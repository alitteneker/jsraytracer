// node tests/bsdf_checks/normalmaps.js
// Checks normal maps (PrincipledMaterial.normalMap, with the tangents Triangle.tangent gives): a flat map leaves the
// normal alone, and a tilted one tilts it along the right world axis, also with mirrored UVs (the tangent frame's
// handedness), a mirroring transform, and a rotation. The GPU (principledShadingNormal in bsdf.glsl) does the same sums.
const fs = require("fs"), vm = require("vm"), path = require("path");
const src = path.join(__dirname, "..", "..", "src");
for (const f of ['math.js','world.js','geometry.js','bsdf.js','materials.js'])
    vm.runInThisContext(fs.readFileSync(path.join(src, f)).toString(), { filename: f });

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
    if (!ok) ++failures;
};

// A 1x1 linear texture holding one tangent-space normal, as a normal map stores it ((n + 1) / 2 in bytes).
const mapOf = n => {
    const b = n.map(c => Math.round(255 * (c + 1) / 2));
    return new TextureMaterialColor({ width: 1, height: 1, data: new Uint8ClampedArray([b[0], b[1], b[2], 255]) },
        "nearest", true, true, "linear");
};
// What the map actually holds after 8-bit rounding, as a tangent-space vector (0 is stored as 128, so reads as 1/255).
const decoded = n => n.map(c => 2 * Math.round(255 * (c + 1) / 2) / 255 - 1);

// The shading normal where a ray from above hits a triangle in the z = 0 plane (normal +z) with the given UVs,
// placed in the world by transform.
const shade = (uvs, normal, transform=Mat4.identity()) => {
    const ps = [Vec.of(-1, -1, 0, 1), Vec.of(1, -1, 0, 1), Vec.of(-1, 1, 0, 1)];
    const material = new PrincipledMaterial({ normalMap: mapOf(normal), normalScale: 1 });
    const prim = new Primitive(new Triangle(ps, { UV: uvs.map(([u, v]) => Vec.of(u, v)) }), material, transform);
    const target = transform.times(Vec.of(-0.5, -0.5, 0, 1)), up = transform.times(Vec.of(0, 0, 1, 0));
    const origin = target.plus(up.times(2)), ray = new Ray(origin, target.minus(origin));
    const hit = prim.intersect(ray, 1e-6);
    const data = prim.surfaceData(ray, hit.distance, Mat4.identity());
    return material.shadingNormal(data).to3();
};
const near = (a, b) => a.minus(b).norm() < 1e-6;
const show = v => `(${[0, 1, 2].map(i => v[i].toFixed(3)).join(", ")})`;
const expect = (name, got, want) => check(name, near(got, want), `got ${show(got)}, want ${show(want)}`);

const tilt = Vec.of(0.6, 0, 0.8), tiltY = Vec.of(0, 0.6, 0.8);
const plainUV = [[0, 0], [1, 0], [0, 1]], mirroredUV = [[1, 0], [0, 0], [1, 1]];
const dx = decoded(tilt), dy = decoded(tiltY);

const df = decoded(Vec.of(0, 0, 1));
expect("flat map", shade(plainUV, Vec.of(0, 0, 1)), Vec.of(df[0], df[1], df[2]).normalized());
expect("tilt along u goes along +x", shade(plainUV, tilt), Vec.of(dx[0], dx[1], dx[2]).normalized());
expect("tilt along v goes along +y", shade(plainUV, tiltY), Vec.of(dy[0], dy[1], dy[2]).normalized());
// u runs along -x, v along +y: a left-handed frame (w = -1), and v must still go along +y.
expect("mirrored UVs: u tilt goes along -x", shade(mirroredUV, tilt), Vec.of(-dx[0], dx[1], dx[2]).normalized());
expect("mirrored UVs: v tilt still along +y", shade(mirroredUV, tiltY), Vec.of(-dy[0], dy[1], dy[2]).normalized());
// Mirroring the object in x: the world sees the mirror image of the unmirrored result.
const mirror = Mat4.scale([-1, 1, 1]);
expect("mirroring transform: u tilt goes along -x", shade(plainUV, tilt, mirror), Vec.of(-dx[0], dx[1], dx[2]).normalized());
expect("mirroring transform: v tilt still along +y", shade(plainUV, tiltY, mirror), Vec.of(-dy[0], dy[1], dy[2]).normalized());
// A rotation (and a non-uniform scale) carries the tilted normal along with the surface.
const R = Mat4.rotation(0.7, Vec.of(1, 2, 3).normalized()), S = R.times(Mat4.scale([2, 2, 2]));
const want = R.times(Vec.of(dx[0], dx[1], dx[2], 0)).to3().normalized();
expect("rotated and scaled object", shade(plainUV, tilt, S), want);

console.log(failures ? `${failures} FAILED` : "all ok");
process.exit(failures ? 1 : 0);
