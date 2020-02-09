function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1, Mat4.identity());

    const lights = [new SimplePointLight(
        Vec.of(5, 0, 0, 1),
        Vec.of(0, 1, 0)
    )];

    loadObjFile(
        "../assets/cylinder.obj",
        new PhongMaterial(Vec.of(1,1,1), 0.1, 0.4, 0.6, 100),

        Mat4.translation([0,0,-6])
            .times(Mat4.rotation(3, Vec.of(0,1,0)))
            .times(Mat4.rotation(-Math.PI/2, Vec.of(1,0,0))),

        function(triangles) {
            callback({
                renderer: new SimpleRenderer(new Scene(triangles, lights), camera, 4),
                width: 600,
                height: 600
            });
        });
}