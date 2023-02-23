class WebGLSceneAdapter {
    USE_SCENE_BVH = false;
    constructor(scene, webgl_helper) {
        [this.indices_texture_unit,  this.indices_texture ] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        [this.bvh_node_texture_unit, this.bvh_node_texture] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        [this.bvh_aabb_texture_unit, this.bvh_aabb_texture] = webgl_helper.createDataTextureAndUnit(4, "FLOAT");
        
        this.transform_store = new WebGLTransformStore();
        this.adapters = {
            lights:     new WebGLLightsAdapter(webgl_helper),
            materials:  new WebGLMaterialsAdapter(webgl_helper),
            geometries: new WebGLGeometriesAdapter(webgl_helper)
        };
        
        // deal with lights
        for (let light of scene.lights)
            this.adapters.lights.visit(light);
        
        // deal with scene objects
        this.objects = [];
        this.inv_transforms = [];
        const object_id_index_map = this.object_id_index_map = {};
        for (let object of scene.objects) {
            object_id_index_map[object.OBJECT_UID] = this.objects.length;
            this.objects.push({
                object:      object,
                transformID: this.transform_store.store(object.inv_transform),
                geometryID:  this.adapters.geometries.visit(object.geometry, webgl_helper),
                materialID:  this.adapters.materials.visit(object.material, webgl_helper),
                does_cast_shadow:  object.does_cast_shadow
            });
        }

        // deal with the bvh data
        if (!(scene instanceof BVHScene))
            scene = new BVHScene(scene.objects, scene.lights, scene.bg_color);
        this.scene = scene;

        const bvh_nodes = this.bvh_nodes = [];
        const bvh_object_list = this.bvh_object_list = [];
        const bvh_node_indices = {};
        function BVHVisitorFn(node, parent_node=null, isGreater=false) {
            const node_index = bvh_node_indices[node.NODE_UID] = bvh_nodes.length;
            const node_data = {
                raw_node:    node,
                parent_node: parent_node,
                aabb:        node.aabb,
                isGreater:   isGreater
            };
            bvh_nodes.push(node_data);
            
            if (node.sep_axis >= 0) {
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
        bvh_object_list.push(...this.scene.infinite_objects.map(o => object_id_index_map[o.OBJECT_UID]), -1);

        BVHVisitorFn(this.scene.kdtree);
        
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
    destroy(gl) {
        gl.deleteTexture(this.indices_texture);
        gl.deleteTexture(this.bvh_node_texture);
        gl.deleteTexture(this.bvh_aabb_texture);
        
        this.adapters.lights.destroy(gl);
        this.adapters.geometries.destroy(gl);
        this.adapters.materials.destroy(gl);
    }
    intersectRay(ray) {
        const intersect = this.scene.cast(ray);
        if (!intersect.object)
            return null;
        
        const index = this.object_id_index_map[intersect.object.OBJECT_UID];
        const webgl_ids = this.objects[index];
        
        return {
            index: index,
            object: webgl_ids.object,
            transform: { index: webgl_ids.transformID, value: this.transform_store.get(webgl_ids.transformID) },
            material:  { index: webgl_ids.materialID,  value: this.adapters.materials.getMaterial(webgl_ids.materialID) },
            does_cast_shadow: webgl_ids.does_cast_shadow
        };
    }
    writeShaderData(gl, program, webgl_helper) {
        // write global scene properties
        gl.uniform1i(gl.getUniformLocation(program, "uNumObjects"), this.scene.objects.length);
        gl.uniform3fv(gl.getUniformLocation(program, "uBackgroundColor"), this.scene.bg_color);
        
        // write transforms
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uTransforms"), true, this.transform_store.flat());
        
        // write geometry ids, material ids, transform ids, shadow flags
        webgl_helper.setDataTexturePixelsUnit(this.indices_texture, 4, "INTEGER", this.indices_texture_unit, "uSceneObjects", program,
            this.objects.map(o => [o.geometryID, o.materialID, o.transformID, Number(o.does_cast_shadow)]).flat());
        
        // Write BVH data
        gl.uniform1i(gl.getUniformLocation(program, "uUseBVHSceneIntersect"), this.USE_SCENE_BVH);
        gl.uniform1i(gl.getUniformLocation(program, "uSceneBVHNodeCount"), this.bvh_nodes.length);
        webgl_helper.setDataTexturePixelsUnit(this.bvh_aabb_texture, 4, "FLOAT",   this.bvh_aabb_texture_unit, "uSceneBVHAABBs", program,
            this.bvh_nodes.map(n => n.aabb ? [...n.aabb.center, ...n.aabb.half_size] : [0,0,0,0,0,0,0,0]).flat());
        webgl_helper.setDataTexturePixelsUnit(this.bvh_node_texture, 4, "INTEGER", this.bvh_node_texture_unit, "uSceneBVHNodeData", program,
            this.bvh_nodes.map(n => [n.hitIndex, n.missIndex]).flat().concat(this.bvh_object_list));
        
        // let our contained adapters do their own thing too
        this.adapters.lights.writeShaderData(gl, program, webgl_helper);
        this.adapters.materials.writeShaderData(gl, program, webgl_helper);
        this.adapters.geometries.writeShaderData(gl, program, webgl_helper);
    }
    getShaderSourceDeclarations() {
        return `
            float sceneRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag);
            vec3 sceneRayColorShallow(in Ray in_ray, inout vec2 random_seed, inout vec4 intersect_position, inout RecursiveNextRays nextRays);` + "\n"
            + this.adapters.lights.getShaderSourceDeclarations() + "\n"
            + this.adapters.geometries.getShaderSourceDeclarations() + "\n"
            + this.adapters.materials.getShaderSourceDeclarations() + "\n";
    }
    getShaderSource() {
        return `
            uniform vec3 uBackgroundColor;
            uniform int uNumObjects;

            uniform mat4 uTransforms[16]; // TODO: should safety check the size of this

            uniform isampler2D uSceneObjects;
            
            struct SceneObject {
                int geometry_id;
                int material_id;
                int transform_id;
                bool castsShadow;
            };
            SceneObject getSceneObjectIDs(in int objectID) {
                ivec4 indices = itexelFetchByIndex(objectID, uSceneObjects);
                return SceneObject(indices.r, indices.g, indices.b, bool(indices.a));
            }
            mat4 getTransform(in int index) {
                return uTransforms[index];
            }

            // ---- Intersection ----
            float sceneObjectIntersect(in int objectID, in Ray r, in float minDistance, in bool shadowFlag) {
                SceneObject obj = getSceneObjectIDs(objectID);
                if (shadowFlag && !obj.castsShadow)
                    return minDistance - 1.0;
                mat4 objectInverseTransform = getTransform(obj.transform_id);
                return geometryIntersect(obj.geometry_id, Ray(objectInverseTransform * r.o, objectInverseTransform * r.d), minDistance);
            }

            // ---- Brute Force Intersection ----
            float sceneRayCastBruteForce(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int objectID) {
                float min_found_t = minT - 1.0;
                for (int i = 0; i < uNumObjects; ++i) {
                    float t = sceneObjectIntersect(i, r, minT, shadowFlag);
                    if (t >= minT && (min_found_t < minT || t < min_found_t)) {
                        min_found_t = t;
                        objectID = i;
                    }
                }
                return min_found_t;
            }
            
            
            // ---- BVH Intersection ----
            uniform int uSceneBVHNodeCount;
            uniform isampler2D uSceneBVHNodeData;
            uniform  sampler2D uSceneBVHAABBs;
            
            struct BVHBounds {
                vec4 center;
                vec4 half_size;
            };
            struct BVHNode {
                int hitIndex;  // >0 if node has children with left child as next, <0 if node is leaf with index of start of object list
                int missIndex; // index of next node to visit if this is a leaf or the ray misses the aabb
            };
            BVHNode getBVHNode(in int node_index) {
                ivec4 texel = itexelFetchByIndex(node_index / 2, uSceneBVHNodeData);
                if (node_index % 2 == 0) 
                    return BVHNode(texel.x, texel.y);
                return BVHNode(texel.z, texel.w);
            }
            int getBVHSceneObject(in int start_index, in int offset) {
                int texIndex = uSceneBVHNodeCount * 2 - start_index + offset - 1;
                return itexelFetchByIndex(texIndex / 4, uSceneBVHNodeData)[texIndex % 4];
            }
            BVHBounds getBVHAABB(in int node_index) {
                return BVHBounds(
                    texelFetchByIndex(node_index * 2,     uSceneBVHAABBs),
                    texelFetchByIndex(node_index * 2 + 1, uSceneBVHAABBs));
            }
            float sceneRayCastBVH(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int objectID) {
                float min_found_t = minT - 1.0;
                float local_minT = minT, local_maxT = maxT;
                
                // deal with infinitely large objects, stored specially in the list starting at index 0
                {
                    BVHNode root_node = getBVHNode(0);
                    int object_id = getBVHSceneObject(root_node.hitIndex, 0);
                    for (int i = 0; object_id >= 0; ++i) {
                        float t = sceneObjectIntersect(object_id, r, minT, shadowFlag);
                        if (t >= minT && t < maxT && (min_found_t < minT || t < min_found_t)) {
                            min_found_t = t;
                            objectID = object_id;
                        }
                        object_id = getBVHSceneObject(root_node.hitIndex, i);
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
                            int object_id = getBVHSceneObject(node.hitIndex, 0);
                            for (int i = 0; object_id >= 0; ++i) {
                                float t = sceneObjectIntersect(object_id, r, minT, shadowFlag);
                                if (t >= minT && t < maxT && (min_found_t < minT || t < min_found_t)) {
                                    min_found_t = t;
                                    objectID = object_id;
                                }
                                object_id = getBVHSceneObject(node.hitIndex, i);
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
            uniform bool uUseBVHSceneIntersect;
            float sceneRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int objectID) {
                if (uUseBVHSceneIntersect)
                    return sceneRayCastBVH(r, minT, maxT, shadowFlag, objectID);
                return sceneRayCastBruteForce(r, minT, maxT, shadowFlag, objectID);
            }
            float sceneRayCast(in Ray r, in float minT, in float maxT, in bool shadowFlag) {
                int objectID = -1;
                return sceneRayCast(r, minT, maxT, shadowFlag, objectID);
            }

            // ---- Scene Color ----
            vec3 sceneObjectColor(in int objectID, in vec4 rp, in Ray r, inout vec2 random_seed, inout RecursiveNextRays nextRays) {
                SceneObject ids = getSceneObjectIDs(objectID);
                GeometricMaterialData geomatdata;
                mat4 inverseTransform = getTransform(ids.transform_id);
                getGeometricMaterialData(ids.geometry_id, inverseTransform * rp, Ray(inverseTransform * r.o, inverseTransform * r.d), geomatdata);
                geomatdata.normal = vec4(normalize((transpose(inverseTransform) * geomatdata.normal).xyz), 0);
                return colorForMaterial(ids.material_id, rp, r, geomatdata, random_seed, nextRays);
            }
            vec3 sceneRayColorShallow(in Ray in_ray, inout vec2 random_seed, inout vec4 intersect_position, inout RecursiveNextRays nextRays) {
                int objectID = -1;
                float intersect_time = sceneRayCast(in_ray, EPSILON, 1E20, false, objectID);
                if (objectID == -1)
                    return uBackgroundColor;
                intersect_position = in_ray.o + intersect_time * in_ray.d;
                return sceneObjectColor(objectID, intersect_position, in_ray, random_seed, nextRays);
            }`
            + this.adapters.lights.getShaderSource()
            + this.adapters.materials.getShaderSource()
            + this.adapters.geometries.getShaderSource();
    }
}