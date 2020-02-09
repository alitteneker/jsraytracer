function configureTest(callback) {

    const lights = new SimplePointLight(
        Vec.of(10, 10, -5, 1),
        Vec.of(1, 1, 1)       
    );

    const objects = [
        new SceneObject(
            new Triangle([Vec.of(-3, 0, -8, 1), Vec.of(0, 1, -5, 1), Vec.of(1, -2, -6, 1)]),
            new SolidColorMaterial(Vec.of(0,0,1))),
        new SceneObject(
            new Plane(Vec.of(0, 1, 0, 0), -2),
            new SolidColorMaterial(Vec.of(1,0,0)))
    ];

    callback({
        renderer: new SimpleRenderer(
            new Scene(objects, lights),
            new PerspectiveCamera(Math.PI / 4, 1, Mat4.identity()),
            4),
        width: 600,
        height: 600
    });

}