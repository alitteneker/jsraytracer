export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0,2,0,1]));
        //Mat4.identity());

    const lights = [new SimplePointLight(
        Vec.of(10, 7, 10, 1),
        Vec.of(1, 1, 1),
        5000
    )];

    const objects = [];
    objects.push(new SceneObject(
        new Plane(),
        new PhongMaterial(Vec.of(0.5, 0.5, 0.5),0.1, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0,-1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));
    objects.push(new SceneObject(
        new UnitBox(),
        new PhongMaterial(Vec.of(1,0,0), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0.75, 0.4, -7, 1]).times(Mat4.rotation(0.4, Vec.of(0,1,0))).times(Mat4.scale(2.5))));
    objects.push(new SceneObject(
        new Sphere(),
        new PhongMaterial(Vec.of(0,0,1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([-2.7, 1.3, -10]).times(Mat4.scale(2))));
        
    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new BVHScene(objects, lights), camera, 16, 4),
        width: 600,
        height: 600
    });
}