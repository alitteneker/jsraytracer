class WebGLWorldAdapter {
    static WORLD_NODE_TRANSFORMED_NODE_TYPE = 2;
    static WORLD_NODE_AGGREGATE_TYPE        = 3;
    static WORLD_NODE_BVH_NODE_TYPE         = 4;
    
    
    constructor(world, webgl_helper) {
        [this.world_node_texture_unit, this.world_node_texture] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        [this.world_aabb_texture_unit, this.world_aabb_texture] = webgl_helper.createDataTextureAndUnit(4, "FLOAT");
        
        this.transform_store = new WebGLTransformStore();
        this.adapters = {
            lights:     new WebGLLightsAdapter(webgl_helper),
            materials:  new WebGLMaterialsAdapter(webgl_helper),
            geometries: new WebGLGeometriesAdapter(webgl_helper)
        };
        
        this.max_node_depth = 1;
        this.world_nodes = [];
        this.world_aabbs = [];
        this.object_aggregates_index_list = [];
        this.transform_object_map = {};
        this.object_id_index_map = {};
        this.BVH_node_id_index_map = {};

        this.world = world;
        
        
        // deal with lights
        for (let light of world.lights)
            this.adapters.lights.visit(light, this.adapters.geometries, this.adapters.materials, webgl_helper);
        
        // deal with world objects
        this.visitWorldObject(new Aggregate(world.objects), webgl_helper, 0);
        //this.visitWorldObject(world.objects[0], webgl_helper, 0);
    }
    visitWorldObject(object, webgl_helper, depth, isUnderBVH=false) {
        this.max_node_depth = Math.max(depth, this.max_node_depth);
        
        if (object.OBJECT_UID in this.object_id_index_map)
            return this.object_id_index_map[object.OBJECT_UID];

        const index = this.object_id_index_map[object.OBJECT_UID] = this.world_nodes.length;
        const world_node = {
            index:       index,
            object:      object,
            transformID: this.registerTransform(object.getInvTransform(), object)
        }
        this.world_nodes.push(world_node);
        
        if (object instanceof Primitive) {
            Object.assign(world_node, {
                type:              "primitive",
                geometryID:        this.adapters.geometries.visit(object.geometry, webgl_helper),
                materialID:        this.adapters.materials.visit( object.material, webgl_helper),
                does_cast_shadow:  object.does_cast_shadow
            });
            world_node.node_vec = [Number(world_node.does_cast_shadow), world_node.geometryID, world_node.materialID, world_node.transformID];
        }
        else if (object instanceof TransformedWorldObject) {
            Object.assign(world_node, {
                type:    "transformed_object",
                childID: this.visitWorldObject(object.object, webgl_helper, depth+1, isUnderBVH)
            });
            world_node.node_vec = [WebGLWorldAdapter.WORLD_NODE_TRANSFORMED_NODE_TYPE, world_node.transformID, world_node.childID, 0];
        }
        else if (object instanceof BVHAggregate) {
            Object.assign(world_node, {
                type:    "BVH_aggregate",
                childID: this.visitBVHAggregateNode(object.kdtree, webgl_helper, depth+1)
            });
            world_node.node_vec = [WebGLWorldAdapter.WORLD_NODE_TRANSFORMED_NODE_TYPE, world_node.transformID, world_node.childID, 0];
        }
        else if (object instanceof Aggregate) {
            Object.assign(world_node, {
                type:           "aggregate",
                nodeListStart:  this.object_aggregates_index_list.length,
                nodeListLength: object.objects.length
            });
            world_node.node_vec = [WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE, world_node.transformID, world_node.nodeListStart, world_node.nodeListLength];
            
            this.object_aggregates_index_list.push(...object.objects.map(o => null));
            for (let [i, o] of object.objects.entries())
                this.object_aggregates_index_list[i + world_node.nodeListStart] = this.visitWorldObject(o, webgl_helper, depth+1, isUnderBVH);
        }
        
        return index;
    }
    visitBVHAggregateNode(node, webgl_helper, depth) {
        this.max_node_depth = Math.max(depth, this.max_node_depth);
        
        if (node.NODE_UID in this.BVH_node_id_index_map)
            return this.BVH_node_id_index_map[node.NODE_UID];
        
        this.BVH_node_id_index_map[node.NODE_UID] = this.world_nodes.length;
        const world_node = {
            type:       "bvh_node",
            bvh_node:   node,
            index:      this.world_nodes.length,
            aabb_index: this.world_aabbs.length
        };
        this.world_nodes.push(world_node);
        this.world_aabbs.push(node.aabb);
        
        if (node.isLeaf) {
            world_node.nodeListStart = this.object_aggregates_index_list.length;
            world_node.nodeListLength = node.objects.length;
            this.object_aggregates_index_list.push(...node.objects.map(o => null));
            for (let [i, o] of node.objects.entries())
                this.object_aggregates_index_list[i + world_node.nodeListStart] = this.visitWorldObject(o, webgl_helper, depth+1, true);
            world_node.node_vec = [WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE, -1 - world_node.nodeListStart, world_node.nodeListLength, world_node.aabb_index];
        }
        else {
            world_node.greater_index = this.visitBVHAggregateNode(node.greater_node, webgl_helper, depth+1);
            world_node.lesser_index  = this.visitBVHAggregateNode(node.lesser_node,  webgl_helper, depth+1);
            world_node.node_vec = [WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE, world_node.greater_index, world_node.lesser_index, world_node.aabb_index];
        }
        
        return this.BVH_node_id_index_map[node.NODE_UID];
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
        const index = this.object_id_index_map[object.OBJECT_UID];
        if (!index)
            return null;
        const webgl_ids = this.world_nodes[index];
        
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
        
        // Write world node data
        gl.uniform1i(gl.getUniformLocation(program, "uNumWorldGraphNodes"), this.world_nodes.length);
        this.world_node_texture.setDataPixelsUnit(
            this.world_nodes.map(n => n.node_vec).flat().concat(this.object_aggregates_index_list),
            this.world_node_texture_unit, "uWorldObjectGraph", program);
            
        this.world_aabb_texture.setDataPixelsUnit(
            this.world_aabbs.map(aabb => [...aabb.center, ...aabb.half_size]).flat(),
            this.world_aabb_texture_unit, "uWorldAABBs", program);
        
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
            
            
            uniform int uNumWorldGraphNodes;
            uniform isampler2D uWorldObjectGraph;
            uniform  sampler2D uWorldAABBs;
            
            

            // ---- Intersection/Color with a single primitive ----
            struct Primitive {
                int geometry_id;
                int material_id;
                int transform_id;
                bool castsShadow;
            };
            Primitive getPrimitive(in int prim_id) {
                ivec4 p = itexelFetchByIndex(prim_id, uWorldObjectGraph);
                return Primitive(p.g, p.b, p.a, bool(p.r));
            }
            float worldObjectIntersect(in Primitive obj, in Ray r, in mat4 ancestorInvTransform, in float minDistance, in bool shadowFlag) {
                if (shadowFlag && !obj.castsShadow)
                    return minDistance - 1.0;
                mat4 objectInverseTransform = getTransform(obj.transform_id) * ancestorInvTransform;
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
            #define WORLD_NODE_TRANSFORMED_NODE_TYPE  ${WebGLWorldAdapter.WORLD_NODE_TRANSFORMED_NODE_TYPE}
            #define WORLD_NODE_AGGREGATE_TYPE         ${WebGLWorldAdapter.WORLD_NODE_AGGREGATE_TYPE}
            #define WORLD_NODE_BVH_NODE_TYPE          ${WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE}
            
            int getWorldNodeIDFromList(in int index) {
                return itexelFetchByIndex(uNumWorldGraphNodes + (index / 4), uWorldObjectGraph)[index % 4];
            }
            
            #define WORLD_MAX_SCENE_GRAPH_DEPTH ${Math.max(10, this.max_node_depth+1)}
            
            struct WorldNodeTraversal {
                int index;
                ivec4 nodeData;
                mat4 ancestorInvTransform;
                int nextChildIndex;
            };
            WorldNodeTraversal getWorldNodeTraversal(int index, in mat4 ancestorInvTransform) {
                return WorldNodeTraversal(index, itexelFetchByIndex(index, uWorldObjectGraph), ancestorInvTransform, 0);
            }
            void worldTraverseGraphChild(inout WorldNodeTraversal childTraversal, inout WorldNodeTraversal parentTraversal, in int nextNodeIndex, inout int nodeDepth) {
                childTraversal = getWorldNodeTraversal(nextNodeIndex, parentTraversal.ancestorInvTransform);
                ++parentTraversal.nextChildIndex;
                ++nodeDepth;
            }
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout mat4 ancestorInvTransform, inout int primID) {
                float min_found_t = minT - 1.0;
                
                WorldNodeTraversal nodeTraversalStack[WORLD_MAX_SCENE_GRAPH_DEPTH];
                nodeTraversalStack[0] = getWorldNodeTraversal(0, ancestorInvTransform);
                int nodeDepth = 0;
                
                int count = 0;
                while (nodeDepth >= 0) {
                    ++count;
                    // if (count > 1000)
                        // break;
                    if (nodeDepth > 20)
                        break;
                    
                    ivec4 node = nodeTraversalStack[nodeDepth].nodeData;
                    
                    if (node[0] < 2) {             // primitive
                        float t = worldObjectIntersect(Primitive(node[1], node[2], node[3], bool(node[0])), r, nodeTraversalStack[nodeDepth].ancestorInvTransform, minT, shadowFlag);
                        if (t >= minT && t < maxT && (min_found_t < minT || t < min_found_t)) {
                            min_found_t = t;
                            primID = nodeTraversalStack[nodeDepth].index;
                            ancestorInvTransform = nodeTraversalStack[nodeDepth].ancestorInvTransform;
                        }
                        --nodeDepth;
                        continue;
                    }
                    else if (node[0] == WORLD_NODE_AGGREGATE_TYPE) {   // agregate
                        if (nodeTraversalStack[nodeDepth].nextChildIndex < node[3]) {
                            if (nodeTraversalStack[nodeDepth].nextChildIndex == 0)
                                nodeTraversalStack[nodeDepth].ancestorInvTransform = nodeTraversalStack[nodeDepth].ancestorInvTransform * getTransform(node[1]);
                            int nextNodeIndex = getWorldNodeIDFromList(node[2] + nodeTraversalStack[nodeDepth].nextChildIndex);
                            worldTraverseGraphChild(nodeTraversalStack[nodeDepth+1], nodeTraversalStack[nodeDepth], nextNodeIndex, nodeDepth);
                        }
                        else
                            --nodeDepth;
                        continue;
                    }
                    else if (node[0] == WORLD_NODE_TRANSFORMED_NODE_TYPE
                        && nodeTraversalStack[nodeDepth].nextChildIndex == 0)
                    {
                        nodeTraversalStack[nodeDepth].ancestorInvTransform = nodeTraversalStack[nodeDepth].ancestorInvTransform * getTransform(node[1]);
                        worldTraverseGraphChild(nodeTraversalStack[nodeDepth+1], nodeTraversalStack[nodeDepth], node[2], nodeDepth);
                        continue;
                    }
                    else if (node[0] == WORLD_NODE_BVH_NODE_TYPE) {   // bvh node
                        if (nodeTraversalStack[nodeDepth].nextChildIndex == 0) {
                            vec4 AABB_center   = texelFetchByIndex(node[3] * 2,     uWorldAABBs);
                            vec4 AABB_halfsize = texelFetchByIndex(node[3] * 2 + 1, uWorldAABBs);
                            vec2 aabb_ts = AABBIntersects(r, AABB_center, AABB_halfsize, minT, maxT);
                            if (!(aabb_ts.x <= maxT && aabb_ts.y >= minT && (aabb_ts.x <= min_found_t || min_found_t < minT))) {
                                --nodeDepth;
                                continue;
                            }
                        }
                        if (node[1] < 0 && nodeTraversalStack[nodeDepth].nextChildIndex < node[2]) {                // leaf node
                            int nextNodeIndex = getWorldNodeIDFromList(-1 - node[1] + nodeTraversalStack[nodeDepth].nextChildIndex);
                            worldTraverseGraphChild(nodeTraversalStack[nodeDepth+1], nodeTraversalStack[nodeDepth], nextNodeIndex, nodeDepth);
                            continue;
                        }
                        else if (node[1] >= 0 && nodeTraversalStack[nodeDepth].nextChildIndex < 2) {                // node has children
                            int nextNodeIndex = (nodeTraversalStack[nodeDepth].nextChildIndex == 0) ? node[1] : node[2];
                            worldTraverseGraphChild(nodeTraversalStack[nodeDepth+1], nodeTraversalStack[nodeDepth], nextNodeIndex, nodeDepth);
                            continue;
                        }
                        else {
                            --nodeDepth;
                            continue;
                        }
                    }
                    else
                        --nodeDepth;
                }
                return min_found_t;
            }
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag) {
                int primID = -1;
                mat4 ancestorInvTransform = mat4(1.0);
                return worldRayCast(r, minT, maxT, shadowFlag, ancestorInvTransform, primID);
            }

            // ---- World Color ----
            vec3 worldRayColorShallow(in Ray in_ray, inout vec2 random_seed, inout vec4 intersect_position, inout RecursiveNextRays nextRays) {
                int primID = -1;
                mat4 ancestorInvTransform = mat4(1.0);
                
                float intersect_time = worldRayCast(in_ray, EPSILON, 1E20, false, ancestorInvTransform, primID);
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