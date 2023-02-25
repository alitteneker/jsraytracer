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
        1000
    )];
    
    const objs = []
    objs.push(new WorldObject(
        new Plane(),
        new PhongMaterial(
            new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0,0,0)),
                        0.3, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0,1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));

    loadObjFile(
        "../assets/bunny2.obj",
        //new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4, 0.6, 100, 0.5),
        new FresnelPhongMaterial(Vec.of(0.8,1,0.8), 0.1, 0.4, 0.6, 10, 1.3),

        Mat4.translation([-0.6, 1, -4]),
//              .times(Mat4.rotation(0, Vec.of(0,1,0))),
//              .times(Mat4.scale(15)),

        function(triangles) {
            callback({
                renderer: new SimpleRenderer(new BVHWorld(objs.concat(triangles), lights/*, Vec.of(0.53, 0.81, 0.92).times(0.6)*/), camera, 4),
                width: 600,
                height: 600
            });
        });
}