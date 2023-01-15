class WebGLCameraAdapter {
    constructor(camera) {
        this.camera = camera;
        if (camera instanceof PerspectiveCamera) {
            this.tanFov = camera.tan_fov;
            this.aspect = camera.aspect; // should aspect instead reflect canvas size/dimensions?
        }
        // TODO: depth of field camera
    }
    writeShaderData(gl, program) {
        gl.uniform1f(gl.getUniformLocation(program, "uTanFOV"), this.tanFov);
        gl.uniform1f(gl.getUniformLocation(program, "uAspect"), this.aspect);
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uInverseCameraTransform"), false, this.camera.inv_transform.to_webgl());
    }
    getShaderSource() {
        return `
            uniform mat4 uInverseCameraTransform;
            uniform float uAspect, uTanFOV;
            void computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec4 ro, inout vec4 rd) {
                ro = uInverseCameraTransform * vec4(0.0, 0.0, 0.0, 1.0);
                rd = uInverseCameraTransform * vec4(canvasPos.x * uTanFOV * uAspect, canvasPos.y * uTanFOV, -1.0, 0.0);
            }`;
    }
}