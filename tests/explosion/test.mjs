// An explosion from the OpenVDB project's explosion.vdb: its density and temperature grids (each converted by
// tools/vdb_to_grid.py with --grid) make a medium that scatters, absorbs and glows. Hot gas emits as a blackbody, in
// proportion to how much it absorbs (see Emission in src/media.js), with temperature 1 standing for `kelvin`. The scene
// is a dusk: a dim sky and a low, weak sun to show the smoke's shape, so the fire stands out. (The fire lights the ground
// too, but only by paths that happen to reach it, since nothing samples glowing media as lights yet: that light is noisy.)
export function configureTest(callback) {
    const camera = new PerspectiveCamera(Math.PI / 4, 1.5,
        Mat4.translation([0, 2.6, 9]).times(Mat4.rotation(0.05, Vec.of(1, 0, 0))));

    // A low sun, to the right and a little behind the explosion, about 1 degree across.
    const offset = Vec.of(70, 25, -40), d = offset.norm();
    const z = offset.times(-1 / d), x = Vec.of(0, 1, 0).cross(z).normalized(), y = z.cross(x);
    const toSun = Mat.of([x[0], y[0], z[0], offset[0]], [x[1], y[1], z[1], offset[1]], [x[2], y[2], z[2], offset[2]], [0, 0, 0, 1]);
    const sun = new DirectionalLight(new Circle(), toSun.times(Mat4.scale(0.01 * d)), Vec.of(1, 0.8, 0.6), 1.5 * 2 * Math.PI * d * d);

    GridMedium.load("../assets/volumes/explosion_density.vol.gz", {
        density: 0.12, albedo: 0.55, g: 0.3,
        emission: { temperature: "../assets/volumes/explosion_temperature.vol.gz", kelvin: 3800, offset: 0.05, scale: 40 }
    }).then(fire => {
        const objects = [
            // The VDB is in voxels, about 200 across, with its base at y = 39 voxels: about 6 units tall here.
            new Volume(fire, Mat4.scale(0.022).times(Mat4.translation([-164, -39, -155]))),
            new Primitive(new Plane(), new PrincipledMaterial({ baseColor: Vec.of(0.3, 0.28, 0.26), roughness: 0.9 }),
                Mat4.rotation(-Math.PI / 2, Vec.of(1, 0, 0))),
            sun
        ];
        callback({
            renderer: new IncrementalMultisamplingRenderer(new World(objects, [], Vec.of(0.05, 0.06, 0.09)), camera, 16, 16,
                "auto", { exposure: 0 }),
            width: 600,
            height: 400
        });
    });
}
