class WebGLMaterialsAdapter {
    static SPECIAL_COLOR_CHECKERBOARD = 1;
    static SPECIAL_COLOR_TEXTURE = 2;
    static USE_TEXTURES_FOR_MAT_PARAMS = false;
    static MAX_TEXTURE_GROUPS = 8;    // different image sizes in one scene: each takes a texture unit

    // Each material is described to the shader by MATERIAL_SLOTS integers (three ivec4s): its type, then indices of
    // its parameters' colors (see getMaterialColor), in an order that depends on the type.
    //   Phong types:  ambient, diffuse, specular, reflectivity, transmissivity, specularFactor, refractiveIndexRatio,
    //                 mirrorProbability, and for a light's stand-in its area
    //   Principled:   baseColor, metallic, roughness, ior, transmission, emission, then three albedo table indices
    //                 (see AlbedoTable): the specular layer's, and the glass's seen from outside and from inside
    static MATERIAL_SLOTS = 12;
    static TYPE_PHONG = 0;            // PhongMaterial
    static TYPE_FRESNEL_PHONG = 1;    // FresnelPhongMaterial
    static TYPE_PHONG_PATH = 2;       // PhongPathTracingMaterial
    static TYPE_PRINCIPLED = 3;       // PrincipledMaterial
    static TYPE_EMITTER = 4;          // a light's stand-in (see WebGLWorldAdapter.makeLightEmitterProxy)
    static PHONG_PROPERTIES = ["ambient", "diffuse", "specular", "reflectivity", "transmissivity", "specularFactor", "refractiveIndexRatio", "mirrorProbability"];
    static PRINCIPLED_PROPERTIES = ["baseColor", "metallic", "roughness", "ior", "transmission", "emission"];
    
    constructor(webgl_helper, world_adapter) {
        this.world_adapter = world_adapter;
        this.webgl_helper = webgl_helper;
        
        [this.material_colors_texture_unit,  this.material_colors_texture]  = webgl_helper.createDataTextureAndUnit(3, "FLOAT");
        [this.material_indices_texture_unit, this.material_indices_texture] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        [this.albedo_texture_unit, this.albedo_texture] = webgl_helper.createDataTextureAndUnit(1, "FLOAT");
        
        this.solid_colors = new WebGLVecStore(3, false);
        this.texture_groups = [];   // see textureRef
        this.free_texture_units = [];
        this.reset();
    }
    reset() {
        // Texture groups are rebuilt by each visit, from the previous visit's groups where they still fit (textureRef).
        this.previous_texture_groups = (this.previous_texture_groups || []).concat(this.texture_groups);
        this.texture_groups = [];
        this.solid_colors.clear();
        this.solid_mc_map = {};
        // Edits made in the editor are written back into the CPU scene (see bindToScene), so that rebuilding the
        // shader from the scene (adding or removing objects, or switching to and from the editable shader) keeps them.
        this.scene_bindings = {};   // solid color id -> [{ field, set }]
        
        this.special_colors = [];
        
        this.materials = [];
        this.material_id_map = {};

        // Albedo tables used by Principled materials, uploaded together into one texture. Table 0 is always the white
        // conductor's (for multiple scattering on metals).
        this.albedo_tables = [];
    }
    albedoTableIndex(table) {
        let i = this.albedo_tables.indexOf(table);
        if (i < 0) {
            i = this.albedo_tables.length;
            this.albedo_tables.push(table);
        }
        return i;
    }
    albedoTableData() {
        if (!this.albedo_tables.length)
            this.albedoTableIndex(AlbedoTable.whiteConductor());
        const n = AlbedoTable.SIZE, stride = n * n + n, data = new Float32Array(stride * this.albedo_tables.length);
        this.albedo_tables.forEach((t, i) => {
            data.set(t.table, i * stride);
            data.set(t.average, i * stride + n * n);
        });
        return data;
    }
    // Which albedo tables a Principled material needs depends on its ior, which (for the tables) must be a constant.
    static principledTableIOR(material) {
        const ior = material.ior;
        if (typeof ior == "number") return Math.max(ior, 1.0001);
        if (ior instanceof SolidMaterialColor) return Math.max(ior._color[0], 1.0001);
        return 1.5;
    }
    principledTables(ior) {
        this.albedoTableIndex(AlbedoTable.whiteConductor());
        return [this.albedoTableIndex(AlbedoTable.dielectricSpecular(ior)),
                this.albedoTableIndex(AlbedoTable.dielectricTotal(ior)),
                this.albedoTableIndex(AlbedoTable.dielectricTotal(1 / ior))];
    }
    // The integers describing a material to the shader (see MATERIAL_SLOTS).
    static materialSlots(m) {
        const ids = m._type == WebGLMaterialsAdapter.TYPE_PRINCIPLED
            ? WebGLMaterialsAdapter.PRINCIPLED_PROPERTIES.map(k => m[k]._id).concat(m._tables)
            : WebGLMaterialsAdapter.PHONG_PROPERTIES.map(k => m[k]._id).concat(m._area ? [m._area._id] : []);
        const ret = [m._type].concat(ids);
        while (ret.length < WebGLMaterialsAdapter.MATERIAL_SLOTS)
            ret.push(0);
        return ret;
    }
    get usesPrincipled() {
        return this.materials.some(m => m._type == WebGLMaterialsAdapter.TYPE_PRINCIPLED);
    }
    destroy() {
        this.material_colors_texture.destroy();
        this.material_indices_texture.destroy();
        this.albedo_texture.destroy();
        for (const group of this.texture_groups.concat(this.previous_texture_groups))
            if (group.texture)
                this.webgl_helper.gl.deleteTexture(group.texture);
    }
    // Images live in array textures, one per image size and color space (see materials.glsl:colors.textures). sRGB
    // images are stored as SRGB8_ALPHA8, so the GPU decodes their texels to linear before filtering, as the CPU does.
    // Each visit of the world builds its groups afresh from the images it still uses, reusing the previous visit's
    // group of the same kind (its texture unit, and its texture if the images are the same), so an edit that keeps the
    // textures uploads nothing, and images no longer used are dropped. uploadTextures does the uploading.
    textureRef(mc, webgl_helper) {
        const key = mc.width + "x" + mc.height + " " + mc.colorSpace;
        let group = this.texture_groups.find(g => g.key == key);
        if (!group) {
            if (this.texture_groups.length >= WebGLMaterialsAdapter.MAX_TEXTURE_GROUPS)
                throw `Too many kinds of texture: at most ${WebGLMaterialsAdapter.MAX_TEXTURE_GROUPS} different image sizes and color spaces are supported`;
            const previous = this.previous_texture_groups.findIndex(g => g.key == key);
            if (previous >= 0) {
                group = this.previous_texture_groups.splice(previous, 1)[0];
                group.layers = [];
            }
            else
                group = { key: key, width: mc.width, height: mc.height, srgb: mc.colorSpace == "srgb", layers: [],
                    unit: this.free_texture_units.pop() || webgl_helper.allocateTextureUnit(), texture: null,
                    uploaded: [] };
            this.texture_groups.push(group);
        }
        let layer = group.layers.indexOf(mc);
        if (layer < 0) {
            layer = group.layers.length;
            group.layers.push(mc);
        }
        return WebGLMaterialsAdapter.packTextureRef(this.texture_groups.indexOf(group), layer, mc.clampU, mc.clampV);
    }
    static packTextureRef(group, layer, clampU, clampV) {
        return (group << 18) | (layer << 2) | (clampV ? 2 : 0) | (clampU ? 1 : 0);
    }
    uploadTextures(gl) {
        // Groups the last visit didn't need any more: free their textures, and keep their units for new groups.
        for (const group of this.previous_texture_groups) {
            if (group.texture)
                gl.deleteTexture(group.texture);
            this.free_texture_units.push(group.unit);
        }
        this.previous_texture_groups = [];

        for (const group of this.texture_groups) {
            if (group.uploaded.length == group.layers.length && group.layers.every((mc, i) => group.uploaded[i] === mc))
                continue;
            if (!group.texture)
                group.texture = gl.createTexture();
            gl.activeTexture(group.unit);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, group.texture);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, group.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, group.width, group.height,
                group.layers.length, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, null);
            group.layers.forEach((mc, layer) => {
                const data = mc._imgdata.data;
                gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, group.width, group.height, 1, gl.RGBA,
                    gl.UNSIGNED_BYTE, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            });
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
            group.uploaded = group.layers.slice();
        }
    }
    storeSolidColor(color) {
        const id = this.solid_colors.store(color);
        const ret = { _id: id, color: color };
        this.solid_mc_map[id] = ret;
        return ret;
    }
    collapseMaterialColor(mc, webgl_helper, scale=Vec.of(1,1,1)) {
        if (mc instanceof Vec)
            return Object.assign(this.storeSolidColor(mc.times(scale)), { type: "color" });
        if (mc instanceof SolidMaterialColor) {
            return Object.assign(this.storeSolidColor(mc._color.times(scale)), {
                mc: mc,
                type: "color"
            });
        }
        else if (mc instanceof CheckerboardMaterialColor) {
            const color1 = this.storeSolidColor(mc.color1.toSolidColor()._color.times(scale)),
                  color2 = this.storeSolidColor(mc.color2.toSolidColor()._color.times(scale));
            this.special_colors.push([ WebGLMaterialsAdapter.SPECIAL_COLOR_CHECKERBOARD, color1._id, color2._id ]);
            return {
                _id: -this.special_colors.length,
                color1: color1,
                color2: color2,
                mc: mc,
                type: "checkerboard"
            };
        }
        else if (mc instanceof TextureMaterialColor) {
            const ref = this.textureRef(mc, webgl_helper);
            const scaleColorData = this.storeSolidColor(scale);
            this.special_colors.push([WebGLMaterialsAdapter.SPECIAL_COLOR_TEXTURE, ref, scaleColorData._id]);
            return {
                _id: -this.special_colors.length,
                scale: scaleColorData,
                mc: mc,
                type: "texture"
            };
        }
        else if (mc instanceof ScaledMaterialColor)
            return this.collapseMaterialColor(mc._mc, webgl_helper, scale.times(mc._scale));
        throw "Unsupported material color type";
    }
    visitMaterialColor(mc, webgl_helper) {
        return this.collapseMaterialColor(mc, webgl_helper);
    }
    visitMaterialScalar(s) {
        return Object.assign(this.storeSolidColor(Vec.of(s, 0, 0)), {
            value: s,
            type: "number"
        });
    }
    // A parameter that may be a number or a MaterialColor (the shader reads a scalar's red channel).
    visitMaterialParameter(p, webgl_helper) {
        return (typeof p == "number") ? this.visitMaterialScalar(p) : this.visitMaterialColor(MaterialColor.coerce(p), webgl_helper);
    }
    // Ties an editable field (a visitMaterialColor/Scalar/Parameter result) to the scene property it came from:
    // after any of the field's colors is edited, set(value) receives the field's current value as a number or a
    // MaterialColor.
    bindToScene(field, set) {
        const ids = field.type == "checkerboard" ? [field.color1._id, field.color2._id]
                  : field.type == "texture"      ? [field.scale._id]
                  :                                [field._id];
        for (const id of ids)
            (this.scene_bindings[id] = this.scene_bindings[id] || []).push({ field: field, set: set });
        return field;
    }
    static fieldToSceneValue(field) {
        if (field.type == "number")       return field.value;
        if (field.type == "checkerboard") return new CheckerboardMaterialColor(field.color1.color, field.color2.color);
        if (field.type == "texture")      return new ScaledMaterialColor(field.mc, field.scale.color);
        return new SolidMaterialColor(field.color);
    }
    static hide(obj, key, value) {
        Object.defineProperty(obj, key, { value: value, writable: true, enumerable: false, configurable: true });
    }
    visit(material, webgl_helper) {
        if (material.MATERIAL_UID in this.material_id_map)
            return this.material_id_map[material.MATERIAL_UID];
        
        const material_data = {};
        if (material instanceof PrincipledMaterial) {
            WebGLMaterialsAdapter.hide(material_data, "_type", WebGLMaterialsAdapter.TYPE_PRINCIPLED);
            material_data.baseColor    = this.visitMaterialColor(material.baseColor, webgl_helper);
            material_data.metallic     = this.visitMaterialParameter(material.metallic, webgl_helper);
            material_data.roughness    = this.visitMaterialParameter(material.roughness, webgl_helper);
            material_data.ior          = this.visitMaterialParameter(material.ior, webgl_helper);
            material_data.transmission = this.visitMaterialParameter(material.transmission, webgl_helper);
            material_data.emission     = this.collapseMaterialColor(material.emission, webgl_helper,
                Vec.of(1, 1, 1).times(PrincipledMaterial.scalar(material.emissionStrength, {})));
            for (const key of ["baseColor", "metallic", "roughness", "ior", "transmission"])
                this.bindToScene(material_data[key], v => material[key] = v);
            this.bindToScene(material_data.emission, v => { material.emission = v; material.emissionStrength = 1; });
            WebGLMaterialsAdapter.hide(material_data, "_material", material);
            WebGLMaterialsAdapter.hide(material_data, "_tables", this.principledTables(WebGLMaterialsAdapter.principledTableIOR(material)));
        }
        else if (material instanceof PhongMaterial) {
            WebGLMaterialsAdapter.hide(material_data, "_type",
                  material.emitterArea !== undefined                ? WebGLMaterialsAdapter.TYPE_EMITTER
                : material instanceof PhongPathTracingMaterial     ? WebGLMaterialsAdapter.TYPE_PHONG_PATH
                : material instanceof FresnelPhongMaterial         ? WebGLMaterialsAdapter.TYPE_FRESNEL_PHONG
                :                                                    WebGLMaterialsAdapter.TYPE_PHONG);
            if (material.emitterArea !== undefined)
                WebGLMaterialsAdapter.hide(material_data, "_area", this.visitMaterialScalar(material.emitterArea));
            material_data.ambient        = this.visitMaterialColor(material.ambient,        webgl_helper);
            material_data.diffuse        = this.visitMaterialColor(material.diffusivity,    webgl_helper);
            material_data.specular       = this.visitMaterialColor(material.specularity,    webgl_helper);
            material_data.reflectivity   = this.visitMaterialColor(material.reflectivity,   webgl_helper);
            material_data.transmissivity = this.visitMaterialColor(material.transmissivity, webgl_helper);
            material_data.specularFactor = this.visitMaterialScalar(material.smoothness);
            for (const [key, scene_key] of [["ambient", "ambient"], ["diffuse", "diffusivity"], ["specular", "specularity"],
                    ["reflectivity", "reflectivity"], ["transmissivity", "transmissivity"], ["specularFactor", "smoothness"]])
                this.bindToScene(material_data[key], v => material[scene_key] = v);
            if (material instanceof FresnelPhongMaterial) {
                material_data.refractiveIndexRatio  = this.bindToScene(this.visitMaterialScalar(material.refractiveIndexRatio),
                    v => material.refractiveIndexRatio = v);
                if (material instanceof PhongPathTracingMaterial)
                    material_data.mirrorProbability = this.bindToScene(this.visitMaterialScalar(material.mirrorProbability),
                        v => material.mirrorProbability = v);
                else
                    material_data.mirrorProbability = this.visitMaterialScalar(1.0);
            }
            else {
                material_data.refractiveIndexRatio  = this.visitMaterialScalar(Infinity);
                material_data.mirrorProbability     = this.visitMaterialScalar(1.0);
            }
        }
        else
            throw "Unsupported material type";
        
        this.material_id_map[material.MATERIAL_UID] = this.materials.length;
        this.materials.push(material_data);
        return this.material_id_map[material.MATERIAL_UID];
    }
    getMaterial(index) {
        return this.materials[index];
    }
    modifySolidColor(solid_color_index, new_color) {
        this.solid_colors.set(solid_color_index, new_color);
        this.world_adapter.renderer_adapter.useTracerProgram();
        if (this.ShaderUsesTexturesForProperties)
            this.material_colors_texture.modifyDataPixel(solid_color_index, new_color);
        else
            this.world_adapter.renderer_adapter.gl.uniform3fv(this.world_adapter.renderer_adapter.getUniformLocation("uMaterialColors"), this.solid_colors.flat());
        this.solid_mc_map[solid_color_index].color = new_color;
        for (const b of this.scene_bindings[solid_color_index] || [])
            b.set(WebGLMaterialsAdapter.fieldToSceneValue(b.field));
    }
    modifyScalar(index, new_scalar) {
        this.solid_mc_map[index].value = new_scalar;
        this.modifySolidColor(index, Vec.of(new_scalar, 0, 0));
        // A Principled material's ior decides which albedo tables it uses.
        for (const m of this.materials) {
            if (m._type == WebGLMaterialsAdapter.TYPE_PRINCIPLED && m.ior._id == index) {
                m._material.ior = new_scalar;
                m._tables = this.principledTables(WebGLMaterialsAdapter.principledTableIOR(m._material));
                this.writeMaterialIndices(this.world_adapter.renderer_adapter.gl, this.world_adapter.renderer_adapter.tracerShaderProgram);
                this.albedo_texture.setDataPixelsUnit(this.albedoTableData(), this.albedo_texture_unit, "uAlbedoTables",
                    this.world_adapter.renderer_adapter.tracerShaderProgram);
            }
        }
    }
    getShaderSourceDeclarations() {
        const M = WebGLMaterialsAdapter;
        return ShaderLibrary.render("materials.glsl", "declarations", {
            specialColorCheckerboard: M.SPECIAL_COLOR_CHECKERBOARD,
            specialColorTexture:      M.SPECIAL_COLOR_TEXTURE,
            typePhong:                M.TYPE_PHONG,
            typeFresnelPhong:         M.TYPE_FRESNEL_PHONG,
            typePhongPath:            M.TYPE_PHONG_PATH,
            typePrincipled:           M.TYPE_PRINCIPLED,
            typeEmitter:              M.TYPE_EMITTER
        });
    }
    getShaderSource(sceneEditable) {
        let ret = ShaderLibrary.render("materials.glsl", "parameters");
        // The materials' parameters go in textures for the editable shader, and whenever they won't fit in uniforms.
        this.ShaderUsesTexturesForProperties = WebGLMaterialsAdapter.USE_TEXTURES_FOR_MAT_PARAMS || sceneEditable
            || (this.solid_colors.size() * 3 + this.materials.length * WebGLMaterialsAdapter.MATERIAL_SLOTS) > 512;
        ret += this.ShaderUsesTexturesForProperties
            ? ShaderLibrary.render("materials.glsl", "storage.textures")
            : ShaderLibrary.render("materials.glsl", "storage.uniforms", {
                colorCount: Math.max(64, this.solid_colors.size()),
                indexCount: Math.max(12, 3 * this.materials.length)
            });
        ret += ShaderLibrary.render("materials.glsl", "colors", {
            specialColorCount: sceneEditable
                ? WebGLWorldAdapter.editableCapacity(this.special_colors.length, 16)
                : Math.max(4, this.special_colors.length),
            textureSampling: this.texture_groups.length
                ? ShaderLibrary.render("materials.glsl", "colors.textures", {
                    textureCount: this.texture_groups.length,
                    textureCases: this.texture_groups.map((_, i) =>
                        ShaderLibrary.render("materials.glsl", "colors.texture-case", { i: i })).join("")
                })
                : ShaderLibrary.render("materials.glsl", "colors.no-textures")
        });
        ret += ShaderLibrary.render("materials.glsl", "phong");

        // BSDFs are needed for path tracing, and for any material that isn't one of the legacy Phong ones.
        this.ShaderUsesBSDFs = this.world_adapter.renderer_adapter.pathTracing || this.usesPrincipled;
        if (this.ShaderUsesBSDFs) {
            if (!this.albedo_tables.length)
                this.albedoTableIndex(AlbedoTable.whiteConductor());
            ret += ShaderLibrary.render("bsdf.glsl", "source");
        }
        else
            ret += ShaderLibrary.render("materials.glsl", "generic");
        return ret;
    }
    writeMaterialIndices(gl, program) {
        const slots = this.materials.map(m => WebGLMaterialsAdapter.materialSlots(m)).flat();
        if (this.ShaderUsesTexturesForProperties)
            this.material_indices_texture.setDataPixelsUnit(slots, this.material_indices_texture_unit, "umMaterialIndices", program);
        else {
            gl.useProgram(program);
            gl.uniform4iv(gl.getUniformLocation(program, "uMaterialIndices"), slots);
        }
    }
    writeShaderData(gl, program, webgl_helper) {
        if (this.ShaderUsesTexturesForProperties) {
            this.material_colors_texture.setDataPixelsUnit(this.solid_colors.flat(), this.material_colors_texture_unit, "umMaterialColors", program);
        }
        else
            gl.uniform3fv(gl.getUniformLocation(program, "uMaterialColors"), this.solid_colors.flat());
        this.writeMaterialIndices(gl, program);
        if (this.ShaderUsesBSDFs)
            this.albedo_texture.setDataPixelsUnit(this.albedoTableData(), this.albedo_texture_unit, "uAlbedoTables", program);
        
        if (this.special_colors.length)
            gl.uniform3iv(gl.getUniformLocation(program, "umSpecialColors"), this.special_colors.flat());
        this.uploadTextures(gl);
        if (this.texture_groups.length) {
            gl.uniform1iv(gl.getUniformLocation(program, "umTextures"),
                this.texture_groups.map(g => WebGLHelper.textureUnitIndex(g.unit)));
        }
    }
}
