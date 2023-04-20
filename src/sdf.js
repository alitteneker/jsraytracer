class SDFGeometry extends Geometry {
    static EPSILON = 0.00001;
    static MAX_SAMPLES = 1000;
    static NORMAL_STEP_SIZE = 0.001;
    constructor(root_sdf) {
        super();
        this.root_sdf = root_sdf;
        this.aabb = this.root_sdf.getBoundingBox(Mat4.identity(), Mat4.identity());
    }
    intersect(ray, minDistance, maxDistance) {
        const intersect_bounds = this.aabb.get_intersects(ray, minDistance, maxDistance);
        if (!intersect_bounds)
            return -Infinity;

        minDistance = Math.max(minDistance, intersect_bounds.min);
        maxDistance = Math.min(maxDistance, intersect_bounds.max);
        
        let t = minDistance;
        const rd_norm = ray.direction.norm();
        for (let i = 0; i < SDFGeometry.MAX_SAMPLES; ++i) {
            const p = ray.getPoint(t);
            const distance = this.root_sdf.distance(p);
            if (!isFinite(distance)) {
                if (isNaN(distance) && p.every(c => isFinite(c)))
                    throw "SDF distance computation has failed";
                break;
            }
            if (Math.abs(distance) <= SDFGeometry.EPSILON)
                return t;
            t += distance / rd_norm;
            if (t < minDistance || t > maxDistance)
                break;
        }
        return -Infinity;
    }
    materialData(base_data, direction) {
        const distance = this.root_sdf.distance(base_data.position);
        const N = Vec.of(0,0,0,0);
        for (let i = 0; i < 3; ++i)
            N[i] = (this.root_sdf.distance(base_data.position.plus(Vec.axis(i, 4, SDFGeometry.NORMAL_STEP_SIZE))) - distance) / SDFGeometry.NORMAL_STEP_SIZE;
        return Object.assign(base_data, {
            normal: N.normalized(),
            // TODO: UV?
        });
    }
    getBoundingBox(transform, inv_transform) {
        return this.root_sdf.getBoundingBox(transform, inv_transform);
    }
}

class SDF {
    distance(p) {
        throw "SDF subclass has not implemented distance";
    }
    getBoundingBox(transform, inv_transform) {
        throw "SDF subclass has not implemented getBoundingBox";
    }
}

class TransformSDF extends SDF {
    constructor(child_sdf, transform, inv_transform=Mat4.inverse(transform)) {
        super();
        this.child_sdf = child_sdf;
        this.transform = transform;
        this.inv_transform = inv_transform;
    }
    distance(p) {
        return this.child_sdf.distance(this.inv_transform.times(p));
    }
    getBoundingBox(transform, inv_transform) {
        return this.child_sdf.getBoundingBox(transform.times(this.transform), this.inv_transform.times(inv_transform));
    }
}

class UnionSDF extends SDF {
    constructor(...children) {
        super();
        this.children = children;
    }
    distance(p) {
        return Math.min(...this.children.map(c => c.distance(p)));
    }
    getBoundingBox(transform, inv_transform) {
        return AABB.hull(this.children.map(c => c.getBoundingBox(transform, inv_transform)));
    }
}

class IntersectionSDF extends SDF {
    constructor(...children) {
        super();
        this.children = children;
    }
    distance(p) {
        return Math.max(...this.children.map(c => c.distance(p)));
    }
    getBoundingBox(transform, inv_transform) {
        return AABB.intersection(this.children.map(c => c.getBoundingBox(transform, inv_transform)));
    }
}

class RoundSDF extends SDF {
    constructor(child_sdf, rounding) {
        super();
        this.child_sdf = child_sdf;
        this.rounding = rounding
    }
    distance(p) {
        return this.child_sdf.distance(p) - this.rounding;
    }
    getBoundingBox(transform, inv_transform) {
        return this.child_sdf.getBoundingBox(transform, inv_transform);
    }
}

class InfiniteRepetitionSDF extends SDF {
    constructor(child_sdf, sizes = Vec.of(1, 1, 1)) {
        super();
        this.child_sdf = child_sdf;
        this.sizes = sizes;
    }
    distance(p) {
        const q = Vec.from([0,1,2].map(i => (p[i] + this.sizes[i] / 2) % this.sizes[i] - this.sizes[i] / 2));
        return this.child_sdf.distance(q);
    }
    getBoundingBox(transform, inv_transform) {
        return new AABB(Vec.of(0,0,0,1), Vec.of(Infinity, Infinity, Infinity, 0));
    }
}

class SphereSDF extends SDF {
    constructor(radius = 1) {
        super();
        this.radius = radius;
    }
    distance(p) {
        return p.to4(0).norm() - this.radius;
    }
    getBoundingBox(transform, inv_transform) {
        return Sphere.computeBoundingBox(transform.times(Mat4.scale(this.radius), Mat4.scale(1/this.radius).times(inv_transform)));
    }
}

class PlaneSDF extends SDF {
    constructor(norm = Vec.of(0,0,1,0), delta=0) {
        this.normal = normal;
        this.delta = delta;
    }
    distance(p) {
        return this.normal.dot(p) + delta;
    }
    getBoundingBox(transform, inv_transform) {
        return new AABB(Vec.of(0,0,0,1), Vec.of(Infinity, Infinity, Infinity, 0));
    }
}

class BoxSDF extends SDF {
    constructor(size = 0.5) {
        super();
        this.size = size;
    }
    distance(p) {
        const q = p.abs().minus(this.size);
        return Vec.max(q, 0).norm() + Math.min(Math.max(q[0], q[1], q[2]), 0);
    }
    getBoundingBox(transform, inv_transform) {
        return new UnitBox().getBoundingBox(transform.times(Mat4.scale(this.size * 2)), Mat4.scale(0.5/this.size).times(inv_transform));
    }
}
