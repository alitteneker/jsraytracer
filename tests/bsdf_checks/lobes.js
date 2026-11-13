// node tests/bsdf_checks/lobes.js
// For every lobe and several view angles: the albedo from the lobe's own importance sampling must match a
// brute-force integral over the sphere (checks sample() against eval()), and the integral of pdf() must match the
// fraction of sample() calls that succeed (checks that pdf() is the density sample() draws from).
// Lobe consistency tests: importance-sampled albedo vs uniform-sphere albedo, and pdf integral vs sample success rate.
const fs = require("fs"), vm = require("vm"), path = require("path");
const src = path.join(__dirname, "..", "..", "src");
for (const f of ['math.js', 'bsdf.js']) vm.runInThisContext(fs.readFileSync(path.join(src, f)).toString(), { filename: f });

function uniformSphere() {
    const z = 1 - 2 * Math.random(), r = Math.sqrt(Math.max(0, 1 - z * z)), phi = 2 * Math.PI * Math.random();
    return [r * Math.cos(phi), r * Math.sin(phi), z];
}
const avg = f => typeof f == "number" ? f : (f[0] + f[1] + f[2]) / 3;
function test(name, lobe, mu, N = 200000) {
    const wo = [Math.sqrt(1 - mu * mu), 0, mu];
    let sSum = 0, sSum2 = 0, ok = 0, pdfMismatch = 0;
    for (let i = 0; i < N; ++i) {
        const s = lobe.sample(wo, Math.random(), Math.random());
        if (!s) continue;
        ++ok;
        const p = lobe.pdf(wo, s.wi);
        if (Math.abs(p - s.pdf) > 1e-6 * Math.max(1, p)) ++pdfMismatch;
        const w = avg(lobe.eval(wo, s.wi)) * Math.abs(s.wi[2]) / p;
        sSum += w; sSum2 += w * w;
    }
    let uSum = 0, uSum2 = 0, pSum = 0;
    for (let i = 0; i < N; ++i) {
        const wi = uniformSphere();
        const v = avg(lobe.eval(wo, wi)) * Math.abs(wi[2]) * 4 * Math.PI;
        uSum += v; uSum2 += v * v;
        pSum += lobe.pdf(wo, wi) * 4 * Math.PI;
    }
    const eS = sSum / N, seS = Math.sqrt((sSum2 / N - eS * eS) / N);
    const eU = uSum / N, seU = Math.sqrt((uSum2 / N - eU * eU) / N);
    const z = (eS - eU) / Math.hypot(seS, seU);
    console.log(`${name.padEnd(34)} mu=${mu.toFixed(2)}  albedo(sampled)=${eS.toFixed(4)}  albedo(uniform)=${eU.toFixed(4)}±${seU.toFixed(4)}  z=${z.toFixed(2).padStart(6)}  ` +
        `pdf integral=${(pSum / N).toFixed(4)} success=${(ok / N).toFixed(4)}${pdfMismatch ? "  PDF MISMATCH " + pdfMismatch : ""}`);
}
const mus = [1, 0.7, 0.3, 0.1];
for (const a of [0.1, 0.3, 0.6, 1.0])
    for (const mu of mus) test(`conductor F0=1 alpha=${a}`, new MicrofacetConductorLobe(new GGX(a), [1, 1, 1]), mu);
for (const a of [0.15, 0.5])
    for (const mu of mus) test(`dielectric in  (etap 1.5) alpha=${a}`, new MicrofacetDielectricLobe(new GGX(a), 1.5), mu);
for (const a of [0.15, 0.5])
    for (const mu of mus) test(`dielectric out (etap 1/1.5) alpha=${a}`, new MicrofacetDielectricLobe(new GGX(a), 1 / 1.5), mu);
for (const a of [0.3])
    for (const mu of mus) test(`dielectric reflectOnly alpha=${a}`, new MicrofacetDielectricLobe(new GGX(a), 1.5, [1,1,1], [1,1,1], true), mu);
for (const a of [0.3])
    for (const mu of [0.7]) test(`anisotropic conductor ${a}x${a/4}`, new MicrofacetConductorLobe(new GGX(a, a / 4), [1, 1, 1]), mu);
