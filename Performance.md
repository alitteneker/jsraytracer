# Performance

Notes on the WebGL path tracer's performance work: what the bottleneck turned out to be, how it was measured, what
changed, and what didn't help. All numbers are GPU time for one tracer pass (one sample per pixel, 600x600) on the
same desktop machine, measured with the GPU timer described below. They are only comparable with each other.

## Summary

| Scene | Before | After | Speedup |
|---|---|---|---|
| dragon (100k triangles, 4 bounces) | 6.05 ms | 2.6 ms | 2.3x |
| starwars | 5.73 ms | 2.91 ms | 2.0x |
| AMultipleBVH | 0.70 ms | 0.35 ms | 2.0x |
| refraction, cornell_box_path, SDF_Combinations | unchanged | unchanged | none (no BVH traversal) |

In every scene, the image after the changes matches the image before them within sampling noise (64x64 downsampled
RMSE, compared against a baseline-vs-baseline run of the same scene).

## What the bottleneck was

Earlier ablations (denoiser, material fetches, material math, register pressure via `debugBallastRegisters`) had
already shown that shading costs almost nothing and that the frame is dominated by BVH traversal: about 8
full-screen traversal passes per 4-bounce frame, counting bounce rays and shadow rays.

The working hypothesis was that traversal was memory-bandwidth-bound. The measurements below ruled that out:

- **The tree is fine.** Rays that enter the dragon's BVH visit a mean of 34 nodes (median 39, p99 96) and do about
  2 triangle tests on primary rays. That is below what the SAH cost estimate predicts (about 46 nodes, 6 tests),
  which is expected, since closest-hit pruning lets rays skip work the estimate assumes they do. More SAH bins (16,
  32) and binning on triangle centers barely changed the SAH estimate and did not make rendering faster.
- **Bandwidth is low.** About 640 bytes per BVH ray, 86% of it node fetches. That works out to about 5 GB/s for
  the primary pass, far below what the GPU can move.
- **Fixed per-pixel work is negligible.** With traversal removed entirely (`debugSkipTraversal`), a pass takes
  0.17 ms. So about 97% of the pass is traversal.
- **The cost is per node visit.** Making each visit cheaper (a branchless slab test, mask-and-shift texel
  addressing) gave savings that added up almost exactly. If the visits were waiting on memory, cheaper math would
  overlap with that wait and the savings would not add. So traversal was limited by instructions per visit, not by
  bytes.
- **About half the fetches were wasted.** In the original layout a node stores its own box, so finding out that a
  ray misses a child means fetching that child first. 46% of node fetches ended in a failed box test.

## What changed

All of these are static flags on `WebGLRendererAdapter`, read when the shader is generated. The adopted ones are
on by default. Set one to `false` (in the console, or as a URL parameter such as `?debugChildBoxes=false`) and
reload the scene to compare.

| Flag | Default | Effect on dragon | What it does |
|---|---|---|---|
| `debugFastAABB` | off | 6.05 -> 4.79 ms | Branchless slab test with `1/dir` computed once per ray. Superseded by `debugChildBoxes`, which has its own slab test. |
| `debugPow2DataTextures` | **on** | 4.79 -> 4.39 ms | Every data texture is 2048 texels wide, so `texelFetchByIndex` uses a mask and shift instead of integer `%` and `/`. Integer division is expensive on GPUs. |
| `debugSkipUnlitShadows` | **on** | 4.39 -> 3.79 ms | Skips a shadow ray when `phongBRDF` would return exactly zero for that light (for example, a light behind an opaque surface). The image is identical. |
| `debugChildBoxes` | **on** | see below | Each internal node stores its two children's boxes (2 texels per node), so a node the ray misses is never fetched. Children are visited nearest-first by entry distance. Non-editable shaders only. |
| `debugFastTriangle` | **on** | see below | Moller-Trumbore triangle test: one reciprocal, no normalize, versus plane intersection plus a barycentric check. |
| `debugInlineTriangleVerts` | **on** | 3.01 -> 2.67 ms | Each triangle's three positions are duplicated into their own texture, so intersection does three independent fetches instead of an index fetch followed by three dependent ones. Costs about 48 bytes per triangle of extra memory. |

Child boxes and the faster triangle test only pay off together: child boxes alone measured 4.48 ms, slower than
without them (3.79 ms), and child boxes plus Moller-Trumbore measured 3.01 ms. The ray work is nearly identical
either way, so the likely explanation is that the shader compiler handles the old triangle test badly inside the
new two-child loop. That is a reminder that on this platform, the shape of the generated code matters as much as
the algorithm.

## Tried and not adopted

| Experiment | Result on dragon | Notes |
|---|---|---|
| `debugFastNodeIndex` (power-of-two width for the BVH node texture only) | 4.43 ms vs 4.79 ms | Superseded by `debugPow2DataTextures`. |
| `debugWideBVH` (4-wide BVH, collapsed from the binary tree) | 2.74-2.80 ms vs 2.67 ms | Fewer loop iterations did not make up for 4 box tests per visit and unsorted pushes. Might be worth revisiting with sorted children or compressed child boxes. |
| `debugStackTNear` (keep each stacked node's entry distance, drop nodes a closer hit has made unreachable) | slower | A second dynamically indexed array costs more than the fetches it saves. |
| `debugStackTopCache` (top stack entry kept in a register) | no change | |
| `BVHAggregateNode.BINS_PER_AXIS` 16 or 32, `CENTROID_BINNING` | no gain | SAH estimate 10.87 -> 10.75-10.81. Defaults unchanged (8 bins, full-extent binning). |

## Measurement tools

### Debug flags

Static fields on `WebGLRendererAdapter`. Ones read at shader-generation time need a scene reload after changing.

- `debugTraversalOnly`, `debugNoShadows`, `debugConstMaterialParams`, `debugBallastRegisters`: earlier ablations.
- `debugSkipTraversal`: returns the background color before any traversal. Measures the fixed per-pixel cost.
- `debugTraversalHeatmap`: `'nodes'`, `'prims'`, `'both'` or `'misses'`. Colors pixels by traversal work. With
  `debugHeatmapStatsIntervalMs` > 0, it also reads back the raw per-pixel counts and logs distributions (mean, p50,
  p90, p99, max) for hit pixels, rays that entered a BVH, and all pixels.
- `debugGPUTimer`: read while rendering, so no reload is needed. Logs the tracer pass's GPU time once per second
  using `EXT_disjoint_timer_query_webgl2`. This excludes vsync, CPU work and the denoise pass.

### URL parameters

`gl/webgl-demo.js` applies any URL parameter that names a static on `WebGLRendererAdapter`, plus
`ClassName.FIELD` parameters for other classes (for example `BVHAggregateNode.BINS_PER_AXIS=32`). Values `true`,
`false` and numbers are converted.

- `bench=N`: after `benchWarmupMs` of drawing, collects N seconds of GPU timer samples and logs one
  `BENCH_RESULT {json}` line (also stored in `window.benchResult`). The result includes every debug flag, compile
  time, shader line count, timing percentiles, non-finite pixel count, mean color and the latest heatmap stats.
- `benchRef=save` / `benchRef=compare` with `benchRefKey=<name>`: saves a 64x64 downsample of the accumulated image
  to localStorage, or reports the RMSE against a saved one. Use this to check that an optimization does not change
  the image. Always compare against a baseline-vs-baseline run to know the noise floor for that scene.
- `unthrottled=1`: replaces `requestAnimationFrame` with a ~60 Hz stand-in, because hidden pages stop
  `requestAnimationFrame` entirely (which also stalls shader-compile polling). Only for scripted runs.

### Scripted A/B runs without reloading

`window.jsrtEditor` and `window.jsrtLastTest` are exposed, so shader-flag experiments can rebuild in place without
reloading assets:

```js
Object.assign(WebGLRendererAdapter, { debugChildBoxes: false, bench: 4, benchRef: "compare" });
window.onBenchResult = r => console.log(r.gpu.p50);
jsrtEditor.stopDrawLoop();
jsrtEditor.changeTest(jsrtLastTest);
```

### Getting stable numbers

- Use the GPU timer's p50, not FPS. On a fast machine FPS is capped by vsync.
- Keep the GPU busy, for example 4 draws per frame. At light load the GPU lowers its clocks and timings drift and
  become bimodal.
- Interleave configurations (A B A B) rather than running each once. Within one page session, repeats of the same
  configuration agreed to within about 1%.
- Hold the camera still. Moving it resets accumulation and changes the work per ray.

## The editable shader

The editable shader is the one built with `world_editable = true`. Instead of unrolling the scene into the
source, it reads aggregates, primitives and lists from data textures at run time, so the scene's structure could
change without recompiling. Nothing had built it for a long time. It can now be reached with
`?worldEditable=true` (the static `WebGLRendererAdapter.worldEditable`).

### Two bugs it had (and why the regular shader never showed them)

- **Aggregate lists pointed past their data.** `updateIndicesStart` advanced each list's offset by a BVH's node
  count, while `writeShaderData` only writes that BVH's list-leaf entries (zero for the dragon). So every plain
  aggregate's list started past the end of the data. On the dragon, the floor vanished, and the out-of-range fetch
  returned primitive 0, which drew a ghost of the dragon in the wrong space. The regular shader unrolls those lists
  into the source and never reads the offsets.
- **Every untransformed triangle reported geometry id 17.** When `WebGLGeometriesAdapter.visit` saw a geometry it
  had already registered, it returned `register_usage(...)`, which clamps triangle ids to the triangle type id. The
  regular shader looks triangles up by primitive index and didn't notice. The editable shader trusts
  `geometryIndex`, so every triangle was shaded with triangle 0's normal. Anything else that groups primitives by
  `geometryIndex` (`WrappedAggregate.getStaticShaderSource`) was exposed to the same bug for untransformed triangles
  in plain aggregates.

### Making it faster

1. **Child boxes in the editable shader too.** A BVH's boxes are in its own local space, so editing transforms never
   changes them, and nothing required the old layout. Dragon: 6.16 -> 3.69 ms.
2. **One primitive test per ray cast.** The editable shader compiled very slowly (24 s for `ASimpleScene`, against
   1.5 s for the regular shader). Ablations on the generated source (stubbing out functions, then compiling) showed:
   - Stubbing the generic `geometryIntersect` took compile time from about 5 s to 0.9 s, and removing either the list
     path or the BVH path took off about a second each. The compiler inlines the generic intersection everywhere
     it's called, and the layered code (`worldRayCastList`, plus `worldRayCastBVH` with single and list leaves)
     called it from 3 places per ray cast, times 2 ray casts (camera and shadow).
   - The shadow cast sits in a loop bounded by the uniform `uNumLights`, and that multiplied the cost: with a
     constant bound and an early `break`, the same shader compiled in 5.4 s instead of 24 s. Once the duplication
     below was gone, the loop bound no longer mattered (3.4 vs 3.6 s), and the constant bound cost the regular
     shader about 10% at runtime, so it was not kept.

   `getEditableUnifiedRayCastSource` replaces the layered code with a single loop. Each iteration either advances
   the traversal (next root aggregate, pop a BVH node and push the children the ray hits, or decode a leaf into a
   pending primitive or list) or tests one pending primitive. The primitive test appears once. Controlled by
   `WebGLRendererAdapter.editableUnifiedCast` (on by default).
3. **Untransformed triangles skip the generic dispatch** in `worldObjectIntersect` and call `triangleIntersect`
   directly.

| Scene | Compile, layered -> unified | GPU ms, layered -> unified | Regular shader |
|---|---|---|---|
| ASimpleScene | 24.2 -> 3.4 s | 0.48 -> 0.45 | 0.21 ms, 1.5 s |
| refraction | 6.4 -> 2.1 s | 0.58 -> 0.57 | 0.26 ms |
| SDF_Combinations | 24.1 -> 5.3 s | 1.33 -> 1.44 | 1.61 ms, 7.4 s |
| cornell_box_path | 21.6 -> 3.4 s | 1.89 -> 2.18 | 1.34 ms |
| AMultipleBVH | 10.6 -> 2.5 s | 0.50-0.55 -> 0.60 | 0.35 ms, 1.7 s |
| dragon | 10.1 -> 2.8 s | 4.25 -> 3.63 | 2.67 ms, 1.9 s |
| starwars | 11.5 -> 3.0 s | 4.79 -> 4.18 | 2.93 ms, 2.6 s |

The layered numbers include fixes 1 and 3. Every editable image matches the regular shader's within noise. The
unified loop compiles 3 to 7 times faster everywhere. At runtime it is faster on the big BVH scenes and up to about
15% slower on scenes that are mostly flat lists of primitives (cornell_box_path) or small BVHs (AMultipleBVH).
Interestingly, SDF_Combinations runs faster in the editable shader than in the regular one.

## Adding and removing objects

The editor can now add objects (sphere, box, cylinder, square, circle, plane) and lights (point, area), and delete
the selected object (the Delete button or key). An edit changes the CPU world in `src/`, then calls
`WebGLRendererAdapter.worldModified()`, which visits the world again, regenerates the shader source, and compares it
with the compiled source:

- **Same source:** only the data (textures and uniforms) is re-uploaded. This is the normal case for the editable
  shader.
- **Different source:** the shader is recompiled. This is always the case for the regular shader (an add on
  cornell_box_path recompiled in 2.7 s), and occasionally for the editable one (see below).

Comparing the generated source, instead of listing what the shader depends on, means a missed dependency costs a
recompile rather than a wrong image.

### Keeping the editable shader independent of the scene

Diffing the editable source before and after an edit showed what it still baked in. Each is now fixed or sized with
spare capacity (`WebGLWorldAdapter.editableCapacity`, powers of two):

- `MAX_LIGHTS` (now at least 8), the transform array (at least 64) and the special-color array (at least 16).
- The generic geometry dispatch only had cases for geometry types in the scene; it now has all of them.
- The light stand-in check compared `primID` against a list of ids; it now reads a flag bit stored with each
  primitive (bit 1 of the 4th channel, next to the casts-shadow bit).
- The BVH stack size (at least 32), the BVH layout flags, and the child-box layout (on even with no BVHs).

An edit that exceeds a capacity or adds a new kind of thing (an SDF, an image texture) still recompiles.

### Rebuild cost

| Scene | Rebuild after an edit |
|---|---|
| cornell_box_path, ASimpleScene | 1 to 5 ms |
| dragon (100k triangles) | 1.1 to 1.3 s (was 26 s) |

Re-visiting the dragon originally took 26 s, and the same code ran on every scene load:

- `WrappedBVHTree` built its primitive list with `concat` once per leaf, which is quadratic. Using `push` brought a
  rebuild to 4 s.
- Each `Triangle` now remembers where its vertex data was stored (`_webglTriangleData`, not enumerable), so meshes
  still in the scene aren't stored again. The cache is tagged with a generation number that is unique across
  adapters, because a fresh scene load once picked up stale data from the previous adapter.
- Identity transforms skip building a string key in `WebGLTransformStore`.
- Triangle textures aren't re-uploaded when the triangle list is unchanged.

The remaining second is re-wrapping 100k primitives, rebuilding the child-box BVH layout, and uploading it. Caching
whole BVH trees across rebuilds would remove most of it.

### A texture binding bug

`WebGLTexture.modifyPixel` (used when editing a material color, syncing a light's color, or re-registering a shared
transform) bound its texture on whatever texture unit was active. Normally that's a render-target unit, which the
next frame rebinds, so nothing went wrong. Right after a data upload, though, the active unit belongs to a data
texture. A light added and moved before the next frame put the float material texture on an integer sampler's unit,
and every draw after that failed with `INVALID_OPERATION`. Textures now remember their unit and select it before
binding.

## Open questions and next steps

- **Russian roulette** for path-traced scenes (bigger effect at depth 8 than at depth 4). It changes the noise, so
  check it with mean-color comparisons rather than RMSE.
- **Shadow rays in transmissive scenes** don't benefit from `debugSkipUnlitShadows`.
- **The editable shader is still 1.2 to 1.7 times slower than the regular one.** The remaining cost is in reading
  every primitive's data from textures and in the generic geometry and material dispatch. Shading untransformed
  triangles directly (as `worldObjectColor` does in the regular shader) is the next obvious step. Flat lists of
  primitives might be better served by wrapping them in a BVH.
- **More structural edits.** Adding meshes (OBJ files), grouping objects into aggregates, and moving objects between
  them would all fit the same `worldModified` path. Deleting one primitive from inside a BVH would need the BVH
  rebuilt; for now the whole BVH is deleted.
- **Faster rebuilds for big scenes**, by caching wrapped BVH trees and their child-box layouts across rebuilds.
- **Promoting the adopted flags.** They still carry `debug` names and the old code paths remain. Once these
  settings have held up for a while, the old paths could be removed and the flags renamed or deleted.
- **A wider BVH revisited.** With children sorted by distance, or compressed child boxes (8-wide trees with
  quantized boxes are the standard GPU layout), it might still beat the binary layout.
