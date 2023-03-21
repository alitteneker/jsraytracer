export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([-7,0.5,4]));

    const lights = [new SimplePointLight(
        Vec.of(10, 7, 10, 1),
        Vec.of(1, 1, 1),
        10000
    )];

    const objects = [];
    objects.push(new Primitive(
        new Plane(),
        new PhongMaterial(Vec.of(0.5, 0.5, 0.5), 0.1, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0,-1.5,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));
    
    const box = new Primitive(
        new UnitBox(),
        new PhongMaterial(Vec.of(1,0,0), 0.2, 0.4, 0.6, 100, 0.5),
        //new FresnelPhongMaterial(Vec.of(1,1,1), 0, 0.4, 0.6, 100, 1.3, Vec.of(1, 0.5, 0.5), Vec.of(0.5,0.5,1)),
        Mat4.translation([1, 0.3, -9, 1]).times(Mat4.scale(2)));
    const ball = new Primitive(
        new Sphere(),
        new PhongMaterial(Vec.of(0,0,1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([-2, 0.3, -9]));
    const agg = new Aggregate([box, ball], Mat4.translation([-6,0,0]));
    objects.push(agg);
    objects.push(new Aggregate([agg, ball], Mat4.translation([-9,3,-9]).times(Mat4.eulerRotation([0, Math.PI, 0])).times(Mat4.translation([3,0,9]))));

        
    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new World(objects, lights), camera, 16, 4),
        width: 600,
        height: 600
    });
}