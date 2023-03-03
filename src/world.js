class World {
    constructor(objects, lights=[], bg_color=Vec.of(0, 0, 0)) {
        this.bg_color = bg_color;
        this.objects = objects;
        this.lights = lights;
    }
    cast(ray, minDistance = 0, maxDistance = Infinity, intersectTransparent=true) {
        let closestIntersection = { distance: Infinity, object: null, invTransform: null };
        for (let o of this.objects) {
            let intersection = o.intersect(ray, minDistance, maxDistance, intersectTransparent);
            if (intersection.distance > minDistance && intersection.distance < closestIntersection.distance && intersection.distance < maxDistance)
                closestIntersection = intersection;
        }
        return closestIntersection;
    }
    color(ray, recursionDepth, minDistance = 0) {
        if (!recursionDepth)
            return Vec.of(0,0,0);
        const intersection = this.cast(ray, minDistance);
        if (intersection.object == null)
            return this.bg_color;
        return intersection.object.color(ray, intersection.distance, this, recursionDepth - 1);
    }
}
class WorldObject {
    static _OBJECT_UID_GEN = 0;
    constructor() {
        this.OBJECT_UID = WorldObject._OBJECT_UID_GEN++;
    }
    intersect(ray, minDistance, maxDistance=Infinity, shadowCast=true) {
        throw "WorldObject subclass does not implement intersect";
    }
    color(ray, distance, world, recursionDepth) {
        throw "WorldObject subclass does not implement color";
    }
    getBoundingBox() {
        throw "WorldObject subclass does not implement getBoundingBox";
    }
}

class Primitive extends WorldObject {
    constructor(geometry, material, transform=Mat4.identity(), inv_transform=Mat4.inverse(transform), base_material_data={}, does_cast_shadow=true) {
        super();
        
        this.geometry = geometry;
        this.material = material;
        
        this.transform = transform;
        this.inv_transform = inv_transform;
        
        this.base_material_data = base_material_data;
        this.does_cast_shadow = does_cast_shadow;
    }
    intersect(ray, minDistance, maxDistance=Infinity, shadowCast=true) {
        if (!this.does_cast_shadow && !shadowCast)
            return Infinity;
        return {
            distance: this.geometry.intersect(ray.getTransformed(this.inv_transform), minDistance, maxDistance),
            transform: null,
            object: this
        };
    }
    color(ray, distance, world, recursionDepth) {
        let base_data = Object.assign({
                ray: ray,
                distance: distance,
                position: ray.getTransformed(this.inv_transform).getPoint(distance)
            }, this.base_material_data);
        let material_data = this.geometry.materialData(base_data, ray.direction);
        if ('normal' in material_data)
            material_data.normal = this.inv_transform.transposed().times(material_data.normal).to4(0).normalized();
        material_data.position = ray.getPoint(distance);
        return this.material.color(material_data, world, recursionDepth);
    }
    setTransform(transform, inv_transform=Mat4.inverse(transform)) {
        this.transform = transform;
        this.inv_transform = inv_transform;
        this.boundingBox = null;
    }
    getTransformed(transform, inv_transform=Mat4.inverse(transform)) {
        return new WorldObject(
            this.geometry,
            this.material,
            
            transform.times(this.transform),
            this.inv_trasform.times(inv_transform),
            
            this.base_material_data,
            this.does_cast_shadow);
    }
    getBoundingBox() {
        if (!this.boundingBox)
            this.boundingBox = this.geometry.getBoundingBox(this.transform, this.inv_transform);
        return this.boundingBox;
    }
}