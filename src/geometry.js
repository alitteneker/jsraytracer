class Geometry {
    static GEOMETRY_UID_GEN = 0;
    constructor() {
        this.GEOMETRY_UID = Geometry.GEOMETRY_UID_GEN++;
    }
    intersect(ray, minDistance, maxDistance) {
        throw "Geometry subclass nas implemented intersect";
    }
    materialData(ray, scalar, base_data) {
        throw "Geometry subclass has not implemented materialData";
    }
    getTransformed(transform, inv_transform, inv_transform_transpose) {
        throw "Geometry subclass has not implemented getTransformed";
    }
    getBoundingBox(transform, inv_transform) {
        throw "Geometry subclass has not implemented getBoundingBox";
    }
}

class AABB extends Geometry {
    constructor(center, half_size, min = center.minus(half_size), max = center.plus(half_size)) {
        super();
        this.center = center;
        this.half_size = half_size;
        this.min = min;
        this.max = max;
    }
    static empty() {
        return new AABB(Vec.of(0,0,0,1), Vec.of(0,0,0,0), Vec.of( Infinity,  Infinity,  Infinity, 1), Vec.of(-Infinity, -Infinity, -Infinity, 1));
    }
    static fromMinMax(min, max) {
        const center = min.mix(max, 0.5), half_size = max.minus(min).times(0.5);
        for (let i = 0; i < 3; ++i) {
            if (!isFinite(min[i]) && !isFinite(max[i])) {
                if (min[i] == max[i])
                    half_size[i] = 0;
                if (min[i] == -Infinity && max[i] == Infinity)
                    center[i] = 0;
            }
        }
        return new AABB(center, half_size, min, max);
    }
    static fromPoints(points) {
        if (points.length == 0)
            throw "Cannot build AABB with zero points";
        let min = Vec.of( Infinity,  Infinity,  Infinity, 1),
            max = Vec.of(-Infinity, -Infinity, -Infinity, 1);
        for (let p of points) {
            for (let i = 0; i < 3; ++i) {
                if (p[i] < min[i])
                    min[i] = p[i];
                if (p[i] > max[i])
                    max[i] = p[i];
            }
        }
        return AABB.fromMinMax(min, max);
    }
    static hull(boxes) {
        if (boxes.length == 0)
            throw "Cannot build AABB with zero boxes";
        let min = Vec.of( Infinity,  Infinity,  Infinity, 1),
            max = Vec.of(-Infinity, -Infinity, -Infinity, 1);
        for (let b of boxes) {
            for (let i = 0; i < 3; ++i) {
                if (b.min[i] < min[i])
                    min[i] = b.min[i];
                if (b.max[i] > max[i])
                    max[i] = b.max[i];
            }
        }
        return AABB.fromMinMax(min, max);
    }
    static intersection(boxes) {
        let min = Vec.of(-Infinity, -Infinity, -Infinity, 1),
            max = Vec.of( Infinity,  Infinity,  Infinity, 1);
        for (let b of boxes) {
            for (let i = 0; i < 3; ++i) {
                if (b.min[i] > min[i])
                    min[i] = b.min[i];
                if (b.max[i] < max[i])
                    max[i] = b.max[i];
            }
        }
        for (let i = 0; i < 3; ++i)
            if (min[i] > max[i])
                return null;
        return AABB.fromMinMax(min, max);
    }
    static infinite() {
        return AABB.fromMinMax(
            Vec.of(-Infinity, -Infinity, -Infinity, 1),
            Vec.of( Infinity,  Infinity,  Infinity, 1));
    }
    volume() {
        return 8 * this.half_size[0] * this.half_size[1] * this.half_size[2];
    }
    surfaceArea() {
        return 4 * (this.half_size[0] * this.half_size[1]
                  + this.half_size[0] * this.half_size[2]
                  + this.half_size[1] * this.half_size[2]);
    }
    getCorners() {
        const a = this.min, b = this.max;
        return Vec.cast(
            [a[0], a[1], a[2], 1], [b[0], a[1], a[2], 1],
            [a[0], b[1], a[2], 1], [b[0], b[1], a[2], 1],
            [a[0], a[1], b[2], 1], [b[0], a[1], b[2], 1],
            [a[0], b[1], b[2], 1], [b[0], b[1], b[2], 1]);
    }
    intersect(ray, minDistance, maxDistance) {
        const t = this.get_intersects(ray, minDistance, maxDistance);
        if (t)
            return (t.min >= minDistance) ? t.min : t.max;
        else
            return -Infinity;
    }
    isFinite() {
        for (let i = 0; i < 3; ++i)
            if (!isFinite(this.min[i]) || !isFinite(this.max[i]))
                return false;
        return true;
    }
    get_intersects(ray, minDistance = -Infinity, maxDistance = Infinity) {
        let t_min = -Infinity, t_max = Infinity;
        const p = this.center.minus(ray.origin),
            epsilon = 0.0000001;
        for (let i = 0; i < 3; ++i) {
            if (Math.abs(ray.direction[i]) > epsilon) {
                let t1 = (p[i] + this.half_size[i]) / ray.direction[i],
                    t2 = (p[i] - this.half_size[i]) / ray.direction[i];
                if (t1 > t2) { let tmp = t1; t1 = t2; t2 = tmp; }
                if (t1 > t_min)
                    t_min = t1;
                if (t2 < t_max)
                    t_max = t2;
                if (t_min > t_max || t_max < minDistance || t_min > maxDistance)
                    return null;
            }
            else if (Math.abs(p[i]) > this.half_size[i])
                return null;
        }
        return { min: t_min, max: t_max };
    }
    materialData(ray, scalar, base_data) {
        const p = base_data.position;
        let norm_dist = 0, norm = Vec.of(0, 0, 0, 0);
        for (let i = 0; i < 3; ++i) {
            const comp = (p[i] - this.center[i]) / this.half_size[i],
                abs_comp = Math.abs(comp);
            if (abs_comp > norm_dist) {
                norm_dist = abs_comp;
                norm = Vec.of(0, 0, 0, 0);
                norm[i] = Math.sign(comp);
            }
        }
        if (norm.dot(ray.direction) > 0)
            norm = norm.times(-1);
        return Object.assign(base_data, { normal: norm });
    }
    getBoundingBox(transform, inv_transform) {
        return AABB.fromPoints(this.getCorners().map(c => transform.times(c)));
    }
}

class UnitBox extends AABB {
    constructor() {
        super(Vec.of(0, 0, 0, 1), Vec.of(0.5, 0.5, 0.5, 0));
    }
}

class SimplePlane extends Geometry {
    constructor(mdata) {
        super();
        this.base_material_data = mdata || {};
    }
    intersect(ray) {
        return (ray.direction[2] != 0) ? -ray.origin[2] / ray.direction[2] : -Infinity;
    }
    materialData(ray, scalar, base_data) {
        return Object.assign(base_data, {
            normal: Vec.of(0, 0, 1, 0),
            UV: Vec.of(base_data.position[0], base_data.position[1])
        });
    }
}

class Plane extends SimplePlane {
    constructor(mdata) {
        super(mdata);
    }
    getBoundingBox(transform, inv_transform) {
        const normal = inv_transform.transposed().times(Vec.of(0, 0, 1, 0)).normalized();
        let s = Vec.of(Infinity, Infinity, Infinity, 0);
        for (let i = 0; i < 3; ++i) {
            let found = false;
            for (let j = 0; !found && j < 3; ++j)
                if (i != j && normal[j] != 0)
                    found = true;
            if (!found)
                s[i] = 0;
        }
        const p = transform.times(Vec.of(0, 0, 0, 1));
        return new AABB(p, s, p.minus(s), p.plus(s.to4(1)));
    }
}

class Square extends SimplePlane {
    constructor(mdata) {
        super(mdata);
    }
    intersect(ray) {
        const t = super.intersect(ray);
        const p = ray.getPoint(t);
        return [p[0], p[1]].every(c => (-0.5 <= c && c <= 0.5)) ? t : -Infinity;
    }
    getBoundingBox(transform, inv_transform) {
        return AABB.fromPoints([[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(a => Vec.of(...a, 0, 1)).map(p => transform.times(p)));
    }
}

class Circle extends SimplePlane {
    constructor(mdata) {
        super(mdata);
    }
    intersect(ray) {
        const t = super.intersect(ray);
        const p = ray.getPoint(t);
        return (p.minus(Vec.of(0,0,0,1)).squarednorm() <= 1) ? t : -Infinity;
    }
    static getTransformedEdgePoints(transform, inv_transform) {
        const world_axis = transform.times(Vec.axis(2,4)), world_center = transform.column(3), ps = [];
        for (let i = 0; i < 3; ++i) {
            const world_edge_dir = transform.times(inv_transform.times(world_axis.cross(Vec.axis(i, 4)).to4(0)).normalized());
            ps.push(world_center.plus(world_edge_dir), world_center.minus(world_edge_dir));
        }
        return ps;
    }
    getBoundingBox(transform, inv_transform) {
        return AABB.fromPoints(Circle.getTransformedEdgePoints(transform, inv_transform));
    }
}

class Triangle extends Geometry {
    constructor(ps, psdata={}) {
        super()
        
        this.v0 = ps[1].minus(ps[0]).to3();
        this.v1 = ps[2].minus(ps[0]).to3();
        
        const heron = this.v0.cross(this.v1);
        
        this.area = heron.norm() / 2.0;
        this.normal = heron.normalized().to4(0);
        this.delta = this.normal.dot(ps[0]);
        this.ps = ps;
        this.psdata = psdata;
        
        this.d00 = this.v0.squarednorm();
        this.d11 = this.v1.squarednorm();
        this.d01 = this.v0.dot(this.v1);
        this.denom = this.d00 * this.d11 - this.d01 * this.d01;
    }
    getTransformed(t, inv_t=Mat4.inverse(t), inv_t_transpose=inv_t_transpose) {
        const data = {};
        const datamap = { tangent: t, bitangent: t, normal: inv_t_transpose };
        for (let k in this.psdata)
            data[k] = datamap[k] ? this.psdata[k].map(x => datamap[k].times(x)) : this.psdata[k];
        return new Triangle(this.ps.map(p => t.times(p)), data);
    }
    intersect(ray) {
        const denom = this.normal.dot(ray.direction);
        const distance = (denom != 0) ? (this.delta - this.normal.dot(ray.origin)) / denom : -Infinity;
        if (!isFinite(distance) || distance < 0)
            return distance;
        const bary = this.toBarycentric(ray.getPoint(distance).to3());
        return bary.every(x => (x >= 0 && x <= 1)) ? distance : -Infinity;
    }
    materialData(ray, scalar, base_data) {
        const extend_data = {
            normal: this.normal,
            bary: this.toBarycentric(base_data.position)
        };
        for (let k in this.psdata)
            extend_data[k] = Triangle.blend(extend_data.bary, this.psdata[k]);
        Object.assign(base_data, extend_data);
        return base_data;
    }
    getBoundingBox(transform, inv_transform) {
        return AABB.fromPoints(this.ps.map(p => transform.times(p)));
    }
    toBarycentric(p) {
        const v2 = p.minus(this.ps[0]).to3(),
            d20 = v2.dot(this.v0),
            d21 = v2.dot(this.v1),
            v = (this.d11 * d20 - this.d01 * d21) / this.denom,
            w = (this.d00 * d21 - this.d01 * d20) / this.denom;
        return Vec.of(1 - v - w, v, w);
    }
    static blend(bary, data) {
        if (data instanceof Array) {
            if (typeof data[0] === "number")
                return bary[0] * data[0]
                    + bary[1] * data[1]
                    + bary[2] * data[2];
            if (data[0] instanceof Vec)
                return data[0].times(bary[0])
                    .plus(data[1].times(bary[1]))
                    .plus(data[2].times(bary[2]));
        }
        return data;
    }
}

class Sphere extends Geometry {
    constructor() {
        super();
    }
    getBoundingBox(transform, inv_transform) {
        const c = transform.column(3);
        let h = Vec.of(0,0,0,0);
        for (let i = 0; i < 3; ++i)
            h[i] = transform.times(transform.transposed().times(Vec.axis(i, 4)).to4(0).normalized().to4(1))[i] - c[i];
        return new AABB(c, h);
    }
    static staticIntersect(r, minDistance) {
        const a = r.direction.squarednorm(),
              b = r.direction.dot(r.origin),
              c = r.origin.to3().squarednorm() - 1;
        let big = b * b - a * c;
        if (big < 0 || a == 0)
            return -Infinity;
        big = Math.sqrt(big);
        const t1 = (-b + big) / a,
            t2 = (-b - big) / a;
        if (t1 >= minDistance && t2 >= minDistance)
            return Math.min(t1, t2);
        return (t2 < minDistance) ? t1 : t2;
    }
    intersect(r, minDistance) {
        return Sphere.staticIntersect(r, minDistance);
    }
    materialData(ray, scalar, base_data) {
        const n = base_data.position.normalized();
        return Object.assign(base_data, {
            normal: n,
            UV: Vec.of(
                0.5 + Math.atan2(n[2], n[0]) / (2 * Math.PI),
                0.5 - Math.asin(n[1]) / Math.PI)
        });
    }
}

class Cylinder extends Geometry {
    constructor() {
        super();
    }
    getBoundingBox(transform, inv_transform) {
        const axis = transform.times(Vec.axis(2,4));
        const circle_points = Circle.getTransformedEdgePoints(transform, inv_transform);
        return AABB.fromPoints(circle_points.map(v => [v.plus(axis), v.minus(axis)]).flat());
    }
    intersect(r, minDistance) {
        if (Math.abs(r.origin[2]) > 1 && r.direction[2] != 0)
            minDistance = Math.max(minDistance, -(r.origin[2] - Math.sign(r.origin[2])) / r.direction[2]);
        const t = Sphere.staticIntersect(new Ray(...[r.origin, r.direction].map(v => Vec.of(1,1,0,1).times(v))), minDistance);
        return (Math.abs(r.origin[2] + t * r.direction[2]) <= 1) ? t : -Infinity;
    }
    materialData(ray, scalar, base_data) {
        const n = base_data.position.normalized();
        return Object.assign(base_data, {
            normal: Vec.of(base_data.position[0], base_data.position[1], 0, 0).normalized(),
            UV: Vec.of(
                0.5 + Math.atan2(base_data.position[2], base_data.position[0]) / (2 * Math.PI),
                0.5 + base_data.position[1])
        });
    }
}