class WebGLMaterialsAdapter {
    static SPECIAL_COLOR_CHECKERBOARD = 1;
    static SPECIAL_COLOR_TEXTURE = 2;
    constructor(webgl_helper) {
        this.webgl_helper = webgl_helper;
        
        this.solid_colors = new WebGLVecStore();
        
        this.textures = [];
        this.texture_id_map = {};
        this.special_colors = [];
        
        this.materials = [];
        this.material_id_map = {};
    }
    destroy() {}
    collapseMaterialColor(mc, webgl_helper, scale=Vec.of(1,1,1)) {
        if (mc instanceof SolidMaterialColor)
            return this.solid_colors.visit(mc._color.times(scale));
        else if (mc instanceof ScaledMaterialColor)
            return this.collapseMaterialColor(mc._mc, webgl_helper, scale.times(mc._scale));
        else if (mc instanceof CheckerboardMaterialColor) {
            this.special_colors.push([
                WebGLMaterialsAdapter.SPECIAL_COLOR_CHECKERBOARD,
                this.solid_colors.visit(mc.color1.toSolidColor()._color.times(scale)),
                this.solid_colors.visit(mc.color2.toSolidColor()._color.times(scale))
            ]);
            return -this.special_colors.length;
        }
        else if (mc instanceof TextureMaterialColor) {
            if (!(mc.MATERIALCOLOR_UID in this.texture_id_map)) {
                this.texture_id_map[mc.MATERIALCOLOR_UID] = this.textures.length;
                const td = { mc: mc };
                [ td.texture_unit, td.texture ] = webgl_helper.createTextureAndUnit(4, "IMAGEDATA", mc.width, mc.height, true, mc._imgdata);
                this.textures.push(td);
            }
            this.special_colors.push([
                WebGLMaterialsAdapter.SPECIAL_COLOR_TEXTURE,
                this.texture_id_map[mc.MATERIALCOLOR_UID],
                this.solid_colors.visit(scale)]);
            return -this.special_colors.length;
        }
        throw "Unsupported material color type";
    }
    visitMaterialColor(mc, webgl_helper) {
        return this.collapseMaterialColor(mc, webgl_helper);
    }
    visit(material, webgl_helper) {
        if (material.MATERIAL_UID in this.material_id_map)
            return this.material_id_map[material.MATERIAL_UID];
        
        const material_data = {};
        if (material instanceof PhongMaterial) {
            material_data.ambient_id      = this.visitMaterialColor(material.ambient,      webgl_helper);
            material_data.diffuse_id      = this.visitMaterialColor(material.diffusivity,  webgl_helper);
            material_data.specular_id     = this.visitMaterialColor(material.specularity,  webgl_helper);
            material_data.reflectivity_id = this.visitMaterialColor(material.reflectivity, webgl_helper);
            material_data.specularFactor  = material.smoothness;
            if (material instanceof FresnelPhongMaterial) {
                material_data.refractiveIndexRatio = material.refractiveIndexRatio;
                if (material instanceof PhongPathTracingMaterial) {
                    material_data.pathSmoothness = material.pathSmoothness;
                    material_data.bounceProbability = material.bounceProbability;
                }
                else {
                    material_data.pathSmoothness = Infinity;
                    material_data.bounceProbability = 1.0;
                }
            }
            else {
                material_data.refractiveIndexRatio = Infinity;
                material_data.pathSmoothness = Infinity;
                material_data.bounceProbability = 1.0;
            }
        }
        else
            throw "Unsupported material type";
        
        this.material_id_map[material.MATERIAL_UID] = this.materials.length;
        this.materials.push(material_data);
        return this.material_id_map[material.MATERIAL_UID];
    }
    writeShaderData(gl, program, webgl_helper) {
        if (this.solid_colors.size())    gl.uniform3fv(gl.getUniformLocation(program, "umSolidColors"),   this.solid_colors.flat());
        if (this.special_colors.length)  gl.uniform3iv(gl.getUniformLocation(program, "umSpecialColors"), this.special_colors.flat());
        if (this.textures.length)        gl.uniform1iv(gl.getUniformLocation(program, "umTextures"),      this.textures.map(t => webgl_helper.textureUnitIndex(t.texture_unit)));
        
        if (this.materials.length) {
            gl.uniform1iv(gl.getUniformLocation(program, "umPhongMaterialAmbientMCs"),            this.materials.map(m => m.ambient_id));
            gl.uniform1iv(gl.getUniformLocation(program, "umPhongMaterialDiffuseMCs"),            this.materials.map(m => m.diffuse_id));
            gl.uniform1iv(gl.getUniformLocation(program, "umPhongMaterialSpecularMCs"),           this.materials.map(m => m.specular_id));
            gl.uniform1iv(gl.getUniformLocation(program, "umPhongMaterialReflectivityMCs"),       this.materials.map(m => m.reflectivity_id));
            gl.uniform1fv(gl.getUniformLocation(program, "umPhongMaterialSpecularFactors"),       this.materials.map(m => m.specularFactor));
            gl.uniform1fv(gl.getUniformLocation(program, "umPhongMaterialRefractiveIndexRatios"), this.materials.map(m => m.refractiveIndexRatio));
            gl.uniform1fv(gl.getUniformLocation(program, "umPhongMaterialPathSmoothnesses"),      this.materials.map(m => m.pathSmoothness));
            gl.uniform1fv(gl.getUniformLocation(program, "umPhongMaterialBounceProbabilities"),   this.materials.map(m => m.bounceProbability));
        }
    }
    getShaderSourceDeclarations() {
        return `
            #define MATERIALCOLOR_SPECIAL_CHECKERBOARD ${WebGLMaterialsAdapter.SPECIAL_COLOR_CHECKERBOARD}
            #define MATERIALCOLOR_SPECIAL_TEXTURE      ${WebGLMaterialsAdapter.SPECIAL_COLOR_TEXTURE}
            vec3 colorForMaterial(in int materialID, in vec4 intersect_position, in Ray r, in GeometricMaterialData data,
                inout vec2 random_seed, inout RecursiveNextRays nextRays);`
    }
    getShaderSource() {
        function makeStaticTextureShaderSource(i) {
            return `
                case ${i}:
                    return texture(umTextures[${i}], vec2(UV.x, 1.0-UV.y)).xyz * umSolidColors[special_color.z];`;
        }
        return `
            uniform sampler2D umTextures[${Math.max(1, this.textures.length)}];
            
            uniform vec3  umSolidColors[${   Math.max(1, this.solid_colors.size())}];
            uniform ivec3 umSpecialColors[${ Math.max(1, this.special_colors.length)}];
            
            #define MAX_MATERIALS ${Math.max(this.materials.length, 1)}
            uniform int   umPhongMaterialAmbientMCs           [MAX_MATERIALS];
            uniform int   umPhongMaterialDiffuseMCs           [MAX_MATERIALS];
            uniform int   umPhongMaterialSpecularMCs          [MAX_MATERIALS];
            uniform int   umPhongMaterialReflectivityMCs      [MAX_MATERIALS];
            uniform float umPhongMaterialSpecularFactors      [MAX_MATERIALS];
            uniform float umPhongMaterialRefractiveIndexRatios[MAX_MATERIALS];
            uniform float umPhongMaterialPathSmoothnesses     [MAX_MATERIALS];
            uniform float umPhongMaterialBounceProbabilities  [MAX_MATERIALS];

            vec3 getMaterialColor(in int color_index, in vec2 UV) {
                // Special color
                if (color_index < 0) {
                    ivec3 special_color = umSpecialColors[-color_index - 1];
                    if (special_color.x == MATERIALCOLOR_SPECIAL_CHECKERBOARD)
                        return umSolidColors[(mod(floor(UV.x) + floor(UV.y), 2.0) < 1.0) ? special_color.y : special_color.z];
                    if (special_color.x == MATERIALCOLOR_SPECIAL_TEXTURE) {
                        switch (special_color.y) {
                            ${ new Array(this.textures.length).fill(0).map((_,i) => makeStaticTextureShaderSource(i)).join('') }
                            default: break;
                        }
                    }
                }
                // Solid color
                return umSolidColors[color_index];
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
            
            struct PhongMaterialParameters {
                vec3 ambient;
                vec3 diffuse;
                vec3 specular;
                vec3 reflectivity;
                float specularFactor;
                float refractiveIndexRatio;
                float pathSmoothness;
                float bounceProbability;
            };
            
            void getPhongMaterialParameters(in int materialID, in GeometricMaterialData geodata, out PhongMaterialParameters matParams) {
                matParams.ambient              = getMaterialColor(umPhongMaterialAmbientMCs     [materialID], geodata.UV);
                matParams.diffuse              = getMaterialColor(umPhongMaterialDiffuseMCs     [materialID], geodata.UV);
                matParams.specular             = getMaterialColor(umPhongMaterialSpecularMCs    [materialID], geodata.UV);
                matParams.reflectivity         = getMaterialColor(umPhongMaterialReflectivityMCs[materialID], geodata.UV);
                matParams.specularFactor       = umPhongMaterialSpecularFactors      [materialID];
                matParams.refractiveIndexRatio = umPhongMaterialRefractiveIndexRatios[materialID];
                matParams.pathSmoothness       = umPhongMaterialPathSmoothnesses     [materialID];
                matParams.bounceProbability    = umPhongMaterialBounceProbabilities  [materialID];
            }
            
            
            vec4 samplePhongDirectionPDF(in vec4 R, in vec4 N, in float pathSmoothness, inout vec2 random_seed) {
                if (isinf(pathSmoothness))
                    return R;
                if (pathSmoothness <= 0.0)
                    R = N;

                // Compute a space transform from local space to world space using R and another random base vector
                mat4 space_transform = mat4(1.0);
                for (int i = 0; i < 3; ++i) {
                    vec4 axis = vec4(0.0);
                    axis[i] = 1.0;
                    if (1.0 - dot(axis, R) > EPSILON) {
                        space_transform[0] = vec4(normalize(cross(axis.xyz, R.xyz)).xyz, 0);
                        space_transform[1] = R;
                        space_transform[2] = vec4(normalize(cross(R.xyz, space_transform[0].xyz)).xyz, 0);
                        break;
                    }
                }

                // spherical coordinates following the PDF for Phong, theta is easy
                float theta = 2.0 * PI * randf(random_seed);
                float sin_theta = sin(theta), cos_theta = cos(theta);
                
                // phi is harder: many possibly options may point away from the normal (through the material) if we're not careful
                float minRand = 0.0;
                if (pathSmoothness > 0.0) {
                    vec4 forward = space_transform * vec4(cos_theta, 0,  sin_theta, 0);
                    vec4 right   = space_transform * vec4(sin_theta, 0, -cos_theta, 0);
                    
                    // So, to combat this, we first compute the maximum value phi can have before something breaks
                    vec4 phiN = (1.0 - dot(right, N) > EPSILON) ? vec4(normalize(cross(N.xyz, right.xyz)), 0.0) : R;
                    if (dot(phiN, forward) < -EPSILON)
                        phiN = -1.0 * phiN;
                    float maxPhi = acos(max(dot(R, phiN), 0.0));
                    
                    // then we use that to compute the minimum usable random value allowable
                    minRand = pow(cos(maxPhi - EPSILON), pathSmoothness + 1.0);
                }
                
                // finally generate a random number in the given range
                float phi = acos(pow((1.0 - minRand) * randf(random_seed) + minRand, 1.0 / (pathSmoothness + 1.0)));

                // convert spherical to local Cartesian, then to world space
                float sin_phi = sin(phi), cos_phi = cos(phi);
                vec4 ret = space_transform * vec4(
                    cos_theta * sin_phi,
                                cos_phi,
                    sin_theta * sin_phi, 0);
                
                // Even with all that care, numerical error occasionally creeps in and breaks things, simply return the source if so
                if (dot(ret, N) < 0.0)
                    return R;
                
                return ret;
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
                    vec4 lightDirection;
                    vec3 lightColor;
                    sampleLight(i, rp, lightDirection, lightColor, random_seed);
                    
                    float shadowIntersection = sceneRayCast(Ray(rp, lightDirection), EPSILON, 1.0, true);
                    if (shadowIntersection > 0.0 && shadowIntersection < 1.0)
                        continue;
                    
                    vec4 L = normalize(lightDirection);
                    float ldotn = dot(L, N);
                    
                    float diffuse = 0.0, specular = 0.0;
                    if (kr > 0.0 && ldotn >= 0.0) {
                        diffuse  += kr * ldotn;
                        specular += kr * safePow(max(dot(L, R), 0.0), matParams.specularFactor);
                    }
                    if (kr < 1.0 && ldotn <= 0.0) {
                        diffuse  += (1.0 - kr) * (-ldotn);
                        specular += (1.0 - kr) * safePow(max(dot(L, refractionDirection), 0.0), matParams.specularFactor);
                    }
                    totalColor += lightColor * (diffuse * matParams.diffuse + specular * matParams.specular);
                }
                
                // reflection/refraction
                if (matParams.bounceProbability > 0.0 && (matParams.bounceProbability >= 1.0 || randf(random_seed) <= matParams.bounceProbability)) {
                    nextRays.reflectionProbability = kr;
                    if (kr > 0.0 && dot(matParams.reflectivity, matParams.reflectivity) > 0.0) {
                        nextRays.reflectionDirection = samplePhongDirectionPDF(R, N, matParams.pathSmoothness, random_seed);
                        nextRays.reflectionColor = matParams.reflectivity;
                    }
                    if (kr < 1.0 && dot(refractionDirection, refractionDirection) > 0.0) {
                        nextRays.refractionDirection = samplePhongDirectionPDF(refractionDirection, N, matParams.pathSmoothness, random_seed);
                        nextRays.refractionColor = matParams.reflectivity;
                    }
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