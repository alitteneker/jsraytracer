function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1, Mat4.identity());

    const lights = [new SimplePointLight(
        Vec.of(10, 5, 10, 1),
        Vec.of(1, 0.87, 0)       
    )];

    loadObjFile(
        "../assets/hollow_tetrahedron.obj",
        new PhongMaterial(Vec.of(1,1,1), 0.1, 0.4, 0.6, 100),

        Mat4.translation([.3,-0.75,-3])
            .times(Mat4.rotation(0.7, Vec.of(0,1,0)))
            .times(Mat4.scale(0.1)),

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