// node tests/bsdf_checks/multiscatter.js
const fs = require("fs"), vm = require("vm"), path = require("path");
const src = path.join(__dirname, "..", "..", "src");
for (const f of ['math.js', 'bsdf.js']) vm.runInThisContext(fs.readFileSync(path.join(src, f)).toString(), { filename: f });
// Albedo of single-scattering conductor + multiscatter lobe, white F0 = 1: should be 1 for every mu and alpha.
const t0 = Date.now(); const table = AlbedoTable.whiteConductor(); console.log(`table built in ${Date.now() - t0} ms`);
const rows = [];
for (const a of [0.1, 0.3, 0.6, 1.0]) {
    const ss = new MicrofacetConductorLobe(new GGX(a), [1, 1, 1]), ms = new MultiscatterLobe(a, table);
    const cells = [];
    for (const mu of [1, 0.7, 0.3, 0.1]) {
        const wo = [Math.sqrt(1 - mu * mu), 0, mu];
        let e1 = 0, e2 = 0; const N = 100000;
        for (let i = 0; i < N; ++i) {
            const s = ss.sample(wo, Math.random(), Math.random());
            if (s) e1 += ss.eval(wo, s.wi)[0] * s.wi[2] / s.pdf;
            const t = ms.sample(wo, Math.random(), Math.random());
            e2 += ms.eval(wo, t.wi) * t.wi[2] / t.pdf;
        }
        cells.push(`mu=${mu}: ${(e1 / N).toFixed(3)} + ${(e2 / N).toFixed(3)} = ${((e1 + e2) / N).toFixed(3)}`);
    }
    console.log(`alpha ${a} (Eavg ${ms.Eavg.toFixed(3)}):  ` + cells.join("   "));
}
