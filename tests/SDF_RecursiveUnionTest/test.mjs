export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.identity()
            .times(Mat4.translation([-6, 1, 0]))
            .times(Mat4.rotation(-0.6, Vec.of(0,1,0)))
            .times(Mat4.rotation(-0.2, Vec.of(1,0,0))));

    const lights = [new SimplePointLight(
        Vec.of(10, 7, 10, 1),
        Vec.of(1, 1, 1),
        5000
    ),
    new SimplePointLight(
        Vec.of(-6, 2, -1, 1),
        Vec.of(1, 1, 1),
        2000
    )];

    const objects = [];
    objects.push(new Primitive(
        new Plane(),
        new PhongMaterial(
            new CheckerboardMaterialColor(Vec.of(1,1,1), Vec.of(0,0,0)),
                0.1, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0,-1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0)))));
        
    
    const scale = 3;
    objects.push(new Primitive(
        new SDFGeometry(
            new RecursiveTransformUnionSDF(
                new UnionSDF(
                    new BoxSDF(Vec.of(Infinity, 1/scale,  1/scale)),
                    new BoxSDF(Vec.of(1/scale,  Infinity, 1/scale))),
                new SDFTransformerSequence(
                    new SDFMatrixTransformer(Mat4.scale(1/scale)),
                    new SDFInfiniteRepetitionTransformer(Vec.of(10,10,10000000))),
                2),
            600, 0.00001, 1000),
        new PhongMaterial(Vec.of(0.1, 0.1, 1), 0.2, 0.4, 0.6, 100, 0.15),
        Mat4.translation([-1.5,-1,-13.5]).times(Mat4.rotationY(-0.45)).times(Mat4.rotationX(-Math.pi / 2)).times(Mat4.scale(5))));
        
    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new World(objects, lights), camera, 16, 4),
        width: 600,
        height: 600
    });
}