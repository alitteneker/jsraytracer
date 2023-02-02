class Scene {
    constructor(objects, lights=[], bg_color=Vec.of(0, 0, 0)) {
        this.bg_color = bg_color;
        this.objects = objects;
        this.lights = lights;
    }
    cast(ray, minDistance = 0, maxDistance = Infinity, intersectTransparent=true) {
        let closestDist = Infinity, closestObj = null;
        for (let o of this.objects) {
            let distance = o.intersect(ray, minDistance, maxDistance, intersectTransparent);
            if (distance > minDistance && distance < closestDist && distance < maxDistance) {
                closestDist = distance;
                closestObj = o;
            }
        }
        return { object: closestObj, distance: closestDist };
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
class SceneObject {
    static _OBJECT_UID_GEN = 0;
    constructor(geometry, material, transform=Mat4.identity(), inv_transform=Mat4.inverse(transform), base_material_data={}, does_cast_shadow=true) {
        this.OBJECT_UID = SceneObject._OBJECT_UID_GEN++;

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
        return this.geometry.intersect(ray.getTransformed(this.inv_transform), minDistance, maxDistance);
    }
    color(ray, distance, scene, recursionDepth) {
        let base_data = Object.assign({
                ray: ray,
                distance: distance,
                position: ray.getTransformed(this.inv_transform).getPoint(distance)
            }, this.base_material_data);
        let material_data = this.geometry.materialData(ray, distance, base_data);
        if ('normal' in material_data)
            material_data.normal = this.inv_transform.transposed().times(material_data.normal).to4(0).normalized();
        material_data.position = ray.getPoint(distance);
        return this.material.color(material_data, scene, recursionDepth);
    }
    getTransformed(transform, inv_transform=Mat4.inverse(transform)) {
        return new SceneObject(
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