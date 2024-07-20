export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0,2,0])
            .times(Mat4.rotation(-0.2, Vec.of(1,0,0))));

    const lights = [new SimplePointLight(
        Vec.of(-15, 5, 12, 1),
        Vec.of(1, 1, 1),
        5000
    ),
    new SimplePointLight(
        Vec.of(1, 5, -8, 1),
        Vec.of(0.8, 0.8, 1),
        5000
    )];
    
    const objs = []
    objs.push(new Primitive(
        new Plane(),
        new PhongPathTracingMaterial(
            new CheckerboardMaterialColor(Vec.of(0.8,0.8,0.8), Vec.of(0.2,0.2,0.2)),
                        0.3, 0.4, 0.6, 100),
        Mat4.translation([0,1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));

    loadObjFile(
        "../assets/bunny2.obj",
        //new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4, 0.6, 100, 0.5),
        new FresnelPhongMaterial(Vec.of(0.8,1,0.8), 0.1, 0.4, 0.6, 10, 1.3),
        Mat4.identity(),

        function(triangles) {
            objs.push(BVHAggregate.build(triangles,
                Mat4.translation([-0.6, 1, -4]),
//                  .times(Mat4.rotation(0, Vec.of(0,1,0))),
//                  .times(Mat4.scale(15)),));
            
            callback({
                renderer: new IncrementalMultisamplingRenderer(new World(objs, lights), camera, 128, 4),
                width: 600,
                height: 600
            });
        });
}