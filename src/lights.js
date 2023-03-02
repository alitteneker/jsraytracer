// Superclass for all light classes.
// Light.sample returns a direction and a color corresponding to a path the light would take from
// the the given position to this light source, and the color it would have. See 
// SimplePointLight below for an example.
class Light {
    sampleIterator(position) {
        throw "Light subclass has not implemented sampleIterator";
    }
    getBoundingBox() {
        throw "Light subclass has not implemented getBoundingBox";
    }
    setTransform(new_transform, new_inv_transform) {
        throw "Light subclass has not implemented setTransform";
    }
    static falloff(delta) {
        return 1 / (4 * Math.PI * delta.squarednorm());
    }
}

// Simple point light source, with a single position and uniform color
class SimplePointLight extends Light {
    constructor(position, color_mc, intensity=1) {
        super();
        this.position = position;
        this.color_mc = MaterialColor.coerce(color_mc, intensity);
    }
    getBoundingBox(size=5) {
        return new AABB(this.position, Vec.of(size, size, size));
    }
    setTransform(new_transform, new_inv_transform) {
        this.position = new_transform.column(3);
    }
    *sampleIterator(surface_position) {
        const delta = this.position.minus(surface_position)
        yield {
            direction: delta,
            color: this.color_mc.color({
                UV: Vec.cartesianToSpherical(delta.normalized())
            }).times(Light.falloff(delta))
        };
    }
}

class RandomSampleAreaLight extends Light {
    constructor(surface_geometry, transform, color_mc, intensity=1, samples=1) {
        super();
        this.surface_geometry = surface_geometry;
        this.transform = transform;
        this.inv_transform = Mat4.inverse(transform);
        this.color_mc = MaterialColor.coerce(color_mc, intensity);
        this.samples = samples;
        this.aabb = this.surface_geometry.getBoundingBox(transform, Mat4.inverse(transform));
    }
    getBoundingBox() {
        return this.aabb;
    }
    setTransform(new_transform, new_inv_transform=Mat4.inverse(new_transform)) {
        this.transform = new_transform;
        this.inv_transform = new_inv_transform;
        this.aabb = this.surface_geometry.getBoundingBox(transform, Mat4.inverse(transform));
    }
    *sampleIterator(surface_position) {
        for (let i = 0; i < this.samples; ++i) {
            const local_pos = this.surface_geometry.sampleSurface();
            const world_pos = this.transform.times(local_pos);
            
            const delta = world_pos.minus(surface_position);
            const material_data = this.surface_geometry.materialData({ position: local_pos }, this.inv_transform.times(delta));
            yield {
                direction: delta,
                color: this.color_mc.color(material_data).times(Light.falloff(delta)
                    * Math.abs(delta.normalized().dot(this.inv_transform.transposed().times(material_data.normal).to4(0).normalized())))
            };
        }
    }
}