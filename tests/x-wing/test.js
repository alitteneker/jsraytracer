export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0,2,0])
            .times(Mat4.rotation(-0.2, Vec.of(1,0,0))));

    const lights = [new SimplePointLight(
            Vec.of(-10, 10, -12, 1),
            Vec.of(1, 1, 1),
            5000
        ),
        new RandomSampleAreaLight(
            new Square(),
            Mat4.translation([-0.15, 1.86, -2.73])
                .times(Mat4.rotation(0.4, Vec.of(0,1,0)))
                .times(Mat4.scale([0.01, 0.01, 1.5]))
                .times(Mat4.rotation(Math.PI / 2, Vec.of(1,0,0))),
            Vec.of(0,1,0), 10, 4
        )
    ];
    
    const objs = []
    objs.push(new Primitive(
        new Plane(),
        new PhongMaterial(Vec.of(0.3,0.3,0.3), 0.3, 0.4, 0.6, 100, 0.4),
        Mat4.translation([0,1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));
    const sphere_transform = Mat4.translation([-0.15, 1.86, -2.73])
             .times(Mat4.rotation(0.4, Vec.of(0,1,0)))
             .times(Mat4.scale([0.01, 0.01, 1.5]));
    objs.push(new Primitive(
        new Sphere(),
        new FresnelPhongMaterial(Vec.of(0,1,0), 0.2, 0.4, 0.5, 100, 1.3),
        sphere_transform, Mat4.inverse(sphere_transform), false));

    loadObjFile(
        "../assets/x_wing_fighter.obj",
        new PhongMaterial(Vec.of(1,0,0.5), 0.1, 0.4, 0.6, 100, 0.5),

        Mat4.translation([-0.75, 1, -4])
              .times(Mat4.rotation(-0.8, Vec.of(0,1,0)))
              .times(Mat4.scale(0.01)),

        function(triangles) {
            objs.push(BVHAggregate.build(triangles));
            
            callback({
                renderer: new IncrementalMultisamplingRenderer(new World(objs, lights), camera, 16, 4),
                width: 600,
                height: 600
            });
        });
}