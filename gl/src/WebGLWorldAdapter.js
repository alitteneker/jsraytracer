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
    visitPrimitive(prim, webgl_helper, ancestors) {
        if (!(prim instanceof Primitive))
            throw "Cannot call visitPrimitive on non-Primitive";
        
        if (prim.OBJECT_UID in this.primitive_id_index_map) {
            const index = this.primitive_id_index_map[prim.OBJECT_UID];
            if (ancestors && ancestors.length)
                ancestors[ancestors.length-1].indices.push(index);
            return index;
        }
        
        const index = this.primitives.length;
        this.primitive_id_index_map[prim.OBJECT_UID] = index;
        
        this.primitives.push({
            index: index,
            object: prim,
            
            transformID: this.registerTransform(prim.getInvTransform(), prim),
            geometryID:  this.adapters.geometries.visit(prim.geometry, webgl_helper),
            materialID:  this.adapters.materials.visit( prim.material, webgl_helper),
            does_cast_shadow:  prim.does_cast_shadow
        });
        if (ancestors && ancestors.length)
            ancestors[ancestors.length-1].indices.push(index);
        
        return index;
    }
    collapseAncestorInvTransform(ancestors) {
        let ret = Mat4.identity();
        for (let a of ancestors)
            ret = a.object.getInvTransform().times(ret);
        return ret;
    }
    visitDescendantObject(obj, webgl_helper, ancestors=[]) {
        if (obj instanceof Primitive)
            this.visitPrimitive(obj, webgl_helper, ancestors);
        else if (obj instanceof BVHAggregate) {
            const agg = {
                index: this.aggregates.length,
                object: obj,
                type_code: WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE,
                transformID: this.registerTransform(this.collapseAncestorInvTransform(ancestors).times(obj.getInvTransform()), obj),
            };
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
                    bvh_object_list.push(...node.objects.map(o => me.visitPrimitive(o, webgl_helper)));
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
            agg.indices = bvh_object_list;
        }
        else if (obj instanceof Aggregate) {
            const agg = {
                index: this.aggregates.length,
                object: obj,
                type_code: WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE,
                ancestors: ancestors,
                transformID: this.registerTransform(this.collapseAncestorInvTransform(ancestors).times(obj.getInvTransform()), obj),
                indices: []
            };
            this.aggregates.push(agg);
            for (let o of obj.objects)
                this.visitDescendantObject(o, webgl_helper, ancestors.concat(agg));
        }
        else
            throw "Unsupported object type";
    }
    registerTransform(transform, object) {
        const transformID = this.transform_store.store(transform);
        if (!(transformID in this.transform_object_map))
            this.transform_object_map[transformID] = [];
        this.transform_object_map[transformID].push(object);
        return transformID;
    }
    destroy(gl) {
        this.world_node_texture.destroy();
        this.world_aabb_texture.destroy();
        
        this.adapters.lights.destroy(gl);
        this.adapters.geometries.destroy(gl);
        this.adapters.materials.destroy(gl);
    }
    
    wrapObject(object, renderer_adapter, gl, program) {
        if (!object)
            return null;
        
        const me = this;
        const index = this.primitive_id_index_map[object.OBJECT_UID];
        if (!index)
            return null;
        const webgl_ids = this.primitives[index];
        
        return {
            worldtype: "object",
            index: index,
            
            transform: { index: webgl_ids.transformID, value: this.transform_store.get(webgl_ids.transformID) },
            geometry:  { index: webgl_ids.geometryID,  value: this.adapters.geometries.getGeometry(webgl_ids.geometryID) },
            material:  { index: webgl_ids.materialID,  value: this.adapters.materials.getMaterial(webgl_ids.materialID) },
            does_cast_shadow: webgl_ids.does_cast_shadow,
            
            getBoundingBox: function() {
                return object.getBoundingBox();
            },
            getTransform: function() {
                return object.transform;
            },
            getInvTransform: function() {
                return object.inv_transform;
            },
            intersect(ray) {
                return object.intersect(ray)
            },
            setTransform(new_transform, new_inv_transform) {
                me.setTransform(webgl_ids.transformID, new_transform, new_inv_transform, renderer_adapter, gl, program);
            }
        };
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
    getObjects(renderer_adapter, gl, program) {
        return this.world.objects.map(o => this.wrapObject(o, renderer_adapter, gl, program));
    }
    getObject(index, renderer_adapter, gl, program) {
        return this.wrapObject(this.world.objects[index], renderer_adapter, gl, program);
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
                
        const primitive_list = this.primitives.map(o => [o.geometryID, o.materialID, o.transformID, Number(o.does_cast_shadow)]).flat();
        const aggregate_list = [], accelerators_list = [], indices_list = [], aabb_data = [];
        for (const a of this.aggregates) {
            if (a.type_code == WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE) {
                aggregate_list.push(a.type_code, a.transformID, indices_list.length, a.indices.length);
                indices_list.push(...a.indices);
            }
            else if (a.type_code == WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE) {
                aggregate_list.push(a.type_code, a.transformID, accelerators_list.length, indices_list.length);
                accelerators_list.push(...a.bvh_nodes.map((n, i) => [aabb_data.length + 2 * i, n.hitIndex, n.missIndex, n.raw_node.objects.length]).flat());
                indices_list.push(...a.indices);
                aabb_data.push(...a.bvh_nodes.map(n => [n.raw_node.aabb.center, ...n.aabb.half_size]).flat());
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
            + this.adapters.lights.getShaderSourceDeclarations() + "\n"
            + this.adapters.geometries.getShaderSourceDeclarations() + "\n"
            + this.adapters.materials.getShaderSourceDeclarations() + "\n";
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
                for (int i = listStartIndex; i < listLength; ++i) {
                    int prim_id = getIndexFromList(i);
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
                
                int count = 0;
                
                int node_index = 0;
                while (node_index >= 0) {
                    if (count++ > 0)
                        break;
                    
                    // aabb_index, hitIndex (>0 for children, <0 for leaf indices list start), missIndex, indices_length
                    ivec4 node = itexelFetchByIndex(uWorldAcceleratorsStart + root_index + node_index, uWorldData);
                    
                    vec2 aabb_ts = AABBIntersects(r,
                        texelFetchByIndex(node.r,     uWorldAABBs),
                        texelFetchByIndex(node.r + 1, uWorldAABBs), minT, maxT);
                    
                    bool hit_node = aabb_ts.x <= maxT && aabb_ts.y >= minT && (aabb_ts.x <= min_found_t || min_found_t < minT);
                    if (hit_node) {
                        // check if this is a leaf node, check all objects in this node
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
                    
                    switch (nodeData.r) {
                    case WORLD_NODE_AGGREGATE_TYPE:
                        if (worldRayCastList(nodeData.b, nodeData.a, local_r, minT, maxT, shadowFlag, min_found_t, primID))
                            ancestorInvTransform = root_invTransform;
                        break;
                    case WORLD_NODE_BVH_TYPE:
                        if (worldRayCastBVH(nodeData.b, nodeData.a, local_r, minT, maxT, shadowFlag, min_found_t, primID))
                            ancestorInvTransform = root_invTransform;
                        break;
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
            + this.adapters.lights.getShaderSource()
            + this.adapters.materials.getShaderSource()
            + this.adapters.geometries.getShaderSource();
    }
}