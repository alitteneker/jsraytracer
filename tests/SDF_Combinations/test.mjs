export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.identity()
            .times(Mat4.translation([-6, 5, 0]))
            .times(Mat4.rotation(-0.61, Vec.of(0,1,0)))
            .times(Mat4.rotation(-0.37, Vec.of(1,0,0))));

    const lights = [new SimplePointLight(
        Vec.of(10, 7, 10, 1),
        Vec.of(1, 1, 1),
        5000
    )];

    const objects = [];
    objects.push(new Primitive(
        new Plane(),
        new PhongMaterial(
            new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0,0,0)),
                0.1, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0,-1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));
    
    const box  = new TransformSDF(new BoxSDF(Vec.of(1,0.5,1), Vec.of(0.1,0.1,1)),   new SDFMatrixTransformer(Mat4.translation([0, 0.2,  0])));
    const ball = new TransformSDF(new SphereSDF(0.75,         Vec.of(1,0.1,0.1)),   new SDFMatrixTransformer(Mat4.translation([0, 0.7, 0])));
    objects.push(new Primitive(
        new SDFGeometry(new UnionSDF(box, ball), 128, 0.00001, 100),
        new PhongMaterial(Vec.of(1, 1, 1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([2,0,-7])));
    objects.push(new Primitive(
        new SDFGeometry(new IntersectionSDF(box, ball), 128, 0.00001, 100),
        new PhongMaterial(Vec.of(1, 1, 1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([-0.5,0,-7])));
    objects.push(new Primitive(
        new SDFGeometry(new DifferenceSDF(box, ball), 128, 0.00001, 100),
        new PhongMaterial(Vec.of(1, 1, 1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([-3,0,-7])));
    objects.push(new Primitive(
        new SDFGeometry(new SmoothUnionSDF(box, ball), 128, 0.00001, 100),
        new PhongMaterial(Vec.of(1, 1, 1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([2,3,-7])));
    objects.push(new Primitive(
        new SDFGeometry(new SmoothIntersectionSDF(box, ball), 128, 0.00001, 100),
        new PhongMaterial(Vec.of(1, 1, 1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([-0.5,3,-7])));
    objects.push(new Primitive(
        new SDFGeometry(new SmoothDifferenceSDF(box, ball), 128, 0.00001, 100),
        new PhongMaterial(Vec.of(1, 1, 1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([-3,3,-7])));
        
    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new World(objects, lights), camera, 16, 4),
        width: 600,
        height: 600
    });
}