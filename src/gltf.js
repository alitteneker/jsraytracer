// glTF 2.0 (a .gltf with its .bin buffers and images, or a single .glb) as the tracer's primitives: triangles with their
// normals and UVs, placed by the scene's node hierarchy, with metallic-roughness materials as PrincipledMaterials. Used
// by the editor's Import (gl/src/WebGLImporter.js).
//
// Materials: base color, metallic and roughness (factors and textures; glTF packs roughness and metallic into the green
// and blue channels of one texture, which become two single-channel textures here, since the tracer reads scalar
// parameters from a texture's red channel), emission (with KHR_materials_emissive_strength), transmission and ior
// (KHR_materials_transmission, KHR_materials_ior). Factors are baked into textures' pixels. Not yet: normal and
// occlusion maps, alpha (cutouts and blending), texture transforms, other UV sets than the first, vertex colors,
// morph targets, skins, cameras and lights. Those are reported as warnings, and the rest still loads.
class GLTFLoader {
    // bytes: the .gltf (JSON text) or .glb file, as an ArrayBuffer or Uint8Array. resolve(uri): a Promise of the bytes of
    // a file the glTF names (buffers and images), as an ArrayBuffer; data: URIs are decoded here.
    static async load(bytes, resolve, name = "a glTF file") {
        const loader = new GLTFLoader(name, resolve);
        await loader.parse(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        return { primitives: loader.primitives, warnings: loader.warnings };
    }
    constructor(name, resolve) {
        this.name = name;
        this.resolve = resolve;
        this.warnings = [];
        this.primitives = [];
        this.warned = new Set();
    }
    warn(message) {
        if (!this.warned.has(message)) {
            this.warned.add(message);
            this.warnings.push(message);
        }
    }
    async parse(bytes) {
        let json, bin = null;
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length >= 12 && dv.getUint32(0, true) == 0x46546C67) {   // "glTF": binary
            if (dv.getUint32(4, true) != 2)
                throw `${this.name} is glTF version ${dv.getUint32(4, true)}; only 2 is supported`;
            for (let at = 12; at + 8 <= bytes.length;) {
                const length = dv.getUint32(at, true), type = dv.getUint32(at + 4, true), chunk = bytes.subarray(at + 8, at + 8 + length);
                if (type == 0x4E4F534A)
                    json = JSON.parse(new TextDecoder().decode(chunk));
                else if (type == 0x004E4942)
                    bin = chunk;
                at += 8 + length;
            }
        }
        else
            json = JSON.parse(new TextDecoder().decode(bytes));
        if (!json || !json.asset || !/^2\./.test(json.asset.version))
            throw `${this.name} isn't a glTF 2.0 file`;
        this.json = json;
        for (const ext of json.extensionsRequired || [])
            if (!["KHR_materials_emissive_strength", "KHR_materials_transmission", "KHR_materials_ior"].includes(ext))
                throw `${this.name} requires the glTF extension ${ext}, which isn't supported`;

        // Buffers (the GLB's own chunk, data: URIs, or files picked alongside), then images and materials on demand.
        this.buffers = await Promise.all((json.buffers || []).map(async (b, i) => {
            if (b.uri === undefined) {
                if (!bin)
                    throw `${this.name}: buffer ${i} has no data`;
                return bin;
            }
            return new Uint8Array(await this.fetchUri(b.uri));
        }));
        this.textureCache = new Map();
        this.materials = await Promise.all((json.materials || []).map((m, i) => this.material(m, i)));
        this.defaultMaterial = new PrincipledMaterial({});

        const sceneIndex = json.scene !== undefined ? json.scene : 0;
        const roots = json.scenes && json.scenes[sceneIndex] ? json.scenes[sceneIndex].nodes
                    : (json.nodes || []).map((_, i) => i).filter(i => !(json.nodes || []).some(n => (n.children || []).includes(i)));
        for (const n of roots || [])
            this.node(n, Mat4.identity());
        if (json.skins && json.skins.length) this.warn("skins are ignored (meshes are shown in their bind pose)");
        if (json.cameras && json.cameras.length) this.warn("cameras are ignored");
    }
    async fetchUri(uri) {
        const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(uri);
        if (m) {
            if (m[1]) {
                const s = atob(m[2]), out = new Uint8Array(s.length);
                for (let i = 0; i < s.length; ++i)
                    out[i] = s.charCodeAt(i);
                return out.buffer;
            }
            return new TextEncoder().encode(decodeURIComponent(m[2])).buffer;
        }
        return this.resolve(decodeURIComponent(uri));
    }

    // A node: its transform (a matrix, or translation * rotation * scale), its mesh, then its children.
    node(index, parent) {
        const n = this.json.nodes[index];
        let local = Mat4.identity();
        if (n.matrix) {
            const m = n.matrix;   // column major
            local = Mat.of([m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]], [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]);
        }
        else {
            const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
            const R = Mat.of([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
                             [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
                             [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
                             [0, 0, 0, 1]);
            local = Mat4.translation(n.translation || [0, 0, 0]).times(R).times(Mat4.scale(n.scale || [1, 1, 1]));
        }
        const T = parent.times(local);
        if (n.mesh !== undefined)
            this.mesh(this.json.meshes[n.mesh], T);
        if (n.extensions && n.extensions.KHR_lights_punctual)
            this.warn("lights (KHR_lights_punctual) are ignored");
        for (const c of n.children || [])
            this.node(c, T);
    }
    // A mesh's triangles, with the node's transform T baked into their vertices and normals (the inverse transpose
    // for normals), so they're untransformed like an OBJ's: the GPU handles those as one compact triangle list, while
    // primitives with their own transforms each get their own code.
    mesh(mesh, T) {
        const identity = Mat4.identity(), normalT = Mat4.inverse(T).transposed();
        for (const p of mesh.primitives) {
            const mode = p.mode !== undefined ? p.mode : 4;
            if (mode != 4) {
                this.warn(`primitives drawn as ${["points", "lines", "line loops", "line strips", "triangles", "triangle strips", "triangle fans"][mode]} are skipped (only triangle lists are supported)`);
                continue;
            }
            if (p.targets) this.warn("morph targets are ignored");
            if (p.attributes.COLOR_0 !== undefined) this.warn("vertex colors are ignored");
            const pos = this.accessor(p.attributes.POSITION);
            const nrm = p.attributes.NORMAL !== undefined ? this.accessor(p.attributes.NORMAL) : null;
            const uv = p.attributes.TEXCOORD_0 !== undefined ? this.accessor(p.attributes.TEXCOORD_0) : null;
            const indices = p.indices !== undefined ? this.accessor(p.indices).array : null;
            const count = indices ? indices.length : pos.count;
            const material = p.material !== undefined ? this.materials[p.material] : this.defaultMaterial;
            const P = i => T.times(Vec.of(pos.array[3 * i], pos.array[3 * i + 1], pos.array[3 * i + 2], 1));
            const N = i => {
                const n = normalT.times(Vec.of(nrm.array[3 * i], nrm.array[3 * i + 1], nrm.array[3 * i + 2], 0));
                const l = Math.hypot(n[0], n[1], n[2]) || 1;
                return Vec.of(n[0] / l, n[1] / l, n[2] / l, 0);
            };
            // glTF's UVs start at the image's top; the tracer's V = 1 is the top row.
            const UV = i => Vec.of(uv.array[2 * i], 1 - uv.array[2 * i + 1], 0);
            for (let k = 0; k + 2 < count; k += 3) {
                const abc = indices ? [indices[k], indices[k + 1], indices[k + 2]] : [k, k + 1, k + 2];
                const data = {};
                if (uv) data.UV = abc.map(UV);
                if (nrm) data.normal = abc.map(N);
                const triangle = new Triangle(abc.map(P), data);
                if (triangle.area > 0)
                    this.primitives.push(new Primitive(triangle, material, identity, identity));
            }
        }
    }
    // An accessor's values as floats (normalized integers scaled to [0, 1] or [-1, 1]), count elements of size each.
    accessor(index) {
        const a = this.json.accessors[index];
        const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[a.type];
        const kinds = { 5120: [1, "getInt8", 127], 5121: [1, "getUint8", 255], 5122: [2, "getInt16", 32767],
                        5123: [2, "getUint16", 65535], 5125: [4, "getUint32", 1], 5126: [4, "getFloat32", 1] };
        const [bytes, get, max] = kinds[a.componentType];
        const array = new Float32Array(a.count * size);
        const read = (viewIndex, offset, n, out, outIndex = i => i) => {
            const view = this.json.bufferViews[viewIndex], buffer = this.buffers[view.buffer];
            const dv = new DataView(buffer.buffer, buffer.byteOffset + (view.byteOffset || 0), view.byteLength);
            const stride = view.byteStride || bytes * size;
            for (let i = 0; i < n; ++i)
                for (let c = 0; c < size; ++c) {
                    let v = dv[get](offset + i * stride + c * bytes, true);
                    if (a.normalized) v = Math.max(v / max, -1);
                    out[outIndex(i) * size + c] = v;
                }
        };
        if (a.bufferView !== undefined)
            read(a.bufferView, a.byteOffset || 0, a.count, array);
        if (a.sparse) {
            const s = a.sparse, idx = new Uint32Array(s.count);
            const ik = kinds[s.indices.componentType], iv = this.json.bufferViews[s.indices.bufferView], ib = this.buffers[iv.buffer];
            const idv = new DataView(ib.buffer, ib.byteOffset + (iv.byteOffset || 0) + (s.indices.byteOffset || 0));
            for (let i = 0; i < s.count; ++i)
                idx[i] = idv[ik[1]](i * ik[0], true);
            read(s.values.bufferView, s.values.byteOffset || 0, s.count, array, i => idx[i]);
        }
        return { array, count: a.count, size };
    }

    // A glTF material as a PrincipledMaterial.
    async material(m, index) {
        const pbr = m.pbrMetallicRoughness || {}, ext = m.extensions || {};
        if (m.normalTexture) this.warn("normal maps are ignored");
        if (m.occlusionTexture) this.warn("occlusion maps are ignored");
        if (m.alphaMode && m.alphaMode != "OPAQUE") this.warn(`alpha (${m.alphaMode.toLowerCase()}) is ignored: those surfaces are opaque`);
        const f = pbr.baseColorFactor || [1, 1, 1, 1];
        const baseColor = pbr.baseColorTexture
            ? await this.texture(pbr.baseColorTexture, "srgb", px => [px[0] * f[0], px[1] * f[1], px[2] * f[2]])
            : Vec.of(f[0], f[1], f[2]);
        const metallicFactor = pbr.metallicFactor !== undefined ? pbr.metallicFactor : 1;
        const roughnessFactor = pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1;
        let metallic = metallicFactor, roughness = roughnessFactor;
        if (pbr.metallicRoughnessTexture) {
            roughness = await this.texture(pbr.metallicRoughnessTexture, "linear", px => [px[1] * roughnessFactor, 0, 0]);
            metallic = await this.texture(pbr.metallicRoughnessTexture, "linear", px => [px[2] * metallicFactor, 0, 0]);
        }
        const e = m.emissiveFactor || [0, 0, 0];
        const strength = ext.KHR_materials_emissive_strength ? ext.KHR_materials_emissive_strength.emissiveStrength : 1;
        const emission = m.emissiveTexture
            ? await this.texture(m.emissiveTexture, "srgb", px => [px[0] * e[0], px[1] * e[1], px[2] * e[2]])
            : Vec.of(e[0], e[1], e[2]);
        const transmission = ext.KHR_materials_transmission ? (ext.KHR_materials_transmission.transmissionFactor || 0) : 0;
        if (ext.KHR_materials_transmission && ext.KHR_materials_transmission.transmissionTexture)
            this.warn("transmission textures are ignored (their factor is used)");
        const ior = ext.KHR_materials_ior && ext.KHR_materials_ior.ior !== undefined ? ext.KHR_materials_ior.ior : 1.5;
        const material = new PrincipledMaterial({ baseColor, metallic, roughness, emission, emissionStrength: strength, transmission, ior });
        if (m.name)
            material.name = m.name;
        return material;
    }
    // A texture (an image and its sampler), with its pixels passed through map (linear values in [0, 1] for each of
    // r, g, b, after decoding sRGB if colorSpace says so) and stored back in that color space.
    async texture(info, colorSpace, map) {
        if (info.texCoord) this.warn("textures on other UV sets than the first are drawn with the first");
        if (info.extensions && info.extensions.KHR_texture_transform) this.warn("texture transforms are ignored");
        const tex = this.json.textures[info.index], sampler = tex.sampler !== undefined ? this.json.samplers[tex.sampler] : {};
        const pixels = await this.image(tex.source);
        const srgb = colorSpace == "srgb", decode = TextureMaterialColor.SRGB_TO_LINEAR;
        const encode = v => {
            v = Math.min(1, Math.max(0, v));
            return Math.round(255 * (srgb ? (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) : v));
        };
        const src = pixels.data, data = new Uint8ClampedArray(src.length);
        for (let i = 0; i < src.length; i += 4) {
            const px = [0, 1, 2].map(k => srgb ? decode[src[i + k]] : src[i + k] / 255);
            const out = map(px);
            data[i] = encode(out[0]);
            data[i + 1] = encode(out[1]);
            data[i + 2] = encode(out[2]);
            data[i + 3] = src[i + 3];
        }
        const nearest = sampler.magFilter == 9728;
        return new TextureMaterialColor({ width: pixels.width, height: pixels.height, data }, nearest ? "nearest" : "bilinear",
            sampler.wrapS == 33071, sampler.wrapT == 33071, colorSpace);
    }
    // An image's pixels, decoded once (from a file, a data: URI, or a buffer view).
    image(index) {
        if (!this.textureCache.has(index))
            this.textureCache.set(index, (async () => {
                const img = this.json.images[index];
                let bytes, type = img.mimeType;
                if (img.bufferView !== undefined) {
                    const view = this.json.bufferViews[img.bufferView], buffer = this.buffers[view.buffer];
                    bytes = buffer.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
                }
                else
                    bytes = new Uint8Array(await this.fetchUri(img.uri));
                const bitmap = await createImageBitmap(new Blob([bytes], type ? { type } : {}));
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d");
                context.drawImage(bitmap, 0, 0);
                return context.getImageData(0, 0, bitmap.width, bitmap.height);
            })());
        return this.textureCache.get(index);
    }
}
