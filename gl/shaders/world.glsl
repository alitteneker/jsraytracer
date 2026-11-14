// The world: casting rays against the scene's primitives, aggregates and BVHs, and shading the closest hit.
// Rendered by WebGLWorldAdapter. Most of a scene's structure is data in textures; what the shader needs to know
// about it at compile time comes in as the WORLD_* macros at the top of source, and as these holes:
//   source: the WORLD_* values, worldDebugDefines (the DEBUG_* macros that depend on the scene's BVH layout),
//     transformCount (the transform array's length), untransformedTriangleIntersect,
//     bvhTraversal (bvh.stack or bvh.child-boxes), lightEmitterTest (emitter.*, or nothing), and the heatmap's
//     settings (debugTraversalHeatmap).
//   bvh.*, editable.unified: stackSize, and width, the child boxes per node.
// The editable shader (editable.*) reads everything from the textures; the scene-specific shader's ray cast and
// shading functions are generated per scene (see WebGLWorldAdapter.getShaderSource).

//#section declarations

float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag);
float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int primID, inout mat4 ancestorInvTransform);
vec3 worldObjectSurface(in int primID, in vec4 rp, in Ray r, in mat4 ancestorInvTransform, inout vec3 normal);
vec3 worldRayColorShallow(in Ray in_ray, inout vec4 intersect_position, inout vec3 normal, in bool countEmission);

//#section source



// ========== WORLD ==========
#define WORLD_EDITABLE ${worldEditable}
#define WORLD_HAS_BVH_NODES ${worldHasBVHNodes}
#define WORLD_BVH_LEAVES_SINGULAR ${worldBVHLeavesSingular}
#define WORLD_BVH_ONLY_UNTRANSFORMED_TRIANGLES ${worldBVHOnlyUntransformedTriangles}
${worldDebugDefines}

uniform vec3 uBackgroundColor;

// TODO: should safety check the size of this, for larger sizes need a texture
uniform mat4 uTransforms[${transformCount}];
mat4 getTransform(in int index) {
    if (index < 0)
        return mat4(1.0);
    return uTransforms[index];
}

uniform int uWorldListsStart;
uniform int uWorldNumAggregates;
uniform int uWorldNumPrimitives;
uniform int uWorldNumUntransformedTriangles;
uniform isampler2D uWorldData;
uniform isampler2D uWorldAABBs;


// ---- Intersection/Color with a single primitive ----
struct Primitive {
    int geometry_id;
    int material_id;
    int transform_id;
    bool castsShadow;
    bool isLightEmitter;    // a light's stand-in (see makeLightEmitterProxy)
};
Primitive getPrimitive(in int prim_id) {
    ivec4 p = itexelFetchByIndex(prim_id + uWorldNumAggregates, uWorldData);
    return Primitive(p.r, p.g, p.b, (p.a & 1) != 0, (p.a & 2) != 0);
}
bool worldRayCastCompareTime(in float t, in float minT, in float maxT, inout float min_found_t) {
    if (t >= minT && t < maxT && (min_found_t < minT || t < min_found_t)) {
        min_found_t = t;
        return true;
    }
    return false;
}
#if DEBUG_TRAVERSAL_HEATMAP
// ---- Traversal-cost heatmap counters ----
// Non-const globals are legal in GLSL ES 3.00 and are per-fragment-invocation (implicitly reset each
// invocation, and explicitly reset at the top of worldRayColorShallow). They accumulate during a single
// primary-ray cast, since worldRayColorShallow returns before spawning any shadow/secondary rays.
int gHeatmapNodeCount = 0;   // BVH nodes fetched/visited (internal + leaf)
int gHeatmapPrimCount = 0;   // primitive intersection tests performed
int gHeatmapMissCount = 0;   // BVH nodes fetched whose box test then failed (wasted fetches)
vec3 heatmapRamp(in float t) {
    t = clamp(t, 0.0, 1.0);
    const vec3 c0 = vec3(0.0, 0.0, 1.0); // blue   (low)
    const vec3 c1 = vec3(0.0, 1.0, 1.0); // cyan
    const vec3 c2 = vec3(0.0, 1.0, 0.0); // green
    const vec3 c3 = vec3(1.0, 1.0, 0.0); // yellow
    const vec3 c4 = vec3(1.0, 0.0, 0.0); // red    (high)
    float s = t * 4.0;
    if (s < 1.0) return mix(c0, c1, s);
    if (s < 2.0) return mix(c1, c2, s - 1.0);
    if (s < 3.0) return mix(c2, c3, s - 2.0);
    return mix(c3, c4, s - 3.0);
}
#endif


#if (WORLD_EDITABLE || (WORLD_HAS_BVH_NODES && !WORLD_BVH_ONLY_UNTRANSFORMED_TRIANGLES))
// ---- Generic Intersection with a particular object ----
float worldObjectIntersect(in int prim_id, in Ray r, in float minDistance, in bool shadowFlag) {
    int geometry_id = 0;
    // Untransformed triangles (the bulk of any mesh) are tested directly, skipping the generic geometry
    // dispatch. Their primitive index is their triangle index.
    // (Without any, the triangle code may not be compiled in, and this branch is never taken.)
    if (prim_id < uWorldNumUntransformedTriangles)
        return ${untransformedTriangleIntersect};
    else {
        Primitive obj = getPrimitive(prim_id);
        if (shadowFlag && !obj.castsShadow)
            return minDistance - 1.0;
        mat4 objectInverseTransform = getTransform(obj.transform_id);
        r = Ray(objectInverseTransform * r.o, objectInverseTransform * r.d);
        geometry_id = obj.geometry_id;
    }
    return geometryIntersect(geometry_id, r, minDistance);
}
// ---- Generic RayCast with a particular object ----
bool worldRayCastObject(in int prim_id, in Ray r, in float minT, in float maxT, in bool shadowFlag,
    inout float min_found_t, inout int min_prim_id)
{
    float t = worldObjectIntersect(prim_id, r, minT, shadowFlag);
    if (worldRayCastCompareTime(t, minT, maxT, min_found_t)) {
        min_prim_id = prim_id;
        return true;
    }
    return false;
}
#if (WORLD_EDITABLE || (!WORLD_BVH_ONLY_UNTRANSFORMED_TRIANGLES && !WORLD_BVH_LEAVES_SINGULAR))
// ---- Generic RayCast with a list of objects ----
bool worldRayCastList(in int listStartIndex, in int listLength, in Ray r, in float minT, in float maxT, in bool shadowFlag,
    inout float min_found_t, inout int min_prim_id)
{
    bool found_min = false;
    ivec4 indexTexel;
    int indexTexelEnd = -1;
    for (int i = 0; i < listLength; ++i) {
        int index = listStartIndex + i;
        if (index > indexTexelEnd) {
            indexTexel = itexelFetchByIndex(uWorldListsStart + index / 4, uWorldData);
            indexTexelEnd = 4 * (index / 4) + 3;
        }
        if (worldRayCastObject(indexTexel[index % 4], r, minT, maxT, shadowFlag, min_found_t, min_prim_id)) {
            found_min = true;
            if (shadowFlag) break;
        }
    }
    return found_min;
}
#endif
#endif


// ========== World BVH ==========
#if (WORLD_EDITABLE || WORLD_HAS_BVH_NODES)
#if (!WORLD_EDITABLE && WORLD_BVH_ONLY_UNTRANSFORMED_TRIANGLES)
bool worldRayCastBVHObject(in int prim_id, in Ray r, in float minT, in float maxT, in bool shadowFlag,
    inout float min_found_t, inout int min_prim_id)
{
#if DEBUG_TRAVERSAL_HEATMAP
    gHeatmapPrimCount++;
#endif
    float t = triangleIntersect(r, minT, prim_id);
    if (worldRayCastCompareTime(t, minT, maxT, min_found_t)) {
        min_prim_id = prim_id;
        return true;
    }
    return false;
}
#if (!WORLD_BVH_LEAVES_SINGULAR)
bool worldRayCastBVHList(in int listStartIndex, in int listLength, in Ray r, in float minT, in float maxT, in bool shadowFlag,
    inout float min_found_t, inout int min_prim_id)
{
    bool found_min = false;
    ivec4 indexTexel;
    int indexTexelEnd = -1;
    for (int i = 0; i < listLength; ++i) {
        int index = listStartIndex + i;
        if (index > indexTexelEnd) {
            indexTexel = itexelFetchByIndex(uWorldListsStart + index / 4, uWorldData);
            indexTexelEnd = 4 * (index / 4) + 3;
        }
        if (worldRayCastBVHObject(indexTexel[index % 4], r, minT, maxT, shadowFlag, min_found_t, min_prim_id)) {
            found_min = true;
            if (shadowFlag) break;
        }
    }
    return found_min;
}
#endif
#else
bool worldRayCastBVHObject(in int prim_id, in Ray r, in float minT, in float maxT, in bool shadowFlag,
    inout float min_found_t, inout int min_prim_id)
{
#if DEBUG_TRAVERSAL_HEATMAP
    gHeatmapPrimCount++;
#endif
    return worldRayCastObject(prim_id, r, minT, maxT, shadowFlag, min_found_t, min_prim_id);
}
bool worldRayCastBVHList(in int listStartIndex, in int listLength, in Ray r, in float minT, in float maxT, in bool shadowFlag,
    inout float min_found_t, inout int min_prim_id)
{
    return worldRayCastList(listStartIndex, listLength, r, minT, maxT, shadowFlag, min_found_t, min_prim_id);
}
#endif

// Emulates recursive BVH traversal without actual recursion, using a small fixed-size local stack.
// Each internal node stores its "greater" child implicitly (always node_index+1, since it's visited
// immediately after this node when the tree was flattened) and its "lesser" child explicitly (packed
// together with the split axis, since lesser_node's position varies). At traversal time, the ray's
// direction sign along that axis determines which child is actually nearer for THIS ray, so unlike a
// fixed rope/miss-index chain, the nearer child is always descended into first, letting min_found_t
// prune the farther child before it's ever visited.
// Sized exactly to the deepest BVH actually present in this scene (see WebGLWorldAdapter.getBVHStackSize),
// rather than a conservative guess, since the tree shape can't change without a full shader rebuild anyway.
#if DEBUG_FAST_NODE_INDEX
// debugFastNodeIndex: the node texture is laid out ${nodeTextureWidth} texels wide (a power of
// two, fixed at shader-gen time; see WebGLWorldAdapter.writeShaderData), so index -> texel is mask + shift.
ivec4 fetchBVHNodeTexel(in int index) {
    return texelFetch(uWorldAABBs, ivec2(index & ${nodeTextureMask}, index >> ${nodeTextureShift}), 0);
}
#else
ivec4 fetchBVHNodeTexel(in int index) {
    return itexelFetchByIndex(index, uWorldAABBs);
}
#endif

${bvhTraversal}
#endif

// ---- Generic World Color ----
// Finds what in_ray hits and sets up its surface for the integrator (see materialSurface in materials.glsl).
// Returns the light that reaches in_ray's origin straight from the hit (its emission) or from the background.
// countEmission: whether a light hit directly by this ray contributes its emission. True for camera rays and
// exact (mirror/refraction) bounces, false for randomly sampled bounces, whose light was already counted by
// direct light sampling at the surface they left (see src/lights.js).
vec3 worldRayColorShallow(in Ray in_ray, inout vec4 intersect_position, inout vec3 normal, in bool countEmission) {
    int primID = -1;
    mat4 ancestorInvTransform = mat4(1.0);
#if DEBUG_TRAVERSAL_HEATMAP
    gHeatmapNodeCount = 0; gHeatmapPrimCount = 0; gHeatmapMissCount = 0;
#endif
#if DEBUG_SKIP_TRAVERSAL
    // Diagnostic floor: return before any world traversal. intersect_position stays zero, so the
    // bounce loop exits after this, and nothing below is reached. What remains is the per-pixel work
    // that doesn't depend on the scene: camera ray + jitter, accumulation texture reads/writes.
    return uBackgroundColor;
#endif

    float intersect_time = worldRayCast(in_ray, EPSILON, 1E20, false, primID, ancestorInvTransform);
#if DEBUG_TRAVERSAL_HEATMAP
    // Diagnostic: colorize the primary ray's traversal work instead of shading. Returning here leaves
    // nextRays zero (no shadow/secondary rays), so the counts reflect exactly one primary-ray cast. Miss
    // and hit are both colorized, since background rays still pay to traverse. worldObjectSurface goes
    // unreferenced, so the whole material/light subtree is dead-code-eliminated as with debugTraversalOnly.
    {
        // Raw counts for CPU readback (see WebGLRendererAdapter.reportHeatmapStats): the normal output is
        // otherwise unused in heatmap mode, so it carries (nodes, prims, hit) unscaled and unclamped.
        // In 'misses' mode the second channel carries failed-box-test node fetches instead of prim tests.
        normal = vec3(float(gHeatmapNodeCount), float(${heatmapSecondChannel}), (primID != -1) ? 1.0 : 0.0);
        float nodeC = float(gHeatmapNodeCount) / float(${heatNodeScale});
        float primC = float(gHeatmapPrimCount) / float(${heatPrimScale});
#if DEBUG_HEATMAP_MODE == 1
        return heatmapRamp(nodeC);
#elif DEBUG_HEATMAP_MODE == 2
        return heatmapRamp(primC);
#else
        return vec3(clamp(primC, 0.0, 1.0), clamp(nodeC, 0.0, 1.0), 0.0);
#endif
    }
#endif
    if (primID == -1)
        return uBackgroundColor;

    intersect_position = in_ray.o + intersect_time * in_ray.d;
    ${lightEmitterTest}
#if DEBUG_TRAVERSAL_ONLY
    // Diagnostic: return a flat color instead of shading. Because worldObjectSurface is then never
    // referenced anywhere, the compiler dead-code-eliminates the entire material/light/scatter
    // subtree, so this measures traversal cost with shading's register footprint actually removed
    // (a runtime branch would leave that code compiled in and occupancy unchanged). nextRays stays
    // zero, so no secondary rays are spawned and only primary-ray traversal is exercised.
    return vec3(0.7);
#else
    return worldObjectSurface(primID, intersect_position, in_ray, ancestorInvTransform, normal);
#endif
}


// This is an overload for worldRayCast that skips over some of the inout parameters
// that are not relevant for some purposes like casting shadow rays.
float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag) {
    int primID = -1;
    mat4 ancestorInvTransform = mat4(1.0);
    return worldRayCast(r, minT, maxT, shadowFlag, primID, ancestorInvTransform);
}

//#section emitter.editable

    // A light's stand-in primitive was hit by a sampled bounce: its light is already counted, and lights
    // don't reflect, so this path ends here with nothing added. (Read from the primitive's data, so the
    // editable shader doesn't change when lights are added or removed.)
    if (!countEmission && getPrimitive(primID).isLightEmitter)
        return vec3(0.0);
//#section emitter.list

    // A light's stand-in primitive was hit by a sampled bounce: its light is already counted, and lights
    // don't reflect, so this path ends here with nothing added.
    if (!countEmission && (${condition}))
        return vec3(0.0);
//#section bvh.stack

#define BVH_STACK_SIZE ${stackSize}
bool worldRayCastBVH(in int root_index, in int indices_offset, in Ray r, in float minT, in float maxT, in bool shadowFlag, inout float min_found_t, inout int min_prim_id) {
    bool found_min = false;

#if DEBUG_FAST_AABB
    vec3 invD  = 1.0 / r.d.xyz;
    vec3 oInvD = r.o.xyz * invD;
#endif

    int stack[BVH_STACK_SIZE];
    int stackPtr = 0;
    int node_index = 0;

    while (true) {
        // BVH node data is packed 16 bytes per node into a single RGBA32I texel (halving the fetch
        // traffic of the older two-RGBA32F-texel layout; traversal is bandwidth-bound):
        //    [ min.x|min.y,  min.z|max.x,  max.y|max.z   as fp16 pairs bit-cast through int,
        //      leaf encoding or (lesser child index << 2 | split axis) as a full int ]
        // The AABB was quantized conservatively at upload (min rounded down, max up, see
        // packBVHNodeTexel), so boxes only ever grow (<= 1 fp16 ulp per side) and no hit can be lost.

        // Node i lives at texel i. All node indices are specified relative to the index of the
        // root node, so an offset of the root index must be included.
#if DEBUG_TRAVERSAL_HEATMAP
        gHeatmapNodeCount++;
#endif
        ivec4 nodeTexel = fetchBVHNodeTexel(root_index + node_index);

        // int->uint on ANGLE/GLSL ES 3.0 is a bit-preserving cast, so unpackHalf2x16 sees the
        // exact half bits packed on the JS side.
        vec2 min_xy    = unpackHalf2x16(uint(nodeTexel.r));
        vec2 minz_maxx = unpackHalf2x16(uint(nodeTexel.g));
        vec2 max_yz    = unpackHalf2x16(uint(nodeTexel.b));
        vec3 aabb_min  = vec3(min_xy, minz_maxx.x);
        vec3 aabb_max  = vec3(minz_maxx.y, max_yz);

        int nodeData = nodeTexel.a;

        // Identify where the ray could intersect this node's AABB, and test whether the possible
        // range of intersections would be useful given the range desired. This is called a 'hit'.
        // (Center/half-size reconstruction feeds the shared AABBIntersects; fp16 values are exact
        // in fp32, so this round-trip introduces no error beyond the old float path's own rounding.)
#if DEBUG_FAST_AABB
        // Branchless slab test (debugFastAABB). invD/oInvD are hoisted out of the loop, so each node costs
        // two multiply-subtracts per axis plus min/max reductions. Clamping the entry/exit to [minT, maxT]
        // folds the original range checks into the single tnear <= tfar comparison. Axis-parallel rays rely
        // on IEEE inf from 1/0; an origin exactly on a slab plane of such a ray gives 0*inf = NaN, an edge
        // case the original's EPSILON branch handled and this version doesn't.
        vec3 slab_t0 = aabb_min * invD - oInvD;
        vec3 slab_t1 = aabb_max * invD - oInvD;
        vec3 slab_near = min(slab_t0, slab_t1), slab_far = max(slab_t0, slab_t1);
        float tnear = max(max(slab_near.x, slab_near.y), max(slab_near.z, minT));
        float tfar  = min(min(slab_far.x,  slab_far.y),  min(slab_far.z,  maxT));
        bool hit_node = tnear <= tfar && (tnear <= min_found_t || min_found_t < minT);
#else
        vec2 aabb_ts = AABBIntersects(r, vec4(0.5*(aabb_min + aabb_max), 1.0), vec4(0.5*(aabb_max - aabb_min), 0.0), minT, maxT);
        bool hit_node = aabb_ts.x <= maxT && aabb_ts.y >= minT && (aabb_ts.x <= min_found_t || min_found_t < minT);
#endif

        bool descending = false;
#if DEBUG_TRAVERSAL_HEATMAP
        if (!hit_node) gHeatmapMissCount++;
#endif

        if (hit_node) {

            // If the hit node is a leaf node (encoded by an index less than or equal to zero), check all objects in this node.
            if (nodeData <= 0) {
                int id = -nodeData - 1;
                // There are two possibilities: either the id corresponds to a single primitive
                // id (encoded as a number less than the number of primitives), or to a list
                // (encoded as a number greater than the number of primitives).

                // If the world is not editable, and every BVH is a leaf with a single primitive,
                // only the single primitive case need be compiled.
#if (!WORLD_EDITABLE && WORLD_BVH_LEAVES_SINGULAR)
                if (worldRayCastBVHObject(id, r, minT, maxT, shadowFlag, min_found_t, min_prim_id))
                    found_min = true;

#else
                // Single primitive ids are easy (and should dominate most good BVH constructions),
                // so we just do them directly.
                if (id < uWorldNumPrimitives) {
                    if (worldRayCastBVHObject(id, r, minT, maxT, shadowFlag, min_found_t, min_prim_id))
                        found_min = true;
                }

                // lists are a bit harder: we don't know how long the list is, so we have to first
                // lookup the length before we can test. Fortunately, these should be a small fraction
                // of BVH nodes, so the cost should be much lower on average.
                else {
                    int listStart = indices_offset + (id - uWorldNumPrimitives);
                    int listLength = itexelFetchByIndex(uWorldListsStart + listStart / 4, uWorldData)[listStart % 4];
                    if (worldRayCastBVHList(listStart + 1, listLength, r, minT, maxT, shadowFlag, min_found_t, min_prim_id))
                        found_min = true;
                }
#endif
            }

            // Otherwise, this is an internal node: figure out which child the ray reaches first along
            // the split axis, descend into it directly, and push the other child to visit afterward.
            else {
                int axis = nodeData & 3;
                int farChildIndex = nodeData >> 2;
                int nearChildIndex = node_index + 1;

                int nextIndex, pushIndex;
                if (r.d[axis] < 0.0) {
                    // ray points toward decreasing axis value: the implicit (greater) child is nearer
                    nextIndex = nearChildIndex;
                    pushIndex = farChildIndex;
                }
                else {
                    // ray points toward increasing (or zero) axis value: the explicit (lesser) child is nearer
                    nextIndex = farChildIndex;
                    pushIndex = nearChildIndex;
                }

                if (stackPtr < BVH_STACK_SIZE)
                    stack[stackPtr++] = pushIndex;
                node_index = nextIndex;
                descending = true;
            }
        }

        // If we missed this node, or just finished checking a leaf's objects, backtrack to the next
        // node waiting on the stack. An empty stack means every reachable node has been visited.
        // For a shadow ray, any recorded hit is enough to occlude the light, so stop as soon as one
        // is found rather than continuing to search for the closest one.
        if (!descending) {
            if ((shadowFlag && found_min) || stackPtr <= 0)
                break;
            node_index = stack[--stackPtr];
        }
    }

    return found_min;
}

//#section bvh.child-boxes


#define BVH_STACK_SIZE ${stackSize}
// debugChildBoxes traversal. Each visit fetches both child boxes of one internal node and tests them
// with a branchless slab test; hit leaf children are intersected immediately (so a hit there can prune
// the sibling's box test), hit internal children are visited nearest-first. A node is therefore only
// ever fetched when its box is already known to be hit, unlike the original layout, where every
// fetched node first has to test its own box.
bool worldRayCastBVH(in int root_index, in int indices_offset, in Ray r, in float minT, in float maxT, in bool shadowFlag, inout float min_found_t, inout int min_prim_id) {
    bool found_min = false;
    // Replace exactly-zero direction components with a tiny value, so 1/d is huge but finite: this keeps
    // the slab test free of 0 * inf = NaN when the origin lies exactly on a slab plane.
    vec3 safeD = r.d.xyz;
    safeD.x = (safeD.x == 0.0) ? 1e-30 : safeD.x;
    safeD.y = (safeD.y == 0.0) ? 1e-30 : safeD.y;
    safeD.z = (safeD.z == 0.0) ? 1e-30 : safeD.z;
    vec3 invD  = 1.0 / safeD;
    vec3 oInvD = r.o.xyz * invD;

    int stack[BVH_STACK_SIZE];
#if DEBUG_STACK_TNEAR
    float stackT[BVH_STACK_SIZE];
#endif
    int stackPtr = 0;
#if DEBUG_STACK_TOP_CACHE
    // debugStackTopCache: the most recently pushed node lives in a register (stackTop); only older
    // entries go through the dynamically indexed array. Most pops take the entry just pushed.
    int stackTop = -1;
#endif
    int node_index = 0;

    while (true) {
#if DEBUG_TRAVERSAL_HEATMAP
        gHeatmapNodeCount++;
#endif
        int nearChild = -1, farChild = -1;
        float nearT = 0.0, farT = 0.0;
        for (int c = 0; c < ${width}; ++c) {
            ivec4 childTexel = fetchBVHNodeTexel(root_index + ${width} * node_index + c);
            int childData = childTexel.a;
            if (childData == 0)
                continue;

            vec2 min_xy    = unpackHalf2x16(uint(childTexel.r));
            vec2 minz_maxx = unpackHalf2x16(uint(childTexel.g));
            vec2 max_yz    = unpackHalf2x16(uint(childTexel.b));
            vec3 slab_t0 = vec3(min_xy, minz_maxx.x) * invD - oInvD;
            vec3 slab_t1 = vec3(minz_maxx.y, max_yz) * invD - oInvD;
            vec3 slab_near = min(slab_t0, slab_t1), slab_far = max(slab_t0, slab_t1);
            float tnear = max(max(slab_near.x, slab_near.y), max(slab_near.z, minT));
            float tfar  = min(min(slab_far.x,  slab_far.y),  min(slab_far.z,  maxT));
            if (!(tnear <= tfar && (tnear <= min_found_t || min_found_t < minT))) {
#if DEBUG_TRAVERSAL_HEATMAP
                gHeatmapMissCount++;
#endif
                continue;
            }

            if (childData < 0) {
                int id = -childData - 1;
#if (!WORLD_EDITABLE && WORLD_BVH_LEAVES_SINGULAR)
                if (worldRayCastBVHObject(id, r, minT, maxT, shadowFlag, min_found_t, min_prim_id))
                    found_min = true;
#else
                if (id < uWorldNumPrimitives) {
                    if (worldRayCastBVHObject(id, r, minT, maxT, shadowFlag, min_found_t, min_prim_id))
                        found_min = true;
                }
                else {
                    int listStart = indices_offset + (id - uWorldNumPrimitives);
                    int listLength = itexelFetchByIndex(uWorldListsStart + listStart / 4, uWorldData)[listStart % 4];
                    if (worldRayCastBVHList(listStart + 1, listLength, r, minT, maxT, shadowFlag, min_found_t, min_prim_id))
                        found_min = true;
                }
#endif
                if (shadowFlag && found_min)
                    break;
            }
            else if (nearChild < 0) {
                nearChild = childData - 1;
                nearT = tnear;
            }
#if !DEBUG_WIDE_BVH
            else if (tnear < nearT) {
                farChild = nearChild;
                farT = nearT;
                nearChild = childData - 1;
                nearT = tnear;
            }
            else {
                farChild = childData - 1;
                farT = tnear;
            }
#else
            // Wide node: the nearest hit internal child is visited next; every other hit internal
            // child goes straight onto the stack (unsorted among themselves).
            else if (tnear < nearT) {
                if (stackPtr < BVH_STACK_SIZE)
                    stack[stackPtr++] = nearChild;
                nearChild = childData - 1;
                nearT = tnear;
            }
            else if (stackPtr < BVH_STACK_SIZE)
                stack[stackPtr++] = childData - 1;
#endif
        }
        if (shadowFlag && found_min)
            break;

#if DEBUG_STACK_TOP_CACHE
        if (farChild >= 0) {
            if (stackTop >= 0 && stackPtr < BVH_STACK_SIZE)
                stack[stackPtr++] = stackTop;
            stackTop = farChild;
        }
#else
        if (farChild >= 0 && stackPtr < BVH_STACK_SIZE) {
#if DEBUG_STACK_TNEAR
            stackT[stackPtr] = farT;
#endif
            stack[stackPtr++] = farChild;
        }
#endif
        if (nearChild >= 0)
            node_index = nearChild;
        else {
#if DEBUG_STACK_TNEAR
            // debugStackTNear: drop stacked nodes whose box entry is now beyond the closest hit found
            // since they were pushed, without fetching them.
            while (stackPtr > 0 && min_found_t >= minT && stackT[stackPtr - 1] > min_found_t)
                --stackPtr;
#endif
#if DEBUG_STACK_TOP_CACHE
            if (stackTop >= 0) {
                node_index = stackTop;
                stackTop = -1;
            }
            else if (stackPtr > 0)
                node_index = stack[--stackPtr];
            else
                break;
#else
            if (stackPtr <= 0)
                break;
            node_index = stack[--stackPtr];
#endif
        }
    }
    return found_min;
}

//#section editable

#define WORLD_NODE_AGGREGATE_TYPE    ${aggregateType}
#define WORLD_NODE_BVH_TYPE          ${bvhType}

vec3 worldObjectSurface(in int primID, in vec4 rp, in Ray r, in mat4 ancestorInvTransform, inout vec3 normal) {
    Primitive ids = getPrimitive(primID);
    mat4 inverseTransform = getTransform(ids.transform_id) * ancestorInvTransform;
    GeometricMaterialData geomatdata = getGeometricMaterialData(ids.geometry_id, inverseTransform * rp, inverseTransform * r.d);
    geomatdata.normal = vec4(normalize((transpose(inverseTransform) * geomatdata.normal).xyz), 0);
    normal = geomatdata.normal.xyz;
    return materialSurface(ids.material_id, rp, r, geomatdata);
}

//#section editable.unified


#define UNIFIED_STACK_SIZE ${stackSize}
float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int primID, inout mat4 ancestorInvTransform) {
    float min_found_t = minT - 1.0;

    int root_index = 0;             // next root aggregate to start
    mat4 root_invTransform = mat4(1.0);
    Ray local_r = r;
    vec3 invD = vec3(0.0), oInvD = vec3(0.0);

    int bvhStart = -1;              // texel offset of the current BVH's nodes, or -1 outside a BVH
    int indicesOffset = 0;          // the current BVH's list-leaf entries
    int stack[UNIFIED_STACK_SIZE];  // > 0: internal node index + 1, < 0: leaf encoding
    int stackPtr = 0;

    int single = -1;                // a pending primitive to test
    int listPos = 0, listEnd = 0;   // or a pending range of a primitive list

    while (true) {
        // 1. With no primitive pending, advance the traversal until one is (or everything is done).
        if (single < 0 && listPos >= listEnd) {
            if (stackPtr > 0) {
                int entry = stack[--stackPtr];
                if (entry > 0) {
                    // An internal node: push the children whose boxes the ray hits, nearest on top.
#if DEBUG_TRAVERSAL_HEATMAP
                    gHeatmapNodeCount++;
#endif
                    int node_index = entry - 1;
                    int nearEntry = 0;
                    float nearT = 0.0;
                    for (int c = 0; c < ${width}; ++c) {
                        ivec4 childTexel = fetchBVHNodeTexel(bvhStart + ${width} * node_index + c);
                        int childData = childTexel.a;
                        if (childData == 0)
                            continue;
                        vec2 min_xy    = unpackHalf2x16(uint(childTexel.r));
                        vec2 minz_maxx = unpackHalf2x16(uint(childTexel.g));
                        vec2 max_yz    = unpackHalf2x16(uint(childTexel.b));
                        vec3 slab_t0 = vec3(min_xy, minz_maxx.x) * invD - oInvD;
                        vec3 slab_t1 = vec3(minz_maxx.y, max_yz) * invD - oInvD;
                        vec3 slab_near = min(slab_t0, slab_t1), slab_far = max(slab_t0, slab_t1);
                        float tnear = max(max(slab_near.x, slab_near.y), max(slab_near.z, minT));
                        float tfar  = min(min(slab_far.x,  slab_far.y),  min(slab_far.z,  maxT));
                        if (!(tnear <= tfar && (tnear <= min_found_t || min_found_t < minT))) {
#if DEBUG_TRAVERSAL_HEATMAP
                            gHeatmapMissCount++;
#endif
                            continue;
                        }
                        if (nearEntry == 0) {
                            nearEntry = childData;
                            nearT = tnear;
                        }
                        else if (tnear < nearT) {
                            if (stackPtr < UNIFIED_STACK_SIZE)
                                stack[stackPtr++] = nearEntry;
                            nearEntry = childData;
                            nearT = tnear;
                        }
                        else if (stackPtr < UNIFIED_STACK_SIZE)
                            stack[stackPtr++] = childData;
                    }
                    // The nearest child is handled right away: an internal one goes back on the stack
                    // to be visited next, a leaf falls through to be decoded and tested below.
                    if (nearEntry > 0 && stackPtr < UNIFIED_STACK_SIZE) {
                        stack[stackPtr++] = nearEntry;
                        continue;
                    }
                    if (nearEntry == 0)
                        continue;
                    entry = nearEntry;
                }
                // A leaf: one primitive, or a list of them.
                int id = -entry - 1;
                if (id < uWorldNumPrimitives)
                    single = id;
                else {
                    int listStart = indicesOffset + (id - uWorldNumPrimitives);
                    listPos = listStart + 1;
                    listEnd = listPos + itexelFetchByIndex(uWorldListsStart + listStart / 4, uWorldData)[listStart % 4];
                }
            }
            else {
                // Start the next root aggregate: a plain aggregate queues its list of primitives, a
                // BVH pushes its root node.
                if (root_index >= uWorldNumAggregates)
                    break;
                ivec4 nodeData = itexelFetchByIndex(root_index, uWorldData);
                ++root_index;
                root_invTransform = getTransform(nodeData.g);
                local_r = Ray(root_invTransform * r.o, root_invTransform * r.d);
                if (nodeData.r == WORLD_NODE_AGGREGATE_TYPE) {
                    listPos = nodeData.b;
                    listEnd = nodeData.b + nodeData.a;
                }
                else {
                    bvhStart = nodeData.b;
                    indicesOffset = nodeData.a;
                    // Exactly-zero direction components become tiny, keeping the slab test free of 0 * inf.
                    vec3 safeD = local_r.d.xyz;
                    safeD.x = (safeD.x == 0.0) ? 1e-30 : safeD.x;
                    safeD.y = (safeD.y == 0.0) ? 1e-30 : safeD.y;
                    safeD.z = (safeD.z == 0.0) ? 1e-30 : safeD.z;
                    invD  = 1.0 / safeD;
                    oInvD = local_r.o.xyz * invD;
                    stack[0] = 1;
                    stackPtr = 1;
                    continue;
                }
            }
        }

        // 2. Test the next pending primitive. This is the only primitive test in the loop.
        int prim = single;
        if (prim >= 0)
            single = -1;
        else if (listPos < listEnd) {
            prim = itexelFetchByIndex(uWorldListsStart + listPos / 4, uWorldData)[listPos % 4];
            ++listPos;
        }
        else
            continue;
#if DEBUG_TRAVERSAL_HEATMAP
        if (bvhStart >= 0) gHeatmapPrimCount++;
#endif
        if (worldRayCastObject(prim, local_r, minT, maxT, shadowFlag, min_found_t, primID)) {
            ancestorInvTransform = root_invTransform;
            if (shadowFlag)
                break;
        }
    }

    return min_found_t;
}

//#section editable.layered
float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int primID, inout mat4 ancestorInvTransform) {
    float min_found_t = minT - 1.0;

    for (int root_index = 0; root_index < uWorldNumAggregates; ++root_index) {
        ivec4 nodeData = itexelFetchByIndex(root_index, uWorldData);

        mat4 root_invTransform = getTransform(nodeData.g);
        Ray local_r = Ray(root_invTransform * r.o, root_invTransform * r.d);

        if (nodeData.r == WORLD_NODE_AGGREGATE_TYPE) {
            if (worldRayCastList(nodeData.b, nodeData.a, local_r, minT, maxT, shadowFlag, min_found_t, primID))
                ancestorInvTransform = root_invTransform;
        }
        else if (nodeData.r == WORLD_NODE_BVH_TYPE) {
            if (worldRayCastBVH(nodeData.b, nodeData.a, local_r, minT, maxT, shadowFlag, min_found_t, primID))
                ancestorInvTransform = root_invTransform;
        }

        // A shadow ray only needs one occluder; stop scanning the remaining root nodes once found.
        if (shadowFlag && primID != -1)
            break;
    }

    return min_found_t;
}
