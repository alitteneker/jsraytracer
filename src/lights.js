// Superclass for all light classes.
// Light.sample returns a direction and a color corresponding to a path the light would take from
// the the given position to this light source, and the color it would have. See 
// SimplePointLight below for an example.
class Light {
    sample(position) {
        throw "Light subclass has not implemented sample";
    }
}

// Simple point light source, with a single position and uniform color
class SimplePointLight extends Light {
    constructor(position, color) {
        super();
        this.position = position;
        this.color = color;
    }
    sample(sample_position) {
        return {
            direction: this.position.minus(sample_position),
            color: this.color
        };
    }
}