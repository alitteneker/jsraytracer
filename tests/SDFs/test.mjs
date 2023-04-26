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
        
    objects.push(new Primitive(
        new SDFGeometry(
            // BoxBall test with SDFs
            // new UnionSDF(
                // new TransformSDF(new BoxSDF(1),   new SDFMatrixtransformer(Mat4.translation([ 1.2, 0.2, -7]))),
                // new TransformSDF(new SphereSDF(), new SDFMatrixtransformer(Mat4.translation([-2,   0.3, -9])))),
            
            // Infinite Spheres
            // new TransformSDF(new SphereSDF(), new SDFInfiniteRepetitionTransformer(Vec.of(5,5,5))),
            
            // Monger sponge fractal
            new DifferenceSDF(
                new BoxSDF(5),
                new RecursiveTransformUnionSDF(
                    new UnionSDF(
                        new BoxSDF(Vec.of(Infinity, 1/3, 1/3)),
                        new BoxSDF(Vec.of(1/3, Infinity, 1/3)),
                        new BoxSDF(Vec.of(1/3, 1/3, Infinity))),
                    new SDFTransformerSequence(
                        new SDFInfiniteRepetitionTransformer(Vec.of(1,1,1)),
                        new SDFMatrixTransformer(Mat4.scale(1/3))),
                    3)),
            32, 0.001, 100),
        new PhongMaterial(Vec.of(0.1, 0.1, 1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([-2,0.3,-9])));
        
    callback({
        renderer: new IncrementalMultisamplingRenderer(
            new World(objects, lights), camera, 16, 4),
        width: 600,
        height: 600
    });
}