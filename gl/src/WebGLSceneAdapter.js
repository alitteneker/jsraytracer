class WebGLSceneAdapter {
    constructor(scene, webgl_helper) {
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
        // gl.uniform1iv(gl.getUniformLocation(program, "usObjectGeometryIDs"),  this.objects.map(o => o.geometryID));
        // gl.uniform1iv(gl.getUniformLocation(program, "usObjectMaterialIDs"),  this.objects.map(o => o.materialID));
        // gl.uniform1iv(gl.getUniformLocation(program, "usObjectTransformIDs"), this.objects.map(o => o.transformID));
        gl.activeTexture(this.indices_texture_unit);
        webgl_helper.setDataTexturePixels(this.indices_texture, 4, "INTEGER",
            this.objects.map(o => [o.geometryID, o.materialID, o.transformID, 1]).flat());
        gl.uniform1i(gl.getUniformLocation(program, "uSceneObjects"), webgl_helper.textureUnitIndex(this.indices_texture_unit));
        
        // let our contained adapters do their own thing too
        this.adapters.lights.writeShaderData(gl, program, webgl_helper);
        this.adapters.materials.writeShaderData(gl, program, webgl_helper);
        this.adapters.geometries.writeShaderData(gl, program, webgl_helper);
    }
    getShaderSourceDeclarations() {
        return `
            #define SCENE_MAX_BOUNCE_QUEUE_LENGTH (1 << (MAX_BOUNCE_DEPTH+1))
            vec3 sceneRayColor(in Ray r, inout vec2 random_seed);
            float sceneRayCast(in Ray r, in float minDistance, in bool shadowFlag);` + "\n"
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
            
            // #define MAX_OBJECTS ${Math.max(this.scene.objects.length, 1)}
            // uniform int usObjectGeometryIDs [MAX_OBJECTS];
            // uniform int usObjectMaterialIDs [MAX_OBJECTS];
            // uniform int usObjectTransformIDs[MAX_OBJECTS];
            
            struct SceneObject {
                int geometry_id;
                int material_id;
                int transform_id;
                int shadowflag;
            };
            SceneObject getSceneObjectIDs(in int objectID) {
                ivec4 indices = itexelFetchByIndex(objectID, uSceneObjects);
                return SceneObject(indices.r, indices.g, indices.b, indices.a);
                // return SceneObject(
                    // usObjectGeometryIDs[objectID],
                    // usObjectMaterialIDs[objectID],
                    // usObjectTransformIDs[objectID],
                    // 1);
            }

            // ---- Intersections ----
            float sceneObjectIntersect(in int objectID, in Ray r, in float minDistance, in bool shadowFlag) {
                // TODO: add shadowflag logic
                SceneObject ids = getSceneObjectIDs(objectID);
                mat4 objectInverseTransform = uObjectInverseTransforms[ids.transform_id];
                return geometryIntersect(ids.geometry_id, Ray(objectInverseTransform * r.o, objectInverseTransform * r.d), minDistance);
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
            float sceneRayCast(in Ray r, in float minDistance, in bool shadowFlag) {
                int objectID = -1;
                return sceneRayCast(r, minDistance, shadowFlag, objectID);
            }

            // ---- Color ----
            vec3 sceneObjectColor(in int objectID, in vec4 rp, in Ray r, inout vec2 random_seed,
                inout vec4 reflection_direction, inout vec3 reflection_color, inout vec4 refraction_direction, inout vec3 refraction_color)
            {
                SceneObject ids = getSceneObjectIDs(objectID);
                GeometricMaterialData geomatdata;
                mat4 inverseTransform = uObjectInverseTransforms[ids.transform_id];
                getGeometricMaterialData(ids.geometry_id, inverseTransform * rp, Ray(inverseTransform * r.o, inverseTransform * r.d), geomatdata);
                geomatdata.normal = vec4(normalize((transpose(inverseTransform) * geomatdata.normal).xyz), 0);
                return colorForMaterial(ids.material_id, rp, r, geomatdata, random_seed,
                                        reflection_direction, reflection_color, refraction_direction, refraction_color);
            }
            vec3 sceneRayColor(in Ray in_ray, inout vec2 random_seed) {
                vec3 total_color = vec3(0.0);
                
                int q_len = 0;
                Ray q_rays[SCENE_MAX_BOUNCE_QUEUE_LENGTH];
                vec3 q_attenuation_colors[SCENE_MAX_BOUNCE_QUEUE_LENGTH];
                int q_remaining_bounces[SCENE_MAX_BOUNCE_QUEUE_LENGTH];
                
                if (MAX_BOUNCE_DEPTH > 0) {
                    q_rays[0] = in_ray;
                    q_attenuation_colors[0] = vec3(1.0);
                    q_remaining_bounces[0] = MAX_BOUNCE_DEPTH-1;
                    q_len = 1;
                }
                
                for (int i = 0; i < q_len; ++i) {
                    Ray r = q_rays[i];
                    vec3 attenuation_color = q_attenuation_colors[i];
                    int remaining_bounces = q_remaining_bounces[i];
                    
                    int objectID = -1;
                    float intersect_time = sceneRayCast(r, EPSILON, false, objectID);
                    if (objectID == -1) {
                        total_color += attenuation_color * uBackgroundColor;
                        continue;
                    }
                    
                    vec4 reflection_direction = vec4(0.0), refraction_direction = vec4(0.0);
                    vec3 reflection_color = vec3(0.0), refraction_color = vec3(0.0);
                    
                    vec3 sampleColor = sceneObjectColor(objectID, r.o + intersect_time * r.d, r, random_seed,
                        reflection_direction, reflection_color, refraction_direction, refraction_color);
                    total_color += attenuation_color * sampleColor;
                    
                    if (remaining_bounces > 0) {
                        vec4 intersect_position = r.o + intersect_time * r.d;
                        if (dot(reflection_direction, reflection_direction) > EPSILON && dot(reflection_color, reflection_color) > EPSILON) {
                            q_rays[q_len] = Ray(intersect_position, reflection_direction);
                            q_attenuation_colors[q_len] = attenuation_color * reflection_color;
                            q_remaining_bounces[q_len] = remaining_bounces - 1;
                            ++q_len;
                        }
                        
                        if (dot(refraction_direction, refraction_direction) > EPSILON && dot(refraction_color, refraction_color) > EPSILON) {
                            q_rays[q_len] = Ray(intersect_position, refraction_direction);
                            q_attenuation_colors[q_len] = attenuation_color * refraction_color;
                            q_remaining_bounces[q_len] = remaining_bounces - 1;
                            ++q_len;
                        }
                    }
                }
                
                if (q_len == SCENE_MAX_BOUNCE_QUEUE_LENGTH)
                    return vec3(1.0, 0.0, 0.5);
                
                return total_color;
            }`
            + this.adapters.lights.getShaderSource()
            + this.adapters.materials.getShaderSource()
            + this.adapters.geometries.getShaderSource();
    }
}