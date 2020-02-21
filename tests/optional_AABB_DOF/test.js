function configureTest(callback) {

    const camera = new DepthOfFieldPerspectiveCamera(Math.PI / 4, 1,
        Mat4.identity()
            .times(Mat4.translation([-6, 1, 0]))
            .times(Mat4.rotation(-0.6, Vec.of(0,1,0)))
            .times(Mat4.rotation(-0.2, Vec.of(1,0,0))),
        9.2, 0.2);

    const lights = [new SimplePointLight(
        Vec.of(10, 7, 10, 1),
        Vec.of(1, 1, 1),
        5000       
    )];

    loadObjFile(
        "../assets/cube.obj",
        new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4, 0.6, 100),

        Mat4.translation([0.6,0,-8])
            .times(Mat4.rotation(Math.PI/9, Vec.of(1,0,0)))
            .times(Mat4.rotation(Math.PI/3, Vec.of(0,1,0))),

        function(objects) {
            objects = [];
            objects.push(new SceneObject(
                new Plane(Vec.of(0, 1, 0, 0), -1),
                new PositionalUVMaterial(new PhongMaterial(
                    new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0,0,0)),
                        0.1, 0.4, 0.6, 100, 0.5))));
            objects.push(new SceneObject(
                new AABB(Vec.of(1.2, 0.2, -7, 1), Vec.of(1,1,1,0)),
                new PhongMaterial(Vec.of(1,0,0), 0.2, 0.4, 0.6, 100, 0.5)));
            objects.push(new SceneObject(
                new Sphere(Mat4.translation([-2, 0.3, -9])),
                new PhongMaterial(Vec.of(0,0,1), 0.2, 0.4, 0.6, 100, 0.5)));
                
            callback({
                renderer: new /*RandomMultisamplingRenderer*/IncrementalMultisamplingRenderer/**/(new Scene(objects, lights), camera, 64, 4),
                width: 600,
                height: 600
            });
        });
}