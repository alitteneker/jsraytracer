class Geometry {
    intersect(ray, minDistance, maxDistance) {
        throw "Geometry subclass nas implemented intersect";
    }
    materialData(ray, scalar, base_data) {
        throw "Geometry subclass has not implemented materialData";
    }
    getTransformed(transform, inv_transform, inv_transform_transpose) {
        throw "Geometry subclass has not implemented getTransformed";
    }
    getBoundingBox() {
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
        return AABB.fromMinMax(min, max);
    }
    static infinite() {
        return AABB.fromMinMax(
            Vec.of(-Infinity, -Infinity, -Infinity, 1),
            Vec.of( Infinity,  Infinity,  Infinity, 1));
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
    getTransformed(transform) {
        throw "Cannot get a transformed AABB.";
    }
    getBoundingBox() {
        return this;
    }
}

class Plane extends Geometry {
    constructor(normal, delta, mdata) {
        super();
        this.normal = normal;
        this.delta = delta;
        this.base_material_data = mdata || {};
    }
    getTransformed(t, inv_t=Mat4.inverse(t), inv_t_transpose=inv_t.transposed()) {
        const n = inv_t_transpose.times(this.normal),
            o = t.times(this.normal.times(this.delta).to4(1));
        return new Plane(n, n.dot(o), this.base_material_data);
    }
    getPoint() {
        return this.normal.times(this.delta).to4(1);
    }
    intersect(ray) {
        let denom = this.normal.dot(ray.direction);
        return (denom != 0) ? (this.delta - this.normal.dot(ray.origin)) / denom : -Infinity;
    }
    materialData(ray, scalar, base_data) {
        return Object.assign(base_data, { normal: this.normal });
    }
    getBoundingBox() {
        let s = Vec.of(Infinity, Infinity, Infinity, 0);
        for (let i = 0; i < 3; ++i) {
            let found = false;
            for (let j = 0; !found && j < 3; ++j)
                if (i != j && this.normal[j] != 0)
                    found = true;
            if (!found)
                s[i] = 0;
        }
        const p = this.getPoint();
        return new AABB(p, s, p.minus(s), p.plus(s.to4(1)));
    }
}

class Triangle extends Plane {
    constructor(ps, psdata) {
        const n = ps[1].minus(ps[0]).cross(ps[2].minus(ps[0])).normalized();
        super(n.to4(0), n.dot(ps[0]));
        this.ps = ps;
        this.psdata = psdata || {};
        
        this.v0 = ps[1].minus(ps[0]).to3();
        this.v1 = ps[2].minus(ps[0]).to3();
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
        const distance = super.intersect(ray);
        if (!isFinite(distance) || distance < 0)
            return distance;
        const bary = this.toBarycentric(ray.getPoint(distance).to3());
        return bary.every(x => (x >= 0 && x <= 1)) ? distance : -Infinity;
    }
    materialData(ray, scalar, base_data) {
        base_data = super.materialData(ray, scalar, base_data);
        const extend_data = { bary: this.toBarycentric(base_data.position) };
        for (let k in this.psdata)
            extend_data[k] = Triangle.blend(extend_data.bary, this.psdata[k]);
        Object.assign(base_data, extend_data);
        return base_data;
    }
    getBoundingBox() {
        return AABB.fromPoints(this.ps);
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
    constructor(m=Mat4.identity()) {
        super();
        this.m = m;
        this.m_inv = Mat4.inverse(m);
        this.m_inv_transpose = this.m_inv.transposed();
    }
    getTransformed(transform, inv_transform) {
        return new Sphere(transform.times(this.m.times));
    }
    getBoundingBox() {
        const c = this.m.column(3);
        let h = Vec.of(0,0,0,0);
        for (let i = 0; i < 3; ++i)
            h[i] = this.m.times(this.m.transposed().times(Vec.axis(i, 4)).to4(0).normalized().to4(1))[i] - c[i];
        return new AABB(c, h);
    }
    intersect(ray, minDistance) {
        const r = ray.getTransformed(this.m_inv),
            a = r.direction.squarednorm(),
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
    materialData(ray, scalar, base_data) {
        let n = this.m_inv.times(base_data.position).normalized();
        return Object.assign(base_data, {
            normal: this.m_inv_transpose.times(n).to4(0).normalized(),
            UV: Vec.of(
                0.5 + Math.atan2(n[2], n[0]) / (2 * Math.PI),
                0.5 - Math.asin(n[1]) / Math.PI)
        });
    }
}