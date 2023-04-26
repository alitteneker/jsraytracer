class SDFGeometry extends Geometry {
    constructor(root_sdf, max_samples=1000, distance_epsilon=0.0001, max_trace_distance=1000, normal_step_size=0.001) {
        super();
        this.root_sdf = root_sdf;
        this.aabb = this.root_sdf.getBoundingBox(Mat4.identity(), Mat4.identity());
        this.max_samples = max_samples;
        this.distance_epsilon = distance_epsilon;
        this.max_trace_distance = max_trace_distance;
        this.normal_step_size = normal_step_size;
    }
    intersect(ray, minDistance, maxDistance) {
        const intersect_bounds = this.aabb.get_intersects(ray, minDistance, maxDistance);
        if (!intersect_bounds)
            return -Infinity;

        minDistance = Math.max(minDistance, intersect_bounds.min);
        maxDistance = Math.min(maxDistance, intersect_bounds.max);
        
        let t = minDistance;
        const rd_norm = ray.direction.norm();
        for (let i = 0; i < this.max_samples; ++i) {
            const p = ray.getPoint(t);
            const distance = this.root_sdf.distance(p);
            
            if (!isFinite(distance)) {
                if (isNaN(distance) && p.every(c => isFinite(c)))
                    throw "SDF distance computation has failed";
                break;
            }
            
            if (Math.abs(distance) <= this.distance_epsilon)
                return t;
            
            t += distance / rd_norm;
            if (t < minDistance || t > maxDistance || (t - minDistance) * rd_norm > this.max_trace_distance)
                break;
        }
        return -Infinity;
    }
    materialData(base_data, direction) {
        const distance = this.root_sdf.distance(base_data.position);
        const N = Vec.of(0,0,0,0);
        for (let i = 0; i < 3; ++i) {
            N[i] = (this.root_sdf.distance(base_data.position.plus(Vec.axis(i, 4, this.normal_step_size))) - distance) / this.normal_step_size;
        }
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


// Combinational SDFs
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

class DifferenceSDF extends SDF {
    constructor(positive, negative) {
        super();
        this.positive = positive;
        this.negative = negative;
    }
    distance(p) {
        return Math.max(this.positive.distance(p), -this.negative.distance(p));
    }
    getBoundingBox(transform, inv_transform) {
        return this.positive.getBoundingBox(transform, inv_transform);
        // TODO: is it ever worthwhile to consider the negative bounding box?
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



// Useful classes for applying transformations one or more times
class TransformSDF extends SDF {
    constructor(child_sdf, transformer) {
        super();
        this.child_sdf = child_sdf;
        this.transformer = transformer;
    }
    distance(p) {
        return this.child_sdf.distance(this.transformer.transform(p));
    }
    getBoundingBox(transform, inv_transform) {
        return this.transformer.transformBoundingBox(this.child_sdf.getBoundingBox(transform, inv_transform));
    }
}

class RecursiveTransformUnionSDF extends SDF {
    constructor(sdf, transformer, iterations) {
        super();
        this.sdf = sdf;
        this.transformer = transformer;
        this.iterations = iterations;
    }
    distance(p) {
        let bestDist = this.sdf.distance(p);
        for (let i = 0; i < this.iterations; ++i) {
            p = this.transformer.transform(p);
            bestDist = Math.min(this.sdf.distance(p), bestDist);
        }
        return bestDist;
    }
    getBoundingBox(transform, inv_transform) {
        let aabb = this.sdf.getBoundingBox(transform, inv_transform);
        for (let i = 0; i < this.iterations; ++i)
            aabb = AABB.hull(aabb, this.transformer.transformBoundingBox(aabb));
        return aabb;
    }
}

class SDFTransformer {
    transform(p) {
        throw "SDFTransformer subclass has not implemented transform";
    }
    transformBoundingBox(aabb) {
        let corners = aabb.getCorners();
        corners = corners.concat(corners.map(c => this.transform(c)));
        return AABB.fromPoints(corners);
    }
}

class SDFTransformerSequence extends SDFTransformer {
    constructor(...transformers) {
        super();
        this.transformers = transformers;
    }
    transform(p) {
        for (let t of this.transformers)
            p = t.transform(p);
        return p;
    }
}

class SDFMatrixTransformer extends SDFTransformer {
    constructor(transform, inv_transform=Mat4.inverse(transform)) {
        super();
        this._transform = transform;
        this._inv_transform = transform;
    }
    transform(p) {
        return this._inv_transform.times(p);
    }
}

class SDFReflectionTransformer extends SDFTransformer {
    constructor(normal, delta, greater=true) {
        super();
        this.normal = normal.to4(0);
        this.delta = delta;
        this.greater = greater;
    }
    transform(p) {
        const dot = this.normal.dot(p);
        return (dot !== this.delta && this.greater === (dot < this.delta))
            ? p.times(2 * dot).minus(this.normal).to4(1)
            : p;
    }
    transformBoundingBox(aabb) {
        // TODO: this is too big. Can be made considerably smaller, probably...
        let corners = aabb.getCorners();
        corners = corners.concat(corners.map(c => this.transform(c)));
        return AABB.fromPoints(corners);
    }
}

class SDFInfiniteRepetitionTransformer extends SDFTransformer {
    constructor(sizes = Vec.of(1,1,1)) {
        super();
        this.sizes = sizes;
    }
    transform(p) {
        return Vec.from([0,1,2].map(i => Math.fmod((p[i] + this.sizes[i] / 2), this.sizes[i]) - this.sizes[i] / 2)).to4(1);
    }
    transformBoundingBox(aabb) {
        return new AABB(Vec.of(0,0,0,1), Vec.of(Infinity, Infinity, Infinity, 0));
    }
}


// Some SDFs for standard primitive pieces of geometry
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
        if (size instanceof Vec)
            this.size = size.to4(0);
    }
    static distanceComp(p, size) {
        const q = p.abs().minus(size);
        return Vec.max(q, 0).norm() + Math.min(Math.max(q[0], q[1], q[2]), 0);
    }
    distance(p) {
        return BoxSDF.distanceComp(p, this.size);
    }
    getBoundingBox(transform, inv_transform) {
        const scale_vec = this.size.length ? this.size : Vec.of(this.size, this.size, this.size);
        return new UnitBox().getBoundingBox(transform.times(Mat4.scale(scale_vec.times(2))), Mat4.scale(scale_vec.inverse(2)).times(inv_transform));
    }
}

