class WebGLMaterialsAdapter {
    static SPECIAL_COLOR_CHECKERBOARD = 1;
    static SPECIAL_COLOR_TEXTURE = 2;
    
    static MATERIAL_PROPERTIES = ["ambient", "diffuse", "specular", "reflectivity", "transmissivity", "specularFactor", "refractiveIndexRatio", "mirrorProbability"];
    
    constructor(webgl_helper) {
        this.webgl_helper = webgl_helper;
        
        [this.material_colors_texture_unit,  this.material_colors_texture]  = webgl_helper.createDataTextureAndUnit(3, "FLOAT");
        [this.material_indices_texture_unit, this.material_indices_texture] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        
        this.solid_colors = new WebGLVecStore(3, false);
        this.reset();
    }
    reset() {
        this.solid_colors.clear();
        this.solid_mc_map = {};
        
        this.textures = [];
        this.texture_id_map = {};
        this.special_colors = [];
        
        this.materials = [];
        this.material_id_map = {};
    }
    destroy() {
        this.material_colors_texture.destroy();
        this.material_indices_texture.destroy();
    }
    storeSolidColor(color) {
        const id = this.solid_colors.store(color);
        const ret = { _id: id, color: color };
        this.solid_mc_map[id] = ret;
        return ret;
    }
    collapseMaterialColor(mc, webgl_helper, scale=Vec.of(1,1,1)) {
        if (mc instanceof Vec)
            return Object.assign(this.storeSolidColor(mc.times(scale)), { type: "solid" });
        if (mc instanceof SolidMaterialColor) {
            return Object.assign(this.storeSolidColor(mc._color.times(scale)), {
                mc: mc,
                type: "solid"
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
                const td = { mc: mc };
                [ td.texture_unit, td.texture ] = webgl_helper.createTextureAndUnit(4, "IMAGEDATA", mc.width, mc.height, true, mc._imgdata);
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
            type: "scalar"
        });
    }
    visit(material, webgl_helper) {
        if (material.MATERIAL_UID in this.material_id_map)
            return this.material_id_map[material.MATERIAL_UID];
        
        const material_data = {};
        if (material instanceof PhongMaterial) {
            material_data.ambient        = this.visitMaterialColor(material.ambient,        webgl_helper);
            material_data.diffuse        = this.visitMaterialColor(material.diffusivity,    webgl_helper);
            material_data.specular       = this.visitMaterialColor(material.specularity,    webgl_helper);
            material_data.reflectivity   = this.visitMaterialColor(material.reflectivity,   webgl_helper);
            material_data.transmissivity = this.visitMaterialColor(material.transmissivity, webgl_helper);
            material_data.specularFactor = this.visitMaterialScalar(material.smoothness);
            if (material instanceof FresnelPhongMaterial) {
                material_data.refractiveIndexRatio  = this.visitMaterialScalar(material.refractiveIndexRatio);
                if (material instanceof PhongPathTracingMaterial)
                    material_data.mirrorProbability = this.visitMaterialScalar(material.mirrorProbability);
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
        this.material_colors_texture.modifyDataPixel(solid_color_index, new_color);
        this.solid_mc_map[solid_color_index].color = new_color;
    }
    modifyScalar(index, new_scalar) {
        this.modifySolidColor(index, Vec.of(new_scalar, 0, 0));
        this.solid_mc_map[index].value = new_scalar;
    }
    writeShaderData(gl, program, webgl_helper) {
        this.material_colors_texture.setDataPixelsUnit(this.solid_colors.flat(), this.material_colors_texture_unit, "umMaterialColors", program);
        this.material_indices_texture.setDataPixelsUnit(
            this.materials.map(m => WebGLMaterialsAdapter.MATERIAL_PROPERTIES.map(k => m[k]._id)).flat(),
            this.material_indices_texture_unit, "umMaterialIndices", program);
        
        if (this.special_colors.length)
            gl.uniform3iv(gl.getUniformLocation(program, "umSpecialColors"), this.special_colors.flat());
        if (this.textures.length)
            gl.uniform1iv(gl.getUniformLocation(program, "umTextures"),
                this.textures.map(t => WebGLHelper.textureUnitIndex(t.texture_unit)));
    }
    getShaderSourceDeclarations() {
        return `
            #define MATERIALCOLOR_SPECIAL_CHECKERBOARD ${WebGLMaterialsAdapter.SPECIAL_COLOR_CHECKERBOARD}
            #define MATERIALCOLOR_SPECIAL_TEXTURE      ${WebGLMaterialsAdapter.SPECIAL_COLOR_TEXTURE}
            vec3 getMaterialColor(in int color_index, in vec2 UV);
            vec3 colorForMaterial(in int materialID, in vec4 intersect_position, in Ray r, in GeometricMaterialData data,
                inout vec2 random_seed, inout RecursiveNextRays nextRays);`
    }
    getShaderSource() {
        function makeStaticTextureShaderSource(i) {
            return `
                case ${i}:
                    return texture(umTextures[${i}], vec2(UV.x, 1.0-UV.y)).xyz * getSolidColor(special_color.z);`;
        }
        return `
            uniform sampler2D umTextures [${ Math.max(1, this.textures.length)       }];
            uniform ivec3 umSpecialColors[${ Math.max(4, this.special_colors.length) }];
            uniform  sampler2D umMaterialColors;
            uniform isampler2D umMaterialIndices;

            vec3 getSolidColor(in int color_index) {
                return texelFetchByIndex(color_index, umMaterialColors).xyz;
            }
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
            
            struct PhongMaterialParameters {
                vec3 ambient;
                vec3 diffuse;
                vec3 specular;
                vec3 reflectivity;
                vec3 transmissivity;
                float specularFactor;
                float refractiveIndexRatio;
                float mirrorProbability;
            };
            
            void getPhongMaterialParameters(in int materialID, in GeometricMaterialData geodata, out PhongMaterialParameters matParams) {
                ivec4 mat_ind_1 = itexelFetchByIndex(materialID * 2    , umMaterialIndices),
                      mat_ind_2 = itexelFetchByIndex(materialID * 2 + 1, umMaterialIndices);
                matParams.ambient              = geodata.baseColor * getMaterialColor(mat_ind_1[0], geodata.UV);
                matParams.diffuse              = geodata.baseColor * getMaterialColor(mat_ind_1[1], geodata.UV);
                matParams.specular             =                     getMaterialColor(mat_ind_1[2], geodata.UV);
                matParams.reflectivity         =                     getMaterialColor(mat_ind_1[3], geodata.UV);
                matParams.transmissivity       =                     getMaterialColor(mat_ind_2[0], geodata.UV);
                matParams.specularFactor       =                     getMaterialColor(mat_ind_2[1], geodata.UV).r;
                matParams.refractiveIndexRatio =                     getMaterialColor(mat_ind_2[2], geodata.UV).r;
                matParams.mirrorProbability    =                     getMaterialColor(mat_ind_2[3], geodata.UV).r;
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
                
                // phi is harder: many possibly options may point away from the normal (through the material) if we're not careful
                // This can lead to light leaks/black spots in surfaces if we can't prevent it.
                vec4 forward = space_transform * vec4(cos_theta, 0,  sin_theta, 0);
                vec4 right   = space_transform * vec4(sin_theta, 0, -cos_theta, 0);
                
                // So, to combat this, we first compute the maximum value phi can have before something breaks
                vec4 phiN = (1.0 - abs(dot(right, N)) > EPSILON) ? vec4(normalize(cross(N.xyz, right.xyz)), 0.0) : R;
                if (dot(phiN, forward) < -EPSILON)
                    phiN = -1.0 * phiN;
                float maxPhi = acos(max(dot(R, phiN), 0.0));
                
                // then we use that to compute the minimum usable random value allowable
                float minRand = pow(cos(maxPhi - EPSILON), matParams.specularFactor + 1.0);
                
                // finally generate a random number in the safe range
                float phi = acos(pow((1.0 - minRand) * randf(random_seed) + minRand, 1.0 / (matParams.specularFactor + 1.0)));

                // convert spherical to local Cartesian, then to world space
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
                outColor = matParams.diffuse / PI;
                return true;
            }
            bool samplePhongScatter(in vec4 R, in vec4 N, in PhongMaterialParameters matParams,
                inout vec4 outDirection, inout vec3 outColor, inout vec2 random_seed)
            {
                if (randf(random_seed) < matParams.mirrorProbability) {
                    outDirection = R;
                    outColor = vec3(1.0);
                    return true;
                }

                float diffuseProb  = average(matParams.diffuse),
                      specularProb = average(matParams.specular);
                float probSum = diffuseProb + specularProb;
                
                if (probSum < EPSILON)
                    return false;
                
                if (randf(random_seed) < (diffuseProb / probSum))
                    return diffuseScatter(N, matParams, outDirection, outColor, random_seed);
                
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
                    
                    float shadowIntersection = worldRayCast(Ray(rp, lightSample.direction), EPSILON, 1.0, true);
                    if (shadowIntersection > 0.0 && shadowIntersection < 1.0)
                        continue;
                    
                    totalColor += lightSample.color * phongBRDF(N, R, lightSample.direction, kr, refractionDirection, matParams);
                }
                
                // reflection/refraction/transmission
                if (kr > 0.0 && normSquared(matParams.reflectivity) > 0.0) {
                    nextRays.reflectionProbability = kr;
                    if (samplePhongScatter(R, N, matParams, nextRays.reflectionDirection, nextRays.reflectionColor, random_seed))
                        nextRays.reflectionColor *= matParams.reflectivity;
                }
                if (kr < 1.0 && normSquared(refractionDirection) > 0.0) {
                    nextRays.transmissionProbability = 1.0 - kr;
                    if (samplePhongScatter(refractionDirection, N, matParams, nextRays.transmissionDirection, nextRays.transmissionColor, random_seed))
                        nextRays.transmissionColor *= matParams.transmissivity;
                }
                else if (isinf(matParams.refractiveIndexRatio) && normSquared(matParams.transmissivity) > 0.0) {
                    nextRays.transmissionProbability = 1.0;
                    if (samplePhongScatter(rd, N, matParams, nextRays.transmissionDirection, nextRays.transmissionColor, random_seed))
                        nextRays.transmissionColor *= matParams.transmissivity;
                }
                
                return totalColor;
            }

            // ---- Generic ----
            vec3 colorForMaterial(in int materialID, in vec4 rp, in Ray r, in GeometricMaterialData geodata,
                inout vec2 random_seed, inout RecursiveNextRays nextRays)
            {
                PhongMaterialParameters matParams;
                getPhongMaterialParameters(materialID, geodata, matParams);
                return computePhongMaterialColor(matParams, rp, r.d, geodata.normal, random_seed, nextRays);
            }`;
    }
}