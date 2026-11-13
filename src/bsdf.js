// BSDFs: what a surface does with light, separated from how light is transported (that's src/integrators.js).
//
// A BSDF answers three questions about a pair of directions at a surface point, both pointing away from it:
// wo (toward the viewer, or where the path came from) and wi (toward the light, or where the path goes next):
//   eval(wo, wi):   f(wo, wi), the fraction of light arriving from wi that leaves toward wo, per unit solid angle and
//                   per unit of projected area. The integrator multiplies by |cos(theta_i)| itself.
//   sample(wo):     picks a wi with some probability density pdf(wi), and returns the Monte Carlo weight
//                   f * |cos(theta_i)| / pdf, so the integrator can continue the path without knowing the lobe.
//   pdf(wo, wi):    the density sample() would have produced wi with. Needed for multiple importance sampling.
// Delta lobes (perfect mirrors and refraction) reflect into a single direction. Their f is infinite there and zero
// everywhere else, so eval() and pdf() ignore them, and sample() reports them with delta = true.
//
// Lobes work in a local shading frame where the surface normal is +z, using plain [x, y, z] arrays (doubles: the
// Vec class is Float32Array). BSDF converts to and from world space.

const BSDFMath = {
    dot:       (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2],
    scale:     (a, s) => [a[0]*s, a[1]*s, a[2]*s],
    add:       (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]],
    normalize: a => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0]/l, a[1]/l, a[2]/l] : [0, 0, 1]; },
    // Mirror reflection of w about the normal (+z).
    reflect:   w => [-w[0], -w[1], w[2]],
    // Mirror reflection of w about an arbitrary unit vector h.
    reflectAbout: (w, h) => { const d = 2 * BSDFMath.dot(w, h); return [d*h[0] - w[0], d*h[1] - w[1], d*h[2] - w[2]]; },
    // Refraction of w (pointing away from the surface) through a surface with normal h (on w's side), where
    // eta = (index on w's side) / (index on the other side). Returns null on total internal reflection.
    refract: (w, h, eta) => {
        const cosi = BSDFMath.dot(w, h);
        const sin2t = eta * eta * Math.max(0, 1 - cosi * cosi);
        if (sin2t >= 1)
            return null;
        const cost = Math.sqrt(1 - sin2t);
        return [-eta * w[0] + (eta * cosi - cost) * h[0], -eta * w[1] + (eta * cosi - cost) * h[1], -eta * w[2] + (eta * cosi - cost) * h[2]];
    },
    // Unpolarized Fresnel reflectance of a dielectric interface. cosi is measured on the incident side;
    // eta = (index of the incident side) / (index of the other side).
    fresnelDielectric: (cosi, eta) => {
        cosi = Math.min(1, Math.abs(cosi));
        const sin2t = eta * eta * (1 - cosi * cosi);
        if (sin2t >= 1)
            return 1;   // total internal reflection
        const cost = Math.sqrt(1 - sin2t);
        // Same formula as the legacy FresnelPhongMaterial, with ni = eta, nt = 1.
        const Rs = (cosi - eta * cost) / (cosi + eta * cost);
        const Rp = (eta * cosi - cost) / (eta * cosi + cost);
        return (Rs * Rs + Rp * Rp) / 2;
    },
    // Schlick's approximation for a reflectance F0 at normal incidence (per channel, for conductors).
    fresnelSchlick: (cosi, F0) => {
        const m = Math.pow(1 - Math.min(1, Math.abs(cosi)), 5);
        return F0.map(f => f + (1 - f) * m);
    },
    // Cosine-weighted direction on the upper hemisphere: pdf = cos(theta) / pi.
    sampleCosineHemisphere: (u1, u2) => {
        const r = Math.sqrt(u1), phi = 2 * Math.PI * u2;
        return [r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(Math.max(0, 1 - u1))];
    },
    // An orthonormal basis [t, b] completing unit vector n (Duff et al. 2017, branchless).
    basis: n => {
        const sign = n[2] >= 0 ? 1 : -1, a = -1 / (sign + n[2]), b = n[0] * n[1] * a;
        return [[1 + sign * n[0] * n[0] * a, sign * b, -sign * n[0]], [b, sign + n[1] * n[1] * a, -n[1]]];
    },
    maxComponent: c => Math.max(c[0], c[1], c[2]),
    average: c => (c[0] + c[1] + c[2]) / 3,
    isBlack: c => c[0] <= 0 && c[1] <= 0 && c[2] <= 0,
};

// ---------------------------------------------------------------------------------------------------------------
// Lobes. eval/pdf take local wo, wi; sample(wo, u1, u2) returns { wi, pdf } (or { wi, delta: true, value: [r,g,b] }
// for delta lobes), or null if no direction could be produced.
// ---------------------------------------------------------------------------------------------------------------

class LambertLobe {
    // side = +1 reflects (diffuse reflection), -1 transmits (diffuse transmission, a legacy behavior).
    constructor(side = 1) { this.side = side; }
    eval(wo, wi) { return (wi[2] * this.side > 0 && wo[2] > 0) ? 1 / Math.PI : 0; }
    pdf(wo, wi)  { return (wi[2] * this.side > 0 && wo[2] > 0) ? Math.abs(wi[2]) / Math.PI : 0; }
    sample(wo, u1, u2) {
        if (wo[2] <= 0) return null;
        const wi = BSDFMath.sampleCosineHemisphere(u1, u2);
        wi[2] *= this.side;
        return { wi: wi, pdf: Math.abs(wi[2]) / Math.PI };
    }
}

// Normalized Phong lobe around an axis (the mirror direction, or the refracted one for legacy rough transmission):
// f = (n + 2) / (2 pi) * cos(alpha)^n, alpha the angle between wi and the axis, restricted to one hemisphere. The
// (n + 2) / (2 pi) factor makes it reflect at most all the light, which the legacy shading term (cos^n alone) didn't.
class PhongLobe {
    constructor(axis, exponent, side = 1) { this.axis = axis; this.n = exponent; this.side = side; }
    eval(wo, wi) {
        if (wi[2] * this.side <= 0) return 0;
        const c = BSDFMath.dot(wi, this.axis);
        return c > 0 ? (this.n + 2) / (2 * Math.PI) * Math.pow(c, this.n) : 0;
    }
    pdf(wo, wi) {
        if (wi[2] * this.side <= 0) return 0;
        const c = BSDFMath.dot(wi, this.axis);
        return c > 0 ? (this.n + 1) / (2 * Math.PI) * Math.pow(c, this.n) : 0;
    }
    sample(wo, u1, u2) {
        const cosa = Math.pow(u1, 1 / (this.n + 1)), sina = Math.sqrt(Math.max(0, 1 - cosa * cosa)), phi = 2 * Math.PI * u2;
        const [t, b] = BSDFMath.basis(this.axis);
        const wi = BSDFMath.add(BSDFMath.add(BSDFMath.scale(t, sina * Math.cos(phi)), BSDFMath.scale(b, sina * Math.sin(phi))), BSDFMath.scale(this.axis, cosa));
        if (wi[2] * this.side <= 0) return null;   // fell on the wrong side of the surface: f is zero there
        return { wi: wi, pdf: (this.n + 1) / (2 * Math.PI) * Math.pow(cosa, this.n) };
    }
}

// Delta lobes. deltaDirections(wo) lists every direction with its weight (Whitted mode traces all of them);
// sample() picks one.
class MirrorLobe {
    deltaDirections(wo) { return [{ wi: BSDFMath.reflect(wo), value: [1, 1, 1] }]; }
    sample(wo) { return { wi: BSDFMath.reflect(wo), delta: true, value: [1, 1, 1] }; }
}
class PassThroughLobe {
    deltaDirections(wo) { return [{ wi: [-wo[0], -wo[1], -wo[2]], value: [1, 1, 1] }]; }
    sample(wo) { return { wi: [-wo[0], -wo[1], -wo[2]], delta: true, value: [1, 1, 1] }; }
}
// A smooth dielectric interface: Fresnel-weighted mirror reflection and refraction. eta = (index on wo's side) /
// (index on the other side). The reflected and transmitted parts can be tinted separately (legacy parameters).
class SmoothDielectricLobe {
    constructor(eta, reflectTint = [1, 1, 1], transmitTint = [1, 1, 1]) { this.eta = eta; this.R = reflectTint; this.T = transmitTint; }
    deltaDirections(wo) {
        const F = BSDFMath.fresnelDielectric(wo[2], this.eta);
        const ret = [{ wi: BSDFMath.reflect(wo), value: BSDFMath.scale(this.R, F) }];
        const t = F < 1 ? BSDFMath.refract(wo, [0, 0, 1], this.eta) : null;
        if (t)
            ret.push({ wi: t, value: BSDFMath.scale(this.T, 1 - F) });
        return ret;
    }
    sample(wo, u1) {
        const F = BSDFMath.fresnelDielectric(wo[2], this.eta);
        // Choose reflection with probability F, so the weight (F / F, or (1 - F) / (1 - F)) is just the tint.
        if (u1 < F)
            return { wi: BSDFMath.reflect(wo), delta: true, value: this.R };
        const t = BSDFMath.refract(wo, [0, 0, 1], this.eta);
        return t ? { wi: t, delta: true, value: this.T } : null;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// BSDF: a weighted mix of lobes at one shading point.
// ---------------------------------------------------------------------------------------------------------------
class BSDF {
    // normal: the world-space shading normal (Vec), already flipped to face wo if the material is two-sided.
    constructor(normal) {
        this.n = BSDFMath.normalize([normal[0], normal[1], normal[2]]);
        [this.t, this.b] = BSDFMath.basis(this.n);
        this.lobes = [];
        this.sampleWeightSum = 0;
    }
    // weight: [r, g, b] multiplier on the lobe's f. sampleWeight: relative probability of sampling this lobe
    // (defaults to the weight's average, a reasonable guess at how much light the lobe carries).
    add(lobe, weight, sampleWeight = BSDFMath.average(weight)) {
        if (BSDFMath.isBlack(weight) || !(sampleWeight > 0))
            return this;
        this.lobes.push({ lobe: lobe, weight: weight, sampleWeight: sampleWeight, delta: !lobe.eval });
        this.sampleWeightSum += sampleWeight;
        return this;
    }
    get isEmpty()        { return this.lobes.length == 0; }
    get hasNonDelta()    { return this.lobes.some(l => !l.delta); }
    toLocal(v)  { return [BSDFMath.dot(v, this.t), BSDFMath.dot(v, this.b), BSDFMath.dot(v, this.n)]; }
    toWorld(l)  { return Vec.of(this.t[0]*l[0] + this.b[0]*l[1] + this.n[0]*l[2],
                                this.t[1]*l[0] + this.b[1]*l[1] + this.n[1]*l[2],
                                this.t[2]*l[0] + this.b[2]*l[1] + this.n[2]*l[2], 0); }
    static wLocal(bsdf, v) { return BSDFMath.normalize(bsdf.toLocal(v)); }

    // f(wo, wi) summed over the non-delta lobes, as [r, g, b]. wo, wi: world-space Vecs.
    eval(woW, wiW) {
        const wo = BSDF.wLocal(this, woW), wi = BSDF.wLocal(this, wiW);
        return this.evalLocal(wo, wi);
    }
    evalLocal(wo, wi) {
        const ret = [0, 0, 0];
        for (const l of this.lobes) {
            if (l.delta) continue;
            const f = l.lobe.eval(wo, wi);
            if (f) for (let c = 0; c < 3; ++c) ret[c] += l.weight[c] * (typeof f == "number" ? f : f[c]);
        }
        return ret;
    }
    // Density of sample() producing wi (solid angle measure), over the non-delta lobes.
    pdf(woW, wiW) {
        return this.pdfLocal(BSDF.wLocal(this, woW), BSDF.wLocal(this, wiW));
    }
    pdfLocal(wo, wi) {
        let ret = 0;
        for (const l of this.lobes)
            if (!l.delta)
                ret += l.sampleWeight / this.sampleWeightSum * l.lobe.pdf(wo, wi);
        return ret;
    }
    // Returns { wi (world Vec), weight ([r,g,b] = f |cos| / pdf), pdf, delta }, or null.
    sample(woW, u0 = Math.random(), u1 = Math.random(), u2 = Math.random()) {
        if (this.isEmpty) return null;
        const wo = BSDF.wLocal(this, woW);
        // Pick a lobe in proportion to its sampleWeight, then reuse u0 (rescaled) inside the lobe.
        let target = u0 * this.sampleWeightSum, chosen = this.lobes[this.lobes.length - 1];
        for (const l of this.lobes) {
            if (target < l.sampleWeight) { chosen = l; break; }
            target -= l.sampleWeight;
        }
        const prob = chosen.sampleWeight / this.sampleWeightSum;
        const s = chosen.lobe.sample(wo, chosen.delta ? Math.min(target / chosen.sampleWeight, 0.99999999) : u1, u2);
        if (!s) return null;
        if (s.delta)
            return { wi: this.toWorld(s.wi), weight: [0, 1, 2].map(c => chosen.weight[c] * s.value[c] / prob), pdf: 0, delta: true };
        // A non-delta sample is weighted by the whole mixture, not just the lobe that produced it: f and pdf both sum
        // every non-delta lobe. (This is MIS over the lobes, with the balance heuristic.)
        const f = this.evalLocal(wo, s.wi), pdf = this.pdfLocal(wo, s.wi);
        if (!(pdf > 0) || BSDFMath.isBlack(f)) return null;
        const cos = Math.abs(s.wi[2]);
        return { wi: this.toWorld(s.wi), weight: f.map(x => x * cos / pdf), pdf: pdf, delta: false };
    }
    // Every delta direction with its weight, for Whitted mode, which traces all of them.
    deltaDirections(woW) {
        const wo = BSDF.wLocal(this, woW), ret = [];
        for (const l of this.lobes)
            if (l.delta)
                for (const d of l.lobe.deltaDirections(wo))
                    ret.push({ wi: this.toWorld(d.wi), weight: [0, 1, 2].map(c => l.weight[c] * d.value[c]) });
        return ret;
    }
    // Direct lighting in Whitted mode: the light sample's color (Li / pdf, see Light.sampleIterator) times the
    // surface's response, f * |cos|, exactly as in path tracing. The legacy Phong materials override this with their
    // original formula, which multiplies the light by the diffuse color directly (pi times a physical Lambertian).
    whittedDirect(light_sample, woW) {
        const wiW = light_sample.direction.normalized();
        const f = this.eval(woW, wiW), k = Math.abs(BSDFMath.dot(this.n, [wiW[0], wiW[1], wiW[2]]));
        return Vec.of(light_sample.color[0] * f[0] * k, light_sample.color[1] * f[1] * k, light_sample.color[2] * f[2] * k);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Microfacet models.
//
// A rough surface is modeled as a field of tiny perfect mirrors (microfacets) with normals m. Light from wi reaches wo
// only off facets whose normal is the half vector h between them, so for reflection
//     f(wo, wi) = D(h) G(wo, wi) F(wo.h) / (4 |n.wo| |n.wi|)
// D is the distribution of facet normals, G the fraction of those facets that are visible from both directions,
// F the Fresnel reflectance of one facet, and 4 |n.wo| |n.wi| converts a density of facet normals into a density of
// reflected directions (see MicrofacetConductorLobe.pdf for where the 4 comes from).
// ---------------------------------------------------------------------------------------------------------------

// The GGX (Trowbridge-Reitz) distribution, with roughness alpha along each tangent axis (equal for isotropic).
// alpha is the slope scale of the surface; materials usually take a "perceptual" roughness r and use alpha = r^2.
class GGX {
    constructor(alphaX, alphaY = alphaX) {
        this.ax = Math.max(alphaX, 1e-4);
        this.ay = Math.max(alphaY, 1e-4);
    }
    // D(m): density of facet normals per unit solid angle, normalized so the facets' projected area adds up to the
    // macro surface's: integral of D(m) (m.n) over the hemisphere = 1. That's why the peak D(n) = 1 / (pi ax ay)
    // grows as the surface gets smoother: the same total area concentrated in a narrower cone.
    D(m) {
        if (m[2] <= 0) return 0;
        const x = m[0] / this.ax, y = m[1] / this.ay, z = m[2];
        const k = x * x + y * y + z * z;
        return 1 / (Math.PI * this.ax * this.ay * k * k);
    }
    // Smith Lambda(w): roughly, how much of the surface the facets facing away from w hide, per unit of the surface
    // that's visible. G1(w) = 1 / (1 + Lambda(w)) is the fraction of facets visible from w.
    Lambda(w) {
        const cos2 = w[2] * w[2];
        if (cos2 == 0) return Infinity;
        const tan2 = (this.ax * this.ax * w[0] * w[0] + this.ay * this.ay * w[1] * w[1]) / cos2;
        return (Math.sqrt(1 + tan2) - 1) / 2;
    }
    G1(w) { return 1 / (1 + this.Lambda(w)); }
    // Height-correlated masking-shadowing: a facet hidden from wo is likelier to be hidden from wi too (both are
    // low facets), so this is larger than G1(wo) G1(wi).
    G2(wo, wi) { return 1 / (1 + this.Lambda(wo) + this.Lambda(wi)); }
    // The distribution of normals of the facets visible from w: D_w(m) = G1(w) max(0, w.m) D(m) / w.z. Sampling
    // this instead of D wastes no samples on facets the viewer can't see.
    Dvisible(w, m) {
        const wm = BSDFMath.dot(w, m);
        return wm > 0 ? this.G1(w) * wm * this.D(m) / w[2] : 0;
    }
    // Samples m from D_w (w.z > 0), by Dupuy and Benyoub's spherical cap method (2023). In the "stretched" space where
    // the roughness is 1, the visible normals of a hemisphere of facets seen from w are found by picking a point
    // uniformly on the spherical cap facing w and adding w; then unstretch.
    sampleVisible(w, u1, u2) {
        const ws = BSDFMath.normalize([this.ax * w[0], this.ay * w[1], w[2]]);
        const phi = 2 * Math.PI * u1;
        const z = (1 - u2) * (1 + ws[2]) - ws[2];
        const sinTheta = Math.sqrt(Math.max(0, 1 - z * z));
        const h = [sinTheta * Math.cos(phi) + ws[0], sinTheta * Math.sin(phi) + ws[1], z + ws[2]];
        return BSDFMath.normalize([this.ax * h[0], this.ay * h[1], Math.max(0, h[2])]);
    }
}

// A metal: microfacet reflection with a colored Fresnel reflectance F0 at normal incidence (Schlick).
class MicrofacetConductorLobe {
    constructor(ggx, F0) { this.ggx = ggx; this.F0 = F0; }
    eval(wo, wi) {
        if (wo[2] <= 0 || wi[2] <= 0) return 0;
        const h = BSDFMath.normalize(BSDFMath.add(wo, wi));
        const F = BSDFMath.fresnelSchlick(BSDFMath.dot(wo, h), this.F0);
        const k = this.ggx.D(h) * this.ggx.G2(wo, wi) / (4 * wo[2] * wi[2]);
        return [F[0] * k, F[1] * k, F[2] * k];
    }
    // We sample a facet normal h with density D_wo(h), then reflect. Reflecting maps a small cone of normals around h
    // to a cone of directions around wi that is 4 |wo.h| times wider, so p(wi) = D_wo(h) / (4 |wo.h|).
    pdf(wo, wi) {
        if (wo[2] <= 0 || wi[2] <= 0) return 0;
        const h = BSDFMath.normalize(BSDFMath.add(wo, wi));
        return this.ggx.Dvisible(wo, h) / (4 * BSDFMath.dot(wo, h));
    }
    sample(wo, u1, u2) {
        if (wo[2] <= 0) return null;
        const h = this.ggx.sampleVisible(wo, u1, u2);
        const wi = BSDFMath.reflectAbout(wo, h);
        if (wi[2] <= 0) return null;   // reflected below the surface: the path is lost (masked by another facet)
        return { wi: wi, pdf: this.ggx.Dvisible(wo, h) / (4 * BSDFMath.dot(wo, h)) };
    }
}

// A rough dielectric interface (Walter et al. 2007): microfacet reflection and refraction, weighted by each facet's
// Fresnel reflectance. etap = (index on the far side) / (index on wo's side): 1.5 entering glass from air, 1 / 1.5
// leaving it. With reflectOnly, transmission is dropped: the specular layer of an opaque dielectric, whose
// transmitted light goes to the diffuse lobe underneath instead.
//
// For refraction the half vector generalizes to the facet normal that refracts wo into wi:
//     m = normalize(etap wi + wo)
// and the facet-to-direction Jacobian becomes |wi.m| / (wi.m + wo.m / etap)^2 instead of 1 / (4 |wo.m|).
// Radiance is not scaled by 1 / etap^2 on refraction; that compression undoes itself when a path enters and leaves
// the same object, and leaving it out keeps a path's weight between 0 and 1.
class MicrofacetDielectricLobe {
    constructor(ggx, etap, reflectTint = [1, 1, 1], transmitTint = [1, 1, 1], reflectOnly = false) {
        this.ggx = ggx; this.etap = etap; this.R = reflectTint; this.T = transmitTint; this.reflectOnly = reflectOnly;
    }
    // The facet normal connecting wo and wi, oriented up, or null if no facet can.
    facetNormal(wo, wi) {
        const reflect = wi[2] > 0, e = reflect ? 1 : this.etap;
        let m = [wi[0] * e + wo[0], wi[1] * e + wo[1], wi[2] * e + wo[2]];
        const len = Math.hypot(m[0], m[1], m[2]);
        if (len < 1e-12) return null;
        m = BSDFMath.scale(m, (m[2] < 0 ? -1 : 1) / len);
        // Both directions must be on the facet's front side the way they are on the surface's.
        if (BSDFMath.dot(m, wi) * wi[2] < 0 || BSDFMath.dot(m, wo) * wo[2] < 0) return null;
        return m;
    }
    fresnel(wo, m) { return BSDFMath.fresnelDielectric(BSDFMath.dot(wo, m), 1 / this.etap); }
    eval(wo, wi) {
        if (wo[2] <= 0 || wi[2] == 0 || (this.reflectOnly && wi[2] < 0)) return 0;
        const m = this.facetNormal(wo, wi);
        if (!m) return 0;
        const F = this.fresnel(wo, m), D = this.ggx.D(m), G = this.ggx.G2(wo, wi);
        if (wi[2] > 0) {
            const k = D * G * F / (4 * wo[2] * wi[2]);
            return [this.R[0] * k, this.R[1] * k, this.R[2] * k];
        }
        const wim = BSDFMath.dot(wi, m), wom = BSDFMath.dot(wo, m);
        const denom = (wim + wom / this.etap) ** 2 * wi[2] * wo[2];
        const k = Math.abs(D * G * (1 - F) * wim * wom / denom);
        return [this.T[0] * k, this.T[1] * k, this.T[2] * k];
    }
    pdf(wo, wi) {
        if (wo[2] <= 0 || wi[2] == 0 || (this.reflectOnly && wi[2] < 0)) return 0;
        const m = this.facetNormal(wo, wi);
        if (!m) return 0;
        const F = this.reflectOnly ? 1 : this.fresnel(wo, m), Dv = this.ggx.Dvisible(wo, m);
        if (wi[2] > 0)
            return Dv / (4 * Math.abs(BSDFMath.dot(wo, m))) * F;
        const wim = BSDFMath.dot(wi, m), wom = BSDFMath.dot(wo, m);
        return Dv * Math.abs(wim) / (wim + wom / this.etap) ** 2 * (1 - F);
    }
    sample(wo, u1, u2) {
        if (wo[2] <= 0) return null;
        const m = this.ggx.sampleVisible(wo, u1, u2);
        const F = this.fresnel(wo, m);
        // Choose reflection or refraction off this facet in proportion to its Fresnel split.
        if (this.reflectOnly || Math.random() < F) {
            const wi = BSDFMath.reflectAbout(wo, m);
            if (wi[2] <= 0) return null;
            return { wi: wi, pdf: this.pdf(wo, wi) };
        }
        const wi = BSDFMath.refract(wo, m, 1 / this.etap);
        if (!wi || wi[2] >= 0) return null;
        return { wi: wi, pdf: this.pdf(wo, wi) };
    }
}

// Directional albedo tables: E(cos theta_o, alpha) = the fraction of light a lobe reflects from direction wo,
//     E(mu) = integral f(wo, wi) cos(theta_i) dwi
// computed on first use by Monte Carlo integration with the lobe's own sampling, then interpolated. Two uses:
//   - the specular layer of an opaque dielectric (ior-dependent): the diffuse base under it only receives the light
//     the specular layer doesn't reflect, so the base is weighted by (1 - E) ("albedo scaling", as Cycles does);
//   - a white (F = 1) conductor: what's missing from 1 is the energy lost to light bouncing between facets, which
//     MultiscatterLobe adds back.
class AlbedoTable {
    static SIZE = 16;
    static SAMPLES = 256;
    static tables = new Map();
    // makeLobe(alpha) builds the lobe to integrate. key identifies it (lobe kind and parameters).
    static get(key, makeLobe) {
        let t = AlbedoTable.tables.get(key);
        if (!t) AlbedoTable.tables.set(key, t = AlbedoTable.build(makeLobe));
        return t;
    }
    static build(makeLobe) {
        const n = AlbedoTable.SIZE, table = new Float64Array(n * n), average = new Float64Array(n);
        const r = Math.round(Math.sqrt(AlbedoTable.SAMPLES));   // a fixed stratified pattern keeps tables deterministic
        for (let ia = 0; ia < n; ++ia) {
            const lobe = makeLobe(Math.max(1e-3, ia / (n - 1)));
            for (let im = 0; im < n; ++im) {
                const mu = Math.max(1e-3, im / (n - 1)), wo = [Math.sqrt(1 - mu * mu), 0, mu];
                let sum = 0;
                for (let a = 0; a < r; ++a)
                    for (let b = 0; b < r; ++b) {
                        const s = lobe.sample(wo, (a + 0.5) / r, (b + 0.5) / r);
                        if (s && s.pdf > 0)
                            sum += BSDFMath.average(lobe.eval(wo, s.wi)) * Math.abs(s.wi[2]) / s.pdf;
                    }
                table[ia * n + im] = Math.min(1, sum / (r * r));
            }
            // Cosine-weighted average over directions: E_avg = 2 integral E(mu) mu dmu (trapezoid rule).
            let acc = 0;
            for (let im = 0; im < n - 1; ++im) {
                const m0 = im / (n - 1), m1 = (im + 1) / (n - 1);
                acc += (table[ia * n + im] * m0 + table[ia * n + im + 1] * m1) / 2 * (m1 - m0);
            }
            average[ia] = 2 * acc;
        }
        return { table, average };
    }
    static interp1(arr, f) {
        const n = arr.length, x = Math.min(Math.max(f, 0), 1) * (n - 1), i = Math.min(Math.floor(x), n - 2), t = x - i;
        return (1 - t) * arr[i] + t * arr[i + 1];
    }
    static lookup(t, mu, alpha) {
        const n = AlbedoTable.SIZE;
        const fx = Math.min(Math.max(mu, 0), 1) * (n - 1), fy = Math.min(Math.max(alpha, 0), 1) * (n - 1);
        const x0 = Math.min(Math.floor(fx), n - 2), y0 = Math.min(Math.floor(fy), n - 2), tx = fx - x0, ty = fy - y0;
        const at = (x, y) => t.table[y * n + x];
        return (1 - ty) * ((1 - tx) * at(x0, y0) + tx * at(x0 + 1, y0)) + ty * ((1 - tx) * at(x0, y0 + 1) + tx * at(x0 + 1, y0 + 1));
    }
    static average(t, alpha) { return AlbedoTable.interp1(t.average, alpha); }

    static dielectricSpecular(ior) {
        const key = "dielectric-reflect:" + Math.round(ior * 100) / 100;
        return AlbedoTable.get(key, alpha => new MicrofacetDielectricLobe(new GGX(alpha), ior, [1, 1, 1], [1, 1, 1], true));
    }
    static whiteConductor() {
        return AlbedoTable.get("conductor", alpha => new MicrofacetConductorLobe(new GGX(alpha), [1, 1, 1]));
    }
    // Reflection plus transmission of a rough dielectric interface, seen from the side where etap applies.
    static dielectricTotal(etap) {
        const key = "dielectric:" + Math.round(etap * 1000) / 1000;
        return AlbedoTable.get(key, alpha => new MicrofacetDielectricLobe(new GGX(alpha), etap));
    }
}

// Kulla and Conty's multiple scattering compensation for a microfacet conductor (2017). A single-scattering
// microfacet BRDF drops light that bounces off one facet into another; for a white conductor it reflects only E(mu_o)
// of the incoming light. This lobe adds a smooth lobe carrying the missing 1 - E(mu_o):
//     f_ms(wo, wi) = (1 - E(mu_o)) (1 - E(mu_i)) / (pi (1 - E_avg))
// whose integral over wi is exactly 1 - E(mu_o) (that's what the E_avg normalization is for), and which is symmetric
// in wo and wi, as a BRDF should be. For a colored conductor, light that bounces k times between facets is tinted
// F^k, so the lobe is tinted by F_ms = F_avg^2 E_avg / (1 - F_avg (1 - E_avg)): the sum of that series with an
// average Fresnel F_avg.
class MultiscatterLobe {
    constructor(alpha, table) {
        this.alpha = alpha; this.table = table;
        this.Eavg = AlbedoTable.average(table, alpha);
    }
    E(mu) { return AlbedoTable.lookup(this.table, mu, this.alpha); }
    eval(wo, wi) {
        if (wo[2] <= 0 || wi[2] <= 0 || this.Eavg >= 1) return 0;
        return (1 - this.E(wo[2])) * (1 - this.E(wi[2])) / (Math.PI * (1 - this.Eavg));
    }
    // Cosine sampling: the lobe is broad and smooth, like a diffuse lobe.
    pdf(wo, wi)  { return (wo[2] > 0 && wi[2] > 0) ? wi[2] / Math.PI : 0; }
    sample(wo, u1, u2) {
        if (wo[2] <= 0) return null;
        const wi = BSDFMath.sampleCosineHemisphere(u1, u2);
        return { wi: wi, pdf: wi[2] / Math.PI };
    }
    // The tint for a conductor whose Schlick Fresnel has normal reflectance F0. F_avg is Schlick's cosine-weighted
    // average, 2 integral (F0 + (1 - F0)(1 - mu)^5) mu dmu = F0 + (1 - F0) / 21.
    static tint(F0, Eavg) {
        return F0.map(f0 => {
            const Favg = f0 + (1 - f0) / 21;
            return Favg * Favg * Eavg / (1 - Favg * (1 - Eavg));
        });
    }
}
