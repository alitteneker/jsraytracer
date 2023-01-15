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
            specularFactors.push(...material.specularFactor);
        }
        gl.uniform4fv(gl.getUniformLocation(program, "umSimpleMaterialAmbients"), ambients);
        gl.uniform4fv(gl.getUniformLocation(program, "umSimpleMaterialDiffuses"), diffuses);
        gl.uniform4fv(gl.getUniformLocation(program, "umSimpleMaterialSpeculars"), speculars);
        gl.uniform4fv(gl.getUniformLocation(program, "umSimpleMaterialReflectivities"), reflectivities);
        gl.uniform1fv(gl.getUniformLocation(program, "umSimpleMaterialSpecularFactors"), specularFactors);
    }
    getShaderSource() {
        return `
            #define MAX_MATERIALS 4
            uniform vec4  umSimpleMaterialAmbients       [MAX_MATERIALS];
            uniform vec4  umSimpleMaterialDiffuses       [MAX_MATERIALS];
            uniform vec4  umSimpleMaterialSpeculars      [MAX_MATERIALS];
            uniform float umSimpleMaterialSpecularFactors[MAX_MATERIALS];
            uniform vec4  umSimpleMaterialReflectivities [MAX_MATERIALS];

            void getMaterialFactors(in int materialID, in vec2 UV, out vec4 ambient, out vec4 diffuse, out vec4 specular, out float specular_factor, out vec4 reflectivity) {
                ambient         = umSimpleMaterialAmbients       [materialID];
                diffuse         = umSimpleMaterialDiffuses       [materialID];
                specular        = umSimpleMaterialSpeculars      [materialID];
                specular_factor = umSimpleMaterialSpecularFactors[materialID];
                reflectivity    = umSimpleMaterialReflectivities [materialID];
            }
            vec4 computeMaterialColor(in vec4 ambientColor, in vec4 diffuseColor, in vec4 specularColor, in float specular_factor, in vec4 reflectivityColor, in vec4 rp, in vec4 rd, in vec4 normal, in vec2 UV, inout vec4 reflection_direction, inout vec4 reflection_color) {
                vec4 V = normalize(-rd);
                vec4 N = normalize(normal);
                if (dot(V, N) < 0.0)
                    N = -N;
                vec4 R = normalize((2.0 * dot(normal, V) * normal) - V);

                vec4 totalColor = ambientColor;
                for (int i = 0; i < uNumLights; ++i) {
                    vec4 lightDirection, lightColor;
                    sampleLight(i, rp, lightDirection, lightColor);
                    
                    float lightIntersection = sceneRayCast(rp, lightDirection, 0.0001, true);
                    if (lightIntersection <= 0.0 || lightIntersection >= 1.0)
                        continue;
                    
                    lightDirection = normalize(lightDirection);
                    
                    // diffuse component
                    totalColor += max(dot(lightDirection, N), 0.0) * diffuseColor * lightColor;
                    
                    // specular component
                    totalColor += pow(max(dot(lightDirection, R), 0.0), specular_factor) * specularColor * lightColor;
                }
                
                // reflection
                if (dot(reflectivityColor, reflectivityColor) > 0.0) {
                    reflection_direction = R;
                    reflection_color = reflectivityColor;
                }
                return totalColor;
            }

            // ---- Generic ----
            vec4 colorForMaterial(in int materialID, in vec4 rp, in vec4 ro, in vec4 rd, in vec4 normal, in vec2 UV, inout vec4 reflection_direction, inout vec4 reflection_color) {
                vec4 ambient, diffuse, specular, reflectivity;
                float specular_factor;
                getMaterialFactors(materialID, UV, ambient, diffuse, specular, specular_factor, reflectivity);
                return computeMaterialColor(ambient, diffuse, specular, specular_factor, reflectivity, rp, rd, normal, UV, reflection_direction, reflection_color);
            }`;
    }
}