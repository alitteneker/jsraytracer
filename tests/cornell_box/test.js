export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0, 5, 15]));

    const lights = [];
    lights.push(new RandomSampleAreaLight(
        new SquareLightArea(Mat4.translation([0,9.9,0])
            .times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))
            .times(Mat4.scale([1,1,1]))),
        Vec.of(1,1,1), 1500, 4));
//     lights.push(new SimplePointLight(Vec.of(0,9.9,0), Vec.of(1,1,1), 1000));

    const objects = [];
    // floor
    objects.push(new SceneObject(
        new Plane(),
        new PositionalUVMaterial(new PhongMaterial(
            new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0,0,0)),
                0.1, 0.4)),
        Mat4.rotation(Math.PI/2, Vec.of(1,0,0))));
    // back wall
    objects.push(new SceneObject(
        new Plane(),
        new PhongMaterial(Vec.of(1,1,1), 0.1, 0.4),
        Mat4.translation([0,0,-12])));
    // left wall
    objects.push(new SceneObject(
        new Plane(),
        new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4),
        Mat4.translation([5,0,0]).times(Mat4.rotation(Math.PI/2, Vec.of(0,1,0)))));
    // right wall
    objects.push(new SceneObject(
        new Plane(),
        new PhongMaterial(Vec.of(0,1,0), 0.1, 0.4),
        Mat4.translation([-5,0,0]).times(Mat4.rotation(Math.PI/2, Vec.of(0,1,0)))));
    // ceiling
    objects.push(new SceneObject(
        new Plane(),
        new PhongMaterial(Vec.of(1,1,1), 0.1, 0.4),
        Mat4.translation([0,10,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));

    // objects
    objects.push(new SceneObject(
        new Sphere(),
        new PhongMaterial(Vec.of(1,1,1), 0.2, 0.4, Vec.of(1,1,1), 1000),
        Mat4.translation([1, 2, -5]).times(Mat4.scale(2))));
    objects.push(new SceneObject(
        new Sphere(),
        new PhongMaterial(Vec.of(1,1,1), 0.2, 0.4, 0.6, 100),
        Mat4.translation([-2, 1.3, -1])));

    callback({
        renderer: new /*RandomMultisamplingRenderer*/IncrementalMultisamplingRenderer(
            new Scene(objects, lights), camera, 128, 7),
        width: 600,
        height: 600
    });
}