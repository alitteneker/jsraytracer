class SDFGeometry extends Geometry {
    static SDF_UID_GEN = 0;
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
            
            if (distance <= this.distance_epsilon)
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
        for (let i = 0; i < 3; ++i)
            N[i] = (this.root_sdf.distance(base_data.position.plus(Vec.axis(i, 4, this.normal_step_size))) - distance) / this.normal_step_size;
        return Object.assign(base_data, this.root_sdf.getMaterialData(base_data.position), { normal: N.normalized() });
    }
    getBoundingBox(transform, inv_transform) {
        return this.root_sdf.getBoundingBox(transform, inv_transform);
    }
}

class SDF {
    constructor() {
        this.UID = ++SDFGeometry.SDF_UID_GEN;
    }
    distance(p) {
        throw "SDF subclass has not implemented distance";
    }
    getBoundingBox(transform, inv_transform) {
        throw "SDF subclass has not implemented getBoundingBox";
    }
    getMaterialData(p) {
        throw "SDF subclass has not implemented getMaterialData";
    }
    static blendMaterialData(mix_factor, data_a, data_b) {
        if      (mix_factor <= 0.0) return data_a;
        else if (mix_factor >= 1.0) return data_b;
        return {
            basecolor: (data_a.basecolor || Vec.of(1,1,1)).mix(data_b.basecolor || Vec.of(1,1,1), mix_factor),
            UV:        (data_a.UV        || Vec.of(0,0)  ).mix(data_b.UV        || Vec.of(0,0),   mix_factor)
        };
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
    getMaterialData(p) {
        return this.children[Math.indexOfMin(...this.children.map(c => c.distance(p)))].getMaterialData(p);
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
    getMaterialData(p) {
        return this.children[Math.indexOfMax(...this.children.map(c => c.distance(p)))].getMaterialData(p);
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
    getMaterialData(p) {
        return (this.positive.distance(p) > -this.negative.distance(p)) ? this.positive.getMaterialData(p) : this.negative.getMaterialData(p);
    }
    getBoundingBox(transform, inv_transform) {
        return this.positive.getBoundingBox(transform, inv_transform);
    }
}

// cubic with C2 continuity
function smoothMin(a, b, k) {
    const h = Math.max( k - Math.abs( a - b ), 0.0 ) / k;
    return Math.min( a, b ) - h * h * h * k * (1.0 / 6.0);
}

function smoothMinBlend(a, b, k) {
    const h = Math.max( k - Math.abs( a - b ), 0.0 ) / k;
    const m = h * h * h * 0.5;
    return (a<b) ? m : (1.0 - m);
}

class SmoothUnionSDF extends SDF {
    constructor(childA, childB, k=1) {
        super();
        this.k = k;
        this.childA = childA;
        this.childB = childB;
    }
    distance(p) {
        return smoothMin(this.childA.distance(p), this.childB.distance(p), this.k);
    }
    getMaterialData(p) {
        return SDF.blendMaterialData(
            smoothMinBlend(this.childA.distance(p), this.childB.distance(p), this.k),
            this.childA.getMaterialData(p),
            this.childB.getMaterialData(p));
    }
    getBoundingBox(transform, inv_transform) {
        return AABB.hull([this.childA.getBoundingBox(transform, inv_transform), this.childB.getBoundingBox(transform, inv_transform)]).expand(this.k / 6);
    }
}

class SmoothIntersectionSDF extends SDF {
    constructor(childA, childB, k=1) {
        super();
        this.k = k;
        this.childA = childA;
        this.childB = childB;
    }
    distance(p) {
        return -smoothMin(-this.childA.distance(p), -this.childB.distance(p), this.k);
    }
    getMaterialData(p) {
        return SDF.blendMaterialData(
            1.0 - smoothMinBlend( -this.childA.distance(p), -this.childB.distance(p), this.k),
            this.childA.getMaterialData(p),
            this.childB.getMaterialData(p));
    }
    getBoundingBox(transform, inv_transform) {
        return AABB.intersection([this.childA.getBoundingBox(transform, inv_transform), this.childB.getBoundingBox(transform, inv_transform)]);
    }
}

class SmoothDifferenceSDF extends SDF {
    constructor(positive, negative, k=1) {
        super();
        this.k = k;
        this.positive = positive;
        this.negative = negative;
    }
    distance(p) {
        return -smoothMin(-this.positive.distance(p), this.negative.distance(p), this.k);
    }
    getMaterialData(p) {
        return SDF.blendMaterialData(
            smoothMinBlend( -this.positive.distance(p), this.negative.distance(p), this.k),
            this.positive.getMaterialData(p),
            this.negative.getMaterialData(p));
    }
    getBoundingBox(transform, inv_transform) {
        return this.positive.getBoundingBox(transform, inv_transform);
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
    getMaterialData(p) {
        return this.child_sdf.getMaterialData(p);
    }
    getBoundingBox(transform, inv_transform) {
        return this.child_sdf.getBoundingBox(transform, inv_transform).expand(this.rounding);
    }
}





// Some SDFs for standard primitive pieces of geometry
class SphereSDF extends SDF {
    constructor(radius = 1, basecolor=Vec.of(1,1,1)) {
        super();
        this.radius = radius;
        this.basecolor = basecolor;
    }
    distance(p) {
        return p.to4(0).norm() - this.radius;
    }
    getMaterialData(p) {
        return {
            basecolor: this.basecolor,
            UV: Vec.cartesianToSpherical(p.to4(0).normalized())
        };
    }
    getBoundingBox(transform, inv_transform) {
        return Sphere.computeBoundingBox(transform.times(Mat4.scale(this.radius), Mat4.scale(1/this.radius).times(inv_transform)));
    }
}

class PlaneSDF extends SDF {
    constructor(norm = Vec.of(0,0,1,0), delta=0, basecolor=Vec.of(1,1,1)) {
        this.normal = normal;
        this.delta = delta;
        this.basecolor = basecolor;
    }
    distance(p) {
        return this.normal.dot(p) + delta;
    }
    getMaterialData(p) {
        return {
            basecolor: this.basecolor,
            UV: Vec.of(p[0], p[1])
        };
    }
    getBoundingBox(transform, inv_transform) {
        return new AABB(Vec.of(0,0,0,1), Vec.of(Infinity, Infinity, Infinity, 0));
    }
}

class BoxSDF extends SDF {
    constructor(size = 0.5, basecolor=Vec.of(1,1,1)) {
        super();
        this.size = size;
        if (size instanceof Vec)
            this.size = size.to4(0);
        else
            this.size = Vec.of(size, size, size, 0);
        this.basecolor = basecolor;
    }
    static distanceComp(p, size) {
        const q = p.abs().minus(size).to4(0);
        return Vec.max(q, 0).norm() + Math.min(Math.max(q[0], q[1], q[2]), 0);
    }
    distance(p) {
        return BoxSDF.distanceComp(p, this.size);
    }
    getMaterialData(p) {
        return {
            basecolor: this.basecolor
            // TODO: UV should be consistent with regular Box, whatever that is...
        };
    }
    getBoundingBox(transform, inv_transform) {
        const scale_vec = this.size.length ? this.size : Vec.of(this.size, this.size, this.size);
        return new UnitBox().getBoundingBox(transform.times(Mat4.scale(scale_vec.times(2))), Mat4.scale(scale_vec.inverse(2)).times(inv_transform));
    }
}

class TetrahedronSDF extends SDF {
    static vertices = [
        Vec.of( 1,  1,  1, 0),
        Vec.of(-1,  1, -1, 0),
        Vec.of(-1, -1,  1, 0),
        Vec.of( 1, -1, -1, 0)];
    constructor(basecolor=Vec.of(1,1,1)) {
        super();
        this.basecolor = basecolor;
    }
    distance(p) {
        return (Math.max(Math.abs(p[0] + p[1]) - p[2],
                         Math.abs(p[0] - p[1]) + p[2]) - 1) / Math.sqrt(3);
    }
    getMaterialData(p) {
        return {
            basecolor: this.basecolor
            // TODO: what should UV be here?
        };
    }
    getBoundingBox(transform, inv_transform) {
        return AABB.fromPoints(TetrahedronSDF.vertices.map(v => transform.times(v)));
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
        const [pt, s] = this.transformer.transform(p);
        return this.child_sdf.distance(pt) * s;
    }
    getMaterialData(p) {
        return this.child_sdf.getMaterialData(p);
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
        let bestDist = this.sdf.distance(p), s = 1;
        for (let i = 0; i < this.iterations; ++i) {
            let [pt, st] = this.transformer.transform(p);
            [p, s] = [pt, s * st];
            bestDist = Math.min(this.sdf.distance(p) * s, bestDist);
        }
        return bestDist;
    }
    getMaterialData(p) {
        // TODO: could modify color by depth of max...
        return this.sdf.getMaterialData(p);
    }
    getBoundingBox(transform, inv_transform) {
        let aabb = this.sdf.getBoundingBox(transform, inv_transform);
        for (let i = 0; i < this.iterations; ++i)
            aabb = AABB.hull([aabb, this.transformer.transformBoundingBox(aabb)]);
        return aabb;
    }
}

class SDFTransformer {
    constructor() {
        this.UID = ++SDFGeometry.SDF_UID_GEN;
    }
    transform(p) {
        throw "SDFTransformer subclass has not implemented transform";
    }
    transformBoundingBox(aabb) {
        throw "SDFTransformer subclass has not implemented transformBoundingBox";
    }
}

class SDFTransformerSequence extends SDFTransformer {
    constructor(...transformers) {
        super();
        this.transformers = transformers;
    }
    transform(p) {
        let s = 1;
        for (let t of this.transformers) {
            let [pt, st] = t.transform(p);
            [p, s] = [pt, s * st];
        }
        return [p, s];
    }
    transformBoundingBox(aabb) {
        for (let t of this.transformers)
            aabb = t.transformBoundingBox(aabb);
        return aabb;
    }
}

class SDFRecursiveTransformer extends SDFTransformer {
    constructor(transformer, iterations) {
        super();
        this.transformer = transformer;
        this.iterations = iterations;
    }
    transform(p) {
        let s = 1;
        for (let i = 0; i < this.iterations; ++i) {
            let [pt, st] = this.transformer.transform(p);
            [p, s] = [pt, s * st];
        }
        return [p, s];
    }
    transformBoundingBox(aabb) {
        for (let i = 0; i < this.iterations; ++i)
            aabb = this.transformer.transformBoundingBox(aabb);
        return aabb;
    }
}

class SDFMatrixTransformer extends SDFTransformer {
    constructor(transform, inv_transform=Mat4.inverse(transform)) {
        super();
        this._transform = transform;
        this._inv_transform = inv_transform;
        this._scale = SDFMatrixTransformer.calcScaleForTransform(transform);
    }
    static calcScaleForTransform(transform) {
        return Math.min(...[0,1,2].map(i => transform.column(i).to3().norm()));
    }
    transform(p) {
        return [this._inv_transform.times(p), this._scale];
    }
    transformBoundingBox(aabb) {
        return aabb.getBoundingBox(this._transform, this._inv_transform);
    }
}

class SDFReflectionTransformer extends SDFTransformer {
    constructor(normal, delta) {
        super();
        normal = normal.to4(0);
        if (delta instanceof Vec)
            delta = normal.dot(delta);
        this.delta = delta / normal.norm();
        this.normal = normal.normalized();
    }
    static transformComp(p, normal, delta) {
        const dot = normal.dot(p) - delta;
        if (dot < 0)
            return [p.minus(normal.times(2 * dot)), 1];
        return [p, 1];
    }
    transform(p) {
        return SDFReflectionTransformer.transformComp(p, this.normal, this.delta, this.greater);
    }
    transformBoundingBox(aabb) {
        let corners = aabb.getCorners();
        corners = corners.concat(corners.map(c => SDFReflectionTransformer.transformComp(c, this.normal.times(-1), -this.delta)[0]));
        return AABB.fromPoints(corners);
    }
}

class SDFInfiniteRepetitionTransformer extends SDFTransformer {
    constructor(sizes = Vec.of(1,1,1)) {
        super();
        this.sizes = sizes;
    }
    transform(p) {
        return [Vec.from([0,1,2].map(i => Math.fmod((p[i] + this.sizes[i] / 2), this.sizes[i]) - this.sizes[i] / 2)).to4(1), 1];
    }
    transformBoundingBox(aabb) {
        return new AABB(Vec.of(0,0,0,1), Vec.of(Infinity, Infinity, Infinity, 0));
    }
}

