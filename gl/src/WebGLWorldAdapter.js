class WebGLWorldAdapter {
    static WORLD_NODE_AGGREGATE_TYPE = 3;
    static WORLD_NODE_BVH_NODE_TYPE  = 4;
    
    constructor(world, webgl_helper, renderer_adapter) {
        this.renderer_adapter = renderer_adapter;
        
        [this.world_node_texture_unit, this.world_node_texture] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        [this.world_aabb_texture_unit, this.world_aabb_texture] = webgl_helper.createDataTextureAndUnit(4, "FLOAT");
        
        this.transform_store = new WebGLTransformStore();
        this.adapters = {
            lights:     new WebGLLightsAdapter(webgl_helper),
            materials:  new WebGLMaterialsAdapter(webgl_helper),
            geometries: new WebGLGeometriesAdapter(webgl_helper)
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
        this.bvh_first_instances    = {};
        
        this.adapters.lights.reset();
        this.adapters.geometries.reset();
        this.adapters.materials.reset();
    }
    visitWorld(world, webgl_helper) {
        this.reset();
        this.world = world;
        
        // deal with lights
        for (let light of world.lights)
            this.adapters.lights.visit(light, this.adapters.geometries, this.adapters.materials, webgl_helper);
        
        // deal with world objects
        this.visitDescendantObject(new Aggregate(world.objects), webgl_helper);
    }
    
    visitPrimitive(prim, webgl_helper) {
        if (!(prim instanceof Primitive))
            throw "Cannot call visitPrimitive on non-Primitive";
        
        if (prim.OBJECT_UID in this.primitive_id_index_map)
            return this.primitives[this.primitive_id_index_map[prim.OBJECT_UID]];
        
        const index = this.primitives.length;
        this.primitive_id_index_map[prim.OBJECT_UID] = index;
        
        const wrapped = {
            ID: prim.OBJECT_UID,
            type: "primitive",
            index: index,
            object: prim,
            parents: [],
            
            transformIndex: this.registerTransform(prim.getInvTransform(), prim),
            geometryIndex:  this.adapters.geometries.visit(prim.geometry, webgl_helper),
            materialIndex:  this.adapters.materials.visit( prim.material, webgl_helper)
        };
        this.primitives.push(wrapped);
        
        return wrapped;
    }
    visitDescendantObject(obj, webgl_helper, ancestors=[]) {
        if (obj instanceof Primitive) {
            const prim = this.visitPrimitive(obj, webgl_helper, ancestors);
            if (ancestors && ancestors.length) {
                ancestors[ancestors.length-1].primIndices.push(prim.index);
                prim.parents.push(ancestors[ancestors.length-1]);
            }
            return prim;
        }
        else if (obj instanceof BVHAggregate) {
            const ID = (ancestors && ancestors.length ? ancestors[ancestors.length-1].ID + ":" : "") + obj.OBJECT_UID;
            const agg = new WrappedAggregate({
                index: this.aggregates.length,
                ID: ID,
                object: obj,
                type: "BVH ",
                ancestors: ancestors,
                type_code: WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE,
                transformIndex: this.registerTransform(obj.getInvTransform().times(WebGLWorldAdapter.collapseAncestorInvTransform(ancestors)), obj),
                children: []
            }, this);
            
            this.aggregate_id_index_map[ID] = this.aggregates.length;
            if (!(obj.OBJECT_UID in this.aggregate_instance_map))
                this.aggregate_instance_map[obj.OBJECT_UID] = [];
            this.aggregate_instance_map[obj.OBJECT_UID].push(agg);
            this.aggregates.push(agg);
            
            if (obj.kdtree.NODE_UID in this.bvh_first_instances) {
                agg.bvh_reuse_from = this.bvh_first_instances[obj.kdtree.NODE_UID];
                agg.bvh_nodes = agg.bvh_reuse_from.bvh_nodes;
                agg.primIndices = agg.bvh_reuse_from.primIndices;
            }
            else {
                const bvh_nodes = [];
                const bvh_node_indices = {};
                const bvh_object_list = [];
                
                const me = this;
                function BVHVisitorFn(node, parent_node=null, isGreater=false) {
                    const node_index = bvh_node_indices[node.NODE_UID] = bvh_nodes.length;
                    const node_data = {
                        raw_node:    node,
                        parent_node: parent_node,
                        aabb:        node.aabb,
                        isGreater:   isGreater,
                    };
                    bvh_nodes.push(node_data);
                    
                    if (!node.isLeaf) {
                        BVHVisitorFn(node.greater_node, node_data, true);
                        BVHVisitorFn(node.lesser_node,  node_data, false);
                        node_data.hitIndex = bvh_node_indices[node.greater_node.NODE_UID];
                    }
                    else {
                        node_data.hitIndex = -1 - bvh_object_list.length;
                        for (let o of node.objects) {
                            const p = me.visitPrimitive(o, webgl_helper);
                            p.notTransformable = true;
                            //agg.children.push(p);
                            p.parents.push(agg);
                            bvh_object_list.push(p.index);
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
                agg.primIndices = bvh_object_list;
                
                this.bvh_first_instances[obj.kdtree.NODE_UID] = agg;
            }
            
            return agg;
        }
        else if (obj instanceof Aggregate) {
            const ID = (ancestors && ancestors.length ? ancestors[ancestors.length-1].ID + ":" : "") + obj.OBJECT_UID;
            const agg = new WrappedAggregate({
                index: this.aggregates.length,
                ID: ID,
                object: obj,
                type: "aggregate",
                type_code: WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE,
                ancestors: ancestors,
                transformIndex: this.registerTransform(obj.getInvTransform().times(WebGLWorldAdapter.collapseAncestorInvTransform(ancestors)), obj),
                primIndices: [],
                children: []
            }, this);
            this.aggregate_id_index_map[ID] = this.aggregates.length;
            if (!(obj.OBJECT_UID in this.aggregate_instance_map))
                this.aggregate_instance_map[obj.OBJECT_UID] = [];
            this.aggregate_instance_map[obj.OBJECT_UID].push(agg);
            this.aggregates.push(agg);
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
        return new WrappedPrimitive(this.primitives[this.primitive_id_index_map[intersect.object.OBJECT_UID]],
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
                
        const primitive_list = this.primitives.map(o => [o.geometryIndex, o.materialIndex, o.transformIndex, Number(o.object.does_cast_shadow)]).flat();
        let aggregate_list = [], accelerators_list = [], indices_list = [], aabb_data = [];
        for (const a of this.aggregates) {
            if (a.type_code == WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE) {
                aggregate_list.push(a.type_code, a.transformIndex, a.indicesStartIndex = indices_list.length, a.primIndices.length);
                indices_list = indices_list.concat(a.primIndices);
            }
            else if (a.type_code == WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE) {
                if (a.bvh_reuse_from)
                    aggregate_list.push(a.type_code, a.transformIndex, a.bvh_reuse_from.acceleratorsStartIndex, a.bvh_reuse_from.indicesStartIndex);
                else {
                    aggregate_list.push(a.type_code, a.transformIndex, a.acceleratorsStartIndex = accelerators_list.length / 4, a.indicesStartIndex = indices_list.length);
                    indices_list = indices_list.concat(a.primIndices);
                    accelerators_list = accelerators_list.concat(a.bvh_nodes.map((n, i) => [(aabb_data.length / 4) + 2 * i, n.hitIndex, n.missIndex, n.raw_node.isLeaf ? n.raw_node.objects.length : 0]).flat());
                    aabb_data = aabb_data.concat(a.bvh_nodes.map(n => [...n.raw_node.aabb.center, ...n.aabb.half_size]).flat());
                }
            }
            else
                throw "Unsupported aggregate type detected";
        }
        
        // Write world node data
        gl.uniform1i(gl.getUniformLocation(program, "uWorldNumAggregates"), this.aggregates.length);
        gl.uniform1i(gl.getUniformLocation(program, "uWorldAcceleratorsStart"), this.aggregates.length + this.primitives.length);
        gl.uniform1i(gl.getUniformLocation(program, "uWorldListsStart"), this.aggregates.length + this.primitives.length + accelerators_list.length / 4);
        this.world_node_texture.setDataPixelsUnit([...aggregate_list, ...primitive_list, ...accelerators_list, ...indices_list],
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
            vec3 worldRayColorShallow(in Ray in_ray, inout vec2 random_seed, inout vec4 intersect_position, inout RecursiveNextRays nextRays);` + "\n"
            + this.adapters.lights.getShaderSourceDeclarations()     + "\n"
            + this.adapters.geometries.getShaderSourceDeclarations() + "\n"
            + this.adapters.materials.getShaderSourceDeclarations()  + "\n";
    }
    getShaderSource(sceneEditable) {
        return `
            uniform vec3 uBackgroundColor;

            uniform mat4 uTransforms[${Math.max(16, this.transform_store.size())}]; // TODO: should safety check the size of this, for larger sizes need a texture
            mat4 getTransform(in int index) {
                if (index < 0)
                    return mat4(1.0);
                return uTransforms[index];
            }
            
            uniform int uWorldListsStart;
            uniform int uWorldAcceleratorsStart;
            uniform int uWorldNumAggregates;
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
                Primitive obj = getPrimitive(prim_id);
                if (shadowFlag && !obj.castsShadow)
                    return minDistance - 1.0;
                mat4 objectInverseTransform = getTransform(obj.transform_id);
                return geometryIntersect(obj.geometry_id, Ray(objectInverseTransform * r.o, objectInverseTransform * r.d), minDistance);
            }
            vec3 worldObjectColor(in int primID, in vec4 rp, in Ray r, in mat4 ancestorInvTransform, inout vec2 random_seed, inout RecursiveNextRays nextRays) {
                Primitive ids = getPrimitive(primID);
                mat4 inverseTransform = getTransform(ids.transform_id) * ancestorInvTransform;
                GeometricMaterialData geomatdata = getGeometricMaterialData(ids.geometry_id, inverseTransform * rp, inverseTransform * r.d);
                geomatdata.normal = vec4(normalize((transpose(inverseTransform) * geomatdata.normal).xyz), 0);
                return colorForMaterial(ids.material_id, rp, r, geomatdata, random_seed, nextRays);
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
                    int prim_id = indexTexel[index % 4];
                    float t = worldObjectIntersect(prim_id, r, minT, shadowFlag);
                    if (t >= minT && t < maxT && (min_found_t < minT || t < min_found_t)) {
                        min_found_t = t;
                        min_prim_id = prim_id;
                        found_min = true;
                    }
                }
                return found_min;
            }
            bool worldRayCastBVH(in int root_index, in int indices_offset, in Ray r, in float minT, in float maxT, in bool shadowFlag, inout float min_found_t, inout int min_prim_id) {
                bool found_min = false;
                
                int node_index = 0;
                while (node_index >= 0) {
                    
                    // aabb_index, hitIndex (>0 for children, <0 for leaf indices list start), missIndex, indices_length
                    ivec4 node = itexelFetchByIndex(uWorldAcceleratorsStart + root_index + node_index, uWorldData);
                    
                    vec2 aabb_ts = AABBIntersects(r,
                        texelFetchByIndex(node.r,     uWorldAABBs),
                        texelFetchByIndex(node.r + 1, uWorldAABBs), minT, maxT);
                    
                    bool hit_node = aabb_ts.x <= maxT && aabb_ts.y >= minT && (aabb_ts.x <= min_found_t || min_found_t < minT);
                    if (hit_node) {
                        
                        // if this is a leaf node, check all objects in this node
                        if (node.g < 0) {
                            if (worldRayCastList(indices_offset - node.g - 1, node.a, r, minT, maxT, shadowFlag, min_found_t, min_prim_id))
                               found_min = true;
                        }
                        
                        // if this node has children, visit this node's left child next
                        else if (node.g > 0)
                            node_index = node.g;
                    }
                    
                    // if we missed this node or this node has NO children, find the closest ancestor that is a left child, and visit its right sibling next
                    if (!hit_node || node.g < 0)
                        node_index = node.b;
                }
                
                return found_min;
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
            }
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag) {
                int primID = -1;
                mat4 ancestorInvTransform = mat4(1.0);
                return worldRayCast(r, minT, maxT, shadowFlag, primID, ancestorInvTransform);
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
            }`
            + this.adapters.lights.getShaderSource()     + "\n"
            + this.adapters.materials.getShaderSource()  + "\n"
            + this.adapters.geometries.getShaderSource() + "\n";
    }
}

class AbstractWrappedObject {
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

class WrappedLight extends AbstractWrappedObject {
    constructor(light, worldadapter) {
        super();
        Object.assign(this, light);
        
        this.object = light.light;
        this.ancestors = [];
        this.worldadapter = worldadapter;
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

class WrappedAggregate extends AbstractWrappedObject {
    constructor(base_data, worldadapter) {
        super();
        Object.assign(this, base_data);
        this.worldadapter = worldadapter;
        this.transform = { index: this.transformIndex, value: worldadapter.transform_store.get(this.transformIndex) };
    }
    getDataVector() {
        if (this.type_code == WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE)
            return [this.type_code, this.transformIndex, this.acceleratorsStartIndex, this.indicesStartIndex];
        else
            return [this.type_code, this.transformIndex, this.indicesStartIndex, this.primIndices.length];
    }
    getMutableObjectProperties() {
        return [];
    }
    getMaterialValues() {
        return {};
    }
}

class WrappedPrimitive extends AbstractWrappedObject {
    constructor(base_data, ancestors, worldadapter) {
        super();
        Object.assign(this, base_data);
        
        this.ID = (ancestors.length ? ancestors[ancestors.length-1].ID + ":" : "") + base_data.ID;
        this.worldadapter = worldadapter;
        this.ancestors = ancestors;
    }
    getDataVector() {
        return [this.geometryIndex, this.materialIndex, this.transformIndex, Number(this.object.does_cast_shadow)];
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
