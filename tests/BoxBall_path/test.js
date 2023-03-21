export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.identity()
            .times(Mat4.translation([-6, 1, 0]))
            .times(Mat4.rotation(-0.6, Vec.of(0,1,0)))
            .times(Mat4.rotation(-0.2, Vec.of(1,0,0))));

    const lights = [new SimplePointLight(
        Vec.of(10, 7, 10, 1),
        Vec.of(1, 1, 1),
        5000
    )];

    const objects = [];
    objects.push(new Primitive(
        new Plane(),
        new PhongPathTracingMaterial(
            new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0,0,0)),
                0.1, 0.4, 0.6, 10),
        Mat4.translation([0,-1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));
    objects.push(new Primitive(
        new UnitBox(),
        new PhongPathTracingMaterial(Vec.of(1,0,0), 0.2, 0.4, 0.6, 10000),
        Mat4.translation([1.2, 0.2, -7, 1]).times(Mat4.scale(2))));
    objects.push(new Primitive(
        new Sphere(),
        new PhongPathTracingMaterial(Vec.of(0,0,1), 0.2, 0.4, 0.6, 100),
        Mat4.translation([-2, 0.3, -9])));

        
    callback({
        renderer: new /*RandomMultisamplingRenderer*/IncrementalMultisamplingRenderer(
            new World(objects, lights), camera, 128, 4),
        width: 600,
        height: 600
    });
}