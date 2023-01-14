class WebGLLightsAdapter {
    constructor() {
        
    }
    writeShaderData(gl) {
    }
    getShaderSource() {
        return `
            // ---- Point Lights ----
            void samplePointLight(in vec4 rp, in vec4 rd) {
                // TODO
            }`;
    }
}