class WebGLMaterialsAdapter {
    constructor() {
        this.
    }
    visit(material) {
        
    }
    writeShaderData(gl) {
    }
    getShaderSource() {
        return `
            #define MATERIAL_SIMPLE_TYPE 1

            #define MAX_SIMPLE_MATERIALS 4
            uniform vec4 umSimpleMaterialAmbients[MAX_SIMPLE_MATERIALS];
            uniform vec4 umSimpleMaterialDiffuses[MAX_SIMPLE_MATERIALS];
            uniform vec4 umSimpleMaterialSpeculars[MAX_SIMPLE_MATERIALS];
            uniform float umSimpleMaterialSpecularFactors[MAX_SIMPLE_MATERIALS];
            uniform vec4 umSimpleMaterialReflectivities[MAX_SIMPLE_MATERIALS];

            void getSimpleMaterialFactors(in int simpleMaterialID, out vec4 ambient, out vec4 diffuse, out vec4 specular, out float specular_factor, out vec4 reflectivity) {
                ambient = umSimpleMaterialAmbients[simpleMaterialID];
                diffuse = umSimpleMaterialDiffuses[simpleMaterialID];
                specular = umSimpleMaterialSpeculars[simpleMaterialID];
                specular_factor = umSimpleMaterialSpecularFactors[simpleMaterialID];
                reflectivity = umSimpleMaterialReflectivities[simpleMaterialID];
            }
            vec4 simpleMaterialColor(in vec4 ambientColor, in vec4 diffuseColor, in vec4 specularColor, in float specular_factor, in vec4 reflectivityColor, in vec4 rp, in vec4 rd, in vec4 normal, in vec2 UV, inout vec4 reflection_direction, inout vec4 reflection_color) {
                vec4 V = normalize(-rd);
                vec4 N = normalize(normal);
                if (dot(V, N) < 0.0)
                    N = -N;
                vec4 R = normalize((2.0 * dot(normal, V) * normal) - V);

                vec4 totalColor = ambientColor;
                // for (int i = 0; i < uNumLights; ++i) {
                //     vec4 lightDirection, lightColor;
                //     sampleLight(i, rp, lightDirection, lightColor);
                //     
                //     float lightIntersection = sceneRayCast(rp, lightDirection, 0.0001, true);
                //     if (lightIntersection <= 0.0 || lightIntersection >= 1.0)
                //         continue;
                //     
                //     lightDirection = normalize(lightDirection);
                //     
                //     // diffuse component
                //     totalColor += max(dot(lightDirection, N), 0.0) * diffuseColor * lightColor;
                //     
                //     // specular component
                //     totalColor += pow(max(dot(lightDirection, R), 0.0), specular_factor) * specularColor * lightColor;
                // }
                // if (dot(reflectivityColor, reflectivityColor) > 0.0) {
                //     reflection_direction = R;
                //     reflection_color = reflectivityColor;
                // }
                return totalColor;
            }
            vec4 simpleMaterialColor(in int simpleMaterialID, in vec4 rp, in vec4 rd, in vec4 normal, in vec2 UV, inout vec4 reflection_direction, inout vec4 reflection_color) {
                vec4 ambient, diffuse, specular, reflectivity;
                float specular_factor;
                getSimpleMaterialFactors(simpleMaterialID, ambient, diffuse, specular, specular_factor, reflectivity);
                return simpleMaterialColor(ambient, diffuse, specular, specular_factor, reflectivity, rp, rd, normal, UV, reflection_direction, reflection_color);
            }

            // ---- Generic ----
            vec4 colorForMaterial(in int materialID, in vec4 rp, in vec4 rd, in vec4 normal, in vec2 UV, inout vec4 reflection_direction, inout vec4 reflection_color) {
                if (materialID == MATERIAL_SIMPLE_TYPE)
                    return simpleMaterialColor(materialID - MATERIAL_SIMPLE_TYPE, rp, rd, normal, UV, reflection_direction, reflection_color);
                return vec4(1.0, 1.0, 1.0, 1.0);
            }`;
    }
}