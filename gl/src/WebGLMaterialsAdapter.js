class WebGLMaterialsAdapter {
    static SPECIAL_COLOR_CHECKERBOARD = 1;
    static SPECIAL_COLOR_TEXTURE = 2;
    static USE_TEXTURES_FOR_MAT_PARAMS = false;

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
        this.reset();
    }
    reset() {
        this.solid_colors.clear();
        this.solid_mc_map = {};
        // Edits made in the editor are written back into the CPU scene (see bindToScene), so that rebuilding the
        // shader from the scene (adding or removing objects, or switching to and from the editable shader) keeps them.
        this.scene_bindings = {};   // solid color id -> [{ field, set }]
        
        this.textures = [];
        this.texture_id_map = {};
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
        for (const td of (this.texture_cache ? this.texture_cache.values() : this.textures))
            td.texture.destroy();
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
            if (!(mc.MATERIALCOLOR_UID in this.texture_id_map)) {
                this.texture_id_map[mc.MATERIALCOLOR_UID] = this.textures.length;
                // GL textures are kept across reset() (the world can be re-visited after an edit, see
                // WebGLRendererAdapter.worldModified), so an image is only uploaded once.
                if (!this.texture_cache)
                    this.texture_cache = new Map();
                let td = this.texture_cache.get(mc.MATERIALCOLOR_UID);
                if (!td) {
                    td = { mc: mc };
                    [ td.texture_unit, td.texture ] = webgl_helper.createTextureAndUnit(4, "IMAGEDATA", mc.width, mc.height, true, mc._imgdata);
                    this.texture_cache.set(mc.MATERIALCOLOR_UID, td);
                }
                this.textures.push(td);
            }
            const scaleColorData = this.storeSolidColor(scale);
            this.special_colors.push([
                WebGLMaterialsAdapter.SPECIAL_COLOR_TEXTURE,
                this.texture_id_map[mc.MATERIALCOLOR_UID],
                scaleColorData._id
            ]);
            
            return { 
                _id: -this.special_colors.length,
                scale: scaleColorData,
                texture: this.texture_id_map[mc.MATERIALCOLOR_UID],
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
        return `
            #define MATERIALCOLOR_SPECIAL_CHECKERBOARD ${WebGLMaterialsAdapter.SPECIAL_COLOR_CHECKERBOARD}
            #define MATERIALCOLOR_SPECIAL_TEXTURE      ${WebGLMaterialsAdapter.SPECIAL_COLOR_TEXTURE}
            #define MATERIAL_TYPE_PHONG                ${WebGLMaterialsAdapter.TYPE_PHONG}
            #define MATERIAL_TYPE_FRESNEL_PHONG        ${WebGLMaterialsAdapter.TYPE_FRESNEL_PHONG}
            #define MATERIAL_TYPE_PHONG_PATH           ${WebGLMaterialsAdapter.TYPE_PHONG_PATH}
            #define MATERIAL_TYPE_PRINCIPLED           ${WebGLMaterialsAdapter.TYPE_PRINCIPLED}
            #define MATERIAL_TYPE_EMITTER              ${WebGLMaterialsAdapter.TYPE_EMITTER}
            void getMaterialIndices(in int materialID, out ivec4 mat_ind_0, out ivec4 mat_ind_1, out ivec4 mat_ind_2);
            vec3 getMaterialColor(in int color_index, in vec2 UV);
            vec3 colorForMaterial(in int materialID, in vec4 intersect_position, in Ray r, in GeometricMaterialData data,
                inout vec2 random_seed, inout RecursiveNextRays nextRays);`
    }
    getShaderSource(sceneEditable) {
        let ret = `
            struct PhongMaterialParameters {
                vec3 ambient;
                vec3 diffuse;
                vec3 specular;
                vec3 reflectivity;
                vec3 transmissivity;
                float specularFactor;
                float refractiveIndexRatio;
                float mirrorProbability;
            };`;
        if (WebGLMaterialsAdapter.USE_TEXTURES_FOR_MAT_PARAMS || sceneEditable ||  (this.solid_colors.size() * 3 + this.materials.length * WebGLMaterialsAdapter.MATERIAL_SLOTS) > 512) {
            this.ShaderUsesTexturesForProperties = true;
            ret += `
            uniform  sampler2D umMaterialColors;
            vec3 getSolidColor(in int color_index) {
                return texelFetchByIndex(color_index, umMaterialColors).xyz;
            }
            
            uniform isampler2D umMaterialIndices;
            void getMaterialIndices(in int materialID, out ivec4 mat_ind_0, out ivec4 mat_ind_1, out ivec4 mat_ind_2) {
                mat_ind_0 = itexelFetchByIndex(materialID * 3    , umMaterialIndices);
                mat_ind_1 = itexelFetchByIndex(materialID * 3 + 1, umMaterialIndices);
                mat_ind_2 = itexelFetchByIndex(materialID * 3 + 2, umMaterialIndices);
            }`;
        }
        else {
            this.ShaderUsesTexturesForProperties = false;
            ret += `
            uniform vec3 uMaterialColors[ ${Math.max(64, this.solid_colors.size())}];
            vec3 getSolidColor(in int color_index) {
                return uMaterialColors[color_index];
            }
            
            uniform ivec4 uMaterialIndices[${Math.max(12, 3 * this.materials.length)}];
            void getMaterialIndices(in int materialID, out ivec4 mat_ind_0, out ivec4 mat_ind_1, out ivec4 mat_ind_2) {
                mat_ind_0 = uMaterialIndices[materialID * 3    ];
                mat_ind_1 = uMaterialIndices[materialID * 3 + 1];
                mat_ind_2 = uMaterialIndices[materialID * 3 + 2];
            }`;
        }
        
        function makeStaticTextureShaderSource(i) {
            return `
                case ${i}:
                    return texture(umTextures[${i}], vec2(UV.x, 1.0-UV.y)).xyz * getSolidColor(special_color.z);`;
        }
        ret += `
            uniform sampler2D umTextures [${ Math.max(1, this.textures.length)       }];
            uniform ivec3 umSpecialColors[${ sceneEditable ? WebGLWorldAdapter.editableCapacity(this.special_colors.length, 16) : Math.max(4, this.special_colors.length) }];

            vec3 getMaterialColor(in int color_index, in vec2 UV) {
                
                // Special colors
                if (color_index < 0) {
                    ivec3 special_color = umSpecialColors[-color_index - 1];
                    
                    // checkerboard color
                    if (special_color.x == MATERIALCOLOR_SPECIAL_CHECKERBOARD)
                        return getSolidColor((mod(floor(UV.x) + floor(UV.y), 2.0) < 1.0) ? special_color.y : special_color.z);
                    
                    // texture color
                    if (special_color.x == MATERIALCOLOR_SPECIAL_TEXTURE) {
                        switch (special_color.y) {
                            ${ new Array(this.textures.length).fill(0).map((_,i) => makeStaticTextureShaderSource(i)).join('') }
                            default: break;
                        }
                    }
                    
                    // something has gone wrong
                    return vec3(1.0, 0.5, 1.0);
                }
                
                // Solid color
                return getSolidColor(color_index);
            }
            
            void getPhongMaterialParameters(in int materialID, in GeometricMaterialData geodata, out PhongMaterialParameters matParams) {
                ${WebGLRendererAdapter.debugConstMaterialParams ? `
                // Diagnostic: constant parameters instead of fetched ones, chosen to keep the same downstream
                // branches as a typical reflective, non-refractive material (so only the fetch cost is removed).
                matParams.ambient              = geodata.baseColor * vec3(0.1);
                matParams.diffuse              = geodata.baseColor * vec3(0.4);
                matParams.specular             = vec3(0.6);
                matParams.reflectivity         = vec3(0.3);
                matParams.transmissivity       = vec3(0.0);
                matParams.specularFactor       = 100.0;
                matParams.refractiveIndexRatio = uintBitsToFloat(0x7f800000u); // +infinity: no refraction, matches Ni=inf
                matParams.mirrorProbability    = 1.0;
                ` : `
                ivec4 mat_ind_0, mat_ind_1, mat_ind_2;
                getMaterialIndices(materialID, mat_ind_0, mat_ind_1, mat_ind_2);
                matParams.ambient              = geodata.baseColor * getMaterialColor(mat_ind_0[1], geodata.UV);
                matParams.diffuse              = geodata.baseColor * getMaterialColor(mat_ind_0[2], geodata.UV);
                matParams.specular             =                     getMaterialColor(mat_ind_0[3], geodata.UV);
                matParams.reflectivity         =                     getMaterialColor(mat_ind_1[0], geodata.UV);
                matParams.transmissivity       =                     getMaterialColor(mat_ind_1[1], geodata.UV);
                matParams.specularFactor       =                     getMaterialColor(mat_ind_1[2], geodata.UV).r;
                matParams.refractiveIndexRatio =                     getMaterialColor(mat_ind_1[3], geodata.UV).r;
                matParams.mirrorProbability    =                     getMaterialColor(mat_ind_2[0], geodata.UV).r;`}
            }
            
            void computeRefractionParameters(in vec4 V, in vec4 N, in float vdotn, in float refractiveIndexRatio, in bool backside,
                out vec4 refractionDirection, out float kr)
            {
                if (refractiveIndexRatio > 0.0 && !isinf(refractiveIndexRatio)) {
                    
                    // compute the split between reflected light and refracted light
                    {
                        float ni = backside ? refractiveIndexRatio : 1.0,
                              nt = backside ? 1.0 : refractiveIndexRatio;
                        float cosi = vdotn,
                              sint = ni / nt * sqrt(max(0.0, 1.0 - cosi * cosi));

                        // Partial reflection/refraction, with a factor of kr being reflected, and (1-kr) being refracted
                        if (sint < 1.0) {
                            float cost = sqrt(max(0.0, 1.0 - sint * sint));
                            float Rs = ((nt * cosi) - (ni * cost)) / ((nt * cosi) + (ni * cost));
                            float Rp = ((ni * cosi) - (nt * cost)) / ((ni * cosi) + (nt * cost));
                            kr = (Rs * Rs + Rp * Rp) / 2.0;
                        }
                        else
                            kr = 1.0;
                    }
                    
                    // compute the direction that refracted light would come from
                    {
                        float r = backside ? refractiveIndexRatio : 1.0 / refractiveIndexRatio,
                              k = 1.0 - r * r * (1.0 - vdotn * vdotn);
                        if (k >= 0.0)
                            refractionDirection = -r * V + (r * vdotn - sqrt(k)) * N;
                    }
                }
                else {
                    kr = 1.0;
                    refractionDirection = vec4(0.0);
                }
            }
            
            bool glossyScatter(in vec4 R, in vec4 N, in PhongMaterialParameters matParams,
                inout vec4 outDirection, inout vec3 outColor, inout vec2 random_seed)
            {
                outColor = matParams.specular;
                if (isinf(matParams.specularFactor)) {
                    outDirection = R;
                    return true;
                }
                
                // Compute a space transform from local space to world space using R and another random base vector
                mat4 space_transform = transformToAlignY(R);

                // spherical coordinates following the PDF for Phong specular, theta is a simple uniform angle
                float theta = 2.0 * PI * randf(random_seed);
                float sin_theta = sin(theta), cos_theta = cos(theta);
                
                // Phi is harder: many angles may point away from the normal (through the material),
                // potentially leading to bad light leaks/black spots if not prevented.
                vec4 forward = space_transform * vec4(cos_theta, 0,  sin_theta, 0);
                vec4 right   = space_transform * vec4(sin_theta, 0, -cos_theta, 0);
                
                // So, to combat this, we first compute the maximum value phi can have before 
                vec4 phiN = (1.0 - abs(dot(right, N)) > EPSILON) ? vec4(normalize(cross(N.xyz, right.xyz)), 0.0) : R;
                if (dot(phiN, forward) < -EPSILON)
                    phiN = -1.0 * phiN;
                float maxPhi = acos(max(dot(R, phiN), 0.0));
                
                // then we use that to compute the minimum usable random value allowable.
                float minRand = pow(cos(maxPhi - EPSILON), matParams.specularFactor + 1.0);
                
                // Generate a random number in the safe range, following a rough Phong PDF.
                float phi = acos(pow((1.0 - minRand) * randf(random_seed) + minRand, 1.0 / (matParams.specularFactor + 1.0)));

                // Finally, convert spherical to local Cartesian, then to world space
                float sin_phi = sin(phi), cos_phi = cos(phi);
                outDirection = space_transform * vec4(
                    cos_theta * sin_phi,
                                cos_phi,
                    sin_theta * sin_phi, 0);
                
                // Even with all that care, numerical error occasionally creeps in and breaks things, especially if
                // R is very close to N. In that case, just return R.
                if (dot(outDirection, N) < 0.0)
                    outDirection = R;
                
                return true;
            }
            bool diffuseScatter(in vec4 N, in PhongMaterialParameters matParams,
                inout vec4 outDirection, inout vec3 outColor, inout vec2 random_seed)
            {
                outDirection = normalize(N + vec4(randomSpherePoint(random_seed), 0));
                outColor = matParams.diffuse;
                return true;
            }
            // outExact is set true when the direction wasn't randomly sampled from a lobe (a perfect mirror or an
            // infinitely smooth glossy lobe); the next bounce then counts a directly hit light's emission.
            bool samplePhongScatter(in vec4 R, in vec4 N, in PhongMaterialParameters matParams,
                inout vec4 outDirection, inout vec3 outColor, inout bool outExact, inout vec2 random_seed)
            {
                if (randf(random_seed) < matParams.mirrorProbability) {
                    outDirection = R;
                    outColor = vec3(1.0);
                    outExact = true;
                    return true;
                }
                outExact = false;

                float diffuseProb  = average(matParams.diffuse),
                      specularProb = average(matParams.specular);
                float probSum = diffuseProb + specularProb;
                
                if (probSum < EPSILON)
                    return false;
                
                if (randf(random_seed) < (diffuseProb / probSum))
                    return diffuseScatter(N, matParams, outDirection, outColor, random_seed);
                
                outExact = isinf(matParams.specularFactor);
                return glossyScatter(R, N, matParams, outDirection, outColor, random_seed);
            }
            
            vec3 phongBRDF(in vec4 N, in vec4 R, in vec4 lightDir, in float kr, in vec4 refractionDir, in PhongMaterialParameters matParams) {
                vec4 L = normalize(lightDir);
                float ldotn = dot(L, N);
                
                float diffuse = 0.0, specular = 0.0;
                if (kr > 0.0 && ldotn >= 0.0) {
                    diffuse  += kr * ldotn;
                    specular += kr * ldotn * safePow(max(dot(L, R), 0.0), matParams.specularFactor);
                }
                if (kr < 1.0 && ldotn <= 0.0) {
                    diffuse  += (1.0 - kr) * (-ldotn);
                    specular += (1.0 - kr) * -ldotn * safePow(max(dot(L, refractionDir), 0.0), matParams.specularFactor);
                }
                
                return diffuse * matParams.diffuse + specular * matParams.specular;
            }
            
            vec3 computePhongMaterialColor(in PhongMaterialParameters matParams, in vec4 rp, in vec4 rd, in vec4 normal,
                inout vec2 random_seed, inout RecursiveNextRays nextRays)
            {
                
                // standardize geometry data
                vec4 V = normalize(-rd);
                vec4 N = normalize(normal);
                float vdotn = dot(V, N);
                
                // check if this we have hit the backside of this material, and mark if so
                bool backside = false;
                if (vdotn < 0.0) {
                    N = -N;
                    vdotn = -vdotn;
                    backside = true;
                }
                
                vec4 R = normalize((2.0 * vdotn * N) - V);
                
                // Deal with refraction parameters
                float kr;
                vec4 refractionDirection;
                computeRefractionParameters(V, N, vdotn, matParams.refractiveIndexRatio, backside, refractionDirection, kr);

                // compute direct illumination
                vec3 totalColor = matParams.ambient;
                for (int i = 0; i < uNumLights; ++i) {
                    LightSample lightSample = sampleLight(i, rp, random_seed);
                    ${WebGLRendererAdapter.debugSkipUnlitShadows ? `
                    // debugSkipUnlitShadows: phongBRDF below is exactly zero unless (kr > 0 and the light is on the
                    // reflecting side) or (kr < 1 and it's on the transmitting side), so in every other case the shadow
                    // ray can't change the result. Skipping it is output-identical (the shadow cast uses no randomness).
                    {
                        float shadowLdotN = dot(normalize(lightSample.direction), N);
                        if (!((kr > 0.0 && shadowLdotN >= 0.0) || (kr < 1.0 && shadowLdotN <= 0.0)))
                            continue;
                    }` : ``}
                    ${WebGLRendererAdapter.debugNoShadows ? `` : `
                    float shadowIntersection = worldRayCast(Ray(rp, lightSample.direction), EPSILON, 1.0, true);
                    if (shadowIntersection > 0.0 && shadowIntersection < 1.0)
                        continue;
                    `}
                    totalColor += lightSample.color * phongBRDF(N, R, lightSample.direction, kr, refractionDirection, matParams);
                }
                
                
                // reflection
                if (kr > 0.0 && normSquared(matParams.reflectivity) > 0.0) {
                    nextRays.reflectionProbability = kr;
                    if (samplePhongScatter(R, N, matParams, nextRays.reflectionDirection, nextRays.reflectionColor, nextRays.reflectionExact, random_seed))
                        nextRays.reflectionColor *= matParams.reflectivity;
                }
                
                // refraction
                if (kr < 1.0 && normSquared(refractionDirection) > EPSILON) {
                    nextRays.transmissionProbability = 1.0 - kr;
                    if (samplePhongScatter(refractionDirection, N, matParams, nextRays.transmissionDirection, nextRays.transmissionColor, nextRays.transmissionExact, random_seed))
                        nextRays.transmissionColor *= matParams.transmissivity;
                }
                
                // transmission (no refraction)
                else if (isinf(matParams.refractiveIndexRatio) && normSquared(matParams.transmissivity) > 0.0) {
                    nextRays.transmissionProbability = 1.0;
                    if (samplePhongScatter(rd, N, matParams, nextRays.transmissionDirection, nextRays.transmissionColor, nextRays.transmissionExact, random_seed))
                        nextRays.transmissionColor *= matParams.transmissivity;
                }
                
                
                return totalColor;
            }
`;
        // BSDFs are needed for path tracing, and for any material that isn't one of the legacy Phong ones.
        this.ShaderUsesBSDFs = this.world_adapter.renderer_adapter.pathTracing || this.usesPrincipled;
        if (this.ShaderUsesBSDFs) {
            if (!this.albedo_tables.length)
                this.albedoTableIndex(AlbedoTable.whiteConductor());
            ret += WebGLMaterialsAdapter.BSDF_SHADER_SOURCE;
        }
        else
            ret += `
            // ---- Generic ----
            vec3 colorForMaterial(in int materialID, in vec4 rp, in Ray r, in GeometricMaterialData geodata,
                inout vec2 random_seed, inout RecursiveNextRays nextRays)
            {
                PhongMaterialParameters matParams;
                getPhongMaterialParameters(materialID, geodata, matParams);
                return computePhongMaterialColor(matParams, rp, r.d, geodata.normal, random_seed, nextRays);
            }`;
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
        if (this.textures.length)
            gl.uniform1iv(gl.getUniformLocation(program, "umTextures"),
                this.textures.map(t => WebGLHelper.textureUnitIndex(t.texture_unit)));
    }

    // The GLSL port of src/bsdf.js and the materials' surface() methods. See Materials.md.
    static BSDF_SHADER_SOURCE = `
            // ---- BSDFs (a port of src/bsdf.js; see Materials.md) ----
            // A BSDF here is a fixed set of lobe slots with weights, filled in by a material (buildPhongBSDF,
            // buildPrincipledBSDF), so evaluating, sampling and the pdf are each a single function no matter which
            // material made it. Lobes work in a local frame where the shading normal is +z; wo is stored local.
            // A lobe with a zero weight costs a branch and nothing else.
            uniform sampler2D uAlbedoTables;

            struct BSDF {
                vec3 n; vec3 t; vec3 b;      // world-space frame
                vec3 wo;                     // the outgoing direction, local

                vec3 lamb;  vec3 lambT;      // Lambertian reflection and (legacy) diffuse transmission
                vec3 phongR; vec3 axisR;     // normalized Phong lobes around a local axis, on each side
                vec3 phongT; vec3 axisT;
                float phongN;

                float alpha;                 // GGX roughness shared by the microfacet lobes
                vec3 cond; vec3 F0;          // conductor, Schlick Fresnel
                vec3 ms; float msEo; float msEavg;   // Kulla-Conty multiple scattering
                // Rough dielectric interfaces: [0] glass, [1] the specular layer of an opaque dielectric (dT[1] = 0,
                // so it only reflects). etap = (index on the far side) / (index on wo's side).
                vec3 dR[2]; vec3 dT[2]; float dEtap[2];

                vec3 mirror; vec3 pass;      // delta lobes: mirror, pass-through,
                vec3 smR; vec3 smT; float smEta;     // and a smooth dielectric (eta = n_wo / n_other)

                // Lobe selection weights: lamb, lambT, phongR, phongT, cond, ms, d0, d1, mirror, pass, smooth.
                float sw[11];
                float swSum;
                bool hasNonDelta;
            };
            struct BSDFSample {
                vec3 wi;        // world space
                vec3 weight;    // f |cos| / pdf, or the delta lobe's weight / its selection probability
                float pdf;      // 0 for delta lobes
                bool delta;
                bool ok;
            };

            void bsdfInit(inout BSDF f, in vec3 n, in vec3 woW) {
                f.n = n;
                // Orthonormal basis (Duff et al. 2017).
                float sgn = n.z >= 0.0 ? 1.0 : -1.0, a = -1.0 / (sgn + n.z), bb = n.x * n.y * a;
                f.t = vec3(1.0 + sgn * n.x * n.x * a, sgn * bb, -sgn * n.x);
                f.b = vec3(bb, sgn + n.y * n.y * a, -n.y);
                f.wo = normalize(vec3(dot(woW, f.t), dot(woW, f.b), dot(woW, f.n)));
                f.lamb = f.lambT = f.phongR = f.phongT = f.cond = f.F0 = f.ms = f.mirror = f.pass = f.smR = f.smT = vec3(0.0);
                f.axisR = f.axisT = vec3(0.0, 0.0, 1.0);
                f.phongN = 1.0; f.alpha = 1.0; f.msEo = 1.0; f.msEavg = 1.0; f.smEta = 1.0;
                for (int i = 0; i < 2; ++i) { f.dR[i] = vec3(0.0); f.dT[i] = vec3(0.0); f.dEtap[i] = 1.5; }
                for (int i = 0; i < 11; ++i) f.sw[i] = 0.0;
            }
            vec3 bsdfToLocal(in BSDF f, in vec3 v) { return vec3(dot(v, f.t), dot(v, f.b), dot(v, f.n)); }
            vec3 bsdfToWorld(in BSDF f, in vec3 l) { return f.t * l.x + f.b * l.y + f.n * l.z; }
            // Sets every lobe's selection weight to its average weight, as BSDF.add does by default, except where the
            // material set one already (sw > 0).
            void bsdfFinish(inout BSDF f) {
                vec3 w[11] = vec3[11](f.lamb, f.lambT, f.phongR, f.phongT, f.cond, f.ms, f.dR[0] + f.dT[0], f.dR[1],
                    f.mirror, f.pass, f.smR + f.smT);
                f.swSum = 0.0;
                for (int i = 0; i < 11; ++i) {
                    if (max(max(w[i].r, w[i].g), w[i].b) <= 0.0)
                        f.sw[i] = 0.0;
                    else if (f.sw[i] <= 0.0)
                        f.sw[i] = average(w[i]);
                    f.swSum += f.sw[i];
                }
                f.hasNonDelta = (f.sw[0] + f.sw[1] + f.sw[2] + f.sw[3] + f.sw[4] + f.sw[5] + f.sw[6] + f.sw[7]) > 0.0;
            }

            // ---- Albedo tables: 16 x 16 values E(mu, alpha) and 16 averages E_avg(alpha) each ----
            float albedoAt(in int table, in int i) {
                return texelFetchByIndex(table * 272 + i, uAlbedoTables).r;
            }
            float albedoLookup(in int table, in float mu, in float alpha) {
                float fx = clamp(mu, 0.0, 1.0) * 15.0, fy = clamp(alpha, 0.0, 1.0) * 15.0;
                int x0 = min(int(fx), 14), y0 = min(int(fy), 14);
                float tx = fx - float(x0), ty = fy - float(y0);
                int i = y0 * 16 + x0;
                return mix(mix(albedoAt(table, i),      albedoAt(table, i + 1),  tx),
                           mix(albedoAt(table, i + 16), albedoAt(table, i + 17), tx), ty);
            }
            float albedoAverage(in int table, in float alpha) {
                float fx = clamp(alpha, 0.0, 1.0) * 15.0;
                int x0 = min(int(fx), 14);
                return mix(albedoAt(table, 256 + x0), albedoAt(table, 257 + x0), fx - float(x0));
            }

            // ---- Fresnel and GGX ----
            // eta = (index of the incident side) / (index of the other side).
            float fresnelDielectric(in float cosi, in float eta) {
                cosi = min(1.0, abs(cosi));
                float sin2t = eta * eta * (1.0 - cosi * cosi);
                if (sin2t >= 1.0)
                    return 1.0;
                float cost = sqrt(1.0 - sin2t);
                float Rs = (cosi - eta * cost) / (cosi + eta * cost);
                float Rp = (eta * cosi - cost) / (eta * cosi + cost);
                return (Rs * Rs + Rp * Rp) * 0.5;
            }
            vec3 fresnelSchlick(in float cosi, in vec3 F0) {
                float m = 1.0 - min(1.0, abs(cosi));
                return F0 + (1.0 - F0) * (m * m * m * m * m);
            }
            float ggxD(in vec3 m, in float a) {
                if (m.z <= 0.0) return 0.0;
                float a2 = a * a, k = (m.x * m.x + m.y * m.y) / a2 + m.z * m.z;
                return 1.0 / (PI * a2 * k * k);
            }
            float ggxLambda(in vec3 w, in float a) {
                float cos2 = w.z * w.z;
                if (cos2 <= 0.0) return 1e20;
                return (sqrt(1.0 + a * a * (w.x * w.x + w.y * w.y) / cos2) - 1.0) * 0.5;
            }
            float ggxG1(in vec3 w, in float a) { return 1.0 / (1.0 + ggxLambda(w, a)); }
            float ggxG2(in vec3 wo, in vec3 wi, in float a) { return 1.0 / (1.0 + ggxLambda(wo, a) + ggxLambda(wi, a)); }
            float ggxDvisible(in vec3 w, in vec3 m, in float a) {
                float wm = dot(w, m);
                return wm > 0.0 ? ggxG1(w, a) * wm * ggxD(m, a) / w.z : 0.0;
            }
            // Visible normal sampling (Dupuy and Benyoub 2023).
            vec3 ggxSampleVisible(in vec3 w, in float a, in float u1, in float u2) {
                vec3 ws = normalize(vec3(a * w.x, a * w.y, w.z));
                float phi = 2.0 * PI * u1;
                float z = (1.0 - u2) * (1.0 + ws.z) - ws.z;
                float sinTheta = sqrt(max(0.0, 1.0 - z * z));
                vec3 h = vec3(sinTheta * cos(phi) + ws.x, sinTheta * sin(phi) + ws.y, z + ws.z);
                return normalize(vec3(a * h.x, a * h.y, max(0.0, h.z)));
            }
            vec3 sampleCosineHemisphere(in float u1, in float u2) {
                float r = sqrt(u1), phi = 2.0 * PI * u2;
                return vec3(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u1)));
            }

            // ---- Rough dielectric (Walter et al. 2007), slot k ----
            // The facet normal connecting wo and wi, oriented up, or zero if no facet can.
            vec3 dielectricFacet(in vec3 wo, in vec3 wi, in float etap) {
                vec3 m = wi * (wi.z > 0.0 ? 1.0 : etap) + wo;
                float len = length(m);
                if (len < 1e-7) return vec3(0.0);
                m *= (m.z < 0.0 ? -1.0 : 1.0) / len;
                if (dot(m, wi) * wi.z < 0.0 || dot(m, wo) * wo.z < 0.0) return vec3(0.0);
                return m;
            }
            // f, and (in pdf) the density of sampling wi, for dielectric slot k.
            vec3 dielectricEval(in BSDF f, in int k, in vec3 wi, out float pdf) {
                pdf = 0.0;
                vec3 wo = f.wo;
                bool reflectOnly = max(max(f.dT[k].r, f.dT[k].g), f.dT[k].b) <= 0.0;
                if (wo.z <= 0.0 || wi.z == 0.0 || (reflectOnly && wi.z < 0.0)) return vec3(0.0);
                float etap = f.dEtap[k];
                vec3 m = dielectricFacet(wo, wi, etap);
                if (m.z <= 0.0) return vec3(0.0);
                float F = fresnelDielectric(dot(wo, m), 1.0 / etap);
                float D = ggxD(m, f.alpha), G = ggxG2(wo, wi, f.alpha), Dv = ggxDvisible(wo, m, f.alpha);
                float pR = reflectOnly ? 1.0 : F;
                if (wi.z > 0.0) {
                    pdf = Dv / (4.0 * abs(dot(wo, m))) * pR;
                    return f.dR[k] * (D * G * F / (4.0 * wo.z * wi.z));
                }
                float wim = dot(wi, m), wom = dot(wo, m), s = wim + wom / etap;
                pdf = Dv * abs(wim) / (s * s) * (1.0 - pR);
                return f.dT[k] * abs(D * G * (1.0 - F) * wim * wom / (s * s * wi.z * wo.z));
            }

            // f(wo, wi) over the non-delta lobes, and the mixture's pdf (local directions).
            vec3 bsdfEvalLocal(in BSDF f, in vec3 wi, out float pdf) {
                vec3 wo = f.wo, ret = vec3(0.0);
                pdf = 0.0;
                if (!f.hasNonDelta || f.swSum <= 0.0) return ret;
                float invSum = 1.0 / f.swSum;
                if (wo.z > 0.0) {
                    if (wi.z > 0.0 && f.sw[0] > 0.0) {
                        ret += f.lamb / PI;
                        pdf += f.sw[0] * invSum * wi.z / PI;
                    }
                    if (wi.z < 0.0 && f.sw[1] > 0.0) {
                        ret += f.lambT / PI;
                        pdf += f.sw[1] * invSum * -wi.z / PI;
                    }
                    // Normalized Phong: f = (n + 2) / 2pi cos^n, sampled with density (n + 1) / 2pi cos^n.
                    if (wi.z > 0.0 && f.sw[2] > 0.0) {
                        float c = dot(wi, f.axisR);
                        if (c > 0.0) {
                            float cn = pow(c, f.phongN) / (2.0 * PI);
                            ret += f.phongR * (f.phongN + 2.0) * cn;
                            pdf += f.sw[2] * invSum * (f.phongN + 1.0) * cn;
                        }
                    }
                    if (wi.z < 0.0 && f.sw[3] > 0.0) {
                        float c = dot(wi, f.axisT);
                        if (c > 0.0) {
                            float cn = pow(c, f.phongN) / (2.0 * PI);
                            ret += f.phongT * (f.phongN + 2.0) * cn;
                            pdf += f.sw[3] * invSum * (f.phongN + 1.0) * cn;
                        }
                    }
                    if (wi.z > 0.0 && f.sw[4] > 0.0) {
                        vec3 h = normalize(wo + wi);
                        ret += fresnelSchlick(dot(wo, h), f.F0) * f.cond * (ggxD(h, f.alpha) * ggxG2(wo, wi, f.alpha) / (4.0 * wo.z * wi.z));
                        pdf += f.sw[4] * invSum * ggxDvisible(wo, h, f.alpha) / (4.0 * dot(wo, h));
                    }
                    if (wi.z > 0.0 && f.sw[5] > 0.0 && f.msEavg < 1.0) {
                        ret += f.ms * ((1.0 - f.msEo) * (1.0 - albedoLookup(0, wi.z, f.alpha)) / (PI * (1.0 - f.msEavg)));
                        pdf += f.sw[5] * invSum * wi.z / PI;
                    }
                    for (int k = 0; k < 2; ++k) {
                        if (f.sw[6 + k] <= 0.0) continue;
                        float p;
                        ret += dielectricEval(f, k, wi, p);
                        pdf += f.sw[6 + k] * invSum * p;
                    }
                }
                return ret;
            }
            vec3 bsdfEval(in BSDF f, in vec3 wiW, out float pdf) {
                return bsdfEvalLocal(f, normalize(bsdfToLocal(f, wiW)), pdf);
            }

            // Picks a lobe in proportion to its selection weight and samples it. A non-delta sample is weighted by the
            // whole mixture (MIS over the lobes with the balance heuristic), as on the CPU.
            BSDFSample bsdfSample(in BSDF f, inout vec2 random_seed, in bool deltaOnly) {
                BSDFSample s = BSDFSample(vec3(0.0), vec3(0.0), 0.0, false, false);
                float total = deltaOnly ? f.sw[8] + f.sw[9] + f.sw[10] : f.swSum;
                if (total <= 0.0) return s;
                float target = randf(random_seed) * total, u1 = randf(random_seed), u2 = randf(random_seed);
                int lobe = -1, last = 0;
                for (int i = deltaOnly ? 8 : 0; i < 11; ++i) {
                    if (f.sw[i] <= 0.0) continue;
                    last = i;
                    if (target < f.sw[i]) { lobe = i; break; }
                    target -= f.sw[i];
                }
                if (lobe < 0) lobe = last;   // rounding
                float prob = f.sw[lobe] / total;
                vec3 wo = f.wo, wi;
                if (lobe >= 8) {
                    s.delta = true;
                    if (lobe == 8) {
                        wi = vec3(-wo.x, -wo.y, wo.z);
                        s.weight = f.mirror / prob;
                    }
                    else if (lobe == 9) {
                        wi = -wo;
                        s.weight = f.pass / prob;
                    }
                    else {
                        float F = fresnelDielectric(wo.z, f.smEta);
                        if (u1 < F) {
                            wi = vec3(-wo.x, -wo.y, wo.z);
                            s.weight = f.smR / prob;
                        }
                        else {
                            wi = refract(-wo, vec3(0.0, 0.0, 1.0), f.smEta);
                            if (dot(wi, wi) == 0.0) return s;
                            s.weight = f.smT / prob;
                        }
                    }
                    s.wi = bsdfToWorld(f, wi);
                    s.ok = true;
                    return s;
                }
                if (wo.z <= 0.0) return s;
                if (lobe == 0 || lobe == 1 || lobe == 5) {
                    wi = sampleCosineHemisphere(u1, u2);
                    if (lobe == 1) wi.z = -wi.z;
                }
                else if (lobe == 2 || lobe == 3) {
                    vec3 axis = lobe == 2 ? f.axisR : f.axisT;
                    float cosa = pow(u1, 1.0 / (f.phongN + 1.0)), sina = sqrt(max(0.0, 1.0 - cosa * cosa)), phi = 2.0 * PI * u2;
                    float sgn = axis.z >= 0.0 ? 1.0 : -1.0, a = -1.0 / (sgn + axis.z), bb = axis.x * axis.y * a;
                    vec3 t = vec3(1.0 + sgn * axis.x * axis.x * a, sgn * bb, -sgn * axis.x), b = vec3(bb, sgn + axis.y * axis.y * a, -axis.y);
                    wi = t * (sina * cos(phi)) + b * (sina * sin(phi)) + axis * cosa;
                    if (wi.z * (lobe == 2 ? 1.0 : -1.0) <= 0.0) return s;
                }
                else if (lobe == 4) {
                    vec3 h = ggxSampleVisible(wo, f.alpha, u1, u2);
                    wi = reflect(-wo, h);
                    if (wi.z <= 0.0) return s;
                }
                else {
                    int k = lobe - 6;
                    vec3 m = ggxSampleVisible(wo, f.alpha, u1, u2);
                    bool reflectOnly = max(max(f.dT[k].r, f.dT[k].g), f.dT[k].b) <= 0.0;
                    float F = fresnelDielectric(dot(wo, m), 1.0 / f.dEtap[k]);
                    if (reflectOnly || randf(random_seed) < F) {
                        wi = reflect(-wo, m);
                        if (wi.z <= 0.0) return s;
                    }
                    else {
                        wi = refract(-wo, m, 1.0 / f.dEtap[k]);
                        if (dot(wi, wi) == 0.0 || wi.z >= 0.0) return s;
                    }
                }
                float pdf;
                vec3 fv = bsdfEvalLocal(f, wi, pdf);
                if (!(pdf > 0.0) || max(max(fv.r, fv.g), fv.b) <= 0.0) return s;
                s.wi = bsdfToWorld(f, wi);
                s.weight = fv * abs(wi.z) / pdf;
                s.pdf = pdf;
                s.ok = true;
                return s;
            }

            // ---- Materials as BSDFs (see the surface() methods in src/materials.js) ----
            // PhongMaterial, FresnelPhongMaterial and PhongPathTracingMaterial.
            void buildPhongBSDF(in int type, in PhongMaterialParameters p, in vec4 rd, in vec4 normal, inout BSDF f) {
                vec4 V = normalize(-rd), N = normalize(normal);
                float vdotn = dot(V, N);
                bool backside = false;
                if (vdotn < 0.0) {
                    N = -N;
                    vdotn = -vdotn;
                    backside = true;
                }
                vec4 R = normalize((2.0 * vdotn * N) - V);
                float kr;
                vec4 refr = vec4(0.0);
                computeRefractionParameters(V, N, vdotn, p.refractiveIndexRatio, backside, refr, kr);

                bsdfInit(f, N.xyz, V.xyz);
                bool finiteN = !isinf(p.specularFactor);
                f.phongN = finiteN ? p.specularFactor : 1.0;
                vec3 d = p.diffuse, sp = p.specular;
                if (type == MATERIAL_TYPE_PHONG || type == MATERIAL_TYPE_EMITTER) {
                    f.lamb = d;
                    if (finiteN) {
                        f.phongR = sp;
                        f.axisR = normalize(bsdfToLocal(f, R.xyz));
                    }
                    f.mirror = p.reflectivity;
                    f.pass = p.transmissivity;
                }
                else {
                    // FresnelPhongMaterial: rough lobes on both sides of the Fresnel split, plus a smooth dielectric
                    // (or a mirror, for an opaque one). PhongPathTracingMaterial: the same, as a mixture with the
                    // mirror taking mirrorProbability and the rough lobes sharing the rest.
                    vec3 deltaWeight = vec3(1.0);
                    if (type == MATERIAL_TYPE_PHONG_PATH) {
                        float m = p.mirrorProbability, pd = average(d), ps = average(sp), sum = pd + ps;
                        if (sum > 0.0 && m < 1.0) {
                            d  *= (1.0 - m) * pd / sum;
                            sp *= (1.0 - m) * ps / sum;
                        }
                        else
                            d = sp = vec3(0.0);
                        // An infinitely smooth glossy lobe is a mirror.
                        deltaWeight = vec3(m) + (finiteN ? vec3(0.0) : sp);
                    }
                    f.lamb = d * kr;
                    if (finiteN) {
                        f.phongR = sp * kr;
                        f.axisR = normalize(bsdfToLocal(f, R.xyz));
                    }
                    if (kr < 1.0 && dot(refr, refr) > 0.0) {
                        f.lambT = d * (1.0 - kr);
                        if (finiteN) {
                            f.phongT = sp * (1.0 - kr);
                            f.axisT = normalize(bsdfToLocal(f, refr.xyz));
                        }
                    }
                    if (p.refractiveIndexRatio > 0.0 && !isinf(p.refractiveIndexRatio)) {
                        f.smR = p.reflectivity * deltaWeight;
                        f.smT = p.transmissivity * deltaWeight;
                        f.smEta = backside ? p.refractiveIndexRatio : 1.0 / p.refractiveIndexRatio;
                    }
                    else
                        f.mirror = (type == MATERIAL_TYPE_PHONG_PATH) ? deltaWeight : p.reflectivity;
                }
                bsdfFinish(f);
            }

            // PrincipledMaterial: metal, glass and dielectric (specular over diffuse), blended.
            void buildPrincipledBSDF(in ivec4 m0, in ivec4 m1, in ivec4 m2, in vec4 rd, in vec4 normal, in vec2 UV,
                inout BSDF f, out vec3 emission)
            {
                vec3 V = normalize(-rd.xyz), N = normalize(normal.xyz);
                bool backside = dot(V, N) < 0.0;
                if (backside)
                    N = -N;
                float mu = min(1.0, abs(dot(V, N)));

                vec3  base         = getMaterialColor(m0[1], UV);
                float metallic     = clamp(getMaterialColor(m0[2], UV).r, 0.0, 1.0);
                float roughness    = clamp(getMaterialColor(m0[3], UV).r, 0.0, 1.0);
                float ior          = max(getMaterialColor(m1[0], UV).r, 1.0001);
                float transmission = clamp(getMaterialColor(m1[1], UV).r, 0.0, 1.0);
                emission           = getMaterialColor(m1[2], UV);
                int tableSpecular = m1[3], tableFront = m2[0], tableBack = m2[1];

                bsdfInit(f, N, V);
                float alpha = roughness * roughness;
                bool isSmooth = alpha < 1e-3;
                f.alpha = max(alpha, 1e-4);
                float wMetal = metallic, wGlass = (1.0 - metallic) * transmission, wDielectric = (1.0 - metallic) * (1.0 - transmission);

                if (wMetal > 0.0) {
                    if (isSmooth)
                        f.mirror += fresnelSchlick(mu, base) * wMetal;
                    else {
                        f.cond = vec3(wMetal);
                        f.F0 = base;
                        // Kulla-Conty: return the energy single scattering loses, tinted by repeated Fresnel.
                        f.msEavg = albedoAverage(0, alpha);
                        f.msEo = albedoLookup(0, mu, alpha);
                        vec3 Favg = base + (1.0 - base) / 21.0;
                        f.ms = Favg * Favg * f.msEavg / (1.0 - Favg * (1.0 - f.msEavg)) * wMetal;
                        f.sw[5] = average(f.ms) * (1.0 - f.msEo);
                        if (f.sw[5] <= 0.0)
                            f.ms = vec3(0.0);
                    }
                }
                if (wGlass > 0.0) {
                    // Entering from the front the far side is the dense one; from the back it's air.
                    float etap = backside ? 1.0 / ior : ior;
                    if (isSmooth) {
                        f.smR = vec3(wGlass);
                        f.smT = base * wGlass;
                        f.smEta = 1.0 / etap;
                    }
                    else {
                        // Turquin: scale by 1 / E(mu_o), the lobe's albedo from this side.
                        float k = 1.0 / max(0.05, albedoLookup(backside ? tableBack : tableFront, mu, alpha));
                        f.dR[0] = vec3(wGlass * k);
                        f.dT[0] = base * wGlass * k;
                        f.dEtap[0] = etap;
                        f.sw[6] = wGlass;
                    }
                }
                if (wDielectric > 0.0) {
                    // Opaque: two-sided, entering the dense side whichever side is hit. The diffuse base only gets
                    // the light the specular layer doesn't reflect.
                    float E = isSmooth ? fresnelDielectric(mu, 1.0 / ior) : albedoLookup(tableSpecular, mu, alpha);
                    if (isSmooth)
                        f.mirror += vec3(E * wDielectric);
                    else if (E > 0.0) {
                        f.dR[1] = vec3(wDielectric);
                        f.dEtap[1] = ior;
                        f.sw[7] = wDielectric * E;
                    }
                    f.lamb = base * wDielectric * (1.0 - E);
                }
                bsdfFinish(f);
            }

            // Power heuristic MIS weight, f^2 / (f^2 + g^2), written so huge densities can't overflow to inf / inf.
            float powerHeuristic(in float f, in float g) {
                if (f >= g) {
                    float r = g / f;
                    return 1.0 / (1.0 + r * r);
                }
                float r = f / g;
                return r * r / (1.0 + r * r);
            }

            // Direct light from every light. With mis (path tracing), each light sample is weighed against the chance
            // that BSDF sampling would have found the same light; without (Whitted mode), it counts fully.
            vec3 bsdfDirectLight(in BSDF f, in vec4 rp, in bool mis, inout vec2 random_seed) {
                vec3 L = vec3(0.0);
                if (!f.hasNonDelta)
                    return L;
                for (int i = 0; i < uNumLights; ++i) {
                    LightSample ls = sampleLight(i, rp, random_seed);
                    vec3 wi = normalize(ls.direction.xyz);
                    float pdf;
                    vec3 fv = bsdfEval(f, wi, pdf);
                    if (max(max(fv.r, fv.g), fv.b) <= 0.0)
                        continue;
                    float shadowIntersection = worldRayCast(Ray(rp, ls.direction), EPSILON, 1.0, true);
                    if (shadowIntersection > 0.0 && shadowIntersection < 1.0)
                        continue;
                    float w = (mis && ls.pdf > 0.0) ? powerHeuristic(ls.pdf, pdf) : 1.0;
                    L += fv * ls.color * abs(dot(f.n, wi)) * w;
                }
                return L;
            }

            // ---- Generic ----
            // In path tracing every material is a BSDF: light sampled directly (with MIS), plus one direction chosen
            // by the BSDF to continue the path. In Whitted mode the legacy Phong materials keep their original
            // shading (computePhongMaterialColor), and other BSDFs get direct light plus their delta directions.
            vec3 colorForMaterial(in int materialID, in vec4 rp, in Ray r, in GeometricMaterialData geodata,
                inout vec2 random_seed, inout RecursiveNextRays nextRays)
            {
                ivec4 m0, m1, m2;
                getMaterialIndices(materialID, m0, m1, m2);
                int type = m0[0];
                BSDF f;
                vec3 emission;
                if (type == MATERIAL_TYPE_PRINCIPLED)
                    buildPrincipledBSDF(m0, m1, m2, r.d, geodata.normal, geodata.UV, f, emission);
                else {
                    PhongMaterialParameters matParams;
                    getPhongMaterialParameters(materialID, geodata, matParams);
#ifdef PATH_TRACING
                    if (type == MATERIAL_TYPE_EMITTER) {
                        // A light's surface. If the path got here by sampling a BSDF, light sampling at the surface it
                        // left could have found this light too, so MIS splits the credit (see sampleLight's pdf).
                        vec3 Le = matParams.ambient;
                        if (gPrevBsdfPdf > 0.0) {
                            vec3 delta = rp.xyz - r.o.xyz;
                            float cosLight = abs(dot(normalize(r.d.xyz), normalize(geodata.normal.xyz)));
                            float area = getMaterialColor(m2[1], geodata.UV).r;
                            float lightPdf = cosLight > 0.0 ? dot(delta, delta) / (area * cosLight) : 1e30;
                            Le *= powerHeuristic(gPrevBsdfPdf, lightPdf);
                        }
                        return Le;
                    }
                    buildPhongBSDF(type, matParams, r.d, geodata.normal, f);
                    emission = matParams.ambient;
#else
                    return computePhongMaterialColor(matParams, rp, r.d, geodata.normal, random_seed, nextRays);
#endif
                }
#ifdef PATH_TRACING
                vec3 color = emission + bsdfDirectLight(f, rp, true, random_seed);
                BSDFSample s = bsdfSample(f, random_seed, false);
#else
                vec3 color = emission + bsdfDirectLight(f, rp, false, random_seed);
                BSDFSample s = bsdfSample(f, random_seed, true);
#endif
                if (s.ok) {
                    nextRays.reflectionProbability = 1.0;
                    nextRays.reflectionDirection = vec4(s.wi, 0.0);
                    nextRays.reflectionColor = s.weight;
                    nextRays.reflectionExact = s.delta;
                    nextRays.pdf = s.pdf;
                }
                return color;
            }
`;
}
