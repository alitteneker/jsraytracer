function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        /*Mat4.translation([0,4,0])
            .times(Mat4.rotation(-0.4, Vec.of(1,0,0))));/**/
        Mat4.translation([0,2,0])
            .times(Mat4.rotation(-0.2, Vec.of(1,0,0))));/**/

    const lights = [new SimplePointLight(
        Vec.of(-15, 5, 12, 1),
        Vec.of(1, 1, 1)       
    )];
    const objs = [new SceneObject(
        new Plane(Vec.of(0, 1, 0, 0), -1.5),
        new PhongMaterial(Vec.of(0,0,1), 0.1, 0.4, 0.6, 100))];

    loadObjFile(
        "../assets/heart.obj",
        new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4, 0.6, 100, 0.6),

        Mat4.translation([-0.2,-1,-7])
            .times(Mat4.rotation(-0.5, Vec.of(0,1,0)))
            .times(Mat4.scale(0.05)),

        function(triangles) {

            callback({
                renderer: new SimpleRenderer(new BVHScene(objs.concat(triangles), lights), camera, 4),
                width: 600,
                height: 600
            });
        });
}