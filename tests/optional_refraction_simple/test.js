function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0, 0, 0]));

    const lights = [new SimplePointLight(
        Vec.of(0.75, 0, -10, 1),
        Vec.of(300, 1, 1)       
    )];


    const objects = [];
    objects.push(new SceneObject(
        new Sphere(Mat4.translation([0, 0, -5])),
        new FresnelPhongMaterial(Vec.of(1,1,1), 0.05, 0.4, 0.9, 100, 1.3)));

    callback({
        renderer: new /*RandomMultisamplingRenderer*/IncrementalMultisamplingRenderer(
            new Scene(objects, lights), camera, 16, 4),
        width: 600,
        height: 600
    });
}