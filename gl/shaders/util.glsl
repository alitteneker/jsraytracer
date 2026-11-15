// Precision, constants, and the helpers every other part of the shader uses: small vector utilities, random
// numbers, and fetching data from the 2D textures that hold the scene's arrays.
// Rendered by WebGLHelper (WebGLUtilHelpers.js). Holes: dataTextureWidth, dataTextureMask, dataTextureShift, the
// data textures' layout (see WebGLTexture.coerceToDataTextureData).

//#section declarations

precision highp int;
precision highp float;
precision highp isampler2D;
precision highp sampler2D;

#define PI 3.14159265359
#define EPSILON 0.0001

float normSquared(in vec2 v);
float normSquared(in vec3 v);
float normSquared(in vec4 v);
float sum(in vec2 v);
float sum(in vec3 v);
float sum(in vec4 v);
float average(in vec2 v);
float average(in vec3 v);
float average(in vec4 v);

vec4 unitAxis4(in int dim);

float randf(inout vec2 seed);
vec2 randomGaussian(inout vec2 seed);
vec2 randomCirclePoint(inout vec2 seed);
vec3 randomSpherePoint(inout vec2 seed);
mat4 transformToAlignY(in vec4 R);

float safePow(in float x, in float y);

ivec2 computeGenericIndex(in int index);
vec4   texelFetchByIndex(  in int index, in  sampler2D texture);
ivec4 itexelFetchByIndex(  in int index, in isampler2D texture);

//#section source

// Utility Functions
float normSquared(in vec2 v) { return dot(v, v); }
float normSquared(in vec3 v) { return dot(v, v); }
float normSquared(in vec4 v) { return dot(v, v); }
float sum(in vec2 v)         { return dot(v, vec2(1.0)); }
float sum(in vec3 v)         { return dot(v, vec3(1.0)); }
float sum(in vec4 v)         { return dot(v, vec4(1.0)); }
float average(in vec2 v)     { return sum(v) / 2.0; }
float average(in vec3 v)     { return sum(v) / 3.0; }
float average(in vec4 v)     { return sum(v) / 4.0; }

vec4 unitAxis4(in int dim) {
    vec4 ret = vec4(0.0);
    ret[dim] = 1.0;
    return ret;
}


// Random functions

// A single iteration of Bob Jenkins' One-At-A-Time hashing algorithm.
uint hash_uint( uint x ) {
    x += ( x << 10u );
    x ^= ( x >>  6u );
    x += ( x <<  3u );
    x ^= ( x >> 11u );
    x += ( x << 15u );
    return x;
}
uint hash_uint( uvec2 v ) {
    return hash_uint( v.x ^ hash_uint(v.y));
}

// Construct a float with half-open range [0:1] using low 23 bits.
// All zeroes yields 0.0, all ones yields the next smallest representable value below 1.0.
float floatConstruct( uint m ) {
    const uint ieeeMantissa = 0x007FFFFFu; // binary32 mantissa bitmask
    const uint ieeeOne      = 0x3F800000u; // 1.0 in IEEE binary32

    m &= ieeeMantissa;                     // Keep only mantissa bits (fractional part)
    m |= ieeeOne;                          // Add fractional part to 1.0

    float  f = uintBitsToFloat( m );       // Range [1:2]
    return f - 1.0;                        // Range [0:1]
}

float random_hash( vec2  v ) {
    return floatConstruct( hash_uint( floatBitsToUint(v) ) );
}

float randf(inout vec2 seed) {
    const float random_advance = 65.60358;

    float ret = random_hash(seed);

    seed += vec2(random_advance);

    return ret;
}

vec2 randomGaussian(inout vec2 seed) {
    //create two random numbers, make sure u1 is greater than zero
    float u1 = 0.0, u2, u2p;
    do {
        u1 = randf(seed);
    } while (u1 == 0.0);
    u2 = randf(seed);
    u2p = 2.0 * PI * u2;

    //compute z0 and z1
    float mag = sqrt(-2.0 * log(u1));
    float z0  = mag * cos(u2p);
    float z1  = mag * sin(u2p);

    return vec2(z0, z1);
}

vec2 randomCirclePoint(inout vec2 seed) {
    float a = 2.0 * PI * randf(seed), r = sqrt(randf(seed));
    return vec2(r * cos(a), r * sin(a));
}
vec3 randomSpherePoint(inout vec2 seed) {
    float theta = 2.0 * PI * randf(seed),
        phi = acos(2.0 * randf(seed) - 1.0);
    float sin_phi = sin(phi);
    return vec3(
        cos(theta) * sin_phi,
                     cos(phi),
        sin(theta) * sin_phi);
}
vec4 getFurthestAxis(in vec4 R) {
    vec4  best_axis = vec4(1,0,0,0);
    float best_score = 1.0-abs(dot(R, best_axis));
    for (int i = 1; i < 3; ++i) {
        vec4 axis = unitAxis4(i);
        float score = 1.0-abs(dot(R, axis));
        if (score > best_score) {
            best_score = score;
            best_axis  = axis;
        }
    }
    return best_axis;
}
mat4 transformToAlignY(in vec4 R) {
    vec4 axis = getFurthestAxis(R);

    mat4 space_transform = mat4(1.0);
    space_transform[0] = vec4(normalize(cross(axis.xyz, R.xyz)).xyz, 0);
    space_transform[1] = R;
    space_transform[2] = vec4(normalize(cross(R.xyz, space_transform[0].xyz)).xyz, 0);

    return space_transform;
}

float safePow(in float x, in float y) {
    if (x < 0.0 || (x == 0.0 && y <= 0.0))
        return 0.0;
    return pow(x, y);
}

// Texel fetch by index functions
// Data textures are ${dataTextureWidth} texels wide, so index -> texel is a mask and a shift rather than an integer %
// and / by the texture's width (integer division is expensive on GPUs).
ivec2 computeGenericIndex(in int index) {
    return ivec2(index & ${dataTextureMask}, index >> ${dataTextureShift});
}
vec4   texelFetchByIndex(in int index, in  sampler2D texture) { return texelFetch(texture, computeGenericIndex(index), 0); }
ivec4 itexelFetchByIndex(in int index, in isampler2D texture) { return texelFetch(texture, computeGenericIndex(index), 0); }
