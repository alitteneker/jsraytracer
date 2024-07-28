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
    objects.push(new Primitive(
        new Sphere(),
        new PhongMaterial(Vec.of(0,0,1), 0.2, 0.4, 0.6, 100, 0.5),
        Mat4.translation([-2, 0.3, -9])));

    const trans1 = Mat4.translation([-0.5,-1.5,-5])
            .times(Mat4.rotation(0.3, Vec.of(0,1,0)))
            .times(Mat4.scale(0.3));
    const trans2 = Mat4.translation([0.59,0.58,-3.5])
            .times(Mat4.rotation(0.4, Vec.of(0,1,0)))
            .times(Mat4.rotation(1.5, Vec.of(1,0,0)))
            .times(Mat4.scale(0.3));

    loadObjFiles(
        ["../assets/hollow_tetrahedron.obj", "../assets/star.obj"],
        function([tetrahedron_triangles, star_triangles]) {
            const bvh1 = BVHAggregate.build(tetrahedron_triangles, trans1);
            const bvh2 = BVHAggregate.build(star_triangles, trans2);
            
            objects.push(bvh1, bvh2);
            
            callback({
                renderer: new SimpleRenderer(new World(objects, lights), camera, 4),
                width: 600,
                height: 600
            });
        },
        new PhongMaterial(Vec.of(1,0.7,0.7), 0.1, 0.4, 0.6, 100, 0.4));
}