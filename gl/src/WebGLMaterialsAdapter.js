class WebGLMaterialsAdapter {
    constructor(webgl_helper) {
        this.solid_colors = new WebGLVecStore();
        this.checkerboard_colors = [];
        
        this.materials = [];
        this.material_id_map = {};
    }
    collapseMaterialColor(mc, scale=Vec.of(1,1,1)) {
        if (mc instanceof SolidMaterialColor)
            return this.solid_colors.visit(mc._color.times(scale));
        if (mc instanceof ScaledMaterialColor)
            return this.collapseMaterialColor(mc._mc, scale.times(mc._scale));
        if (mc instanceof CheckerboardMaterialColor) {
            this.checkerboard_colors.push([
                this.collapseMaterialColor(new ScaledMaterialColor(mc.color1.toSolidColor()._color, scale)),
                this.collapseMaterialColor(new ScaledMaterialColor(mc.color2.toSolidColor()._color, scale))
            ]);
            return -this.checkerboard_colors.length;
        }
        else
            throw "Unsupported material color type";
    }
    visitMaterialColor(mc) {
        return this.collapseMaterialColor(mc);
    }
    visit(material) {
        if (material.MATERIAL_UID in this.material_id_map)
            return this.material_id_map[material.MATERIAL_UID];
        
        const material_data = {};
        if (material instanceof PhongMaterial) {
            material_data.ambient_id      = this.visitMaterialColor(material.ambient);
            material_data.diffuse_id      = this.visitMaterialColor(material.diffusivity);
            material_data.specular_id     = this.visitMaterialColor(material.specularity);
            material_data.reflectivity_id = this.visitMaterialColor(material.reflectivity);
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
    writeShaderData(gl, program) {
        if (this.solid_colors.size())
            gl.uniform3fv(gl.getUniformLocation(program, "umSolidColors"), this.solid_colors.to_webgl());
        
        if (this.checkerboard_colors.length)
            gl.uniform1iv(gl.getUniformLocation(program, "umCheckerboardColors"), this.checkerboard_colors.flat());
        
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
            vec3 colorForMaterial(in int materialID, in vec4 intersect_position, in Ray r, in GeometricMaterialData data,
                inout vec2 random_seed, inout RecursiveNextRays nextRays);`
    }
    getShaderSource() {
        return `
            uniform vec3 umSolidColors[${Math.max(1, this.solid_colors.size())}];
            uniform int umCheckerboardColors[${Math.max(1, 2*this.checkerboard_colors.length)}];
            
            #define MAX_MATERIALS ${Math.max(this.materials.length, 1)}
            uniform int   umPhongMaterialAmbientMCs           [MAX_MATERIALS];
            uniform int   umPhongMaterialDiffuseMCs           [MAX_MATERIALS];
            uniform int   umPhongMaterialSpecularMCs          [MAX_MATERIALS];
            uniform int   umPhongMaterialReflectivityMCs      [MAX_MATERIALS];
            uniform float umPhongMaterialSpecularFactors      [MAX_MATERIALS];
            uniform float umPhongMaterialRefractiveIndexRatios[MAX_MATERIALS];
            uniform float umPhongMaterialPathSmoothnesses[MAX_MATERIALS];
            uniform float umPhongMaterialBounceProbabilities[MAX_MATERIALS];

            vec3 getMaterialColor(in int color_index, in vec2 UV) {
                // checkerboard
                if (color_index < 0) {
                    int checkerboard_cell = (mod(floor(UV.x) + floor(UV.y), 2.0) < 1.0) ? 0 : 1;
                    return umSolidColors[umCheckerboardColors[-2 * (color_index + 1) + checkerboard_cell]];
                }
                return umSolidColors[color_index];
            }
            
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
            
            
            vec4 samplePhongDirectionPDF(in vec4 V, in vec4 R, in float vdotn, in float pathSmoothness, inout vec2 random_seed) {
                if (!isinf(pathSmoothness))
                    return R;
                
                // spherical coordinates following the PDF for Phong
                float phi = acos(pow(randf(random_seed), 1.0 / (pathSmoothness + 1.0))),
                    theta = 2.0 * PI * randf(random_seed);

                // Compute a space transform from local space to world space using the V and R vectors as bases
                mat4 space_transform = mat4(1.0);
                if (1.0 - vdotn > EPSILON) {
                    space_transform[0] = vec4(normalize(cross(V.xyz, R.xyz)).xyz, 0);
                    space_transform[1] = R;
                    space_transform[2] = vec4(cross(R.xyz, space_transform[0].xyz).xyz, 0);
                }

                // convert spherical to local Cartesian, then to world space
                float sin_phi = sin(phi);
                return space_transform * vec4(
                    cos(theta) * sin_phi,
                    cos(phi),
                    sin(theta) * sin_phi, 0);
            }
            
            
            vec3 computePhongMaterialColor(in PhongMaterialParameters matParams, in vec4 rp, in vec4 rd, in vec4 normal,
                inout vec2 random_seed, inout RecursiveNextRays nextRays)
            {
                
                // standardize geometry data
                vec4 V = normalize(-rd);
                vec4 N = normalize(normal);
                
                float vdotn = dot(V, N);
                bool backside = false;
                if (vdotn < 0.0) {
                    N = -N;
                    vdotn = -vdotn;
                    backside = true;
                }
                
                vec4 R = normalize((2.0 * vdotn * N) - V);
                
                // Deal with refraction parameters
                float kr = 1.0;
                vec4 refractionDirection = vec4(0.0);
                if (matParams.refractiveIndexRatio > 0.0 && !isinf(matParams.refractiveIndexRatio)) {
                    
                    // compute the split between reflected light and refracted light
                    {
                        float ni = backside ? matParams.refractiveIndexRatio : 1.0,
                              nt = backside ? 1.0 : matParams.refractiveIndexRatio;
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
                        float r = backside ? matParams.refractiveIndexRatio : 1.0 / matParams.refractiveIndexRatio,
                              k = 1.0 - r * r * (1.0 - vdotn * vdotn);
                        if (k >= 0.0)
                            refractionDirection = -r * V + (r * vdotn - sqrt(k)) * N;
                    }
                }

                // compute direct illumination
                vec3 totalColor = matParams.ambient;
                for (int i = 0; i < uNumLights; ++i) {
                    vec4 lightDirection;
                    vec3 lightColor;
                    sampleLight(i, rp, lightDirection, lightColor, random_seed);
                    
                    float shadowIntersection = sceneRayCast(Ray(rp, lightDirection), EPSILON, true);
                    if (shadowIntersection > 0.0 && shadowIntersection < 1.0)
                        continue;
                    
                    vec4 L = normalize(lightDirection);
                    float ldotn = dot(L, N);
                    
                    float diffuse = 0.0, specular = 0.0;
                    if (kr > 0.0 && ldotn >= 0.0) {
                        diffuse  += kr * ldotn;
                        specular += kr * pow(max(dot(L, R), 0.0), matParams.specularFactor);
                    }
                    if (kr < 1.0 && ldotn <= 0.0) {
                        diffuse  += (1.0 - kr) * (-ldotn);
                        specular += (1.0 - kr) * pow(max(dot(L, refractionDirection), 0.0), matParams.specularFactor);
                    }
                    totalColor += lightColor * (diffuse * matParams.diffuse + specular * matParams.specular);
                }
                
                // reflection/refraction
                if (matParams.bounceProbability > 0.0 && (matParams.bounceProbability >= 1.0 || randf(random_seed) <= matParams.bounceProbability)) {
                    nextRays.reflectionProbability = kr;
                    if (kr > 0.0 && dot(matParams.reflectivity, matParams.reflectivity) > 0.0) {
                        nextRays.reflectionDirection = samplePhongDirectionPDF(V, R, vdotn, matParams.pathSmoothness, random_seed);
                        nextRays.reflectionColor = matParams.reflectivity;
                    }
                    if (kr < 1.0 && dot(refractionDirection, refractionDirection) > 0.0) {
                        nextRays.refractionDirection = samplePhongDirectionPDF(reflect(V, N), refractionDirection, vdotn, matParams.pathSmoothness, random_seed);
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