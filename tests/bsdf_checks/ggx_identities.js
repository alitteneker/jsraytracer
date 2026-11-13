// node tests/bsdf_checks/ggx_identities.js
// Microfacet identities, by quadrature over the hemisphere of facet normals m:
//   (1) projected area:           integral D(m) (m.n) dm = 1
//   (2) visible projected area:   integral G1(w) max(0, w.m) D(m) dm = w.n      (for any w)
const fs = require("fs"), vm = require("vm"), path = require("path");
const src = path.join(__dirname, "..", "..", "src");
for (const f of ['math.js', 'bsdf.js']) vm.runInThisContext(fs.readFileSync(path.join(src, f)).toString(), { filename: f });
const NT = 2000, NP = 400;
for (const [ax, ay] of [[0.1, 0.1], [0.5, 0.5], [1, 1], [0.6, 0.15]]) {
    const g = new GGX(ax, ay);
    for (const mu of [1, 0.5, 0.1]) {
        const w = [Math.sqrt(1 - mu * mu), 0, mu];
        let I1 = 0, I2 = 0;
        // Integrate in u = cos(theta) on a fine grid weighted toward the normal (D is peaked there for small alpha).
        for (let i = 0; i < NT; ++i) {
            const t = (i + 0.5) / NT, ct = 1 - t * t * t, dct = 3 * t * t / NT;   // cos theta from 1 down to 0
            const st = Math.sqrt(Math.max(0, 1 - ct * ct));
            for (let j = 0; j < NP; ++j) {
                const phi = 2 * Math.PI * (j + 0.5) / NP, m = [st * Math.cos(phi), st * Math.sin(phi), ct];
                const dA = dct * 2 * Math.PI / NP, D = g.D(m);
                I1 += D * ct * dA;
                I2 += g.G1(w) * Math.max(0, BSDFMath.dot(w, m)) * D * dA;
            }
        }
        console.log(`alpha ${ax}x${ay} mu=${mu}: integral D(m)(m.n) = ${I1.toFixed(4)} (expect 1),  integral G1 (w.m)+ D = ${I2.toFixed(4)} (expect ${mu})`);
    }
}
