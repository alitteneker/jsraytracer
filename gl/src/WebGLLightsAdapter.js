class WebGLLightsAdapter {
    constructor() {
        this.lights_data = [];
    }
    visit(light) {
        const light_data = {};
        
        if (light instanceof SimplePointLight) {
            light_data.center = light.position;
            light_data.color = light.color;
            // TODO: deal with intensity
        }
        else {
            throw "Unsupported light type";
        }
        
        this.lights_data.push(light_data);
    }
    writeShaderData(gl, program) {
        const centers = [], colors = [];
        for (let light_data of this.lights_data) {
            this.centers.push(...light_data.center);
            this.colors.push(...light_data.color);
        }
        gl.uniform4fv(gl.getUniformLocation(program, "uPointLightCenters"), centers);
        gl.uniform4fv(gl.getUniformLocation(program, "uPointLightColors"), colors);
    }
    getShaderSource() {
        return `
            // ---- Point Lights ----
            #define MAX_POINT_LIGHTS 4
            uniform vec4 uPointLightCenters[MAX_POINT_LIGHTS];
            uniform vec4 uPointLightColors[MAX_POINT_LIGHTS];
            void sampPointLight(in vec4 center, in vec4 color, in vec4 position, out vec4 outLightDirection, out vec4 outLightColor) {
                vec4 delta = position - center;
                float norm_squared = dot(delta, delta);
                
                outLightDirection = delta;
                outLightColor = color / (4.0 * PI * norm_squared);
            }
            void sampleLight(in int lightID, in vec4 position, out vec4 outLightDirection, out vec4 outLightColor) {
                vec4 lightCenter = uPointLightCenters[lightID];
                vec4 lightColor = uPointLightColors[lightID];
                samplePointLight(lightCenter, lightColor, position, outLightDirection, outLightColor);
            }`;
    }
}