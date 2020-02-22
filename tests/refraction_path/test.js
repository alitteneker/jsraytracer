function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.identity()
            .times(Mat4.translation([-7, 1.5, 0]))
            .times(Mat4.rotation(-0.6, Vec.of(0,1,0)))
            .times(Mat4.rotation(-0.15, Vec.of(1,0,0))));

    const lights = [
//         new SimplePointLight(
//             Vec.of(10, 7, 10, 1),
//             Vec.of(1, 1, 1),
//             1000
//         )
        new SimplePointLight(
            Vec.of(-1, 100, -3, 1),
            Vec.of(1, 1, 1),
            150000
        ),
        new SimplePointLight(
            Vec.of(3, 3, -20, 1),
            Vec.of(1, 1, 1),
            1000
        )
    ];

    const objects = [];
    objects.push(new SceneObject(
        new Plane(Vec.of(0, 1, 0, 0), -1),
        new PositionalUVMaterial(new PhongPathTracingMaterial(
            new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0.5,0.5,0.5)),
                0.1, 0.4))));
    objects.push(new SceneObject(
        new Sphere(Mat4.translation([-3, 1, -5])),
        new PhongPathTracingMaterial(Vec.of(/*1,1,1/**/0.827,0.412,0.424), 0.1, 0.2, 0.9, 100, 1.3, Infinity)));
    objects.push(new SceneObject(
        new Sphere(Mat4.translation([-2, 1, -10]).times(Mat4.scale(2))),
        new PhongPathTracingMaterial(Vec.of(0.255,0.506,0.498), 0.1, 0.2, 0.9, 100, 1.3, Infinity)));
    objects.push(new SceneObject(
        new Sphere(Mat4.translation([5, 2, -12]).times(Mat4.scale(3))),
        new PhongPathTracingMaterial(Vec.of(0.655,0.78,0.388), 0.1, 0.2, 0.9, 100, 1.3, Infinity)));

    callback({
        renderer: new /*RandomMultisamplingRenderer*/IncrementalMultisamplingRenderer(
            new Scene(objects, lights, Vec.of(0.5,0.5,0.5)), camera, 256, 7),
        width: 600,
        height: 600
    });
}