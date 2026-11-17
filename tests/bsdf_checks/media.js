// node tests/bsdf_checks/media.js
// Checks the participating media (src/media.js) and how the path integrator uses them:
//   transmittance  ratio tracking and delta tracking against the transmittance computed by quadrature, through a
//                  constant grid, a varying grid and a homogeneous sphere, and across many majorant cells (whose
//                  bounds are checked too)
//   furnace        a medium that scatters all it absorbs (albedo 1), under a white sky, disappears: every pixel is 1
//   mis            a lit medium rendered with light sampling, phase function sampling and MIS: all three agree
const fs = require("fs"), vm = require("vm"), path = require("path");
const src = path.join(__dirname, "..", "..", "src");
for (const f of ['math.js','world.js','geometry.js','bsdf.js','materials.js','cameras.js','renderers.js','integrators.js','lights.js','media.js','aggregates.js'])
    vm.runInThisContext(fs.readFileSync(path.join(src, f)).toString(), { filename: f });

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
    if (!ok) ++failures;
};
const meanAndError = (n, f) => {
    let s = 0, s2 = 0;
    for (let i = 0; i < n; ++i) { const v = f(); s += v; s2 += v * v; }
    const m = s / n;
    return [m, Math.sqrt(Math.max(0, s2 / n - m * m) / n)];
};

// A small grid over [-1, 1]^3 whose values come from f(x, y, z), stored as the converter would.
const makeGrid = (n, f) => {
    const max = 1.5, codes = new Uint8Array(n * n * n);
    for (let z = 0; z < n; ++z) for (let y = 0; y < n; ++y) for (let x = 0; x < n; ++x) {
        const p = [x, y, z].map(i => -1 + (i + 0.5) * 2 / n);
        codes[(z * n + y) * n + x] = Math.round(Math.sqrt(Math.min(1, f(...p) / max)) * 255);
    }
    return new VoxelGrid({ dims: [n, n, n], bounds: { min: [-1, -1, -1], max: [1, 1, 1] }, max: max }, codes);
};
const quadrature = (medium, local, t0, t1, steps = 4000) => {
    let tau = 0;
    const dt = (t1 - t0) / steps, speed = local.direction.norm();
    for (let i = 0; i < steps; ++i)
        tau += medium.densityAt(local.getPoint(t0 + (i + 0.5) * dt)) * speed * dt;
    return Math.exp(-tau);
};

for (const [name, medium] of [
    ["constant grid", new GridMedium(makeGrid(8, () => 1.5), { density: 0.6 })],
    ["varying grid", new GridMedium(makeGrid(16, (x, y, z) => 0.75 * (1 + Math.sin(3 * x) * Math.cos(2 * y + z))), { density: 1.3 })],
    ["homogeneous sphere", new HomogeneousMedium({ shape: "sphere", density: 0.8 })]]) {
    const ray = new Ray(Vec.of(-3, 0.2, -0.1, 1), Vec.of(1.5, -0.05, 0.08, 0));
    const [t0, t1] = Volume.interval(medium, ray, 0, Infinity);
    const exact = quadrature(medium, ray, t0, t1);
    const [ratio, ratioErr] = meanAndError(40000, () => Volume.transmittance(medium, ray, t0, t1));
    const [pass, passErr] = meanAndError(40000, () => Volume.sampleCollision(medium, ray, t0, t1) === null ? 1 : 0);
    const z1 = (ratio - exact) / Math.max(ratioErr, 1e-9), z2 = (pass - exact) / passErr;
    check(`transmittance, ${name}`, Math.abs(z1) < 4 && Math.abs(z2) < 4,
        `quadrature ${exact.toFixed(4)}, ratio tracking ${ratio.toFixed(4)} (z ${z1.toFixed(2)}), delta tracking passes ${pass.toFixed(4)} (z ${z2.toFixed(2)})`);
}

// A larger grid, so tracking crosses many majorant cells (VoxelGrid.traverse): a dense blob in mostly empty space,
// along rays in assorted directions, including ones parallel to the axes and going backwards.
{
    const medium = new GridMedium(makeGrid(44, (x, y, z) => 1.5 * Math.exp(-12 * ((x - 0.3) ** 2 + (y + 0.2) ** 2 + z * z)) + 0.1 * (x > 0.6)), { density: 2.5 });
    const grid = medium.grid;
    // Every interpolated value must be within its cell's majorant.
    let worst = 0;
    for (let k = 0; k < 20000; ++k) {
        const p = Vec.of(...[0, 1, 2].map(() => -1 + 2 * Math.random()));
        const c = [0, 1, 2].map(i => Math.min(grid.majorantDims[i] - 1, Math.floor((p[i] + 1) / (grid.voxelSize[i] * VoxelGrid.MAJORANT_CELL))));
        const code = grid.majorantCodes[(c[2] * grid.majorantDims[1] + c[1]) * grid.majorantDims[0] + c[0]];
        worst = Math.max(worst, grid.codeAt(p) - code);
    }
    check("majorant cells bound the grid", worst <= 1e-9, `largest excess of an interpolated byte over its cell's ${worst.toFixed(6)}`);
    let ok = true;
    const details = [];
    for (const [o, d] of [[[-3, -0.2, 0.05], [1, 0, 0]], [[2, 2.5, -2], [-0.6, -1, 0.7]], [[0.3, -0.2, 3], [0, 0, -1]], [[-2, -2, -2], [1, 1.1, 0.9]]]) {
        const ray = new Ray(Vec.of(...o, 1), Vec.of(...d, 0));
        const iv = Volume.interval(medium, ray, 0, Infinity);
        if (!iv) { ok = false; details.push("missed"); continue; }
        const exact = quadrature(medium, ray, iv[0], iv[1], 20000);
        const [ratio, re] = meanAndError(20000, () => Volume.transmittance(medium, ray, iv[0], iv[1]));
        const [pass, pe] = meanAndError(20000, () => Volume.sampleCollision(medium, ray, iv[0], iv[1]) === null ? 1 : 0);
        const z1 = (ratio - exact) / Math.max(re, 1e-9), z2 = (pass - exact) / Math.max(pe, 1e-9);
        ok = ok && Math.abs(z1) < 4 && Math.abs(z2) < 4;
        details.push(`${exact.toFixed(3)}: ${ratio.toFixed(3)} (z ${z1.toFixed(1)}), ${pass.toFixed(3)} (z ${z2.toFixed(1)})`);
    }
    check("transmittance across many majorant cells", ok, details.join("; "));
}

const camera = new PerspectiveCamera(Math.PI / 4, 1, Mat4.translation([0, 0, 4]));
const pixels = (world, n, spp, depth = 64) => {
    const integ = new PathIntegrator(world);
    return meanAndError(n * spp, () => {
        const v = integ.radiance(camera.getRayForPixel(2 * Math.random() - 1, 2 * Math.random() - 1), depth);
        return (v[0] + v[1] + v[2]) / 3;
    });
};

for (const [name, medium] of [
    ["furnace, homogeneous sphere", new HomogeneousMedium({ shape: "sphere", density: 3, albedo: 1, g: 0.6 })],
    ["furnace, grid", new GridMedium(makeGrid(16, (x, y, z) => 1.5 * Math.max(0, 1 - Math.hypot(x, y, z))), { density: 4, albedo: 1, g: -0.3 })]]) {
    const world = new World([new Volume(medium, Mat4.scale(1.2))], [], Vec.of(1, 1, 1));
    const [m, e] = pixels(world, 40, 100);
    check(name, Math.abs(m - 1) < Math.max(4 * e, 0.002), `mean ${m.toFixed(4)} +- ${e.toFixed(4)} (expect 1)`);
}

{
    const medium = new HomogeneousMedium({ shape: "sphere", density: 1.5, albedo: Vec.of(0.9, 0.7, 0.5), g: 0.4 });
    const light = new RandomSampleAreaLight(new Square(),
        Mat4.translation([0, 2.5, 0]).times(Mat4.rotation(Math.PI / 2, Vec.of(1, 0, 0))).times(Mat4.scale([3, 3, 1])),
        Vec.of(1, 1, 1), 60, 1);
    const world = new World([new Volume(medium), light], [], Vec.of(0, 0, 0));
    const result = {};
    for (const strategy of ["mis", "light", "bsdf"]) {
        PathIntegrator.STRATEGY = strategy;
        result[strategy] = pixels(world, 40, 200, 16);
    }
    PathIntegrator.STRATEGY = "mis";
    const z = (a, b) => (result[a][0] - result[b][0]) / Math.hypot(result[a][1], result[b][1]);
    check("mis, lit medium", Math.abs(z("light", "mis")) < 4 && Math.abs(z("bsdf", "mis")) < 4,
        Object.entries(result).map(([k, v]) => `${k} ${v[0].toFixed(5)}+-${v[1].toFixed(5)}`).join("  ")
        + `  z(light-mis) ${z("light", "mis").toFixed(2)}  z(phase-mis) ${z("bsdf", "mis").toFixed(2)}`);
}

process.exit(failures ? 1 : 0);
