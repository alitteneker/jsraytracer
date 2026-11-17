// A cloud from a voxel grid: the OpenVDB project's bunny_cloud.vdb (see tools/vdb_to_grid.py, which converted it at
// half resolution), lit by a sun (a directional light, see src/lights.js) and a blue sky (the world's background, which
// path tracing gathers as light). Its density is per unit of the VDB's own space, so scaling the volume keeps its look.
export function configureTest(callback) {
    const camera = new PerspectiveCamera(Math.PI / 4, 1.5,
        Mat4.translation([0, 2, 10]).times(Mat4.rotation(-0.05, Vec.of(1, 0, 0))));

    // The sun, up, to the left and behind the camera, about 1 degree across.
    const offset = Vec.of(-50, 80, 60), d = offset.norm();
    const z = offset.times(-1 / d), x = Vec.of(0, 1, 0).cross(z).normalized(), y = z.cross(x);
    const toSun = Mat.of([x[0], y[0], z[0], offset[0]], [x[1], y[1], z[1], offset[1]], [x[2], y[2], z[2], offset[2]], [0, 0, 0, 1]);
    const sun = new DirectionalLight(new Circle(), toSun.times(Mat4.scale(0.01 * d)), Vec.of(1, 0.95, 0.88), 8 * 2 * Math.PI * d * d);

    GridMedium.load("../assets/volumes/bunny_cloud.vol.gz", { density: 3, albedo: 0.98, g: 0.6 }).then(cloud => {
        const objects = [
            new Volume(cloud, Mat4.translation([0, 0.4, 0]).times(Mat4.scale(0.1))),
            new Primitive(new Plane(), new PrincipledMaterial({ baseColor: Vec.of(0.35, 0.4, 0.3), roughness: 0.9 }),
                Mat4.rotation(-Math.PI / 2, Vec.of(1, 0, 0))),
            sun
        ];
        callback({
            renderer: new IncrementalMultisamplingRenderer(new World(objects, [], Vec.of(0.25, 0.38, 0.65)), camera, 16, 16,
                "auto", { exposure: -1.5 }),
            width: 600,
            height: 400
        });
    });
}
