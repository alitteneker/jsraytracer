// node tests/bsdf_checks/furnace.js
// White furnace: a unit sphere under a uniform white sky (background = 1), no lights. Reports the average radiance
// over the sphere's silhouette: 1 means the material neither gains nor loses energy (over one or more bounces).
const fs = require("fs"), vm = require("vm"), path = require("path");
const src = path.join(__dirname, "..", "..", "src");
for (const f of ['math.js','world.js','geometry.js','bsdf.js','materials.js','cameras.js','integrators.js','lights.js','aggregates.js'])
    vm.runInThisContext(fs.readFileSync(path.join(src, f)).toString(), { filename: f });
const W = Vec.of(1, 1, 1);
const cases = {
    "white diffuse (Principled, rough 1)": new PrincipledMaterial({ baseColor: W, roughness: 1 }),
    "white plastic rough 0.2":  new PrincipledMaterial({ baseColor: W, roughness: 0.2 }),
    "white plastic rough 0.7":  new PrincipledMaterial({ baseColor: W, roughness: 0.7 }),
    "smooth glass":             new PrincipledMaterial({ baseColor: W, transmission: 1, roughness: 0 }),
    "rough glass 0.3":          new PrincipledMaterial({ baseColor: W, transmission: 1, roughness: 0.3 }),
    "rough glass 0.7":          new PrincipledMaterial({ baseColor: W, transmission: 1, roughness: 0.7 }),
    "white metal rough 0.2":    new PrincipledMaterial({ baseColor: W, metallic: 1, roughness: 0.2 }),
    "white metal rough 0.5":    new PrincipledMaterial({ baseColor: W, metallic: 1, roughness: 0.5 }),
    "white metal rough 1.0":    new PrincipledMaterial({ baseColor: W, metallic: 1, roughness: 1.0 }),
};
for (const [name, mat] of Object.entries(cases)) {
    const world = new World([new Primitive(new Sphere(), mat)], [], Vec.of(1, 1, 1));
    const integ = new PathIntegrator(world);
    let sum = 0, n = 0;
    const S = 20000;
    for (let i = 0; i < S; ++i) {
        // Rays aimed at random points of the sphere's disk, from far away along +z.
        const r = Math.sqrt(Math.random()) * 0.999, phi = 2 * Math.PI * Math.random();
        const ray = new Ray(Vec.of(r * Math.cos(phi), r * Math.sin(phi), 10, 1), Vec.of(0, 0, -1, 0));
        const v = integ.radiance(ray, 64);
        sum += (v[0] + v[1] + v[2]) / 3; ++n;
    }
    console.log(name.padEnd(36), (sum / n).toFixed(4));
}
