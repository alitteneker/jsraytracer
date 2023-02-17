export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1,
        Mat4.translation([0,2,0])
            .times(Mat4.rotation(-0.2, Vec.of(1,0,0))));

    const lights = [new SimplePointLight(
            Vec.of(-10, 100, -12, 1),
            Vec.of(1, 1, 1),
            5000
        )
    ];
    
    const objs = [];

    loadObjFile(
        "../assets/ToledoCity/Toledo.obj",
        new PhongMaterial(Vec.of(1,0,0), 0.1, 0.4, 0.6, 100, 0.5),

        Mat4.translation([-0.75, 2, -4])
              //.times(Mat4.rotation(0.4, Vec.of(0,1,0)))
              .times(Mat4.scale(0.01)),

        function(triangles) {
            callback({
                renderer: new IncrementalMultisamplingRenderer(
                    new BVHScene(objs.concat(triangles), lights), camera, 16, 4),
                width: 600,
                height: 600
            });
        });
}