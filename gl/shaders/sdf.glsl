// Signed distance fields: sphere tracing each SDF geometry, and the helpers its distance functions use. The distance
// and material code of each SDF is generated from its tree, by the node decorators in WebGLSDFAdapter.js; this file
// holds what's the same for every SDF. Rendered by WebGLSDFAdapter. Holes: id, the SDF's index, in the per-SDF
// sections (declarations.geometry, geometry, dispatch.*); in geometry, distance and material, the generated
// expressions for the SDF's root; in source, intersectDispatch and materialDispatch, one dispatch.* per SDF.

//#section declarations

// =============== SDF ===============
float sdfIntersect(in Ray r, in float minDistance, in int sdfID);
void sdfMaterialData(in vec4 position, inout GeometricMaterialData data, in int sdfID);
//#section declarations.geometry

float sdfIntersect_${id}(in Ray r, in float minDistance);
void sdfMaterialData_${id}(in vec4 position, inout GeometricMaterialData data);
//#section none

// =============== SDF ===============
float sdfIntersect(in Ray r, in float minDistance, in int sdfID) { return minDistance - 1.0; }
void sdfMaterialData(in vec4 position, inout GeometricMaterialData data, in int sdfID) {}
//#section source

// =============== SDF ===============
float sdfBoxDistance(in vec4 p, in vec4 size) {
    p = abs(p) - size;
    return length(max(p.xyz, vec3(0.0))) + min(max(p[0], max(p[1], p[2])), 0.0);
}
float sdfUnitTetrahedronDistance(in vec4 p) {
    return (max(abs(p[0] + p[1]) - p[2],
                abs(p[0] - p[1]) + p[2]) - 1.0) / sqrt(3.0);
}
float sdfSmoothMin(in float a, in float b, in float k) {
    float h = max( k - abs( a - b ), 0.0 ) / k;
    return min( a, b ) - h * h * h * k * (1.0 / 6.0);
}
float sdfSmoothMinBlend(in float a, in float b, in float k) {
    float h = max( k - abs( a - b ), 0.0 ) / k;
    float m = h * h * h * 0.5;
    return (a < b) ? m : (1.0 - m);
}
GeometricMaterialData sdfBlendMaterialData(in float mix_factor, in GeometricMaterialData data_a, in GeometricMaterialData data_b) {
    if      (mix_factor <= 0.0) return data_a;
    else if (mix_factor >= 1.0) return data_b;
    GeometricMaterialData ret;
    ret.baseColor = mix(data_a.baseColor, data_b.baseColor, mix_factor);
    ret.UV = mix(data_a.UV, data_b.UV, mix_factor);
    return ret;
}
float sdfIntersect(in Ray r, in float minDistance, in int sdfID) {
${intersectDispatch}
    return minDistance - 1.0;
}
void sdfMaterialData(in vec4 position, inout GeometricMaterialData data, in int sdfID) {
${materialDispatch}
}
//#section dispatch.intersect
    if (sdfID == ${id}) return sdfIntersect_${id}(r, minDistance);
//#section dispatch.material
    if (sdfID == ${id}) sdfMaterialData_${id}(position, data);
//#section geometry

uniform int sdf_${id}_max_samples;
uniform float sdf_${id}_distance_epsilon;
uniform float sdf_${id}_max_trace_distance;
uniform float sdf_${id}_normal_step_size;
uniform vec3 sdf_${id}_aabb_min;
uniform vec3 sdf_${id}_aabb_max;

float sdfGeometryDistance_${id}(in vec4 position) {
    return ${distance};
}
float sdfIntersect_${id}(in Ray r, in float minDistance) {
    float rd_norm = length(r.d);
    float t = minDistance, tEnd = minDistance + sdf_${id}_max_trace_distance / rd_norm;
#if DEBUG_SDF_BOUNDS
    // March only inside the SDF's bounding box (a slab test, in the SDF's own space): start where the
    // ray enters it and stop where it leaves. Rays that miss it entirely cost nothing.
    {
        vec3 invD = 1.0 / r.d.xyz;
        vec3 t0 = (sdf_${id}_aabb_min - r.o.xyz) * invD, t1 = (sdf_${id}_aabb_max - r.o.xyz) * invD;
        vec3 tn = min(t0, t1), tf = max(t0, t1);
        float tEnter = max(max(tn.x, tn.y), tn.z), tExit = min(min(tf.x, tf.y), tf.z);
        if (tExit < tEnter || tExit < minDistance)
            return minDistance - 1.0;
        if (!isnan(tEnter) && !isnan(tExit)) {
            t = max(t, tEnter);
            tEnd = min(tEnd, tExit + sdf_${id}_distance_epsilon / rd_norm);
        }
    }
#endif
    for (int i = 0; i < sdf_${id}_max_samples; ++i) {
        float distance = sdfGeometryDistance_${id}(r.o + t * r.d);

        if (isinf(distance) || isnan(distance))
            break;

        if (distance <= sdf_${id}_distance_epsilon)
            return t;

        t += distance / rd_norm;
        if (t < minDistance || t > tEnd)
            break;
    }
    return minDistance - 1.0;
}
void sdfMaterialData_${id}(in vec4 position, inout GeometricMaterialData data) {
    float distance = sdfGeometryDistance_${id}(position);
    for (int i = 0; i < 3; ++i)
        data.normal[i] = (sdfGeometryDistance_${id}(position + sdf_${id}_normal_step_size * unitAxis4(i)) - distance) / sdf_${id}_normal_step_size;

    GeometricMaterialData sdf_data = ${material};
    data.UV = sdf_data.UV;
    data.baseColor = sdf_data.baseColor;
}
