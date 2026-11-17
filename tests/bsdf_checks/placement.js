// node tests/bsdf_checks/placement.js
// Rays must find lights and objects where sampling and the scene put them, including inside a TransformedWorldObject.
// For a directional light (placed relative to whoever looks at it), each direction light sampling picks from a point
// must hit the light at exactly the sampled point: sampling and visibility have to agree, or MIS weights and
// reflections of the light are wrong.
const fs = require("fs"), vm = require("vm"), path = require("path");
const src = path.join(__dirname, "..", "..", "src");
for (const f of ['math.js','world.js','geometry.js','bsdf.js','materials.js','cameras.js','renderers.js','integrators.js','lights.js','aggregates.js'])
    vm.runInThisContext(fs.readFileSync(path.join(src, f)).toString(), { filename: f });

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ": " + detail : ""}`);
    if (!ok) ++failures;
};

// An object inside a TransformedWorldObject is hit where the transform puts it.
{
    const sphere = new Primitive(new Sphere(), new PhongMaterial(Vec.of(1, 1, 1)));
    const world = new World([new TransformedWorldObject(sphere, Mat4.translation([0, 0, -5]))]);
    const hit = world.cast(new Ray(Vec.of(0, 0, 0, 1), Vec.of(0, 0, -1, 0)), 0.0001);
    check("sphere in a TransformedWorldObject", hit.object === sphere && Math.abs(hit.distance - 4) < 1e-9,
        `hit ${hit.object && hit.object.constructor.name} at ${hit.distance}`);
}

// A directional disc, on its own and inside a translated, rotated group, seen from several points.
for (const [name, wrap] of [
    ["directional light", l => l],
    ["directional light in a TransformedWorldObject", l => new TransformedWorldObject(l,
        Mat4.translation([10, -3, 2]).times(Mat4.rotation(0.3, Vec.of(0, 0, 1))))]]) {
    const light = new DirectionalLight(new Circle(),
        Mat4.translation([0, 5, 0]).times(Mat4.rotation(Math.PI / 2, Vec.of(1, 0, 0))), Vec.of(1, 1, 1), 100);
    const world = new World([wrap(light)]);
    let hits = 0, n = 0;
    for (const P of [Vec.of(0, 0, 0, 1), Vec.of(3, -2, 7, 1)])
        for (const instance of world.lights)
            for (let k = 0; k < 50; ++k)
                for (const s of instance.sampleLi(P)) {
                    const hit = world.cast(new Ray(P, s.direction), 0.0001);
                    ++n;
                    if (hit.object === light && Math.abs(hit.distance - 1) < 1e-6)
                        ++hits;
                }
    check(name, hits == n, `${hits} of ${n} sampled directions hit the light at the sampled point`);
}

process.exit(failures ? 1 : 0);
