class WebGLCameraAdapter {
    constructor(camera, webgl_helper) {
        this.camera = camera;
        
        if (camera instanceof PerspectiveCamera) {
            this.FOV = camera.FOV;
            this.tan_fov = camera.tan_fov;
            this.aspect = camera.aspect; // should aspect instead reflect canvas size/dimensions?
            this.camera_transform = this.camera.transform;
            
            if (camera instanceof DepthOfFieldPerspectiveCamera) {
                this.focus_distance = camera.focus_distance;
                this.aperture_size = camera.sensor_size;
            }
            else {
                this.focus_distance = 1;
                this.aperture_size = 0;
            }
        }
        else 
            throw "Unsupported camera type";
        
        this.camera_position = this.camera_transform.column(3);
        this.camera_euler_rotation = Vec.from(Mat4.getEulerAngles(this.camera_transform));
    }
    destroy() {}
    writeShaderData(gl, program) {
        gl.uniform1f(gl.getUniformLocation(program, "uTanFOV"),        this.tan_fov);
        gl.uniform1f(gl.getUniformLocation(program, "uAspect"),        this.aspect);
        gl.uniform1f(gl.getUniformLocation(program, "uFocusDistance"), this.focus_distance);
        gl.uniform1f(gl.getUniformLocation(program, "uApertureSize"),  this.aperture_size);
        
        this.writeCameraTransform(gl, program, this.camera_transform);
    }
    moveCamera(rotateDelta, translateDelta, gl, program) {
        if (rotateDelta.every(x => (x == 0)) && translateDelta.every(x => (x == 0)))
            return false;
        
        this.camera_euler_rotation = this.camera_euler_rotation.plus([rotateDelta[1], rotateDelta[0]]);
        this.camera_position = this.camera_position.plus(this.camera_transform.times(translateDelta.to4(0)));
        
        if (this.camera_position.some(v => isNaN(v)))
            throw "NaN found in moved camera translation";
        
        this.camera_transform = this.camera.transform = Mat4.translation(this.camera_position)
            .times(Mat4.eulerRotation(this.camera_euler_rotation));
        
        this.writeCameraTransform(gl, program, this.camera_transform);
        return true;
    }
    changeLensSettings(focusDistance, apertureSize, FOV, gl, program) {
        if (this.FOV == FOV && this.focus_distance == focusDistance && this.aperture_size == apertureSize)
            return false;
        gl.uniform1f(gl.getUniformLocation(program, "uTanFOV"),        this.tan_fov = Math.tan((this.FOV = FOV) / 2));
        gl.uniform1f(gl.getUniformLocation(program, "uFocusDistance"), this.focus_distance = focusDistance);
        gl.uniform1f(gl.getUniformLocation(program, "uApertureSize"),  this.aperture_size  = apertureSize);
        return true;
    }
    writeCameraTransform(gl, program, transform) {
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uCameraTransform"), true, transform.flat());
    }
    getShaderSourceDeclarations() {
        return `
            Ray computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec2 random_seed);`;
    }
    getShaderSource() {
        return `
            uniform mat4 uCameraTransform;
            uniform float uAspect, uTanFOV, uApertureSize, uFocusDistance;
            Ray computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec2 random_seed) {
                vec4 ro = uCameraTransform * vec4(0.0, 0.0, 0.0, 1.0);
                vec4 rd = uCameraTransform * vec4(canvasPos.x * uTanFOV * uAspect, canvasPos.y * uTanFOV, -1.0, 0.0);
                if (uApertureSize > 0.0 && uFocusDistance >= 0.0) {
                    vec4 offset = uCameraTransform * vec4(uApertureSize * randomCirclePoint(random_seed), 0, 0);
                    ro += offset;
                    rd = normalize((uFocusDistance * rd) - offset);
                }
                return Ray(ro, rd);
            }`;
    }
}