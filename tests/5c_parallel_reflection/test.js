function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1, Mat4.identity());

    const lights = [new SimplePointLight(
        Vec.of(10, -5, 0, 1),
        Vec.of(1, 1, 1)       
    )];
    const objs = [
        new SceneObject(
            new Plane(Vec.of(0, 0, 1, 0), -10),
            new PhongMaterial(Vec.of(0.7, 0.22, 0.24), 0.1, 0.4, 0.6, 100, 0.8)),
        new SceneObject(
            new Plane(Vec.of(0, 0, -1, 0), -1),
            new PhongMaterial(Vec.of(0.137, 0.41, 0.39), 0.1, 0.4, 0.6, 100, 0.8))
    ];

    loadObjFile(
        "../assets/cylinder.obj",
        new PhongMaterial(Vec.of(0.49, 0.624, 0.21), 0.1, 0.4, 0.6, 100, 0.9),

        Mat4.translation([1.5,-0.9,-8])
            .times(Mat4.rotation(Math.PI/3, Vec.of(0,1,0)))
            .times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0))),

        function(triangles) {
            callback({
                renderer: new SimpleRenderer(
                    new Scene(objs.concat(triangles), lights),
                    camera, 4),
                width: 600,
                height: 600
            });
        });
}