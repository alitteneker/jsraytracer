// Principled (microfacet) materials: roughness 0 to 1 from left to right, for a dielectric (plastic), a metal (gold)
// and glass. Path traced on the CPU; the GPU renderer doesn't support PrincipledMaterial yet.
export function configureTest(callback) {
    const objects = [];
    objects.push(new Primitive(new Plane(),
        new PrincipledMaterial({ baseColor: new CheckerboardMaterialColor(Vec.of(0.5, 0.5, 0.5), Vec.of(0.25, 0.25, 0.25)), roughness: 0.6 }),
        Mat4.translation([0, -0.6, 0]).times(Mat4.rotation(-Math.PI / 2, Vec.of(1, 0, 0)))));
    objects.push(new Primitive(new Plane(),
        new PrincipledMaterial({ baseColor: new CheckerboardMaterialColor(Vec.of(0.55, 0.5, 0.45), Vec.of(0.3, 0.32, 0.35)), roughness: 0.8 }),
        Mat4.translation([0, 0, -2.5]).times(Mat4.scale(0.5))));

    const roughness = [0, 0.25, 0.5, 0.75, 1];
    const rows = [
        r => new PrincipledMaterial({ baseColor: Vec.of(0.8, 0.12, 0.08), roughness: r }),
        r => new PrincipledMaterial({ baseColor: Vec.of(1.0, 0.77, 0.34), metallic: 1, roughness: r }),
        r => new PrincipledMaterial({ baseColor: Vec.of(0.9, 0.97, 1.0), transmission: 1, roughness: r }),
    ];
    rows.forEach((material, j) => roughness.forEach((r, i) =>
        objects.push(new Primitive(new Sphere(), material(r),
            Mat4.translation([(i - 2) * 1.1, 2.2 - j * 1.1, 0]).times(Mat4.scale(0.45))))));

    objects.push(new RandomSampleAreaLight(new Square(),
        Mat4.translation([-2.5, 4.5, 4]).times(Mat4.rotation(Math.PI / 2, Vec.of(1, 0, 0))).times(Mat4.scale([3, 3, 1])),
        Vec.of(1, 0.95, 0.9), 630, 1));

    const camera = new PerspectiveCamera(Math.PI / 5, 1.5,
        Mat4.translation([0, 1.5, 8.5]).times(Mat4.rotation(-0.07, Vec.of(1, 0, 0))));
    callback({
        renderer: new IncrementalMultisamplingRenderer(new World(objects, [], Vec.of(0.12, 0.14, 0.18)), camera, 64, 10, "path"),
        width: 600,
        height: 400
    });
}
