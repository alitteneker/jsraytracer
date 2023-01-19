class WebGLMaterialsAdapter {
    constructor() {
        this.materials = [];
        this.material_id_map = {};
    }
    visit(material) {
        if (material.MATERIAL_UID in this.material_id_map)
            return this.material_id_map[material.MATERIAL_UID];
        
        const material_data = {};
        if (material instanceof PhongMaterial) {
            material_data.ambient = material.ambient.toSolidColor()._color;
            material_data.diffuse = material.diffusivity.toSolidColor()._color;
            material_data.specular = material.specularity.toSolidColor()._color;
            material_data.reflectivity = material.reflectivity.toSolidColor()._color;
            material_data.specularFactor = material.smoothness;
        }
        else
            throw "Unsupported material type";
        this.material_id_map[material.MATERIAL_UID] = this.materials.length;
        this.materials.push(material_data);
        return this.material_id_map[material.MATERIAL_UID];
    }
    writeShaderData(gl, program) {
        const ambients = [], diffuses = [], speculars = [], reflectivities = [], specularFactors = [];
        for (let material of this.materials) {
            ambients.push(...material.ambient);
            diffuses.push(...material.diffuse);
            speculars.push(...material.specular);
            reflectivities.push(...material.reflectivity);
            specularFactors.push(material.specularFactor);
        }
        gl.uniform3fv(gl.getUniformLocation(program, "umSimpleMaterialAmbients"), ambients);
        gl.uniform3fv(gl.getUniformLocation(program, "umSimpleMaterialDiffuses"), diffuses);
        gl.uniform3fv(gl.getUniformLocation(program, "umSimpleMaterialSpeculars"), speculars);
        gl.uniform3fv(gl.getUniformLocation(program, "umSimpleMaterialReflectivities"), reflectivities);
        gl.uniform1fv(gl.getUniformLocation(program, "umSimpleMaterialSpecularFactors"), specularFactors);
    }
    getShaderSourceForwardDefinitions() {
        return `vec3 colorForMaterial(in int materialID, in vec4 intersect_position, in vec4 ray_origin, in vec4 ray_direction,
                                      in vec4 normal, in vec2 UV, inout vec4 reflection_direction, inout vec3 reflection_color);`
    }
    getShaderSource() {
        return `
            #define MAX_MATERIALS 4
            uniform vec3  umSimpleMaterialAmbients       [MAX_MATERIALS];
            uniform vec3  umSimpleMaterialDiffuses       [MAX_MATERIALS];
            uniform vec3  umSimpleMaterialSpeculars      [MAX_MATERIALS];
            uniform float umSimpleMaterialSpecularFactors[MAX_MATERIALS];
            uniform vec3  umSimpleMaterialReflectivities [MAX_MATERIALS];

            void getMaterialFactors(in int materialID, in vec2 UV, out vec3 ambient, out vec3 diffuse, out vec3 specular, out float specularFactor, out vec3 reflectivity) {
                ambient        = umSimpleMaterialAmbients       [materialID];
                diffuse        = umSimpleMaterialDiffuses       [materialID];
                specular       = umSimpleMaterialSpeculars      [materialID];
                specularFactor = umSimpleMaterialSpecularFactors[materialID];
                reflectivity   = umSimpleMaterialReflectivities [materialID];
            }
            vec3 computeMaterialColor(in vec3 ambientColor, in vec3 diffuseColor, in vec3 specularColor, in float specularFactor, in vec3 reflectivityColor, in vec4 rp, in vec4 rd, in vec4 normal, inout vec4 reflection_direction, inout vec3 reflection_color) {
                vec4 V = normalize(-rd);
                vec4 N = normalize(normal);
                float vdotn = dot(V, N);
                if (vdotn < 0.0) {
                    N = -N;
                    vdotn = -vdotn;
                }
                vec4 R = normalize((2.0 * vdotn * N) - V);

                vec3 totalColor = ambientColor;
                for (int i = 0; i < uNumLights; ++i) {
                    vec4 lightDirection;
                    vec3 lightColor;
                    sampleLight(i, rp, lightDirection, lightColor);
                    
                    float shadowIntersection = sceneRayCast(rp, lightDirection, 0.0001, true);
                    if (shadowIntersection > 0.0 && shadowIntersection < 1.0)
                        continue;
                    
                    vec4 L = normalize(lightDirection);
                    
                    // diffuse component
                    totalColor +=     max(dot(L, N), 0.0)                  * diffuseColor  * lightColor;
                    
                    // specular component
                    totalColor += pow(max(dot(L, R), 0.0), specularFactor) * specularColor * lightColor;
                }
                
                // reflection
                if (dot(reflectivityColor, reflectivityColor) > 0.0) {
                    reflection_direction = R;
                    reflection_color = reflectivityColor;
                }
                return totalColor;
            }

            // ---- Generic ----
            vec3 colorForMaterial(in int materialID, in vec4 rp, in vec4 ro, in vec4 rd, in vec4 normal, in vec2 UV, inout vec4 reflection_direction, inout vec3 reflection_color) {
                vec3 ambient, diffuse, specular, reflectivity;
                float specularFactor;
                getMaterialFactors(materialID, UV, ambient, diffuse, specular, specularFactor, reflectivity);
                return computeMaterialColor(ambient, diffuse, specular, specularFactor, reflectivity, rp, rd, normal, reflection_direction, reflection_color);
            }`;
    }
}