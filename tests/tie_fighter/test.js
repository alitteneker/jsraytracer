function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0,2,0])
            .times(Mat4.rotation(-0.2, Vec.of(1,0,0))));

    const lights = [new SimplePointLight(
        Vec.of(-10, 10, -12, 1),
        Vec.of(1, 1, 1),
        5000
    ),
    new SimplePointLight(
        Vec.of(3, 5, 0, 1),
        Vec.of(0, 1, 0),
        100
    )];
    
    const objs = []
    objs.push(new SceneObject(
        new Plane(Vec.of(0, 1, 0, 0), 1),
        new PhongMaterial(Vec.of(0.3,0.3,0.3), 0.3, 0.4, 0.2, 100, 0.4)));
    objs.push(new SceneObject(
        new Sphere(Mat4.translation([-0.2, 1.9, -2.75])
             .times(Mat4.rotation(0.4, Vec.of(0,1,0)))
             .times(Mat4.scale([0.01, 0.01, 1.5]))),
        new FresnelPhongMaterial(Vec.of(0,1,0), 0.2, 0.4, 0.5, 100, 1.3)));

    loadObjFile(
        "../assets/Tie_Fighter.obj",
        new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4, 0.6, 100, 0.5),

        Mat4.translation([-0.75, 2, -4])
              .times(Mat4.rotation(0.4, Vec.of(0,1,0)))
              .times(Mat4.scale(0.2)),

        function(triangles) {
            callback({
                renderer: new /*RandomMultisamplingRenderer*/IncrementalMultisamplingRenderer(
                    new BVHScene(objs.concat(triangles), lights), camera, 16, 4),
                width: 600,
                height: 600
            });
        });
}