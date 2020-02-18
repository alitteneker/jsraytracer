function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0, 5, 15]));

    const lights = [];
//     lights.push(new RandomSampleAreaLight(
//         new SquareLightArea(Mat4.translation([0,9.9,0])
//             .times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))
//             .times(Mat4.scale([2.5,2.5,1]))),
//         Vec.of(1,1,1), 128));
    lights.push(new SimplePointLight(Vec.of(0,9.9,0), Vec.of(1,1,1)));

    loadObjFile(
        "../assets/cube.obj",
        new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4, 0.6, 100),

        Mat4.translation([0.6,0,-8])
            .times(Mat4.rotation(Math.PI/9, Vec.of(1,0,0)))
            .times(Mat4.rotation(Math.PI/3, Vec.of(0,1,0))),

        function(objects) {
            objects = [];
            // floor
            objects.push(new SceneObject(
                new Plane(Vec.of(0, 1, 0, 0), 0),
                new PositionalUVMaterial(new PhongMaterial(
                    new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0,0,0)),
                        0.1, 0.4, 0.6, 100, 0))));
            // back wall
            objects.push(new SceneObject(
                new Plane(Vec.of(0, 0, 1, 0), -12),
                new PhongMaterial(Vec.of(1,1,1), 0.1, 0.4, 0.6, 100)));
            // left wall
            objects.push(new SceneObject(
                new Plane(Vec.of(1, 0, 0, 0), 5),
                new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4, 0.6, 100)));
            // right wall
            objects.push(new SceneObject(
                new Plane(Vec.of(1, 0, 0, 0), -5),
                new PhongMaterial(Vec.of(0,1,0), 0.1, 0.4, 0.6, 100)));
            // ceiling
            objects.push(new SceneObject(
                new Plane(Vec.of(0, 1, 0, 0), 10),
                new PhongMaterial(Vec.of(1,1,1), 0.1, 0.4, 0.6, 100)));
              
            // objects
            objects.push(new SceneObject(
                new Sphere(Mat4.translation([1, 2, -5]).times(Mat4.scale(2))),
                new PhongMaterial(Vec.of(1,0,0), 0.2, 0.4, Vec.of(1,1,1), 1000, 0.5)));
            objects.push(new SceneObject(
                new Sphere(Mat4.translation([-2, 1.3, -1])),
                new PhongMaterial(Vec.of(0,0,1), 0.2, 0.4, 0.6, 100, 0.5)));
                
            callback({
                renderer: new /*RandomMultisamplingRenderer*/IncrementalMultisamplingRenderer(new Scene(objects, lights), camera, 128, 4),
                width: 600,
                height: 600
            });
        });
}