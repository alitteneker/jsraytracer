class WebGLLightsAdapter {
    constructor() {
        this.lights_data = [];
    }
    visit(light) {
        const light_data = {};
        
        if (light instanceof SimplePointLight) {
            light_data.center = light.position;
            light_data.color = light.color.times(light.intensity);
        }
        else {
            throw "Unsupported light type";
        }
        
        this.lights_data.push(light_data);
    }
    writeShaderData(gl, program) {
        const centers = [], colors = [];
        for (let light_data of this.lights_data) {
            centers.push(...light_data.center);
            colors.push(...light_data.color);
        }
        gl.uniform4fv(gl.getUniformLocation(program, "uPointLightCenters"), centers);
        gl.uniform3fv(gl.getUniformLocation(program, "uPointLightColors"), colors);
    }
    getShaderSourceForwardDefinitions() {
        return `void sampleLight(in int lightID, in vec4 position, out vec4 lightDirection, out vec3 lightColor);`;
    }
    getShaderSource() {
        return `
            // ---- Point Lights ----
            #define MAX_POINT_LIGHTS 4
            uniform vec4 uPointLightCenters[MAX_POINT_LIGHTS];
            uniform vec3 uPointLightColors[MAX_POINT_LIGHTS];
            void samplePointLight(in vec4 lightCenter, in vec3 lightColor, in vec4 position, out vec4 outLightDirection, out vec3 outLightColor) {
                vec4 delta = lightCenter - position;
                float norm_squared = dot(delta, delta);
                
                outLightDirection = delta;
                outLightColor = lightColor / (4.0 * PI * norm_squared);
            }
            void sampleLight(in int lightID, in vec4 position, out vec4 outLightDirection, out vec3 outLightColor) {
                vec4 lightCenter = uPointLightCenters[lightID];
                vec3 lightColor = uPointLightColors[lightID];
                samplePointLight(lightCenter, lightColor, position, outLightDirection, outLightColor);
            }`;
    }
}