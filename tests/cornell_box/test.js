function configureTest(callback) {

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
        new Plane(Vec.of(0, 1, 0, 0), 0),
        new PositionalUVMaterial(new PhongMaterial(
            new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0,0,0)),
                0.1, 0.4))));
    // back wall
    objects.push(new SceneObject(
        new Plane(Vec.of(0, 0, 1, 0), -12),
        new PhongMaterial(Vec.of(1,1,1), 0.1, 0.4)));
    // left wall
    objects.push(new SceneObject(
        new Plane(Vec.of(1, 0, 0, 0), 5),
        new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4)));
    // right wall
    objects.push(new SceneObject(
        new Plane(Vec.of(-1, 0, 0, 0), 5),
        new PhongMaterial(Vec.of(0,1,0), 0.1, 0.4)));
    // ceiling
    objects.push(new SceneObject(
        new Plane(Vec.of(0, -1, 0, 0), -10),
        new PhongMaterial(Vec.of(1,1,1), 0.1, 0.4)));

    // objects
    objects.push(new SceneObject(
        new Sphere(Mat4.translation([1, 2, -5]).times(Mat4.scale(2))),
        new PhongMaterial(Vec.of(1,1,1), 0.2, 0.4, Vec.of(1,1,1), 1000)));
    objects.push(new SceneObject(
        new Sphere(Mat4.translation([-2, 1.3, -1])),
        new PhongMaterial(Vec.of(1,1,1), 0.2, 0.4, 0.6, 100)));

    callback({
        renderer: new /*RandomMultisamplingRenderer*/IncrementalMultisamplingRenderer(
            new Scene(objects, lights), camera, 128, 7),
        width: 600,
        height: 600
    });
}