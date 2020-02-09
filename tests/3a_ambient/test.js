function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1, Mat4.identity());

    const lights = [
        new SimplePointLight(
            Vec.of(50, 50, -75, 1),
            Vec.of(1, 0, 0)       
        ),
        new SimplePointLight(
            Vec.of(8, -5, -1, 1),
            Vec.of(0, 1, 0)
        ),
        new SimplePointLight(
            Vec.of(-1, 0, 0, 1),
            Vec.of(0, 0, 1)
        )
    ];

    loadObjFile(
        "../assets/tetrahedron.obj",
        new PhongMaterial(Vec.of(0.9,0.8,0.7), 0.2),

        Mat4.translation([0,0,-2])
            .times(Mat4.rotation(0.4, Vec.of(0,1,0)))
            .times(Mat4.rotation(-0.4, Vec.of(1,0,0))),

        function(triangles) {

            callback({
                renderer: new SimpleRenderer(new Scene(triangles, lights), camera, 4),
                width: 600,
                height: 600
            });
        }
    );
}