class Material {
    color(data, scene, recursionDepth) {
        throw "Material subclass has not implemented color";
    }
}

// no lighting, no shadows, no reflections, just a solid color
class SolidColorMaterial extends Material {
    constructor(color) {
        super();
        this._color = color;
    }
    color(data, scene, recursionDepth) {
        return this._color;
    }
}

// no lighting, no shadows, no reflections, just a solid color
class TransparentMaterial extends Material {
    constructor(color, opacity) {
        super();
        this._color = color;
        this._opacity = opacity;
    }
    color(data, scene, recursionDepth) {
        return this._color.times(this._opacity).plus(
            scene.color(new Ray(data.position, data.ray.direction),
                recursionDepth, 0.0001).times(1-this._opacity));
    }
}

class PhongMaterial extends Material {
    constructor(baseColor, ambient=1, diffusivity=0, specularity=0, smoothness=5, reflectivity=0) {
        super();
        this.white = Vec.of(1, 1, 1);
        this.baseColor = baseColor;
        this.ambient = ambient;
        this.diffusivity = diffusivity;
        this.specularity = specularity;
        this.smoothness = smoothness;
        this.reflectivity = reflectivity;
    }
    color(data, scene, recursionDepth) {

        // ambient component
        let surfaceColor = this.baseColor.times(this.ambient);
        const N = data.normal.normalized();
        const V = data.ray.direction.normalized().times(-1);
        const R = N.times(2 * N.dot(V)).minus(V).normalized();
        
        // TODO: It would be cool if we could refactor this so that this same material could
        // support a variety of complex light types (eg. spotlight, area, etc.) generically.
        // Can we design that in a way that allows for scalable levels of sampling?
        for (let l of scene.lights) {
            let light_sample = l.sample(data.position);

            // test whether this light source is shadowed
            const shadowDist = scene.cast(new Ray(data.position, light_sample.direction), 0.0001, 1).distance;
            if (shadowDist < 1)
                continue;
            
            // diffuse & specular: TODO
            const L = light_sample.direction.normalized();
            // const H = L.minus(data.ray.direction.normalized()).normalized();
            
            const diffuse  =          Math.max(L.dot(N), 0);
            const specular = Math.pow(Math.max(L.dot(R), 0), this.smoothness);

            surfaceColor = surfaceColor
                .plus(light_sample.color.mult_pairs(this.baseColor.times(   this.diffusivity * diffuse)))
                .plus(light_sample.color.times(                             this.specularity * specular));
        }

        // reflection
        let reflectedColor = Vec.of(0, 0, 0);
        if (this.reflectivity != 0 && N.dot(data.ray.direction) < 0)
            reflectedColor = scene.color(
                new Ray(data.position, R),
                recursionDepth, 0.0001);

        // TODO: refraction, we would have to pack current refractive index the ray data
        // const r = n1/n2, c = -N.dot(data.ray.direction);
        // const refractedColor = scene.color(
        //     ray.direction.times(r).plus(N.times(r * c - Math.sqrt(1 - r * r * ( 1 - c * c )))),
        //     recursionDepth
        // );
        
        return surfaceColor.plus(
            reflectedColor.times(this.reflectivity)
//          .plus(refractedColor.times(this.refractivity))
        );
    }
}