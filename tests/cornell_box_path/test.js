export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0, 5, 15]));

    const lights = [];
    lights.push(new RandomSampleAreaLight(
        new SquareLightArea(Mat4.translation([0,10,0])
            .times(Mat4.rotation(-Math.PI/2, Vec.of(1,0,0)))
            .times(Mat4.scale(0.8))),
        Vec.of(1,1,1), 2000/* 1000 */, 16));
//     lights.push(new SimplePointLight(Vec.of(0,9.9,0), Vec.of(1,1,1), 1000));

    const objects = [];
    // floor
    objects.push(new SceneObject(
        new Plane(),
        new PhongPathTracingMaterial(
            new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0.1,0.1,0.1)),
            //Vec.of(0.1,0.1,1),
                0, 0.4, 0.4, 10),
        Mat4.rotation(Math.PI/2, Vec.of(1,0,0))));
    // back wall
    objects.push(new SceneObject(
        new Square(),
        new PhongPathTracingMaterial(Vec.of(1,1,1), 0, 0.4),
        Mat4.translation([0,5,-5]).times(Mat4.scale([10,10,1]))));
    // left wall
    objects.push(new SceneObject(
        new Square(),
        new PhongPathTracingMaterial(Vec.of(1,0.1,0.1), 0, 0.4),
        Mat4.translation([5,5,0]).times(Mat4.scale([1,10,10])).times(Mat4.rotation(Math.PI/2, Vec.of(0,1,0)))));
    // right wall
    objects.push(new SceneObject(
        new Square(),
        new PhongPathTracingMaterial(Vec.of(0.1,1,0.1), 0, 0.4),
        Mat4.translation([-5,5,0]).times(Mat4.scale([1,10,10])).times(Mat4.rotation(-Math.PI/2, Vec.of(0,1,0)))));
    // ceiling
    const ceilingmaterial = new PhongPathTracingMaterial(Vec.of(1,1,1), 0, 0.4);
    objects.push(new SceneObject(
        new Square(),
        ceilingmaterial,
        Mat4.translation([0,10.5,0]).times(Mat4.scale([2,1,2])).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));
    objects.push(new SceneObject(
        new UnitBox(),
        ceilingmaterial,
        Mat4.translation([0,10,3]).times(Mat4.scale([10,1,4]))));
    objects.push(new SceneObject(
        new UnitBox(),
        ceilingmaterial,
        Mat4.translation([0,10,-3]).times(Mat4.scale([10,1,4]))));
    objects.push(new SceneObject(
        new UnitBox(),
        ceilingmaterial,
        Mat4.translation([3,10,0]).times(Mat4.scale([4,1,2]))));
    objects.push(new SceneObject(
        new UnitBox(),
        ceilingmaterial,
        Mat4.translation([-3,10,0]).times(Mat4.scale([4,1,2]))));

    // objects
    objects.push(new SceneObject(
        new Sphere(),
        new PhongPathTracingMaterial(Vec.of(1,1,1), 0, 0.1, 0.8, 10),
        Mat4.translation([1, 2, -1]).times(Mat4.scale(2))));
    objects.push(new SceneObject(
        new Sphere(),
        new PhongPathTracingMaterial(Vec.of(1,1,1), 0, 0.1, 0.9, 10, 2),
        Mat4.translation([-2, 1, 1.5])));

    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new Scene(objects, lights), camera, 128, 8),
        width:  600,
        height: 600
    });
}