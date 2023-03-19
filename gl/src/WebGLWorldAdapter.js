class WebGLWorldAdapter {
    static WORLD_NODE_AGGREGATE_TYPE = 3;
    static WORLD_NODE_BVH_NODE_TYPE  = 4;
    
    constructor(world, webgl_helper) {
        [this.world_node_texture_unit, this.world_node_texture] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        [this.world_aabb_texture_unit, this.world_aabb_texture] = webgl_helper.createDataTextureAndUnit(4, "FLOAT");
        
        this.transform_store = new WebGLTransformStore();
        this.adapters = {
            lights:     new WebGLLightsAdapter(webgl_helper),
            materials:  new WebGLMaterialsAdapter(webgl_helper),
            geometries: new WebGLGeometriesAdapter(webgl_helper)
        };

        this.world = world;
        
        this.primitives = [];
        this.aggregates = [];
        this.transform_object_map = {};
        this.primitive_id_index_map = {};
        
        
        // deal with lights
        for (let light of world.lights)
            this.adapters.lights.visit(light, this.adapters.geometries, this.adapters.materials, webgl_helper);
        
        // deal with world objects
        this.visitDescendantObject(new Aggregate(world.objects), webgl_helper);
    }
    destroy(gl) {
        this.world_node_texture.destroy();
        this.world_aabb_texture.destroy();
        
        this.adapters.lights.destroy(gl);
        this.adapters.geometries.destroy(gl);
        this.adapters.materials.destroy(gl);
    }
    visitPrimitive(prim, webgl_helper) {
        if (!(prim instanceof Primitive))
            throw "Cannot call visitPrimitive on non-Primitive";
        
        if (prim.OBJECT_UID in this.primitive_id_index_map)
            return this.primitives[this.primitive_id_index_map[prim.OBJECT_UID]];
        
        const index = this.primitives.length;
        this.primitive_id_index_map[prim.OBJECT_UID] = index;
        
        const wrapped = new WrappedObject({
            ID: index,
            type: "primitive",
            index: index,
            object: prim,
            
            transformIndex: this.registerTransform(prim.getInvTransform(), prim),
            geometryIndex:  this.adapters.geometries.visit(prim.geometry, webgl_helper),
            materialIndex:  this.adapters.materials.visit( prim.material, webgl_helper)
        }, this);
        this.primitives.push(wrapped);
        
        return wrapped;
    }
    collapseAncestorInvTransform(ancestors) {
        let ret = Mat4.identity();
        for (let a of ancestors)
            ret = a.object.getInvTransform().times(ret);
        return ret;
    }
    visitDescendantObject(obj, webgl_helper, ancestors=[]) {
        if (obj instanceof Primitive) {
            const prim = this.visitPrimitive(obj, webgl_helper, ancestors);
            if (ancestors && ancestors.length)
                ancestors[ancestors.length-1].primIndices.push(prim.index);
            return prim;
        }
        else if (obj instanceof BVHAggregate) {
            const agg = new WrappedObject({
                index: this.aggregates.length,
                ID: ancestors.map(a => a.index).join("-") + ":" + this.aggregates.length,
                object: obj,
                type: "BVH ",
                ancestors: ancestors,
                type_code: WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE,
                transformIndex: this.registerTransform(this.collapseAncestorInvTransform(ancestors).times(obj.getInvTransform()), obj),
                children: []
            }, this);
            this.aggregates.push(agg);
            
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
                        agg.children.push(p);
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
            
            return agg;
        }
        else if (obj instanceof Aggregate) {
            const agg = new WrappedObject({
                index: this.aggregates.length,
                ID: ancestors.map(a => a.index).join("-") + ":" + this.aggregates.length,
                object: obj,
                type: "aggregate",
                type_code: WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE,
                ancestors: ancestors,
                transformIndex: this.registerTransform(this.collapseAncestorInvTransform(ancestors).times(obj.getInvTransform()), obj),
                primIndices: [],
                children: []
            }, this);
            this.aggregates.push(agg);
            for (let o of obj.objects)
                agg.children.push(this.visitDescendantObject(o, webgl_helper, ancestors.concat(agg)));
            
            return agg;
        }
        else
            throw "Unsupported object type";
    }
    registerTransform(transform, object) {
        const transformIndex = this.transform_store.store(transform);
        if (!(transformIndex in this.transform_object_map))
            this.transform_object_map[transformIndex] = [];
        this.transform_object_map[transformIndex].push(object);
        return transformIndex;
    }
    
    wrapLight(light, renderer_adapter, gl, program) {
        const me = this;
        return Object.assign({
            material: { value: { color: light.color_mc } },
            getBoundingBox: function() {
                return light.light.getBoundingBox();
            },
            getTransform: function() {
                return light.transform;
            },
            getInvTransform: function() {
                return light.inv_transform;
            },
            intersect(ray) {
                return { object: null, distance: -Infinity }
            },
            setTransform(new_transform, new_inv_transform) {
                me.adapters.lights.setTransform(light.index, new_transform, new_inv_transform, renderer_adapter, gl, program);
            }
        }, light);
    }
    intersectRay(ray, renderer_adapter, gl, program) {
        const intersect = this.world.cast(ray);
        return (!intersect.object) ? null : this.wrapObject(intersect.object, renderer_adapter, gl, program);
    }
    getLights(renderer_adapter, gl, program) {
        return this.adapters.lights.getLights().map(l => this.wrapLight(l, renderer_adapter,  gl, program));
    }
    getLight(index, renderer_adapter,  gl, program) {
        return this.wrapLight(this.adapters.lights.getLight(index), renderer_adapter,  gl, program);
    }
    getSceneTree(renderer_adapter, gl, program) {
        return this.aggregates[0];
    }
    
    setTransform(transform_index, new_transform, new_inv_transform, renderer_adapter, gl, program) {
        gl.useProgram(program);
        for (let object of this.transform_object_map[transform_index])
            object.setTransform(new_transform, new_inv_transform);
        this.transform_store.set(transform_index, new_inv_transform);
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uTransforms"), true, this.transform_store.flat());
        renderer_adapter.resetDrawCount();
    }
    modifyMaterialSolidColor(material_color_index, new_color) {
        this.adapters.materials.modifySolidColor(material_color_index, new_color);
    }
    modifyMaterialScalar(material_index, new_scalar) {
        this.adapters.materials.modifyScalar(material_index, new_scalar);
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
                aggregate_list.push(a.type_code, a.transformIndex, indices_list.length, a.primIndices.length);
                indices_list = indices_list.concat(a.primIndices);
            }
            else if (a.type_code == WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE) {
                aggregate_list.push(a.type_code, a.transformIndex, accelerators_list.length / 4, indices_list.length);
                indices_list = indices_list.concat(a.primIndices);
                accelerators_list = accelerators_list.concat(a.bvh_nodes.map((n, i) => [(aabb_data.length / 4) + 2 * i, n.hitIndex, n.missIndex, n.raw_node.objects.length]).flat());
                aabb_data = aabb_data.concat(a.bvh_nodes.map(n => [...n.raw_node.aabb.center, ...n.aabb.half_size]).flat());
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
    getShaderSource() {
        return `
            uniform vec3 uBackgroundColor;

            uniform mat4 uTransforms[${Math.max(16, this.transform_store.size())}]; // TODO: should safety check the size of this
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
                for (int i = 0; i < listLength; ++i) {
                    int prim_id = getIndexFromList(listStartIndex + i);
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

class WrappedObject {
    constructor(base_data, worldadapter) {
        Object.assign(this, base_data);
        
        this.transform = { index: this.transformIndex, value: worldadapter.transform_store.get(this.transformIndex) };
        if (this.type == "primitive") {
            this.geometry =  { index: this.geometryIndex,   value: worldadapter.adapters.geometries.getGeometry(this.geometryIndex) };
            this.material =  { index: this.materialIndex,   value: worldadapter.adapters.materials.getMaterial(this.materialIndex) };
            this.does_cast_shadow = this.object.does_cast_shadow;
        }
    }
    getBoundingBox() {
        return this.object.getBoundingBox();
    }
    getTransform() {
        return this.object.getTransform();
    }
    getInvTransform() {
        return this.object.getInvTransform();
    }
    intersect(ray) {
        return this.object.intersect(ray)
    }
    setTransform(new_transform, new_inv_transform) {
        // TODO
        //me.setTransform(webgl_ids.transformIndex, new_transform, new_inv_transform, renderer_adapter, gl, program);
    }
}
