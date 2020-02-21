// Superclass for all light classes.
// Light.sample returns a direction and a color corresponding to a path the light would take from
// the the given position to this light source, and the color it would have. See 
// SimplePointLight below for an example.
class Light {
    sampleIterator(position) {
        throw "Light subclass has not implemented sampleIterator";
    }
    static falloff(delta) {
        return 1 / (4 * Math.PI * delta.squarednorm());
    }
}

// Simple point light source, with a single position and uniform color
class SimplePointLight extends Light {
    constructor(position, color, intensity=1) {
        super();
        this.position = position;
        this.color = color;
        this.intensity = intensity;
    }
    *sampleIterator(sample_position) {
        const delta = this.position.minus(sample_position)
        yield {
            direction: delta,
            color: this.color.times(this.intensity * Light.falloff(delta))
        };
    }
}

class LightArea {
    sample() {
        throw "LightArea subclass has not implemented sample";
    }
}
class SquareLightArea extends LightArea {
    constructor(transform) {
        super();
        this.transform = transform;
    }
    sample() {
        return this.transform.times(Vec.of(
            2 * (Math.random() - 0.5),
            2 * (Math.random() - 0.5),
            0, 1));
    }
}
class RandomSampleAreaLight extends Light {
    constructor(area, color, intensity=1, samples=1) {
        super();
        this.area = area;
        this.color = color;
        this.samples = samples;
        this.intensity = intensity;
    }
    *sampleIterator(sample_position) {
        for (let i = 0; i < this.samples; ++i) {
            const delta = this.area.sample().minus(sample_position);
            yield {
                direction: delta,
                color: this.color.times(this.intensity * Light.falloff(delta))
            };
        }
    }
}