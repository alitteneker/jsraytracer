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
        gl.uniform1i(gl.getUniformLocation(program, "uNumLights"), this.scene.lights.length);
        gl.uniform3fv(gl.getUniformLocation(program, "uBackgroundColor"), this.scene.bg_color);
        
        // write transforms
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uObjectInverseTransforms"), false, Mat.mats_to_webgl(this.inv_transforms));
        
        // write geometry ids, material ids, transform ids
        gl.uniform1iv(gl.getUniformLocation(program, "usObjectGeometryIDs"), this.properties.geometryIDs);
        gl.uniform1iv(gl.getUniformLocation(program, "usObjectMaterialIDs"), this.properties.materialIDs);
        gl.uniform1iv(gl.getUniformLocation(program, "usObjectTransformIDs"), this.properties.transformIDs);
        
        // let our contained adapters do their own thing too
        this.adapters.lights.writeShaderData(gl, program);
        this.adapters.materials.writeShaderData(gl, program);
        this.adapters.geometries.writeShaderData(gl, program);
    }
    getShaderSource() {
        return `
            uniform vec3 uBackgroundColor;
            uniform int uNumObjects;
            uniform int uNumLights;

            uniform mat4 uObjectInverseTransforms[16];

            #define MAX_OBJECTS 64
            uniform int usObjectGeometryIDs [MAX_OBJECTS];
            uniform int usObjectMaterialIDs [MAX_OBJECTS];
            uniform int usObjectTransformIDs[MAX_OBJECTS];

            // ---- Intersections ----
            float sceneObjectIntersect(in int objectID, in vec4 ro, in vec4 rd, in float minDistance, in bool shadowFlag) {
                // TODO: add shadowflag logic
                mat4 objectInverseTransform = uObjectInverseTransforms[usObjectTransformIDs[objectID]];
                return geometryIntersect(usObjectGeometryIDs[objectID], objectInverseTransform * ro, objectInverseTransform * rd, minDistance);
            }
            float sceneRayCast(in vec4 ro, in vec4 rd, in float minT, in bool shadowFlag, inout int objectID) {
                float min_found_t = minT - 1.0;
                for (int i = 0; i < uNumObjects; ++i) {
                    float t = sceneObjectIntersect(i, ro, rd, minT, shadowFlag);
                    if (t >= minT && (min_found_t < minT || t < min_found_t)) {
                        min_found_t = t;
                        objectID = i;
                    }
                }
                return min_found_t;
            }
            float sceneRayCast(in vec4 ro, in vec4 rd, in float minDistance, in bool shadowFlag) {
                int objectID = -1;
                return sceneRayCast(ro, rd, minDistance, shadowFlag, objectID);
            }

            // ---- Color ----
            vec3 sceneObjectColor(in int objectID, in vec4 rp, in vec4 ro, in vec4 rd, inout vec4 reflection_direction, inout vec3 reflection_color) {
                vec4 normal;
                vec2 UV;
                mat4 inverseTransform = uObjectInverseTransforms[usObjectTransformIDs[objectID]];
                getGeometricMaterialProperties(usObjectGeometryIDs[objectID], inverseTransform * rp, inverseTransform * ro, inverseTransform * rd, normal, UV);
                normal = transpose(inverseTransform) * normal;
                return colorForMaterial(usObjectMaterialIDs[objectID], rp, ro, rd, normal, UV, reflection_direction, reflection_color);
            }
            vec3 sceneRayColor(in vec4 ro, in vec4 rd, in int maxBounceDepth) {
                vec3 rayColor = uBackgroundColor, attenuation_color = vec3(1.0);
                for (int i = 0; i <= maxBounceDepth; ++i) {
                    int objectID = -1;
                    float distance = sceneRayCast(ro, rd, 0.0, false, objectID);
                    if (objectID == -1)
                        break;
                    
                    vec4 reflection_direction = vec4(0.0);
                    vec3 reflection_color = vec3(0.0);
                    rayColor += /*attenuation_color * */ sceneObjectColor(objectID, ro + distance * rd, ro, rd, reflection_direction, reflection_color);
                    
                    if (dot(reflection_direction, reflection_direction) == 0.0)
                        break;
                    ro += distance * rd;
                    rd = reflection_direction;
                    attenuation_color *= reflection_color;
                }
                return rayColor;
            }`
            + this.adapters.lights.getShaderSource()
            + this.adapters.materials.getShaderSource()
            + this.adapters.geometries.getShaderSource();
    }
}