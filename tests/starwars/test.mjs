export function configureTest(callback) {

    const camera = new DepthOfFieldPerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([-0.73,2.05,7.5])
            .times(Mat4.rotation(-0.2, Vec.of(1,0,0)))
            .times(Mat4.rotation(-0.3, Vec.of(0,1,0))),
        5.35, 0.04);
    

    const lights = [new SimplePointLight(
            Vec.of(-10, 10, -12, 1),
            Vec.of(1, 1, 1),
            5000
        ),
    ];

    
    const objs = []
    objs.push(new Primitive(
        new Plane(),
        new PhongMaterial(Vec.of(0.3,0.3,0.3), 0.3, 0.4, 0.6, 100, 0.4),
        Mat4.translation([0,1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));

    const bolttransforms = [
        Mat4.translation([-0.15, 1.86, -2.73])
            .times(Mat4.rotation(0.4, Vec.of(0,1,0)))
            .times(Mat4.scale([0.01, 0.01, 1.5])),
        Mat4.translation([0.1, 2.15, 1.5])
            .times(Mat4.rotation(0.4, Vec.of(0,1,0)))
            .times(Mat4.scale([0.01, 0.01, 1.5])),
        Mat4.translation([2, 1.7, 2.6])
            .times(Mat4.rotation(0.4, Vec.of(0,1,0)))
            .times(Mat4.scale([0.01, 0.01, 1.5]))
    ];
    const boltlighttransform = Mat4.scale(2).times(Mat4.rotation(Math.PI / 2, Vec.of(1,0,0)));
    for (let bolttransform of bolttransforms) {
        lights.push(new RandomSampleAreaLight(
            new Square(),
            bolttransform.times(boltlighttransform),
            Vec.of(0,1,0), 10, 4
        ));
        objs.push(new Primitive(
            new Sphere(),
            new FresnelPhongMaterial(Vec.of(0,1,0), 0.2, 0.4, 0.5, 100, 1.3),
            bolttransform, Mat4.inverse(bolttransform), false));
    }

    loadObjFiles(
        ["../assets/Tie_Fighter.obj", "../assets/x_wing_fighter.obj"],

        function([tiefighter, xwing]) {
            const tie1 = BVHAggregate.build(tiefighter,
                Mat4.translation([-0.75, 2, -4])
                  .times(Mat4.rotation(0.4, Vec.of(0,1,0)))
                  .times(Mat4.scale(0.2)));
            const tie2 = new BVHAggregate(tiefighter, tie1.kdtree,
                Mat4.translation([6, 6, -20])
                  .times(Mat4.rotation(0.2, Vec.of(0,1,0)))
                  .times(Mat4.scale(0.2)));
            const tie3 = new BVHAggregate(tiefighter, tie1.kdtree,
                Mat4.translation([0.5, 4, -10])
                  .times(Mat4.rotation(0.3, Vec.of(0,1,0)))
                  .times(Mat4.scale(0.2)));
            objs.push(tie1, tie2, tie3);
            
            objs.push(BVHAggregate.build(xwing,
                Mat4.translation([0.2, 1.1, 0.43])
                    .times(Mat4.rotation(0.2, Vec.of(0,0,1)))
                    .times(Mat4.rotation(-1.22, Vec.of(0,1,0)))
                    .times(Mat4.scale(0.0075))));
            
            callback({
                renderer: new IncrementalMultisamplingRenderer(new World(objs, lights), camera, 16, 4),
                width: 600,
                height: 600
            });
        });
}