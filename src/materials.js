// MaterialColor is for specifying a simple color, either solid, textured, or whatever.
class MaterialColor {
    static _MATERIALCOLOR_UID_GEN = 0;
    static coerce(baseColor, mc) {
        if (baseColor !== undefined && mc === undefined) {
            mc = baseColor;
            baseColor = null;
        }
        if (mc instanceof MaterialColor)
            return mc;
        if (mc instanceof Vec)
            return new SolidMaterialColor(mc);
        if (typeof mc === "number" || mc instanceof Array)
            return new ScaledMaterialColor(MaterialColor.coerce(baseColor), mc);
        throw "Type provided that cannot be coerced to MaterialColor";
    }
    constructor() {
        Object.defineProperty(this, "MATERIALCOLOR_UID", { value: MaterialColor._MATERIALCOLOR_UID_GEN++, enumerable: false, configurable: false, writable: false });
    }
    color(data) {
        throw 'MaterialColor subclass has not implemented color';
    }
    toSolidColor() {
        throw 'MaterialColor subclass has not implemented toSolidColor';
    }
}
class SolidMaterialColor extends MaterialColor {
    static White = new SolidMaterialColor(Vec.of(1,1,1));
    constructor(color) {
        super();
        this._color = color;
    }
    static deserialize(data) {
        return new SolidMaterialColor(data._color);
    }
    color(data) {
        return this._color;
    }
    toSolidColor() {
        return this;
    }
}
class ScaledMaterialColor extends MaterialColor {
    constructor(mc, scale) {
        super();
        this._mc = MaterialColor.coerce(mc);
        this._scale = scale;
    }
    static deserialize(data) {
        return new ScaledMaterialColor(data._mc, data._scale);
    }
    color(data) {
        return this._mc.color(data).times(this._scale);
    }
    toSolidColor() {
        const solid_mc = this._mc.toSolidColor();
        if (this._scale == 1 || (this._scale instanceof Array && this._scale.every(c => c == 1)))
            return solid_mc;
        return new SolidMaterialColor(solid_mc._color.times(this._scale));
    }
}

class CheckerboardMaterialColor extends MaterialColor {
    constructor(color1, color2) {
        super();
        this.color1 = MaterialColor.coerce(color1);
        this.color2 = MaterialColor.coerce(color2);
    }
    static deserialize(data) {
        return new CheckerboardMaterialColor(data.color1, data.color2);
    }
    color(data) {
        return (Math.fmod(Math.floor(data.UV[0]) + Math.floor(data.UV[1]), 2) % 2 < 1)
            ? this.color1.color(data) : this.color2.color(data);
    }
}
class TextureMaterialColor extends MaterialColor {
    constructor(imgdata, mode="bilinear", clampU=true, clampV=true) {
        super();
        this._imgdata = imgdata;
        this.width  = imgdata.width;
        this.height = imgdata.height;
        
        this.mode = mode;
        this.clampU = clampU;
        this.clampV = clampV;
    }
    static deserialize(data) {
        return new TextureMaterialColor(data.imgdata, data.mode, data.clampU, data.clampV);
    }
    static fromBitmap(bitmap) {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        return new TextureMaterialColor(context.getImageData(0, 0, bitmap.width, bitmap.height));
    }
    static normalizeUV(c, doClamp) {
        if (doClamp) return Math.clamp(c, 0, 1);
        else         return ((c % 1) + 1) % 1;
    }
    color(data) {
        let U = TextureMaterialColor.normalizeUV(data.UV[0], this.clampU);
        let V = TextureMaterialColor.normalizeUV(data.UV[1], this.clampV);
        
        const fx =        U  * this.width  - 0.5;
        const fy = (1.0 - V) * this.height - 0.5;
        
        const xs = [], ys = [];
        if (this.mode == "bilinear") {
            const mx = Math.floor(fx), my = Math.floor(fy);
            xs.push([mx, 1 - (fx % 1)], [mx + 1, fx % 1]);
            ys.push([my, 1 - (fy % 1)], [my + 1, fy % 1]);
        }
        else if (this.mode == "nearest") {
            xs.push([Math.round(fx), 1]);
            ys.push([Math.round(fy), 1]);
        }
        else
            throw "Unsupported texture mode " + this.mode;
        
        let ret = [0,0,0,0];
        for (let [px, bx] of xs) {
            for (let [py, by] of ys) {
                const index = Math.clamp(py, 0, this.height-1) * this.width + Math.clamp(px, 0, this.width-1);
                for (let i = 0; i < 4; ++i)
                    ret[i] += bx * by * (this._imgdata.data[index * 4 + i] / 255);
            }
        }
        return Vec.from(ret);
    }
}

// Materials describe a surface: what it emits and how it scatters light (its BSDF, see src/bsdf.js). They don't
// trace any rays themselves; that's the integrator's job (src/integrators.js). Materials can take MaterialColors as
// parameters.
const toRGB = v => [v[0], v[1], v[2]];

class Material {
    static MATERIAL_UID_GEN = 0;
    constructor() {
        Object.defineProperty(this, "MATERIAL_UID", { value: Material.MATERIAL_UID_GEN++, enumerable: false, configurable: false, writable: false });
    }
    // The surface at a hit: { emission: Vec or null, bsdf: BSDF or null (absorbs everything) }. data comes from
    // Primitive.surfaceData (ray, position, normal, UV, ...).
    surface(data) {
        throw "Material subclass has not implemented surface";
    }
    // Whether scenes using this material are meant to be path traced (see Integrator.create).
    get prefersPathTracing() {
        return false;
    }
}

// no lighting, no shadows, no reflections, one solid color across the entire geometry
class SolidColorMaterial extends Material {
    constructor(color) {
        super();
        this._color = MaterialColor.coerce(color);
    }
    static deserialize(data) {
        return new SolidColorMaterial(data._color);
    }
    surface(data) {
        return { emission: this._color.color(data), bsdf: null };
    }
}

// transparent material: 
// NB: this will still cast a shadow unless the containing Primitive has does_cast_shadow set to false
class TransparentMaterial extends Material {
    constructor(color, opacity) {
        super();
        this._color = MaterialColor.coerce(color);
        this._opacity = opacity;
    }
    static deserialize(data) {
        return new TransparentMaterial(data._color, data._opacity);
    }
    surface(data) {
        const t = 1 - this._opacity;
        return {
            emission: this._color.color(data).times(this._opacity),
            bsdf: new BSDF(data.normal).add(new PassThroughLobe(), [t, t, t])
        };
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
    static deserialize(data) {
        return new PositionalUVMaterial(data.baseMaterial, data.origin, data.u_axis, data.v_axis);
    }
    get prefersPathTracing() {
        return this.baseMaterial.prefersPathTracing;
    }
    surface(data) {
        const delta = this.origin.minus(data.position);
        data.UV = Vec.of(this.u_axis.dot(delta), this.v_axis.dot(delta));
        return this.baseMaterial.surface(data);
    }
}

// The original Phong material. Its ambient term is treated as emission. Its diffuse and specular terms become a
// Lambertian lobe and a normalized Phong lobe for path tracing, and its reflectivity and transmissivity become a
// mirror and a straight pass-through. In Whitted mode, direct light uses the original formula (whittedDirect).
class PhongMaterial extends Material {
    constructor(baseColor, ambient=1, diffusivity=0, specularity=0, smoothness=5, reflectivity=0, transmissivity=0) {
        super();
        this.baseColor      = MaterialColor.coerce(baseColor);
        this.ambient        = MaterialColor.coerce(this.baseColor, ambient);
        this.diffusivity    = MaterialColor.coerce(this.baseColor, diffusivity);
        this.specularity    = MaterialColor.coerce(SolidMaterialColor.White, specularity);
        this.reflectivity   = MaterialColor.coerce(SolidMaterialColor.White, reflectivity);
        this.transmissivity = MaterialColor.coerce(SolidMaterialColor.White, transmissivity);
        this.smoothness     = smoothness;
    }
    static deserialize(data) {
        return new PhongMaterial(data.baseColor, data.ambient, data.diffusivity, data.specularity, data.smoothness, data.reflectivity, data.transmissivity);
    }

    getBaseFactors(data) {
        const V = data.ray.direction.normalized().times(-1);

        let N = data.normal.normalized(), backside = false, vdotn = V.dot(N);
        if (vdotn < 0) {
            N = N.times(-1);
            backside = true;
            vdotn = -vdotn;
        }
        
        // R = normalize(N * (2 * dot(V, N)) - V)
        const R = N.times(2 * vdotn).minus(V).normalized();

        const basecolor = data.basecolor || Vec.of(1,1,1);
        Object.assign(data, {
            V: V,
            N: N,
            R: R,
            backside: backside,
            vdotn: vdotn,
            
            ambient:        basecolor.times(this.ambient.color(data)),
            diffusivity:    basecolor.times(this.diffusivity.color(data)),
            specularity:    this.specularity.color(data),
            reflectivity:   this.reflectivity.color(data),
            transmissivity: this.transmissivity.color(data),
            smoothness:     this.smoothness
        });
    }

    // Original Whitted-mode response to one light sample (light_sample.color is the light's irradiance-like color).
    colorFromLightSample(light_sample, data) {
        const L = light_sample.direction.normalized();

        const diffuse  =          Math.max(L.dot(data.N), 0);
        const specular = Math.pow(Math.max(L.dot(data.R), 0), this.smoothness);

        return    light_sample.color.mult_pairs(data.diffusivity.times(diffuse ))
            .plus(light_sample.color.mult_pairs(data.specularity.times(specular)));
    }

    // A BSDF whose frame faces the viewer (these materials are two-sided), with this material's legacy Whitted
    // shading attached.
    legacyBSDF(data) {
        const bsdf = new BSDF(data.N);
        bsdf.whittedDirect = light_sample => this.colorFromLightSample(light_sample, data);
        return bsdf;
    }
    // A Phong lobe for the given world-space axis on the given side, unless the lobe is a perfect mirror.
    static phongLobe(bsdf, axisW, smoothness, side) {
        return isFinite(smoothness) ? new PhongLobe(BSDFMath.normalize(bsdf.toLocal(axisW)), smoothness, side) : null;
    }

    surface(data) {
        this.getBaseFactors(data);
        const bsdf = this.legacyBSDF(data);
        bsdf.add(new LambertLobe(), toRGB(data.diffusivity));
        const phong = PhongMaterial.phongLobe(bsdf, data.R, this.smoothness, 1);
        if (phong)
            bsdf.add(phong, toRGB(data.specularity));
        bsdf.add(new MirrorLobe(), toRGB(data.reflectivity));
        bsdf.add(new PassThroughLobe(), toRGB(data.transmissivity));
        return { emission: data.ambient, bsdf: bsdf };
    }
}

// Phong with a Fresnel-weighted split between reflection and refraction, controlled by refractiveIndexRatio
// (Infinity for an opaque surface).
class FresnelPhongMaterial extends PhongMaterial {
    constructor(baseColor, ambient=1, diffusivity=0, specularity=0, smoothness=0, refractiveIndexRatio=1, reflectivity=1, transmissivity=1) {
        super(baseColor, ambient, diffusivity, specularity, smoothness, reflectivity, transmissivity);
        this.refractiveIndexRatio = refractiveIndexRatio;
    }
    static deserialize(data) {
        return new FresnelPhongMaterial(data.baseColor, data.ambient, data.diffusivity, data.specularity, data.smoothness, data.refractiveIndexRatio, data.reflectivity, data.transmissivity);
    }
    getBaseFactors(data) {
        super.getBaseFactors(data);
        Object.assign(data, {
            kr : this.fresnelReflectionFactor(data),
            refractionDirection : this.getRefractionDirection(data)
        });
    }
    // The ratio of indices on the viewer's side to the far side, as the dielectric lobes expect it.
    eta(data) {
        return data.backside ? this.refractiveIndexRatio : 1 / this.refractiveIndexRatio;
    }
    // The perfectly specular part: Fresnel-split mirror reflection and refraction, tinted.
    deltaLobe(data) {
        return isFinite(this.refractiveIndexRatio)
            ? new SmoothDielectricLobe(this.eta(data), toRGB(data.reflectivity), toRGB(data.transmissivity))
            : null;
    }
    // Diffuse and glossy lobes on both sides, split by kr (the legacy model also scatters around the refracted ray).
    addRoughLobes(bsdf, data, scale) {
        const kr = data.kr, s = c => toRGB(c).map(x => x * scale);
        bsdf.add(new LambertLobe(1), s(data.diffusivity.times(kr)));
        const phongR = PhongMaterial.phongLobe(bsdf, data.R, this.smoothness, 1);
        if (phongR)
            bsdf.add(phongR, s(data.specularity.times(kr)));
        if (kr < 1 && data.refractionDirection) {
            bsdf.add(new LambertLobe(-1), s(data.diffusivity.times(1 - kr)));
            const phongT = PhongMaterial.phongLobe(bsdf, data.refractionDirection, this.smoothness, -1);
            if (phongT)
                bsdf.add(phongT, s(data.specularity.times(1 - kr)));
        }
    }
    surface(data) {
        this.getBaseFactors(data);
        const bsdf = this.legacyBSDF(data);
        this.addRoughLobes(bsdf, data, 1);
        const delta = this.deltaLobe(data);
        if (delta)
            bsdf.add(delta, [1, 1, 1]);
        else
            bsdf.add(new MirrorLobe(), toRGB(data.reflectivity));
        return { emission: data.ambient, bsdf: bsdf };
    }

    // override this to correspond to the way that light passes through Fresnel materials
    colorFromLightSample(light_sample, data) {
        const L = light_sample.direction.normalized(),
            ldotn = L.dot(data.N);

        let diffuse = 0, specular = 0;
        if (data.kr > 0 && ldotn >= 0) {
            diffuse  += data.kr * ldotn;
            specular += data.kr * Math.pow(Math.max(L.dot(data.R), 0), this.smoothness);
        }
        if (data.kr < 1 && ldotn <= 0) {
            diffuse  += (1 - data.kr) * -ldotn;
            specular += (1 - data.kr) * Math.pow(Math.max(L.dot(data.refractionDirection), 0), this.smoothness);
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

    fresnelReflectionFactor(data) {
        // If the refractiveIndexRatio is Infinite, don't even bother.
        if (!isFinite(this.refractiveIndexRatio))
            return 1;

        // The magic of Snell's law
        const ni = data.backside ? this.refractiveIndexRatio : 1,
              nt = data.backside ?                         1 : this.refractiveIndexRatio;
        const cosi = data.vdotn,
              sint = ni / nt * Math.sqrt(Math.max(0, 1 - cosi * cosi));

        // Total internal reflection
        if (sint >= 1)
            return 1;
        
        // Split between reflection and refraction
        const cost = Math.sqrt(Math.max(0, 1 - sint * sint));
        const Rs = ((nt * cosi) - (ni * cost)) / ((nt * cosi) + (ni * cost));
        const Rp = ((ni * cosi) - (nt * cost)) / ((ni * cosi) + (nt * cost));
        return (Rs * Rs + Rp * Rp) / 2;
    }
}

// The original path tracing material. Its sampler picked one lobe per bounce: a mirror with probability
// mirrorProbability, otherwise diffuse or glossy in proportion to their strengths. As a BSDF that's a mixture with
// those probabilities as weights, on each side of the Fresnel split.
class PhongPathTracingMaterial extends FresnelPhongMaterial {
    constructor(baseColor, ambient=1, diffusivity=0, specularity=0, smoothness=0, refractiveIndexRatio=Infinity, mirrorProbability=0) {
        super(baseColor, ambient, diffusivity, specularity, smoothness, refractiveIndexRatio, Vec.of(1,1,1), isFinite(refractiveIndexRatio) ? Vec.of(1,1,1) : Vec.of(0,0,0));
        this.mirrorProbability = mirrorProbability;
    }
    static deserialize(data) {
        return new PhongPathTracingMaterial(data.baseColor, data.ambient, data.diffusivity, data.specularity, data.smoothness, data.refractiveIndexRatio, data.mirrorProbability);
    }
    get prefersPathTracing() {
        return true;
    }
    // The original path tracer bounced light off these surfaces with a mirror (with mirrorProbability) or, otherwise,
    // the diffuse and glossy lobes in proportion to their strengths; this BSDF is that mixture. (Its direct lighting
    // used the full diffuse and glossy lobes regardless, which a single BSDF can't do without gaining energy, so a
    // surface with a high mirrorProbability now shows less diffuse shading from lights than it used to.)
    surface(data) {
        this.getBaseFactors(data);
        const bsdf = this.legacyBSDF(data);
        const m = this.mirrorProbability;
        const pd = data.diffusivity.average(), ps = data.specularity.average(), sum = pd + ps;
        if (sum > 0 && m < 1) {
            // Diffuse and glossy share the non-mirror probability in proportion to their strengths.
            const d = data.diffusivity.times((1 - m) * pd / sum), sp = data.specularity.times((1 - m) * ps / sum);
            const scaled = Object.assign({}, data, { diffusivity: d, specularity: sp });
            this.addRoughLobes(bsdf, scaled, 1);
            // An infinitely smooth glossy lobe is a mirror.
            if (!isFinite(this.smoothness))
                bsdf.add(this.deltaLobe(data) || new MirrorLobe(), toRGB(sp));
        }
        if (m > 0)
            bsdf.add(this.deltaLobe(data) || new MirrorLobe(), [m, m, m]);
        return { emission: data.ambient, bsdf: bsdf };
    }
}

// A physically based material in the style of Cycles' Principled BSDF (and close to glTF's metallic-roughness model
// and OpenPBR), built from microfacet lobes (src/bsdf.js). It's a blend of three materials:
//   metal       (weight metallic):                                GGX reflection, Fresnel tinted by baseColor
//   glass       (weight (1 - metallic) * transmission):           GGX reflection and refraction, transmission tinted
//   dielectric  (weight (1 - metallic) * (1 - transmission)):     GGX specular reflection over a diffuse base
// Parameters can be numbers, colors, or MaterialColors (textures); scalar parameters read the red channel.
//   roughness: perceptual roughness in [0, 1]; the GGX alpha is roughness^2, which spreads the visual change evenly.
//   ior: index of refraction, for the specular layer and glass. 1.5 reflects 4% head on, like most plastics and glass.
//   emission, emissionStrength: emitted radiance.
class PrincipledMaterial extends Material {
    constructor({ baseColor = Vec.of(0.8, 0.8, 0.8), metallic = 0, roughness = 0.5, ior = 1.5, transmission = 0,
                  emission = Vec.of(0, 0, 0), emissionStrength = 1 } = {}) {
        super();
        this.baseColor = MaterialColor.coerce(baseColor);
        this.metallic = metallic;
        this.roughness = roughness;
        this.ior = ior;
        this.transmission = transmission;
        this.emission = MaterialColor.coerce(emission);
        this.emissionStrength = emissionStrength;
    }
    static deserialize(data) {
        return new PrincipledMaterial(data);
    }
    get prefersPathTracing() {
        return true;
    }
    static scalar(p, data) {
        return (typeof p == "number") ? p : MaterialColor.coerce(p).color(data)[0];
    }
    // Below this alpha, lobes are treated as perfectly smooth (delta) lobes.
    static SMOOTH_ALPHA = 1e-3;
    // Multiple scattering compensation for rough metals (Kulla and Conty). Turn off to see single scattering alone.
    static MULTISCATTER = true;

    surface(data) {
        const V = data.ray.direction.normalized().times(-1);
        let N = data.normal.normalized();
        const backside = V.dot(N) < 0;
        if (backside)
            N = N.times(-1);
        const mu = Math.min(1, Math.abs(V.dot(N)));

        const base = toRGB(this.baseColor.color(data));
        const metallic = Math.min(Math.max(PrincipledMaterial.scalar(this.metallic, data), 0), 1);
        const transmission = Math.min(Math.max(PrincipledMaterial.scalar(this.transmission, data), 0), 1);
        const roughness = Math.min(Math.max(PrincipledMaterial.scalar(this.roughness, data), 0), 1);
        const ior = Math.max(PrincipledMaterial.scalar(this.ior, data), 1.0001);
        const alpha = roughness * roughness, smooth = alpha < PrincipledMaterial.SMOOTH_ALPHA;
        const ggx = new GGX(alpha);

        const bsdf = new BSDF(N);
        const wMetal = metallic, wGlass = (1 - metallic) * transmission, wDielectric = (1 - metallic) * (1 - transmission);

        if (wMetal > 0) {
            if (smooth)
                bsdf.add(new MirrorLobe(), BSDFMath.fresnelSchlick(mu, base).map(f => f * wMetal));
            else {
                bsdf.add(new MicrofacetConductorLobe(ggx, base), [wMetal, wMetal, wMetal]);
                // Return the energy single scattering loses (see MultiscatterLobe).
                if (PrincipledMaterial.MULTISCATTER) {
                    const ms = new MultiscatterLobe(alpha, AlbedoTable.whiteConductor());
                    const tint = MultiscatterLobe.tint(base, ms.Eavg).map(c => c * wMetal);
                    bsdf.add(ms, tint, BSDFMath.average(tint) * (1 - ms.E(mu)));
                }
            }
        }
        if (wGlass > 0) {
            // Entering from the front the far side is the dense one; from the back it's air.
            const etap = backside ? 1 / ior : ior;
            if (smooth)
                bsdf.add(new SmoothDielectricLobe(1 / etap, [1, 1, 1], base), [wGlass, wGlass, wGlass]);
            else {
                // Energy lost to light bouncing between facets is returned by scaling the lobe by 1 / E(mu_o), its
                // single-scattering albedo from this side (Turquin 2019). It keeps the lobe's shape, but isn't
                // reciprocal; Kulla and Conty's lobe (used for metals) is, but is much harder to build for refraction.
                const k = PrincipledMaterial.MULTISCATTER
                    ? 1 / Math.max(0.05, AlbedoTable.lookup(AlbedoTable.dielectricTotal(etap), mu, alpha)) : 1;
                bsdf.add(new MicrofacetDielectricLobe(ggx, etap, [1, 1, 1], base), [wGlass * k, wGlass * k, wGlass * k], wGlass);
            }
        }
        if (wDielectric > 0) {
            // Opaque: treated as two-sided, entering the dense side whichever side is hit.
            const E = smooth ? BSDFMath.fresnelDielectric(mu, 1 / ior) : AlbedoTable.lookup(AlbedoTable.dielectricSpecular(ior), mu, alpha);
            if (smooth)
                bsdf.add(new MirrorLobe(), [E * wDielectric, E * wDielectric, E * wDielectric]);
            else
                bsdf.add(new MicrofacetDielectricLobe(ggx, ior, [1, 1, 1], [1, 1, 1], true),
                    [wDielectric, wDielectric, wDielectric], wDielectric * E);
            bsdf.add(new LambertLobe(), base.map(c => c * wDielectric * (1 - E)));
        }

        const emission = this.emission.color(data).times(PrincipledMaterial.scalar(this.emissionStrength, data));
        return { emission: (emission[0] || emission[1] || emission[2]) ? emission : null, bsdf: bsdf };
    }
}
