class World {
    // Lights are WorldObjects and live in this.objects with everything else. The separate `lights` argument is kept
    // for convenience (and for existing scene files): any lights passed there are simply added to the objects.
    constructor(objects, lights=[], bg_color=Vec.of(0, 0, 0)) {
        this.bg_color = bg_color;
        this.objects = objects.concat(lights.filter(l => !objects.includes(l)));
    }
    static deserialize(data) {
        // Scenes serialized before lights were WorldObjects carry a separate `lights` array.
        return new World(data.objects || [], data.lights || [], data.bg_color);
    }
    // The lights that illuminate this world: one LightInstance per light reachable through this.objects, including
    // lights nested inside Aggregates and TransformedWorldObjects (the instance carries those ancestors, so sampling
    // uses the light's world transform). Lights inside a BVHAggregate aren't supported (see BVHAggregate.build).
    // Cached, since materials ask for this at every shading point; call contentsChanged() after adding, removing or
    // moving lights between aggregates. (Transforms are read live, so moving a light needs no call.)
    get lights() {
        if (!this._light_instances || this._light_instances_source !== this.objects || this._light_instances_count !== this.objects.length) {
            const instances = [];
            const visit = (o, ancestors) => {
                if (o instanceof Light)
                    instances.push(new LightInstance(o, ancestors));
                else if (o instanceof TransformedWorldObject)
                    visit(o.object, ancestors.concat(o));
                else if (o instanceof Aggregate && !(o instanceof BVHAggregate))
                    for (const child of o.objects)
                        visit(child, ancestors.concat(o));
            };
            for (const o of this.objects)
                visit(o, []);
            // Not enumerable, so the cache is never serialized.
            for (const [k, v] of [["_light_instances", instances], ["_light_instances_source", this.objects], ["_light_instances_count", this.objects.length]])
                Object.defineProperty(this, k, { value: v, writable: true, enumerable: false, configurable: true });
        }
        return this._light_instances;
    }
    contentsChanged() {
        Object.defineProperty(this, "_light_instances", { value: null, writable: true, enumerable: false, configurable: true });
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
    // Bounding boxes describe the scene's geometry, so lights are left out (a distant point light would otherwise
    // drag the box, and anything centered on it, far from the visible objects).
    getBoundingBox() {
        const objects = this.objects.filter(o => !(o instanceof Light));
        return objects.length ? AABB.hull(objects.map(o => o.getBoundingBox())) : AABB.empty();
    }
    getFiniteBoundingBox() {
        const aabbs = [];
        for (let o of this.objects) {
            if (o instanceof Light)
                continue;
            const aabb = o.getBoundingBox();
            if (aabb.isFinite())
                aabbs.push(aabb);
        }
        return aabbs.length ? AABB.hull(aabbs) : AABB.empty();
    }
    cast(ray, minDistance = 0, maxDistance = Infinity, intersectTransparent=true) {
        return World.getMinimumIntersection(this.objects, ray, minDistance, maxDistance, intersectTransparent);
    }
    // countEmission: whether a light hit directly by this ray should contribute its emission. See the comment at the
    // top of lights.js: true for camera rays and exact (mirror/refraction) bounces, false for sampled bounces.
    color(ray, recursionDepth, minDistance = 0, countEmission = true) {
        if (!recursionDepth)
            return Vec.of(0,0,0);
        const intersection = this.cast(ray, minDistance);
        if (intersection.object == null)
            return this.bg_color;
        let ancestorInvTransform = Mat4.identity();
        for (let i = 0; i < intersection.ancestors.length; ++i)
            ancestorInvTransform = intersection.ancestors[i].getInvTransform().times(ancestorInvTransform);
        return intersection.object.color(ray, intersection.distance, ancestorInvTransform, this, recursionDepth - 1, countEmission);
    }
}

class WorldObject {
    static _OBJECT_UID_GEN = 0;
    constructor(transform, inv_transform) {
        Object.defineProperty(this, "OBJECT_UID", { value: WorldObject._OBJECT_UID_GEN++, enumerable: false, configurable: false, writable: false });
        
        this.transform = transform;
        this.inv_transform = inv_transform;
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
    }
    static deserialize(data) {
        return new TransformedWorldObject(data.object, data.transform, data.inv_transform);
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
    static deserialize(data) {
        return new Primitive(data.geometry, data.material, data.transform, data.inv_transform, data.does_cast_shadow);
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