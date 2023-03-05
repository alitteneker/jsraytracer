export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0,2,0])
            .times(Mat4.rotation(-0.2, Vec.of(1,0,0))));

    const lights = [new SimplePointLight(
        Vec.of(-15, 10, 12, 1),
        Vec.of(1, 1, 1),
        5000
    )];
    
    const objs = [];
    objs.push(new Primitive(
        new Plane(),
        new PhongMaterial(
            new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0,0,0)),
                        0.3, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0,1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));

    loadObjFile(
        "../assets/dragon.obj",
        new PhongMaterial(Vec.of(0.3884335160255432, 1, 0.8839936256408691), 0.01, 0.8, 0.2, 32, 0.5),
        //new FresnelPhongMaterial(Vec.of(0.3884335160255432, 1, 0.8839936256408691), 0.01, 0.9, 0.1, 32, 1.3),

        Mat4.translation([0, 1, -4])
              .times(Mat4.rotation(0.3, Vec.of(0,1,0)))
              .times(Mat4.scale(0.175)),

        function(triangles) {
            objs.push(BVHAggregate.build(triangles));
            
            callback({
                renderer: new IncrementalMultisamplingRenderer(new World(objs, lights, Vec.of(0,0,0)), camera, 8, 4),
                width: 600,
                height: 600
            });
        });
}