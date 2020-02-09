function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1, Mat4.identity());
    const scene = new Scene();

    const lights = [new SimplePointLight(
        Vec.of(10, 5, 10, 1),
        Vec.of(1, 0.87, 0)       
    )];

    loadObjFiles(
        [{
            filename: "../assets/cube.obj",
            defaultMaterial: new PhongMaterial(Vec.of(0,1,0), 0.1, 0.4, 0.6, 100, 0.5),
            transform: Mat4.translation([-1,0,-8])
                .times(Mat4.rotation(Math.PI/9, Vec.of(1,0,0)))
                .times(Mat4.rotation(Math.PI/3, Vec.of(0,1,0)))
        }, {
            filename: "../assets/cylinder.obj",
            defaultMaterial: new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4, 0.6, 100, 0.5),
            transform: Mat4.translation([1.5,0,-10])
                .times(Mat4.rotation(3, Vec.of(0,1,0)))
                .times(Mat4.rotation(-Math.PI/2, Vec.of(1,0,0)))
        }],

        function(objs) {
            objs = objs.flat();
            objs.push(new SceneObject(
                new Plane(Vec.of(0, 1, 0, 0), -1),
                new PhongMaterial(Vec.of(1,1,1), 0.1, 0.4, 0.6, 100, 0.5)));

            callback({
                renderer: new SimpleRenderer(new Scene(objs, lights), camera, 4),
                width: 600,
                height: 600
            });
        });
}