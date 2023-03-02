class WebGLCameraAdapter {
    constructor(camera, webgl_helper) {
        this.camera = camera;
        
        if (camera instanceof PerspectiveCamera) {
            this.FOV = camera.FOV;
            this.tan_fov = camera.tan_fov;
            
            if (camera instanceof DepthOfFieldPerspectiveCamera) {
                this.focus_distance = camera.focus_distance;
                this.sensor_size = camera.sensor_size;
            }
            else {
                this.focus_distance = 1;
                this.sensor_size = 0;
            }
        }
        else 
            throw "Unsupported camera type";
        
        this.camera_position = this.camera.transform.column(3);
        this.camera_euler_rotation = Vec.from(Mat4.getEulerAngles(this.camera.transform));
    }
    destroy() {}
    writeShaderData(gl, program) {
        gl.uniform1f(gl.getUniformLocation(program, "uTanFOV"),        this.tan_fov);
        gl.uniform1f(gl.getUniformLocation(program, "uFocusDistance"), this.focus_distance);
        gl.uniform1f(gl.getUniformLocation(program, "uSensorSize"),    this.sensor_size);
        
        this.writeCameraTransform(gl, program, this.camera.transform);
    }
    moveCamera(rotateDelta, translateDelta, gl, program) {
        if (rotateDelta.every(x => (x == 0)) && translateDelta.every(x => (x == 0)))
            return false;
        
        this.camera_euler_rotation = this.camera_euler_rotation.plus([rotateDelta[1], rotateDelta[0]]);
        this.camera_position = this.camera_position.plus(this.camera.transform.times(translateDelta.to4(0)));
        
        if (this.camera_position.some(v => isNaN(v)))
            throw "NaN found in moved camera translation";
        
        const rotation = Mat4.eulerRotation(this.camera_euler_rotation)
        this.camera.setTransform(Mat4.translation(this.camera_position).times(rotation),
                                 rotation.transposed().times(Mat4.translation(this.camera_position.times(-1))));
        
        this.writeCameraTransform(gl, program, this.camera.transform);
        return true;
    }
    changeLensSettings(focusDistance, sensorSize, FOV, gl, program) {
        if (this.FOV == FOV && this.focus_distance == focusDistance && this.sensor_size == sensorSize)
            return false;
        gl.uniform1f(gl.getUniformLocation(program, "uTanFOV"),        this.tan_fov = this.camera.tan_fov = Math.tan((this.FOV = this.camera.FOV = FOV) / 2));
        gl.uniform1f(gl.getUniformLocation(program, "uFocusDistance"), this.focus_distance = this.camera.focus_distance = focusDistance);
        gl.uniform1f(gl.getUniformLocation(program, "uSensorSize"),    this.sensor_size = this.camera.sensor_size = sensorSize);
        return true;
    }
    getPosition() {
        return this.camera.transform.column(3);
    }
    getViewMatrix() {
        return this.camera.getViewMatrix();
    }
    getTransform() {
        return this.camera.transform;
    }
    getInverseTransform() {
        return this.camera.inv_transform;
    }
    getFOV() {
        return this.FOV;
    }
    getFocusDistance() {
        return this.focus_distance;
    }
    getSensorSize() {
        return this.sensor_size;
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
            uniform float uAspect, uTanFOV, uSensorSize, uFocusDistance;
            Ray computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec2 random_seed) {
                vec4 ro = uCameraTransform * vec4(0.0, 0.0, 0.0, 1.0);
                vec4 rd = uCameraTransform * vec4(canvasPos.x * uTanFOV * (pixelSize.y / pixelSize.x), canvasPos.y * uTanFOV, -1.0, 0.0);
                if (uSensorSize > 0.0 && uFocusDistance >= 0.0) {
                    vec4 offset = uCameraTransform * vec4(uSensorSize * randomCirclePoint(random_seed), 0, 0);
                    ro += offset;
                    rd = normalize((uFocusDistance * rd) - offset);
                }
                return Ray(ro, rd);
            }`;
    }
}