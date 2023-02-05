class WebGLSceneAdapter {
    static USE_SCENE_BVH = true;
    constructor(scene, webgl_helper) {
        [this.indices_texture_unit,  this.indices_texture ] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        [this.bvh_node_texture_unit, this.bvh_node_texture] = webgl_helper.createDataTextureAndUnit(4, "INTEGER");
        [this.bvh_aabb_texture_unit, this.bvh_aabb_texture] = webgl_helper.createDataTextureAndUnit(4, "FLOAT");
        
        this.adapters = {
            lights:     new WebGLLightsAdapter(webgl_helper),
            materials:  new WebGLMaterialsAdapter(webgl_helper),
            geometries: new WebGLGeometriesAdapter(webgl_helper)
        };
        this.inv_transforms = [];
        for (let light of scene.lights)
            this.adapters.lights.visit(light);
        
        this.objects = [];
        const transform_ID_map = {}, object_id_index_map = {};
        for (let object of scene.objects) {
            const transform_key = object.transform.toString();
            let transformID = null;
            if (transform_key in transform_ID_map)
                transformID = transform_ID_map[transform_key];
            else {
                transformID = transform_ID_map[transform_key] = this.inv_transforms.length;
                this.inv_transforms.push(object.inv_transform);
            }
            
            object_id_index_map[object.OBJECT_UID] = this.objects.length;
            this.objects.push({
                transformID: transformID,
                geometryID: this.adapters.geometries.visit(object.geometry, webgl_helper),
                materialID: this.adapters.materials.visit(object.material, webgl_helper)
            });
        }

        // deal with the bvh data
        if (!(scene instanceof BVHScene))
            scene = new BVHScene(scene.objects, scene.lights, scene.bg_color);
        this.scene = scene;

        const bvh_depth = this.bvh_depth = this.scene.maxDepth();
        const max_nodes = 2 ** (this.bvh_depth+1);
        const bvh_data = this.bvh_data = new Array(max_nodes).fill(-1);
        const bvh_aabbs = this.bvh_aabbs = new Array(max_nodes).fill(null);

        const bvh_node_indices = {};
        function BVHVisitorFn(node) {
            const node_index = bvh_node_indices[node.NODE_UID];
            bvh_aabbs[node_index] = node.aabb;
            if (node.sep_axis >= 0) {
                bvh_node_indices[node.greater_node.NODE_UID] = 2 * node_index;
                bvh_node_indices[node.lesser_node.NODE_UID]  = 2 * node_index + 1;
                BVHVisitorFn(node.greater_node);
                BVHVisitorFn(node.lesser_node);
            }
            else if (node.spanning_objects.length) {
                bvh_data[node_index] = bvh_data.length;
                bvh_data.push(...node.spanning_objects.map(o => object_id_index_map[o.OBJECT_UID]), -1);
            }
            else
                bvh_data[node_index] = max_nodes;
        };
        bvh_node_indices[this.scene.kdtree.NODE_UID] = 1;
        bvh_data[0] = max_nodes + 1;
        bvh_data.push(-1, ...this.scene.infinite_objects.map(o => object_id_index_map[o.OBJECT_UID]), -1);
        BVHVisitorFn(this.scene.kdtree);
    }
    destroy(gl) {
        gl.deleteTexture(this.indices_texture);
        gl.deleteTexture(this.bvh_node_texture);
        gl.deleteTexture(this.bvh_aabb_texture);
        
        this.adapters.lights.destroy(gl);
        this.adapters.geometries.destroy(gl);
        this.adapters.materials.destroy(gl);
    }
    writeShaderData(gl, program, webgl_helper) {
        // write global scene properties
        gl.uniform1i(gl.getUniformLocation(program, "uNumObjects"), this.scene.objects.length);
        gl.uniform3fv(gl.getUniformLocation(program, "uBackgroundColor"), this.scene.bg_color);
        
        // write transforms
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uObjectInverseTransforms"), true, Mat.mats_to_webgl(this.inv_transforms));
        
        // write geometry ids, material ids, transform ids, shadow flags
        webgl_helper.setDataTexturePixelsUnit(this.indices_texture, 4, "INTEGER", this.indices_texture_unit, "uSceneObjects", program,
            this.objects.map(o => [o.geometryID, o.materialID, o.transformID, Number(!o.does_cast_shadow)]).flat());
        
        // Write BVH data
        gl.uniform1i(gl.getUniformLocation(program, "uUseBVHSceneIntersect"), WebGLSceneAdapter.USE_SCENE_BVH);
        webgl_helper.setDataTexturePixelsUnit(this.bvh_aabb_texture, 4, "FLOAT",   this.bvh_aabb_texture_unit, "uSceneBVHAABBs", program,
            this.bvh_aabbs.map(a => a ? [...a.center, ...a.half_size] : [0,0,0,0,0,0,0,0]).flat());
        webgl_helper.setDataTexturePixelsUnit(this.bvh_node_texture, 4, "INTEGER", this.bvh_node_texture_unit, "uSceneBVH", program,
            this.bvh_data);
        
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

            uniform mat4 uObjectInverseTransforms[16];

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

            // ---- Intersection ----
            float sceneObjectIntersect(in int objectID, in Ray r, in float minDistance, in bool shadowFlag) {
                SceneObject obj = getSceneObjectIDs(objectID);
                if (shadowFlag && !obj.castsShadow)
                    return minDistance - 1.0;
                mat4 objectInverseTransform = uObjectInverseTransforms[obj.transform_id];
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
            uniform isampler2D uSceneBVH;
            uniform  sampler2D uSceneBVHAABBs;
            
            int getBVHNode(in int node_index) {
                return itexelFetchByIndex(node_index / 4, uSceneBVH)[node_index % 4];
            }
            int getBVHSceneObject(in int index) {
                return itexelFetchByIndex(index / 4, uSceneBVH)[index % 4];
            }
            void getBVHAABB(in int node_index, out vec4 center, out vec4 half_size) {
                center    = texelFetchByIndex(node_index * 2,     uSceneBVHAABBs);
                half_size = texelFetchByIndex(node_index * 2 + 1, uSceneBVHAABBs);
            }
            float sceneRayCastBVH(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int objectID) {
                int node_index = 1; // index of root node
                float min_found_t = minT - 1.0;
                float local_minT = minT, local_maxT = maxT;
                
                // deal with infinitely large objects, stored specially in the list starting at index 0
                {
                    int root_node_objects_start_index = getBVHNode(0);
                    int object_id = getBVHSceneObject(root_node_objects_start_index);
                    for (int i = 0; object_id >= 0; ++i) {
                        float t = sceneObjectIntersect(object_id, r, minT, shadowFlag);
                        if (t >= minT && t < maxT && (min_found_t < minT || t < min_found_t)) {
                            min_found_t = t;
                            objectID = object_id;
                        }
                        object_id = getBVHSceneObject(root_node_objects_start_index + i);
                    }
                }
                
                while (node_index > 0) {
                    int node_objects_start_index = getBVHNode(node_index);
                    
                    vec4 aabb_center, aabb_half_size;
                    getBVHAABB(node_index, aabb_center, aabb_half_size);
                    
                    vec2 aabb_ts = AABBIntersects(r, aabb_center, aabb_half_size, minT, maxT);
                    bool hit_node = aabb_ts.x <= maxT && aabb_ts.y >= minT && (aabb_ts.x <= min_found_t || min_found_t < minT);
                    if (hit_node) {

                        // check if this is a leaf node, check all objects in this node
                        if (node_objects_start_index >= 0) {
                            int object_id = getBVHSceneObject(node_objects_start_index);
                            for (int i = 0; object_id >= 0; ++i) {
                                float t = sceneObjectIntersect(object_id, r, minT, shadowFlag);
                                if (t >= minT && t < maxT && (min_found_t < minT || t < min_found_t)) {
                                    min_found_t = t;
                                    objectID = object_id;
                                }
                                object_id = getBVHSceneObject(node_objects_start_index + i);
                            }
                        }

                        // if this node has children, visit this node's left child next
                        else
                            node_index = node_index * 2;
                    }
                    
                    // if we missed this node or this node has NO children, find the closest ancestor that is a left child, and visit its right sibling next
                    if (!hit_node || node_objects_start_index >= 0) {
                        while (node_index % 2 == 1)
                            node_index = node_index / 2;
                        if (node_index > 0)
                            ++node_index;
                    }
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
                mat4 inverseTransform = uObjectInverseTransforms[ids.transform_id];
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