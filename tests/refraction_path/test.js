export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.identity()
            .times(Mat4.translation([-7, 1.5, 0]))
            .times(Mat4.rotation(-0.6, Vec.of(0,1,0)))
            .times(Mat4.rotation(-0.15, Vec.of(1,0,0))));

//     const camera = new PerspectiveCamera(Math.PI / 4, 1,
//         Mat4.identity()
//             .times(Mat4.translation([-2, 1, -3]))
//             .times(Mat4.rotation(0.4, Vec.of(0,1,0)))
//             .times(Mat4.rotation(-0.8, Vec.of(1,0,0))));

    const lights = [
        new SimplePointLight(
            Vec.of(-3, 10, -4, 1),
            Vec.of(1, 1, 1),
            300
        ),
        new SimplePointLight(
            Vec.of(3, 10, -20, 1),
            //Vec.of(12, 1, -40, 1),
            Vec.of(1, 1, 1),
            //10000
            10000
        )
    ];

    const objects = [];
    objects.push(new Primitive(
        new Plane(),
        new PhongPathTracingMaterial(
            new CheckerboardMaterialColor(Vec.of(0.8,0.8,0.8), Vec.of(0.5,0.5,0.5)),
                0.01, 0.8, 0, 0, Infinity, 0, 1.0),
        Mat4.translation([0,-1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));
    objects.push(new Primitive(
        new Sphere(),
        new PhongPathTracingMaterial(Vec.of(/*1,1,1/**/0.827,0.412,0.424/**/), 0.1, 0.2, 0.9, 100, 1.3, 1.0),
        Mat4.translation([-2.5, 0, -5.5])));
    objects.push(new Primitive(
        new Sphere(),
        new PhongPathTracingMaterial(Vec.of(0.255,0.506,0.498), 0.1, 0.2, 0.9, 100, 1.3, 1.0),
        Mat4.translation([-2, 1, -11]).times(Mat4.scale(2))));
    objects.push(new Primitive(
        new Sphere(),
        new PhongPathTracingMaterial(Vec.of(0.655,0.78,0.388), 0.1, 0.2, 0.9, 100, 1.3, 1.0),
        Mat4.translation([4, 2, -12]).times(Mat4.scale(3))));

    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new World(objects, lights, Vec.of(0.5,0.5,0.5)), camera, 256, 7),
        width: 600,
        height: 600
    });
}