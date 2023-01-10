const geometry_glsl_source = `
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
}`;

