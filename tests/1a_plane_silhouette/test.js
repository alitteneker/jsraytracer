function configureTest(callback) {

    const objects = [new SceneObject(
        new Plane(Vec.of(1, 1, 0, 0).normalized(), -1),
        new SolidColorMaterial(Vec.of(0,0,1)))];

    callback({
        renderer: new SimpleRenderer(
            new Scene(objects),
            new PerspectiveCamera(Math.PI / 4, 1, Mat4.identity()),
            4),
        width: 600,
        height: 600
    });

}