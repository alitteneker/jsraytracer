# JSRaytracer

**A path tracer that runs in your browser with no installs, no build step and no dependencies to fetch.**

Build a scene from plain JavaScript classes. JSRaytracer can then render it two ways: as a GLSL shader generated
for that scene and run in real time on your GPU, or as a multithreaded CPU tracer you can step through in a debugger.
Both renderers read the same scene graph, so the CPU tracer doubles as a reference implementation for the GPU one.

**[Try the GPU demo](https://alitteneker.github.io/jsraytracer/gl)** &nbsp;|&nbsp;
**[Try the CPU demo](https://alitteneker.github.io/jsraytracer/)**

---

## Highlights

- **Real-time on the GPU.** Each scene gets its own WebGL2 fragment shader, specialized for that scene's
  geometry, materials and BVH layout. Every frame adds another sample per pixel, so the image refines while you watch.
- **A 100,000-triangle dragon at about 2.6 ms per sample pass**, down from 6 ms after a round of traversal
  optimizations. See [Performance.md](Performance.md) for the full story.
- **Edit the scene live.** Click any object to select it, then drag it, rotate it, scale it or change its material,
  and the render keeps converging. That includes lights. Add spheres, boxes, planes and lights, or delete what's
  selected; with `?worldEditable=true` the shader is built to handle any scene, so these edits apply in milliseconds
  without recompiling.
- **Lights you can see.** Area lights are part of the scene like any other object. Look at one directly, or in a
  mirror or through glass, and you see a glowing surface, consistent with the light it casts. Lights can be nested
  inside transformed groups like any other object.
- **Signed distance fields.** Build shapes from functional operators (unions, intersections, repetition,
  fractals like the Menger sponge and Sierpinski tetrahedron) and render them by ray marching, mixed freely with
  ordinary geometry.
- **Path tracing or Whitted-style.** Choose classic Phong shading with exact reflection and refraction, or full
  path tracing over an approximate Phong BRDF with Fresnel effects.
- **Real assets.** Loads OBJ and MTL files with textures. Scenes can be serialized to JSON or MessagePack.

## The two renderers

| | GPU (WebGL2) | CPU (Web Workers) |
|---|---|---|
| Speed | Tens to hundreds of samples per second for most scenes | About a minute or less per sample pass |
| Interaction | Live editing of transforms, materials and lights | Render and view |
| Best for | Exploring scenes, look development, performance work | Debugging, checking the GPU's results against a reference |
| Entry point | [`gl/index.html`](gl/index.html) | [`index.html`](index.html) |

## Features

**Geometry**
- Spheres, planes, squares, circles, cylinders, unit boxes and triangles
- Triangle meshes from OBJ files, with MTL materials and textures
- Signed distance fields assembled from primitives and operators, intersected by ray marching
- Aggregates (groups with their own transforms, which can be nested) and instancing

**Acceleration**
- Bounding volume hierarchies built with the surface area heuristic (SAH)
- GPU traversal tuned for WebGL2: child bounding boxes stored with each parent so a missed child is never fetched,
  nearest-child-first visiting, power-of-two data texture layouts, Moller-Trumbore triangle tests, and shadow rays
  skipped when a light can't contribute

**Shading**
- Phong materials with reflection, refraction and transmission
- Fresnel effects and path tracing over an approximate Phong BRDF, with diffuse, glossy and mirror lobes
- Solid, checkerboard and texture-mapped material colors

**Lights**
- Point lights, and area lights in any supported shape (square, circle, sphere and more), sampled by area
- Lights are scene objects: they can be hit by rays, picked and edited in the GPU editor, and placed inside groups
- Direct light sampling combined with visible emission, without counting any light twice

**Cameras and sampling**
- Perspective camera, with depth of field
- Incremental per-pixel multisampling with an optional denoising pass on the GPU

## Running it locally

Everything is static files. Any web server works. One is included:

```sh
python server.py        # serves the repository on http://localhost:8000
```

On Windows, `host.bat` does the same thing. Then open:

- `http://localhost:8000/gl/` for the GPU renderer and editor
- `http://localhost:8000/` for the CPU renderer

Pick a scene from the dropdown, or jump straight to one with `?test=<name>`, for example
`http://localhost:8000/gl/?test=dragon`. Add `&worldEditable=true` to build the editable shader, which reads the scene
from textures instead of compiling it in. It renders a little slower, but adding and removing objects is then instant.

### Scenes

The `tests/` folder holds more than thirty scenes, listed in [`tests/list.json`](tests/list.json). A few to start with:

| Scene | What it shows |
|---|---|
| `ASimpleScene` | The basic geometry types under a single point light |
| `refraction`, `diamond`, `bottle` | Glass and refraction |
| `cornell_box_path` | Path-traced global illumination from an area light |
| `BoxBall_DOF` | Depth of field |
| `bunny`, `dragon` | Large triangle meshes in a BVH |
| `starwars` | Instanced meshes, glowing laser bolts and depth of field together |
| `SDF_Menger`, `SDF_Sierpinski` | Fractals built from signed distance fields |

`dragon_json` and `toledo_json` load serialized versions of their scenes, which are too large to keep in the
repository. Generate them first with `cd tests && node test_to_json.js dragon` (or `toledo`, which also needs the
`@msgpack/msgpack` package).

## Writing a scene

A scene is a module in `tests/<name>/test.mjs` that hands back a renderer. Add its name to `tests/list.json` and it
appears in the dropdown.

```js
export function configureTest(callback) {
    const camera = new PerspectiveCamera(Math.PI / 4, 1, Mat4.translation([0, 0, 5]));

    const objects = [
        new Primitive(new Sphere(),
            new PhongMaterial(Vec.of(0.1, 0.1, 1), 0.2, 0.4, 0.6, 100, 0.5)),
        new Primitive(new Plane(),
            new PhongMaterial(Vec.of(0.5, 0.5, 0.5), 0.1, 0.4, 0.6, 100, 0.5),
            Mat4.translation([0, -1, 0]).times(Mat4.rotation(Math.PI / 2, Vec.of(1, 0, 0)))),
        // Lights are scene objects too.
        new RandomSampleAreaLight(new Square(),
            Mat4.translation([0, 4, 0]).times(Mat4.rotation(Math.PI / 2, Vec.of(1, 0, 0))),
            Vec.of(1, 1, 1), 200)
    ];

    callback({
        renderer: new IncrementalMultisamplingRenderer(new World(objects), camera, 16, 4),
        width: 600,
        height: 600
    });
}
```

## Under the hood

```
src/        The scene model and CPU tracer: math, geometry, materials, lights, cameras, aggregates (BVH),
            SDFs, OBJ loading, serialization, and the Web Worker renderer.
gl/         The GPU renderer: adapters that walk the scene graph and generate GLSL for it, plus the editor UI.
tests/      Example scenes, one folder each.
assets/     Models and textures used by the scenes.
```

The GPU side does not interpret the scene at runtime. Each adapter in `gl/src/` (world, geometries, materials,
lights) visits its part of the scene graph, packs the data into uniforms and data textures, and emits the GLSL that
reads it. For scenes that aren't being restructured, the generated shader is unrolled for that specific scene.

### Performance tooling

The GPU renderer has measurement tools built in, controlled by static flags or URL parameters:

- `?debugGPUTimer=true` logs the true GPU time per pass using timer queries, independent of vsync
- `?debugTraversalHeatmap=nodes` colors each pixel by BVH traversal work, with per-frame statistics
- `?bench=4&benchRef=compare&benchRefKey=<name>` runs a timed benchmark and checks the image against a saved
  reference, so an optimization can be proven not to change the picture

[Performance.md](Performance.md) covers what was measured, what changed and what didn't help.

## Roadmap

- Adding meshes and grouping objects from the editor
- Russian roulette path termination
- Solid angle sampling for area lights
- A Disney principled BSDF
- Adaptive multisampling

## License

MIT. See [License.txt](License.txt).
