// MaterialColor is for specifying a simple color, either solid, textured, or whatever.
class MaterialColor {
    static coerce(baseColor, mc) {
        if (baseColor !== undefined && mc === undefined) {
            mc = baseColor;
            baseColor = null;
        }
        if (mc instanceof MaterialColor)
            return mc;
        if (mc instanceof Vec)
            return new SolidMaterialColor(mc);
        if (typeof mc === "number")
            return new ScaledMaterialColor(MaterialColor.coerce(baseColor), mc);
        throw "Type provided that cannot be coerced to MaterialColor";
    }
    color(data) {
        throw 'MaterialColor subclass has not implemented color';
    }
}
class SolidMaterialColor extends MaterialColor {
    constructor(color) {
        super();
        this._color = color;
    }
    color(data) {
        return this._color;
    }
}
class ScaledMaterialColor extends MaterialColor {
    constructor(mc, scale) {
        super();
        this._mc = MaterialColor.coerce(mc);
        this._scale = scale;
    }
    color(data) {
        return this._mc.color(data).times(this._scale);
    }
}

class CheckerboardMaterialColor extends MaterialColor {
    constructor(color1, color2) {
        super();
        this.color1 = MaterialColor.coerce(color1);
        this.color2 = MaterialColor.coerce(color2);
    }
    color(data) {
        return (Math.fmod(Math.floor(data.UV[0]) + Math.floor(data.UV[1]), 2) % 2 < 1)
            ? this.color1.color(data) : this.color2.color(data);
    }
}

// Materials color an object, and can take as parameters MaterialColors
class Material {
    color(data, scene, recursionDepth) {
        throw "Material subclass has not implemented color";
    }
}

// no lighting, no shadows, no reflections, just a solid color
class SolidColorMaterial extends Material {
    constructor(color) {
        super();
        this._color = MaterialColor.coerce(color);
    }
    color(data, scene, recursionDepth) {
        return this._color.color(data);
    }
}

// transparent material, will still cast a shadow unless the 
class TransparentMaterial extends Material {
    constructor(color, opacity) {
        super();
        this._color = MaterialColor.coerce(color);
        this._opacity = opacity;
    }
    color(data, scene, recursionDepth) {
        return this._color.color(data).times(this._opacity).plus(
            scene.color(new Ray(data.position, data.ray.direction),
                recursionDepth, 0.0001).times(1-this._opacity));
    }
}

// Material modifier that sets UV coordinates in the data based on position
class PositionalUVMaterial extends Material {
    constructor(baseMaterial, origin=Vec.of(0,0,0), u_axis=Vec.of(1,0,0), v_axis=Vec.of(0,0,1)) {
        super();
        this.baseMaterial = baseMaterial;
        this.origin = origin;
        this.u_axis = u_axis;
        this.v_axis = v_axis;
    }
    color(data, scene, recursionDepth) {
        const delta = this.origin.minus(data.position);
        data.UV = Vec.of(this.u_axis.dot(delta), this.v_axis.dot(delta));
        return this.baseMaterial.color(data, scene, recursionDepth);
    }
}

class PhongMaterial extends Material {
    constructor(baseColor, ambient=1, diffusivity=0, specularity=0, smoothness=5, reflectivity=0) {
        super();
        this.baseColor    = MaterialColor.coerce(baseColor);
        this.ambient      = MaterialColor.coerce(this.baseColor, ambient);
        this.diffusivity  = MaterialColor.coerce(this.baseColor, diffusivity);
        this.specularity  = MaterialColor.coerce(Vec.of(1,1,1), specularity);
        this.reflectivity = MaterialColor.coerce(Vec.of(1,1,1), reflectivity);
        this.smoothness   = smoothness;
    }

    getBaseFactors(data) {
        const V = data.ray.direction.normalized().times(-1);

        let N = data.normal.normalized(), backside = false, vdotn = V.dot(N);
        if (vdotn < 0) {
            N = N.times(-1);
            backside = true;
            vdotn = -vdotn;
        }
        
        const R = N.times(2 * N.dot(V)).minus(V).normalized();

        Object.assign(data, {
            V: V,
            N: N,
            R: R,
            backside: backside,
            vdotn: vdotn
        });
    }

    colorFromLights(data, scene) {
        let ret = this.ambient.color(data);

        // get diffuse and specular values from material colors so that we're not asking multiple times
        data.specularity = this.specularity.color(data);
        data.diffusivity = this.diffusivity.color(data);
        
        // compute contribution from each light in the scene on this fragment
        for (let l of scene.lights) {
            let light_sample_count = 0,
                light_color = Vec.of(0,0,0);
            for (const light_sample of l.sampleIterator(data.position)) {
                ++light_sample_count;
                // test whether this light sample is shadowed
                const shadowDist = scene.cast(new Ray(data.position, light_sample.direction), 0.0001, 1, false).distance;
                if (shadowDist < 1)
                    continue;
                light_color = light_color.plus(this.colorFromLightSample(light_sample, data, scene));
            }
            if (light_sample_count > 0)
                ret = ret.plus(light_color.times(1/light_sample_count));
        }
        return ret;
    }

    colorFromLightSample(light_sample, data, scene) {
        const L = light_sample.direction.normalized();

        const diffuse  =          Math.max(L.dot(data.N), 0);
        const specular = Math.pow(Math.max(L.dot(data.R), 0), this.smoothness);

        return    light_sample.color.mult_pairs(data.diffusivity.times(diffuse ))
            .plus(light_sample.color.mult_pairs(data.specularity.times(specular)));
    }

    color(data, scene, recursionDepth) {
        this.getBaseFactors(data);

        let surfaceColor = this.colorFromLights(data, scene);

        // reflection
        const reflectivity = this.reflectivity.color(data);
        if (reflectivity.squarednorm() > 0) {
            surfaceColor = surfaceColor.plus(
                scene.color(new Ray(data.position, data.R), recursionDepth, 0.0001).mult_pairs(reflectivity));
        }
        
        return surfaceColor;
    }
}

class FresnelPhongMaterial extends PhongMaterial {
    constructor(baseColor, ambient=1, diffusivity=0, specularity=0, smoothness=0, refractiveIndexRatio=1) {
        super(baseColor, ambient, diffusivity, specularity, smoothness);
        this.refractiveIndexRatio = refractiveIndexRatio;
    }
    getBaseFactors(data) {
        super.getBaseFactors(data);
        Object.assign(data, {
            kr : this.getReflectionValue(data),
            refracionDirection : this.getRefractionDirection(data)
        });
    }
    color(data, scene, recursionDepth) {
        this.getBaseFactors(data);

        const baseColor = this.baseColor.color(data);

        let surfaceColor = this.colorFromLights(data, scene);
        
        // reflection
        if (data.kr > 0) {
            surfaceColor = surfaceColor.plus(
                scene.color(new Ray(data.position, data.R), recursionDepth, 0.0001)
                .mult_pairs(baseColor).times(data.kr));
        }

        // refraction
        if (data.kr < 1) {
            surfaceColor = surfaceColor.plus(
                scene.color(new Ray(data.position, data.refracionDirection), recursionDepth, 0.0001)
                .mult_pairs(baseColor).times(1 - data.kr));
        }
        
        return surfaceColor;
    }

    // override this to correspond to the way that light passes through fresnel materials
    colorFromLightSample(light_sample, data, scene) {
        const L = light_sample.direction.normalized(),
            ldotn = L.dot(data.N);

        let diffuse = 0, specular = 0;
        if (data.kr > 0 && ldotn >= 0) {
            diffuse  += data.kr * ldotn;
            specular += data.kr * Math.pow(Math.max(L.dot(data.R), 0), this.smoothness);
        }
        if (data.kr < 1 && ldotn <= 0) {
            diffuse  += (1 - data.kr) * -ldotn;
            specular += (1 - data.kr) * Math.pow(Math.max(L.dot(data.refracionDirection), 0), this.smoothness);
        }

        return    light_sample.color.mult_pairs(data.diffusivity.times(diffuse ))
            .plus(light_sample.color.mult_pairs(data.specularity.times(specular)));
    }

    getRefractionDirection(data) {
        const r = data.backside ? this.refractiveIndexRatio : 1 / this.refractiveIndexRatio,
            k = 1 - r * r * ( 1 - data.vdotn * data.vdotn );
        if (k < 0)
            return null;
        return data.V.times(-1).times(r).plus(data.N.times(r * data.vdotn - Math.sqrt(k)));
    }

    getReflectionValue(data) {
        // If the refractiveIndexRatio is Infinite, don't even bother.
        if (!isFinite(this.refractiveIndexRatio))
            return 1;

        // The magic of Snell's law
        const ni = data.backside ? this.refractiveIndexRatio : 1, nt = data.backside ? 1 : this.refractiveIndexRatio;
        const cosi = data.vdotn,
            sint = ni / nt * Math.sqrt(Math.max(0, 1 - cosi * cosi));

        // Total internal reflection
        if (sint >= 1)
            return 1;
        else {
            const cost = Math.sqrt(Math.max(0, 1 - sint * sint));
            const Rs = ((nt * cosi) - (ni * cost)) / ((nt * cosi) + (ni * cost));
            const Rp = ((ni * cosi) - (nt * cost)) / ((ni * cosi) + (nt * cost));
            return (Rs * Rs + Rp * Rp) / 2;
        }
    }
}

class PhongPathTracingMaterial extends FresnelPhongMaterial {
    constructor(baseColor, ambient=1, diffusivity=0, specularity=0, smoothness=0, refractiveIndexRatio=Infinity, pathSmoothness=smoothness, bounceProbability=0.3) {
        super(baseColor, ambient, diffusivity, specularity, smoothness, refractiveIndexRatio);
        this.pathSmoothness = pathSmoothness;
        this.bounceProbability = bounceProbability;
    }
    color(data, scene, recursionDepth) {
        this.getBaseFactors(data);

        let surfaceColor = this.colorFromLights(data, scene);

        // This is path tracing, so instead of reflecting or refracting, we sample the Phong PDF!
        if (Math.random() <= this.bounceProbability)
            surfaceColor = surfaceColor.plus(this.baseColor.color(data).mult_pairs(
                scene.color(new Ray(data.position, this.samplePathDirection(data)), recursionDepth, 0.0001)));
        
        return surfaceColor;
    }

    samplePathDirection(data) {
        const EPSILON = 0.00001;

        let V = data.V, R = data.R;

        // Allow some probability of doing a refraction ray, if the index of refraction allows it
        if (Math.random() > this.getReflectionValue(data)) {
            V = V.minus(data.N.times(2 * data.vdotn));
            R = this.getRefractionDirection(data);
        }

        let space_transform = Mat4.identity();
        if(1.0 - data.vdotn > EPSILON) {
            const i = V.cross(R).normalized().to4(),
                j = R,
                k = R.cross(i).to4();
            space_transform.set_col(0, i);
            space_transform.set_col(1, j);
            space_transform.set_col(2, k);
        }

        // spherical coordinates following the pdf for Phong
        const phi = Math.acos(Math.pow(Math.random(), 1.0 / (this.pathSmoothness + 1))),
            theta = 2 * Math.PI * Math.random();

        // convert spherical to local cartesian, then to world space
        const sin_phi = Math.sin(phi);
        return space_transform.times(Vec.of(
            Math.cos(theta) * sin_phi,
            Math.cos(phi),
            Math.sin(theta) * sin_phi, 0));
    }
}