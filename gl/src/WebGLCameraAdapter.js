class WebGLCameraAdapter {
    constructor(camera) {
        this.camera = camera;
        
        this.rotateDelta = Vec.of(0,0);
        this.translateDelta = Vec.of(0,0,0);
        
        if (camera instanceof PerspectiveCamera) {
            this.tanFov = camera.tan_fov;
            this.aspect = camera.aspect; // should aspect instead reflect canvas size/dimensions?
            this.camera_transform = this.base_camera_transform = this.camera.transform;
            
            if (camera instanceof DepthOfFieldPerspectiveCamera) {
                this.focus_distance = camera.focus_distance;
                this.sensor_size = camera.sensor_size;
            }
            else {
                this.focus_distance = 1;//8
                this.sensor_size = 0;//0.1
            }
        }
        else 
            throw "Unsupported camera type";
    }
    writeShaderData(gl, program) {
        gl.uniform1f(gl.getUniformLocation(program, "uTanFOV"), this.tanFov);
        gl.uniform1f(gl.getUniformLocation(program, "uAspect"), this.aspect);
        gl.uniform1f(gl.getUniformLocation(program, "uFocusDistance"), this.focus_distance);
        gl.uniform1f(gl.getUniformLocation(program, "uSensorSize"), this.sensor_size);
        
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
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uCameraTransform"), true, transform.to_webgl());
    }
    getShaderSourceForwardDefinitions() {
        return `void computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec4 ray_origin, inout vec4 ray_direction, inout vec2 random_seed);`;
    }
    getShaderSource() {
        return `
            uniform mat4 uCameraTransform;
            uniform float uAspect, uTanFOV, uSensorSize, uFocusDistance;
            void computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec4 ro, inout vec4 rd, inout vec2 random_seed) {
                ro = uCameraTransform * vec4(0.0, 0.0, 0.0, 1.0);
                rd = uCameraTransform * vec4(canvasPos.x * uTanFOV * uAspect, canvasPos.y * uTanFOV, -1.0, 0.0);
                if (uSensorSize > 0.0 && uFocusDistance >= 0.0) {
                    vec4 offset = uCameraTransform * vec4(uSensorSize * randomCirclePoint(random_seed), 0, 0);
                    ro += offset;
                    rd = normalize((uFocusDistance * rd) - offset);
                }
            }`;
    }
}