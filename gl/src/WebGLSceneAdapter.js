class WebGLSceneAdapter {
    constructor(scene) {
        this.adapters = {
            lights:     new WebGLLightsAdapter(),
            materials:  new WebGLMaterialsAdapter,
            geometries: new WebGLGeometriesAdapter()
        };
        this.properties = {
            numObject: sccene.objects.length,
            geometryIDs:  [],
            materialIDs:  [],
            transformIDs: []
        };
        for (let light of scene.lights)
            this.adapters.lights.visit(light);
        for (let object of scene.objects) {
            // TODO: do something with object transform
            this.properties.geometryIDs.push(this.adapters.geometries.visit(object.geometry));
            this.properties.materialIDs.push(this.adapters.materials.visit(object.material));
        }
    }
    writeShaderData(gl) {
    }
    getShaderSource() {
        return this.adapters.lights.getShaderSource()
        + this.adapters.materials.getShaderSource()
        + this.adapters.geometries.getShaderSource()
        + ` uniform vec4 uBackgroundColor;
            uniform int uAllowedBounceDepth;
            uniform int uNumObjects;

            uniform mat4 uObjectTransforms[16];
            uniform mat4 uObjectInverseTransforms[16];

            #define MAX_OBJECTS 64
            uniform int usObjectGeometryIDs[MAX_OBJECTS]; // 1=Plane, 2=Sphere, 3+=Triangle instance
            uniform int usObjectMaterialIDs[MAX_OBJECTS]; // 1+=SimpleMaterial instance
            uniform int usObjectTransformIDs[MAX_OBJECTS];

            // ---- Intersections ----
            float sceneObjectIntersect(in int objectID, in vec4 ro, in vec4 rd, in float minDistance, in bool shadowFlag) {
                // TODO: add shadowflag logic
                mat4 objectTransform = uObjectTransforms[usObjectTransformIDs[objectID]];
                return geometryIntersect(usObjectGeometryIDs[objectID], objectTransform * ro, objectTransform * rd, minDistance);
            }
            float sceneRayCast(in vec4 ro, in vec4 rd, in float minDistance, in bool shadowFlag, inout int objectID) {
                float minFoundDistance = minDistance - 1.0;
                for (int i = 0; i < uNumObjects; ++i) {
                    float distance = sceneObjectIntersect(i, ro, rd, minDistance, shadowFlag);
                    if (distance > minDistance && distance < minFoundDistance) {
                        minFoundDistance = distance;
                        objectID = i;
                    }
                }
                return minFoundDistance;
            }
            float sceneRayCast(in vec4 ro, in vec4 rd, in float minDistance, in bool shadowFlag) {
                int objectID = -1;
                return sceneRayCast(ro, rd, minDistance, shadowFlag, objectID);
            }

            // ---- Color ----
            vec4 sceneObjectColor(in int objectID, in vec4 rp, in vec4 rd, inout vec4 reflection_direction, inout vec4 reflection_color) {
                vec4 normal;
                vec2 UV;
                getGeometricMaterialProperties(usObjectGeometryIDs[objectID], uObjectTransforms[usObjectTransformIDs[objectID]] * rp, normal, UV);
                normal = transpose(uObjectInverseTransforms[usObjectTransformIDs[objectID]]) * normal;
                return colorForMaterial(usObjectMaterialIDs[objectID], rp, rd, normal, UV, reflection_direction, reflection_color);
            }
            vec4 sceneRayColor(in vec4 ro, in vec4 rd) {
                vec4 rayColor = uBackgroundColor, attenuation_color = vec4(1.0);
                for (int i = 0; i <= uAllowedBounceDepth; ++i) {
                    int objectID = -1;
                    float distance = sceneRayCast(ro, rd, 0.0, false, objectID);
                    if (objectID == -1)
                        break;
                    
                    vec4 reflection_direction = vec4(0.0), reflection_color = vec4(0.0);
                    rayColor += attenuation_color * sceneObjectColor(objectID, ro + distance * rd, rd, reflection_direction, reflection_color);
                    
                    if (dot(reflection_direction, reflection_direction) == 0.0)
                        break;
                    ro += distance * rd;
                    rd = reflection_direction;
                    attenuation_color *= reflection_color;
                }
                return rayColor;
            }`;
    }
}