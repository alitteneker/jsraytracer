// Integrators: how light is transported through the scene. Materials only describe surfaces (Material.surface
// returns an emission and a BSDF, see src/bsdf.js); everything about sampling lights, casting shadow rays and
// continuing paths lives here.
//
// Two integrators:
//   WhittedIntegrator: direct light from every light at every hit, plus recursion along every perfectly specular
//       (delta) direction: mirrors, refraction, pass-through transparency. Deterministic, and with the legacy Phong
//       materials it reproduces the original renderer exactly.
//   PathIntegrator: unbiased path tracing. One BSDF-sampled continuation per bounce, direct light from every light
//       at every hit (next-event estimation), the two combined with multiple importance sampling, and Russian
//       roulette to end paths.
// Renderers pick one with Integrator.create(name, world); "auto" uses path tracing when any material asks for it
// (Material.prefersPathTracing), or the world has volumes, which keeps every existing scene rendering the way it was
// designed to. Volumes (participating media, src/media.js) are only seen by the path integrator.

class Integrator {
    static create(name, world) {
        if (name == "auto")
            name = world.volumes.length || world.anyMaterial(m => m.prefersPathTracing) ? "path" : "whitted";
        if (name == "whitted") return new WhittedIntegrator(world);
        if (name == "path")    return new PathIntegrator(world);
        throw "Unknown integrator " + name;
    }
    constructor(world) {
        this.world = world;
    }
    // The surface hit by a ray: { light } for a light, { data, material } for a primitive, or null for a miss.
    hit(ray, minDistance) {
        const intersection = this.world.cast(ray, minDistance);
        if (intersection.object == null)
            return null;
        let ancestorInvTransform = Mat4.identity();
        for (let i = 0; i < intersection.ancestors.length; ++i)
            ancestorInvTransform = intersection.ancestors[i].getInvTransform().times(ancestorInvTransform);
        if (intersection.object instanceof Light)
            return { light: intersection.object, distance: intersection.distance, ancestorInvTransform: ancestorInvTransform };
        const data = intersection.object.surfaceData(ray, intersection.distance, ancestorInvTransform);
        return { data: data, material: intersection.object.material, distance: intersection.distance };
    }
    isShadowed(position, direction) {
        const shadowDist = this.world.cast(new Ray(position, direction), 0.0001, 1, false).distance;
        return shadowDist > 0 && shadowDist < 1;
    }
    // The fraction of light that reaches position from position + direction: 0 if a surface is in the way, otherwise
    // the transmittance of the volumes between.
    shadowTransmittance(position, direction) {
        if (this.isShadowed(position, direction))
            return 0;
        return this.world.volumes.length ? this.transmittance(new Ray(position, direction), 0.0001, 1) : 1;
    }
    // The pieces of a ray inside volumes, between tMin and tMax, nearest first: [{ medium, local, t0, t1 }].
    volumeSegments(ray, tMin, tMax) {
        const segments = [];
        for (const instance of this.world.volumes) {
            const medium = instance.object.medium, local = ray.getTransformed(instance.getInvTransform());
            const interval = Volume.interval(medium, local, tMin, tMax);
            if (interval)
                segments.push({ medium: medium, local: local, t0: interval[0], t1: interval[1], detInv: Integrator.detInv(instance) });
        }
        return segments.sort((a, b) => a.t0 - b.t0);
    }
    // Where light traveling along ray first scatters in a volume before tMax: { position, medium }, or null if it
    // reaches tMax (where the surface is) without interacting. Each volume's chance of letting it through is its
    // transmittance, so a path that gets through carries no extra weight.
    // Light emitted by glowing media along the way (up to the collision, if any) is added to `emitted`. misPdf: the
    // solid angle density the ray's direction was sampled with, if its origin also sampled glowing media as lights
    // (PathIntegrator.volumeLight); then each bit of glow is weighed by MIS against that, and 0 means it counts fully.
    mediumScatter(ray, tMin, tMax, emitted = null, misPdf = 0) {
        const worldSpeed = ray.direction.norm();
        for (const seg of this.volumeSegments(ray, tMin, tMax)) {
            const medium = seg.medium;
            let weightAt = null;
            if (emitted && misPdf > 0 && medium.emissive && PathIntegrator.STRATEGY != "bsdf") {
                const detInv = seg.detInv, localPerWorld = seg.local.direction.norm() / worldSpeed;
                weightAt = PathIntegrator.STRATEGY == "light" ? () => 0 : (p, t, majorant) => {
                    const r = t * worldSpeed;
                    return PathIntegrator.powerHeuristic(1, misPdf * majorant * localPerWorld / (r * r), 1, medium.emissionPdf(p) * detInv);
                };
            }
            const t = Volume.sampleCollision(medium, seg.local, seg.t0, seg.t1, emitted, weightAt);
            if (t !== null)
                return { position: ray.getPoint(t), medium: medium };
        }
        return null;
    }
    // How much a volume's transform shrinks volume, world to local: densities per unit of local volume times this are
    // per unit of world volume.
    static detInv(instance) {
        const m = instance.getInvTransform();
        return Math.abs(m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                      + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]));
    }
    transmittance(ray, tMin, tMax) {
        let T = 1;
        for (const seg of this.volumeSegments(ray, tMin, tMax)) {
            T *= Volume.transmittance(seg.medium, seg.local, seg.t0, seg.t1);
            if (T == 0)
                break;
        }
        return T;
    }
}

class WhittedIntegrator extends Integrator {
    // depth: how many surfaces may still be hit (the camera ray's hit counts), as in the original World.color.
    radiance(ray, depth, minDistance = 0) {
        if (!depth)
            return Vec.of(0, 0, 0);
        const hit = this.hit(ray, minDistance);
        if (!hit)
            return this.world.bg_color;
        if (hit.light)
            return hit.light.color(ray, hit.distance, hit.ancestorInvTransform, this.world, depth - 1, true);

        const { emission, bsdf } = hit.material.surface(hit.data);
        let color = emission || Vec.of(0, 0, 0);
        if (!bsdf)
            return color;
        const data = hit.data, wo = data.ray.direction.normalized().times(-1);

        // Direct light: every sample of every light, averaged per light.
        if (bsdf.hasNonDelta || bsdf.whittedDirect !== BSDF.prototype.whittedDirect) {
            for (const light of this.world.lights) {
                let count = 0, sum = Vec.of(0, 0, 0);
                for (const light_sample of light.sampleIterator(data.position)) {
                    ++count;
                    if (this.isShadowed(data.position, light_sample.direction))
                        continue;
                    sum = sum.plus(bsdf.whittedDirect(light_sample, wo));
                }
                if (count > 0)
                    color = color.plus(sum.times(1 / count));
            }
        }

        // Every perfectly specular direction.
        for (const d of bsdf.deltaDirections(wo))
            color = color.plus(this.radiance(new Ray(data.position, d.wi), depth - 1, 0.0001).mult_pairs(Vec.from(d.weight)));
        return color;
    }
}

class PathIntegrator extends Integrator {
    // Paths survive at least this many bounces before Russian roulette may end them.
    static RR_MIN_DEPTH = 3;
    // For testing: "mis" (normal), "light" (light sampling only; lights found by BSDF sampling are ignored unless the
    // bounce was a delta) or "bsdf" (BSDF sampling only; no shadow rays). All three converge to the same image, so
    // comparing them checks every pdf involved.
    static STRATEGY = "mis";

    // Power heuristic (beta = 2) MIS weight for a strategy with nf samples at density fPdf, against one with ng
    // samples at density gPdf.
    static powerHeuristic(nf, fPdf, ng, gPdf) {
        const f = nf * fPdf, g = ng * gPdf;
        return (f * f) / (f * f + g * g);
    }

    // Direct light from glowing volumes at P: one point sampled in each (sampleEmissionPoint), its glow sigma_a * Le
    // carried back through whatever lies between, and response(wi) giving the BSDF times cosine (or the phase function)
    // toward it, as { f, pdf }. Weighed by MIS against finding the same glow along a ray response's sampling would cast:
    // that ray's tentative collisions come at the majorant's rate, so its density for reaching x is the direction's pdf
    // times majorant / r^2, times the transmittance to x. That last factor is left out, here and in mediumScatter
    // alike: MIS stays unbiased with any weights that add up to 1, and near P, where 1 / r^2 would make light sampling's
    // variance infinite, the path's weight goes to 1 and takes over.
    volumeLight(P, response) {
        const sum = [0, 0, 0];
        for (const instance of this.world.volumes) {
            const medium = instance.object.medium;
            if (!medium.emissive)
                continue;
            const s = medium.sampleEmissionPoint();
            if (!s)
                continue;
            const E = medium.emittedAt(s.p);
            if (!(E[0] > 0 || E[1] > 0 || E[2] > 0))
                continue;
            const x = instance.getTransform().times(s.p), dir = Vec.of(x[0] - P[0], x[1] - P[1], x[2] - P[2], 0);
            const r2 = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2], wi = dir.times(1 / Math.sqrt(r2));
            const { f, pdf } = response(wi);
            if (!(f[0] > 0 || f[1] > 0 || f[2] > 0))
                continue;
            const T = this.shadowTransmittance(P, dir);
            if (!T)
                continue;
            // Densities are per unit of the volume's own length: along wi, a world unit is localPerWorld of those (so a
            // stretched volume is thinner along its stretch), which scales both the glow and the majorant.
            const detInv = Integrator.detInv(instance), pL = s.pdf * detInv;
            const localPerWorld = instance.getInvTransform().times(wi).norm();
            const pB = pdf * medium.majorantAt(s.p) * localPerWorld / r2;
            const w = PathIntegrator.STRATEGY == "light" ? 1 : PathIntegrator.powerHeuristic(1, pL, 1, pB);
            for (let k = 0; k < 3; ++k)
                sum[k] += f[k] * E[k] * localPerWorld * T * w / (r2 * pL);
        }
        return sum;
    }

    radiance(ray, maxDepth) {
        let L = [0, 0, 0], beta = [1, 1, 1];
        let prevDelta = true, prevPdf = 0, minDistance = 0;
        const add = (c, w = 1) => { for (let i = 0; i < 3; ++i) L[i] += beta[i] * c[i] * w; };

        for (let depth = 0; depth < maxDepth; ++depth) {
            const hit = this.hit(ray, minDistance);

            // Light may scatter in a volume before reaching the surface (or escaping), and then the path continues
            // from there: next-event estimation with the phase function in place of the BSDF, then a direction
            // sampled from the phase function (whose weight is exactly 1, so only the albedo changes beta).
            const emitted = Vec.of(0, 0, 0);
            const scatter = this.world.volumes.length
                ? this.mediumScatter(ray, minDistance, hit ? hit.distance : Infinity, emitted, prevDelta ? 0 : prevPdf) : null;
            if (emitted[0] || emitted[1] || emitted[2])
                add(emitted, 1);
            if (scatter) {
                const medium = scatter.medium, P = scatter.position, d = ray.direction.normalized();
                for (let i = 0; i < 3; ++i) beta[i] *= medium.albedo[i];
                if (PathIntegrator.STRATEGY != "bsdf") {
                    for (const light of this.world.lights) {
                        for (const ls of light.sampleLi(P)) {
                            const T = this.shadowTransmittance(P, ls.direction);
                            if (!T)
                                continue;
                            const phase = HenyeyGreenstein.eval(medium.g, d.dot(ls.direction.normalized()));
                            const w = ls.delta || PathIntegrator.STRATEGY == "light" ? 1 : PathIntegrator.powerHeuristic(ls.count, ls.pdf, 1, phase);
                            add(ls.value, phase * T * w / ls.count);
                        }
                    }
                    add(this.volumeLight(P, wi => { const phase = HenyeyGreenstein.eval(medium.g, d.dot(wi)); return { f: [phase, phase, phase], pdf: phase }; }));
                }
                const ps = HenyeyGreenstein.sample(medium.g, d);
                prevDelta = false;
                prevPdf = ps.pdf;
                ray = new Ray(P, ps.wi);
                minDistance = 0;
                if (depth + 1 >= PathIntegrator.RR_MIN_DEPTH) {
                    const q = Math.max(0.05, 1 - BSDFMath.maxComponent(beta));
                    if (Math.random() < q)
                        break;
                    for (let i = 0; i < 3; ++i) beta[i] /= (1 - q);
                }
                continue;
            }

            if (!hit) {
                add(this.world.bg_color);
                break;
            }

            // A light hit by the path. After a delta bounce (or from the camera) it couldn't have been found by light
            // sampling, so it counts fully; otherwise both strategies could have found it, and MIS splits the credit.
            if (hit.light) {
                const e = hit.light.emissionAt ? hit.light.emissionAt(ray, hit.distance, hit.ancestorInvTransform) : null;
                if (e) {
                    const strategy = PathIntegrator.STRATEGY;
                    const w = prevDelta || strategy == "bsdf" ? 1
                        : strategy == "light" ? 0 : PathIntegrator.powerHeuristic(1, prevPdf, e.count, e.pdf);
                    add(e.Le, w);
                }
                break;   // lights don't reflect
            }

            const data = hit.data;
            const { emission, bsdf } = hit.material.surface(data);
            if (emission)
                add(emission);
            if (!bsdf || bsdf.isEmpty)
                break;
            const wo = data.ray.direction.normalized().times(-1);

            // Next-event estimation: sample every light, weighted against the chance that BSDF sampling finds it.
            if (bsdf.hasNonDelta && PathIntegrator.STRATEGY != "bsdf") {
                for (const light of this.world.lights) {
                    for (const s of light.sampleLi(data.position)) {
                        const T = this.shadowTransmittance(data.position, s.direction);
                        if (!T)
                            continue;
                        const wi = s.direction.normalized();
                        const f = bsdf.eval(wo, wi);
                        if (BSDFMath.isBlack(f))
                            continue;
                        const cos = Math.abs(bsdf.n[0] * wi[0] + bsdf.n[1] * wi[1] + bsdf.n[2] * wi[2]);
                        const w = s.delta || PathIntegrator.STRATEGY == "light" ? 1 : PathIntegrator.powerHeuristic(s.count, s.pdf, 1, bsdf.pdf(wo, wi));
                        const k = cos * w * T / s.count;
                        add([f[0] * s.value[0] * k, f[1] * s.value[1] * k, f[2] * s.value[2] * k]);
                    }
                }
                add(this.volumeLight(data.position, wi => {
                    const f = bsdf.eval(wo, wi), cos = Math.abs(bsdf.n[0] * wi[0] + bsdf.n[1] * wi[1] + bsdf.n[2] * wi[2]);
                    return { f: [f[0] * cos, f[1] * cos, f[2] * cos], pdf: bsdf.pdf(wo, wi) };
                }));
            }

            // Continue the path in a direction chosen by the BSDF.
            const s = bsdf.sample(wo);
            if (!s)
                break;
            for (let i = 0; i < 3; ++i) beta[i] *= s.weight[i];
            prevDelta = s.delta;
            prevPdf = s.pdf;
            ray = new Ray(data.position, s.wi);
            minDistance = 0.0001;

            // Russian roulette: end dim paths at random, boosting the survivors so the estimate stays unbiased.
            if (depth + 1 >= PathIntegrator.RR_MIN_DEPTH) {
                const q = Math.max(0.05, 1 - BSDFMath.maxComponent(beta));
                if (Math.random() < q)
                    break;
                for (let i = 0; i < 3; ++i) beta[i] /= (1 - q);
            }
        }
        return Vec.of(L[0], L[1], L[2]);
    }
}
