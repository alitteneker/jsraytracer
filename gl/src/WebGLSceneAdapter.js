class WebGLSceneAdapter {
    constructor(scene) {
        this.scene = scene;
        this.adapters = {
            lights:     new WebGLLightsAdapter(),
            materials:  new WebGLMaterialsAdapter(),
            geometries: new WebGLGeometriesAdapter()
        };
        this.inv_transforms = [];
        this.properties = {
            geometryIDs:  [],
            materialIDs:  [],
            transformIDs: []
        };
        for (let light of scene.lights)
            this.adapters.lights.visit(light);
        
        let transform_ID_map = {};
        for (let object of scene.objects) {
            let transform_ID = object.transform.toString();
            if (transform_ID in transform_ID_map)
                this.properties.transformIDs.push(transform_ID_map[transform_ID]);
            else {
                this.properties.transformIDs.push(transform_ID_map[transform_ID] = this.inv_transforms.length);
                this.inv_transforms.push(object.inv_transform);
            }
            this.properties.geometryIDs.push(this.adapters.geometries.visit(object.geometry));
            this.properties.materialIDs.push(this.adapters.materials.visit(object.material));
        }
    }
    writeShaderData(gl, program) {
        // write global scene properties
        gl.uniform1i(gl.getUniformLocation(program, "uNumObjects"), this.scene.objects.length);
        gl.uniform3fv(gl.getUniformLocation(program, "uBackgroundColor"), this.scene.bg_color);
        
        // write transforms
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uObjectInverseTransforms"), true, Mat.mats_to_webgl(this.inv_transforms));
        
        // write geometry ids, material ids, transform ids
        gl.uniform1iv(gl.getUniformLocation(program, "usObjectGeometryIDs"), this.properties.geometryIDs);
        gl.uniform1iv(gl.getUniformLocation(program, "usObjectMaterialIDs"), this.properties.materialIDs);
        gl.uniform1iv(gl.getUniformLocation(program, "usObjectTransformIDs"), this.properties.transformIDs);
        
        // let our contained adapters do their own thing too
        this.adapters.lights.writeShaderData(gl, program);
        this.adapters.materials.writeShaderData(gl, program);
        this.adapters.geometries.writeShaderData(gl, program);
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

            #define MAX_OBJECTS ${Math.max(this.scene.objects.length, 1)}
            uniform int usObjectGeometryIDs [MAX_OBJECTS];
            uniform int usObjectMaterialIDs [MAX_OBJECTS];
            uniform int usObjectTransformIDs[MAX_OBJECTS];

            // ---- Intersections ----
            float sceneObjectIntersect(in int objectID, in Ray r, in float minDistance, in bool shadowFlag) {
                // TODO: add shadowflag logic
                mat4 objectInverseTransform = uObjectInverseTransforms[usObjectTransformIDs[objectID]];
                return geometryIntersect(usObjectGeometryIDs[objectID], Ray(objectInverseTransform * r.o, objectInverseTransform * r.d), minDistance);
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
                GeometricMaterialData geomatdata;
                mat4 inverseTransform = uObjectInverseTransforms[usObjectTransformIDs[objectID]];
                getGeometricMaterialData(usObjectGeometryIDs[objectID], inverseTransform * rp, Ray(inverseTransform * r.o, inverseTransform * r.d), geomatdata);
                geomatdata.normal = vec4(normalize((transpose(inverseTransform) * geomatdata.normal).xyz), 0);
                return colorForMaterial(usObjectMaterialIDs[objectID], rp, r, geomatdata, random_seed,
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