export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        /*Mat4.translation([0,4,0])
            .times(Mat4.rotation(-0.4, Vec.of(1,0,0))));/**/
        Mat4.translation([0,4,-3])
            .times(Mat4.rotation(-0.6, Vec.of(1,0,0))));/**/

    const lights = [
        new SimplePointLight(
            Vec.of(-15, 5, 12, 1),
            Vec.of(1, 1, 1),
            7000
        ),
        new SimplePointLight(
            Vec.of(-10, 10, -100, 1),
            Vec.of(1.0, 1.0, 0.8),
            75000
        )];
        
    const objs = []
    objs.push(new WorldObject(
        new Plane(),
        new PhongMaterial(
            new CheckerboardMaterialColor(Vec.of(0.5,0.5,0.5), Vec.of(0.1,0.1,0.1)),
                0.1, 0.4, 0.6, 2, 0.5),
        Mat4.translation([0,-1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));

    loadObjFile(
        "../assets/diamond.obj",
        new FresnelPhongMaterial(Vec.of(0.827,0.827,0.827), 0.1, 0.4, 0.8, 100, 2.4),

        Mat4.translation([-0.2,1.5,-10])
            .times(Mat4.rotation(-0.4, Vec.of(0,1,0)))
            .times(Mat4.rotation(0.1, Vec.of(1,0,0)))
            .times(Mat4.scale(1)),

        function(triangles) {

            callback({
                renderer: new SimpleRenderer(new BVHWorld(objs.concat(triangles), lights, Vec.of(0.9, 0.9, 0.9)), camera, 4),
                width: 600,
                height: 600
            });
        });
}