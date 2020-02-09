function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1, Mat4.identity());

    const lights = [
        new SimplePointLight(
            Vec.of(2, 1, -2, 1),
            Vec.of(1, 0.87, 0)       
        ),
        new SimplePointLight(
            Vec.of(2, 1.25, -6, 1),
            Vec.of(0, 0, 1)       
        )
    ];

    loadObjFile(
        "../assets/tetrahedron.obj",
        new PhongMaterial(Vec.of(1,1,1), 0.1, 0.4, 0.6, 100),

        Mat4.translation([0.6,-0.2,-5])
            .times(Mat4.rotation(Math.PI/9, Vec.of(1,0,0)))
            .times(Mat4.rotation(Math.PI/4, Vec.of(0,1,0))),

        function(objects) {
            objects.push(new SceneObject(
                new Plane(Vec.of(0, 1, 0, 0), -1),
                new PhongMaterial(Vec.of(1,1,1), 0.1, 0.4, 0.6, 100)));

            callback({
                renderer: new SimpleRenderer(new Scene(objects, lights), camera, 4),
                width: 600,
                height: 600
            });
        });
}