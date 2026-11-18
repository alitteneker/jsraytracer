// The BSDFs: a GLSL port of src/bsdf.js and of the materials' surface() methods (see Materials.md). Used for path
// tracing, and for any material that isn't one of the legacy Phong ones. Rendered by WebGLMaterialsAdapter.

//#section source

// ---- BSDFs (a port of src/bsdf.js; see Materials.md) ----
// A BSDF here is a fixed set of lobe slots with weights, filled in by a material (buildPhongBSDF,
// buildPrincipledBSDF), so evaluating, sampling and the pdf are each a single function no matter which
// material made it. Lobes work in a local frame where the shading normal is +z; wo is stored local.
// A lobe with a zero weight costs a branch and nothing else.
uniform sampler2D uAlbedoTables;

struct BSDF {
    vec3 n; vec3 t; vec3 b;      // world-space frame
    vec3 wo;                     // the outgoing direction, local

    vec3 lamb;  vec3 lambT;      // Lambertian reflection and (legacy) diffuse transmission
    vec3 phongR; vec3 axisR;     // normalized Phong lobes around a local axis, on each side
    vec3 phongT; vec3 axisT;
    float phongN;

    float alpha;                 // GGX roughness shared by the microfacet lobes
    vec3 cond; vec3 F0;          // conductor, Schlick Fresnel
    vec3 ms; float msEo; float msEavg;   // Kulla-Conty multiple scattering
    // Rough dielectric interfaces: [0] glass, [1] the specular layer of an opaque dielectric (dT[1] = 0,
    // so it only reflects). etap = (index on the far side) / (index on wo's side).
    vec3 dR[2]; vec3 dT[2]; float dEtap[2];

    vec3 mirror; vec3 pass;      // delta lobes: mirror, pass-through,
    vec3 smR; vec3 smT; float smEta;     // and a smooth dielectric (eta = n_wo / n_other)

    // Lobe selection weights: lamb, lambT, phongR, phongT, cond, ms, d0, d1, mirror, pass, smooth.
    float sw[11];
    float swSum;
    bool hasNonDelta;
};
struct BSDFSample {
    vec3 wi;        // world space
    vec3 weight;    // f |cos| / pdf, or the delta lobe's weight / its selection probability
    float pdf;      // 0 for delta lobes
    bool delta;
    bool ok;
};

void bsdfInit(inout BSDF f, in vec3 n, in vec3 woW) {
    f.n = n;
    // Orthonormal basis (Duff et al. 2017).
    float sgn = n.z >= 0.0 ? 1.0 : -1.0, a = -1.0 / (sgn + n.z), bb = n.x * n.y * a;
    f.t = vec3(1.0 + sgn * n.x * n.x * a, sgn * bb, -sgn * n.x);
    f.b = vec3(bb, sgn + n.y * n.y * a, -n.y);
    f.wo = normalize(vec3(dot(woW, f.t), dot(woW, f.b), dot(woW, f.n)));
    f.lamb = f.lambT = f.phongR = f.phongT = f.cond = f.F0 = f.ms = f.mirror = f.pass = f.smR = f.smT = vec3(0.0);
    f.axisR = f.axisT = vec3(0.0, 0.0, 1.0);
    f.phongN = 1.0; f.alpha = 1.0; f.msEo = 1.0; f.msEavg = 1.0; f.smEta = 1.0;
    for (int i = 0; i < 2; ++i) { f.dR[i] = vec3(0.0); f.dT[i] = vec3(0.0); f.dEtap[i] = 1.5; }
    for (int i = 0; i < 11; ++i) f.sw[i] = 0.0;
}
vec3 bsdfToLocal(in BSDF f, in vec3 v) { return vec3(dot(v, f.t), dot(v, f.b), dot(v, f.n)); }
vec3 bsdfToWorld(in BSDF f, in vec3 l) { return f.t * l.x + f.b * l.y + f.n * l.z; }
// Sets every lobe's selection weight to its average weight, as BSDF.add does by default, except where the
// material set one already (sw > 0).
void bsdfFinish(inout BSDF f) {
    vec3 w[11] = vec3[11](f.lamb, f.lambT, f.phongR, f.phongT, f.cond, f.ms, f.dR[0] + f.dT[0], f.dR[1],
        f.mirror, f.pass, f.smR + f.smT);
    f.swSum = 0.0;
    for (int i = 0; i < 11; ++i) {
        if (max(max(w[i].r, w[i].g), w[i].b) <= 0.0)
            f.sw[i] = 0.0;
        else if (f.sw[i] <= 0.0)
            f.sw[i] = average(w[i]);
        f.swSum += f.sw[i];
    }
    f.hasNonDelta = (f.sw[0] + f.sw[1] + f.sw[2] + f.sw[3] + f.sw[4] + f.sw[5] + f.sw[6] + f.sw[7]) > 0.0;
}

// ---- Albedo tables: 16 x 16 values E(mu, alpha) and 16 averages E_avg(alpha) each ----
float albedoAt(in int table, in int i) {
    return texelFetchByIndex(table * 272 + i, uAlbedoTables).r;
}
float albedoLookup(in int table, in float mu, in float alpha) {
    float fx = clamp(mu, 0.0, 1.0) * 15.0, fy = clamp(alpha, 0.0, 1.0) * 15.0;
    int x0 = min(int(fx), 14), y0 = min(int(fy), 14);
    float tx = fx - float(x0), ty = fy - float(y0);
    int i = y0 * 16 + x0;
    return mix(mix(albedoAt(table, i),      albedoAt(table, i + 1),  tx),
               mix(albedoAt(table, i + 16), albedoAt(table, i + 17), tx), ty);
}
float albedoAverage(in int table, in float alpha) {
    float fx = clamp(alpha, 0.0, 1.0) * 15.0;
    int x0 = min(int(fx), 14);
    return mix(albedoAt(table, 256 + x0), albedoAt(table, 257 + x0), fx - float(x0));
}

// ---- Fresnel and GGX ----
// eta = (index of the incident side) / (index of the other side).
float fresnelDielectric(in float cosi, in float eta) {
    cosi = min(1.0, abs(cosi));
    float sin2t = eta * eta * (1.0 - cosi * cosi);
    if (sin2t >= 1.0)
        return 1.0;
    float cost = sqrt(1.0 - sin2t);
    float Rs = (cosi - eta * cost) / (cosi + eta * cost);
    float Rp = (eta * cosi - cost) / (eta * cosi + cost);
    return (Rs * Rs + Rp * Rp) * 0.5;
}
vec3 fresnelSchlick(in float cosi, in vec3 F0) {
    float m = 1.0 - min(1.0, abs(cosi));
    return F0 + (1.0 - F0) * (m * m * m * m * m);
}
float ggxD(in vec3 m, in float a) {
    if (m.z <= 0.0) return 0.0;
    float a2 = a * a, k = (m.x * m.x + m.y * m.y) / a2 + m.z * m.z;
    return 1.0 / (PI * a2 * k * k);
}
float ggxLambda(in vec3 w, in float a) {
    float cos2 = w.z * w.z;
    if (cos2 <= 0.0) return 1e20;
    return (sqrt(1.0 + a * a * (w.x * w.x + w.y * w.y) / cos2) - 1.0) * 0.5;
}
float ggxG1(in vec3 w, in float a) { return 1.0 / (1.0 + ggxLambda(w, a)); }
float ggxG2(in vec3 wo, in vec3 wi, in float a) { return 1.0 / (1.0 + ggxLambda(wo, a) + ggxLambda(wi, a)); }
float ggxDvisible(in vec3 w, in vec3 m, in float a) {
    float wm = dot(w, m);
    return wm > 0.0 ? ggxG1(w, a) * wm * ggxD(m, a) / w.z : 0.0;
}
// Visible normal sampling (Dupuy and Benyoub 2023).
vec3 ggxSampleVisible(in vec3 w, in float a, in float u1, in float u2) {
    vec3 ws = normalize(vec3(a * w.x, a * w.y, w.z));
    float phi = 2.0 * PI * u1;
    float z = (1.0 - u2) * (1.0 + ws.z) - ws.z;
    float sinTheta = sqrt(max(0.0, 1.0 - z * z));
    vec3 h = vec3(sinTheta * cos(phi) + ws.x, sinTheta * sin(phi) + ws.y, z + ws.z);
    return normalize(vec3(a * h.x, a * h.y, max(0.0, h.z)));
}
vec3 sampleCosineHemisphere(in float u1, in float u2) {
    float r = sqrt(u1), phi = 2.0 * PI * u2;
    return vec3(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u1)));
}

// ---- Rough dielectric (Walter et al. 2007), slot k ----
// The facet normal connecting wo and wi, oriented up, or zero if no facet can.
vec3 dielectricFacet(in vec3 wo, in vec3 wi, in float etap) {
    vec3 m = wi * (wi.z > 0.0 ? 1.0 : etap) + wo;
    float len = length(m);
    if (len < 1e-7) return vec3(0.0);
    m *= (m.z < 0.0 ? -1.0 : 1.0) / len;
    if (dot(m, wi) * wi.z < 0.0 || dot(m, wo) * wo.z < 0.0) return vec3(0.0);
    return m;
}
// f, and (in pdf) the density of sampling wi, for dielectric slot k.
vec3 dielectricEval(in BSDF f, in int k, in vec3 wi, out float pdf) {
    pdf = 0.0;
    vec3 wo = f.wo;
    bool reflectOnly = max(max(f.dT[k].r, f.dT[k].g), f.dT[k].b) <= 0.0;
    if (wo.z <= 0.0 || wi.z == 0.0 || (reflectOnly && wi.z < 0.0)) return vec3(0.0);
    float etap = f.dEtap[k];
    vec3 m = dielectricFacet(wo, wi, etap);
    if (m.z <= 0.0) return vec3(0.0);
    float F = fresnelDielectric(dot(wo, m), 1.0 / etap);
    float D = ggxD(m, f.alpha), G = ggxG2(wo, wi, f.alpha), Dv = ggxDvisible(wo, m, f.alpha);
    float pR = reflectOnly ? 1.0 : F;
    if (wi.z > 0.0) {
        pdf = Dv / (4.0 * abs(dot(wo, m))) * pR;
        return f.dR[k] * (D * G * F / (4.0 * wo.z * wi.z));
    }
    float wim = dot(wi, m), wom = dot(wo, m), s = wim + wom / etap;
    pdf = Dv * abs(wim) / (s * s) * (1.0 - pR);
    return f.dT[k] * abs(D * G * (1.0 - F) * wim * wom / (s * s * wi.z * wo.z));
}

// f(wo, wi) over the non-delta lobes, and the mixture's pdf (local directions).
vec3 bsdfEvalLocal(in BSDF f, in vec3 wi, out float pdf) {
    vec3 wo = f.wo, ret = vec3(0.0);
    pdf = 0.0;
    if (!f.hasNonDelta || f.swSum <= 0.0) return ret;
    float invSum = 1.0 / f.swSum;
    if (wo.z > 0.0) {
        if (wi.z > 0.0 && f.sw[0] > 0.0) {
            ret += f.lamb / PI;
            pdf += f.sw[0] * invSum * wi.z / PI;
        }
        if (wi.z < 0.0 && f.sw[1] > 0.0) {
            ret += f.lambT / PI;
            pdf += f.sw[1] * invSum * -wi.z / PI;
        }
        // Normalized Phong: f = (n + 2) / 2pi cos^n, sampled with density (n + 1) / 2pi cos^n.
        if (wi.z > 0.0 && f.sw[2] > 0.0) {
            float c = dot(wi, f.axisR);
            if (c > 0.0) {
                float cn = pow(c, f.phongN) / (2.0 * PI);
                ret += f.phongR * (f.phongN + 2.0) * cn;
                pdf += f.sw[2] * invSum * (f.phongN + 1.0) * cn;
            }
        }
        if (wi.z < 0.0 && f.sw[3] > 0.0) {
            float c = dot(wi, f.axisT);
            if (c > 0.0) {
                float cn = pow(c, f.phongN) / (2.0 * PI);
                ret += f.phongT * (f.phongN + 2.0) * cn;
                pdf += f.sw[3] * invSum * (f.phongN + 1.0) * cn;
            }
        }
        if (wi.z > 0.0 && f.sw[4] > 0.0) {
            vec3 h = normalize(wo + wi);
            ret += fresnelSchlick(dot(wo, h), f.F0) * f.cond * (ggxD(h, f.alpha) * ggxG2(wo, wi, f.alpha) / (4.0 * wo.z * wi.z));
            pdf += f.sw[4] * invSum * ggxDvisible(wo, h, f.alpha) / (4.0 * dot(wo, h));
        }
        if (wi.z > 0.0 && f.sw[5] > 0.0 && f.msEavg < 1.0) {
            ret += f.ms * ((1.0 - f.msEo) * (1.0 - albedoLookup(0, wi.z, f.alpha)) / (PI * (1.0 - f.msEavg)));
            pdf += f.sw[5] * invSum * wi.z / PI;
        }
        for (int k = 0; k < 2; ++k) {
            if (f.sw[6 + k] <= 0.0) continue;
            float p;
            ret += dielectricEval(f, k, wi, p);
            pdf += f.sw[6 + k] * invSum * p;
        }
    }
    return ret;
}
vec3 bsdfEval(in BSDF f, in vec3 wiW, out float pdf) {
    return bsdfEvalLocal(f, normalize(bsdfToLocal(f, wiW)), pdf);
}

// Picks a lobe in proportion to its selection weight and samples it. A non-delta sample is weighted by the
// whole mixture (MIS over the lobes with the balance heuristic), as on the CPU.
BSDFSample bsdfSample(in BSDF f, inout vec2 random_seed, in bool deltaOnly) {
    BSDFSample s = BSDFSample(vec3(0.0), vec3(0.0), 0.0, false, false);
    float total = deltaOnly ? f.sw[8] + f.sw[9] + f.sw[10] : f.swSum;
    if (total <= 0.0) return s;
    float target = randf(random_seed) * total, u1 = randf(random_seed), u2 = randf(random_seed);
    int lobe = -1, last = 0;
    for (int i = deltaOnly ? 8 : 0; i < 11; ++i) {
        if (f.sw[i] <= 0.0) continue;
        last = i;
        if (target < f.sw[i]) { lobe = i; break; }
        target -= f.sw[i];
    }
    if (lobe < 0) lobe = last;   // rounding
    float prob = f.sw[lobe] / total;
    vec3 wo = f.wo, wi;
    if (lobe >= 8) {
        s.delta = true;
        if (lobe == 8) {
            wi = vec3(-wo.x, -wo.y, wo.z);
            s.weight = f.mirror / prob;
        }
        else if (lobe == 9) {
            wi = -wo;
            s.weight = f.pass / prob;
        }
        else {
            float F = fresnelDielectric(wo.z, f.smEta);
            if (u1 < F) {
                wi = vec3(-wo.x, -wo.y, wo.z);
                s.weight = f.smR / prob;
            }
            else {
                wi = refract(-wo, vec3(0.0, 0.0, 1.0), f.smEta);
                if (dot(wi, wi) == 0.0) return s;
                s.weight = f.smT / prob;
            }
        }
        s.wi = bsdfToWorld(f, wi);
        s.ok = true;
        return s;
    }
    if (wo.z <= 0.0) return s;
    if (lobe == 0 || lobe == 1 || lobe == 5) {
        wi = sampleCosineHemisphere(u1, u2);
        if (lobe == 1) wi.z = -wi.z;
    }
    else if (lobe == 2 || lobe == 3) {
        vec3 axis = lobe == 2 ? f.axisR : f.axisT;
        float cosa = pow(u1, 1.0 / (f.phongN + 1.0)), sina = sqrt(max(0.0, 1.0 - cosa * cosa)), phi = 2.0 * PI * u2;
        float sgn = axis.z >= 0.0 ? 1.0 : -1.0, a = -1.0 / (sgn + axis.z), bb = axis.x * axis.y * a;
        vec3 t = vec3(1.0 + sgn * axis.x * axis.x * a, sgn * bb, -sgn * axis.x), b = vec3(bb, sgn + axis.y * axis.y * a, -axis.y);
        wi = t * (sina * cos(phi)) + b * (sina * sin(phi)) + axis * cosa;
        if (wi.z * (lobe == 2 ? 1.0 : -1.0) <= 0.0) return s;
    }
    else if (lobe == 4) {
        vec3 h = ggxSampleVisible(wo, f.alpha, u1, u2);
        wi = reflect(-wo, h);
        if (wi.z <= 0.0) return s;
    }
    else {
        int k = lobe - 6;
        vec3 m = ggxSampleVisible(wo, f.alpha, u1, u2);
        bool reflectOnly = max(max(f.dT[k].r, f.dT[k].g), f.dT[k].b) <= 0.0;
        float F = fresnelDielectric(dot(wo, m), 1.0 / f.dEtap[k]);
        if (reflectOnly || randf(random_seed) < F) {
            wi = reflect(-wo, m);
            if (wi.z <= 0.0) return s;
        }
        else {
            wi = refract(-wo, m, 1.0 / f.dEtap[k]);
            if (dot(wi, wi) == 0.0 || wi.z >= 0.0) return s;
        }
    }
    float pdf;
    vec3 fv = bsdfEvalLocal(f, wi, pdf);
    if (!(pdf > 0.0) || max(max(fv.r, fv.g), fv.b) <= 0.0) return s;
    s.wi = bsdfToWorld(f, wi);
    s.weight = fv * abs(wi.z) / pdf;
    s.pdf = pdf;
    s.ok = true;
    return s;
}

// ---- Materials as BSDFs (see the surface() methods in src/materials.js) ----
// PhongMaterial, FresnelPhongMaterial and PhongPathTracingMaterial.
void buildPhongBSDF(in int type, in PhongMaterialParameters p, in vec4 rd, in vec4 normal, inout BSDF f) {
    vec4 V = normalize(-rd), N = normalize(normal);
    float vdotn = dot(V, N);
    bool backside = false;
    if (vdotn < 0.0) {
        N = -N;
        vdotn = -vdotn;
        backside = true;
    }
    vec4 R = normalize((2.0 * vdotn * N) - V);
    float kr;
    vec4 refr = vec4(0.0);
    computeRefractionParameters(V, N, vdotn, p.refractiveIndexRatio, backside, refr, kr);

    bsdfInit(f, N.xyz, V.xyz);
    bool finiteN = !isinf(p.specularFactor);
    f.phongN = finiteN ? p.specularFactor : 1.0;
    vec3 d = p.diffuse, sp = p.specular;
    if (type == MATERIAL_TYPE_PHONG || type == MATERIAL_TYPE_EMITTER) {
        f.lamb = d;
        if (finiteN) {
            f.phongR = sp;
            f.axisR = normalize(bsdfToLocal(f, R.xyz));
        }
        f.mirror = p.reflectivity;
        f.pass = p.transmissivity;
    }
    else {
        // FresnelPhongMaterial: rough lobes on both sides of the Fresnel split, plus a smooth dielectric
        // (or a mirror, for an opaque one). PhongPathTracingMaterial: the same, as a mixture with the
        // mirror taking mirrorProbability and the rough lobes sharing the rest.
        vec3 deltaWeight = vec3(1.0);
        if (type == MATERIAL_TYPE_PHONG_PATH) {
            float m = p.mirrorProbability, pd = average(d), ps = average(sp), sum = pd + ps;
            if (sum > 0.0 && m < 1.0) {
                d  *= (1.0 - m) * pd / sum;
                sp *= (1.0 - m) * ps / sum;
            }
            else
                d = sp = vec3(0.0);
            // An infinitely smooth glossy lobe is a mirror.
            deltaWeight = vec3(m) + (finiteN ? vec3(0.0) : sp);
        }
        f.lamb = d * kr;
        if (finiteN) {
            f.phongR = sp * kr;
            f.axisR = normalize(bsdfToLocal(f, R.xyz));
        }
        if (kr < 1.0 && dot(refr, refr) > 0.0) {
            f.lambT = d * (1.0 - kr);
            if (finiteN) {
                f.phongT = sp * (1.0 - kr);
                f.axisT = normalize(bsdfToLocal(f, refr.xyz));
            }
        }
        if (p.refractiveIndexRatio > 0.0 && !isinf(p.refractiveIndexRatio)) {
            f.smR = p.reflectivity * deltaWeight;
            f.smT = p.transmissivity * deltaWeight;
            f.smEta = backside ? p.refractiveIndexRatio : 1.0 / p.refractiveIndexRatio;
        }
        else
            f.mirror = (type == MATERIAL_TYPE_PHONG_PATH) ? deltaWeight : p.reflectivity;
    }
    bsdfFinish(f);
}

// PrincipledMaterial: metal, glass and dielectric (specular over diffuse), blended.
void buildPrincipledBSDF(in ivec4 m0, in ivec4 m1, in ivec4 m2, in vec4 rd, in vec4 normal, in vec2 UV,
    inout BSDF f, out vec3 emission)
{
    vec3 V = normalize(-rd.xyz), N = normalize(normal.xyz);
    bool backside = dot(V, N) < 0.0;
    if (backside)
        N = -N;
    float mu = min(1.0, abs(dot(V, N)));

    vec3  base         = getMaterialColor(m0[1], UV);
    float metallic     = clamp(getMaterialColor(m0[2], UV).r, 0.0, 1.0);
    float roughness    = clamp(getMaterialColor(m0[3], UV).r, 0.0, 1.0);
    float ior          = max(getMaterialColor(m1[0], UV).r, 1.0001);
    float transmission = clamp(getMaterialColor(m1[1], UV).r, 0.0, 1.0);
    emission           = getMaterialColor(m1[2], UV);
    int tableSpecular = m1[3], tableFront = m2[0], tableBack = m2[1];

    bsdfInit(f, N, V);
    float alpha = roughness * roughness;
    bool isSmooth = alpha < 1e-3;
    f.alpha = max(alpha, 1e-4);
    float wMetal = metallic, wGlass = (1.0 - metallic) * transmission, wDielectric = (1.0 - metallic) * (1.0 - transmission);

    if (wMetal > 0.0) {
        if (isSmooth)
            f.mirror += fresnelSchlick(mu, base) * wMetal;
        else {
            f.cond = vec3(wMetal);
            f.F0 = base;
            // Kulla-Conty: return the energy single scattering loses, tinted by repeated Fresnel.
            f.msEavg = albedoAverage(0, alpha);
            f.msEo = albedoLookup(0, mu, alpha);
            vec3 Favg = base + (1.0 - base) / 21.0;
            f.ms = Favg * Favg * f.msEavg / (1.0 - Favg * (1.0 - f.msEavg)) * wMetal;
            f.sw[5] = average(f.ms) * (1.0 - f.msEo);
            if (f.sw[5] <= 0.0)
                f.ms = vec3(0.0);
        }
    }
    if (wGlass > 0.0) {
        // Entering from the front the far side is the dense one; from the back it's air.
        float etap = backside ? 1.0 / ior : ior;
        if (isSmooth) {
            f.smR = vec3(wGlass);
            f.smT = base * wGlass;
            f.smEta = 1.0 / etap;
        }
        else {
            // Turquin: scale by 1 / E(mu_o), the lobe's albedo from this side.
            float k = 1.0 / max(0.05, albedoLookup(backside ? tableBack : tableFront, mu, alpha));
            f.dR[0] = vec3(wGlass * k);
            f.dT[0] = base * wGlass * k;
            f.dEtap[0] = etap;
            f.sw[6] = wGlass;
        }
    }
    if (wDielectric > 0.0) {
        // Opaque: two-sided, entering the dense side whichever side is hit. The diffuse base only gets
        // the light the specular layer doesn't reflect.
        float E = isSmooth ? fresnelDielectric(mu, 1.0 / ior) : albedoLookup(tableSpecular, mu, alpha);
        if (isSmooth)
            f.mirror += vec3(E * wDielectric);
        else if (E > 0.0) {
            f.dR[1] = vec3(wDielectric);
            f.dEtap[1] = ior;
            f.sw[7] = wDielectric * E;
        }
        f.lamb = base * wDielectric * (1.0 - E);
    }
    bsdfFinish(f);
}

// A Principled material's shading normal with its normal map (as PrincipledMaterial.shadingNormal): the map's x and y
// along the tangent and bitangent, z along the normal. Kept to the viewer's side of the surface: where the tilted
// normal would face away while the surface faces the viewer (grazing angles), the surface's own normal is used.
vec4 principledShadingNormal(in int mapIndex, in int scaleIndex, in vec4 direction, in GeometricMaterialData geodata) {
    vec3 N = normalize(geodata.normal.xyz), T = geodata.tangent.xyz - N * dot(N, geodata.tangent.xyz);
    if (geodata.tangent.w == 0.0 || dot(T, T) < 1e-24)
        return vec4(N, 0);
    T = normalize(T);
    vec3 B = cross(N, T) * geodata.tangent.w;
    vec3 c = getMaterialColor(mapIndex, geodata.UV) * 2.0 - 1.0;
    c.xy *= getMaterialColor(scaleIndex, geodata.UV).r;
    vec3 n = T * c.x + B * c.y + N * c.z;
    if (dot(n, n) < 1e-24)
        return vec4(N, 0);
    n = normalize(n);
    vec3 V = -direction.xyz;
    return dot(n, V) * dot(N, V) > 0.0 ? vec4(n, 0) : vec4(N, 0);
}

// ---- Generic: the surface interface (see materials.glsl) when BSDFs are compiled in ----
// In path tracing every material is a BSDF: the integrator samples lights directly (with MIS), and the BSDF
// chooses one direction to continue the path. In Whitted mode the legacy Phong materials keep their original
// shading (PhongSurface), and other BSDFs get direct light plus their delta directions.
#define SURFACE_NONE  0
#define SURFACE_PHONG 1
#define SURFACE_BSDF  2
int gSurfaceKind = SURFACE_NONE;
PhongSurface gPhongSurface;
BSDF gBSDF;
float gSurfaceEmitterPdf = 0.0;

vec3 materialSurface(in int materialID, in vec4 rp, in Ray r, in GeometricMaterialData geodata) {
    ivec4 m0, m1, m2;
    getMaterialIndices(materialID, m0, m1, m2);
    int type = m0[0];
    vec3 emission;
    if (type == MATERIAL_TYPE_PRINCIPLED)
        buildPrincipledBSDF(m0, m1, m2, r.d, m2[3] > 0 ? principledShadingNormal(m2[2], m2[3] - 1, r.d, geodata) : geodata.normal,
                            geodata.UV, gBSDF, emission);
    else {
        PhongMaterialParameters matParams;
        getPhongMaterialParameters(materialID, geodata, matParams);
#ifdef PATH_TRACING
        if (type == MATERIAL_TYPE_EMITTER) {
            // A light's surface: it emits, and reflects nothing. Light sampling (sampleLight) picks points on it
            // uniformly by area; the integrator needs that density, per solid angle from r's origin, for MIS.
            vec3 delta = rp.xyz - r.o.xyz;
            float cosLight = abs(dot(normalize(r.d.xyz), normalize(geodata.normal.xyz)));
            float area = getMaterialColor(m2[1], geodata.UV).r;
            gSurfaceEmitterPdf = cosLight > 0.0 ? dot(delta, delta) / (area * cosLight) : 1e30;
            return matParams.ambient;
        }
        buildPhongBSDF(type, matParams, r.d, geodata.normal, gBSDF);
        emission = matParams.ambient;
#else
        gPhongSurface = phongSurface(matParams, r.d, geodata.normal);
        gSurfaceKind = SURFACE_PHONG;
        return matParams.ambient;
#endif
    }
    gSurfaceKind = SURFACE_BSDF;
    return emission;
}
void surfaceClear() {
    gSurfaceKind = SURFACE_NONE;
    gSurfaceEmitterPdf = 0.0;
}
float surfaceEmitterPdf() {
    return gSurfaceEmitterPdf;
}
// A BSDF made only of delta lobes (a mirror, smooth glass) can't reflect a light sample: it only ever sees
// lights through the rays it chooses.
bool surfaceWantsDirectLight() {
    return gSurfaceKind == SURFACE_PHONG || (gSurfaceKind == SURFACE_BSDF && gBSDF.hasNonDelta);
}
vec3 surfaceEval(in vec4 lightDirection, out float pdf, out float cosFactor) {
    if (gSurfaceKind == SURFACE_PHONG) {
        pdf = 0.0;
        cosFactor = 1.0;
        return phongEval(gPhongSurface, lightDirection);
    }
    vec3 wi = normalize(lightDirection.xyz);
    cosFactor = abs(dot(gBSDF.n, wi));
    return bsdfEval(gBSDF, wi, pdf);
}
void surfaceSampleNextRays(inout vec2 random_seed, inout RecursiveNextRays nextRays) {
    if (gSurfaceKind == SURFACE_PHONG) {
        phongSampleNextRays(gPhongSurface, random_seed, nextRays);
        return;
    }
    if (gSurfaceKind != SURFACE_BSDF)
        return;
#ifdef PATH_TRACING
    BSDFSample s = bsdfSample(gBSDF, random_seed, false);
#else
    BSDFSample s = bsdfSample(gBSDF, random_seed, true);
#endif
    if (s.ok) {
        nextRays.reflectionProbability = 1.0;
        nextRays.reflectionDirection = vec4(s.wi, 0.0);
        nextRays.reflectionColor = s.weight;
        nextRays.reflectionExact = s.delta;
        nextRays.pdf = s.pdf;
    }
}
