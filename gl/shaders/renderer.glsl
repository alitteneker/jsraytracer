// The tracer's entry point: main() traces one sample per pixel and accumulates it, and rendererRayColor follows a
// path through the scene, bounce by bounce. Also the display pass, which averages (and optionally denoises) the
// accumulated samples. Rendered by WebGLRendererAdapter.
// Holes in source: ballastDeclarations, ballastAccumulate, ballastSum (debugBallastRegisters; empty normally).

//#section declarations

struct Ray { vec4 o; vec4 d; };
struct RecursiveNextRays {
    float reflectionProbability;
    vec4  reflectionDirection;
    vec3  reflectionColor;

    float transmissionProbability;
    vec4  transmissionDirection;
    vec3  transmissionColor;

    // Whether each direction was exact (mirror/refraction) rather than randomly sampled; decides whether
    // the next hit counts a light's emission (see worldRayColorShallow).
    bool  reflectionExact;
    bool  transmissionExact;

    // Path tracing: the density the BSDF sampled the reflection direction with (0 for an exact one).
    float pdf;
};
float powerHeuristic(in float f, in float g);
vec4 rendererRayColor(in Ray in_ray, inout vec2 random_seed, inout vec4 first_hit_normal);
uniform int uMaxBounceDepth;

//#section source

uniform sampler2D uSampleSumTexture;
uniform sampler2D uNormalSumTexture;
uniform sampler2D uVarianceTexture;

uniform bool uRendererRandomMultisample;
uniform int uSampleCount;
uniform float uRandomSeed;
uniform float uFireflyClamp;

uniform vec2 uCanvasSize;

layout(location=0) out vec4 outSampleSum;
layout(location=1) out vec4 outNormalSum;
layout(location=2) out vec4 outSampleVariance;


void main() {
    vec2 canvasCoord = 2.0 * (gl_FragCoord.xy / uCanvasSize) - vec2(1.0);
    vec2 pixelSize = 2.0 / uCanvasSize;

    vec2 random_seed = gl_FragCoord.xy + vec2(uRandomSeed);

    if (uRendererRandomMultisample)
        canvasCoord += 0.5 * pixelSize * randomGaussian(random_seed); // gaussian filter

    Ray r = computeCameraRayForTexel(canvasCoord, pixelSize, random_seed);

    vec4 firstHitNormal = vec4(0.0);
    vec4 sampleColor = rendererRayColor(r, random_seed, firstHitNormal);

    if (uSampleCount == 0) {
        outSampleSum = sampleColor;
        outNormalSum = firstHitNormal;
        outSampleVariance = vec4(0.0);
    }
    else {
        vec4 sumSampleColor  = texture(uSampleSumTexture,   gl_FragCoord.xy / uCanvasSize);
        vec4 sumSampleNormal = texture(uNormalSumTexture,   gl_FragCoord.xy / uCanvasSize);
        vec4 sampleVariance  = texture(uVarianceTexture,    gl_FragCoord.xy / uCanvasSize);

        outSampleSum = sumSampleColor + sampleColor;
        outNormalSum = sumSampleNormal + firstHitNormal;

        float count1 = float(uSampleCount + 1);
        vec4 mean = sumSampleColor / count1;
        vec4 delta = sampleColor - mean;
        vec4 delta2 = sampleColor - ((delta / count1) + mean);
        outSampleVariance = sampleVariance + (delta * delta2);
    }
}
// Power heuristic MIS weight, f^2 / (f^2 + g^2), written so huge densities can't overflow to inf / inf.
float powerHeuristic(in float f, in float g) {
    if (f >= g) {
        float r = g / f;
        return 1.0 / (1.0 + r * r);
    }
    float r = f / g;
    return r * r / (1.0 + r * r);
}

#if MEDIA_COUNT > 0 && defined(PATH_TRACING)
vec3 rendererGlowLight(in vec4 rp, in vec4 toPoint, in vec3 glow, in float pdfLight, in float majorant, in float pdf, inout vec2 random_seed);
#endif

// Direct light at the current surface (see materialSurface) from every light: one sample on each, a shadow ray
// to it, and the surface's response. In path tracing (MIS), each light sample is weighed against the chance that
// sampling the BSDF would have found the same light; in Whitted mode it counts fully.
vec3 rendererDirectLight(in vec4 rp, inout vec2 random_seed) {
    vec3 L = vec3(0.0);
    for (int i = 0; i < uNumLights; ++i) {
        LightSample ls = sampleLight(i, rp, random_seed);
        float pdf, cosFactor;
        vec3 f = surfaceEval(ls.direction, pdf, cosFactor);
        // The surface reflects none of this light, so its shadow ray can't change anything.
        if (max(max(f.r, f.g), f.b) <= 0.0)
            continue;
#if !DEBUG_NO_SHADOWS
        float shadowIntersection = worldRayCast(Ray(rp, ls.direction), EPSILON, 1.0, true);
        if (shadowIntersection > 0.0 && shadowIntersection < 1.0)
            continue;
#endif
#ifdef PATH_TRACING
        float w = ls.pdf > 0.0 ? powerHeuristic(ls.pdf, pdf) : 1.0;
#else
        float w = 1.0;
#endif
#if MEDIA_COUNT > 0 && defined(PATH_TRACING)
        // Light reaching the surface through volumes is dimmed by their transmittance.
        w *= mediaTransmittance(Ray(rp, ls.direction), EPSILON, 1.0, random_seed);
#endif
        L += f * ls.color * cosFactor * w;
    }
#if MEDIA_COUNT > 0 && defined(PATH_TRACING)
    // Glowing volumes as lights: a point in each (see rendererGlowLight).
    for (int v = 0; v < MEDIA_COUNT; ++v) {
        vec4 toPoint;
        vec3 glow;
        float pdfLight, majorant;
        if (!mediaGlows(v) || !mediaSampleGlow(v, rp, random_seed, toPoint, glow, pdfLight, majorant))
            continue;
        float pdf, cosFactor;
        vec3 f = surfaceEval(toPoint, pdf, cosFactor);
        if (max(max(f.r, f.g), f.b) > 0.0)
            L += f * cosFactor * rendererGlowLight(rp, toPoint, glow, pdfLight, majorant, pdf, random_seed);
    }
#endif
    return L;
}

#if MEDIA_COUNT > 0 && defined(PATH_TRACING)
// The light a point sampled in a glowing volume (mediaSampleGlow) sends to rp, before the response there: its glow over
// r^2 and the density of picking it, through whatever lies between, weighed by MIS against path sampling, which finds
// the same glow along a ray cast with density pdf (the BSDF's or phase function's) at the majorant's rate (see
// PathIntegrator.volumeLight).
vec3 rendererGlowLight(in vec4 rp, in vec4 toPoint, in vec3 glow, in float pdfLight, in float majorant, in float pdf, inout vec2 random_seed) {
#if !DEBUG_NO_SHADOWS
    float shadowIntersection = worldRayCast(Ray(rp, toPoint), EPSILON, 1.0, true);
    if (shadowIntersection > 0.0 && shadowIntersection < 1.0)
        return vec3(0);
#endif
    float r2 = dot(toPoint.xyz, toPoint.xyz);
    float w = powerHeuristic(pdfLight, pdf * majorant / r2);
    return glow * w * mediaTransmittance(Ray(rp, toPoint), EPSILON, 1.0, random_seed) / (r2 * pdfLight);
}

// Direct light at a point where light scatters in a volume: as rendererDirectLight, with the phase function in place
// of the BSDF (and no cosine: a medium has no surface to tilt), for light arriving against the direction d.
vec3 rendererMediumDirectLight(in vec4 p, in vec3 d, in float g, inout vec2 random_seed) {
    vec3 L = vec3(0.0);
    for (int i = 0; i < uNumLights; ++i) {
        LightSample ls = sampleLight(i, p, random_seed);
        float phase = hgEval(g, dot(d, normalize(ls.direction.xyz)));
#if !DEBUG_NO_SHADOWS
        float shadowIntersection = worldRayCast(Ray(p, ls.direction), EPSILON, 1.0, true);
        if (shadowIntersection > 0.0 && shadowIntersection < 1.0)
            continue;
#endif
        float w = ls.pdf > 0.0 ? powerHeuristic(ls.pdf, phase) : 1.0;
        L += ls.color * phase * w * mediaTransmittance(Ray(p, ls.direction), EPSILON, 1.0, random_seed);
    }
    for (int v = 0; v < MEDIA_COUNT; ++v) {
        vec4 toPoint;
        vec3 glow;
        float pdfLight, majorant;
        if (!mediaGlows(v) || !mediaSampleGlow(v, p, random_seed, toPoint, glow, pdfLight, majorant))
            continue;
        float phase = hgEval(g, dot(d, normalize(toPoint.xyz)));
        L += phase * rendererGlowLight(p, toPoint, glow, pdfLight, majorant, phase, random_seed);
    }
    return L;
}
#endif

// The integrator: follows a path from the camera, adding at each hit its emission and the direct light it reflects,
// then continuing in a direction the surface chooses.
vec4 rendererRayColor(in Ray in_ray, inout vec2 random_seed, inout vec4 first_hit_normal) {
    vec3 total_color = vec3(0.0);
    float initial_intersection_distance = 1E20;

    Ray r = in_ray;
    vec3 attenuation_color = vec3(1);
    ${ballastDeclarations}

    // Camera rays see lights directly; after that, only exact bounces do (see worldRayColorShallow).
    bool countEmission = true;
    // Path tracing: the pdf of the bounce that produced the current ray, for MIS when it hits a light (0 for
    // camera rays and exact bounces, whose light counts fully).
    float prevBsdfPdf = 0.0;

    int i = 0;
    for (;i < uMaxBounceDepth; ++i) {
        vec4 intersect_position = vec4(0);
        vec3 intersect_normal = vec3(0);
        RecursiveNextRays nextRays = RecursiveNextRays(0.0, vec4(0), vec3(0), 0.0, vec4(0), vec3(0), false, false, 0.0);
        surfaceClear();
        vec3 surface_color = worldRayColorShallow(r, intersect_position, intersect_normal, countEmission);
#if LIGHTS_VISIBLE_DIRECTIONAL && !DEBUG_TRAVERSAL_HEATMAP && !DEBUG_TRAVERSAL_ONLY
        // A directional light's shape seen by this ray (it sits relative to the ray's origin, not in the world, so
        // worldRayColorShallow can't find it). Nearer than the world's hit, it replaces it, and the path ends there.
        {
            float worldT = intersect_position.w == 0.0 ? 1e30
                : dot(intersect_position.xyz - r.o.xyz, r.d.xyz) / dot(r.d.xyz, r.d.xyz);
            vec3 Le;
            float lightPdf;
            if (lightsRayCastDirectional(r, worldT, Le, lightPdf)) {
                surfaceClear();
#ifdef PATH_TRACING
                // As for an area light hit by a sampled bounce: light sampling could have found it too.
                if (prevBsdfPdf > 0.0)
                    Le *= powerHeuristic(prevBsdfPdf, lightPdf);
#endif
                surface_color = countEmission ? Le : vec3(0);
                intersect_position.w = 0.0;
            }
        }
#endif
#if MEDIA_COUNT > 0 && defined(PATH_TRACING) && !DEBUG_TRAVERSAL_HEATMAP && !DEBUG_TRAVERSAL_ONLY
        // Light may scatter in a volume before reaching the surface (or escaping). Then that is where the path
        // continues from, instead of the surface: direct light through the phase function, scaled by the albedo,
        // and next a direction sampled from the phase function (below).
        bool mediumEvent = false;
        int mediumVolume = -1;
        vec3 mediumEmitted = vec3(0);   // light glowing volumes emit along the ray, before it scatters or hits
        {
            float worldT = intersect_position.w == 0.0 ? 1e30
                : dot(intersect_position.xyz - r.o.xyz, r.d.xyz) / dot(r.d.xyz, r.d.xyz);
            vec4 mediumPosition;
            if (mediaScatter(r, EPSILON, worldT, random_seed, mediumPosition, mediumVolume, mediumEmitted, prevBsdfPdf)) {
                surfaceClear();
                mediumEvent = true;
                intersect_position = mediumPosition;
                intersect_normal = vec3(0);
                surface_color = mediaAlbedo(mediumVolume) * rendererMediumDirectLight(mediumPosition,
                    normalize(r.d.xyz), mediaG(mediumVolume), random_seed);
            }
        }
#endif
#ifdef PATH_TRACING
        // A light reached by sampling a BSDF: light sampling at the surface the path left could have found it
        // too, so MIS splits the credit.
        if (prevBsdfPdf > 0.0 && surfaceEmitterPdf() > 0.0)
            surface_color *= powerHeuristic(prevBsdfPdf, surfaceEmitterPdf());
#endif
#if MEDIA_COUNT > 0 && defined(PATH_TRACING) && !DEBUG_TRAVERSAL_HEATMAP && !DEBUG_TRAVERSAL_ONLY
        // Glowing volumes: nothing samples them as lights, so their light always counts fully (and isn't scaled by
        // the albedo of a scattering event that happens after it).
        surface_color += mediumEmitted;
#endif
#if !DEBUG_TRAVERSAL_HEATMAP && !DEBUG_TRAVERSAL_ONLY
        if (surfaceWantsDirectLight())
            surface_color += rendererDirectLight(intersect_position, random_seed);
        surfaceSampleNextRays(random_seed, nextRays);
#endif
        vec3 contribution = attenuation_color * surface_color;
#if DEBUG_TRAVERSAL_HEATMAP
        // Heatmap mode returns before setting intersect_position, so the loop breaks before the normal
        // is normally recorded. Record it here instead: it holds raw (nodes, prims, hit) counts.
        if (i == 0) first_hit_normal.xyz = intersect_normal;
#endif

        // Firefly clamp: cap the luminance of INDIRECT contributions (bounce >= 1) only. Directly
        // visible surfaces and emitters (i == 0) are never clamped, so bright lights render at full
        // intensity; only rare bright outliers from deeper bounces (the actual fireflies) are tamed.
        if (i > 0 && uFireflyClamp > 0.0) {
            float lum = max(max(contribution.r, contribution.g), contribution.b);
            if (lum > uFireflyClamp)
                contribution *= uFireflyClamp / lum;
        }
        total_color += contribution;
        ${ballastAccumulate}

        if (intersect_position.w == 0.0)
            break;

        if (i == 0) {
            initial_intersection_distance = length(r.o - intersect_position);
            first_hit_normal.xyz = intersect_normal;
        }

        bool do_next_ray = false;

        float next_ray_probability_sum = nextRays.reflectionProbability + nextRays.transmissionProbability;
#if MEDIA_COUNT > 0 && defined(PATH_TRACING) && !DEBUG_TRAVERSAL_HEATMAP && !DEBUG_TRAVERSAL_ONLY
        if (mediumEvent) {
            // The phase function's sample has weight 1, so only the albedo changes the path's throughput.
            float phasePdf;
            vec3 wi = hgSample(mediaG(mediumVolume), normalize(r.d.xyz), random_seed, phasePdf);
            r = Ray(intersect_position, vec4(wi, 0));
            attenuation_color *= mediaAlbedo(mediumVolume);
            prevBsdfPdf = phasePdf;
            countEmission = true;
            do_next_ray = true;
            next_ray_probability_sum = 0.0;
        }
#endif
        if (next_ray_probability_sum > 0.0) {

            float next_ray_probability_sample = randf(random_seed) * max(next_ray_probability_sum, 1.0);

            next_ray_probability_sample -= nextRays.reflectionProbability;
            if (next_ray_probability_sample <= 0.0
                && normSquared(nextRays.reflectionDirection) > EPSILON)
            {
                r = Ray(intersect_position, nextRays.reflectionDirection);
                attenuation_color *= nextRays.reflectionColor * max(next_ray_probability_sum, 1.0);
#ifdef PATH_TRACING
                // Lights hit by sampled bounces count too, weighted by MIS (see materialSurface).
                prevBsdfPdf = nextRays.reflectionExact ? 0.0 : nextRays.pdf;
#else
                countEmission = nextRays.reflectionExact;
#endif
                do_next_ray = true;
            }

            else {
                next_ray_probability_sample -= nextRays.transmissionProbability;
                if (next_ray_probability_sample <= 0.0
                    && normSquared(nextRays.transmissionDirection) > EPSILON)
                {
                    r = Ray(intersect_position, nextRays.transmissionDirection);
                    attenuation_color *= nextRays.transmissionColor * max(next_ray_probability_sum, 1.0);
                    countEmission = nextRays.transmissionExact;
                    do_next_ray = true;
                }
            }
        }

        if (!do_next_ray)
            break;
#ifdef PATH_TRACING
        // Russian roulette: end dim paths at random, boosting the survivors so the estimate stays unbiased.
        if (i + 1 >= 3) {
            float q = max(0.05, 1.0 - max(max(attenuation_color.r, attenuation_color.g), attenuation_color.b));
            if (randf(random_seed) < q)
                break;
            attenuation_color /= 1.0 - q;
        }
#endif
    }
    ${ballastSum}

    first_hit_normal.w = float(i);
    return vec4(total_color, initial_intersection_distance);
}

//#section tracer.vertex
#version 300 es
precision highp float;
in vec4 vertexPosition;
void main() {
    gl_Position = vertexPosition;
}

//#section display.vertex
#version 300 es
precision highp float;
in vec4 vertexPosition;
out vec2 textureCoord;
void main() {
    textureCoord = (vertexPosition.xy+1.0)/2.0;
    gl_Position = vertexPosition;
}

//#section display.fragment
#version 300 es
// highp throughout: the accumulated sums this reads are far outside mediump's range on phones, where mediump is a real
// 16 bit float (desktop GPUs run it as highp, which hid this). A background sample's depth alone is 1e20, so it became
// infinity, the denoiser's depth weights NaN, and the depth written (alpha / uMaxDepth, at most 1 - EPSILON, which is
// 1.0 in 16 bits) failed the depth test against the cleared depth of 1.0: the background came out black.
precision highp float;
precision highp sampler2D;
#define EPSILON 0.0001

#define INV_SQRT_OF_2PI 0.39894228040143267793994605993439  // 1.0/SQRT_OF_2PI
#define INV_PI          0.31830988618379067153776752674503

uniform sampler2D uSampleSumTexture;
uniform sampler2D uVarianceTexture;
uniform sampler2D uNormalSumTexture;
uniform int uSampleCount;
in vec2 textureCoord;

uniform float uMaxDepth;
uniform float uColorLogScale;

// The renderer's film (Film, in src/renderers.js, which documents the settings): exposure in stops, a tone curve
// (uToneMap indexes Film.TONE_MAPS), then sRGB encoding for the display.
uniform float uExposure;
uniform int uToneMap;
vec3 filmToneMap(vec3 c) {
    if (uToneMap == 0) {   // neutral: Khronos PBR Neutral
        const float startCompression = 0.8 - 0.04, desaturation = 0.15;
        float x = min(c.r, min(c.g, c.b));
        c -= x < 0.08 ? x - 6.25 * x * x : 0.04;
        float peak = max(c.r, max(c.g, c.b));
        if (peak < startCompression)
            return c;
        const float d = 1.0 - startCompression;
        float newPeak = 1.0 - d * d / (peak + d - startCompression);
        c *= newPeak / peak;
        float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
        return mix(c, vec3(newPeak), g);
    }
    if (uToneMap == 1)     // aces: Narkowicz's fit
        return (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
    if (uToneMap == 2)     // reinhard
        return c / (1.0 + c);
    return c;              // clip
}
vec3 encodeSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

uniform bool uDoDenoise;
uniform float uDenoiseThreshold;
uniform float uDenoiseSigma;
uniform float uDenoiseKSigma;
uniform float uDenoiseNormalPower;

// The following function is modified from https://github.com/BrutPitt/glslSmartDeNoise/tree/master
// Parameters:
//      sampler2D tex             - sampler image / texture
//      vec2 uv                   - actual fragment coord
//      float texture_factor      - multiplier for values from render texture
//      float uDenoiseSigma  >  0 - sigma Standard Deviation
//      float uDenoiseKSigma >= 0 - sigma coefficient
//          uDenoiseKSigma * uDenoiseSigma  -->  radius of the circular kernel
//      float uDenoiseThreshold   - edge sharpening threshold
vec4 smartDeNoise(in sampler2D tex, in sampler2D var, in sampler2D norm, in vec2 uv, in float texture_factor) {
    float radius = round(uDenoiseKSigma * uDenoiseSigma);
    float radQ = radius * radius;

    float invSigmaQx2 = .5 / (uDenoiseSigma * uDenoiseSigma);      // 1.0 / (uDenoiseSigma^2 * 2.0)
    float invSigmaQx2PI = INV_PI * invSigmaQx2;                    // // 1/(2 * PI * uDenoiseSigma^2)

    float invThresholdSqx2 = .5 / (uDenoiseThreshold * uDenoiseThreshold);     // 1.0 / (uDenoiseSigma^2 * 2.0)
    float invThresholdSqrt2PI = INV_SQRT_OF_2PI / uDenoiseThreshold;           // 1.0 / (sqrt(2*PI) * uDenoiseSigma)

    vec4 centerPx = texture(tex, uv) * texture_factor;
    vec4 centerStd = sqrt(max(texture(var, uv), 0.0) * texture_factor);

    // The accumulated normal buffer isn't unit length (it's a sum across samples), and is exactly
    // zero wherever every sample was a background miss, so guard the normalize rather than risk NaN.
    vec3 centerNormalRaw = texture(norm, uv).xyz;
    float centerNormalLen = length(centerNormalRaw);
    bool centerNormalValid = centerNormalLen > EPSILON;
    vec3 centerNormal = centerNormalValid ? (centerNormalRaw / centerNormalLen) : vec3(0.0);

    vec4 zBuff = vec4(0.0);
    vec4 aBuff = vec4(0.0);
    vec2 size = vec2(textureSize(tex, 0));

    vec2 d;
    for (d.x=-radius; d.x <= radius; d.x++) {
        float pt = sqrt(radQ-d.x*d.x);       // pt = yRadius: have circular trend
        for (d.y=-pt; d.y <= pt; d.y++) {
            vec2 coord = max(min(uv + d / size, 1.0), 0.0);
            vec4 px_color =          texture(tex, coord)       * texture_factor;
            vec4 px_std   = sqrt(max(texture(var, coord), 0.0) * texture_factor);

            vec4 std_diff = px_std - centerStd;

            float spatialW = exp( -dot(d , d) * invSigmaQx2 ) * invSigmaQx2PI;
            vec4  stdDiffW = invThresholdSqrt2PI / (1.0 + exp( -std_diff * invThresholdSqx2));
            float depthW = exp(-abs(px_color.w - centerPx.w) * 50.0);

            // Normal-based edge stopping: pixels facing similar directions to the center pixel
            // are likely the same surface, so blend them freely; a surface next to background,
            // or two differently-oriented surfaces, should not bleed into each other. When both
            // the center and sample are background (no accumulated normal), fall back to 1.0 so
            // background regions still blend on spatial/variance/depth terms alone.
            vec3 px_normalRaw = texture(norm, coord).xyz;
            float px_normalLen = length(px_normalRaw);
            bool px_normalValid = px_normalLen > EPSILON;
            float normalW = 1.0;
            if (centerNormalValid || px_normalValid)
                normalW = (centerNormalValid && px_normalValid)
                    ? pow(max(dot(centerNormal, px_normalRaw / px_normalLen), 0.0), uDenoiseNormalPower)
                    : 0.0;

            vec4 deltaFactor = spatialW * stdDiffW * depthW * normalW;

            zBuff += deltaFactor;
            aBuff += deltaFactor * px_color;
        }
    }
    return vec4((aBuff / zBuff).xyz, centerPx.w);
}

out vec4 outTexelColor;
void main() {
    float texture_factor = 1.0 / float(max(uSampleCount + 1, 1));

    vec4 sampleColor;
    if (uDoDenoise)
        sampleColor = smartDeNoise(uSampleSumTexture, uVarianceTexture, uNormalSumTexture, textureCoord, texture_factor);
    else
        sampleColor = texture(uSampleSumTexture, textureCoord) * texture_factor;

    // Invalid values show as flat warning colors, which skip the film.
    if (any(isnan(sampleColor)))
        sampleColor = vec4(1.0, 0.0, 0.5, 1.0);
    else if (any(isinf(sampleColor)))
        sampleColor = vec4(0.0, 1.0, 0.5, 1.0);
    else if (any(lessThan(sampleColor.rgb, vec3(0.0))))
        sampleColor = vec4(0.5, 0.0, 1.0, 1.0);
    // The log scale view is a diagnostic of the raw radiance, so it skips the film too.
    else if (uColorLogScale > 0.0)
        sampleColor = vec4(log(sampleColor.rgb + 1.0) / uColorLogScale, sampleColor.a);
    else
        sampleColor.rgb = encodeSRGB(filmToneMap(sampleColor.rgb * exp2(uExposure)));

    outTexelColor = vec4(sampleColor.rgb, 1.0);
    gl_FragDepth = min(sampleColor.a / uMaxDepth, 1.0-EPSILON);
}
