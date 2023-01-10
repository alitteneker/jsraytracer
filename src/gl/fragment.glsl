#version 300 es
precision mediump float;

// =============================================
//              Utility Code
// =============================================
#define PI 3.14159265359



// =============================================
//              Geometry Code
// =============================================

// ---- Plane ----
#define GEOMETRY_PLANE_TYPE 1

float planeIntersect(in vec4 ro, in vec4 rd, in float minDistance, in vec4 n, in float delta) {
    float denom = dot(rd, n);
    if (denom == 0.0)
        return minDistance - 1.0;
    return (delta - dot(ro, n)) / denom;
}
float planeIntersect(in vec4 ro, in vec4 rd, in float minDistance) {
    return planeIntersect(ro, rd, minDistance, vec4(0, 0, 1, 0), 0.0);
}
void planeMaterialData(in vec4 position, inout vec4 normal, inout vec2 UV) {
    normal = vec4(0, 0, 1, 0);
    UV = vec2(position.x, position.y);
}


// ---- Sphere ----
#define GEOMETRY_SPHERE_TYPE 2
float unitSphereIntersect(in vec4 ro, in vec4 rd, in float minDistance) {
    float a = dot(rd, rd),
          b = dot(ro, rd),
          c = dot(ro.xyz, ro.xyz) - 1.0;
    float big = b * b - a * c;
    if (big < 0.0 || a == 0.0)
        return minDistance - 1.0;
    big = sqrt(big);
    float t1 = (-b + big) / a,
          t2 = (-b - big) / a;
    if (t1 >= minDistance && t2 >= minDistance)
        return min(t1, t2);
    return (t2 < minDistance) ? t1 : t2;
}

void unitSphereMaterialData(in vec4 position, inout vec4 normal, inout vec2 UV) {
    normal = normalize(position);
    UV.x = 0.5 + atan(normal.z, normal.x) / (2.0 * PI);
    UV.y = 0.5 - asin(normal.y) / PI;
}


// ---- Triangle ----
#define GEOMETRY_TRIANGLE_TYPE 3

#define MAX_TRIANGLES 16
uniform vec4 ugTriangleVertices[MAX_TRIANGLES * 3];
uniform vec4 ugTriangleNormals[MAX_TRIANGLES * 3];
uniform vec2 ugTriangleUVs[MAX_TRIANGLES * 3];

void getTriangleVertices(in int triangleID, out vec4 p1, out vec4 p2, out vec4 p3) {
    p1 = ugTriangleVertices[triangleID * 3];
    p2 = ugTriangleVertices[triangleID * 3 + 1];
    p3 = ugTriangleVertices[triangleID * 3 + 2];
}
void getTriangleNormals(in int triangleID, out vec4 n1, out vec4 n2, out vec4 n3) {
    n1 = ugTriangleNormals[triangleID * 3];
    n2 = ugTriangleNormals[triangleID * 3 + 1];
    n3 = ugTriangleNormals[triangleID * 3 + 2];
}
void getTriangleUVs(in int triangleID, out vec2 uv1, out vec2 uv2, out vec2 uv3) {
    uv1 = ugTriangleUVs[triangleID * 3];
    uv2 = ugTriangleUVs[triangleID * 3 + 1];
    uv3 = ugTriangleUVs[triangleID * 3 + 2];
}
float baryBlend(in vec3 bary, in float v1, in float v2, in float v3) {
    return (bary.x * v1) + (bary.y * v2) + (bary.z * v3);
}
vec2 baryBlend(in vec3 bary, in vec2 v1, in vec2 v2, in vec2 v3) {
    return (bary.x * v1) + (bary.y * v2) + (bary.z * v3);
}
vec3 baryBlend(in vec3 bary, in vec3 v1, in vec3 v2, in vec3 v3) {
    return (bary.x * v1) + (bary.y * v2) + (bary.z * v3);
}
vec4 baryBlend(in vec3 bary, in vec4 v1, in vec4 v2, in vec4 v3) {
    return (bary.x * v1) + (bary.y * v2) + (bary.z * v3);
}
vec3 triangleToBarycentric(in vec4 point, in vec4 p1, in vec4 p2, in vec4 p3) {
    vec4 v0 = p2 - p1,
         v1 = p3 - p1,
         v2 = point - p1;
    float d00 = dot(v0, v0),
          d11 = dot(v1, v1),
          d01 = dot(v0, v1),
          d20 = dot(v2, v0),
          d21 = dot(v2, v1),
          denom = d00 * d11 - d01 * d01,
          v = (d11 * d20 - d01 * d21) / denom,
          w = (d00 * d21 - d01 * d20) / denom;
    return vec3(1.0 - v - w, v, w);
}
float triangleIntersect(in vec4 ro, in vec4 rd, in float minDistance, in vec4 p1, in vec4 p2, in vec4 p3) {
    vec4 normal = vec4(normalize(cross(vec3((p2 - p1).xyz), vec3((p3 - p1).xyz))), 1.0);
    float distance = planeIntersect(ro, rd, minDistance, normal, dot(p1, normal));
    if (distance < minDistance)
        return distance;
    vec3 bary = triangleToBarycentric(ro + (distance * rd), p1, p2, p3);
    if (bary.x >= 0.0 && bary.x <= 1.0 && bary.y >= 0.0 && bary.y <= 1.0 && bary.z >= 0.0 && bary.z <= 1.0)
        return distance;
    return minDistance - 1.0;
}
float triangleIntersect(in vec4 ro, in vec4 rd, in float minDistance, in int triangleID) {
    vec4 p1, p2, p3;
    getTriangleVertices(triangleID, p1, p2, p3);
    return triangleIntersect(ro, rd, minDistance, p1, p2, p3);
}
void triangleMaterialData(in vec4 position, inout vec4 normal, inout vec2 UV, in int triangleID) {
    vec4 p1, p2, p3, n1, n2, n3;
    vec2 uv1, uv2, uv3;
    getTriangleVertices(triangleID, p1, p2, p3);
    getTriangleNormals(triangleID, n1, n2, n3);
    getTriangleUVs(triangleID, uv1, uv2, uv3);
    vec3 bary = triangleToBarycentric(position, p1, p2, p3);
    normal = baryBlend(bary, n1, n2, n3);
    UV = baryBlend(bary, uv1, uv2, uv3);
}

// ---- Generics ----
float geometryIntersect(in int geometryID, in vec4 ro, in vec4 rd, in float minDistance) {
    if (geometryID == GEOMETRY_SPHERE_TYPE)
        return unitSphereIntersect(ro, rd, minDistance);
    if (geometryID == GEOMETRY_PLANE_TYPE)
        return planeIntersect(ro, rd, minDistance);
    if (geometryID == GEOMETRY_TRIANGLE_TYPE)
        return triangleIntersect(ro, rd, minDistance, geometryID - GEOMETRY_TRIANGLE_TYPE);
    return minDistance - 1.0;
}
void getGeometricMaterialProperties(in int geometryID, in vec4 position, inout vec4 normal, inout vec2 UV) {
    if (geometryID == GEOMETRY_SPHERE_TYPE)
        unitSphereMaterialData(position, normal, UV);
    else if (geometryID == GEOMETRY_PLANE_TYPE)
        planeMaterialData(position, normal, UV);
    else if (geometryID == GEOMETRY_TRIANGLE_TYPE)
        triangleMaterialData(position, normal, UV, geometryID - GEOMETRY_TRIANGLE_TYPE);
}


// =============================================
//              Light Code
// =============================================

// ---- Point Lights ----
void samplePointLight(in vec4 rp, in vec4 rd) {
    // TODO
}


// =============================================
//              Material Code
// =============================================

// ---- Simple Material ----
#define MATERIAL_SIMPLE_TYPE 1

#define MAX_SIMPLE_MATERIALS 4
uniform vec4 umSimpleMaterialAmbients[MAX_SIMPLE_MATERIALS];
uniform vec4 umSimpleMaterialDiffuses[MAX_SIMPLE_MATERIALS];
uniform vec4 umSimpleMaterialSpeculars[MAX_SIMPLE_MATERIALS];
uniform float umSimpleMaterialSpecularFactors[MAX_SIMPLE_MATERIALS];
uniform vec4 umSimpleMaterialReflectivities[MAX_SIMPLE_MATERIALS];

void getSimpleMaterialFactors(in int simpleMaterialID, out vec4 ambient, out vec4 diffuse, out vec4 specular, out float specular_factor, out vec4 reflectivity) {
    ambient = umSimpleMaterialAmbients[simpleMaterialID];
    diffuse = umSimpleMaterialDiffuses[simpleMaterialID];
    specular = umSimpleMaterialSpeculars[simpleMaterialID];
    specular_factor = umSimpleMaterialSpecularFactors[simpleMaterialID];
    reflectivity = umSimpleMaterialReflectivities[simpleMaterialID];
}
vec4 simpleMaterialColor(in vec4 ambientColor, in vec4 diffuseColor, in vec4 specularColor, in float specular_factor, in vec4 reflectivityColor, in vec4 rp, in vec4 rd, in vec4 normal, in vec2 UV, inout vec4 reflection_direction, inout vec4 reflection_color) {
    vec4 V = normalize(-rd);
    vec4 N = normalize(normal);
    if (dot(V, N) < 0.0)
        N = -N;
    vec4 R = normalize((2.0 * dot(normal, V) * normal) - V);

    vec4 totalColor = ambientColor;
    // for (int i = 0; i < uNumLights; ++i) {
    //     vec4 lightDirection, lightColor;
    //     sampleLight(i, rp, lightDirection, lightColor);
    //     
    //     float lightIntersection = sceneRayCast(rp, lightDirection, 0.0001, true);
    //     if (lightIntersection <= 0.0 || lightIntersection >= 1.0)
    //         continue;
    //     
    //     lightDirection = normalize(lightDirection);
    //     
    //     // diffuse component
    //     totalColor += max(dot(lightDirection, N), 0.0) * diffuseColor * lightColor;
    //     
    //     // specular component
    //     totalColor += pow(max(dot(lightDirection, R), 0.0), specular_factor) * specularColor * lightColor;
    // }
    // if (dot(reflectivityColor, reflectivityColor) > 0.0) {
    //     reflection_direction = R;
    //     reflection_color = reflectivityColor;
    // }
    return totalColor;
}
vec4 simpleMaterialColor(in int simpleMaterialID, in vec4 rp, in vec4 rd, in vec4 normal, in vec2 UV, inout vec4 reflection_direction, inout vec4 reflection_color) {
    vec4 ambient, diffuse, specular, reflectivity;
    float specular_factor;
    getSimpleMaterialFactors(simpleMaterialID, ambient, diffuse, specular, specular_factor, reflectivity);
    return simpleMaterialColor(ambient, diffuse, specular, specular_factor, reflectivity, rp, rd, normal, UV, reflection_direction, reflection_color);
}

// ---- Generic ----
vec4 colorForMaterial(in int materialID, in vec4 rp, in vec4 rd, in vec4 normal, in vec2 UV, inout vec4 reflection_direction, inout vec4 reflection_color) {
    if (materialID == MATERIAL_SIMPLE_TYPE)
        return simpleMaterialColor(materialID - MATERIAL_SIMPLE_TYPE, rp, rd, normal, UV, reflection_direction, reflection_color);
    return vec4(1.0, 1.0, 1.0, 1.0);
}


// =============================================
//              Scene Querying Code
// =============================================
uniform vec4 uBackgroundColor;
uniform int uAllowedBounceDepth;
uniform int uNumObjects;

uniform mat4 uObjectTransforms[16];
uniform mat4 uObjectInverseTransforms[16];

#define MAX_OBJECTS 64
uniform int usObjectGeometryIDs[MAX_OBJECTS];
uniform int usObjectMaterialIDs[MAX_OBJECTS];
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
}

// =============================================
//              Camera Code
// =============================================
uniform mat4 uCameraTransform;
uniform float uAspect, uFOV;
void computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec4 ro, inout vec4 rd) {
    float tan_fov = tan(uFOV / 2.0);
    ro = uCameraTransform * vec4(0.0, 0.0, 0.0, 1.0);
    rd = uCameraTransform * vec4(canvasPos.x * tan_fov * uAspect, canvasPos.y * tan_fov, -1.0, 0.0);
}

// =============================================
//              Main Rendering Code
// =============================================
uniform vec2 uCanvasSize;
uniform float uTime;
out vec4 outTexelColor;

void main() {
    // TODO: seed noise

    vec2 canvasCoord = 2.0 * (gl_FragCoord.xy / uCanvasSize) - vec2(1.0);
    vec2 pixelSize = 2.0 / uCanvasSize;

    outTexelColor = vec4((canvasCoord.x + 1.0) / 2.0, (canvasCoord.y + 1.0) / 2.0, length(canvasCoord.xy), 1.0);
    
    vec4 ro, rd;
    computeCameraRayForTexel(canvasCoord, pixelSize, ro, rd);
    outTexelColor = sceneRayColor(ro, rd);
}