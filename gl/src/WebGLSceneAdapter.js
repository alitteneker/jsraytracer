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
            vec3 sceneRayColor(in Ray r, in int maxBounceDepth, inout vec2 random_seed);
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
            vec3 sceneObjectColor(in int objectID, in vec4 rp, in Ray r, inout vec2 random_seed, inout vec4 reflection_direction, inout vec3 reflection_color) {
                GeometricMaterialData geomatdata;
                mat4 inverseTransform = uObjectInverseTransforms[usObjectTransformIDs[objectID]];
                getGeometricMaterialData(usObjectGeometryIDs[objectID], inverseTransform * rp, Ray(inverseTransform * r.o, inverseTransform * r.d), geomatdata);
                geomatdata.normal = vec4(normalize((transpose(inverseTransform) * geomatdata.normal).xyz), 0);
                return colorForMaterial(usObjectMaterialIDs[objectID], rp, r, geomatdata, random_seed, reflection_direction, reflection_color);
            }
            vec3 sceneRayColor(in Ray r, in int maxBounceDepth, inout vec2 random_seed) {
                vec3 rayColor = uBackgroundColor, attenuation_color = vec3(1.0);
                for (int i = 0; i < maxBounceDepth; ++i) {
                    int objectID = -1;
                    float intersect_time = sceneRayCast(r, 0.0001, false, objectID);
                    if (objectID == -1)
                        break;
                    
                    vec4 reflection_direction = vec4(0.0);
                    vec3 reflection_color = vec3(0.0);
                    rayColor += attenuation_color * sceneObjectColor(objectID, r.o + intersect_time * r.d, r, random_seed, reflection_direction, reflection_color);
                    
                    if (dot(reflection_direction, reflection_direction) == 0.0)
                        break;
                    r.o += intersect_time * r.d;
                    r.d = reflection_direction;
                    attenuation_color *= reflection_color;
                }
                return rayColor;
            }`
            + this.adapters.lights.getShaderSource()
            + this.adapters.materials.getShaderSource()
            + this.adapters.geometries.getShaderSource();
    }
}