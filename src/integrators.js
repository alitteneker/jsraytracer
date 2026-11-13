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
// (Material.prefersPathTracing), which keeps every existing scene rendering the way it was designed to.

class Integrator {
    static create(name, world) {
        if (name == "auto")
            name = world.anyMaterial(m => m.prefersPathTracing) ? "path" : "whitted";
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
        return { data: data, material: intersection.object.material };
    }
    isShadowed(position, direction) {
        const shadowDist = this.world.cast(new Ray(position, direction), 0.0001, 1, false).distance;
        return shadowDist > 0 && shadowDist < 1;
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

    radiance(ray, maxDepth) {
        let L = [0, 0, 0], beta = [1, 1, 1];
        let prevDelta = true, prevPdf = 0, minDistance = 0;
        const add = (c, w = 1) => { for (let i = 0; i < 3; ++i) L[i] += beta[i] * c[i] * w; };

        for (let depth = 0; depth < maxDepth; ++depth) {
            const hit = this.hit(ray, minDistance);
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
                        if (this.isShadowed(data.position, s.direction))
                            continue;
                        const wi = s.direction.normalized();
                        const f = bsdf.eval(wo, wi);
                        if (BSDFMath.isBlack(f))
                            continue;
                        const cos = Math.abs(bsdf.n[0] * wi[0] + bsdf.n[1] * wi[1] + bsdf.n[2] * wi[2]);
                        const w = s.delta || PathIntegrator.STRATEGY == "light" ? 1 : PathIntegrator.powerHeuristic(s.count, s.pdf, 1, bsdf.pdf(wo, wi));
                        const k = cos * w / s.count;
                        add([f[0] * s.value[0] * k, f[1] * s.value[1] * k, f[2] * s.value[2] * k]);
                    }
                }
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
