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
        
    
    const scale = 1;
    objects.push(new Primitive(
        new SDFGeometry(
            // new DifferenceSDF(
                // new BoxSDF(5),
                //new RecursiveTransformUnionSDF(
                    new UnionSDF(
                        new BoxSDF(Vec.of(100, 1/scale,  1/scale)),
                        new BoxSDF(Vec.of(1/scale,  100, 1/scale)),
                        new BoxSDF(Vec.of(1/scale,  1/scale,  100))),
                    // new SDFTransformerSequence(
                        // new SDFInfiniteRepetitionTransformer(Vec.of(1,1,1)),
                        // new SDFMatrixTransformer(Mat4.scale(1/scale))),
                    // 3)),
            32, 0.001, 100),
        new PhongMaterial(Vec.of(0.1, 0.1, 1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([0,2,-6])));
        
    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new World(objects, lights), camera, 16, 4),
        width: 600,
        height: 600
    });
}