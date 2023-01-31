class WebGLSceneAdapter {
    constructor(scene, webgl_helper) {
        if (!(scene instanceof BVHScene))
            scene = new BVHScene(scene.objects, scene.lights, scene.bg_color);
        this.scene = scene;
        
        this.indices_texture_unit = webgl_helper.allocateTextureUnit();
        this.indices_texture = webgl_helper.createDataTexture(4, "INTEGER");
        
        this.adapters = {
            lights:     new WebGLLightsAdapter(webgl_helper),
            materials:  new WebGLMaterialsAdapter(webgl_helper),
            geometries: new WebGLGeometriesAdapter(webgl_helper)
        };
        this.inv_transforms = [];
        for (let light of scene.lights)
            this.adapters.lights.visit(light);
        
        this.objects = [];
        const transform_ID_map = {};
        for (let object of scene.objects) {
            const transform_key = object.transform.toString();
            let transformID = null;
            if (transform_key in transform_ID_map)
                transformID = transform_ID_map[transform_key];
            else {
                transformID = transform_ID_map[transform_key] = this.inv_transforms.length;
                this.inv_transforms.push(object.inv_transform);
            }
            
            this.objects.push({
                transformID: transformID,
                geometryID: this.adapters.geometries.visit(object.geometry),
                materialID: this.adapters.materials.visit(object.material)
            });
        }
    }
    writeShaderData(gl, program, webgl_helper) {
        // write global scene properties
        gl.uniform1i(gl.getUniformLocation(program, "uNumObjects"), this.scene.objects.length);
        gl.uniform3fv(gl.getUniformLocation(program, "uBackgroundColor"), this.scene.bg_color);
        
        // write transforms
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uObjectInverseTransforms"), true, Mat.mats_to_webgl(this.inv_transforms));
        
        // write geometry ids, material ids, transform ids
        gl.activeTexture(this.indices_texture_unit);
        webgl_helper.setDataTexturePixels(this.indices_texture, 4, "INTEGER",
            this.objects.map(o => [o.geometryID, o.materialID, o.transformID, Number(!o.does_cast_shadow)]).flat());
        gl.uniform1i(gl.getUniformLocation(program, "uSceneObjects"), webgl_helper.textureUnitIndex(this.indices_texture_unit));
        
        // let our contained adapters do their own thing too
        this.adapters.lights.writeShaderData(gl, program, webgl_helper);
        this.adapters.materials.writeShaderData(gl, program, webgl_helper);
        this.adapters.geometries.writeShaderData(gl, program, webgl_helper);
    }
    getShaderSourceDeclarations() {
        return `
            float sceneRayCast(in Ray r, in float minDistance, in bool shadowFlag);
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

            uniform highp isampler2D uSceneObjects;
            
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

            // ---- Intersections ----
            float sceneObjectIntersect(in int objectID, in Ray r, in float minDistance, in bool shadowFlag) {
                SceneObject obj = getSceneObjectIDs(objectID);
                if (shadowFlag && !obj.castsShadow)
                    return minDistance - 1.0;
                mat4 objectInverseTransform = uObjectInverseTransforms[obj.transform_id];
                return geometryIntersect(obj.geometry_id, Ray(objectInverseTransform * r.o, objectInverseTransform * r.d), minDistance);
            }
            float sceneRayCast(in Ray r, in float minT, in bool shadowFlag, inout int objectID) {
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
            
            
            #define SCENE_MAX_TREE_DEPTH 3 //TODO
            struct BVHNode {
                int AABB_index;
                int objects_start_index;
                int object_cells_count;
            };
            BVHNode getBVHNode(in int node_index) {
                // TODO
                return BVHNode(0,0,0);
            }
            void getBVHAABB(in int AABB_index, out vec4 center, out vec4 half_size) {
                // TODO
            }
            ivec4 getBVHObjects(in int cell_index) {
                return ivec4(0,0,0,0); // TODO
            }
            float sceneRayCastBVH(in Ray r, in float minT, in float maxT, in bool shadowFlag, inout int objectID) {
                int tree_index = 1; // index of root node
                float min_found_t = minT - 1.0;
                float local_minT = minT, local_maxT = maxT;
                
                // TODO: deal with infinitely large objects
                
                while (tree_index > 0) {
                    BVHNode node = getBVHNode(tree_index);
                    
                    vec4 aabb_center, aabb_half_size;
                    getBVHAABB(node.AABB_index, aabb_center, aabb_half_size);
                    
                    vec2 aabb_ts = AABBIntersects(r, aabb_center, aabb_half_size, minT, maxT);
                    bool hitNode = aabb_ts.x <= maxT && aabb_ts.y >= minT && aabb_ts.x <= min_found_t;
                    if (hitNode) {
                        for (int i = 0; i < node.object_cells_count; ++i) {
                            ivec4 objectIndices = getBVHObjects(node.objects_start_index + i);
                            for (int j = 0; j < 4; j) {
                                int object_id = objectIndices[j];
                                float t = sceneObjectIntersect(object_id, r, minT, shadowFlag);
                                if (t >= minT && t < maxT && (min_found_t < minT || t < min_found_t)) {
                                    min_found_t = t;
                                    objectID = object_id;
                                }
                            }
                        }
                        
                        // if this node has children, visit this node's left child next
                        if (tree_index < (1 << SCENE_MAX_TREE_DEPTH))
                            tree_index = tree_index * 2;
                    }
                    
                    // if we missed this node or this node has NO children, find the closest ancestor that is a left child, and visit its right sibling next
                    if (!hitNode || tree_index >= (1 << SCENE_MAX_TREE_DEPTH)) {
                        while (tree_index % 2 == 1)
                            tree_index = tree_index / 2;
                        if (tree_index > 0)
                            ++tree_index;
                    }
                }
                
                return min_found_t;
            }
            float sceneRayCast(in Ray r, in float minDistance, in bool shadowFlag) {
                int objectID = -1;
                return sceneRayCast(r, minDistance, shadowFlag, objectID);
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
                float intersect_time = sceneRayCast(in_ray, EPSILON, false, objectID);
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