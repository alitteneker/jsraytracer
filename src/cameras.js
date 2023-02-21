class Camera {
    constructor(transform, inv_transform=Mat4.inverse(transform)) {
        this.transform = transform;
        this.inv_transform = inv_transform;
    }
    setTransform(transform, inv_transform=Mat4.inverse(transform)) {
        this.transform = transform;
        this.inv_transform = inv_transform;
    }
    getRayForPixel(x, y) {
        throw "getRayForPixel is unimplemented in Camera subclass";
    }
    getViewMatrix() {
        throw "getViewMatrix is unimplemented in Camera subclass";
    }
}

class PerspectiveCamera extends Camera {
    constructor(fov, aspect, transform) {
        super(transform);
        this.FOV = fov;
        this.tan_fov = Math.tan(fov / 2);
        this.aspect = aspect;
    }
    changeFOV(fov) {
        this.FOV = fov;
        this.tan_fov = Math.tan(fov / 2);
    }
    getRayForPixel(x, y) {
        let direction = Vec.of(
            x * this.tan_fov * this.aspect,
            y * this.tan_fov, -1, 0);
        return new Ray(this.transform.column(3), this.transform.times(direction));
    }
    getViewMatrix(near=1, far=1000) {
        return Mat4.perspective(this.FOV, this.aspect, near, far).times(this.inv_transform);
    }
}

class DepthOfFieldPerspectiveCamera extends PerspectiveCamera {
    constructor(fov, aspect, transform, focus_distance, sensor_size) {
        super(fov, aspect, transform);
        this.focus_distance = focus_distance;
        this.sensor_size = sensor_size;
    }
    getRayForPixel(x, y) {
        const ray = super.getRayForPixel(x, y),
            offset = this.transform.times(Vec.circlePick().times(this.sensor_size).to4(false));
        ray.origin = ray.origin.plus(offset);
        ray.direction = ray.direction.times(this.focus_distance).minus(offset).normalized();
        return ray;
    }
}