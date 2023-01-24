class WebGLMaterialsAdapter {
    constructor() {
        this.solid_colors = [];
        this.solid_color_map = {};
        this.checkerboard_colors = [];
        
        this.materials = [];
        this.material_id_map = {};
    }
    collapseMaterialColor(mc, scale=Vec.of(1,1,1)) {
        if (mc instanceof SolidMaterialColor) {
            const color = mc._color.times(scale);
            const key = color.to_string();
            if (!(key in this.solid_color_map)) {
                this.solid_color_map[key] = this.solid_colors.length;
                this.solid_colors.push(color);
            }
            return this.solid_color_map[key];
        }
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
        }
        else
            throw "Unsupported material type";
        this.material_id_map[material.MATERIAL_UID] = this.materials.length;
        this.materials.push(material_data);
        return this.material_id_map[material.MATERIAL_UID];
    }
    writeShaderData(gl, program) {
        gl.uniform3fv(gl.getUniformLocation(program, "umSolidColors"), this.solid_colors.map(x => [...x]).flat());
        if (this.checkerboard_colors.length)
            gl.uniform1iv(gl.getUniformLocation(program, "umCheckerboardColors"), this.checkerboard_colors.flat());
        
        gl.uniform1iv(gl.getUniformLocation(program, "umSimpleMaterialAmbientMCs"),      this.materials.map(m => m.ambient_id));
        gl.uniform1iv(gl.getUniformLocation(program, "umSimpleMaterialDiffuseMCs"),      this.materials.map(m => m.diffuse_id));
        gl.uniform1iv(gl.getUniformLocation(program, "umSimpleMaterialSpecularMCs"),     this.materials.map(m => m.specular_id));
        gl.uniform1iv(gl.getUniformLocation(program, "umSimpleMaterialReflectivityMCs"), this.materials.map(m => m.reflectivity_id));
        gl.uniform1fv(gl.getUniformLocation(program, "umSimpleMaterialSpecularFactors"), this.materials.map(m => m.specularFactor));
    }
    getShaderSourceDeclarations() {
        return `
                struct MaterialParameters {
                    vec3 ambient;
                    vec3 diffuse;
                    vec3 specular;
                    vec3 reflectivity;
                    float specularFactor;
                };
                vec3 colorForMaterial(in int materialID, in vec4 intersect_position, in Ray r, in GeometricMaterialData data,
                                        inout vec4 reflection_direction, inout vec3 reflection_color);`
    }
    getShaderSource() {
        return `
            uniform vec3 umSolidColors[${this.solid_colors.length}];
            uniform int umCheckerboardColors[${Math.max(1, 2*this.checkerboard_colors.length)}];
            
            #define MAX_MATERIALS ${Math.max(this.materials.length, 1)}
            uniform int   umSimpleMaterialAmbientMCs     [MAX_MATERIALS];
            uniform int   umSimpleMaterialDiffuseMCs     [MAX_MATERIALS];
            uniform int   umSimpleMaterialSpecularMCs    [MAX_MATERIALS];
            uniform int   umSimpleMaterialReflectivityMCs[MAX_MATERIALS];
            uniform float umSimpleMaterialSpecularFactors[MAX_MATERIALS];

            vec3 getMaterialColor(in int color_index, in vec2 UV) {
                // checkerboard
                if (color_index < 0) {
                    int checkerboard_cell = (mod(floor(UV.x) + floor(UV.y), 2.0) < 1.0) ? 0 : 1;
                    return umSolidColors[umCheckerboardColors[-2 * (color_index + 1) + checkerboard_cell]];
                }
                return umSolidColors[color_index];
            }
            void getMaterialParameters(in int materialID, in GeometricMaterialData geodata, out MaterialParameters matParams) {
                matParams.ambient        = getMaterialColor(umSimpleMaterialAmbientMCs     [materialID], geodata.UV);
                matParams.diffuse        = getMaterialColor(umSimpleMaterialDiffuseMCs     [materialID], geodata.UV);
                matParams.specular       = getMaterialColor(umSimpleMaterialSpecularMCs    [materialID], geodata.UV);
                matParams.reflectivity   = getMaterialColor(umSimpleMaterialReflectivityMCs[materialID], geodata.UV);
                matParams.specularFactor = umSimpleMaterialSpecularFactors[materialID];
            }
            vec3 computeMaterialColor(in MaterialParameters matParams, in vec4 rp, in vec4 rd, in vec4 normal, inout vec4 reflection_direction, inout vec3 reflection_color) {
                vec4 V = normalize(-rd);
                vec4 N = normalize(normal);
                float vdotn = dot(V, N);
                if (vdotn < 0.0) {
                    N = -N;
                    vdotn = -vdotn;
                }
                vec4 R = normalize((2.0 * vdotn * N) - V);

                vec3 totalColor = matParams.ambient;
                for (int i = 0; i < uNumLights; ++i) {
                    vec4 lightDirection;
                    vec3 lightColor;
                    sampleLight(i, rp, lightDirection, lightColor);
                    
                    float shadowIntersection = sceneRayCast(Ray(rp, lightDirection), 0.0001, true);
                    if (shadowIntersection > 0.0 && shadowIntersection < 1.0)
                        continue;
                    
                    vec4 L = normalize(lightDirection);
                    
                    // diffuse component
                    totalColor +=     max(dot(L, N), 0.0)                            * matParams.diffuse  * lightColor;
                    
                    // specular component
                    totalColor += pow(max(dot(L, R), 0.0), matParams.specularFactor) * matParams.specular * lightColor;
                }
                
                // reflection
                if (dot(matParams.reflectivity, matParams.reflectivity) > 0.0) {
                    reflection_direction = R;
                    reflection_color = matParams.reflectivity;
                }
                return totalColor;
            }

            // ---- Generic ----
            vec3 colorForMaterial(in int materialID, in vec4 rp, in Ray r, in GeometricMaterialData geodata, inout vec4 reflection_direction, inout vec3 reflection_color) {
                MaterialParameters matParams;
                getMaterialParameters(materialID, geodata, matParams);
                return computeMaterialColor(matParams, rp, r.d, geodata.normal, reflection_direction, reflection_color);
            }`;
    }
}