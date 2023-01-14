class WebGLRendererAdapter {
    constructor(renderer) {
        this.adapters = {
            camera: new WebGLCameraAdapter(renderer.camera),
            scene:  new WebGLSceneAdapter(renderer.scene)
        };
        // TODO: renderer size or canvas properties...
        // TODO: depth of field camera
        // Log samples per pixel?
    }
    writeShaderData(gl) {
        this.adapters.camera.writeShaderData(gl);
        this.adapters.scene.writeShaderData(gl);
    }
    getShaderSource() {
        return `
            uniform vec2 uCanvasSize;
            uniform float uTime;
            out vec4 outTexelColor;

            void main() {
                // TODO: seed noise

                vec2 canvasCoord = 2.0 * (gl_FragCoord.xy / uCanvasSize) - vec2(1.0);
                vec2 pixelSize = 2.0 / uCanvasSize;
                
                vec4 ro, rd;
                computeCameraRayForTexel(canvasCoord, pixelSize, ro, rd);
                outTexelColor = sceneRayColor(ro, rd);
            }`
            + this.adapters.scene.getShaderSource()
            + this.adapters.camera.getShaderSource();
    }
}