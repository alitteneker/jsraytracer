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
            return this.bg_color;
        const intersection = this.cast(ray, minDistance);
        if (intersection.object == null)
            return this.bg_color;
        return intersection.object.color(ray, intersection.distance, this, recursionDepth - 1);
    }
}
class SceneObject {
    constructor(geometry, material, base_material_data) {
        this.geometry = geometry;
        this.material = material;
        this.base_material_data = base_material_data | {};
    }
    intersect(ray, minDistance) {
        return this.geometry.intersect(ray, minDistance);
    }
    color(ray, distance, scene, recursionDepth) {
        let base_data = Object.assign({
                ray: ray,
                distance: distance,
                position: ray.getPoint(distance)
            }, this.base_material_data);
        let material_data = this.geometry.materialData(ray, distance, base_data);
        return this.material.color(material_data, scene, recursionDepth);
    }
    getTransformed(transform, inv_transform=Mat4.inverse(transform)) {
        return new SceneObject(
            this.geometry.getTransformed(transform, inv_transform),
            this.material,
            this.base_material_data);
    }
    getBoundingBox() {
        if (!this.boundingBox)
            this.boundingBox = this.geometry.getBoundingBox();
        return this.boundingBox;
    }
}