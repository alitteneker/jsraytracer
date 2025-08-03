uniform sampler2D uInputImage;
uniform sampler2D uEdgeMap;
uniform vec2 uResolution;
uniform int uKernelRadius;
uniform float uEdgeDecay;

vec2 texelSize = 1.0 / uResolution;

float edgeBetween(vec2 coordA, vec2 coordB) {
    // Sample edge map at midpoint
    vec2 midpoint = (coordA + coordB) * 0.5;
    return texture(uEdgeMap, midpoint).r;
}

void filter(in sampler2D tex, in vec2 uv, in float texture_factor) {
    // Confidence buffer for this kernel, stored in a flat 2D array
    // (we use 2*radius+1 × 2*radius+1 neighborhood)
    const int MAX_RADIUS = 10;
    float confidence[ (2*MAX_RADIUS+1)*(2*MAX_RADIUS+1) ];

    // Coordinates in kernel space
    int R = uKernelRadius;
    int kernelSize = 2 * R + 1;
    ivec2 centerOffset = ivec2(R, R);

    // Set center confidence
    confidence[R * kernelSize + R] = 1.0;

    // Fetch center color
    vec3 centerColor = texture(uInputImage, uv).rgb;
    vec3 accumColor = centerColor;
    float accumWeight = 1.0;

    for (int d = 1; d <= MAX_RADIUS; ++d) {
        if (d > R) break;

        for (int dy = -d; dy <= d; ++dy) {
            int dx1 = d - abs(dy);
            int dxs[2] = int[2](dx1, -dx1);
            for (int j = 0; j < 2; ++j) {
                int dx = dxs[j];

                ivec2 offset = ivec2(dx, dy);
                ivec2 kernelPos = centerOffset + offset;

                vec2 sampleCoord = uv + vec2(offset) * texelSize;

                float bestConf = 0.0;

                // Look at neighbors toward the center (Manhattan-adjacent)
                ivec2 steps[4] = ivec2[4](ivec2(1,0), ivec2(-1,0), ivec2(0,1), ivec2(0,-1));
                for (int i = 0; i < 4; ++i) {
                    ivec2 prevOffset = offset - steps[i];
                    ivec2 prevKernelPos = centerOffset + prevOffset;

                    // Check bounds
                    if (abs(prevOffset.x) > R || abs(prevOffset.y) > R) continue;

                    float prevConf = confidence[prevKernelPos.y * kernelSize + prevKernelPos.x];

                    vec2 coordA = uv + vec2(prevOffset) * texelSize;
                    vec2 coordB = sampleCoord;

                    float edge = edgeBetween(coordA, coordB);
                    float attenuation = exp(-uEdgeDecay * edge);

                    bestConf = max(bestConf, prevConf * attenuation);
                }

                confidence[kernelPos.y * kernelSize + kernelPos.x] = bestConf;

                vec3 sampleColor = texture(uInputImage, sampleCoord).rgb;
                accumColor += sampleColor * bestConf;
                accumWeight += bestConf;
            }
        }
    }

    return vec4(accumColor / accumWeight, 1.0);
}
