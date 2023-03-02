class WebGLWorldAdapter {
    USE_SCENE_BVH = false;
    constructor(world, webgl_helper) {
        [this.indices_texture_unit,  this.indices_texture ] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        [this.bvh_node_texture_unit, this.bvh_node_texture] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        [this.bvh_aabb_texture_unit, this.bvh_aabb_texture] = webgl_helper.createDataTextureAndUnit(4, "FLOAT");
        
        this.transform_store = new WebGLTransformStore();
        this.adapters = {
            lights:     new WebGLLightsAdapter(webgl_helper),
            materials:  new WebGLMaterialsAdapter(webgl_helper),
            geometries: new WebGLGeometriesAdapter(webgl_helper)
        };
        
        this.objects = [];
        this.transform_object_map = {};
        const object_id_index_map = this.object_id_index_map = {};
        
        const bvh_nodes = this.bvh_nodes = [];
        const bvh_object_list = this.bvh_object_list = [];
        const bvh_node_indices = this.bvh_node_indices = {};
        
        
        // deal with lights
        for (let light of world.lights)
            this.adapters.lights.visit(light, this.adapters.geometries, this.adapters.materials, webgl_helper);
        
        // deal with world objects
        for (let object of world.objects)
            this.visitWorldObject(object, webgl_helper);


        // deal with the bvh data
        if (!(world instanceof BVHWorld))
            world = new BVHWorld(world.objects, world.lights, world.bg_color);
        this.world = world;

        function BVHVisitorFn(node, parent_node=null, isGreater=false) {
            const node_index = bvh_node_indices[node.NODE_UID] = bvh_nodes.length;
            const node_data = {
                raw_node:    node,
                parent_node: parent_node,
                aabb:        node.aabb,
                isGreater:   isGreater
            };
            bvh_nodes.push(node_data);
            
            if (!node.isLeaf) {
                BVHVisitorFn(node.greater_node, node_data, true);
                BVHVisitorFn(node.lesser_node,  node_data, false);
                node_data.hitIndex = bvh_node_indices[node.greater_node.NODE_UID];
            }
            else {
                node_data.hitIndex = -1 - bvh_object_list.length;
                bvh_object_list.push(...node.objects.map(o => object_id_index_map[o.OBJECT_UID]), -1);
            }
        };
        bvh_nodes.push({ raw_node: null, aabb: AABB.empty(), hitIndex: -1, missIndex: 0 });
        bvh_object_list.push(...this.world.infinite_objects.map(o => object_id_index_map[o.OBJECT_UID]), -1);

        BVHVisitorFn(this.world.kdtree);
        
        for (let node_data of bvh_nodes) {
            let n = node_data;
            while (n && !n.isGreater)
                n = n.parent_node;
            if (n)
                node_data.missIndex = bvh_node_indices[n.parent_node.raw_node.lesser_node.NODE_UID];
            else
                node_data.missIndex = 0;
        }
    }
    visitWorldObject(object, webgl_helper) {
        if (object.OBJECT_UID in this.object_id_index_map)
            return this.object_id_index_map[object.OBJECT_UID];
        
        this.object_id_index_map[object.OBJECT_UID] = this.objects.length;
        this.objects.push({
            object:      object,
            transformID: this.transform_store.store(object.inv_transform),
            geometryID:  this.adapters.geometries.visit(object.geometry, webgl_helper),
            materialID:  this.adapters.materials.visit( object.material, webgl_helper),
            does_cast_shadow:  object.does_cast_shadow
        });
        
        const transformID = this.objects[this.objects.length-1].transformID;
        if (!(transformID in this.transform_object_map))
            this.transform_object_map[transformID] = [];
        this.transform_object_map[transformID].push(object);
        
        return this.object_id_index_map[object.OBJECT_UID];
    }
    destroy(gl) {
        this.indices_texture.destroy();
        this.bvh_node_texture.destroy();
        this.bvh_aabb_texture.destroy();
        
        this.adapters.lights.destroy(gl);
        this.adapters.geometries.destroy(gl);
        this.adapters.materials.destroy(gl);
    }
    
    wrapObject(object) {
        if (!object)
            return null;
        
        const index = this.object_id_index_map[object.OBJECT_UID];
        const webgl_ids = this.objects[index];
        
        return {
            index: index,
            object: webgl_ids.object,
            transform: { index: webgl_ids.transformID, value: this.transform_store.get(webgl_ids.transformID) },
            geometry:  { index: webgl_ids.geometryID,  value: this.adapters.geometries.getGeometry(webgl_ids.geometryID) },
            material:  { index: webgl_ids.materialID,  value: this.adapters.materials.getMaterial(webgl_ids.materialID) },
            does_cast_shadow: webgl_ids.does_cast_shadow
        };
    }
    intersectRay(ray) {
        const intersect = this.world.cast(ray);
        return (!intersect.object) ? null : this.wrapObject(intersect.object);
    }
    getLights() {
        //return this.adapters.world.getLights();
    }
    getObjects() {
        return this.world.objects.map(o => this.wrapObject(o));
    }
    getObject(index) {
        return this.wrapObject(this.world.objects[index]);
    }
    
    setTransform(transform_index, new_transform, new_inv_transform, gl, program) {
        for (let object of this.transform_object_map[transform_index])
            object.setTransform(new_transform, new_inv_transform);
        this.transform_store.set(transform_index, new_inv_transform);
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uTransforms"), true, this.transform_store.flat());
    }
    modifyMaterialSolidColor(material_color_index, new_color) {
        this.adapters.materials.modifySolidColor(material_color_index, new_color);
    }
    modifyMaterialScalar(material_index, new_scalar) {
        this.adapters.materials.modifyScalar(material_index, new_scalar);
    }
    
    writeShaderData(gl, program, webgl_helper) {
        // write global world properties
        gl.uniform1i( gl.getUniformLocation(program, "uNumObjects"), this.world.objects.length);
        gl.uniform3fv(gl.getUniformLocation(program, "uBackgroundColor"), this.world.bg_color);
        
        // write transforms
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uTransforms"), true, this.transform_store.flat());
        
        // write geometry ids, material ids, transform ids, shadow flags
        this.indices_texture.setDataPixelsUnit(
            this.objects.map(o => [o.geometryID, o.materialID, o.transformID, Number(o.does_cast_shadow)]).flat(),
            this.indices_texture_unit, "uWorldObjects", program);
        
        // Write BVH data
        gl.uniform1i(gl.getUniformLocation(program, "uUseBVHWorldIntersect"), this.USE_SCENE_BVH);
        gl.uniform1i(gl.getUniformLocation(program, "uWorldBVHNodeCount"), this.bvh_nodes.length);
        this.bvh_aabb_texture.setDataPixelsUnit(
            this.bvh_nodes.map(n => n.aabb ? [...n.aabb.center, ...n.aabb.half_size] : [0,0,0,0,0,0,0,0]).flat(),
            this.bvh_aabb_texture_unit, "uWorldBVHAABBs", program);
        this.bvh_node_texture.setDataPixelsUnit(
            this.bvh_nodes.map(n => [n.hitIndex, n.missIndex]).flat().concat(this.bvh_object_list),
            this.bvh_node_texture_unit, "uWorldBVHNodeData", program);
        
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
            uniform int uNumObjects;

            uniform mat4 uTransforms[16]; // TODO: should safety check the size of this

            uniform isampler2D uWorldObjects;
            
            struct WorldObject {
                int geometry_id;
                int material_id;
                int transform_id;
                bool castsShadow;
            };
            WorldObject getWorldObjectIDs(in int objectID) {
                ivec4 indices = itexelFetchByIndex(objectID, uWorldObjects);
                return WorldObject(indices.r, indices.g, indices.b, bool(indices.a));
            }
            mat4 getTransform(in int index) {
                return uTransforms[index];
            }

            // ---- Intersection ----
            float worldObjectIntersect(in int objectID, in Ray r, in float minDistance, in bool shadowFlag) {
                WorldObject obj = getWorldObjectIDs(objectID);
                if (shadowFlag && !obj.castsShadow)
                    return minDistance - 1.0;
                mat4 objectInverseTransform = getTransform(obj.transform_id);
                return geometryIntersect(obj.geometry_id, Ray(objectInverseTransform * r.o, objectInverseTransform * r.d), minDistance);
            }

            // ---- Brute Force Intersection ----
            float worldRayCastBruteForce(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int objectID) {
                float min_found_t = minT - 1.0;
                for (int i = 0; i < uNumObjects; ++i) {
                    float t = worldObjectIntersect(i, r, minT, shadowFlag);
                    if (t >= minT && (min_found_t < minT || t < min_found_t)) {
                        min_found_t = t;
                        objectID = i;
                    }
                }
                return min_found_t;
            }
            
            
            // ---- BVH Intersection ----
            uniform int uWorldBVHNodeCount;
            uniform isampler2D uWorldBVHNodeData;
            uniform  sampler2D uWorldBVHAABBs;
            
            struct BVHBounds {
                vec4 center;
                vec4 half_size;
            };
            struct BVHNode {
                int hitIndex;  // >0 if node has children with left child as next, <0 if node is leaf with index of start of object list
                int missIndex; // index of next node to visit if this is a leaf or the ray misses the aabb
            };
            BVHNode getBVHNode(in int node_index) {
                ivec4 texel = itexelFetchByIndex(node_index / 2, uWorldBVHNodeData);
                if (node_index % 2 == 0) 
                    return BVHNode(texel.x, texel.y);
                return BVHNode(texel.z, texel.w);
            }
            int getBVHWorldObject(in int start_index, in int offset) {
                int texIndex = uWorldBVHNodeCount * 2 - start_index + offset - 1;
                return itexelFetchByIndex(texIndex / 4, uWorldBVHNodeData)[texIndex % 4];
            }
            BVHBounds getBVHAABB(in int node_index) {
                return BVHBounds(
                    texelFetchByIndex(node_index * 2,     uWorldBVHAABBs),
                    texelFetchByIndex(node_index * 2 + 1, uWorldBVHAABBs));
            }
            float worldRayCastBVH(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int objectID) {
                float min_found_t = minT - 1.0;
                float local_minT = minT, local_maxT = maxT;
                
                // deal with infinitely large objects, stored specially in the list starting at index 0
                {
                    BVHNode root_node = getBVHNode(0);
                    int object_id = getBVHWorldObject(root_node.hitIndex, 0);
                    for (int i = 0; object_id >= 0; ++i) {
                        float t = worldObjectIntersect(object_id, r, minT, shadowFlag);
                        if (t >= minT && t < maxT && (min_found_t < minT || t < min_found_t)) {
                            min_found_t = t;
                            objectID = object_id;
                        }
                        object_id = getBVHWorldObject(root_node.hitIndex, i);
                    }
                }

                int node_index = 1; // index of root (finite) node
                while (node_index > 0) {
                    BVHNode node = getBVHNode(node_index);
                    
                    BVHBounds bvh_bounds = getBVHAABB(node_index);
                    vec2 aabb_ts = AABBIntersects(r, bvh_bounds.center, bvh_bounds.half_size, minT, maxT);
                    
                    bool hit_node = aabb_ts.x <= maxT && aabb_ts.y >= minT && (aabb_ts.x <= min_found_t || min_found_t < minT);
                    if (hit_node) {

                        // check if this is a leaf node, check all objects in this node
                        if (node.hitIndex < 0) {
                            int object_id = getBVHWorldObject(node.hitIndex, 0);
                            for (int i = 0; object_id >= 0; ++i) {
                                float t = worldObjectIntersect(object_id, r, minT, shadowFlag);
                                if (t >= minT && t < maxT && (min_found_t < minT || t < min_found_t)) {
                                    min_found_t = t;
                                    objectID = object_id;
                                }
                                object_id = getBVHWorldObject(node.hitIndex, i);
                            }
                        }

                        // if this node has children, visit this node's left child next
                        else if (node.hitIndex > 0)
                            node_index = node.hitIndex;
                    }
                    
                    // if we missed this node or this node has NO children, find the closest ancestor that is a left child, and visit its right sibling next
                    if (!hit_node || node.hitIndex < 0)
                        node_index = node.missIndex;
                }
                
                return min_found_t;
            }
            
            // ---- Generic Intersection ----
            uniform bool uUseBVHWorldIntersect;
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int objectID) {
                if (uUseBVHWorldIntersect)
                    return worldRayCastBVH(r, minT, maxT, shadowFlag, objectID);
                return worldRayCastBruteForce(r, minT, maxT, shadowFlag, objectID);
            }
            float worldRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag) {
                int objectID = -1;
                return worldRayCast(r, minT, maxT, shadowFlag, objectID);
            }

            // ---- World Color ----
            vec3 worldObjectColor(in int objectID, in vec4 rp, in Ray r, inout vec2 random_seed, inout RecursiveNextRays nextRays) {
                WorldObject ids = getWorldObjectIDs(objectID);
                mat4 inverseTransform = getTransform(ids.transform_id);
                GeometricMaterialData geomatdata = getGeometricMaterialData(ids.geometry_id, inverseTransform * rp, inverseTransform * r.d);
                geomatdata.normal = vec4(normalize((transpose(inverseTransform) * geomatdata.normal).xyz), 0);
                return colorForMaterial(ids.material_id, rp, r, geomatdata, random_seed, nextRays);
            }
            vec3 worldRayColorShallow(in Ray in_ray, inout vec2 random_seed, inout vec4 intersect_position, inout RecursiveNextRays nextRays) {
                int objectID = -1;
                float intersect_time = worldRayCast(in_ray, EPSILON, 1E20, false, objectID);
                if (objectID == -1)
                    return uBackgroundColor;
                intersect_position = in_ray.o + intersect_time * in_ray.d;
                return worldObjectColor(objectID, intersect_position, in_ray, random_seed, nextRays);
            }`
            + this.adapters.lights.getShaderSource()
            + this.adapters.materials.getShaderSource()
            + this.adapters.geometries.getShaderSource();
    }
}