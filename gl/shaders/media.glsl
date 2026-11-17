Participating media on the GPU: the same model and sampling as src/media.js (which explains them), for the volumes
WebGLMediaAdapter uploads. Only path tracing sees media (renderer.glsl: rendererRayColor and rendererDirectLight).

Holes in declarations: count (volumes) and gridCount (distinct voxel grids, each two sampler3Ds: its bytes, and its
majorant cells, see VoxelGrid.majorantCodes). In source: gridCases, one media.grid-case per grid, majorantCases, one
media.majorant-case per grid, maxSteps, the most tentative collisions a ray may take through one volume (a ray that would
need more is treated as passing, a bias only for extremely thick or badly bounded grids), and maxCells, the most
majorant cells it may cross.

//#section declarations
#define MEDIA_COUNT ${count}
#define MEDIA_GRID_COUNT ${gridCount}
#if MEDIA_COUNT > 0
bool mediaScatter(in Ray r, in float tMin, in float tMax, inout vec2 seed, out vec4 position, out int volume);
float mediaTransmittance(in Ray r, in float tMin, in float tMax, inout vec2 seed);
vec3 mediaAlbedo(in int volume);
float mediaG(in int volume);
float hgEval(in float g, in float cosTheta);
vec3 hgSample(in float g, in vec3 d, inout vec2 seed, out float pdf);
#endif

//#section grid-case
        case ${i}: return textureLod(uMediaGrids[${i}], uvw, 0.0).r;
//#section majorant-case
        case ${i}: dims = textureSize(uMediaMajorants[${i}], 0); return texelFetch(uMediaMajorants[${i}], clamp(cell, ivec3(0), dims - 1), 0).r;
//#section source
#if MEDIA_COUNT > 0
// Per volume: its inverse world transform (into its own space), and
//   uMediaParams:  density, majorant (the largest density anywhere in it), g, kind (0: homogeneous box,
//                  1: homogeneous sphere, 2: grid)
//   uMediaAlbedo:  albedo, and in w the grid index (for grids)
//   uMediaBounds*: its box in its own space (a sphere's is [-1, 1]^3), which a grid fills
//   uMediaGridMax: a grid's largest value: a texel holding c stands for max * c^2 (see VoxelGrid in src/media.js)
//   uMediaCellSize: the size of a grid's majorant cell, in its own space
uniform mat4 uMediaInvTransforms[MEDIA_COUNT];
uniform vec4 uMediaParams[MEDIA_COUNT];
uniform vec4 uMediaAlbedo[MEDIA_COUNT];
uniform vec3 uMediaBoundsMin[MEDIA_COUNT];
uniform vec3 uMediaBoundsMax[MEDIA_COUNT];
uniform float uMediaGridMax[MEDIA_COUNT];
uniform vec3 uMediaCellSize[MEDIA_COUNT];
#define MEDIA_MAX_STEPS ${maxSteps}
#define MEDIA_MAX_CELLS ${maxCells}

#if MEDIA_GRID_COUNT > 0
uniform highp sampler3D uMediaGrids[MEDIA_GRID_COUNT];
uniform highp sampler3D uMediaMajorants[MEDIA_GRID_COUNT];
// A majorant cell's byte (/ 255), and the number of cells in each direction (dims). Cells outside are clamped in.
float mediaMajorantCode(in int grid, in ivec3 cell, out ivec3 dims) {
    dims = ivec3(1);
    switch (grid) {
        ${majorantCases}
        default: break;
    }
    return 0.0;
}
// The interpolated texel value (the byte / 255) of a grid at uvw in [0, 1]^3. Samplers in an array need constant
// indices, hence the switch.
float mediaGridCode(in int grid, in vec3 uvw) {
    switch (grid) {
        ${gridCases}
        default: break;
    }
    return 0.0;
}
#endif

vec3 mediaAlbedo(in int volume) {
    return uMediaAlbedo[volume].rgb;
}
float mediaG(in int volume) {
    return uMediaParams[volume].z;
}

// The extinction at p, in the volume's own space.
float mediaDensity(in int i, in vec3 p) {
#if MEDIA_GRID_COUNT > 0
    if (uMediaParams[i].w == 2.0) {
        float c = mediaGridCode(int(uMediaAlbedo[i].w), (p - uMediaBoundsMin[i]) / (uMediaBoundsMax[i] - uMediaBoundsMin[i]));
        return uMediaParams[i].x * uMediaGridMax[i] * c * c;
    }
#endif
    return uMediaParams[i].x;
}

// The part of a ray (in the volume's own space) inside it, clipped to [tMin, tMax].
bool mediaInterval(in int i, in Ray local, in float tMin, in float tMax, out float t0, out float t1) {
    t0 = tMin;
    t1 = tMax;
    vec3 o = local.o.xyz, d = local.d.xyz;
    if (uMediaParams[i].w == 1.0) {
        float a = dot(d, d), b = dot(o, d), c = dot(o, o) - 1.0, disc = b * b - a * c;
        if (disc <= 0.0)
            return false;
        float s = sqrt(disc);
        t0 = max(t0, (-b - s) / a);
        t1 = min(t1, (-b + s) / a);
    }
    else {
        vec3 inv = 1.0 / d;
        vec3 ta = (uMediaBoundsMin[i] - o) * inv, tb = (uMediaBoundsMax[i] - o) * inv;
        vec3 lo = min(ta, tb), hi = max(ta, tb);
        t0 = max(t0, max(lo.x, max(lo.y, lo.z)));
        t1 = min(t1, min(hi.x, min(hi.y, hi.z)));
    }
    return t0 < t1;
}

#if MEDIA_GRID_COUNT > 0
// Tracking through a grid volume cell by cell of its majorant grid (a 3D DDA, as VoxelGrid.traverse): within each
// cell, tentative collisions come at the rate of that cell's majorant. Delta tracking (ratio == false) returns the
// first real collision's parameter, or -1; ratio tracking (ratio == true) returns the transmittance.
float mediaGridTrack(in int i, in Ray local, in float t0, in float t1, in bool ratio, inout vec2 seed) {
    int grid = int(uMediaAlbedo[i].w);
    float speed = length(local.d.xyz), scale = uMediaParams[i].x * uMediaGridMax[i];
    vec3 q = (local.o.xyz + t0 * local.d.xyz - uMediaBoundsMin[i]) / uMediaCellSize[i];
    vec3 dq = local.d.xyz / uMediaCellSize[i];
    ivec3 dims;
    mediaMajorantCode(grid, ivec3(0), dims);
    ivec3 cell = clamp(ivec3(floor(q)), ivec3(0), dims - 1);
    ivec3 stp = ivec3(dq.x >= 0.0 ? 1 : -1, dq.y >= 0.0 ? 1 : -1, dq.z >= 0.0 ? 1 : -1);
    vec3 tDelta = vec3(dq.x == 0.0 ? 1e30 : abs(1.0 / dq.x), dq.y == 0.0 ? 1e30 : abs(1.0 / dq.y), dq.z == 0.0 ? 1e30 : abs(1.0 / dq.z));
    vec3 tNext = vec3(
        dq.x == 0.0 ? 1e30 : t0 + (float(cell.x + (dq.x > 0.0 ? 1 : 0)) - q.x) / dq.x,
        dq.y == 0.0 ? 1e30 : t0 + (float(cell.y + (dq.y > 0.0 ? 1 : 0)) - q.y) / dq.y,
        dq.z == 0.0 ? 1e30 : t0 + (float(cell.z + (dq.z > 0.0 ? 1 : 0)) - q.z) / dq.z);
    float T = 1.0, t = t0;
    int steps = 0;
    for (int k = 0; k < MEDIA_MAX_CELLS && t < t1; ++k) {
        float tb = min(min(min(tNext.x, tNext.y), tNext.z), t1);
        float c = mediaMajorantCode(grid, cell, dims), majorant = scale * c * c;
        if (majorant > 0.0) {
            float s = t, rate = majorant * speed;
            for (; steps < MEDIA_MAX_STEPS; ++steps) {
                s -= log(max(1.0 - randf(seed), 1e-7)) / rate;
                if (s >= tb)
                    break;
                float density = mediaDensity(i, (local.o + s * local.d).xyz);
                if (ratio) {
                    T *= 1.0 - density / majorant;
                    if (T < 0.1) {
                        if (randf(seed) < 0.5)
                            return 0.0;
                        T *= 2.0;
                    }
                }
                else if (randf(seed) * majorant < density)
                    return s;
            }
        }
        // Step into the next cell, along the axis whose boundary comes first.
        vec3 m = step(tNext, tNext.yzx) * step(tNext, tNext.zxy);
        t = tb;
        cell += ivec3(m) * stp;
        tNext += m * tDelta;
        if (any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(cell, dims)))
            break;
    }
    return ratio ? T : -1.0;
}
#endif

// Delta tracking: the parameter of the first real collision in [t0, t1], or -1 if the ray passes through.
float mediaSampleCollision(in int i, in Ray local, in float t0, in float t1, inout vec2 seed) {
    float majorant = uMediaParams[i].y, rate = majorant * length(local.d.xyz);
    if (!(rate > 0.0))
        return -1.0;
    bool homogeneous = uMediaParams[i].w != 2.0;
#if MEDIA_GRID_COUNT > 0
    if (!homogeneous)
        return mediaGridTrack(i, local, t0, t1, false, seed);
#endif
    float t = t0;
    for (int k = 0; k < MEDIA_MAX_STEPS; ++k) {
        t -= log(max(1.0 - randf(seed), 1e-7)) / rate;
        if (t >= t1)
            return -1.0;
        if (homogeneous || randf(seed) * majorant < mediaDensity(i, (local.o + t * local.d).xyz))
            return t;
    }
    return -1.0;
}

// Transmittance over [t0, t1]: exact for a homogeneous medium, otherwise ratio tracking with Russian roulette.
float mediaSegmentTransmittance(in int i, in Ray local, in float t0, in float t1, inout vec2 seed) {
    float majorant = uMediaParams[i].y, rate = majorant * length(local.d.xyz);
    if (!(rate > 0.0))
        return 1.0;
    if (uMediaParams[i].w != 2.0)
        return exp(-rate * (t1 - t0));
#if MEDIA_GRID_COUNT > 0
    return mediaGridTrack(i, local, t0, t1, true, seed);
#endif
    float T = 1.0, t = t0;
    for (int k = 0; k < MEDIA_MAX_STEPS; ++k) {
        t -= log(max(1.0 - randf(seed), 1e-7)) / rate;
        if (t >= t1)
            return T;
        T *= 1.0 - mediaDensity(i, (local.o + t * local.d).xyz) / majorant;
        if (T < 0.1) {
            if (randf(seed) < 0.5)
                return 0.0;
            T *= 2.0;
        }
    }
    return T;
}

// Where light traveling along r first scatters in a volume within [tMin, tMax]. Volumes don't overlap, so sampling
// each one's first collision independently and keeping the nearest is the same as tracking them in order.
bool mediaScatter(in Ray r, in float tMin, in float tMax, inout vec2 seed, out vec4 position, out int volume) {
    float nearest = tMax;
    volume = -1;
    for (int i = 0; i < MEDIA_COUNT; ++i) {
        Ray local = Ray(uMediaInvTransforms[i] * r.o, uMediaInvTransforms[i] * r.d);
        float t0, t1;
        if (!mediaInterval(i, local, tMin, nearest, t0, t1))
            continue;
        float t = mediaSampleCollision(i, local, t0, t1, seed);
        if (t >= 0.0 && t < nearest) {
            nearest = t;
            volume = i;
        }
    }
    position = r.o + nearest * r.d;
    return volume >= 0;
}

float mediaTransmittance(in Ray r, in float tMin, in float tMax, inout vec2 seed) {
    float T = 1.0;
    for (int i = 0; i < MEDIA_COUNT && T > 0.0; ++i) {
        Ray local = Ray(uMediaInvTransforms[i] * r.o, uMediaInvTransforms[i] * r.d);
        float t0, t1;
        if (mediaInterval(i, local, tMin, tMax, t0, t1))
            T *= mediaSegmentTransmittance(i, local, t0, t1, seed);
    }
    return T;
}

// Henyey-Greenstein, as in src/media.js: the density of scattering at angle theta from the direction of travel.
float hgEval(in float g, in float cosTheta) {
    float d = 1.0 + g * g - 2.0 * g * cosTheta;
    return (1.0 - g * g) / (4.0 * PI * d * sqrt(d));
}
vec3 hgSample(in float g, in vec3 d, inout vec2 seed, out float pdf) {
    float u1 = randf(seed), u2 = randf(seed), cosTheta;
    if (abs(g) < 1e-3)
        cosTheta = 1.0 - 2.0 * u1;
    else {
        float s = (1.0 - g * g) / (1.0 - g + 2.0 * g * u1);
        cosTheta = (1.0 + g * g - s * s) / (2.0 * g);
    }
    cosTheta = clamp(cosTheta, -1.0, 1.0);
    float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta)), phi = 2.0 * PI * u2;
    vec3 a = abs(d.x) > 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0);
    vec3 t = normalize(a - d * dot(a, d)), b = cross(d, t);
    pdf = hgEval(g, cosTheta);
    return d * cosTheta + t * (sinTheta * cos(phi)) + b * (sinTheta * sin(phi));
}
#endif
