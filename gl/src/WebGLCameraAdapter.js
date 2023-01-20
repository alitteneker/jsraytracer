class WebGLCameraAdapter {
    constructor(camera) {
        this.camera = camera;
        
        this.rotateDelta = Vec.of(0,0);
        this.translateDelta = Vec.of(0,0,0);
        
        if (camera instanceof PerspectiveCamera) {
            this.tanFov = camera.tan_fov;
            this.aspect = camera.aspect; // should aspect instead reflect canvas size/dimensions?
            this.camera_transform = this.base_camera_transform = this.camera.transform;
        }
        // TODO: depth of field camera
        else 
            throw "Unsupported camera type";
    }
    writeShaderData(gl, program) {
        gl.uniform1f(gl.getUniformLocation(program, "uTanFOV"), this.tanFov);
        gl.uniform1f(gl.getUniformLocation(program, "uAspect"), this.aspect);
        this.writeCameraTransform(gl, program, this.camera_transform);
    }
    moveCamera(rotateDelta, translateDelta, gl, program) {
        if (rotateDelta.every(x => (x == 0)) && translateDelta.every(x => (x == 0)))
            return false;
        
        this.rotateDelta = this.rotateDelta.plus(rotateDelta);
        this.translateDelta = this.translateDelta.plus(this.camera_transform.times(translateDelta.to4(0)));
        this.camera_transform = Mat4.translation(this.translateDelta)
            .times(Mat4.rotation(this.rotateDelta[0], Vec.of(0,1,0))).times(Mat4.rotation(this.rotateDelta[1], Vec.of(1,0,0)))
            .times(this.base_camera_transform);
        
        this.writeCameraTransform(gl, program, this.camera_transform);
        return true;
    }
    writeCameraTransform(gl, program, transform) {
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uCameraTransform"), false, transform.to_webgl());
    }
    getShaderSourceForwardDefinitions() {
        return `void computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec4 ray_origin, inout vec4 ray_direction);`;
    }
    getShaderSource() {
        return `
            uniform mat4 uCameraTransform;
            uniform float uAspect, uTanFOV;
            void computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec4 ro, inout vec4 rd) {
                ro = uCameraTransform * vec4(0.0, 0.0, 0.0, 1.0);
                rd = uCameraTransform * vec4(canvasPos.x * uTanFOV * uAspect, canvasPos.y * uTanFOV, -1.0, 0.0);
            }`;
    }
}