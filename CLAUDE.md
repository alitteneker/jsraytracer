# jsraytracer

A JavaScript ray/path tracer with two independent implementations of the same scene semantics:

- **`src/`** — CPU-side tracer (runs standalone in Node/Web Worker, and acts as the reference model the GL layer mirrors).
- **`gl/`** — WebGL2/GLSL layer: an adapter set that *generates GLSL shader source* from a scene graph, plus an interactive editor UI.

There is **no shared source of truth** between the two. The same shape/material/BVH logic exists once as interpreted JS (`src/`) and again as GLSL-string generation (`gl/`). Consequence: adding or changing a geometry/material/aggregate type means editing **both** sides and adding a serialize→deserialize round-trip check. Most historical bugs were the two sides drifting out of sync.

## Layout

- `src/math.js` — Vec/Mat/quaternion primitives. Verified correct (Mat3/Mat4 inverse, projections, rotations).
- `src/geometry.js` — primitives + intersection; `Triangle`, `AABB`, `OriginPoint`, etc.
- `src/aggregates.js` — `Aggregate`, `BVHAggregate`/`BVHAggregateNode` (SAH build), `BSPAggregate`.
- `src/materials.js` — `PhongMaterial` → `FresnelPhongMaterial` → `PhongPathTracingMaterial`; `MaterialColor` variants.
- `src/sdf.js`, `lights.js`, `cameras.js`, `renderers.js`, `world.js`, `objloader.js`, `serializer.js`, `worker.js`, `pixelbuffer.js`.
- `gl/src/WebGLRendererAdapter.js` — owns the generated tracer shader + the passthrough/denoise shader, the render/accumulation loop, and the **debug toggles** (see below).
- `gl/src/WebGLWorldAdapter.js` — largest file; turns the scene graph into GLSL. Contains BVH traversal generation and the `WORLD_EDITABLE` split.
- `gl/src/WebGL{Materials,Geometries,SDF,Camera,Lights}Adapter.js`, `WebGLEditorInterface.js` (editor UI), `WebGLUtilHelpers.js`.

### The `WORLD_EDITABLE` split
`WebGLWorldAdapter` generates two very different shaders from one codebase:
- **editable** (editor): a data-driven interpreter — scene data lives in textures, traversal uses dynamic loops. One shader renders any scene; slower; only the editor uses it.
- **non-editable** (default for tests): per-scene specialized GLSL with object logic unrolled/inlined. Faster to run, slow to compile.

## Running

No build step / no package.json. The GL app is a static page: `gl/index.html` + `gl/webgl-demo.js`, served over a local HTTP server (needs WebGL2, ES modules, and `fetch`). Tests are listed in `tests/list.json`; each is `tests/<name>/test.mjs` exporting `configureTest`. Select a scene with the `?test=<name>` URL param. BVH-exercising scenes: `dragon`, `bunny`, `starwars`, `AHollowTetrahedron`, `AMultipleBVH` (the `spheres*` scenes are flat `Aggregate`s and never hit the BVH path).

`node --check <file>` validates the JS, but **cannot** validate the GLSL embedded in template strings — shader errors only surface when loaded in a browser. The console logs generated shader line count and compile time on each build.

## Performance investigation (in progress)

Symptom: ~5 FPS on `dragon`/`starwars` at 4 bounces on old hardware, despite the erichlof THREE.js path tracer running the *same* megakernel-fragment-shader architecture in real time — so this is an **efficiency gap, not an architectural ceiling.**

Method: **compile-time** ablation via static flags on `WebGLRendererAdapter` (see below). They're read at shader-generation time so ablated code is genuinely absent (dead-code-eliminated), not just runtime-branched — a runtime `if` would leave register pressure unchanged. Set a flag in the browser console, **reload the scene to rebuild**, record FPS + compile time.

Findings so far (all measured on `dragon`, 4 bounce, 200ms baseline):
- **Denoiser is not the bottleneck** (toggling `uDoDenoise` off = no change). Buffers are RGBA32F, not 16F.
- **Material fetches are ~free** — `debugConstMaterialParams` matched to the real material gives identical FPS. Texture-read hypothesis is dead.
- **Material math is ~free** (~2ms at 1 bounce). `glossyScatter` is expensive but *unused* by plain `PhongMaterial` (which gets `mirrorProbability = 1.0` → cheap mirror branch); it only matters for `PhongPathTracingMaterial` scenes like `cornell_box_path`.
- **Register pressure / occupancy is RULED OUT.** The `debugBallastRegisters` occupancy probe (injects N live `vec4`s of dead work) is flat up to N≈32 (~128 registers of headroom); only degrades at N≥64. That much headroom means the shader is nowhere near the occupancy cliff. "Flat until N=64" is also the signature of being **memory-bandwidth-bound.**
- **Shadow rays ≈ 37% of the frame** (~75ms). They mostly traverse *fully* (lit points never find an occluder to early-exit on), which is why the shadow-ray node-count early-exit and BVH near/far ordering both produced ~0 change.
- Working model: a 4-bounce frame ≈ **8 full-screen traversal passes** (4 bounce rays + 4 shadow rays) × ~25ms each; shading math is a rounding error. "Shading" looked expensive only because it *spawns* the shadow and secondary rays.

**Leading hypothesis: bandwidth-bound per-pass traversal cost.** One dragon traversal is ~25ms / 360k rays ≈ 10× slower per pass than the real-time reference. Prime suspect: triangle-test fetch layout (index indirection → ≥6 texel fetches per triangle) and 32-byte RGBA32F BVH nodes.

**Next planned step (not yet done): a traversal-cost heatmap** — count nodes + triangle-tests per ray and colorize — to split "visits too many nodes" (BVH-quality problem) from "each test moves too many bytes" (data-layout problem). These lead to different fixes.

Lower-value but real levers already identified: skip shadow rays for back-facing lights on opaque surfaces (~half of them, identical output, but doesn't help transmissive scenes); Russian roulette (modest at depth 4, better on depth-8 path-traced scenes).

## Debug toggles

All are **static** on `WebGLRendererAdapter` (survive scene reloads), read at shader-gen time. Set in console, reload scene, then set back:
- `debugTraversalOnly` — flat color on first hit; strips ALL shading (baseline: traversal only). dragon 5→39 FPS.
- `debugNoShadows` — skip the per-light shadow-ray cast.
- `debugConstMaterialParams` — constant material params instead of fetched (isolates fetch cost).
- `debugBallastRegisters` (int) — inject N live `vec4`s to probe occupancy headroom.

## Conventions / gotchas

- Matrices are consumed with `transpose=true` in `gl.uniformMatrix4fv`; `.transposed()` is only used as an inverse stand-in for pure-rotation matrices.
- BVH traversal (`WebGLWorldAdapter`) uses a local stack sized exactly to the deepest tree (`getBVHStackSize()`), with lesser-child index + split axis packed into one int for ray-direction-ordered descent. Net perf vs the older rope traversal was ~0 (the dynamic-indexed stack may cost on ANGLE what the ordering saves).
- Firefly clamp (`fireflyClamp`) is **off by default**; when enabled it clamps *indirect* contributions only, never directly-visible emission (an earlier version darkened emissive scenes by clamping everything).
- Diffuse path-tracing bounce weight is bare `diffusivity` (the cosine-weighted sampler's pdf already cancels the `1/π`; an earlier extra `/π` made indirect light ~3× too dim).

## Git

Work is committed and pushed to `origin` (`git@github.com:alitteneker/jsraytracer.git`) frequently. Commit/push only when asked; if on `master`, prefer a branch first per the usual workflow.
