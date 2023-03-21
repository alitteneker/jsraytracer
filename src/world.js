class World {
    constructor(objects, lights=[], bg_color=Vec.of(0, 0, 0)) {
        this.bg_color = bg_color;
        this.objects = objects;
        this.lights = lights;
    }
    static getMinimumIntersection(objects, ray, minDistance, maxDistance, intersectTransparent) {
        let closestIntersection = { distance: Infinity, object: null, ancestors: [] };
        for (let o of objects) {
            let intersection = o.intersect(ray, minDistance, maxDistance, intersectTransparent);
            if (intersection.distance > minDistance && intersection.distance < closestIntersection.distance && intersection.distance < maxDistance)
                closestIntersection = intersection;
        }
        return closestIntersection;
    }
    getBoundingBox() {
        return this.objects.length ? AABB.hull(this.objects.map(o => o.getBoundingBox())) : AABB.empty();
    }
    getFiniteBoundingBox() {
        const aabbs = [];
        for (let o of this.objects) {
            const aabb = o.getBoundingBox();
            if (aabb.isFinite())
                aabbs.push(aabb);
        }
        return aabbs.length ? AABB.hull(aabbs) : AABB.empty();
        
    }
    cast(ray, minDistance = 0, maxDistance = Infinity, intersectTransparent=true) {
        return World.getMinimumIntersection(this.objects, ray, minDistance, maxDistance, intersectTransparent);
    }
    color(ray, recursionDepth, minDistance = 0) {
        if (!recursionDepth)
            return Vec.of(0,0,0);
        const intersection = this.cast(ray, minDistance);
        if (intersection.object == null)
            return this.bg_color;
        let ancestorInvTransform = Mat4.identity();
        for (let i = 0; i < intersection.ancestors.length; ++i)
            ancestorInvTransform = intersection.ancestors[i].getInvTransform().times(ancestorInvTransform);
        return intersection.object.color(ray, intersection.distance, ancestorInvTransform, this, recursionDepth - 1);
    }
}

class WorldObject {
    static _OBJECT_UID_GEN = 0;
    constructor(transform, inv_transform) {
        this.OBJECT_UID = WorldObject._OBJECT_UID_GEN++;
        
        this.transform = transform;
        this.inv_transform = inv_transform;
        
        this.parents = [];
    }
    getBoundingBox() {
        if (!this.aabb)
            this.aabb = this.buildBoundingBox();
        return this.aabb;
    }
    getTransform() {
        return this.transform;
    }
    getInvTransform() {
        return this.inv_transform;
    }
    setTransform(transform, inv_transform=Mat4.inverse(transform)) {
        this.transform = transform;
        this.inv_transform = inv_transform;
        this.contentsChanged();
    }
    contentsChanged() {
        this.aabb = null;
        for (let p of this.parents)
            p.contentsChanged();
    }
    buildBoundingBox() {
        throw "WorldObject subclass does not implement getBoundingBox";
    }
    intersect(ray, minDistance, maxDistance=Infinity, shadowCast=true) {
        throw "WorldObject subclass does not implement intersect";
    }
    color(ray, distance, ancestorInvTransform, world, recursionDepth) {
        throw "WorldObject subclass does not implement color";
    }
}

class TransformedWorldObject extends WorldObject {
    constructor(object, transform=Mat4.identity(), inv_transform=Mat4.inverse(transform)) {
        super(transform, inv_transform);
        
        this.object = object;
        object.parents.push(this);
    }
    intersect(ray, minDistance, maxDistance=Infinity, shadowCast=true) {
        return {
            distance: this.object.intersect(ray.getTransformed(this.getInvTransform()), minDistance, maxDistance, shadowCast),
            ancestors: [this],
            object: this.object
        };
    }
    buildBoundingBox() {
        return this.object.getBoundingBox().getBoundingBox(this.getTransform(), this.getInvTransform());
    }
}


class Primitive extends WorldObject {
    constructor(geometry, material, transform=Mat4.identity(), inv_transform=Mat4.inverse(transform), does_cast_shadow=true) {
        super(transform, inv_transform);
        
        this.geometry = geometry;
        this.material = material;
        
        this.does_cast_shadow = does_cast_shadow;
    }
    intersect(ray, minDistance, maxDistance=Infinity, shadowCast=true) {
        if (!this.does_cast_shadow && !shadowCast)
            return { distance: Infinity, ancestors: [], object: this };
        return {
            distance: this.geometry.intersect(ray.getTransformed(this.getInvTransform()), minDistance, maxDistance),
            ancestors: [],
            object: this
        };
    }
    color(ray, distance, ancestorInvTransform, world, recursionDepth) {
        const inv_transform = this.getInvTransform().times(ancestorInvTransform);
        let base_data = {
            ray: ray,
            distance: distance,
            position: ray.getTransformed(inv_transform).getPoint(distance)
        };
        let material_data = this.geometry.materialData(base_data, ray.direction);
        if ('normal' in material_data)
            material_data.normal = inv_transform.transposed().times(material_data.normal).to4(0).normalized();
        material_data.position = ray.getPoint(distance);
        return this.material.color(material_data, world, recursionDepth);
    }
    buildBoundingBox() {
        return this.geometry.getBoundingBox(this.getTransform(), this.getInvTransform());
    }
}