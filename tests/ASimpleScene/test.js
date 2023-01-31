export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0.5,-0.5,4]));

    const lights = [new SimplePointLight(
        Vec.of(10, 7, 10, 1),
        Vec.of(1, 1, 1),
        10000
    )];

    const objects = [];
    objects.push(new SceneObject(
        new Plane(),
        new PhongMaterial(Vec.of(0.5, 0.5, 0.5), 0.1, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0,-1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));
        
    objects.push(new SceneObject(
        new UnitBox(),
        new PhongMaterial(Vec.of(1,0.1,0.1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0.75, 0.4, -7]).times(Mat4.rotation(0.35, Vec.of(0,1,0))).times(Mat4.scale(2.5))));
        
    objects.push(new SceneObject(
        new Sphere(),
        new PhongMaterial(Vec.of(0.1,0.1,1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([-2.7, 1.3, -10]).times(Mat4.scale(2))));
        
    objects.push(new SceneObject(
        new Cylinder(),
        new PhongMaterial(Vec.of(0.1,0.8,0.1), 0.1, 0.3, 0.4, 100, 0.5),
        Mat4.translation([2.55, -0.1, -3]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0))).times(Mat4.scale(0.75))));
        
    objects.push(new SceneObject(
        new Circle(),
        new PhongMaterial(Vec.of(1,1,1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([2.55, 1.5, -4]).times(Mat4.rotation(-0.2, Vec.of(0,1,0))).times(Mat4.rotation(0.6, Vec.of(1,0,0))).times(Mat4.scale(1))));
    objects.push(new SceneObject(
        new Square(),
        new PhongMaterial(Vec.of(1,0.1,1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0.7, 6.3, -20]).times(Mat4.rotation(0.4, Vec.of(1,0,0))).times(Mat4.rotation(0, Vec.of(0,1,0))).times(Mat4.scale(6))));
        
    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new BVHScene(objects, lights), camera, 16, 4),
        width: 600,
        height: 600
    });
}