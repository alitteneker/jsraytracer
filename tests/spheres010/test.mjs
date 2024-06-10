export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([-7,0.5,4]));

    const lights = [new SimplePointLight(
        Vec.of(10, 7, 10, 1),
        Vec.of(1, 1, 1),
        10000
    )];

    const objects = [];
    objects.push(new Primitive(
        new Plane(),
        new PhongMaterial(Vec.of(0.5, 0.5, 0.5), 0.1, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0,-6,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));

    
    const NI = 5, NJ = 2, NK = 1;
    for (let i = 0; i < NI; ++i) {
        for (let j = 0; j < NJ; ++j) {
            for (let k = 0; k < NK; ++k) {
                objects.push(new Primitive(
                    new Sphere(),
                    new PhongMaterial(Vec.of(0.1,0.1,1), 0.2, 0.4, 0.6, 100, 0.5),
                    Mat4.translation([-11 + 2*i, -3.7 + 2*j, -12 - 2*k])));
            }
        }
    }

        
    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new World(objects, lights), camera, 16, 4),
        width: 600,
        height: 600
    });
}