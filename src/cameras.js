class Camera {
    constructor(transform) {
        this.transform = transform;
        this.inv_transform = Mat4.inverse(transform);
    }
    getRayForPixel(x, y) {
        throw "getRayForPixel is unimplemented in Camera subclass";
    }
}

class PerspectiveCamera extends Camera {
    constructor(fov, aspect, transform) {
        super(transform);
        this.position = this.transform.column(3);
        this.tan_fov = Math.tan(fov / 2);
        this.aspect = aspect;
    }
    getRayForPixel(x, y) {
        let direction = Vec.of(
            x * this.tan_fov * this.aspect,
            y * this.tan_fov, -1, 0);
        return new Ray(this.position, this.transform.times(direction));
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