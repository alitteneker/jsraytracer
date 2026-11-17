// Participating media (src/media.js) with constant density: a sphere of glowing fog on the left, which light scatters
// in evenly, and a block of thin haze over the floor that the shadows and the spotlight beam show through. Media are
// only seen by the path integrator, which "auto" picks for any world with volumes.
export function configureTest(callback) {
    const camera = new PerspectiveCamera(Math.PI / 4, 1.5,
        Mat4.translation([0, 1.6, 7.5]).times(Mat4.rotation(-0.12, Vec.of(1, 0, 0))));

    const floor = new PrincipledMaterial({ baseColor: Vec.of(0.6, 0.6, 0.6), roughness: 0.6 });
    const objects = [
        new Primitive(new Plane(), floor, Mat4.rotation(-Math.PI / 2, Vec.of(1, 0, 0))),
        new Primitive(new Sphere(), new PrincipledMaterial({ baseColor: Vec.of(0.8, 0.2, 0.15), roughness: 0.3 }),
            Mat4.translation([1.2, 0.8, -0.5]).times(Mat4.scale(0.8))),
        new Primitive(new UnitBox(), new PrincipledMaterial({ baseColor: Vec.of(0.2, 0.35, 0.8), roughness: 0.4 }),
            Mat4.translation([2.6, 0.5, -1.8]).times(Mat4.rotation(0.5, Vec.of(0, 1, 0)))),
        // A dense, forward-scattering ball of fog.
        new Volume(new HomogeneousMedium({ shape: "sphere", density: 1.2, albedo: Vec.of(0.95, 0.9, 0.8), g: 0.5 }),
            Mat4.translation([-1.6, 1.1, -0.3]).times(Mat4.scale(1.1))),
        // Thin haze filling the space above the floor.
        new Volume(new HomogeneousMedium({ density: 0.06, albedo: 0.9, g: 0 }),
            Mat4.translation([0, 2, -2]).times(Mat4.scale([8, 2, 6]))),
        new RandomSampleAreaLight(new Square(),
            Mat4.translation([0.5, 3.9, 0]).times(Mat4.rotation(Math.PI / 2, Vec.of(1, 0, 0))).times(Mat4.scale(0.6)),
            Vec.of(1, 0.9, 0.8), 400)
    ];
    callback({
        renderer: new IncrementalMultisamplingRenderer(new World(objects, [], Vec.of(0.02, 0.025, 0.035)), camera, 16, 12,
            "auto", { exposure: 0 }),
        width: 600,
        height: 400
    });
}
