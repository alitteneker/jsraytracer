// Light sampling for direct lighting: picking a point on a light and returning the light it sends toward a surface
// point, with the density of that choice (for MIS). Rendered by WebGLLightsAdapter.
// Holes in source: lightTypeWorld, lightTypeDirectional, lightTypeArea (WebGLLightsAdapter.LIGHT_TYPE_*), and
// maxLights, the length of the light arrays.

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
// Le A |cos_light| / d^2 = color |cos_light| / (2 pi d^2). See src/lights.js.
float lightFalloff(in vec4 delta, in int type) {
    float norm_squared = dot(delta, delta);
    if (norm_squared < EPSILON)
        return 0.0;
    return 1.0 / ((type == LIGHT_TYPE_AREA ? 2.0 : 4.0) * PI * norm_squared);
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

    if (light.type == LIGHT_TYPE_DIRECTIONAL)
        world_pos += surface_position;

    vec4 delta = world_pos - surface_position;
    GeometricMaterialData material_data = getSampleGeometricMaterialData(light.geometry_id, local_pos, light.inv_transform * delta);
    float cosLight = abs(dot(normalize(delta.xyz), normalize((transpose(light.inv_transform) * material_data.normal).xyz)));
    // Uniform area sampling, converted to solid angle: pdf = d^2 / (A |cos_light|).
    float pdf = 0.0;
    if (light.type == LIGHT_TYPE_AREA)
        pdf = cosLight > 0.0 ? dot(delta.xyz, delta.xyz) / (uLightAreas[lightID] * cosLight) : 1e30;
    return LightSample(delta,
        getMaterialColor(light.color_mc, material_data.UV) * lightFalloff(delta, light.type) * cosLight,
        pdf);
}
