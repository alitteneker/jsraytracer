export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0, 5, 15]));

    const objects = [];
    // floor
    objects.push(new Primitive(
        new Plane(),
        new PhongPathTracingMaterial(
            new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0,0,0)),
            //Vec.of(0.1,0.1,1),
                0, 0.4),
        Mat4.rotation(Math.PI/2, Vec.of(1,0,0))));
    // back wall
    objects.push(new Primitive(
        new Square(),
        new PhongPathTracingMaterial(Vec.of(1,1,1), 0, 0.4),
        Mat4.translation([0,5,-5]).times(Mat4.scale([10,10,1]))));
    // left wall
    objects.push(new Primitive(
        new Square(),
        new PhongPathTracingMaterial(Vec.of(1,0.1,0.1), 0, 0.4),
        Mat4.translation([5,5,0]).times(Mat4.scale([1,10,10])).times(Mat4.rotation(Math.PI/2, Vec.of(0,1,0)))));
    // right wall
    objects.push(new Primitive(
        new Square(),
        new PhongPathTracingMaterial(Vec.of(0.1,1,0.1), 0, 0.4),
        Mat4.translation([-5,5,0]).times(Mat4.scale([1,10,10])).times(Mat4.rotation(-Math.PI/2, Vec.of(0,1,0)))));
    // ceiling
    const ceilingmaterial = new PhongPathTracingMaterial(Vec.of(1,1,1), 0, 0.4);
    objects.push(new Primitive(
        new Square(),
        new PhongPathTracingMaterial(Vec.of(1,1,1), 1000),
        Mat4.translation([0,10.5,0]).times(Mat4.scale([2,1,2])).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));
    objects.push(new Primitive(
        new UnitBox(),
        ceilingmaterial,
        Mat4.translation([0,10,3]).times(Mat4.scale([10,1,4]))));
    objects.push(new Primitive(
        new UnitBox(),
        ceilingmaterial,
        Mat4.translation([0,10,-3]).times(Mat4.scale([10,1,4]))));
    objects.push(new Primitive(
        new UnitBox(),
        ceilingmaterial,
        Mat4.translation([3,10,0]).times(Mat4.scale([4,1,2]))));
    objects.push(new Primitive(
        new UnitBox(),
        ceilingmaterial,
        Mat4.translation([-3,10,0]).times(Mat4.scale([4,1,2]))));

    // objects
    objects.push(new Primitive(
        new Sphere(),
        new PhongPathTracingMaterial(Vec.of(1,1,1), 0, 0.4, 0.6, 1000),
        Mat4.translation([1, 2, -1]).times(Mat4.scale(2))));
    objects.push(new Primitive(
        new Sphere(),
        new PhongPathTracingMaterial(Vec.of(1,1,1), 0, 0.4, 0.6, 100),
        Mat4.translation([-2, 1, 1.5])));

    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new World(objects, []), camera, 128, 4),
        width:  600,
        height: 600
    });
}