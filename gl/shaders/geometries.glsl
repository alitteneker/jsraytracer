// Geometry: ray intersection, surface sampling (for area lights) and surface data (normal and UV) for each kind of
// primitive, triangles included, plus the functions that dispatch on a geometry's type. SDFs are in sdf.glsl.
// Rendered by WebGLGeometriesAdapter. Each primitive has sections <name>.intersect, <name>.sample and
// <name>.material, compiled in only when the scene uses them (see WebGLStaticGeometryShaderSource). Holes:
//   declarations: minSdfId, minTriangleId (WebGLGeometriesAdapter.MIN_SDF_ID, MIN_TRIANGLE_ID).
//   generics.*: the switch cases, one case.* per primitive type in use, and triangleIntersect / triangleData, the
//   triangle branches (generics.triangle-*) or nothing when the scene has no triangles.

//#section declarations

#define GEOMETRY_SDF_MIN_INDEX ${minSdfId}
#define GEOMETRY_TRIANGLE_MIN_INDEX ${minTriangleId}

struct GeometricMaterialData {
    vec3 baseColor;
    vec4 normal;
    vec2 UV;
};

uniform sampler2D tTriangleData;
uniform isampler2D tTriangleIndices;

float planeIntersect(in Ray r, in float minDistance, in vec4 n, in float delta);
vec2 AABBIntersects(in Ray r, in vec4 center, in vec4 half_size, in float minDistance, in float maxDistance);

vec4 sampleGeometrySurface(in int geometryID, inout vec2 random_seed);
float geometryIntersect(in int geometryID, in Ray r, in float minDistance);
GeometricMaterialData getGeometricMaterialData(in int geometryID, in vec4 position, in vec4 direction);
GeometricMaterialData getSampleGeometricMaterialData(in int geometryID, in vec4 position, in vec4 direction);

//#section declarations.generics

float geometryIntersect(in int geometryID, in Ray r, in float minDistance);
vec4 sampleGeometrySurface(in int geometryID, inout vec2 random_seed);

//#section helpers

float planeIntersect(in Ray r, in float minDistance, in vec4 n, in float delta) {
    float denom = dot(r.d, n);
    if (abs(denom) < EPSILON)
        return minDistance - 1.0;
    return (delta - dot(r.o, n)) / denom;
}
vec2 AABBIntersects(in Ray r, in vec4 center, in vec4 half_size, in float minDistance, in float maxDistance) {
    float t_min = minDistance - 1.0, t_max = maxDistance + 1.0;
    vec4 p = center - r.o;
    for (int i = 0; i < 3; ++i) {
        if (abs(r.d[i]) > EPSILON) {
            float t1 = (p[i] + half_size[i]) / r.d[i],
                  t2 = (p[i] - half_size[i]) / r.d[i];
            if (t1 > t2) {
                float tmp = t1;
                t1 = t2;
                t2 = tmp;
            }
            if (t1 > t_min)
                t_min = t1;
            if (t2 < t_max)
                t_max = t2;
            if (t_min > t_max || t_max < minDistance || t_min > maxDistance)
                return vec2(minDistance - 1.0, minDistance - 1.0); //TODO: this needs to be infinite
        }
        else if (abs(p[i]) > half_size[i])
            return vec2(minDistance - 1.0, minDistance - 1.0);
    }
    return vec2(t_min, t_max);
}

//#section plane.intersect

float planeIntersect(in Ray r, in float minDistance) {
    return planeIntersect(r, minDistance, vec4(0, 0, 1, 0), 0.0);
}

//#section plane.material

void planeMaterialData(in vec4 position, inout GeometricMaterialData data) {
    data.normal = vec4(0, 0, 1, 0);
    data.UV = vec2(position.x, position.y);
}

//#section sphere.intersect

float sphereIntersect(in Ray r, in float minDistance) {
    float a = dot(r.d, r.d),
          b = dot(r.o, r.d),
          c = dot(r.o.xyz, r.o.xyz) - 1.0;
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

//#section sphere.sample

vec4 sphereSurfaceSample(inout vec2 random_seed) {
    return vec4(randomSpherePoint(random_seed), 1);
}

//#section sphere.material

void sphereMaterialData(in vec4 position, inout GeometricMaterialData data) {
    data.normal = vec4(normalize(position.xyz), 0);
    data.UV.x = 0.5 + atan(data.normal.z, data.normal.x) / (2.0 * PI);
    data.UV.y = 0.5 - asin(data.normal.y) / PI;
}

//#section unitBox.intersect

float unitBoxIntersect(in Ray r, in float minDistance) {
    vec2 t = AABBIntersects(r, vec4(0,0,0,1), vec4(0.5, 0.5, 0.5, 0), minDistance, 1e20);
    return (!isinf(t.x) && t.x >= minDistance) ? t.x : t.y;
}

//#section unitBox.material

void unitBoxMaterialData(in vec4 p, inout GeometricMaterialData data) {
    float norm_dist = 0.0;
    data.normal = vec4(0.0);
    for (int i = 0; i < 3; ++i) {
        float comp = p[i] / 0.5;
        float abs_comp = abs(comp);
        if (abs_comp > norm_dist) {
            norm_dist = abs_comp;
            data.normal = vec4(0.0);
            data.normal[i] = sign(comp);
        }
    }

    // TODO: what to do about UV?
}

//#section circle.intersect

float circleIntersect(in Ray r, in float minDistance) {
    float t = planeIntersect(r, minDistance);
    if (t < minDistance)
        return t;
    vec4 p = r.o + t * r.d;
    return (dot(p.xy, p.xy) <= 1.0) ? t : (minDistance - 1.0);
}

//#section circle.sample

// Uniform over the unit disk, so circles can be area lights (matches Circle.sampleSurface).
vec4 circleSurfaceSample(inout vec2 random_seed) {
    float r = sqrt(randf(random_seed)), theta = 2.0 * PI * randf(random_seed);
    return vec4(r * cos(theta), r * sin(theta), 0, 1);
}

//#section circle.material

void circleMaterialData(in vec4 position, inout GeometricMaterialData data) {
    planeMaterialData(position, data);
}

//#section square.intersect

float squareIntersect(in Ray r, in float minDistance) {
    float t = planeIntersect(r, minDistance);
    if (t < minDistance)
        return t;
    vec4 p = r.o + t * r.d;
    return all(lessThanEqual(abs(p.xy), vec2(0.5))) ? t : (minDistance - 1.0);
}

//#section square.sample

vec4 squareSurfaceSample(inout vec2 random_seed) {
    return vec4(randf(random_seed) - 0.5, randf(random_seed) - 0.5, 0, 1);
}

//#section square.material

void squareMaterialData(in vec4 position, inout GeometricMaterialData data) {
    planeMaterialData(position, data);
    data.UV += vec2(0.5);
}

//#section cylinder.intersect

float cylinderIntersect(in Ray r, in float minDistance) {
    float cylMinDistance = minDistance;
    if (abs(r.o.z) > 1.0 && r.d.z != 0.0)
        cylMinDistance = max(minDistance, -(r.o.z - sign(r.o.z)) / r.d.z);
    float t = sphereIntersect(Ray(r.o * vec4(1,1,0,1), r.d * vec4(1,1,0,1)), cylMinDistance);
    return (abs(r.o.z + t * r.d.z) <= 1.0) ? t : minDistance - 1.0;
}

//#section cylinder.material

void cylinderMaterialData(in vec4 position, inout GeometricMaterialData data) {
    data.normal = vec4(normalize(position.xy), 0, 0);
    data.UV.x = 0.5 + atan(position.y, position.x) / (2.0 * PI),
    data.UV.y = 0.5 + position.z;
}

//#section originPoint.sample

vec4 originPointSurfaceSample(inout vec2 random_seed) {
    return vec4(0,0,0,1);
}

//#section originPoint.material

void originPointMaterialData(in vec4 position, in vec4 direction, inout GeometricMaterialData data) {
    data.normal = normalize(-direction);
    data.UV.x = 0.5 + atan(data.normal.z, data.normal.x) / (2.0 * PI);
    data.UV.y = 0.5 - asin(data.normal.y) / PI;
}

//#section unitLine.sample

vec4 unitLineSurfaceSample(inout vec2 random_seed) {
    return vec4(0, randf(random_seed) - 0.5, 0, 1);
}

//#section unitLine.material

void unitLineMaterialData(in vec4 position, in vec4 direction, inout GeometricMaterialData data) {
    vec2 n = normalize(-direction.xz);

    data.normal = vec4(n.x, 0, n.y, 0);
    data.UV.x = 0.5 + atan(n.y, n.x) / (2.0 * PI),
    data.UV.y = 0.5 + position.y;
}

//#section triangle.declarations

float triangleIntersect(in Ray r, in float minDistance, in int triangleID);
void triangleMaterialData(in vec4 position, inout GeometricMaterialData data, in int triangleID);

//#section triangle.source

vec3 getTriangleData(in int index) {
    return texelFetchByIndex(index, tTriangleData).rgb;
}
ivec3 getTriangleIndices(in int triangleID, in int dataOffset) {
    return itexelFetchByIndex(triangleID * 3 + dataOffset, tTriangleIndices).rgb;
}
void getTriangleVertices(in int triangleID, out vec4 p1, out vec4 p2, out vec4 p3) {
    ivec3 indices = getTriangleIndices(triangleID, 0);
    p1 = vec4(getTriangleData(indices[0]), 1);
    p2 = vec4(getTriangleData(indices[1]), 1);
    p3 = vec4(getTriangleData(indices[2]), 1);
}
void getTriangleNormals(in int triangleID, out vec4 n1, out vec4 n2, out vec4 n3) {
    ivec3 indices = getTriangleIndices(triangleID, 1);
    n1 = vec4(getTriangleData(indices[0]), 0);
    n2 = vec4(getTriangleData(indices[1]), 0);
    n3 = vec4(getTriangleData(indices[2]), 0);
}
void getTriangleUVs(in int triangleID, out vec2 uv1, out vec2 uv2, out vec2 uv3) {
    ivec3 indices = getTriangleIndices(triangleID, 2);
    uv1 = vec2(getTriangleData(indices[0]).xy);
    uv2 = vec2(getTriangleData(indices[1]).xy);
    uv3 = vec2(getTriangleData(indices[2]).xy);
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
// Moller-Trumbore: one reciprocal and no normalize. Returns t along the (unnormalized) ray direction, or
// minDistance - 1.0 on a miss. The parallel cutoff is on the unnormalized determinant.
float triangleIntersect(in Ray r, in float minDistance, in vec4 p1, in vec4 p2, in vec4 p3) {
    vec3 e1 = p2.xyz - p1.xyz, e2 = p3.xyz - p1.xyz;
    vec3 pv = cross(r.d.xyz, e2);
    float det = dot(e1, pv);
    if (abs(det) < 1e-20)
        return minDistance - 1.0;
    float invDet = 1.0 / det;
    vec3 tv = r.o.xyz - p1.xyz;
    float u = dot(tv, pv) * invDet;
    vec3 qv = cross(tv, e1);
    float v = dot(r.d.xyz, qv) * invDet;
    if (u < 0.0 || v < 0.0 || u + v > 1.0)
        return minDistance - 1.0;
    return dot(e2, qv) * invDet;
}
// Each triangle's three positions also sit in 3 consecutive texels of tTriangleVerts, so intersection needs no
// index lookup and the three fetches don't wait on one. (Shading still reads the indexed data, for normals and UVs.)
uniform sampler2D tTriangleVerts;
float triangleIntersect(in Ray r, in float minDistance, in int triangleID) {
    vec4 p1 = vec4(texelFetchByIndex(triangleID * 3,     tTriangleVerts).rgb, 1);
    vec4 p2 = vec4(texelFetchByIndex(triangleID * 3 + 1, tTriangleVerts).rgb, 1);
    vec4 p3 = vec4(texelFetchByIndex(triangleID * 3 + 2, tTriangleVerts).rgb, 1);
    return triangleIntersect(r, minDistance, p1, p2, p3);
}
void triangleMaterialData(in vec4 position, inout GeometricMaterialData data, in int triangleID) {
    vec4 p1, p2, p3, n1, n2, n3;
    vec2 uv1, uv2, uv3;
    getTriangleVertices(triangleID,  p1,  p2,  p3);
    getTriangleNormals( triangleID,  n1,  n2,  n3);
    getTriangleUVs(     triangleID, uv1, uv2, uv3);

    vec3 bary = triangleToBarycentric(position, p1, p2, p3);

    data.normal = baryBlend(bary,  n1,  n2,  n3);
    data.UV     = baryBlend(bary, uv1, uv2, uv3);
}

//#section case.return

        case ${type}: return ${expression}; break;
//#section case.statement

        case ${type}: ${statement}; break;
//#section generics.sampling




// ---------- Generics ----------
vec4 sampleGeometrySurface(in int geometryID, inout vec2 random_seed) {
    switch(geometryID) {${sampleCases}
    }
    return vec4(0);
}
GeometricMaterialData getSampleGeometricMaterialData(in int geometryID, in vec4 position, in vec4 direction) {
    GeometricMaterialData data;
    data.baseColor = vec3(1.0);
    switch(geometryID) {${sampleDataCases}
    }
    return data;
}

//#section generics.dispatch

float geometryIntersect(in int geometryID, in Ray r, in float minDistance) {
    if (geometryID < GEOMETRY_SDF_MIN_INDEX) {
        switch(geometryID) {${intersectCases}
            default: return minDistance - 1.0;
        }
    }
    else {
        if (geometryID < GEOMETRY_TRIANGLE_MIN_INDEX)
            return sdfIntersect(r, minDistance, geometryID - GEOMETRY_SDF_MIN_INDEX);${triangleIntersect}
    }
    return minDistance - 1.0;
}
GeometricMaterialData getGeometricMaterialData(in int geometryID, in vec4 position, in vec4 direction) {
    GeometricMaterialData data;
    data.baseColor = vec3(1.0);
    if (geometryID < GEOMETRY_SDF_MIN_INDEX) {
        switch(geometryID) {${dataCases}
        }
    }
    else {
        if (geometryID < GEOMETRY_TRIANGLE_MIN_INDEX)
            sdfMaterialData(position, data, geometryID - GEOMETRY_SDF_MIN_INDEX);${triangleData}
    }
    return data;
}

//#section generics.triangle-intersect

        else
            return triangleIntersect(r, minDistance, geometryID - GEOMETRY_TRIANGLE_MIN_INDEX);
//#section generics.triangle-data

        else
            triangleMaterialData(position, data, geometryID - GEOMETRY_TRIANGLE_MIN_INDEX);
//#section generics.none

GeometricMaterialData getGeometricMaterialData(in int geometryID, in vec4 position, in vec4 direction) {
    GeometricMaterialData data;
    data.baseColor = vec3(1.0);
    return data;
}
float geometryIntersect(in int geometryID, in Ray r, in float minDistance) {
    return minDistance - 1.0;
}
