export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        /*Mat4.translation([0,4,0])
            .times(Mat4.rotation(-0.4, Vec.of(1,0,0))));/**/
        Mat4.translation([0,2,0])
            .times(Mat4.rotation(-0.2, Vec.of(1,0,0))));/**/

    const lights = [new SimplePointLight(
        Vec.of(-15, 5, 12, 1),
        Vec.of(1, 1, 1),
        7000
    )];
    const objs = [new SceneObject(
        new Plane(),
        new PhongMaterial(Vec.of(0,0,1), 0.1, 0.5, 0.2, 100),
        Mat4.translation([0,-1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0))))];

    loadObjFile(
        "../assets/potion_bottle/Potion_bottle.obj",
        new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4, 0.6, 100, 0.6),

        Mat4.translation([-0.2,0,-7])
            .times(Mat4.rotation(0.2, Vec.of(0,1,0)))
            .times(Mat4.rotation(-Math.PI/2, Vec.of(1,0,0)))
            .times(Mat4.scale(0.05)),

        function(triangles) {

            callback({
                renderer: new SimpleRenderer(new BVHScene(objs.concat(triangles), lights), camera, 4),
                width: 600,
                height: 600
            });
        });
}