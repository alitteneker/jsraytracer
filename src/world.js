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
        return this.instancesOf(Light, (o, ancestors) => new LightInstance(o, ancestors));
    }
    // The volumes (participating media, see src/media.js) in this world, found and cached the same way as lights.
    get volumes() {
        if (typeof Volume === "undefined")   // src/media.js isn't loaded
            return [];
        return this.instancesOf(Volume, (o, ancestors) => new ObjectInstance(o, ancestors));
    }
    // Every object of a class reachable through this.objects, each as an instance made by make(object, ancestors).
    instancesOf(cls, make) {
        if (!this._instance_cache || this._instance_cache_source !== this.objects || this._instance_cache_count !== this.objects.length) {
            // Not enumerable, so the cache is never serialized.
            for (const [k, v] of [["_instance_cache", new Map()], ["_instance_cache_source", this.objects], ["_instance_cache_count", this.objects.length]])
                Object.defineProperty(this, k, { value: v, writable: true, enumerable: false, configurable: true });
        }
        if (!this._instance_cache.has(cls)) {
            const instances = [];
            const visit = (o, ancestors) => {
                if (o instanceof cls)
                    instances.push(make(o, ancestors));
                else if (o instanceof TransformedWorldObject)
                    visit(o.object, ancestors.concat(o));
                else if (o instanceof Aggregate && !(o instanceof BVHAggregate))
                    for (const child of o.objects)
                        visit(child, ancestors.concat(o));
            };
            for (const o of this.objects)
                visit(o, []);
            this._instance_cache.set(cls, instances);
        }
        return this._instance_cache.get(cls);
    }
    contentsChanged() {
        Object.defineProperty(this, "_instance_cache", { value: null, writable: true, enumerable: false, configurable: true });
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
    // The nearest hit along a world-space ray. Directional lights with a shape are tested here, apart from the object
    // hierarchy, because they sit relative to the ray's origin (see DirectionalLight); like other lights, they
    // never block shadow rays.
    cast(ray, minDistance = 0, maxDistance = Infinity, intersectTransparent=true) {
        let closest = World.getMinimumIntersection(this.objects, ray, minDistance, maxDistance, intersectTransparent);
        if (intersectTransparent) {
            for (const instance of this.lights) {
                if (!(instance.light instanceof DirectionalLight))
                    continue;
                const distance = instance.light.intersectObserved(ray, instance.getInvTransform(), minDistance,
                    Math.min(maxDistance, closest.distance));
                if (distance > minDistance && distance < closest.distance && distance < maxDistance)
                    closest = { distance: distance, object: instance.light, ancestors: instance.ancestors.slice() };
            }
        }
        return closest;
    }
    // Whitted-style color along a ray. Kept for convenience; renderers use an Integrator (see src/integrators.js).
    color(ray, recursionDepth, minDistance = 0) {
        return new WhittedIntegrator(this).radiance(ray, recursionDepth, minDistance);
    }
    // Whether any material reachable from this world's objects satisfies pred.
    anyMaterial(pred) {
        const seen = new Set();
        const visit = o => {
            if (!o || seen.has(o)) return false;
            seen.add(o);
            if (o instanceof Primitive) return !!(o.material && pred(o.material));
            if (o instanceof TransformedWorldObject) return visit(o.object);
            if (o instanceof Aggregate) return o.objects.some(visit);
            return false;
        };
        return this.objects.some(visit);
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
    // The child's intersection, with this object added as its outermost ancestor (as Aggregate does), so the hit
    // keeps the object that was actually hit and the whole chain of transforms above it.
    intersect(ray, minDistance, maxDistance=Infinity, shadowCast=true) {
        const ret = this.object.intersect(ray.getTransformed(this.getInvTransform()), minDistance, maxDistance, shadowCast);
        ret.ancestors.unshift(this);
        return ret;
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
    // Everything a material needs about a hit: the ray, the world-space position and normal, and the geometry's
    // own data (UV, vertex colors, ...).
    surfaceData(ray, distance, ancestorInvTransform) {
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
        return material_data;
    }
    buildBoundingBox() {
        return this.geometry.getBoundingBox(this.getTransform(), this.getInvTransform());
    }
}

// One reachable occurrence of an object in a world: the object plus the chain of ancestors (outermost first) it sits
// inside, which together give its world transform. An object referenced from several aggregates gets one instance per
// path. World.lights and World.volumes return these (LightInstance adds light sampling).
class ObjectInstance {
    constructor(object, ancestors=[]) {
        this.object = object;
        this.ancestors = ancestors;
    }
    getAncestorTransform() {
        let T = Mat4.identity();
        for (const a of this.ancestors)
            T = T.times(a.getTransform());
        return T;
    }
    getAncestorInvTransform() {
        let T = Mat4.identity();
        for (const a of this.ancestors)
            T = a.getInvTransform().times(T);
        return T;
    }
    getTransform() {
        return this.ancestors.length ? this.getAncestorTransform().times(this.object.getTransform()) : this.object.getTransform();
    }
    getInvTransform() {
        return this.ancestors.length ? this.object.getInvTransform().times(this.getAncestorInvTransform()) : this.object.getInvTransform();
    }
}
