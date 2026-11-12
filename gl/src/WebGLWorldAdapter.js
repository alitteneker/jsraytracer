class WebGLWorldAdapter {
    static WORLD_NODE_AGGREGATE_TYPE = 3;
    static WORLD_NODE_BVH_NODE_TYPE  = 4;

    // ---- fp16 packing for compressed BVH nodes ----
    // Each BVH node is stored in a single RGBA32I texel: three ints hold the six AABB bounds as packed
    // fp16 pairs (bit-compatible with GLSL unpackHalf2x16 after an int->uint bit cast), and the fourth
    // holds the leaf/child encoding at full integer precision (fp16 can't hold node indices, and the old
    // float-encoded int capped out at 2^24 anyway). Quantization rounds DIRECTIONALLY: min components
    // round down, max components round up, so a quantized box always contains the true box (grows by at
    // most 1 fp16 ulp per side, ~0.05%) and traversal correctness is unaffected.
    static _f16_f32buf = new Float32Array(1);
    static _f16_u32buf = new Uint32Array(WebGLWorldAdapter._f16_f32buf.buffer);
    static _halfToFloat(h) {
        const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1F, m = h & 0x3FF;
        if (e === 0)  return s * m * Math.pow(2, -24);
        if (e === 31) return m ? NaN : s * Infinity;
        return s * (1 + m / 1024) * Math.pow(2, e - 15);
    }
    static _floatToHalfNearest(val) {
        WebGLWorldAdapter._f16_f32buf[0] = val;
        const x = WebGLWorldAdapter._f16_u32buf[0];
        const sign = (x >>> 16) & 0x8000;
        const e = (x >>> 23) & 0xFF, m = x & 0x7FFFFF;
        if (e === 0xFF) return sign | 0x7C00 | (m ? 0x200 : 0); // inf/NaN
        if (e > 142)    return sign | 0x7C00;                   // overflow -> inf (directional fixup below corrects inward roundings)
        if (e < 103)    return sign;                            // underflow -> +-0
        if (e < 113) {                                          // subnormal half
            const shift = 126 - e, mm = 0x800000 | m;
            let hm = mm >>> shift;
            if (mm & (1 << (shift - 1))) hm += 1;               // may carry into the smallest normal; that's the correct next value
            return sign | hm;
        }
        let h = sign | ((e - 112) << 10) | (m >>> 13);
        if (m & 0x1000) h += 1;                                 // mantissa carry may bump exponent (or overflow to inf); both are the correct next value
        return h;
    }
    // Bit-order-aware one-ulp steps (negative halves move toward -inf as their bits increase).
    static _halfSucc(h) { // next representable value toward +inf, saturating
        if (h === 0x7C00) return h;
        if (h === 0x0000 || h === 0x8000) return 0x0001;
        return (h & 0x8000) ? h - 1 : h + 1;
    }
    static _halfPred(h) { // next representable value toward -inf, saturating
        if (h === 0xFC00) return h;
        if (h === 0x0000 || h === 0x8000) return 0x8001;
        return (h & 0x8000) ? h + 1 : h - 1;
    }
    static floatToHalfBits(v, roundUp) {
        let h = WebGLWorldAdapter._floatToHalfNearest(v);
        const back = WebGLWorldAdapter._halfToFloat(h);
        if (roundUp) {
            if (back < v) h = WebGLWorldAdapter._halfSucc(h);
        }
        else if (back > v) h = WebGLWorldAdapter._halfPred(h);
        return h;
    }
    // Matches GLSL packHalf2x16: x in the low 16 bits, y in the high 16. The |0 wraps to a signed int32
    // for the RGBA32I texture; the shader's uint() cast is bit-preserving, so unpackHalf2x16 recovers
    // the exact halves.
    static packHalf2x16(xBits, yBits) {
        return ((yBits << 16) | xBits) | 0;
    }
    static packBVHNodeTexel(aabb, nodeData) {
        const dn = (v) => WebGLWorldAdapter.floatToHalfBits(v, false),
              up = (v) => WebGLWorldAdapter.floatToHalfBits(v, true);
        return [
            WebGLWorldAdapter.packHalf2x16(dn(aabb.min[0]), dn(aabb.min[1])),
            WebGLWorldAdapter.packHalf2x16(dn(aabb.min[2]), up(aabb.max[0])),
            WebGLWorldAdapter.packHalf2x16(up(aabb.max[1]), up(aabb.max[2])),
            nodeData
        ];
    }


    constructor(world, webgl_helper, renderer_adapter, world_editable = false) {
        this.renderer_adapter = renderer_adapter;

        this.WORLD_EDITABLE = world_editable;
        
        [this.world_node_texture_unit, this.world_node_texture] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        // BVH nodes are packed one RGBA32I texel per node (fp16 AABB + full-precision child data, see
        // packBVHNodeTexel), halving per-node fetch traffic vs the older two-RGBA32F-texel layout —
        // traversal was measured to be strongly bandwidth-bound, dominated by node fetches.
        [this.world_aabb_texture_unit, this.world_aabb_texture] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        
        this.transform_store = new WebGLTransformStore();
        this.adapters = {
            lights:     new WebGLLightsAdapter(webgl_helper, this),
            materials:  new WebGLMaterialsAdapter(webgl_helper, this),
            geometries: new WebGLGeometriesAdapter(webgl_helper, this)
        };
        
        this.visitWorld(world, webgl_helper);
    }
    destroy(gl) {
        this.world_node_texture.destroy();
        this.world_aabb_texture.destroy();
        
        this.adapters.lights.destroy(gl);
        this.adapters.geometries.destroy(gl);
        this.adapters.materials.destroy(gl);
    }

    static collapseAncestorTransform(ancestors) {
        let ret = Mat4.identity();
        for (let a of ancestors)
            ret = ret.times(a.object.getTransform());
        return ret;
    }
    static collapseAncestorInvTransform(ancestors) {
        let ret = Mat4.identity();
        for (let a of ancestors)
            ret = a.object.getInvTransform().times(ret);
        return ret;
    }
    
    reset() {
        this.transform_store.clear();
        
        this.primitives = [];
        this.aggregates = [];
        this.transform_object_map = {};
        this.primitive_id_index_map = {};
        this.aggregate_id_index_map = {};
        this.aggregate_instance_map = {};
        this.untransformed_triangles = [];
        this.untransformed_triangles_by_material = [];
        
        this.bvh_trees = {};
        this.bvh_tree_order = [];
        this.bvh_node_count = 0;
        this.bvh_only_uses_untransformed_triangles = true;
        this.bvh_all_leaves_singular = true;
        
        this.adapters.lights.reset();
        this.adapters.geometries.reset();
        this.adapters.materials.reset();
    }
    visitWorld(world, webgl_helper, sceneEditable) {
        this.reset();
        this.world = world;
        
        // Deal with lights. Lights are WorldObjects in world.objects (possibly nested in aggregates); world.lights
        // returns one LightInstance per reachable light, carrying its ancestors, and those are what the lights
        // adapter samples for direct lighting.
        for (let light of world.lights)
            this.adapters.lights.visit(light, this.adapters.geometries, this.adapters.materials, webgl_helper);

        // To make a light with a surface visible to rays, it's drawn through an ordinary primitive standing in for it
        // (see makeLightEmitterProxy): same geometry and local transform, a material that only emits, and no shadow
        // casting. The stand-in takes the light's place in the tree (see visitDescendantObject), so it inherits the
        // light's ancestors' transforms. Lights without a surface (point lights) can't be hit and get no stand-in.
        this.light_emitter_proxies = new Map();   // light OBJECT_UID -> stand-in Primitive
        
        // As an acceleration for scenes with lots of triangles, any triangle primitive without a local
        // transformation in the scene will be indexed in a way that allows for ray intersection testing without
        // the need to load all the primitive's data. As an added complication, we're also going to bin those
        // triangles by material, so that material data can be handled efficiently.
        const me = this, visited = {};
        function searchForUntransformedTriangles(node) {
            if (node.OBJECT_UID in visited)
                return;
            visited[node.OBJECT_UID] = true;
            if (node instanceof Primitive
                && node.geometry instanceof Triangle
                && node.getTransform().is_identity()
                && node.does_cast_shadow)
            {
                const materialIndex = me.adapters.materials.visit(node.material, webgl_helper);
                while (me.untransformed_triangles_by_material.length <= materialIndex)
                    me.untransformed_triangles_by_material.push({ materialIndex: materialIndex, triangles: [], prims: [] });
                me.untransformed_triangles_by_material[materialIndex].triangles.push(node);
            }
            else if (node instanceof Aggregate)
                for (let child of node.objects)
                    searchForUntransformedTriangles(child);
        }
        for (let node of world.objects)
            searchForUntransformedTriangles(node);
        
        let count = 0;
        for (let bin of this.untransformed_triangles_by_material) {
            for (let t of bin.triangles) {
                const geometryIndex = this.adapters.geometries.visit(t.geometry, webgl_helper);
                if (geometryIndex != WebGLGeometriesAdapter.NULL_ID) {
                    const prim = this.visitPrimitive(t, webgl_helper);
                    this.untransformed_triangles.push(prim);
                    bin.prims.push(prim);
                }
            }
            delete(bin.triangles);
            bin.maxIndex = bin.prims.length + count;
            count += bin.prims.length;
        }
        
        // deal with world objects
        this.visitDescendantObject(new Aggregate(world.objects), webgl_helper);

        // Primitive indices of the light stand-ins, so the shader can tell when a ray has hit a light (see
        // worldRayColorShallow's countEmission).
        this.light_emitter_prim_ids = [...this.light_emitter_proxies.values()]
            .map(p => this.primitive_id_index_map[p.OBJECT_UID]).filter(i => i !== undefined);

        // If this adapter is being used to represent a world that is not editable, the generated shader source
        // will require that all transform indices for transformable objects be unique. Do that here.
        if (!this.WORLD_EDITABLE) {
            for (const p of this.primitives)
                if (!p.notTransformable)
                    this.updateTransformLocal(p, false);
        }
        
        // finally, we need to determine an order for any list start positions, as traversal order may separate
        // contiguous primitives under a single aggregate.
        this.updateIndicesStart();

        // Report BVH shape so we can tell a node-count problem (poor tree) from a per-test cost problem (fat leaves
        // / data layout) before profiling, and confirm assumptions like "list leaves are rare on dragon".
        this.logBVHDemographics();
    }
    
    // A stand-in Primitive that draws a light's emitting surface. Its material has the light's color as ambient
    // (scaled to the radiance the light's sampling implies, see RandomSampleAreaLight.emittedRadianceScale) and
    // nothing else, so a ray that hits it returns that radiance and stops. It casts no shadows, matching the CPU
    // rule that lights never occlude shadow rays.
    // world_transform is the light's full transform including its ancestors; the brightness depends on the world
    // space area. One stand-in is made per light, so a light referenced from several differently scaled aggregates
    // gets the brightness of the first one visited (the light it casts is still correct for every instance).
    makeLightEmitterProxy(light, world_transform) {
        if (!(light instanceof RandomSampleAreaLight))
            return null;
        const scale = light.emittedRadianceScale(world_transform);
        const proxy = new Primitive(light.surface_geometry,
            new PhongMaterial(light.color_mc, scale, 0, 0, 5, 0, 0),
            light.getTransform(), light.getInvTransform(), false);
        proxy.lightEmitterFor = light;
        proxy.emitterScale = scale;
        this.light_emitter_proxies.set(light.OBJECT_UID, proxy);
        return proxy;
    }
    // Called when a light's transform has been edited, to move its stand-in primitive along with it and keep its
    // brightness consistent with its (possibly changed) area.
    lightTransformChanged(light) {
        const proxy = this.light_emitter_proxies && this.light_emitter_proxies.get(light.OBJECT_UID);
        if (!proxy)
            return;
        proxy.setTransform(light.getTransform(), light.getInvTransform());
        const wrapped = this.primitives[this.primitive_id_index_map[proxy.OBJECT_UID]];
        for (const p of wrapped.parents) {
            p.object.contentsChanged();
            for (const a of p.ancestors)
                a.object.contentsChanged();
        }
        this.updateTransformLocal(wrapped);
        this.renderer_adapter.useTracerProgram();
        this.renderer_adapter.gl.uniformMatrix4fv(this.renderer_adapter.getUniformLocation("uTransforms"), true, this.transform_store.flat());

        const light_data = this.adapters.lights.getLights().find(l => l.light === light);
        if (light_data) {
            proxy.emitterScale = light.emittedRadianceScale(light_data.instance.getTransform());
            this.syncLightEmitterColor(light);
        }
    }
    // Copies a light's color (as stored for sampling) into its stand-in's emissive color, times the radiance scale.
    // Called after the light's color is edited or its area changes.
    syncLightEmitterColor(light) {
        const proxy = this.light_emitter_proxies && this.light_emitter_proxies.get(light.OBJECT_UID);
        const light_data = this.adapters.lights.getLights().find(l => l.light === light);
        if (!proxy || !light_data)
            return;
        const materials = this.adapters.materials;
        const src = light_data.color_mc,
              dst = materials.getMaterial(materials.visit(proxy.material)).ambient;
        let pairs;
        if (src.type == "checkerboard")  pairs = [[src.color1, dst.color1], [src.color2, dst.color2]];
        else if (src.type == "texture")  pairs = [[src.scale, dst.scale]];
        else                             pairs = [[src, dst]];
        for (const [s, d] of pairs)
            materials.modifySolidColor(d._id, s.color.times(proxy.emitterScale));
        this.renderer_adapter.resetDrawCount();
    }
    static colorEntryIds(mc) {
        if (mc.type == "checkerboard") return [mc.color1._id, mc.color2._id];
        if (mc.type == "texture")      return [mc.scale._id];
        return [mc._id];
    }

    // BVH structure is fixed once a scene is loaded (the editor can change transforms/materials/geometry types,
    // but never the tree shape itself), so the exact stack depth worldRayCastBVH needs is known at shader-build
    // time here, rather than needing to guess a conservative worst case in the generated GLSL.
    getBVHStackSize() {
        const depth = Math.max(1, ...this.bvh_tree_order.map(t => t.kdtree.maxDepth()));
        // The editable shader must not depend on which BVHs are in the scene (see WebGLRendererAdapter.worldModified),
        // so it gets a fixed size, which only grows if a deeper BVH appears.
        return this.WORLD_EDITABLE ? Math.max(WebGLWorldAdapter.EDITABLE_MIN_BVH_STACK, depth) : depth;
    }
    static EDITABLE_MIN_BVH_STACK = 32;
    // Rounds a count up to a power of two (at least min), for array sizes in the editable shader: adding a few objects
    // or lights then rarely changes the shader source, so no recompile is needed.
    // The 4th channel of a primitive's data: bit 0 = casts shadows, bit 1 = stands in for a light.
    static primitiveFlags(prim) {
        return (prim.does_cast_shadow ? 1 : 0) | (prim.lightEmitterFor ? 2 : 0);
    }
    static editableCapacity(n, min) {
        return Math.max(min, Math.pow(2, Math.ceil(Math.log2(Math.max(1, n)))));
    }

    // Walk each BVH and log its shape: node/leaf counts, leaf-size distribution (singular vs list), depth, and an
    // SAH cost estimate. The SAH cost is the classic expected-traversal-cost model
    //     Ct * sum_internal(SA_node / SA_root)  +  Ci * sum_leaf(SA_leaf / SA_root * prims_in_leaf),
    // i.e. the mean number of node visits + primitive tests a random ray is expected to pay. Lower is a better tree.
    // Ct = 0.125 matches the traversal constant used by the SAH split search in src/aggregates.js.
    logBVHDemographics() {
        if (!this.bvh_tree_order.length)
            return;

        const Ct = 0.125, Ci = 1.0;
        const fmt = x => (Number.isFinite(x) ? x.toFixed(2) : String(x));

        let totals = { nodes: 0, leaves: 0, prims: 0, listLeaves: 0 };
        myconsole.log(`BVH demographics (${this.bvh_tree_order.length} tree(s), stack size ${this.getBVHStackSize()}):`);

        for (const tree of this.bvh_tree_order) {
            const root = tree.kdtree;
            const rootSA = root.aabb.surfaceArea();

            let nodes = 0, leaves = 0, internal = 0, prims = 0, listLeaves = 0, maxLeafSize = 0;
            let maxDepth = 0, leafDepthSum = 0, sahTraversal = 0, sahIntersect = 0;

            (function walk(node) {
                nodes++;
                const saFrac = (rootSA > 0 && Number.isFinite(rootSA)) ? node.aabb.surfaceArea() / rootSA : 0;
                if (node.isLeaf) {
                    leaves++;
                    const n = node.objects.length;
                    prims += n;
                    if (n > 1) listLeaves++;
                    maxLeafSize = Math.max(maxLeafSize, n);
                    maxDepth = Math.max(maxDepth, node.depth);
                    leafDepthSum += node.depth;
                    sahIntersect += Ci * saFrac * n;
                }
                else {
                    internal++;
                    sahTraversal += Ct * saFrac;
                    walk(node.greater_node);
                    walk(node.lesser_node);
                }
            })(root);

            totals.nodes += nodes; totals.leaves += leaves; totals.prims += prims; totals.listLeaves += listLeaves;
            const idx = tree.index !== undefined ? tree.index : this.bvh_tree_order.indexOf(tree);
            myconsole.log(
                `  tree #${idx}: ${nodes} nodes (${leaves} leaf / ${internal} internal), ${prims} prims\n` +
                `    depth: max ${maxDepth}, mean leaf ${fmt(leafDepthSum / leaves)}\n` +
                `    leaf size: 1..${maxLeafSize}, mean ${fmt(prims / leaves)} — ` +
                    `${leaves - listLeaves} singular / ${listLeaves} list (${fmt(100 * listLeaves / leaves)}% list)\n` +
                `    SAH cost estimate: ${fmt(sahTraversal + sahIntersect)} ` +
                    `(traversal ${fmt(sahTraversal)} + intersection ${fmt(sahIntersect)}), root SA ${fmt(rootSA)}`);
        }

        if (this.bvh_tree_order.length > 1)
            myconsole.log(`  totals: ${totals.nodes} nodes, ${totals.leaves} leaves ` +
                `(${totals.listLeaves} list), ${totals.prims} prims`);
    }

    updateIndicesStart() {
        let indices_count = 0;
        for (const t of this.bvh_tree_order) {
            t.indicesStartIndex = indices_count;
            // Must match what writeShaderData lays out: each BVH contributes its list-leaf entries, not one entry
            // per node. (Counting nodes here pushed every aggregate list after it out of bounds; only the editable
            // shader reads those lists from the texture, so it was the only one affected.)
            indices_count += t.bvh_object_list.length;
        }
        for (const a of this.aggregates) {
            if (a.type == "BVH")
                a.indicesStartIndex = a.bvh_tree.indicesStartIndex;
            else {
                a.indicesStartIndex = indices_count;
                indices_count += a.indicesList.length;
            }
        }
    }
    
    visitPrimitive(prim, webgl_helper) {
        if (!(prim instanceof Primitive))
            throw "Cannot call visitPrimitive on non-Primitive";
        
        if (prim.OBJECT_UID in this.primitive_id_index_map)
            return this.primitives[this.primitive_id_index_map[prim.OBJECT_UID]];
        
        const index = this.primitive_id_index_map[prim.OBJECT_UID] = this.primitives.length;
        
        const wrapped = new WrappedPrimitive(index, prim,
            this.registerTransform(prim.getInvTransform(), prim),
            this.adapters.geometries.visit(prim.geometry, webgl_helper),
            this.adapters.materials.visit( prim.material, webgl_helper), this);
        this.primitives.push(wrapped);
        
        return wrapped;
    }
    visitDescendantObject(obj, webgl_helper, ancestors=[]) {
        if (obj instanceof Primitive) {
            const prim = this.visitPrimitive(obj, webgl_helper, ancestors);
            if (ancestors && ancestors.length) {
                ancestors[ancestors.length-1].indicesList.push(prim.index);
                ancestors[ancestors.length-1].immediatePrimitiveChildren.push(prim);
                prim.parents.push(ancestors[ancestors.length-1]);
            }
            return prim;
        }
        else if (obj instanceof BVHAggregate) {
            // NB: construction of a wrapped bvh tree will automatically call visit primitive on all
            // descendant objects, so there is no need to do it again as with regular aggregates.
            const bvh_tree = (obj.kdtree.NODE_UID in this.bvh_trees)
                ? this.bvh_trees[obj.kdtree.NODE_UID]
                : new WrappedBVHTree(this.bvh_trees.length, obj.kdtree, this, webgl_helper);
            
            return new WrappedBVHAggregate(this.aggregates.length, obj, bvh_tree, ancestors,
                this.registerObjectTransform(obj, ancestors), this);
        }
        else if (obj instanceof Aggregate) {
            const agg = new WrappedAggregate(this.aggregates.length, obj, ancestors,
                this.registerObjectTransform(obj, ancestors), this);
            
            for (let o of obj.objects) {
                const child = this.visitDescendantObject(o, webgl_helper, ancestors.concat(agg));
                if (child)
                    agg.children.push(child);
            }
            
            return agg;
        }
        // A light (at any depth) is drawn by its stand-in primitive, which has the light's local transform and so
        // picks up the same ancestors. The light's sampling is handled by the lights adapter.
        else if (obj instanceof Light) {
            let proxy = this.light_emitter_proxies.get(obj.OBJECT_UID);
            if (!proxy)
                proxy = this.makeLightEmitterProxy(obj,
                    WebGLWorldAdapter.collapseAncestorTransform(ancestors).times(obj.getTransform()));
            return proxy ? this.visitDescendantObject(proxy, webgl_helper, ancestors) : null;
        }
        else
            throw "Unsupported object type";
    }
    
    intersectRay(ray, renderer_adapter, gl, program) {
        const intersect = this.world.cast(ray);
        if (!intersect.object)
            return null;
        if (intersect.object instanceof Light) {
            // Match the specific occurrence of the light that was hit, by its chain of ancestors.
            const same = (a, b) => a.length == b.length && a.every((x, i) => x === b[i]);
            const light_data = this.adapters.lights.getLights().find(l => l.light === intersect.object && same(l.instance.ancestors, intersect.ancestors))
                            || this.adapters.lights.getLights().find(l => l.light === intersect.object);
            return light_data ? new WrappedLight(light_data, this) : null;
        }
        return new WrappedPrimitiveInstance(this.primitives[this.primitive_id_index_map[intersect.object.OBJECT_UID]],
            intersect.ancestors.map((a,i) =>
                this.aggregates[this.aggregate_id_index_map[
                    this.aggregates[0].object.OBJECT_UID + ":" + intersect.ancestors.slice(0, i+1).map(aa => aa.OBJECT_UID).join(":")]]), this);
    }
    getLights(renderer_adapter, gl, program) {
        return this.adapters.lights.getLights().map(l => new WrappedLight(l, this));
    }
    getSceneTree(renderer_adapter, gl, program) {
        return this.aggregates[0];
    }
    
    registerTransform(transform, object, allow_reuse = true) {
        const transformIndex = this.transform_store.store(transform, allow_reuse);
        if (!(transformIndex in this.transform_object_map))
            this.transform_object_map[transformIndex] = [];
        this.transform_object_map[transformIndex].push(object);
        return transformIndex;
    }
    registerObjectTransform(object, ancestors) {
        return this.registerTransform(object.getInvTransform().times(WebGLWorldAdapter.collapseAncestorInvTransform(ancestors)), object);
    }
    updateTransformLocal(wrapped_obj, allow_reuse=true) {
        const set_transform = wrapped_obj.type == "primitive" ? wrapped_obj.getInvTransform() : wrapped_obj.getWorldInvTransform();
        if (this.transform_object_map[wrapped_obj.transformIndex].length > 1) {
            if (!this.WORLD_EDITABLE)
                myconsole.error("Transform modification of object with shared transform not possible for shader built without editing enabled. Weirdness ahead...");
            this.transform_object_map[wrapped_obj.transformIndex] 
                = this.transform_object_map[wrapped_obj.transformIndex].filter(o => o !== wrapped_obj.object);
            wrapped_obj.transformIndex = this.registerTransform(set_transform, wrapped_obj.object, allow_reuse);
            // Primitives' texels follow the aggregates' in the world data texture (see writeShaderData).
            this.world_node_texture.modifyDataPixel((wrapped_obj.type == "primitive" ? this.aggregates.length : 0) + wrapped_obj.index,
                wrapped_obj.getDataVector());
        }
        else
            this.transform_store.set(wrapped_obj.transformIndex, set_transform);
    }
    updateTransformsRecursive(wrapped_obj) {
        if (wrapped_obj.type == "primitive")
            return;
        
        this.updateTransformLocal(wrapped_obj);
        
        for (let child of wrapped_obj.children)
            if (child.type != "primitive")
                this.updateTransformsRecursive(child);
    }
    setObjectTransform(wrapped_obj, new_transform, new_inv_transform) {
        if (wrapped_obj.notTransformable)
            return;
        
        wrapped_obj.object.setTransform(wrapped_obj.getAncestorInvTransform().times(new_transform), new_inv_transform.times(wrapped_obj.getAncestorTransform()));
        
        if (wrapped_obj.type == "primitive") {
            this.updateTransformLocal(wrapped_obj);
            for (let p of wrapped_obj.parents) {
                p.object.contentsChanged();
                for (let a of p.ancestors)
                    a.object.contentsChanged();
            }
        }
        else {
            for (let agg of this.aggregate_instance_map[wrapped_obj.object.OBJECT_UID]) {
                this.updateTransformsRecursive(agg);
                for (let a of wrapped_obj.ancestors)
                    a.object.contentsChanged();
            }
            for (let child of wrapped_obj.children)
                if (child.type != "primitive")
                    this.updateTransformsRecursive(child);
        }
        
        // TODO: should this check whether transforms have expanded beyond the bounds of available memory?
        this.renderer_adapter.useTracerProgram();
        this.renderer_adapter.gl.uniformMatrix4fv(this.renderer_adapter.getUniformLocation("uTransforms"), true, this.transform_store.flat());
        this.renderer_adapter.resetDrawCount();
    }
    modifyMaterialSolidColor(material_color_index, new_color) {
        this.adapters.materials.modifySolidColor(material_color_index, new_color);
        // If this color belongs to a light, its visible surface has to follow.
        const id = Number(material_color_index);
        for (const l of this.adapters.lights.getLights())
            if (WebGLWorldAdapter.colorEntryIds(l.color_mc).includes(id))
                this.syncLightEmitterColor(l.light);
    }
    modifyMaterialScalar(material_index, new_scalar) {
        this.adapters.materials.modifyScalar(material_index, new_scalar);
    }
    modifyGeometryType(wrapped_obj, new_type) {
        if (wrapped_obj.type != "primitive")
            throw "Cannot change geometry type for non-primitive object";
        this.primitives[wrapped_obj.index].geometryIndex = wrapped_obj.geometryIndex = new_type;
        wrapped_obj.object.geometry = this.adapters.geometries.geometries[new_type - 1];
        wrapped_obj.object.contentsChanged();
        wrapped_obj.aabb = wrapped_obj.getBoundingBox();
        
        for (let p of wrapped_obj.parents) {
            p.object.contentsChanged();
            for (let a of p.ancestors)
                a.object.contentsChanged();
        }
        
        this.world_node_texture.modifyDataPixel(this.aggregates.length + wrapped_obj.index, wrapped_obj.getDataVector());
        this.renderer_adapter.resetDrawCount();
    }

    
    writeShaderData(gl, program, webgl_helper) {
        // write global world properties
        gl.uniform3fv(gl.getUniformLocation(program, "uBackgroundColor"), this.world.bg_color);
        
        // write transforms
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uTransforms"), true, this.transform_store.flat());
        
        // process world node data for writing
        const primitive_list = this.primitives.map(o => o.getDataVector()).flat();
        let aggregate_list = [], indices_list = [], aabb_data = [];
        for (let a of this.bvh_tree_order) {
            indices_list = indices_list.concat(a.bvh_object_list);
            aabb_data = aabb_data.concat(a.bvh_nodes.map(n => WebGLWorldAdapter.packBVHNodeTexel(n.aabb,
                (n.isLeaf && !n.isSingularLeaf) ? -1 - (this.primitives.length + n.hitIndex) : n.hitIndex)).flat());
        }
        for (const a of this.aggregates) {
            if (a.type_code == WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE) {
                aggregate_list.push(a.type_code, a.transformIndex, a.indicesStartIndex, a.indicesList.length);
                indices_list = indices_list.concat(a.indicesList);
            }
            else if (a.type_code == WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE) {
                aggregate_list.push(...a.getDataVector());
            }
            else
                throw "Unsupported aggregate type detected";
        }
        
        // Write world node data
        gl.uniform1i(gl.getUniformLocation(program, "uWorldNumAggregates"), this.aggregates.length);
        gl.uniform1i(gl.getUniformLocation(program, "uWorldNumPrimitives"), this.primitives.length);
        gl.uniform1i(gl.getUniformLocation(program, "uWorldNumUntransformedTriangles"), this.untransformed_triangles.length);
        gl.uniform1i(gl.getUniformLocation(program, "uWorldListsStart"), this.aggregates.length + this.primitives.length);
        this.world_node_texture.setDataPixelsUnit([...aggregate_list, ...primitive_list, ...indices_list],
            this.world_node_texture_unit, "uWorldData", program);
        if (this.bvh_child_boxes)
            this.world_aabb_texture.setDataPixelsUnit(this.bvh_child_box_layout.data, this.world_aabb_texture_unit, "uWorldAABBs", program);
        else if (this.bvh_node_texture_width) {
            // debugFastNodeIndex layout: must match the width baked into fetchBVHNodeTexel by getShaderSource.
            const w = this.bvh_node_texture_width, nodes = aabb_data.length / 4, h = Math.max(1, Math.ceil(nodes / w));
            const padded = new Int32Array(w * h * 4);
            padded.set(aabb_data);
            gl.activeTexture(this.world_aabb_texture_unit);
            this.world_aabb_texture.setPixels(padded, 4, "INTEGER", w, h);
            gl.uniform1i(gl.getUniformLocation(program, "uWorldAABBs"), WebGLHelper.textureUnitIndex(this.world_aabb_texture_unit));
        }
        else
            this.world_aabb_texture.setDataPixelsUnit(aabb_data.flat(), this.world_aabb_texture_unit, "uWorldAABBs", program);
        
        // let our contained adapters do their own thing too
        this.adapters.lights.writeShaderData(gl, program, webgl_helper);
        this.adapters.materials.writeShaderData(gl, program, webgl_helper);
        this.adapters.geometries.writeShaderData(gl, program, webgl_helper);
    }
    // debugChildBoxes layout, built at shader-gen time (getShaderSource) and uploaded by writeShaderData. Each BVH
    // node becomes W consecutive RGBA32I texels, one per child slot: [child AABB as 3 packed fp16 pairs, child data].
    // Child data is > 0 for an internal child (its node index within the tree + 1), < 0 for a leaf (the same leaf
    // encoding the original layout uses), and 0 for an empty slot. The root's own box is never stored or tested,
    // since its children's boxes lie inside it.
    // W = 2 keeps the binary tree as is. W = 4 (debugWideBVH) collapses it: each wide node starts from a binary
    // node's two children and repeatedly replaces the internal child with the largest surface area by that child's
    // own two children, until it has W slots or only leaves remain.
    // Sets tree.childBoxStart (texel offset) on every tree, and returns { data, maxStack }.
    buildChildBoxBVHData(W) {
        const data = [];
        let maxStack = 1;
        const emptyTexel = WebGLWorldAdapter.packBVHNodeTexel({ min: [0, 0, 0], max: [0, 0, 0] }, 0);
        for (const tree of this.bvh_tree_order) {
            tree.childBoxStart = data.length / 4;
            const nodes = tree.bvh_nodes;
            const leafData = n => (n.isLeaf && !n.isSingularLeaf) ? -1 - (this.primitives.length + n.hitIndex) : n.hitIndex;
            const children = i => [i + 1, nodes[i].hitIndex >> 2];
            const area = i => nodes[i].aabb.surfaceArea();

            const wide = [];   // wide node index -> array of { slot: binary index, child: wide index or undefined }
            let treeDepth = 0;
            const build = (slots, depth) => {
                treeDepth = Math.max(treeDepth, depth);
                while (slots.length < W) {
                    let best = -1;
                    for (const sl of slots)
                        if (!nodes[sl].isLeaf && (best < 0 || area(sl) > area(best)))
                            best = sl;
                    if (best < 0)
                        break;
                    slots.splice(slots.indexOf(best), 1, ...children(best));
                }
                const index = wide.length;
                wide.push(null);
                wide[index] = slots.map(sl => nodes[sl].isLeaf ? { slot: sl } : { slot: sl, child: build(children(sl), depth + 1) });
                return index;
            };
            build(nodes[0].isLeaf ? [0] : children(0), 1);
            // Each visit can leave at most W - 1 entries on the stack, so this bounds the stack for this tree.
            maxStack = Math.max(maxStack, (W - 1) * treeDepth + 1);

            for (const entries of wide) {
                for (let c = 0; c < W; ++c) {
                    const e = entries[c];
                    if (!e)
                        data.push(...emptyTexel);
                    else
                        data.push(...WebGLWorldAdapter.packBVHNodeTexel(nodes[e.slot].aabb,
                            e.child === undefined ? leafData(nodes[e.slot]) : e.child + 1));
                }
            }
        }
        // An editable scene can have no BVHs at all; keep the texture non-empty.
        if (!data.length)
            data.push(...emptyTexel);
        return { data, maxStack };
    }
    // The editable shader's ray cast as a single loop. It walks the root aggregates, the BVH nodes under each BVH root
    // (child-box layout), and lists of primitives, but tests a primitive in only one place. The shader compiler
    // inlines the generic geometry intersection at every call site, and each copy costs about a second of compile
    // time; the layered version (worldRayCastList, worldRayCastBVH and its leaves) had three sites per ray cast.
    // Used when the BVHs use the child-box layout (or there are none).
    editableUnifiedCast() {
        return this.WORLD_EDITABLE && WebGLRendererAdapter.editableUnifiedCast && (this.bvh_child_boxes || this.bvh_node_count == 0);
    }
    getEditableUnifiedRayCastSource(heatmap) {
        const W = this.bvh_child_boxes ? this.bvh_child_box_width : 2;
        // Leaves are pushed too, so a visit can leave up to W entries on the stack.
        const stackSize = (this.bvh_child_boxes ? (W == 2 ? this.getBVHStackSize() : this.bvh_child_box_layout.maxStack) : 1) + W;
        return `
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
                                ${heatmap ? `gHeatmapNodeCount++;` : ``}
                                int node_index = entry - 1;
                                int nearEntry = 0;
                                float nearT = 0.0;
                                for (int c = 0; c < ${W}; ++c) {
                                    ivec4 childTexel = fetchBVHNodeTexel(bvhStart + ${W} * node_index + c);
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
                                        ${heatmap ? `gHeatmapMissCount++;` : ``}
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
                    ${heatmap ? `if (bvhStart >= 0) gHeatmapPrimCount++;` : ``}
                    if (worldRayCastObject(prim, local_r, minT, maxT, shadowFlag, min_found_t, primID)) {
                        ancestorInvTransform = root_invTransform;
                        if (shadowFlag)
                            break;
                    }
                }

                return min_found_t;
            }`;
    }
    getChildBoxBVHSource(heatmap) {
        const W = this.bvh_child_box_width;
        const tnearStack = !!WebGLRendererAdapter.debugStackTNear && W == 2;
        const topCache = !!WebGLRendererAdapter.debugStackTopCache && !tnearStack && W == 2;
        return `
            #define BVH_STACK_SIZE ${W == 2 ? this.getBVHStackSize() : this.bvh_child_box_layout.maxStack}
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
                ${tnearStack ? `float stackT[BVH_STACK_SIZE];` : ``}
                int stackPtr = 0;
                ${topCache ? `
                // debugStackTopCache: the most recently pushed node lives in a register (stackTop); only older
                // entries go through the dynamically indexed array. Most pops take the entry just pushed.
                int stackTop = -1;` : ``}
                int node_index = 0;

                while (true) {
                    ${heatmap ? `gHeatmapNodeCount++;` : ``}
                    int nearChild = -1, farChild = -1;
                    float nearT = 0.0, farT = 0.0;
                    for (int c = 0; c < ${W}; ++c) {
                        ivec4 childTexel = fetchBVHNodeTexel(root_index + ${W} * node_index + c);
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
                            ${heatmap ? `gHeatmapMissCount++;` : ``}
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
                        }${W == 2 ? `
                        else if (tnear < nearT) {
                            farChild = nearChild;
                            farT = nearT;
                            nearChild = childData - 1;
                            nearT = tnear;
                        }
                        else {
                            farChild = childData - 1;
                            farT = tnear;
                        }` : `
                        // Wide node: the nearest hit internal child is visited next; every other hit internal
                        // child goes straight onto the stack (unsorted among themselves).
                        else if (tnear < nearT) {
                            if (stackPtr < BVH_STACK_SIZE)
                                stack[stackPtr++] = nearChild;
                            nearChild = childData - 1;
                            nearT = tnear;
                        }
                        else if (stackPtr < BVH_STACK_SIZE)
                            stack[stackPtr++] = childData - 1;`}
                    }
                    if (shadowFlag && found_min)
                        break;

                    ${topCache ? `
                    if (farChild >= 0) {
                        if (stackTop >= 0 && stackPtr < BVH_STACK_SIZE)
                            stack[stackPtr++] = stackTop;
                        stackTop = farChild;
                    }` : `
                    if (farChild >= 0 && stackPtr < BVH_STACK_SIZE) {
                        ${tnearStack ? `stackT[stackPtr] = farT;` : ``}
                        stack[stackPtr++] = farChild;
                    }`}
                    if (nearChild >= 0)
                        node_index = nearChild;
                    else {
                        ${tnearStack ? `
                        // debugStackTNear: drop stacked nodes whose box entry is now beyond the closest hit found
                        // since they were pushed, without fetching them.
                        while (stackPtr > 0 && min_found_t >= minT && stackT[stackPtr - 1] > min_found_t)
                            --stackPtr;` : ``}
                        ${topCache ? `
                        if (stackTop >= 0) {
                            node_index = stackTop;
                            stackTop = -1;
                        }
                        else if (stackPtr > 0)
                            node_index = stack[--stackPtr];
                        else
                            break;` : `
                        if (stackPtr <= 0)
                            break;
                        node_index = stack[--stackPtr];`}
                    }
                }
                return found_min;
            }`;
    }
    getShaderSourceDeclarations() {
        return `
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag);
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int primID, inout mat4 ancestorInvTransform);
            vec3 worldObjectColor(in int primID, in vec4 rp, in Ray r, in mat4 ancestorInvTransform, inout vec2 random_seed, inout RecursiveNextRays nextRays, inout vec3 normal);
            vec3 worldRayColorShallow(in Ray in_ray, inout vec2 random_seed, inout vec4 intersect_position, inout RecursiveNextRays nextRays, inout vec3 normal, in bool countEmission);` + "\n"
            + this.adapters.lights.getShaderSourceDeclarations()     + "\n"
            + this.adapters.geometries.getShaderSourceDeclarations(this.WORLD_EDITABLE) + "\n"
            + this.adapters.materials.getShaderSourceDeclarations()  + "\n";
    }
    getShaderSource() {
        this.shader_transform_max_size = this.WORLD_EDITABLE
            ? WebGLWorldAdapter.editableCapacity(this.transform_store.size(), 64)
            : Math.max(16, this.transform_store.size());

        // Traversal-cost heatmap instrumentation (see WebGLRendererAdapter.debugTraversalHeatmap). When active, the
        // shared BVH traversal below increments per-fragment counters that worldRayColorShallow then maps to a false
        // color instead of shading. 'heatmap' is false | 'nodes' | 'prims' | 'both'.
        const heatmap = WebGLRendererAdapter.debugTraversalHeatmap;
        const heatNodeScale = Number(WebGLRendererAdapter.debugHeatmapNodeScale) || 1;
        const heatPrimScale = Number(WebGLRendererAdapter.debugHeatmapPrimScale) || 1;

        // debugFastNodeIndex: choose the BVH node texture's width here, at shader-gen time, so it can be baked into the
        // shader as a mask/shift. writeShaderData (which always runs after this) lays the texture out to match. The node
        // count is fixed once the scene is visited, so the width stays valid until the next shader rebuild.
        // debugChildBoxes: store each internal node's two CHILD boxes in the node (2 texels per internal node), so a
        // child is only fetched once its box is known to be hit. Used by the editable shader too: a BVH's boxes are in
        // its own local space, so editing transforms never changes them. Decided here at shader-gen time;
        // writeShaderData uploads the matching layout.
        this.bvh_child_boxes = !!WebGLRendererAdapter.debugChildBoxes && (this.WORLD_EDITABLE || this.bvh_node_count > 0);
        this.bvh_child_box_width = (this.bvh_child_boxes && WebGLRendererAdapter.debugWideBVH) ? 4 : 2;
        this.bvh_child_box_layout = this.bvh_child_boxes ? this.buildChildBoxBVHData(this.bvh_child_box_width) : null;
        this.bvh_node_texture_width = (WebGLRendererAdapter.debugFastNodeIndex && !this.bvh_child_boxes && this.bvh_node_count > 0)
            ? Math.pow(2, Math.ceil(Math.log2(Math.max(1, Math.ceil(Math.sqrt(this.bvh_node_count))))))
            : 0;
        
        // Below is most of the significant source for world ray cast and color functions, where the geometry and
        // material functionality is directly invoked. The source below has a variety of preprocessor branches that
        // can dramatically simplify the source if certain conditions are met, such as if the scene is not editable,
        // if the scene contains any BVHs, if all BVH leaf nodes contain only a single primitive, or if all primitives
        // inside a BVH are triangles with simple identity transforms.
        let ret = `
        
        
            // ========== WORLD ==========
            #define WORLD_EDITABLE ${Number(!!this.WORLD_EDITABLE)}
            #define WORLD_HAS_BVH_NODES ${Number(this.WORLD_EDITABLE || this.bvh_node_count > 0)}
            #define WORLD_BVH_LEAVES_SINGULAR ${Number(!this.WORLD_EDITABLE && !!this.bvh_all_leaves_singular)}
            #define WORLD_BVH_ONLY_UNTRANSFORMED_TRIANGLES ${Number(!this.WORLD_EDITABLE && !!this.bvh_only_uses_untransformed_triangles)}
        
        
            uniform vec3 uBackgroundColor;

            // TODO: should safety check the size of this, for larger sizes need a texture
            uniform mat4 uTransforms[${this.shader_transform_max_size}];
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
            ${heatmap ? `
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
            }` : ``}


#if (WORLD_EDITABLE || (WORLD_HAS_BVH_NODES && !WORLD_BVH_ONLY_UNTRANSFORMED_TRIANGLES))
            // ---- Generic Intersection with a particular object ----
            float worldObjectIntersect(in int prim_id, in Ray r, in float minDistance, in bool shadowFlag) {
                int geometry_id = 0;
                // Untransformed triangles (the bulk of any mesh) are tested directly, skipping the generic geometry
                // dispatch. Their primitive index is their triangle index.
                // (Without any, the triangle code may not be compiled in, and this branch is never taken.)
                if (prim_id < uWorldNumUntransformedTriangles)
                    return ${(this.WORLD_EDITABLE || this.untransformed_triangles.length) ? `triangleIntersect(r, minDistance, prim_id)` : `minDistance - 1.0`};
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
                ${heatmap ? `gHeatmapPrimCount++;` : ``}
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
                ${heatmap ? `gHeatmapPrimCount++;` : ``}
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
            ${this.bvh_node_texture_width ? `
            // debugFastNodeIndex: the node texture is laid out ${this.bvh_node_texture_width} texels wide (a power of
            // two, fixed at shader-gen time; see WebGLWorldAdapter.writeShaderData), so index -> texel is mask + shift.
            ivec4 fetchBVHNodeTexel(in int index) {
                return texelFetch(uWorldAABBs, ivec2(index & ${this.bvh_node_texture_width - 1}, index >> ${Math.log2(this.bvh_node_texture_width)}), 0);
            }` : `
            ivec4 fetchBVHNodeTexel(in int index) {
                return itexelFetchByIndex(index, uWorldAABBs);
            }`}

            ${this.bvh_child_boxes ? this.getChildBoxBVHSource(heatmap) : `
            #define BVH_STACK_SIZE ${this.getBVHStackSize()}
            bool worldRayCastBVH(in int root_index, in int indices_offset, in Ray r, in float minT, in float maxT, in bool shadowFlag, inout float min_found_t, inout int min_prim_id) {
                bool found_min = false;

                ${WebGLRendererAdapter.debugFastAABB ? `
                vec3 invD  = 1.0 / r.d.xyz;
                vec3 oInvD = r.o.xyz * invD;` : ``}

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
                    ${heatmap ? `gHeatmapNodeCount++;` : ``}
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
                    ${WebGLRendererAdapter.debugFastAABB ? `
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
                    bool hit_node = tnear <= tfar && (tnear <= min_found_t || min_found_t < minT);` : `
                    vec2 aabb_ts = AABBIntersects(r, vec4(0.5*(aabb_min + aabb_max), 1.0), vec4(0.5*(aabb_max - aabb_min), 0.0), minT, maxT);
                    bool hit_node = aabb_ts.x <= maxT && aabb_ts.y >= minT && (aabb_ts.x <= min_found_t || min_found_t < minT);`}

                    bool descending = false;
                    ${heatmap ? `if (!hit_node) gHeatmapMissCount++;` : ``}

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
            }`}
#endif

            // ---- Generic World Color ----
            // countEmission: whether a light hit directly by this ray contributes its emission. True for camera rays and
            // exact (mirror/refraction) bounces, false for randomly sampled bounces, whose light was already counted by
            // direct light sampling at the surface they left (see src/lights.js).
            vec3 worldRayColorShallow(in Ray in_ray, inout vec2 random_seed, inout vec4 intersect_position, inout RecursiveNextRays nextRays, inout vec3 normal, in bool countEmission) {
                int primID = -1;
                mat4 ancestorInvTransform = mat4(1.0);
                ${heatmap ? `gHeatmapNodeCount = 0; gHeatmapPrimCount = 0; gHeatmapMissCount = 0;` : ``}
                ${WebGLRendererAdapter.debugSkipTraversal
                    // Diagnostic floor: return before any world traversal. intersect_position stays zero, so the
                    // bounce loop exits after this, and nothing below is reached. What remains is the per-pixel work
                    // that doesn't depend on the scene: camera ray + jitter, accumulation texture reads/writes.
                    ? `return uBackgroundColor;` : ``}

                float intersect_time = worldRayCast(in_ray, EPSILON, 1E20, false, primID, ancestorInvTransform);
                ${heatmap ? `
                // Diagnostic: colorize the primary ray's traversal work instead of shading. Returning here leaves
                // nextRays zero (no shadow/secondary rays), so the counts reflect exactly one primary-ray cast. Miss
                // and hit are both colorized, since background rays still pay to traverse. worldObjectColor goes
                // unreferenced, so the whole material/light subtree is dead-code-eliminated as with debugTraversalOnly.
                {
                    // Raw counts for CPU readback (see WebGLRendererAdapter.reportHeatmapStats): the normal output is
                    // otherwise unused in heatmap mode, so it carries (nodes, prims, hit) unscaled and unclamped.
                    // In 'misses' mode the second channel carries failed-box-test node fetches instead of prim tests.
                    normal = vec3(float(gHeatmapNodeCount), float(${heatmap === 'misses' ? 'gHeatmapMissCount' : 'gHeatmapPrimCount'}), (primID != -1) ? 1.0 : 0.0);
                    float nodeC = float(gHeatmapNodeCount) / float(${heatNodeScale});
                    float primC = float(gHeatmapPrimCount) / float(${heatPrimScale});
                    ${heatmap === 'nodes' ? `return heatmapRamp(nodeC);`
                    : heatmap === 'prims' ? `return heatmapRamp(primC);`
                    : `return vec3(clamp(primC, 0.0, 1.0), clamp(nodeC, 0.0, 1.0), 0.0);`}
                }` : ``}
                if (primID == -1)
                    return uBackgroundColor;
                
                intersect_position = in_ray.o + intersect_time * in_ray.d;
                ${this.WORLD_EDITABLE ? `
                // A light's stand-in primitive was hit by a sampled bounce: its light is already counted, and lights
                // don't reflect, so this path ends here with nothing added. (Read from the primitive's data, so the
                // editable shader doesn't change when lights are added or removed.)
                if (!countEmission && getPrimitive(primID).isLightEmitter)
                    return vec3(0.0);` : this.light_emitter_prim_ids.length ? `
                // A light's stand-in primitive was hit by a sampled bounce: its light is already counted, and lights
                // don't reflect, so this path ends here with nothing added.
                if (!countEmission && (${this.light_emitter_prim_ids.map(i => `primID == ${i}`).join(" || ")}))
                    return vec3(0.0);` : ``}
                ${WebGLRendererAdapter.debugTraversalOnly
                    // Diagnostic: return a flat color instead of shading. Because worldObjectColor is then never
                    // referenced anywhere, the compiler dead-code-eliminates the entire material/light/scatter
                    // subtree, so this measures traversal cost with shading's register footprint actually removed
                    // (a runtime branch would leave that code compiled in and occupancy unchanged). nextRays stays
                    // zero, so no secondary rays are spawned and only primary-ray traversal is exercised.
                    ? `return vec3(0.7);`
                    : `return worldObjectColor(primID, intersect_position, in_ray, ancestorInvTransform, random_seed, nextRays, normal);`}
            }
            
            
            // This is an overload for worldRayCast that skips over some of the inout parameters
            // that are not relevant for some purposes like casting shadow rays.
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag) {
                int primID = -1;
                mat4 ancestorInvTransform = mat4(1.0);
                return worldRayCast(r, minT, maxT, shadowFlag, primID, ancestorInvTransform);
            }`;
            
        
        // There's a much larger divergence in source if the scene is editable. Instead of using the preprocessor,
        // the code is much more readable with branching in the source assembly.
        
        // The branch below is taken if the world is supposed to be editable at run time.
        // In this case, all aggregate and primitive data is read from the uWorldData texture, allowing any scene
        // to be rendered with the same shader. However, the downside is that the renderer will be significantly
        // slower for some scene/device permutations, and shader compilation will be very slow (e.g., more than
        // a minute) on some devices (e.g., Windows).
        if (this.WORLD_EDITABLE) {
            ret += `
            #define WORLD_NODE_AGGREGATE_TYPE    ${WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE}
            #define WORLD_NODE_BVH_TYPE          ${WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE}
            
            vec3 worldObjectColor(in int primID, in vec4 rp, in Ray r, in mat4 ancestorInvTransform, inout vec2 random_seed, inout RecursiveNextRays nextRays, inout vec3 normal) {
                Primitive ids = getPrimitive(primID);
                mat4 inverseTransform = getTransform(ids.transform_id) * ancestorInvTransform;
                GeometricMaterialData geomatdata = getGeometricMaterialData(ids.geometry_id, inverseTransform * rp, inverseTransform * r.d);
                geomatdata.normal = vec4(normalize((transpose(inverseTransform) * geomatdata.normal).xyz), 0);
                normal = geomatdata.normal.xyz;
                return colorForMaterial(ids.material_id, rp, r, geomatdata, random_seed, nextRays);
            }
            ${this.editableUnifiedCast() ? this.getEditableUnifiedRayCastSource(heatmap) : `            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int primID, inout mat4 ancestorInvTransform) {
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
            }`}`;
        }
        
        // If this branch is taken, the scene is not editable. This is potentially good news: by only including
        // features needed for this scene, we can do a lot more to make a shader that will compile and run faster.
        // However, it also makes this source considerably more complicated, with JS and GLSL mixing together.
        else {
            // First, let any aggregates specify any shader source declarations they may depend on later.
            ret += Object.values(this.aggregate_instance_map)
                .map(aggs => aggs[0].getStaticShaderSource())
                .filter(s => s && s.length)
                .join("\n");

            // Specify a statically defined ray cast function for shadow or color casting.
            ret += `
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int primID, inout mat4 ancestorInvTransform) {
                float min_found_t = minT - 1.0;
                mat4 root_invTransform;
                Ray root_r;`;
            
            // To significantly reduce the inline source complexity (and therefore compile time), all BVHs
            // are grouped together into a single invocation of the worldRayCastBVH function.
            if (this.bvh_tree_order.length > 0) {
                const bvhs = [];
                for (let b of this.bvh_tree_order)
                    for (let i of b.instances)
                        bvhs.push(i.transformIndex, this.bvh_child_boxes ? b.childBoxStart : i.bvhStartIndex, i.indicesStartIndex);
                ret += `
                
                // ---------- BVHs ----------
                const int bvhs[${bvhs.length}] = int[${bvhs.length}](${bvhs.join(", ")});
                for (int i = 0; i < min(${bvhs.length / 3}, uWorldNumAggregates); ++i) {
                    root_invTransform = getTransform(bvhs[i*3]);
                    root_r = Ray(root_invTransform * r.o, root_invTransform * r.d);
                    if (worldRayCastBVH(bvhs[3*i + 1], bvhs[3*i + 2], root_r, minT, maxT, shadowFlag, min_found_t, primID))
                        ancestorInvTransform = root_invTransform;
                    if (shadowFlag && primID != -1)
                        break;
                }`;
            }
            
            // Each aggregate also gets to specify an intersect function, generally as specified in WrappedAggregate.
            for (let [i, aggs] of Object.entries(Object.values(this.aggregate_instance_map))) {
                if (aggs.length == 0 || aggs[0].isEmpty() || aggs[0].type == "BVH")
                    continue;
                ret += `

                    // ---------- Aggregate ${i} ----------
                    if (shadowFlag && primID != -1) return min_found_t;`;

                // The following two sections of code are functionally identical: both essentially get a
                // transform for each aggregate instance, apply it to the ray, and call the aggregate
                // intersect function. However, the code can be made simpler, and faster to compile, for
                // the more common case of single instance aggregates.
                if (aggs.length == 1) {
                    ret += `
                    root_invTransform = getTransform(${aggs[0].transformIndex});
                    root_r = Ray(root_invTransform * r.o, root_invTransform * r.d);
                    if (${aggs[0].getIntersectShaderSource("root_r", "minT", "maxT", "shadowFlag", "primID", "min_found_t")})
                        ancestorInvTransform = root_invTransform;`;
                }
                else {
                    ret += `
                    const int agg_transforms_${i}[${aggs.length}] = int[${aggs.length}](${aggs.map(a => a.transformIndex).join(", ")});
                    for (int i = 0; i < min(${aggs.length}, uWorldNumAggregates); ++i) {
                        root_invTransform = getTransform(agg_transforms_${i}[i]);
                        root_r = Ray(root_invTransform * r.o, root_invTransform * r.d);
                        if (${aggs[0].getIntersectShaderSource("root_r", "minT", "maxT", "shadowFlag", "primID", "min_found_t")})
                            ancestorInvTransform = root_invTransform;
                        if (shadowFlag && primID != -1) break;
                    }`;
                }
            }
                
            ret += `
                
                return min_found_t;
            }
            
            
            vec3 worldObjectColor(in int primID, in vec4 rp, in Ray r, in mat4 ancestorInvTransform, inout vec2 random_seed, inout RecursiveNextRays nextRays, inout vec3 normal) {
                int materialID = 0;
                mat4 inverseTransform = mat4(1.0);
                GeometricMaterialData geomatdata;
                geomatdata.baseColor = vec3(1.0);`;
            if (this.untransformed_triangles.length) {
                ret += `
                if (primID < ${this.untransformed_triangles.length}) {
                    triangleMaterialData(ancestorInvTransform * rp, geomatdata, primID);
                    geomatdata.normal = vec4(normalize((transpose(ancestorInvTransform) * geomatdata.normal).xyz), 0);
                    if (false) {}`
                for (let bin of this.untransformed_triangles_by_material) {
                    ret += `
                    else if (primID < ${bin.maxIndex})
                        materialID = ${bin.materialIndex};`;
                }
                ret += `
                } else`;
            }
            ret += `
                switch (primID) {`;
            for (let prim of this.primitives.filter(p => p.index >= this.untransformed_triangles.length && p.geometryIndex != WebGLGeometriesAdapter.NULL_ID)) {
                ret += `
                    case ${prim.index}:
                        inverseTransform = getTransform(${prim.transformIndex}) * ancestorInvTransform;
                        ${this.adapters.geometries.getMaterialDataShaderSource(prim.geometryIndex, "inverseTransform * rp", "inverseTransform * r.d", "geomatdata")};
                        geomatdata.normal = vec4(normalize((transpose(inverseTransform) * geomatdata.normal).xyz), 0);
                        materialID = ${prim.materialIndex};
                        break;`;
            }
            ret += `
                }
                normal = geomatdata.normal.xyz;
                return colorForMaterial(materialID, rp, r, geomatdata, random_seed, nextRays);
            }`;
        }
        return ret
            + this.adapters.lights.getShaderSource(this.WORLD_EDITABLE)     + "\n"
            + this.adapters.materials.getShaderSource(this.WORLD_EDITABLE)  + "\n"
            + this.adapters.geometries.getShaderSource(this.WORLD_EDITABLE, !this.bvh_only_uses_untransformed_triangles) + "\n";
    }
}

class AbstractWrappedWorldObject {
    constructor(type, object, ancestors, worldadapter) {
        this.type = type;
        this.object = object;
        this.ancestors = ancestors;
        this.worldadapter = worldadapter;
    }
    getBoundingBox() {
        return this.object.getBoundingBox();
    }
    getAncestorTransform() {
        return WebGLWorldAdapter.collapseAncestorTransform(this.ancestors);
    }
    getAncestorInvTransform() {
        return WebGLWorldAdapter.collapseAncestorInvTransform(this.ancestors);
    }
    getTransform() {
        return this.object.getTransform();
    }
    getInvTransform() {
        return this.object.getInvTransform();
    }
    getWorldTransform() {
        return this.getAncestorTransform().times(this.object.getTransform());
    }
    getWorldInvTransform() {
        return this.object.getInvTransform().times(this.getAncestorInvTransform());
    }
    intersect(ray) {
        return this.object.intersect(ray)
    }
    setWorldTransform(new_transform, new_inv_transform) {
        this.worldadapter.setObjectTransform(this, new_transform, new_inv_transform);
    }
}

class WrappedLight extends AbstractWrappedWorldObject {
    constructor(light, worldadapter) {
        super("light", light.light, [], worldadapter);
        Object.assign(this, light);
    }
    intersect(ray) {
        return { object: null, ancestors: [], distance: -Infinity };
    }
    setWorldTransform(new_transform, new_inv_transform) {
        this.worldadapter.adapters.lights.setTransform(this.index, new_transform, new_inv_transform, this.worldadapter.renderer_adapter);
    }
    getMaterialValues() {
        return { color: this.color_mc };
    }
    // A light's transforms, as seen by the editor, are its world transforms (it may be nested in aggregates).
    getTransform()         { return this.instance.getTransform(); }
    getInvTransform()      { return this.instance.getInvTransform(); }
    getWorldTransform()    { return this.instance.getTransform(); }
    getWorldInvTransform() { return this.instance.getInvTransform(); }
    getBoundingBox() {
        const box = this.object.getBoundingBox();
        return this.instance.ancestors.length
            ? box.getBoundingBox(this.instance.getAncestorTransform(), this.instance.getAncestorInvTransform())
            : box;
    }
}

class WrappedAggregate extends AbstractWrappedWorldObject {
    constructor(index, object, ancestors, transformIndex, worldadapter) {
        super("aggregate", object, ancestors, worldadapter);
        this.index = index;
        this.type_code = WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE;
        this.ID = (ancestors && ancestors.length ? ancestors[ancestors.length-1].ID + ":" : "") + object.OBJECT_UID;
        this.transformIndex = transformIndex;
        this.transform = { index: transformIndex, value: worldadapter.transform_store.get(this.transformIndex) };
        
        worldadapter.aggregate_id_index_map[this.ID] = worldadapter.aggregates.length;
        worldadapter.aggregates.push(this);
        
        if (!(object.OBJECT_UID in worldadapter.aggregate_instance_map))
            worldadapter.aggregate_instance_map[object.OBJECT_UID] = [];
        worldadapter.aggregate_instance_map[object.OBJECT_UID].push(this);
        
        this.children = [];
        this.indicesList = [];
        this.immediatePrimitiveChildren = [];
    }
    getObjectCount() {
        return this.indicesList.length;
    }
    getDataVector() {
        if (this.type_code == WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE)
            return [this.type_code, this.transformIndex, this.indicesStartIndex, this.indicesList.length];
        else if (this.type_code == WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE)
            // With debugChildBoxes the BVH's nodes live at a different offset (see buildChildBoxBVHData).
            return [this.type_code, this.transformIndex,
                this.worldadapter.bvh_child_boxes ? this.bvh_tree.childBoxStart : this.bvhStartIndex, this.indicesStartIndex];
        else
            throw "Unsupported aggregate type detected";
    }
    getMutableObjectProperties() {
        return [];
    }
    getMaterialValues() {
        return {};
    }
    isEmpty() {
        return this.immediatePrimitiveChildren.length == 0;
    }
    getStaticShaderSource() {
        if (this.isEmpty())
            return "";
        let ret = `
            bool intersectAggregate_${this.index}(in Ray root_r, in float minT, in float maxT, in bool shadowFlag, inout int primID, inout float min_found_t) {
                bool found_min = false;
                mat4 local_invTransform;
                Ray local_r;
        `;
        
        const prims_by_geometry_type = {};
        for (const prim of this.immediatePrimitiveChildren) {
            if (!(prim.geometryIndex in prims_by_geometry_type))
                prims_by_geometry_type[prim.geometryIndex] = [prim];
            else
                prims_by_geometry_type[prim.geometryIndex].push(prim);
        }
        
        let first_group = true;
        for (const [geometry_type, prims] of Object.entries(prims_by_geometry_type)) {
            // For a shadow ray, an occluder found in an earlier geometry group already blocks the light, so
            // skip the remaining groups entirely rather than searching them for a (irrelevant) closer hit.
            if (!first_group)
                ret += `
                    if (shadowFlag && found_min) return true;`;
            first_group = false;
            if (prims.length == 1) {
                const prim = prims[0];
                if (prim.notTransformable && prim.getInvTransform().is_identity())
                    ret += `
                    local_r = root_r;`;
                else
                    ret += `
                    local_invTransform = getTransform(${prim.transformIndex});
                    local_r = Ray(local_invTransform * root_r.o, local_invTransform * root_r.d);`;
                ret += `
                    if (${!prim.shadowFlag ? "!shadowFlag && " : ""}worldRayCastCompareTime(${this.worldadapter.adapters.geometries.getIntersectShaderSource(prim.geometryIndex, "local_r", "minT")}, minT, maxT, min_found_t)) {
                        primID = ${prim.index};
                        found_min = true;
                    }`;
            }
            else {
                const all_untransformed = prims.all(p => p.getInvTransform().is_identity());
                if (all_untransformed)
                    ret += `
                    local_r = root_r;`;
                const prim_data = prims.map(p => [p.transformIndex, Number(!!p.shadowFlag), p.index]).flat();
                ret += `
                    const int prim_data_${geometry_type}[${prim_data.length}] = int[${prim_data.length}](${prim_data.join(', ')});
                    for (int i = 0; i < min(${prims.length}, uWorldNumPrimitives); ++i) {`;
                if (!all_untransformed)
                    ret += `
                        local_invTransform = getTransform(prim_data_${geometry_type}[3 * i]);
                        local_r = Ray(local_invTransform * root_r.o, local_invTransform * root_r.d);`;
                ret += `
                        if ((bool(prim_data_${geometry_type}[3 * i + 1]) || !shadowFlag) && worldRayCastCompareTime(${this.worldadapter.adapters.geometries.getIntersectShaderSource(geometry_type, "local_r", "minT")}, minT, maxT, min_found_t)) {
                            primID = prim_data_${geometry_type}[3 * i + 2];
                            found_min = true;
                            if (shadowFlag) break;
                        }
                    }`;
            }
        }
        return ret + `
                return found_min;
            }`;
    }
    getIntersectShaderSource(ray_src, minT_src, maxT_src, shadowFlag_src, primID_src, min_found_t_src, ancestorInvTransform_src) {
        return `intersectAggregate_${this.index}(root_r, ${minT_src}, ${maxT_src}, ${shadowFlag_src}, ${primID_src}, ${min_found_t_src})`;
    }
}

class WrappedBVHTree {
    constructor(index, kdtree, worldadapter, webgl_helper) {
        this.kdtree = kdtree;
        this.worldadapter = worldadapter;
        
        this.index = worldadapter.bvh_tree_order.length;
        worldadapter.bvh_tree_order.push(worldadapter.bvh_trees[kdtree.NODE_UID] = this);
        
        this.bvh_nodes = [];
        this.bvh_node_indices = {};
        this.bvh_object_list = [];
        this.primitives = [];
        
        this.BVHVisitorFn(kdtree, webgl_helper);
        this.node_count = this.bvh_nodes.length;

        this.bvhStartIndex = worldadapter.bvh_node_count;
        worldadapter.bvh_node_count += this.bvh_nodes.length;
        
        this.instances = [];
    }
    
    BVHVisitorFn(node, webgl_helper) {
        const node_index = this.bvh_node_indices[node.NODE_UID] = this.bvh_nodes.length;
        const node_data = {
            aabb:   node.aabb,
            isLeaf: node.isLeaf,
        };
        this.bvh_nodes.push(node_data);

        if (!node.isLeaf) {
            this.BVHVisitorFn(node.greater_node, webgl_helper);
            this.BVHVisitorFn(node.lesser_node,  webgl_helper);
            // greater_node is always placed immediately after this node (i.e., at node_index+1), so it needs no
            // explicit storage; lesser_node's index is variable (it comes after greater_node's whole subtree) and
            // must be stored explicitly. Packing it together with the split axis lets the shader pick whichever
            // child the ray reaches first, rather than always descending into greater_node first.
            const lesserIndex = this.bvh_node_indices[node.lesser_node.NODE_UID];
            node_data.hitIndex = (lesserIndex << 2) | node.sep_axis;
        }
        else {
            const primitives = node.objects.map(o => this.worldadapter.visitPrimitive(o, webgl_helper, true));
            node_data.isSingularLeaf = primitives.length == 1;
            // (push, not concat: concat copies the whole list at every leaf, which took ~25 s for the dragon.)
            for (const p of primitives)
                this.primitives.push(p);
            for (let p of primitives) {
                p.notTransformable = true;
                if (p.index >= this.worldadapter.untransformed_triangles.length)
                    this.worldadapter.bvh_only_uses_untransformed_triangles = false;
            }
            if (primitives.length == 1)
                node_data.hitIndex = -1 - primitives[0].index;
            else {
                this.worldadapter.bvh_all_leaves_singular = false;
                node_data.hitIndex = this.bvh_object_list.length;
                this.bvh_object_list.push(primitives.length);
                for (let p of primitives)
                    this.bvh_object_list.push(p.index);
            }
        }
    };
}

class WrappedBVHAggregate extends WrappedAggregate {
    constructor(index, object, bvh_tree, ancestors, transformIndex, worldadapter) {
        super(index, object, ancestors, transformIndex, worldadapter);
        this.type = "BVH";
        this.type_code = WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE;
        
        this.bvhStartIndex = bvh_tree.bvhStartIndex;
        this.bvh_tree = bvh_tree;
        bvh_tree.instances.push(this);
        
        this.children = this.immediatePrimitiveChildren = bvh_tree.primitives;
        this.indicesList = bvh_tree.primitives.map(p => p.index);
        for (let p of bvh_tree.primitives)
            p.parents.push(this);
    }
    getStaticShaderSource() {
        return "";
    }
    getIntersectShaderSource() {
        throw "This shouldn't be called for BVH Aggregates!";
    }
}

class WrappedPrimitive extends AbstractWrappedWorldObject {
    constructor(index, object, transformIndex, geometryIndex, materialIndex, worldadapter) {
        super("primitive", object, [], worldadapter);
        this.ID = object.OBJECT_UID;
        this.index = index;
        this.shadowFlag = object.does_cast_shadow;
        this.transformIndex = transformIndex;
        this.geometryIndex = geometryIndex;
        this.materialIndex = materialIndex;
        this.parents = [];
    }
    getDataVector() {
        return [this.geometryIndex, this.materialIndex, this.transformIndex, WebGLWorldAdapter.primitiveFlags(this.object)];
    }
    toInstance(ancestors) {
        return new WrappedPrimitiveInstance(this, ancestors, this.worldadapter)
    }
}

class WrappedPrimitiveInstance extends AbstractWrappedWorldObject {
    constructor(wrapped_primitive, ancestors, worldadapter) {
        super("wrapped_primitive", wrapped_primitive.object, ancestors, worldadapter);
        Object.assign(this, wrapped_primitive);
        this.ancestors = ancestors;
        this.ID = (ancestors.length ? ancestors[ancestors.length-1].ID + ":" : "") + wrapped_primitive.ID;
    }
    getDataVector() {
        return [this.geometryIndex, this.materialIndex, this.transformIndex, WebGLWorldAdapter.primitiveFlags(this.object)];
    }
    getMaterialValues() {
        return this.worldadapter.adapters.materials.getMaterial(this.materialIndex);
    }
    getMutableObjectProperties() {
        return this.worldadapter.adapters.geometries.getMutableObjectProperties(this.geometryIndex, this.worldadapter.renderer_adapter);
    }
    changeGeometryType(newType) {
        return this.worldadapter.modifyGeometryType(this, newType);
    }
}
