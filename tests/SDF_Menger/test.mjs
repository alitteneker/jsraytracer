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
            new DifferenceSDF(
                new BoxSDF(1),
                new RecursiveTransformUnionSDF(
                    new UnionSDF(
                        new BoxSDF(Vec.of(Infinity, 1/scale,  1/scale)),
                        new BoxSDF(Vec.of(1/scale,  Infinity, 1/scale)),
                        new BoxSDF(Vec.of(1/scale,  1/scale,  Infinity))),
                    new SDFTransformerSequence(
                        new SDFMatrixTransformer(Mat4.scale(1/scale)),
                        new SDFInfiniteRepetitionTransformer(Vec.of(2,2,2))),
                    3)),
            128, 0.001, 100),
        new PhongMaterial(Vec.of(0.1, 0.1, 1), 0.2, 0.4, 0.6, 100, 0.15),
        Mat4.translation([-3.5,0.5,-3.5]).times(Mat4.rotationY(0.3))));
        
    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new World(objects, lights), camera, 16, 4),
        width: 600,
        height: 600
    });
}