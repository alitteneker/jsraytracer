// Materials: where the shader finds each material's parameters and colors, the legacy Phong shading model, and the
// surface interface the integrator (rendererRayColor, in renderer.glsl) shades with. Path tracing, and materials
// other than the Phong ones, also use bsdf.glsl, which then provides the surface interface instead (sections
// generic and bsdf.glsl:source are alternatives).
//
// The surface interface: at each hit, worldObjectSurface calls materialSurface, which sets up the current surface
// and returns the light it emits. The integrator then asks the surface how much light it reflects toward each light
// (surfaceEval), casts the shadow rays itself, and has the surface choose the next ray (surfaceSampleNextRays). For
// MIS on a light hit by a sampled ray, surfaceEmitterPdf gives the density light sampling would have picked the same
// point with. Materials never cast rays, and know nothing of the path that reached them.
// Rendered by WebGLMaterialsAdapter. Holes:
//   declarations: the type numbers (WebGLMaterialsAdapter.SPECIAL_COLOR_* and TYPE_*).
//   storage.uniforms: colorCount, indexCount, the sizes of the parameter arrays when they fit in uniforms.
//   colors: specialColorCount, the size of the special color array, and textureSampling: colors.textures (with
//     textureCount and textureCases, one colors.texture-case per texture size) when the scene has textures, and
//     colors.no-textures otherwise.
// The parameters live in textures (storage.textures: for the editable shader, and for scenes with too many to fit in
// uniforms) or in uniform arrays (storage.uniforms).

//#section declarations

#define MATERIALCOLOR_SPECIAL_CHECKERBOARD ${specialColorCheckerboard}
#define MATERIALCOLOR_SPECIAL_TEXTURE      ${specialColorTexture}
#define MATERIAL_TYPE_PHONG                ${typePhong}
#define MATERIAL_TYPE_FRESNEL_PHONG        ${typeFresnelPhong}
#define MATERIAL_TYPE_PHONG_PATH           ${typePhongPath}
#define MATERIAL_TYPE_PRINCIPLED           ${typePrincipled}
#define MATERIAL_TYPE_EMITTER              ${typeEmitter}
void getMaterialIndices(in int materialID, out ivec4 mat_ind_0, out ivec4 mat_ind_1, out ivec4 mat_ind_2);
vec3 getMaterialColor(in int color_index, in vec2 UV);
vec3 materialSurface(in int materialID, in vec4 rp, in Ray r, in GeometricMaterialData data);
void surfaceClear();
float surfaceEmitterPdf();
bool surfaceWantsDirectLight();
vec3 surfaceEval(in vec4 lightDirection, out float pdf, out float cosFactor);
void surfaceSampleNextRays(inout vec2 random_seed, inout RecursiveNextRays nextRays);

//#section parameters

struct PhongMaterialParameters {
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
    vec3 reflectivity;
    vec3 transmissivity;
    float specularFactor;
    float refractiveIndexRatio;
    float mirrorProbability;
};

//#section storage.textures

uniform  sampler2D umMaterialColors;
vec3 getSolidColor(in int color_index) {
    return texelFetchByIndex(color_index, umMaterialColors).xyz;
}

uniform isampler2D umMaterialIndices;
void getMaterialIndices(in int materialID, out ivec4 mat_ind_0, out ivec4 mat_ind_1, out ivec4 mat_ind_2) {
    mat_ind_0 = itexelFetchByIndex(materialID * 3    , umMaterialIndices);
    mat_ind_1 = itexelFetchByIndex(materialID * 3 + 1, umMaterialIndices);
    mat_ind_2 = itexelFetchByIndex(materialID * 3 + 2, umMaterialIndices);
}

//#section storage.uniforms

uniform vec3 uMaterialColors[ ${colorCount}];
vec3 getSolidColor(in int color_index) {
    return uMaterialColors[color_index];
}

uniform ivec4 uMaterialIndices[${indexCount}];
void getMaterialIndices(in int materialID, out ivec4 mat_ind_0, out ivec4 mat_ind_1, out ivec4 mat_ind_2) {
    mat_ind_0 = uMaterialIndices[materialID * 3    ];
    mat_ind_1 = uMaterialIndices[materialID * 3 + 1];
    mat_ind_2 = uMaterialIndices[materialID * 3 + 2];
}

//#section colors.texture-case

        case ${i}: return texelFetch(umTextures[${i}], texel, 0).xyz;
//#section colors.textures

// Images live in atlases, one per color space (WebGLMaterialsAdapter.textureRef): array textures whose pages hold many
// images side by side. A texture special color says where its image is (WebGLMaterialsAdapter.specialColorData).
// Filtering is done here from four texels, exactly as the CPU's TextureMaterialColor.color does it: the image's top
// row is V = 1, texel centers sit at half-integers, a clamped axis repeats its edge texels and an unclamped one wraps
// around, all within the image's own rectangle. There are no mipmaps: rays don't come with screen-space derivatives
// to pick a level with, and the jittered samples average the texture over each pixel anyway.
uniform highp sampler2DArray umTextures[${textureCount}];

vec3 atlasTexel(in int atlas, in ivec3 texel) {
    switch (atlas) {
        ${textureCases}
        default: break;
    }
    return vec3(1.0, 0.5, 1.0);
}
int textureWrap(in int i, in int n, in bool clampAxis) {
    return clampAxis ? clamp(i, 0, n - 1) : ((i % n) + n) % n;
}
vec3 sampleTexture(in ivec4 ref, in vec2 UV) {
    int atlas = (ref.x >> 8) & 15, page = ref.x >> 15;
    bool clampU = (ref.x & 0x1000) != 0, clampV = (ref.x & 0x2000) != 0, nearest = (ref.x & 0x4000) != 0;
    ivec2 origin = ivec2(ref.z & 0xffff, ref.z >> 16), size = ivec2(ref.w & 0xffff, ref.w >> 16);
    vec2 st = vec2(UV.x, 1.0 - UV.y) * vec2(size) - 0.5;
    vec2 f = nearest ? vec2(0.0) : fract(st);
    ivec2 i0 = nearest ? ivec2(round(st)) : ivec2(floor(st));
    ivec2 a = ivec2(textureWrap(i0.x, size.x, clampU), textureWrap(i0.y, size.y, clampV)) + origin;
    ivec2 b = ivec2(textureWrap(i0.x + 1, size.x, clampU), textureWrap(i0.y + 1, size.y, clampV)) + origin;
    return mix(mix(atlasTexel(atlas, ivec3(a.x, a.y, page)), atlasTexel(atlas, ivec3(b.x, a.y, page)), f.x),
               mix(atlasTexel(atlas, ivec3(a.x, b.y, page)), atlasTexel(atlas, ivec3(b.x, b.y, page)), f.x), f.y);
}
//#section colors.no-textures

vec3 sampleTexture(in ivec4 ref, in vec2 UV) {
    return vec3(1.0, 0.5, 1.0);
}
//#section colors

${textureSampling}

uniform ivec4 umSpecialColors[${specialColorCount}];

vec3 getMaterialColor(in int color_index, in vec2 UV) {

    // Special colors
    if (color_index < 0) {
        ivec4 special_color = umSpecialColors[-color_index - 1];

        // checkerboard color
        if (special_color.x == MATERIALCOLOR_SPECIAL_CHECKERBOARD)
            return getSolidColor((mod(floor(UV.x) + floor(UV.y), 2.0) < 1.0) ? special_color.y : special_color.z);

        // texture color
        if ((special_color.x & 255) == MATERIALCOLOR_SPECIAL_TEXTURE)
            return sampleTexture(special_color, UV) * getSolidColor(special_color.y);

        // something has gone wrong
        return vec3(1.0, 0.5, 1.0);
    }

    // Solid color
    return getSolidColor(color_index);
}

//#section phong

void getPhongMaterialParameters(in int materialID, in GeometricMaterialData geodata, out PhongMaterialParameters matParams) {
#if DEBUG_CONST_MATERIAL_PARAMS
    // Diagnostic: constant parameters instead of fetched ones, chosen to keep the same downstream
    // branches as a typical reflective, non-refractive material (so only the fetch cost is removed).
    matParams.ambient              = geodata.baseColor * vec3(0.1);
    matParams.diffuse              = geodata.baseColor * vec3(0.4);
    matParams.specular             = vec3(0.6);
    matParams.reflectivity         = vec3(0.3);
    matParams.transmissivity       = vec3(0.0);
    matParams.specularFactor       = 100.0;
    matParams.refractiveIndexRatio = uintBitsToFloat(0x7f800000u); // +infinity: no refraction, matches Ni=inf
    matParams.mirrorProbability    = 1.0;
#else
    ivec4 mat_ind_0, mat_ind_1, mat_ind_2;
    getMaterialIndices(materialID, mat_ind_0, mat_ind_1, mat_ind_2);
    matParams.ambient              = geodata.baseColor * getMaterialColor(mat_ind_0[1], geodata.UV);
    matParams.diffuse              = geodata.baseColor * getMaterialColor(mat_ind_0[2], geodata.UV);
    matParams.specular             =                     getMaterialColor(mat_ind_0[3], geodata.UV);
    matParams.reflectivity         =                     getMaterialColor(mat_ind_1[0], geodata.UV);
    matParams.transmissivity       =                     getMaterialColor(mat_ind_1[1], geodata.UV);
    matParams.specularFactor       =                     getMaterialColor(mat_ind_1[2], geodata.UV).r;
    matParams.refractiveIndexRatio =                     getMaterialColor(mat_ind_1[3], geodata.UV).r;
    matParams.mirrorProbability    =                     getMaterialColor(mat_ind_2[0], geodata.UV).r;
#endif
}

void computeRefractionParameters(in vec4 V, in vec4 N, in float vdotn, in float refractiveIndexRatio, in bool backside,
    out vec4 refractionDirection, out float kr)
{
    if (refractiveIndexRatio > 0.0 && !isinf(refractiveIndexRatio)) {

        // compute the split between reflected light and refracted light
        {
            float ni = backside ? refractiveIndexRatio : 1.0,
                  nt = backside ? 1.0 : refractiveIndexRatio;
            float cosi = vdotn,
                  sint = ni / nt * sqrt(max(0.0, 1.0 - cosi * cosi));

            // Partial reflection/refraction, with a factor of kr being reflected, and (1-kr) being refracted
            if (sint < 1.0) {
                float cost = sqrt(max(0.0, 1.0 - sint * sint));
                float Rs = ((nt * cosi) - (ni * cost)) / ((nt * cosi) + (ni * cost));
                float Rp = ((ni * cosi) - (nt * cost)) / ((ni * cosi) + (nt * cost));
                kr = (Rs * Rs + Rp * Rp) / 2.0;
            }
            else
                kr = 1.0;
        }

        // compute the direction that refracted light would come from
        {
            float r = backside ? refractiveIndexRatio : 1.0 / refractiveIndexRatio,
                  k = 1.0 - r * r * (1.0 - vdotn * vdotn);
            if (k >= 0.0)
                refractionDirection = -r * V + (r * vdotn - sqrt(k)) * N;
        }
    }
    else {
        kr = 1.0;
        refractionDirection = vec4(0.0);
    }
}

bool glossyScatter(in vec4 R, in vec4 N, in PhongMaterialParameters matParams,
    inout vec4 outDirection, inout vec3 outColor, inout vec2 random_seed)
{
    outColor = matParams.specular;
    if (isinf(matParams.specularFactor)) {
        outDirection = R;
        return true;
    }

    // Compute a space transform from local space to world space using R and another random base vector
    mat4 space_transform = transformToAlignY(R);

    // spherical coordinates following the PDF for Phong specular, theta is a simple uniform angle
    float theta = 2.0 * PI * randf(random_seed);
    float sin_theta = sin(theta), cos_theta = cos(theta);

    // Phi is harder: many angles may point away from the normal (through the material),
    // potentially leading to bad light leaks/black spots if not prevented.
    vec4 forward = space_transform * vec4(cos_theta, 0,  sin_theta, 0);
    vec4 right   = space_transform * vec4(sin_theta, 0, -cos_theta, 0);

    // So, to combat this, we first compute the maximum value phi can have before
    vec4 phiN = (1.0 - abs(dot(right, N)) > EPSILON) ? vec4(normalize(cross(N.xyz, right.xyz)), 0.0) : R;
    if (dot(phiN, forward) < -EPSILON)
        phiN = -1.0 * phiN;
    float maxPhi = acos(max(dot(R, phiN), 0.0));

    // then we use that to compute the minimum usable random value allowable.
    float minRand = pow(cos(maxPhi - EPSILON), matParams.specularFactor + 1.0);

    // Generate a random number in the safe range, following a rough Phong PDF.
    float phi = acos(pow((1.0 - minRand) * randf(random_seed) + minRand, 1.0 / (matParams.specularFactor + 1.0)));

    // Finally, convert spherical to local Cartesian, then to world space
    float sin_phi = sin(phi), cos_phi = cos(phi);
    outDirection = space_transform * vec4(
        cos_theta * sin_phi,
                    cos_phi,
        sin_theta * sin_phi, 0);

    // Even with all that care, numerical error occasionally creeps in and breaks things, especially if
    // R is very close to N. In that case, just return R.
    if (dot(outDirection, N) < 0.0)
        outDirection = R;

    return true;
}
bool diffuseScatter(in vec4 N, in PhongMaterialParameters matParams,
    inout vec4 outDirection, inout vec3 outColor, inout vec2 random_seed)
{
    outDirection = normalize(N + vec4(randomSpherePoint(random_seed), 0));
    outColor = matParams.diffuse;
    return true;
}
// outExact is set true when the direction wasn't randomly sampled from a lobe (a perfect mirror or an
// infinitely smooth glossy lobe); the next bounce then counts a directly hit light's emission.
bool samplePhongScatter(in vec4 R, in vec4 N, in PhongMaterialParameters matParams,
    inout vec4 outDirection, inout vec3 outColor, inout bool outExact, inout vec2 random_seed)
{
    if (randf(random_seed) < matParams.mirrorProbability) {
        outDirection = R;
        outColor = vec3(1.0);
        outExact = true;
        return true;
    }
    outExact = false;

    float diffuseProb  = average(matParams.diffuse),
          specularProb = average(matParams.specular);
    float probSum = diffuseProb + specularProb;

    if (probSum < EPSILON)
        return false;

    if (randf(random_seed) < (diffuseProb / probSum))
        return diffuseScatter(N, matParams, outDirection, outColor, random_seed);

    outExact = isinf(matParams.specularFactor);
    return glossyScatter(R, N, matParams, outDirection, outColor, random_seed);
}

vec3 phongBRDF(in vec4 N, in vec4 R, in vec4 lightDir, in float kr, in vec4 refractionDir, in PhongMaterialParameters matParams) {
    vec4 L = normalize(lightDir);
    float ldotn = dot(L, N);

    float diffuse = 0.0, specular = 0.0;
    if (kr > 0.0 && ldotn >= 0.0) {
        diffuse  += kr * ldotn;
        specular += kr * ldotn * safePow(max(dot(L, R), 0.0), matParams.specularFactor);
    }
    if (kr < 1.0 && ldotn <= 0.0) {
        diffuse  += (1.0 - kr) * (-ldotn);
        specular += (1.0 - kr) * -ldotn * safePow(max(dot(L, refractionDir), 0.0), matParams.specularFactor);
    }

    return diffuse * matParams.diffuse + specular * matParams.specular;
}

// A legacy Phong material at a hit, ready to shade: the view-dependent parts (the reflected direction, and the
// Fresnel split kr and refraction direction for a refractive material) are worked out once, for every light.
struct PhongSurface {
    PhongMaterialParameters params;
    vec4 rd;
    vec4 N;
    vec4 R;
    float kr;
    vec4 refractionDirection;
};
PhongSurface phongSurface(in PhongMaterialParameters matParams, in vec4 rd, in vec4 normal) {
    PhongSurface s;
    s.params = matParams;
    s.rd = rd;

    // standardize geometry data
    vec4 V = normalize(-rd);
    vec4 N = normalize(normal);
    float vdotn = dot(V, N);

    // check if this we have hit the backside of this material, and mark if so
    bool backside = false;
    if (vdotn < 0.0) {
        N = -N;
        vdotn = -vdotn;
        backside = true;
    }
    s.N = N;
    s.R = normalize((2.0 * vdotn * N) - V);

    // Deal with refraction parameters
    computeRefractionParameters(V, N, vdotn, matParams.refractiveIndexRatio, backside, s.refractionDirection, s.kr);
    return s;
}
// The light reflected toward the viewer from a light in direction lightDir, per unit of the light's color. Zero
// unless the light is on a side the material reflects (kr > 0) or transmits (kr < 1) toward.
vec3 phongEval(in PhongSurface s, in vec4 lightDir) {
    return phongBRDF(s.N, s.R, lightDir, s.kr, s.refractionDirection, s.params);
}
void phongSampleNextRays(in PhongSurface s, inout vec2 random_seed, inout RecursiveNextRays nextRays) {
    PhongMaterialParameters matParams = s.params;

    // reflection
    if (s.kr > 0.0 && normSquared(matParams.reflectivity) > 0.0) {
        nextRays.reflectionProbability = s.kr;
        if (samplePhongScatter(s.R, s.N, matParams, nextRays.reflectionDirection, nextRays.reflectionColor, nextRays.reflectionExact, random_seed))
            nextRays.reflectionColor *= matParams.reflectivity;
    }

    // refraction
    if (s.kr < 1.0 && normSquared(s.refractionDirection) > EPSILON) {
        nextRays.transmissionProbability = 1.0 - s.kr;
        if (samplePhongScatter(s.refractionDirection, s.N, matParams, nextRays.transmissionDirection, nextRays.transmissionColor, nextRays.transmissionExact, random_seed))
            nextRays.transmissionColor *= matParams.transmissivity;
    }

    // transmission (no refraction)
    else if (isinf(matParams.refractiveIndexRatio) && normSquared(matParams.transmissivity) > 0.0) {
        nextRays.transmissionProbability = 1.0;
        if (samplePhongScatter(s.rd, s.N, matParams, nextRays.transmissionDirection, nextRays.transmissionColor, nextRays.transmissionExact, random_seed))
            nextRays.transmissionColor *= matParams.transmissivity;
    }
}

//#section generic

// ---- Generic: the surface interface when every material is a legacy Phong one (no BSDFs compiled in) ----
#define SURFACE_NONE  0
#define SURFACE_PHONG 1
int gSurfaceKind = SURFACE_NONE;
PhongSurface gPhongSurface;

vec3 materialSurface(in int materialID, in vec4 rp, in Ray r, in GeometricMaterialData geodata) {
    PhongMaterialParameters matParams;
    getPhongMaterialParameters(materialID, geodata, matParams);
    gPhongSurface = phongSurface(matParams, r.d, geodata.normal);
    gSurfaceKind = SURFACE_PHONG;
    return matParams.ambient;
}
void surfaceClear() {
    gSurfaceKind = SURFACE_NONE;
}
float surfaceEmitterPdf() {
    return 0.0;
}
bool surfaceWantsDirectLight() {
    return gSurfaceKind != SURFACE_NONE;
}
vec3 surfaceEval(in vec4 lightDirection, out float pdf, out float cosFactor) {
    pdf = 0.0;
    cosFactor = 1.0;
    return phongEval(gPhongSurface, lightDirection);
}
void surfaceSampleNextRays(inout vec2 random_seed, inout RecursiveNextRays nextRays) {
    if (gSurfaceKind == SURFACE_PHONG)
        phongSampleNextRays(gPhongSurface, random_seed, nextRays);
}
