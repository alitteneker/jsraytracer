// node tests/bsdf_checks/mis.js [material] [batches] [spp]
// Renders a small scene three ways: light sampling only, BSDF sampling only, and both combined with MIS. They must
// converge to the same image, so their means should agree within a few standard errors (|z| < 3). This checks every
// pdf involved: the lights' solid angle densities and the BSDFs'. Run without a material name to test all of them.
const fs = require("fs"), vm = require("vm"), path = require("path");
const src = path.join(__dirname, "..", "..", "src");
for (const f of ['math.js','world.js','geometry.js','bsdf.js','materials.js','cameras.js','renderers.js','integrators.js','lights.js','aggregates.js'])
    vm.runInThisContext(fs.readFileSync(path.join(src, f)).toString(), { filename: f });
const materials = {
    diffuse:     () => new PhongPathTracingMaterial(Vec.of(0.8, 0.6, 0.4), 0, 0.9),
    glossy:      () => new PhongPathTracingMaterial(Vec.of(1, 1, 1), 0, 0.3, 0.6, 20),
    glass:       () => new PhongPathTracingMaterial(Vec.of(1, 1, 1), 0, 0, 0, 0, 1.5, 1.0),
    frosted:     () => new PhongPathTracingMaterial(Vec.of(1, 1, 1), 0, 0.1, 0.9, 10, 2),
    plastic:     () => new PrincipledMaterial({ baseColor: Vec.of(0.8, 0.3, 0.2), roughness: 0.4 }),
    roughMetal:  () => new PrincipledMaterial({ baseColor: Vec.of(0.95, 0.7, 0.4), metallic: 1, roughness: 0.5 }),
    roughGlass:  () => new PrincipledMaterial({ baseColor: Vec.of(1, 1, 1), transmission: 1, roughness: 0.3 }),
    smoothMetal: () => new PrincipledMaterial({ baseColor: Vec.of(0.9, 0.9, 0.9), metallic: 1, roughness: 0 }),
};
const [kindArg, batchesArg, sppArg] = process.argv.slice(2);
const B = +(batchesArg || 8), S = +(sppArg || 24), N = 16;
for (const kind of kindArg ? [kindArg] : Object.keys(materials)) {
    const floor = new Primitive(new Plane(), new PhongPathTracingMaterial(Vec.of(0.7, 0.7, 0.7), 0, 0.8),
        Mat4.translation([0, -1, 0]).times(Mat4.rotation(-Math.PI / 2, Vec.of(1, 0, 0))));
    const ball = new Primitive(new Sphere(), materials[kind](), Mat4.translation([0, 0, -3]));
    // A big area light, so BSDF sampling finds it often enough to converge.
    const light = new RandomSampleAreaLight(new Square(),
        Mat4.translation([0, 3, -2]).times(Mat4.rotation(Math.PI / 2, Vec.of(1, 0, 0))).times(Mat4.scale([6, 6, 1])),
        Vec.of(1, 1, 1), 40, 1);
    const world = new World([floor, ball, light], [], Vec.of(0.05, 0.05, 0.08));
    const camera = new PerspectiveCamera(Math.PI / 4, 1, Mat4.translation([0, 0.3, 2]));
    const integ = new PathIntegrator(world), result = {};
    for (const strategy of ["mis", "light", "bsdf"]) {
        PathIntegrator.STRATEGY = strategy;
        const means = [];
        for (let b = 0; b < B; ++b) {
            let sum = 0;
            for (let py = 0; py < N; ++py)
                for (let px = 0; px < N; ++px)
                    for (let s = 0; s < S; ++s) {
                        const v = integ.radiance(camera.getRayForPixel(2 * ((px + Math.random()) / N) - 1, -2 * ((py + Math.random()) / N) + 1), 8);
                        sum += (v[0] + v[1] + v[2]) / 3;
                    }
            means.push(sum / (N * N * S));
        }
        const m = means.reduce((a, x) => a + x) / B;
        result[strategy] = { mean: m, se: Math.sqrt(means.reduce((a, x) => a + (x - m) ** 2, 0) / (B - 1) / B) };
    }
    PathIntegrator.STRATEGY = "mis";
    const z = (a, b) => (result[a].mean - result[b].mean) / Math.hypot(result[a].se, result[b].se);
    console.log(kind.padEnd(12), Object.entries(result).map(([k, v]) => `${k} ${v.mean.toFixed(5)}±${v.se.toFixed(5)}`).join("  "),
        ` z(light-mis)=${z("light", "mis").toFixed(2)} z(bsdf-mis)=${z("bsdf", "mis").toFixed(2)}`);
}
