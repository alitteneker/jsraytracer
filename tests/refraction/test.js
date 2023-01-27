export function configureTest(callback) {

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
        new Plane(),
        new PhongMaterial(
            new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0.5,0.5,0.5)),
                0.1, 0.4, 0.6, 2, 0.5),
        Mat4.translation([0,-1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));
    objects.push(new SceneObject(
        new Sphere(),
        new FresnelPhongMaterial(Vec.of(0.827,0.412,0.424), 0.1, 0.4, 0.9, 100, 1.3),
        Mat4.translation([-3, 0, -5])));
    objects.push(new SceneObject(
        new Sphere(),
        new FresnelPhongMaterial(Vec.of(0.255,0.506,0.498), 0.1, 0.4, 0.9, 100, 1.3),
        Mat4.translation([-2, 1, -10]).times(Mat4.scale(2))));
    objects.push(new SceneObject(
        new Sphere(),
        new FresnelPhongMaterial(Vec.of(0.655,0.78,0.388), 0.1, 0.4, 0.9, 100, 1.3),
        Mat4.translation([5, 2, -12]).times(Mat4.scale(3))));

    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new Scene(objects, lights, Vec.of(0.5,0.5,0.5)), camera, 16, 4),
        width: 600,
        height: 600
    });
}