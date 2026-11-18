// Normal maps on PrincipledMaterials: a tiled map of round bumps, made here rather than loaded. Every panel should show
// bumps lit from the same side (the light is up and to the left), whatever its UVs or transform:
//   floor         plastic, the map tiled 6 times
//   back left     plastic with plain UVs
//   back right    the same, but its UVs run right to left (a mirrored tangent frame, as mirrored UV islands have)
//   front right   gold, with the whole panel mirrored by its transform
// A map read with the wrong handedness shows as dents where the others have bumps.

// A size x size tangent-space normal map of n x n domes, as stored in a file: (normal + 1) / 2 per channel.
function bumpMap(size=256, n=4) {
    const data = new Uint8ClampedArray(size * size * 4), cell = size / n, R = cell * 0.42;
    for (let j = 0; j < size; ++j)
        for (let i = 0; i < size; ++i) {
            // Image rows run down while V runs up (the top row is V = 1), so y is measured upward.
            const x = (i + 0.5) % cell - cell / 2, y = cell / 2 - (j + 0.5) % cell, r2 = x * x + y * y;
            const nrm = r2 < R * R ? [x / R, y / R, Math.sqrt(R * R - r2) / R] : [0, 0, 1];
            const k = 4 * (j * size + i);
            for (let c = 0; c < 3; ++c)
                data[k + c] = Math.round(255 * (nrm[c] + 1) / 2);
            data[k + 3] = 255;
        }
    return new TextureMaterialColor({ width: size, height: size, data }, "bilinear", false, false, "linear");
}

// A unit square in the xy plane facing +z, as two triangles whose UVs span [0, tiles]^2 (u running along -x if flipU).
function panel(material, transform, tiles=1, flipU=false) {
    const P = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => Vec.of(x, y, 0, 1));
    const UV = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => Vec.of((flipU ? 1 - u : u) * tiles, v * tiles));
    const tris = [[0, 1, 2], [0, 2, 3]].map(t => new Primitive(new Triangle(t.map(k => P[k]), { UV: t.map(k => UV[k]) }), material));
    return BVHAggregate.build(tris, transform);
}

export function configureTest(callback) {
    const map = bumpMap();
    const plastic = (color, tiles) => new PrincipledMaterial({ baseColor: color, roughness: 0.45, normalMap: map });
    const objects = [
        panel(plastic(Vec.of(0.55, 0.55, 0.6)), Mat4.translation([0, -1, -1]).times(Mat4.rotation(-Math.PI / 2, Vec.of(1, 0, 0))).times(Mat4.scale([3, 3, 1])), 6),
        panel(plastic(Vec.of(0.75, 0.25, 0.15)), Mat4.translation([-1.05, 0.2, -3]), 2),
        panel(plastic(Vec.of(0.15, 0.4, 0.75)), Mat4.translation([1.05, 0.2, -3]), 2, true),
        panel(new PrincipledMaterial({ baseColor: Vec.of(1.0, 0.77, 0.34), metallic: 1, roughness: 0.3, normalMap: map }),
              Mat4.translation([1.2, -0.45, -0.6]).times(Mat4.rotation(-0.5, Vec.of(0, 1, 0))).times(Mat4.rotation(-0.35, Vec.of(1, 0, 0)))
                  .times(Mat4.scale([-0.5, 0.5, 0.5])), 1),
        new RandomSampleAreaLight(new Square(),
            Mat4.translation([-3.5, 3, 1]).times(Mat4.rotation(-Math.PI / 3, Vec.of(0, 1, 0))).times(Mat4.rotation(Math.PI / 4, Vec.of(1, 0, 0))),
            Vec.of(1, 0.95, 0.9), 400, 1)
    ];
    const camera = new PerspectiveCamera(Math.PI / 4, 1.5,
        Mat4.translation([0, 0.6, 4]).times(Mat4.rotation(-0.15, Vec.of(1, 0, 0))));
    callback({
        renderer: new IncrementalMultisamplingRenderer(new World(objects, [], Vec.of(0.02, 0.025, 0.035)), camera, 64, 8, "path", { exposure: -0.5 }),
        width: 600,
        height: 400
    });
}
