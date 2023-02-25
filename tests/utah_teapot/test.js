export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0,1.5,1])
            .times(Mat4.rotation(-0.4, Vec.of(1,0,0))));
    const world = new World();

    const lights = [new SimplePointLight(
        Vec.of(-15, 5, 12, 1),
        Vec.of(1, 1, 1),
        7000
    )];
    const objs = [new WorldObject(
        new Plane(),
        new PhongMaterial(Vec.of(0,0,1), 0.1, 0.4, 0.6, 100, 0.4),
        Mat4.translation([0,-1.5,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0))))];

    loadObjFile(
//         "../assets/teapot.obj",
        "../assets/high-poly-teapot.obj",
        new PhongMaterial(Vec.of(1,1,1), 0.1, 0.4, 0.6, 100, 0.6),

        Mat4.translation([-0.4,-1.5,-6])
            .times(Mat4.rotation(-0.5, Vec.of(0,1,0)))
            .times(Mat4.rotation(-Math.PI/2, Vec.of(1,0,0)))
            .times(Mat4.scale(0.15)),

        function(triangles) {
            callback({
                renderer: new IncrementalMultisamplingRenderer(
                    new BVHWorld(objs.concat(triangles), lights), camera, 8, 4),
                width: 600,
                height: 600
            });
        });
}