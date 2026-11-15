// Light sampling for direct lighting: picking a point on a light and returning the light it sends toward a surface
// point, with the density of that choice (for MIS). Rendered by WebGLLightsAdapter.
// Holes in declarations: visibleDirectional. In source: lightTypeWorld, lightTypeDirectional, lightTypeArea
// (WebGLLightsAdapter.LIGHT_TYPE_*), and maxLights, the length of the light arrays.

//#section declarations

uniform int uNumLights;
struct LightStruct {
    int type;
    int geometry_id;
    int color_mc;
    mat4 transform;
    mat4 inv_transform;
};
// direction: toward the sampled point (unnormalized; it's also the shadow ray). color: the radiance
// arriving along it divided by pdf. pdf: the density of choosing that direction, per unit solid angle, or 0
// for a point light, which has exactly one.
struct LightSample {
    vec4 direction;
    vec3 color;
    float pdf;
};
LightSample sampleLight(in int lightID, in vec4 position, inout vec2 random_seed);
bool lightsRayCastDirectional(in Ray r, in float maxT, out vec3 Le, out float lightPdf);
// Whether any directional light has a shape rays can see (see lightsRayCastDirectional). Here, so the integrator
// (renderer.glsl, which comes first) can test it too.
#define LIGHTS_VISIBLE_DIRECTIONAL ${visibleDirectional}

//#section source

#define LIGHT_TYPE_WORLD ${lightTypeWorld}
#define LIGHT_TYPE_DIRECTIONAL ${lightTypeDirectional}
#define LIGHT_TYPE_AREA ${lightTypeArea}

#define MAX_LIGHTS ${maxLights}
uniform int  uLightTypes[MAX_LIGHTS];
uniform int  uLightGeometries[MAX_LIGHTS];
uniform int  uLightColorMCs[MAX_LIGHTS];
uniform mat4 uLightTransforms[MAX_LIGHTS * 2];
uniform float uLightAreas[MAX_LIGHTS];

// A light's color is its power. A point light spreads it over the whole sphere, so the irradiance at
// distance d is color / (4 pi d^2). An area light emits from both sides of its surface as a Lambertian
// emitter, radiance Le = color / (2 pi A); a point picked uniformly on it (density 1 / A) brings
// Le A |cos_light| / d^2 = color |cos_light| / (2 pi d^2). A directional light is either, depending on
// its geometry (uLightAreas is 0 for a point). See src/lights.js.
float lightFalloff(in vec4 delta, in bool hasArea) {
    float norm_squared = dot(delta, delta);
    if (norm_squared < EPSILON)
        return 0.0;
    return 1.0 / ((hasArea ? 2.0 : 4.0) * PI * norm_squared);
}
LightStruct getLight(in int lightID) {
    return LightStruct(uLightTypes[lightID],
                       uLightGeometries[lightID],
                       uLightColorMCs[lightID],
                       uLightTransforms[lightID * 2],
                       uLightTransforms[lightID * 2 + 1]);
}
LightSample sampleLight(in int lightID, in vec4 surface_position, inout vec2 random_seed) {
    LightStruct light = getLight(lightID);

    vec4 local_pos = sampleGeometrySurface(light.geometry_id, random_seed);
    vec4 world_pos = light.transform * local_pos;

    // A directional light's transform is relative to the point being shaded (see src/lights.js). Shadow rays still
    // stop at the sampled point, so only things nearer than the light can block it.
    if (light.type == LIGHT_TYPE_DIRECTIONAL)
        world_pos.xyz += surface_position.xyz;

    vec4 delta = world_pos - surface_position;
    GeometricMaterialData material_data = getSampleGeometricMaterialData(light.geometry_id, local_pos, light.inv_transform * delta);
    float cosLight = abs(dot(normalize(delta.xyz), normalize((transpose(light.inv_transform) * material_data.normal).xyz)));
    // Uniform area sampling, converted to solid angle: pdf = d^2 / (A |cos_light|). 0 marks a delta sample (full
    // weight in MIS): a point light, or a directional light that is a point, which BSDF sampling can never hit.
    bool hasArea = light.type == LIGHT_TYPE_AREA || (light.type == LIGHT_TYPE_DIRECTIONAL && uLightAreas[lightID] > 0.0);
    float pdf = 0.0;
    if (hasArea)
        pdf = cosLight > 0.0 ? dot(delta.xyz, delta.xyz) / (uLightAreas[lightID] * cosLight) : 1e30;
    return LightSample(delta,
        getMaterialColor(light.color_mc, material_data.UV) * lightFalloff(delta, hasArea) * cosLight,
        pdf);
}

// Directional lights as rays see them. A ray from o sees a directional light's shape at o + its transform, so in the
// light's own space every ray starts at transform^-1 * origin, wherever o is: the test depends only on the ray's
// direction, and never involves the world's BVH. Returns whether one is hit before maxT (in r's own parameter); if
// so, the nearest one's radiance along r (an area light's, Le = power / (2 pi A)), and the density with which light
// sampling would have picked that point (for MIS, like an area light's emitter).
bool lightsRayCastDirectional(in Ray r, in float maxT, out vec3 Le, out float lightPdf) {
    bool found = false;
    Le = vec3(0);
    lightPdf = 0.0;
#if LIGHTS_VISIBLE_DIRECTIONAL
    float nearest = maxT;
    for (int i = 0; i < uNumLights; ++i) {
        if (uLightTypes[i] != LIGHT_TYPE_DIRECTIONAL || uLightAreas[i] <= 0.0)
            continue;
        LightStruct light = getLight(i);
        Ray local = Ray(light.inv_transform * vec4(0, 0, 0, 1), light.inv_transform * vec4(r.d.xyz, 0));
        float t = geometryIntersect(light.geometry_id, local, EPSILON);
        if (t < EPSILON || t >= nearest)
            continue;
        GeometricMaterialData data = getGeometricMaterialData(light.geometry_id, local.o + t * local.d, local.d);
        vec3 n = normalize((transpose(light.inv_transform) * data.normal).xyz);
        float distance = t * length(r.d.xyz);
        float cosLight = abs(dot(normalize(r.d.xyz), n));
        Le = getMaterialColor(light.color_mc, data.UV) / (2.0 * PI * uLightAreas[i]);
        lightPdf = cosLight > 0.0 ? distance * distance / (uLightAreas[i] * cosLight) : 1e30;
        nearest = t;
        found = true;
    }
#endif
    return found;
}
