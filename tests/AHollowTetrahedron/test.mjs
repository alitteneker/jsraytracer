export function configureTest(callback) {

    const camera = new PerspectiveCamera(Math.PI / 4, 1, Mat4.identity());

    const lights = [new SimplePointLight(
        Vec.of(10, 5, 10, 1),
        Vec.of(1, 0.87, 0),
        5000
    )];
    
    const objects = [new Primitive(
        new Plane(),
        new PhongMaterial(Vec.of(0.7,0.7,1), 0.1, 0.4, 0.6, 100, 0.2),
        Mat4.translation([0,-1,0]).times(Mat4.rotation(Math.PI/2, Vec.of(1,0,0))))];

    const trans1 = Mat4.translation([0.5,-1.5,-5])
            .times(Mat4.rotation(0.3, Vec.of(0,1,0)))
            .times(Mat4.scale(0.3));
    const trans2 = Mat4.translation([0.5,-1.5,-8])
            .times(Mat4.rotation(-0.5, Vec.of(0,1,0)))
            .times(Mat4.scale(0.3));

    loadObjFile(
        "../assets/hollow_tetrahedron.obj",
        new PhongMaterial(Vec.of(1,0.7,0.7), 0.1, 0.4, 0.6, 100, 0.4),

        Mat4.identity(),

        function(triangles) {
            const bvh1 = BVHAggregate.build(triangles, trans1);
            const bvh2 = new BVHAggregate(triangles, bvh1.kdtree, trans2);
            
            objects.push(bvh1, bvh2);
            
            callback({
                renderer: new SimpleRenderer(new World(objects, lights), camera, 4),
                width: 600,
                height: 600
            });
        });
}