export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.identity());

    const lights = [new SimplePointLight(
        Vec.of(-15, 5, 12, 1),
        Vec.of(1, 1, 1),
        5000
    )];
    const objs = [new Primitive(
        new Plane(),
        new PhongMaterial(Vec.of(0,0,1), 0.1, 0.4, 0.6, 100),
        Mat4.translation([0,-1.5,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0))))];

    loadObjFile(
        "../assets/cat.obj",
        new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4, 0.6, 100, 0.6),
//         new SolidColorMaterial(Vec.of(1,1,1)),

        Mat4.scale(0.05)
            .times(Mat4.translation([30,-370,-150])),
//             .times(Mat4.rotation(-0.5, Vec.of(0,1,0)))
//             .times(Mat4.scale(0.05)),

        function(triangles) {
            objs.push(BVHAggregate.build(triangles));
            
            callback({
                renderer: new SimpleRenderer(new World(objs, lights), camera, 4),
                width: 600,
                height: 600
            });
        });
}