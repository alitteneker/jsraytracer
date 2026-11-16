// A directional light (see DirectionalLight in src/lights.js): a disc whose transform is relative to whoever looks
// at it (the point being shaded, or a ray's origin), so every point sees it in the same direction, like the sun. It's
// out of the camera's view here, but shows in the reflective objects. The disc is 0.6 units across at a distance of
// about 12, which makes the shadows soft; with a point (new OriginPoint()) they'd be hard. Its power follows the same
// rule as an area light's: about 2 pi d^2 for unit irradiance on a surface facing it.
export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0.5,-0.5,4]));

    // Up and to the right, with the disc facing back toward the observer at its origin.
    const offset = Vec.of(8, 7, -3), d = offset.norm();
    const z = offset.times(-1 / d), x = Vec.of(0, 1, 0).cross(z).normalized(), y = z.cross(x);
    const toLight = Mat.of([x[0], y[0], z[0], offset[0]], [x[1], y[1], z[1], offset[1]], [x[2], y[2], z[2], offset[2]], [0, 0, 0, 1]);
    const lights = [new DirectionalLight(new Circle(), toLight.times(Mat4.scale(0.3)), Vec.of(1, 0.95, 0.85), 2 * Math.PI * d * d)];

    const objects = [];
    objects.push(new Primitive(
        new Plane(),
        new PhongMaterial(Vec.of(0.5, 0.5, 0.5), 0.1, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0,-1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));
    objects.push(new Primitive(
        new UnitBox(),
        new PhongMaterial(Vec.of(1,0.1,0.1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0.75, 0.4, -7]).times(Mat4.rotation(0.35, Vec.of(0,1,0))).times(Mat4.scale(2.5))));
    objects.push(new Primitive(
        new Sphere(),
        new PhongMaterial(Vec.of(0.1,0.1,1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([-2.7, 1.3, -10]).times(Mat4.scale(2))));
    objects.push(new Primitive(
        new Cylinder(),
        new PhongMaterial(Vec.of(0.1,0.8,0.1), 0.1, 0.3, 0.4, 100, 0.5),
        Mat4.translation([2.55, -0.1, -3]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0))).times(Mat4.scale(0.75))));

    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new World(objects, lights), camera, 16, 4, "auto", { exposure: -1.5 }),
        width: 600,
        height: 600
    });
}
