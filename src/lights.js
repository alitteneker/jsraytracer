// Superclass for all light classes.
// Lights are WorldObjects: they live in World.objects alongside everything else, carry a transform, and can be hit
// by rays. Light.sampleIterator returns a direction and a color corresponding to a path the light would take from
// the given position to this light source, and the color it would have. See SimplePointLight below for an example.
//
// Two rules keep a directly visible light consistent with explicit light sampling (every shaded surface already
// samples each light directly):
//   - Lights never occlude shadow rays. intersect() reports no hit when intersectTransparent is false, which is how
//     World.cast is called for shadow tests.
//   - A light's own emission is only returned (see color()) when countEmission is true: for camera rays, and for
//     rays that left a surface in a single exact direction (mirror reflection, refraction). A ray randomly sampled
//     from a diffuse or glossy lobe passes countEmission = false: direct light sampling at the surface it left has
//     already accounted for this light, so counting the hit as well would add the light twice.
// A light can sit inside an Aggregate (or TransformedWorldObject), in which case its transform is relative to its
// ancestors, like any other object. World.lights returns a LightInstance per reachable light, which carries those
// ancestors and samples the light with its full world-space transform. Lights can't be placed inside a BVHAggregate.
class Light extends WorldObject {
    constructor(transform=Mat4.identity(), inv_transform=Mat4.inverse(transform)) {
        super(transform, inv_transform);
    }
    // Samples are taken in world space, using the given world transform (this light's own transform when the light
    // is at the top level, or composed with its ancestors' when it is nested; see LightInstance).
    sampleIterator(position, transform=this.transform, inv_transform=this.inv_transform) {
        throw "Light subclass has not implemented sampleIterator";
    }
    // Default: a light with no surface (such as a point light) can never be hit.
    intersect(ray, minDistance, maxDistance=Infinity, intersectTransparent=true) {
        return { distance: Infinity, ancestors: [], object: this };
    }
    // Radiance seen along a ray that hits this light directly. Black by default.
    color(ray, distance, ancestorInvTransform, world, recursionDepth, countEmission=true) {
        return Vec.of(0, 0, 0);
    }
    buildBoundingBox() {
        throw "Light subclass has not implemented buildBoundingBox";
    }
    // A point light emitting power Phi equally in every direction has intensity Phi / (4 pi) per steradian, so the
    // irradiance it delivers to a surface facing it at distance d is Phi / (4 pi d^2).
    static falloff(delta) {
        return 1 / (4 * Math.PI * delta.squarednorm());
    }
}

// Simple point light source, with a single position and uniform color. A point has no area, so it can't be hit
// directly. Its position is the translation part of its transform.
class SimplePointLight extends Light {
    constructor(position, color_mc, intensity=1) {
        super(Mat4.translation(position), Mat4.translation([-position[0], -position[1], -position[2]]));
        this.color_mc = MaterialColor.coerce(color_mc, intensity);
    }
    // Handles both the current form (transform) and scenes serialized before lights were WorldObjects (position).
    static deserialize(data) {
        return new SimplePointLight(data.position || data.transform.column(3), data.color_mc);
    }
    get position() {
        return this.transform.column(3);
    }
    buildBoundingBox() {
        return new AABB(this.position, Vec.of(0, 0, 0, 0));
    }
    *sampleIterator(surface_position, transform=this.transform, inv_transform=this.inv_transform) {
        const delta = transform.column(3).minus(surface_position)
        yield {
            direction: delta,
            color: this.color_mc.color({
                UV: Vec.cartesianToSpherical(delta.normalized())
            }).times(Light.falloff(delta))
        };
    }
    // For the path integrator (see sampleLi on RandomSampleAreaLight). A point light is a delta light: there is
    // exactly one direction to it, so it has no pdf and no MIS.
    *sampleLi(surface_position, transform=this.transform, inv_transform=this.inv_transform) {
        for (const s of this.sampleIterator(surface_position, transform, inv_transform))
            yield { direction: s.direction, value: s.color, delta: true, count: 1 };
    }
}

class RandomSampleAreaLight extends Light {
    constructor(surface_geometry, transform, color_mc, intensity=1, samples=1) {
        super(transform, Mat4.inverse(transform));
        this.surface_geometry = surface_geometry;
        this.color_mc = MaterialColor.coerce(color_mc, intensity);
        this.samples = samples;
    }
    static deserialize(data) {
        return new RandomSampleAreaLight(data.surface_geometry, data.transform, data.color_mc, 1, data.samples);
    }
    buildBoundingBox() {
        return this.surface_geometry.getBoundingBox(this.transform, this.inv_transform);
    }
    contentsChanged() {
        super.contentsChanged();
        // Cached world-space area for the top-level case; not enumerable, so it isn't serialized.
        Object.defineProperty(this, "_area", { value: undefined, writable: true, enumerable: false, configurable: true });
    }

    // Light units. A light's color * intensity is the total power it emits, Phi. An area light emits from both sides
    // of its surface, uniformly over its area A and equally in every direction (a Lambertian emitter), which makes its
    // radiance Le = Phi / (2 pi A): integrating Le |cos| over each side's hemisphere gives pi Le per unit area per side.
    // `transform` is the light's world transform (its own unless it is nested inside transformed ancestors).
    surfaceArea(transform=this.transform) {
        if (transform !== this.transform)
            return RandomSampleAreaLight.computeSurfaceArea(this.surface_geometry, transform);
        if (this._area === undefined)
            Object.defineProperty(this, "_area", { value: RandomSampleAreaLight.computeSurfaceArea(this.surface_geometry, this.transform),
                writable: true, enumerable: false, configurable: true });
        return this._area;
    }
    emittedRadianceScale(transform=this.transform) {
        return 1 / (2 * Math.PI * this.surfaceArea(transform));
    }
    static computeSurfaceArea(geometry, transform) {
        const ax = transform.times(Vec.of(1, 0, 0, 0)).to3(),
              ay = transform.times(Vec.of(0, 1, 0, 0)).to3(),
              az = transform.times(Vec.of(0, 0, 1, 0)).to3();
        // Planar shapes lie in the local z = 0 plane, so their area scales by |T x * T y|.
        if (geometry instanceof Square)
            return ax.cross(ay).norm();
        if (geometry instanceof Circle)
            return Math.PI * ax.cross(ay).norm();
        // A transformed unit sphere is an ellipsoid. Knud Thomsen's approximation (within about 1%), using the
        // transformed axis lengths as semi-axes (exact for uniform and axis-aligned scales).
        if (geometry instanceof Sphere) {
            const p = 1.6075, a = ax.norm(), b = ay.norm(), c = az.norm();
            return 4 * Math.PI * Math.pow((Math.pow(a*b, p) + Math.pow(a*c, p) + Math.pow(b*c, p)) / 3, 1 / p);
        }
        // Unknown shape: assume unit area, so the light stays visible but its brightness is only approximate.
        return 1;
    }

    intersect(ray, minDistance, maxDistance=Infinity, intersectTransparent=true) {
        if (!intersectTransparent)
            return { distance: Infinity, ancestors: [], object: this };
        return {
            distance: this.surface_geometry.intersect(ray.getTransformed(this.getInvTransform()), minDistance, maxDistance),
            ancestors: [],
            object: this
        };
    }
    color(ray, distance, ancestorInvTransform, world, recursionDepth, countEmission=true) {
        if (!countEmission)
            return Vec.of(0, 0, 0);
        const inv_transform = this.getInvTransform().times(ancestorInvTransform);
        const material_data = this.surface_geometry.materialData(
            { ray: ray, distance: distance, position: ray.getTransformed(inv_transform).getPoint(distance) }, ray.direction);
        // A nested light's visible area depends on its ancestors' transforms too.
        const world_transform = ancestorInvTransform.is_identity()
            ? this.transform : Mat4.inverse(ancestorInvTransform).times(this.transform);
        return this.color_mc.color(material_data).times(this.emittedRadianceScale(world_transform));
    }

    // For the path integrator: samples of the light as seen from surface_position, each with
    //   direction: the (unnormalized) vector to the sampled point, which is also the shadow ray,
    //   value:     the radiance arriving along it divided by its pdf (what sampleIterator calls color),
    //   pdf:       the density of choosing that direction, per unit solid angle, so MIS can compare it with the
    //              BSDF's density for the same direction,
    //   count:     how many samples are taken of this light per shading point.
    // Points are picked uniformly over the surface (density 1 / A per unit area). Converting to solid angle divides
    // by the projected solid angle each bit of area covers: pdf = d^2 / (A |cos theta_light|).
    *sampleLi(surface_position, transform=this.transform, inv_transform=this.inv_transform) {
        const area = this.surfaceArea(transform);
        for (const s of this.sampleIterator(surface_position, transform, inv_transform, true)) {
            const d2 = s.direction.squarednorm();
            s.pdf = s.cosLight > 0 ? d2 / (area * s.cosLight) : Infinity;
            yield { direction: s.direction, value: s.color, pdf: s.pdf, delta: false, count: this.samples };
        }
    }
    // For the path integrator: the radiance seen along a ray that hit this light, and the solid angle density with
    // which sampleLi would have picked that point from the ray's origin (for MIS).
    emissionAt(ray, distance, ancestorInvTransform) {
        const world_transform = ancestorInvTransform.is_identity()
            ? this.transform : Mat4.inverse(ancestorInvTransform).times(this.transform);
        const inv_transform = this.getInvTransform().times(ancestorInvTransform);
        const local_ray = ray.getTransformed(inv_transform);
        const material_data = this.surface_geometry.materialData(
            { ray: ray, distance: distance, position: local_ray.getPoint(distance) }, ray.direction);
        const area = this.surfaceArea(world_transform), radianceScale = 1 / (2 * Math.PI * area);
        const n = inv_transform.transposed().times(material_data.normal).to4(0).normalized();
        const dirLength = ray.direction.norm(), cosLight = Math.abs(n.dot(ray.direction)) / dirLength;
        const d = distance * dirLength;
        const Le = this.color_mc.color(material_data).times(radianceScale);
        return { Le: [Le[0], Le[1], Le[2]], pdf: cosLight > 0 ? d * d / (area * cosLight) : Infinity, count: this.samples };
    }

    *sampleIterator(surface_position, transform=this.transform, inv_transform=this.inv_transform, withCos=false) {
        for (let i = 0; i < this.samples; ++i) {
            const local_pos = this.surface_geometry.sampleSurface();
            const world_pos = transform.times(local_pos);

            const delta = world_pos.minus(surface_position);
            const material_data = this.surface_geometry.materialData({ position: local_pos }, inv_transform.times(delta));
            const cosLight = Math.abs(delta.normalized().dot(inv_transform.transposed().times(material_data.normal).to4(0).normalized()));
            // A point picked uniformly (density 1 / A) carries Le |cos_light| / d^2 per unit area, so its estimate of
            // the radiance arriving, divided by the pdf, is Le A |cos_light| / d^2 = Phi |cos_light| / (2 pi d^2).
            const sample = {
                direction: delta,
                color: this.color_mc.color(material_data).times(cosLight / (2 * Math.PI * delta.squarednorm()))
            };
            if (withCos)
                sample.cosLight = cosLight;
            yield sample;
        }
    }
}

// One reachable occurrence of a light in a world: the light plus the chain of ancestors (outermost first) it sits
// inside. A light referenced from several aggregates gets one instance per path. World.lights returns these.
class LightInstance {
    constructor(light, ancestors=[]) {
        this.light = light;
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
        return this.ancestors.length ? this.getAncestorTransform().times(this.light.getTransform()) : this.light.getTransform();
    }
    getInvTransform() {
        return this.ancestors.length ? this.light.getInvTransform().times(this.getAncestorInvTransform()) : this.light.getInvTransform();
    }
    sampleIterator(surface_position) {
        return this.ancestors.length
            ? this.light.sampleIterator(surface_position, this.getTransform(), this.getInvTransform())
            : this.light.sampleIterator(surface_position);
    }
    sampleLi(surface_position) {
        return this.ancestors.length
            ? this.light.sampleLi(surface_position, this.getTransform(), this.getInvTransform())
            : this.light.sampleLi(surface_position);
    }
    // Sets the light's own (local) transform so that its world transform becomes the one given.
    setWorldTransform(transform, inv_transform=Mat4.inverse(transform)) {
        if (!this.ancestors.length)
            return this.light.setTransform(transform, inv_transform);
        this.light.setTransform(this.getAncestorInvTransform().times(transform), inv_transform.times(this.getAncestorTransform()));
    }
}
