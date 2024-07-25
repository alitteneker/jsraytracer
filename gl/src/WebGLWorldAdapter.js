class WebGLWorldAdapter {
    static WORLD_NODE_AGGREGATE_TYPE = 3;
    static WORLD_NODE_BVH_NODE_TYPE  = 4;
    
    constructor(world, webgl_helper, renderer_adapter) {
        this.renderer_adapter = renderer_adapter;
        
        [this.world_node_texture_unit, this.world_node_texture] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        [this.world_aabb_texture_unit, this.world_aabb_texture] = webgl_helper.createDataTextureAndUnit(4, "FLOAT");
        
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
        this.bvh_first_instances    = {};
        this.bvh_node_count = 0;
        this.bvh_only_uses_untransformed_triangles = true;
        
        this.adapters.lights.reset();
        this.adapters.geometries.reset();
        this.adapters.materials.reset();
    }
    visitWorld(world, webgl_helper, sceneEditable) {
        this.reset();
        this.world = world;
        
        // deal with lights
        // TODO: light geometry should be included in world objects as well, with geometric materials. How should materials be handled?
        for (let light of world.lights)
            this.adapters.lights.visit(light, this.adapters.geometries, this.adapters.materials, webgl_helper);
        
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
                const materialIndex = me.adapters.materials.visit(node.material);
                while (me.untransformed_triangles_by_material.length <= materialIndex)
                    me.untransformed_triangles_by_material.push({ materialIndex: materialIndex, triangles: [] });
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
            for (let t of bin.triangles)
                this.untransformed_triangles.push(this.visitPrimitive(t, webgl_helper));
            bin.maxIndex = bin.triangles.length + count;
            count += bin.triangles.length;
        }
        
        // deal with world objects
        this.visitDescendantObject(new Aggregate(world.objects), webgl_helper);
        
        // finally, we need to determine an order for any list start positions, as traversal order may change
        let indices_count = 0;
        for (const a of this.aggregates) {
            a.indicesStartIndex = indices_count;
            if (a.type == "BVH")
                indices_count += a.bvh_object_list.length;
            else
                indices_count += a.indicesList.length;
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
            const agg = new WrappedBVHAggregate(this.aggregates.length, obj, ancestors,
                this.registerObjectTransform(obj, ancestors), this);
            
            this.aggregate_id_index_map[agg.ID] = this.aggregates.length;
            this.aggregates.push(agg);
            
            if (!(obj.OBJECT_UID in this.aggregate_instance_map))
                this.aggregate_instance_map[obj.OBJECT_UID] = [];
            this.aggregate_instance_map[obj.OBJECT_UID].push(agg);
            
            if (obj.kdtree.NODE_UID in this.bvh_first_instances) {
                agg.bvh_reuse_from = this.bvh_first_instances[obj.kdtree.NODE_UID];
                agg.bvh_nodes = agg.bvh_reuse_from.bvh_nodes;
                agg.indicesList = agg.bvh_reuse_from.indicesList;
                agg.bvh_object_list = agg.bvh_reuse_from.bvh_object_list;
                agg.bvhStartIndex = agg.bvh_reuse_from.bvhStartIndex;
            }
            else {
                const bvh_nodes = [];
                const bvh_node_indices = {};
                const bvh_object_list = [];
                
                const me = this;
                function BVHVisitorFn(node, parent_node=null, isGreater=false) {
                    const node_index = bvh_node_indices[node.NODE_UID] = bvh_nodes.length;
                    const node_data = {
                        raw_node:       node,
                        parent_node:    parent_node,
                        aabb:           node.aabb,
                        isGreater:      isGreater,
                        isLeaf:         node.isLeaf,
                        isSingularLeaf: node.isLeaf && node.objects.length == 1
                    };
                    bvh_nodes.push(node_data);
                    
                    if (!node.isLeaf) {
                        BVHVisitorFn(node.greater_node, node_data, true);
                        BVHVisitorFn(node.lesser_node,  node_data, false);
                        node_data.hitIndex = bvh_node_indices[node.greater_node.NODE_UID];
                    }
                    else {
                        const ps = node.objects.map(o => me.visitPrimitive(o, webgl_helper));
                        for (let p of ps) {
                            p.notTransformable = true;
                            agg.indicesList.push(p.index);
                            if (p.index >= me.untransformed_triangles.length)
                                me.bvh_only_uses_untransformed_triangles = false;
                        }
                        if (ps.length == 1)
                            node_data.hitIndex = -1 - ps[0].index;
                        else {
                            node_data.hitIndex = bvh_object_list.length;
                            bvh_object_list.push(ps.length);
                            for (let p of ps) {
                                p.parents.push(agg);
                                bvh_object_list.push(p.index);
                            }
                        }
                    }
                };
                BVHVisitorFn(obj.kdtree);
                
                for (let node_data of bvh_nodes) {
                    let next_node = node_data;
                    while (next_node && !next_node.isGreater)
                        next_node = next_node.parent_node;
                    node_data.missIndex = next_node ? bvh_node_indices[next_node.parent_node.raw_node.lesser_node.NODE_UID] : -1;
                }
                
                agg.bvh_nodes = bvh_nodes;
                agg.bvh_object_list = bvh_object_list;
                
                agg.bvhStartIndex = this.bvh_node_count;
                this.bvh_node_count += bvh_nodes.length;
                this.bvh_first_instances[obj.kdtree.NODE_UID] = agg;
            }
            
            return agg;
        }
        else if (obj instanceof Aggregate) {
            const agg = new WrappedAggregate(this.aggregates.length, obj, ancestors,
                this.registerObjectTransform(obj, ancestors), this);
            this.aggregate_id_index_map[agg.ID] = this.aggregates.length;
            this.aggregates.push(agg);
            
            if (!(obj.OBJECT_UID in this.aggregate_instance_map))
                this.aggregate_instance_map[obj.OBJECT_UID] = [];
            this.aggregate_instance_map[obj.OBJECT_UID].push(agg);
            
            for (let o of obj.objects)
                agg.children.push(this.visitDescendantObject(o, webgl_helper, ancestors.concat(agg)));
            
            return agg;
        }
        else
            throw "Unsupported object type";
    }
    
    intersectRay(ray, renderer_adapter, gl, program) {
        const intersect = this.world.cast(ray);
        if (!intersect.object)
            return null;
        return new WrappedPrimitiveInstance(this.primitives[this.primitive_id_index_map[intersect.object.OBJECT_UID]],
            intersect.ancestors.map((a,i) => this.aggregates[this.aggregate_id_index_map[this.aggregates[0].object.OBJECT_UID + ":" + intersect.ancestors.slice(0, i+1).map(aa => aa.OBJECT_UID).join(":")]]), this);
    }
    getLights(renderer_adapter, gl, program) {
        return this.adapters.lights.getLights().map(l => new WrappedLight(l, this));
    }
    getSceneTree(renderer_adapter, gl, program) {
        return this.aggregates[0];
    }
    
    registerTransform(transform, object) {
        const transformIndex = this.transform_store.store(transform);
        if (!(transformIndex in this.transform_object_map))
            this.transform_object_map[transformIndex] = [];
        this.transform_object_map[transformIndex].push(object);
        return transformIndex;
    }
    registerObjectTransform(object, ancestors) {
        return this.registerTransform(object.getInvTransform().times(WebGLWorldAdapter.collapseAncestorInvTransform(ancestors)), object);
    }
    updateTransformsRecursive(wrapped_obj) {
        if (wrapped_obj.type == "primitive")
            return;
        
        const set_transform = wrapped_obj.getWorldInvTransform();
        if (this.transform_object_map[wrapped_obj.transformIndex].length > 1) {
            this.transform_object_map[wrapped_obj.transformIndex] = this.transform_object_map[wrapped_obj.transformIndex].filter(o => o !== wrapped_obj.object);
            wrapped_obj.transformIndex = this.registerTransform(set_transform, wrapped_obj.object);
            this.world_node_texture.modifyDataPixel(wrapped_obj.index, wrapped_obj.getDataVector());
        }
        else
            this.transform_store.set(wrapped_obj.transformIndex, set_transform);
        
        for (let child of wrapped_obj.children)
            if (child.type != "primitive")
                this.updateTransformsRecursive(child);
    }
    setObjectTransform(wrapped_obj, new_transform, new_inv_transform) {
        if (wrapped_obj.notTransformable)
            return;
        
        wrapped_obj.object.setTransform(wrapped_obj.getAncestorInvTransform().times(new_transform), new_inv_transform.times(wrapped_obj.getAncestorTransform()));
        
        if (wrapped_obj.type == "primitive") {
            if (this.transform_object_map[wrapped_obj.transformIndex].length > 1) {
                this.transform_object_map[wrapped_obj.transformIndex] = this.transform_object_map[wrapped_obj.transformIndex].filter(o => o !== wrapped_obj.object);
                wrapped_obj.transformIndex = this.registerTransform(wrapped_obj.getInvTransform(), wrapped_obj.object);
                this.world_node_texture.modifyDataPixel(this.aggregates.length + wrapped_obj.index, wrapped_obj.getDataVector());
            }
            else
                this.transform_store.set(wrapped_obj.transformIndex, wrapped_obj.getInvTransform());
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
        
        // TODO: do we need to check whether transforms have expanded beyond the bounds of available memory?
        this.renderer_adapter.useTracerProgram();
        this.renderer_adapter.gl.uniformMatrix4fv(this.renderer_adapter.getUniformLocation("uTransforms"), true, this.transform_store.flat());
        this.renderer_adapter.resetDrawCount();
    }
    modifyMaterialSolidColor(material_color_index, new_color) {
        this.adapters.materials.modifySolidColor(material_color_index, new_color);
    }
    modifyMaterialScalar(material_index, new_scalar) {
        this.adapters.materials.modifyScalar(material_index, new_scalar);
    }
    modifyGeometryType(wrapped_obj, new_type) {
        if (wrapped_obj.type != "primitive")
            throw "Cannot change geometry type for non-primitive object";
        this.primitives[wrapped_obj.index].geometryIndex = wrapped_obj.geometryIndex = new_type;
        wrapped_obj.object.geometry = this.adapters.geometries.geometries[new_type];
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
        const primitive_list = this.primitives.map(o => [o.geometryIndex, o.materialIndex, o.transformIndex, Number(o.object.does_cast_shadow)]).flat();
        let aggregate_list = [], indices_list = [], aabb_data = [];
        for (const a of this.aggregates) {
            if (a.type_code == WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE) {
                aggregate_list.push(a.type_code, a.transformIndex, a.indicesStartIndex, a.indicesList.length);
                indices_list = indices_list.concat(a.indicesList);
            }
            else if (a.type_code == WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE) {
                if (a.bvh_reuse_from)
                    aggregate_list.push(a.type_code, a.transformIndex, a.bvh_reuse_from.bvhStartIndex, a.bvh_reuse_from.indicesStartIndex);
                else {
                    aggregate_list.push(a.type_code, a.transformIndex, a.bvhStartIndex, a.indicesStartIndex);
                    indices_list = indices_list.concat(a.bvh_object_list);
                    aabb_data = aabb_data.concat(a.bvh_nodes.map(n => [
                        ...n.aabb.center.to3(),    (n.isLeaf && !n.isSingularLeaf) ? -1 - (this.primitives.length + n.hitIndex) : n.hitIndex,
                        ...n.aabb.half_size.to3(), n.missIndex]).flat());
                }
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
        this.world_aabb_texture.setDataPixelsUnit(aabb_data.flat(), this.world_aabb_texture_unit, "uWorldAABBs", program);
        
        // let our contained adapters do their own thing too
        this.adapters.lights.writeShaderData(gl, program, webgl_helper);
        this.adapters.materials.writeShaderData(gl, program, webgl_helper);
        this.adapters.geometries.writeShaderData(gl, program, webgl_helper);
    }
    getShaderSourceDeclarations() {
        return `
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag);
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int primID, inout mat4 ancestorInvTransform);
            vec3 worldObjectColor(in int primID, in vec4 rp, in Ray r, in mat4 ancestorInvTransform, inout vec2 random_seed, inout RecursiveNextRays nextRays);
            vec3 worldRayColorShallow(in Ray in_ray, inout vec2 random_seed, inout vec4 intersect_position, inout RecursiveNextRays nextRays);` + "\n"
            + this.adapters.lights.getShaderSourceDeclarations()     + "\n"
            + this.adapters.geometries.getShaderSourceDeclarations() + "\n"
            + this.adapters.materials.getShaderSourceDeclarations()  + "\n";
    }
    getShaderSource(sceneEditable) {
        let ret = `
            uniform vec3 uBackgroundColor;

            uniform mat4 uTransforms[${Math.max(16, this.transform_store.size())}]; // TODO: should safety check the size of this, for larger sizes need a texture
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
            uniform  sampler2D uWorldAABBs;
            

            // ---- Intersection/Color with a single primitive ----
            struct Primitive {
                int geometry_id;
                int material_id;
                int transform_id;
                bool castsShadow;
            };
            Primitive getPrimitive(in int prim_id) {
                ivec4 p = itexelFetchByIndex(prim_id + uWorldNumAggregates, uWorldData);
                return Primitive(p.r, p.g, p.b, bool(p.a));
            }
            float worldObjectIntersect(in int prim_id, in Ray r, in float minDistance, in bool shadowFlag) {
                int geometry_id = 0;
                if (prim_id < uWorldNumUntransformedTriangles)
                    geometry_id = prim_id + GEOMETRY_TRIANGLE_MIN_INDEX;
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
            bool worldRayCastCompareTime(in float t, in float minT, in float maxT, inout float min_found_t) {
                if (t >= minT && t < maxT && (min_found_t < minT || t < min_found_t)) {
                    min_found_t = t;
                    return true;
                }
                return false;
            }
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
            

            
            
            // ---- Generic Intersection with entire world ----
            #define WORLD_NODE_AGGREGATE_TYPE    ${WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE}
            #define WORLD_NODE_BVH_TYPE          ${WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE}
            
            int getIndexFromList(in int index) {
                return itexelFetchByIndex(uWorldListsStart + index / 4, uWorldData)[index % 4];
            }
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
                    if (worldRayCastObject(indexTexel[index % 4], r, minT, maxT, shadowFlag, min_found_t, min_prim_id))
                        found_min = true;
                }
                return found_min;
            }
            
            // ========== BVH ==========`
        if (!sceneEditable && this.bvh_only_uses_untransformed_triangles)
            ret += `
            bool worldRayCastBVHObject(in int prim_id, in Ray r, in float minT, in float maxT, in bool shadowFlag,
                inout float min_found_t, inout int min_prim_id)
            {
                float t = triangleIntersect(r, minT, prim_id);
                if (worldRayCastCompareTime(t, minT, maxT, min_found_t)) {
                    min_prim_id = prim_id;
                    return true;
                }
                return false;
            }
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
                    if (worldRayCastBVHObject(indexTexel[index % 4], r, minT, maxT, shadowFlag, min_found_t, min_prim_id))
                        found_min = true;
                }
                return found_min;
            }`;
        else
            ret += `
            bool worldRayCastBVHObject(in int prim_id, in Ray r, in float minT, in float maxT, in bool shadowFlag,
                inout float min_found_t, inout int min_prim_id)
            {
                return worldRayCastObject(prim_id, r, minT, maxT, shadowFlag, min_found_t, min_prim_id);
            }
            bool worldRayCastBVHList(in int listStartIndex, in int listLength, in Ray r, in float minT, in float maxT, in bool shadowFlag,
                inout float min_found_t, inout int min_prim_id)
            {
                return worldRayCastList(listStartIndex, listLength, r, minT, maxT, shadowFlag, min_found_t, min_prim_id);
            }`;
            
        ret += `
            bool worldRayCastBVH(in int root_index, in int indices_offset, in Ray r, in float minT, in float maxT, in bool shadowFlag, inout float min_found_t, inout int min_prim_id) {
                bool found_min = false;
                
                int node_index = 0;
                while (node_index >= 0) {
                    int aabb_index = 2 * (root_index + node_index);
                    vec4 node1 = texelFetchByIndex(aabb_index,     uWorldAABBs);
                    vec4 node2 = texelFetchByIndex(aabb_index + 1, uWorldAABBs);
                    
                    int hitIndex  = int(node1.w);
                    int missIndex = int(node2.w);
                    
                    vec2 aabb_ts = AABBIntersects(r, vec4(node1.xyz, 1.0), vec4(node2.xyz, 0.0), minT, maxT);
                    bool hit_node = aabb_ts.x <= maxT && aabb_ts.y >= minT && (aabb_ts.x <= min_found_t || min_found_t < minT);
                    
                    if (hit_node) {
                        
                        // if this is a leaf node, check all objects in this node
                        if (hitIndex < 0) {
                            // there are two possibilities: either the id corresponds to a single primitive id, or to a list
                            int id = -hitIndex - 1;
                            
                            // single primitive ids are easy (and should dominate most good BVH constructions), so we just do them directly
                            if (id < uWorldNumPrimitives) {
                                if (worldRayCastBVHObject(id, r, minT, maxT, shadowFlag, min_found_t, min_prim_id))
                                    found_min = true;
                            }
                            
                            // lists are a bit harder: we don't know how long the list is, so we have to first lookup the length before we can test.
                            // Fortunately, these should be a small fraction of BVH nodes, so the cost should be much lower on average.
                            else {
                                int listStart = indices_offset + (id - uWorldNumPrimitives);
                                int listLength = itexelFetchByIndex(uWorldListsStart + listStart / 4, uWorldData)[listStart % 4];
                                if (worldRayCastBVHList(listStart + 1, listLength, r, minT, maxT, shadowFlag, min_found_t, min_prim_id))
                                    found_min = true;
                            }
                        }
                        
                        // if this node has children, visit this node's left child next
                        else if (hitIndex > 0)
                            node_index = hitIndex;
                    }
                    
                    // if we missed this node or this node has NO child nodes (e.g. leaf node),
                    // find the closest ancestor that is a left child, and visit its right sibling next
                    if (!hit_node || hitIndex < 0)
                        node_index = missIndex;
                }
                
                return found_min;
            }
           

            // ---- World Color ----
            vec3 worldRayColorShallow(in Ray in_ray, inout vec2 random_seed, inout vec4 intersect_position, inout RecursiveNextRays nextRays) {
                int primID = -1;
                mat4 ancestorInvTransform = mat4(1.0);
                
                float intersect_time = worldRayCast(in_ray, EPSILON, 1E20, false, primID, ancestorInvTransform);
                if (primID == -1)
                    return uBackgroundColor;
                
                intersect_position = in_ray.o + intersect_time * in_ray.d;
                return worldObjectColor(primID, intersect_position, in_ray, ancestorInvTransform, random_seed, nextRays);
            }
            
            
            // -------- Generic Ray Cast ---------
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag) {
                int primID = -1;
                mat4 ancestorInvTransform = mat4(1.0);
                return worldRayCast(r, minT, maxT, shadowFlag, primID, ancestorInvTransform);
            }`;
        if (sceneEditable) {
            ret += `
            vec3 worldObjectColor(in int primID, in vec4 rp, in Ray r, in mat4 ancestorInvTransform, inout vec2 random_seed, inout RecursiveNextRays nextRays) {
                Primitive ids = getPrimitive(primID);
                mat4 inverseTransform = getTransform(ids.transform_id) * ancestorInvTransform;
                GeometricMaterialData geomatdata = getGeometricMaterialData(ids.geometry_id, inverseTransform * rp, inverseTransform * r.d);
                geomatdata.normal = vec4(normalize((transpose(inverseTransform) * geomatdata.normal).xyz), 0);
                return colorForMaterial(ids.material_id, rp, r, geomatdata, random_seed, nextRays);
            }
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
                }

                return min_found_t;
            }`
        }
        else {
            ret += `
            vec3 worldObjectColor(in int primID, in vec4 rp, in Ray r, in mat4 ancestorInvTransform, inout vec2 random_seed, inout RecursiveNextRays nextRays) {
                int materialID = 0;
                mat4 inverseTransform = mat4(1.0);
                GeometricMaterialData geomatdata;
                geomatdata.baseColor = vec3(1.0);
                if (primID < uWorldNumUntransformedTriangles) {`
            for (let bin of this.untransformed_triangles_by_material) {
                ret += `
                    if (primID <= ${bin.maxIndex}) {
                        triangleMaterialData(rp, geomatdata, primID);
                        materialID = ${bin.materialIndex};
                    }`;
            }
            ret += `
                }
                else { switch (primID) {`;
            for (let prim of this.primitives.filter(p => p.index >= this.untransformed_triangles.length)) {
                ret += `
                    case ${prim.index}:
                        inverseTransform = getTransform(${prim.transformIndex}) * ancestorInvTransform;
                        ${WebGLGeometriesAdapter.getMaterialDataShaderSource(prim.geometryIndex, "inverseTransform * rp", "inverseTransform * r.d", "geomatdata")};
                        geomatdata.normal = vec4(normalize((transpose(inverseTransform) * geomatdata.normal).xyz), 0);
                        materialID = ${prim.materialIndex};
                        break;`;
            }
            ret += `
                }}
                return colorForMaterial(materialID, rp, r, geomatdata, random_seed, nextRays);
            }
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int primID, inout mat4 ancestorInvTransform) {
                float min_found_t = minT - 1.0;
                
                ${this.aggregates.map(agg => agg.getIntersectShaderSource("r", "minT", "maxT", "shadowFlag", "primID", "min_found_t", "ancestorInvTransform")).join("\n")}
                
                return min_found_t;
            }`
        }
        return ret
            + this.adapters.lights.getShaderSource(sceneEditable)     + "\n"
            + this.adapters.materials.getShaderSource(sceneEditable)  + "\n"
            + this.adapters.geometries.getShaderSource(sceneEditable) + "\n";
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
}

class WrappedAggregate extends AbstractWrappedWorldObject {
    static TypeCodeMap = {
        "aggregate": WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE,
        "BVH": WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE
    };
    constructor(index, object, ancestors, transformIndex, worldadapter) {
        super("aggregate", object, ancestors, worldadapter);
        this.type_code = WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE;
        this.ID = (ancestors && ancestors.length ? ancestors[ancestors.length-1].ID + ":" : "") + object.OBJECT_UID;
        this.transformIndex = transformIndex;
        this.transform = { index: transformIndex, value: worldadapter.transform_store.get(this.transformIndex) };
        
        this.children = [];
        this.indicesList = [];
        this.immediatePrimitiveChildren = [];
    }
    getObjectCount() {
        return this.indicesList.length;
    }
    getMutableObjectProperties() {
        return [];
    }
    getMaterialValues() {
        return {};
    }
    getIntersectShaderSource(ray_src, minT_src, maxT_src, shadowFlag_src, primID_src, min_found_t_src, ancestorInvTransform_src) {
        if (this.immediatePrimitiveChildren.length == 0)
            return "";
        let ret = `
                    {
                        mat4 root_invTransform = getTransform(${this.transformIndex}), local_invTransform;
                        Ray root_r = Ray(root_invTransform * ${ray_src}.o, root_invTransform * ${ray_src}.d), local_r;
        `;
        
        for (const prim of this.immediatePrimitiveChildren) {
            if (prim.getInvTransform().is_identity())
                ret += `
                        local_r = root_r;`;
            else
                ret += `
                        local_invTransform = getTransform(${prim.transformIndex});
                        local_r = Ray(local_invTransform * root_r.o, local_invTransform * root_r.d);`;
            ret += `
                        if (${!prim.shadowFlag ? ("!" + shadowFlag_src) + " || " : ""}worldRayCastCompareTime(${WebGLGeometriesAdapter.getIntersectShaderSource(prim.geometryIndex, "local_r", minT_src)}, ${minT_src}, ${maxT_src}, ${min_found_t_src})) {
                            ${primID_src} = ${prim.index};
                            ${ancestorInvTransform_src} = root_invTransform;
                        }`;
        }
        return ret + `
                    }`;
    }
}

class WrappedBVHAggregate extends WrappedAggregate {
    constructor(index, object, ancestors, transformIndex, worldadapter) {
        super(index, object, ancestors, transformIndex, worldadapter);
        this.type = "BVH";
        this.type_code = WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE;
    }
    getIntersectShaderSource(ray_src, minT_src, maxT_src, shadowFlag_src, primID_src, min_found_t_src, ancestorInvTransform_src) {
        return `
                    { 
                        mat4 root_invTransform = getTransform(${this.transformIndex});
                        Ray root_r = Ray(root_invTransform * ${ray_src}.o, root_invTransform * ${ray_src}.d);
                    
                        if (worldRayCastBVH(${this.bvhStartIndex}, ${this.indicesStartIndex}, root_r, ${minT_src}, ${maxT_src}, ${shadowFlag_src}, ${min_found_t_src}, ${primID_src}))
                            ${ancestorInvTransform_src} = root_invTransform;
                    }
        `;
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
        return [this.geometryIndex, this.materialIndex, this.transformIndex, Number(this.object.does_cast_shadow)];
    }
}

class WrappedPrimitiveInstance extends AbstractWrappedWorldObject {
    constructor(wrapped_primitive, ancestors, worldadapter) {
        super("wrapped_primitive", wrapped_primitive.object, ancestors, worldadapter);
        Object.assign(this, wrapped_primitive);
        this.ancestors = ancestors;
        this.ID = (ancestors.length ? ancestors[ancestors.length-1].ID + ":" :
"") + wrapped_primitive.ID;
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
