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
                this.aperture_size = camera.sensor_size;
            }
            else {
                this.focus_distance = 1;
                this.aperture_size = 0;
            }
        }
        else 
            throw "Unsupported camera type";
    }
    writeShaderData(gl, program) {
        gl.uniform1f(gl.getUniformLocation(program, "uTanFOV"), this.tanFov);
        gl.uniform1f(gl.getUniformLocation(program, "uAspect"), this.aspect);
        gl.uniform1f(gl.getUniformLocation(program, "uFocusDistance"), this.focus_distance);
        gl.uniform1f(gl.getUniformLocation(program, "uApertureSize"), this.aperture_size);
        
        this.writeCameraTransform(gl, program, this.camera_transform);
    }
    moveCamera(rotateDelta, translateDelta, gl, program) {
        if (rotateDelta.every(x => (x == 0)) && translateDelta.every(x => (x == 0)))
            return false;
        
        this.rotateDelta = this.rotateDelta.plus(rotateDelta);
        this.translateDelta = this.translateDelta.plus(this.camera_transform.times(translateDelta.to4(0)));
        this.camera_transform = Mat4.translation(this.translateDelta)
            .times(this.base_camera_transform)
            .times(Mat4.rotation(this.rotateDelta[0], Vec.of(0,1,0))).times(Mat4.rotation(this.rotateDelta[1], Vec.of(1,0,0)));
            
        if (this.translateDelta.some(v => isNaN(v)))
            throw "NaN found in moved camera translation";
        
        this.writeCameraTransform(gl, program, this.camera_transform);
        return true;
    }
    changeLensSettings(focusDistance, apertureSize, gl, program) {
        if (this.focus_distance == focusDistance && this.aperture_size == apertureSize)
            return false;
        gl.uniform1f(gl.getUniformLocation(program, "uFocusDistance"), this.focus_distance = focusDistance);
        gl.uniform1f(gl.getUniformLocation(program, "uApertureSize"), this.aperture_size = apertureSize);
        return true;
    }
    writeCameraTransform(gl, program, transform) {
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uCameraTransform"), true, transform.to_webgl());
    }
    getShaderSourceDeclarations() {
        return `
            void computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout Ray r, inout vec2 random_seed);`;
    }
    getShaderSource() {
        return `
            uniform mat4 uCameraTransform;
            uniform float uAspect, uTanFOV, uApertureSize, uFocusDistance;
            void computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout Ray r, inout vec2 random_seed) {
                r.o = uCameraTransform * vec4(0.0, 0.0, 0.0, 1.0);
                r.d = uCameraTransform * vec4(canvasPos.x * uTanFOV * uAspect, canvasPos.y * uTanFOV, -1.0, 0.0);
                if (uApertureSize > 0.0 && uFocusDistance >= 0.0) {
                    vec4 offset = uCameraTransform * vec4(uApertureSize * randomCirclePoint(random_seed), 0, 0);
                    r.o += offset;
                    r.d = normalize((uFocusDistance * r.d) - offset);
                }
            }`;
    }
}