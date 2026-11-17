function makeMaterialColor(a, b, defaultVal=Vec.of(0,0,0)) {
    if (a instanceof MaterialColor)
        return b ? new ScaledMaterialColor(a, b) : a;
    if (a || b)
        return MaterialColor.coerce(a,b);
    return MaterialColor.coerce(defaultVal);
}

// Which material an MTL entry becomes is the caller's choice (loadObjFile's materialModel):
//   "phong":      PhongMaterial, or FresnelPhongMaterial for a transparent one (the default).
//   "path":       PhongPathTracingMaterial, the Phong model with path-traced bounces.
//   "principled": PrincipledMaterial, the physically based model (see Materials.md), translated from the MTL terms.
function makeMaterial(data, materialModel="phong") {
    // Ni (optical density) only matters for a transparent material: one whose illumination model has refraction
    // (illum 4, 6, 7 or 9) or that is partly dissolved (d < 1, or Tr > 0). Exporters write Ni for every material
    // (Tie_Fighter.mtl has Ni 1.0 on its opaque illum 2 hull), so treating any Ni as an index of refraction makes opaque
    // surfaces fully transmissive: with Ni = 1 there is no Fresnel reflection at all, and the camera sees straight
    // through them.
    const dissolve    = data.d !== undefined ? data.d : (data.Tr !== undefined ? 1 - data.Tr : 1),
          transparent = [4, 6, 7, 9].includes(data.illum) || dissolve < 1,
          refractionIndex = (transparent && data.Ni > 0) ? data.Ni : Infinity;

    if (materialModel == "principled")
        return makePrincipledMaterial(data, transparent, refractionIndex);
    if (materialModel != "phong" && materialModel != "path")
        throw `Unknown material model "${materialModel}": use "phong", "path" or "principled"`;

    const ambient  = makeMaterialColor(data.map_Ka, data.Ka),
          diffuse  = makeMaterialColor(data.map_Kd, data.Kd),
          specular = makeMaterialColor(data.map_Ks, data.Ks),
          smoothness      = data.Ns || 0;
    // TODO: add support for Tf, partial dissolve, bump?
    if (materialModel == "path" || isFinite(refractionIndex))
        return new (materialModel == "path" ? PhongPathTracingMaterial : FresnelPhongMaterial)(
            Vec.of(1,1,1), ambient, diffuse, specular, smoothness, refractionIndex);
    return new PhongMaterial(Vec.of(1,1,1), ambient, diffuse, specular, smoothness);
}

// MTL describes Phong-style materials, so a PrincipledMaterial has to be guessed from them:
//   - base color: the diffuse texture if there is one (as glTF and Blender's importer treat it, rather than scaling it
//     by Kd), otherwise Kd.
//   - roughness: Pr, from the PBR extension to MTL, if given. Otherwise from the Phong exponent Ns: a Blinn-Phong lobe
//     with exponent Ns is roughly a GGX lobe with alpha = sqrt(2 / (Ns + 2)), and roughness = sqrt(alpha).
//   - metallic: Pm if given, otherwise 0. Ks is ignored: a dielectric's specular comes from its ior.
//   - transmission and ior: glass (transmission 1, ior Ni) for a transparent material, opaque otherwise.
//   - emission: Ke.
function makePrincipledMaterial(data, transparent, refractionIndex) {
    const Ns = data.Ns || 0;
    return new PrincipledMaterial({
        baseColor:    data.map_Kd || data.Kd || Vec.of(0.8, 0.8, 0.8),
        roughness:    data.Pr !== undefined ? data.Pr : Math.sqrt(Math.sqrt(2 / (Ns + 2))),
        metallic:     data.Pm || 0,
        transmission: transparent ? 1 : 0,
        ior:          isFinite(refractionIndex) ? refractionIndex : 1.5,
        emission:     data.Ke || Vec.of(0, 0, 0)
    });
}

function textFetch(filename) {
    if (new Function("try { return !(typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) && this!==window } catch(e) { return true }")()) {
        return fspromise.readFile(filename, { encoding: 'utf8' });
    }
    return fetch(filename).then(function(response) {
        if (!response.ok)
            throw "Attempt to fetch " + filename + " was not successful.";
        return response.text();
    });
}

// Loading problems that don't stop a scene from loading (a missing texture, an MTL statement this loader ignores)
// are reported here: in the GPU page's log when there is one, and otherwise the browser console.
function objLoaderWarn(message) {
    const log = (typeof myconsole !== "undefined") ? myconsole : console;
    (log.warn || log.log)("Warning: " + message);
}

// Decodes a TGA image (types 2, 3, 10 and 11: true color or grayscale, raw or run-length encoded, 8, 24 or 32 bits a
// pixel) into an ImageData. Browsers don't decode TGA, and many OBJ scenes (Crytek Sponza among them) use it.
function decodeTGA(buffer) {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer);
    const idLength = bytes[0], colorMapType = bytes[1], imageType = bytes[2];
    const width = view.getUint16(12, true), height = view.getUint16(14, true);
    const depth = bytes[16], descriptor = bytes[17];
    if (colorMapType != 0 || ![2, 3, 10, 11].includes(imageType))
        throw `unsupported TGA image type ${imageType}` + (colorMapType ? " (color mapped)" : "");
    const grey = (imageType & 3) == 3, rle = imageType >= 8, bpp = depth / 8;
    if (grey ? bpp != 1 : (bpp != 3 && bpp != 4))
        throw `unsupported TGA pixel depth ${depth}`;
    // 32 bit pixels whose header claims no alpha bits carry padding there, not alpha.
    const hasAlpha = bpp == 4 && (descriptor & 15) != 0;

    const count = width * height, out = new Uint8ClampedArray(count * 4);
    let p = 18 + idLength, n = 0;
    const readPixel = () => {
        const o = n++ * 4;
        if (grey)
            out[o] = out[o + 1] = out[o + 2] = bytes[p];
        else {
            out[o] = bytes[p + 2]; out[o + 1] = bytes[p + 1]; out[o + 2] = bytes[p];
        }
        out[o + 3] = hasAlpha ? bytes[p + 3] : 255;
        p += bpp;
    };
    while (n < count) {
        if (!rle)
            readPixel();
        else {
            const header = bytes[p++], run = (header & 127) + 1;
            if (header & 128) {
                readPixel();
                for (let k = 1; k < run && n < count; ++k, ++n)
                    out.copyWithin(n * 4, (n - 1) * 4, n * 4);
            }
            else
                for (let k = 0; k < run && n < count; ++k)
                    readPixel();
        }
    }
    if (p > bytes.length)
        throw "the TGA file is truncated";

    // Pixels are stored bottom row first unless descriptor bit 5 says otherwise (and right to left if bit 4 is set);
    // ImageData's first row is the top.
    const flipY = !(descriptor & 32), flipX = !!(descriptor & 16);
    let pixels = out;
    if (flipX || flipY) {
        pixels = new Uint8ClampedArray(out.length);
        const u32in = new Uint32Array(out.buffer), u32out = new Uint32Array(pixels.buffer);
        for (let y = 0; y < height; ++y)
            for (let x = 0; x < width; ++x)
                u32out[y * width + x] = u32in[(flipY ? height - 1 - y : y) * width + (flipX ? width - 1 - x : x)];
    }
    return (typeof ImageData !== "undefined")
        ? new ImageData(pixels, width, height)
        : { data: pixels, width: width, height: height };
}

// Textures named in MTL files repeat outside [0, 1], as OBJ texture coordinates expect.
async function loadTexture(filename) {
    const response = await fetch(filename);
    if (!response.ok)
        throw `${response.status} ${response.statusText}`;
    if (/\.tga$/i.test(filename))
        return new TextureMaterialColor(decodeTGA(await response.arrayBuffer()), "bilinear", false, false);
    return TextureMaterialColor.fromBitmap(await createImageBitmap(await response.blob()), "bilinear", false, false);
}

// Resolves to { filename: TextureMaterialColor } for every texture that loaded. One that can't be loaded or decoded is
// reported and left out, so the materials using it fall back to their plain colors.
async function loadTextures(prefix, filenames) {
    const textures = {};
    await Promise.all([...new Set(filenames)].map(async f => {
        try {
            textures[f] = await loadTexture(prefix + f);
        }
        catch (e) {
            objLoaderWarn(`could not load texture ${prefix + f} (${e}); its materials use their plain colors.`);
        }
    }));
    return textures;
}

function parseMtlFile(text, callback, prefix="", materialModel="phong", filename="an MTL file") {
    const lines = text.split("\n");
    
    const texture_names = [];
    for (const l of lines) {
        if (/^\s*($|#)/.test(l))
            continue;

        let t = l.match(/\S+/g) || [];
        if (t[0] == "map_Ka" || t[0] == "map_Kd" || t[0] == "map_Ks")
            texture_names.push(t[t.length-1]);
    }
    return loadTextures(prefix, texture_names).then(function(textures) {
        const ret = {};

        let curr = null, name = null;
        const ignored = new Set();
        for (const l of lines) {
            if (/^\s*($|#)/.test(l))
                continue;

            let t = l.match(/\S+/g) || [];

            if (t[0] == "newmtl") {
                if (curr)
                    ret[name] = Object.assign(makeMaterial(curr, materialModel), { name: name });
                name = t[1];
                curr = {};
                continue;
            }

            for (let i = 1; i < t.length; ++i) {
                const num = Number.parseFloat(t[i])
                if (!isNaN(num))
                    t[i] = num;
            }

            if (t[0] == "Ka" || t[0] == "Kd" || t[0] == "Ks" || t[0] == "Ke" || t[0] == "Tf")
                curr[t[0]] = Vec.of(t[1], t[2], t[3]);

            else if (t[0] == "Ns" || t[0] == "Ni" || t[0] == "illum"
                || t[0] == "d" || t[0] == "Tr" || t[0] == "Pr" || t[0] == "Pm")
                curr[t[0]] = t[1];

            else if (t[0] == "map_Ka" || t[0] == "map_Kd" || t[0] == "map_Ks") {
                // A texture that failed to load was reported by loadTextures.
                if (textures[t[t.length-1]])
                    curr[t[0]] = textures[t[t.length-1]]; // TODO: there are lots of other options to do with textures
            }

            // Statements this loader doesn't use yet (bump and displacement maps, alpha masks, and so on): the
            // material is still usable without them, so each kind is reported once per file and skipped.
            else if (!ignored.has(t[0])) {
                ignored.add(t[0]);
                objLoaderWarn(`ignoring the unsupported MTL statement "${t[0]}" in ${filename}.`);
            }
        }

        if (curr)
            ret[name] = Object.assign(makeMaterial(curr, materialModel), { name: name });

        callback(ret);
    });
}

function loadMtlFile(filename, callback, prefix, materialModel) {
    return textFetch(filename).then(function(text) {
        return parseMtlFile(text, callback, prefix, materialModel, filename);
    });
}

function loadMtlFiles(filenames, callback, prefix="", materialModel="phong") {
    if (filenames.length == 0)
        callback({});
    let toDoCount = filenames.length;
    let materials = {};
    for (let i = 0; i < filenames.length; ++i) {
        (function(i) {
            loadMtlFile(
                filenames[i],
                function(mat) {
                    Object.assign(materials, mat);
                    if (--toDoCount === 0)
                        callback(materials);
                },
                prefix, materialModel
            );
        })(i);
    }
}

function parseIndices(ts) {
    return ts.slice(1).map(t => t.match(/(\d+)(?:\/(\d*)(?:\/(\d+))?)?/).slice(1).map(
        x => Number.parseInt(x) - 1));
}

function parseObjFile(callback, data, prefix="", defaultMaterial=null, transform=Mat4.identity(), minArea=0.0, materialModel="phong") {

    let lines = data.split("\n");

    const mtllibs = [];
    for (const l of lines) {
        if (/^\s*($|#)/.test(l))
            continue;

        let t = l.match(/\S+/g) || [];

        if (t[0] == "mtllib")
            mtllibs.push(prefix + t[1]);
    }
    loadMtlFiles(mtllibs, function(materials) {

        const inv_transform = Mat4.inverse(transform);

        let positions = [],
            textures = [],
            normals = [],
            triangles = [],
            currentMaterial = defaultMaterial;

        for (const l of lines) {

            if (/^\s*($|#)/.test(l))
                continue;

            let t = l.match(/\S+/g) || [];

            // Mtl's have already been loaded, so there is nothing further to do with them here
            if (t[0] == "mtllib")
                continue;

            // Set the current material
            if (t[0] == "usemtl") {
                if (!materials[t[1]])
                    throw "No material defined with name: " + t[1];
                currentMaterial = materials[t[1]];
                continue;
            }

            // face: 3 or more 1 based index triples v/vt/vn corresponding to a planar polygon
            if (t[0] == "f") {
                let indices = parseIndices(t);
                for (let i = 2; i < indices.length; ++i) {
                    const abc = [indices[0], indices[i-1], indices[i]];
                    const data = {};
                    if (abc.every(x => x[1] !== undefined && !isNaN(x[1])))
                        data.UV = abc.map(x => textures[x[1]]);
                    if (abc.every(x => x[2] !== undefined && !isNaN(x[2])))
                        data.normal = abc.map(x => normals[x[2]]);
                    const triangle = new Triangle(abc.map(x => positions[x[0]]), data);
                    if (triangle.area >= minArea)
                        triangles.push(new Primitive(triangle, currentMaterial, transform, inv_transform));
                }
                continue;
            }

            // All options past this point have all floats for parameters, so we can parse them here for easy use later
            for (let i = 1; i < t.length; ++i)
                t[i] = Number.parseFloat(t[i]);

            // vertex position: 3-4 floats xyz[w], w defaults to 1
            if (t[0] == "v")
                positions.push(Vec.of(t[1], t[2], t[3], (t.length < 5) ? 1 : t[4]));

            // texture: 1-3 floats u[v[w]], optionals default to 0
            else if (t[0] == "vt")
                textures.push(Vec.of(t[1], t[2] || 0, t[3] || 0));

            // normal: 3 floats xyz
            else if (t[0] == "vn")
                normals.push(Vec.of(t[1], t[2], t[3], 0));

            // throw away smoothing, group, and parameter data, it's not currently supported
            else if (t[0] == "s" || t[0] == "o" || t[0] == "g" || t[0] == "vp")
                continue;

            // throw an error if we see something we don't recognize
            else
                throw "Error while attempting to parse obj file on line \"" + l + "\"";

        }

        callback(triangles);

    }, prefix, materialModel);
}

// materialModel chooses what the OBJ's MTL materials become: "phong", "path" or "principled" (see makeMaterial).
// defaultMaterial is used for faces before any usemtl.
function loadObjFile(filename, defaultMaterial=null, callback, transform=Mat4.identity(), minArea=0.00001, materialModel="phong") {
    textFetch(filename).then(function(text) {
        let prefix = "";
        if (filename.lastIndexOf("/") > 0)
            prefix = filename.substring(0, filename.lastIndexOf("/") + 1);
        parseObjFile(callback, text, prefix, defaultMaterial, transform, minArea, materialModel);
    });
}

function loadObjFiles(files, callback, defaultMaterial=null, transform=Mat4.identity(), minArea=0.00001, materialModel="phong") {
    let toDoCount = files.length;
    let triangle_sets = new Array(files.length).fill(null);
    for (let i = 0; i < files.length; ++i) {
        // wrap this in a new function scope to capture the current index
        (function(i) {
            loadObjFile(
                files[i].filename || files[i],
                files[i].defaultMaterial || defaultMaterial,
                function(obj_triangles) {
                    triangle_sets[i] = obj_triangles;
                    if (--toDoCount === 0)
                        callback(triangle_sets);
                },
                files[i].transform || transform,
                minArea,
                files[i].materialModel || materialModel
            );
        })(i);
    }
}