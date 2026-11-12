class WebGLRendererAdapter {
    static BUFFER_COUNT = 2;
    static BUFFER_TYPES = ["render", "normal", "variance"];

    // Diagnostics only (all static so they survive scene reloads, all read at shader-generation time so the
    // isolated code is actually removed from the compiled program rather than branched around at runtime). Set
    // one true in the console, reload the scene to rebuild, note FPS + compile time, then set it back to false.
    // Each isolates a single mechanism so we can attribute shading cost rather than guess:
    //   debugTraversalOnly      - return flat color on first hit; strips ALL shading (baseline: traversal only).
    //   debugNoShadows          - keep material math, but skip the per-light shadow-ray cast (isolates the cost
    //                             of the extra shadow-ray BVH traversals).
    //   debugConstMaterialParams- keep everything, but replace the 8 material-property texture/uniform reads with
    //                             constants (isolates material-parameter fetch cost).
    static debugTraversalOnly = false;
    static debugNoShadows = false;
    static debugConstMaterialParams = false;

    // Occupancy probe: injects this many dead-but-live vec4s (~4 registers each) into the hot bounce loop. They
    // do no meaningful work but stay live across traversal+shading, so they raise peak register pressure without
    // changing what the shader computes. Sweep it (0,1,2,4,8...) and watch FPS: an immediate drop means the shader
    // is on the occupancy cliff (register-pressure-bound); flat until large values means there's headroom and
    // register pressure is not the current wall. Individually-named vec4s (not an array) so they stay in registers
    // rather than becoming a spilled indexable-temp on ANGLE, which would measure memory traffic instead.
    static debugBallastRegisters = 0;

    // Traversal-cost heatmap: instead of shading, colorize each pixel by how much work its PRIMARY ray did while
    // traversing the BVH, to split "visits too many nodes" (BVH-quality problem) from "each primitive test moves
    // too many bytes" (data-layout problem) — these need different fixes. Like the flags above it is read at
    // shader-gen time and short-circuits worldRayColorShallow before any shading/secondary rays, so only primary-
    // ray traversal is measured. Set the mode string in the console, reload the scene, and (since the output is a
    // per-pixel diagnostic, not radiance) turn Do Denoise off so counts aren't blurred across edges.
    //   false   - off (normal shading).
    //   'nodes' - blue->red ramp on BVH nodes visited      (isolates BVH quality / how many nodes a ray touches).
    //   'prims' - blue->red ramp on primitive tests done   (isolates leaf fatness / per-test fetch cost).
    //   'both'  - R = primitive tests, G = nodes visited    (red-dominant = intersection-bound, green = node-bound).
    // The *Scale values are the count mapped to full intensity; tune per scene to use the ramp's full range.
    static debugTraversalHeatmap = false;
    static debugHeatmapNodeScale = 200;
    static debugHeatmapPrimScale = 100;
    // While the heatmap is active, read back the raw per-pixel counts this often and log distribution stats to the
    // console (see reportHeatmapStats). readPixels stalls the GPU pipeline, so keep this coarse. 0 disables.
    static debugHeatmapStatsIntervalMs = 1000;

    // Per-node-visit cost ablations for worldRayCastBVH (read at shader-gen time like the flags above; reload the
    // scene after changing). Each replaces one piece of the per-node work with a cheaper equivalent:
    //   debugFastAABB      - precompute 1/r.d once per ray and use a branchless slab test (min/max) on the node's
    //                        min/max directly, instead of the looping, branching, dividing AABBIntersects with its
    //                        center/half-size reconstruction.
    //   debugFastNodeIndex - lay the BVH node texture out with a power-of-two width baked into the shader, so the node
    //                        index -> texel coordinate is a mask and a shift, instead of textureSize() + integer % and /.
    // Traversal optimizations, Nov 2026. Measured on dragon (full 4-bounce render, GPU tracer-pass p50, same machine):
    // baseline 6.05 ms -> 2.67 ms with debugChildBoxes + debugPow2DataTextures + debugSkipUnlitShadows +
    // debugFastTriangle + debugInlineTriangleVerts, which are now ON by default (starwars 5.73 -> 2.91 ms,
    // AMultipleBVH 0.70 -> 0.35 ms; images match the baseline within sampling noise). Set any of them false
    // (console, or URL parameter e.g. ?debugChildBoxes=false) and reload the scene to A/B.
    // Measured and NOT adopted: debugFastNodeIndex (superseded by debugPow2DataTextures), debugStackTNear (slower),
    // debugStackTopCache (no change), debugWideBVH (slightly slower than binary on top of the others).
    static debugFastAABB = false;
    static debugFastNodeIndex = false;
    // Lay out every generic data texture (triangles, world data, materials, BVH nodes unless debugFastNodeIndex) at a
    // fixed power-of-two width, so texelFetchByIndex is a mask + shift everywhere. See WebGLTexture.coerceToDataTextureData.
    static debugPow2DataTextures = true;
    // Skip the shadow ray for a light whose contribution phongBRDF would zero anyway (e.g. a light behind an opaque
    // surface). Output-identical; see computePhongMaterialColor.
    static debugSkipUnlitShadows = true;
    // BVH layout with each internal node holding its two children's boxes (see WebGLWorldAdapter.buildChildBoxBVHData),
    // so nodes the ray misses are never fetched. Used by editable shaders too.
    static debugChildBoxes = true;
    // Build the editable ("interpreter") shader: aggregate and primitive data is read from data textures at run time
    // instead of being unrolled into the source for this scene, so the scene's structure could change without a
    // recompile. Read when the adapters are created; reload the scene after changing it.
    static worldEditable = false;
    // Editable shader only: cast rays with a single loop over roots, BVH nodes and primitive lists, so the generic
    // primitive intersection is compiled once per ray cast instead of three times (see
    // WebGLWorldAdapter.getEditableUnifiedRayCastSource).
    static editableUnifiedCast = true;
    // With debugChildBoxes: also keep each stacked node's box-entry distance, and drop stacked nodes that a closer hit
    // found after they were pushed has made unreachable, without fetching them.
    static debugStackTNear = false;
    // With debugChildBoxes: keep the top stack entry in a register, so most push/pop pairs skip the dynamically
    // indexed stack array (which ANGLE may place in slow indexable memory).
    static debugStackTopCache = false;
    // Moller-Trumbore triangle test in place of plane intersection + barycentric check.
    static debugFastTriangle = true;
    // Duplicate each triangle's positions into their own texture so intersection skips the vertex index lookup.
    static debugInlineTriangleVerts = true;
    // With debugChildBoxes: collapse the binary BVH into a 4-wide one (4 child boxes per node), roughly halving the
    // number of loop iterations and stack operations per ray. See WebGLWorldAdapter.buildChildBoxBVHData.
    static debugWideBVH = false;

    // Floor measurement: worldRayColorShallow returns the background color before casting any ray into the world, so
    // the tracer pass contains only scene-independent per-pixel work (camera ray and jitter, accumulation reads and
    // writes). Read at shader-gen time; reload after changing. Tracer GPU time minus this floor ~= traversal cost.
    static debugSkipTraversal = false;

    // GPU timing of the tracer pass via EXT_disjoint_timer_query_webgl2. Unlike the flags above this is read at
    // runtime, so no reload is needed: set it true in the console and the GPU time of each tracer draw (excluding the
    // passthrough/denoise pass, CPU work, and vsync waits) is collected and summarized to the console every
    // debugGPUTimerIntervalMs. Results arrive a few frames late (queries are asynchronous) and are discarded whenever
    // the GPU reports a disjoint event (e.g. a power-state change), so the first report after enabling may be sparse.
    static debugGPUTimer = false;
    static debugGPUTimerIntervalMs = 1000;

    // Benchmark harness (normally set from URL parameters by webgl-demo.js, e.g. ?test=dragon&bench=5&debugFastAABB=1).
    // bench > 0: after benchWarmupMs of drawing, collect GPU tracer-pass times for `bench` seconds, then publish a
    // summary as window.benchResult and log it as one "BENCH_RESULT {json}" line. The summary also records every
    // debug flag, compile time, shader size, NaN count, and (in heatmap mode) the last heatmap stats.
    // benchRef = "save" stores a 64x64 downsample of the accumulated image in localStorage under benchRefKey;
    // benchRef = "compare" reports the RMSE of this run's image against the stored one, to check that an
    // optimization doesn't change the picture.
    static bench = 0;
    static benchWarmupMs = 1500;
    static benchRef = "";
    static benchRefKey = "jsrt-bench-ref";

    constructor(gl, canvas, renderer) {
        
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearDepth(1.0);
        
        // Store some useful initial variable values
        this.doRandomSample = true;
        this.drawCount = 0;
        
        // Sometimes it's useful to render into log color space, scaled to an appropriate level
        this.colorLogScale = 0.0;
        this.maxDepth = 1000.0;

        this.maxBounceDepth = renderer.maxRecursionDepth;

        // Clamping the luminance of indirect path contributions tames fireflies at the source. It is off by
        // default (0) because a fixed threshold darkens scenes whose legitimate radiance scale exceeds it (e.g.
        // bright emitters); enable it per-scene when fireflies are actually a problem.
        this.fireflyClamp = 0;

        // We also include a denoiser with the passthrough shader. Let's specify some default parameters here.
        this.doDenoise = true;
        this.denoiseSigma = 1;
        this.denoiseKSigma = 2;
        this.denoiseThreshold = 5;
        this.denoiseNormalPower = 32;
        
        // store the canvas and renderer for future usage
        this.canvas = canvas;
        this.renderer = renderer;
        
        // create and store utility variables for managing the WebGL context
        this.gl = gl;
        this.webgl_helper = new WebGLHelper(gl);

        // GPU timer queries (see debugGPUTimer). May be null: not all browsers/GPUs expose the extension.
        this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        this.pendingTimerQueries = [];
        this.gpuTimesMs = [];
        this.lastGPUTimerReport = performance.now();
        this.warnedNoTimerExt = false;
        
        // Create texture units for intermediary rendering/filtering
        this.textureUnits = {};
        for (let k of WebGLRendererAdapter.BUFFER_TYPES)
            this.textureUnits[k] = this.webgl_helper.allocateTextureUnit();
        
        // Allocate texture memory for the necessary buffer types
        this.textures = [];
        for (let i of Math.range(WebGLRendererAdapter.BUFFER_COUNT)) {
            const t = {};
            for (let k of WebGLRendererAdapter.BUFFER_TYPES)
                t[k] = this.webgl_helper.createTexture(4, "FLOAT", canvas.width, canvas.height);
            this.textures.push(t);
        }
        gl.bindTexture(gl.TEXTURE_2D, null);
        
        // Create the adapters for the world, which will also validate the data for the world
        this.adapters = {
            camera: new WebGLCameraAdapter(renderer.camera, this.webgl_helper, this),
            world:  new WebGLWorldAdapter( renderer.world,  this.webgl_helper, this, !!WebGLRendererAdapter.worldEditable)
        };
    }
    
    static build(gl, canvas, renderer, callback) {
        myconsole.log("Building adapters...");
        const ret = new WebGLRendererAdapter(gl, canvas, renderer);
        
        // Build the shader programs to make this render
        const compile_start = Date.now();
        myconsole.log("Building shader...");
        ret.buildShaders(ret.gl, canvas, () => {
            ret.compileSeconds = (Date.now() - compile_start) / 1000;
            myconsole.log(`Shader successfully built in ${ret.compileSeconds} seconds.`);
            
            // Write data to shaders
            myconsole.log("Writing shader data...");
            const write_start = Date.now();
            ret.writeShaderData(ret.gl);
            myconsole.log(`Shader data written in ${(Date.now() - write_start) / 1000} seconds.`);
            
            if (callback)
                callback(ret);
        });
    }
    
    resizeCanvas(new_width, new_height) {
        if (isNaN(new_width) || new_width < 1 || isNaN(new_height) || new_height < 1)
            return;
        
        this.canvas.width = new_width;
        this.canvas.height = new_height;
        
        for (let ta of this.textures)
            for (let t of Object.values(ta))
                t.setPixels(null, 4, "FLOAT", new_width, new_height);
        this.gl.viewport(0, 0, new_width, new_height);
        
        this.gl.useProgram(this.tracerShaderProgram);
        this.gl.uniform2fv(this.gl.getUniformLocation(this.tracerShaderProgram, "uCanvasSize"), Vec.of(new_width, new_height));
        this.resetDrawCount();
    }
    
    getMutableRendererParameters() {
        return {
            canvasWidth      : { label: "Canvas Width",       value: this.canvas.width,     type: "number", step: 1, min: 0 },
            canvasHeight     : { label: "Canvas Height",      value: this.canvas.height,    type: "number", step: 1, min: 0 },
            
            doRandomSample   : { label: "Do Random Sample",   value: this.doRandomSample,   type: "bool"  },
            colorLogScale    : { label: "Color Log Scale",    value: this.colorLogScale,    type: "number", step: 0.1, min: 0 },
            maxBounceDepth   : { label: "Max Bounce Depth",   value: this.maxBounceDepth,   type: "number", step: 1,   min: 0 },
            fireflyClamp     : { label: "Firefly Clamp",      value: this.fireflyClamp,     type: "number", step: 0.1, min: 0 },

            doDenoise        : { label: "Do Denoise",         value: this.doDenoise,        type: "bool"  },
            denoiseSigma     : { label: "Denoise Sigma",      value: this.denoiseSigma,     type: "number", step: 0.01, min: 0 },
            denoiseKSigma    : { label: "Denoise K Sigma",    value: this.denoiseKSigma,    type: "number", step: 0.01, min: 0 },
            denoiseThreshold : { label: "Denoise Threshold",  value: this.denoiseThreshold, type: "number", step: 0.01, min: 0 },
            denoiseNormalPower: { label: "Denoise Normal Power", value: this.denoiseNormalPower, type: "number", step: 1, min: 0 },
        };
    }
    
    rendererParameterModified(name, value) {
        if (name == "canvasWidth" || name == "canvasHeight")
            this.resizeCanvas(name == "canvasWidth"  ? value : this.canvas.width,
                              name == "canvasHeight" ? value : this.canvas.height);
        else {
            const requires_reset = { doRandomSample: true, maxBounceDepth: true, fireflyClamp: true };
            this[name] = value;
            if (requires_reset[name])
                this.resetDrawCount();
        }
    }

    destroy() {
        if (this.tracerShaderProgram)
            this.gl.deleteProgram(this.tracerShaderProgram);
        
        for (let s of this.textures)
            for (let t of Object.values(s))
                t.destroy();
        
        this.gl.deleteFramebuffer(this.tracerBuffer);

        for (const q of this.pendingTimerQueries)
            this.gl.deleteQuery(q);
        this.pendingTimerQueries = [];

        this.webgl_helper.destroy(   this.gl);
        this.adapters.world.destroy( this.gl);
        this.adapters.camera.destroy(this.gl);
    }
    
    buildShaders(gl, canvas, callback) {
        
        // Create framebuffers into which we can render intermediary results
        this.tracerBuffer = gl.createFramebuffer();

        // Create the position buffer data for a polygon covering the image.
        this.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                 1.0,  1.0,
                -1.0,  1.0,
                 1.0, -1.0,
                -1.0, -1.0
            ]), gl.STATIC_DRAW);

        const fsSource =
                "#version 300 es \n"
                    + this.getShaderSourceDeclarations()
                    + this.getShaderSource();
        this.tracerFragmentSource = fsSource;
        this.shaderLineCount = (fsSource.match(/\n/g)||[]).length + 1;
        myconsole.log(`Compiling generated shader with ${this.shaderLineCount} lines`);

        
        WebGLHelper.compileMultipleShaderProgramsFromSources(gl,
            // Compile and link shader program for the tracer
            [{
                vertex: `#version 300 es
                    precision highp float;
                    in vec4 vertexPosition;
                    void main() {
                        gl_Position = vertexPosition;
                    }`,
            
                fragment: fsSource
            },
            
            // Because we're rendering to a texture, we also need a simple pass-through shader
            {
                vertex: `#version 300 es
                    precision highp float;
                    in vec4 vertexPosition;
                    out vec2 textureCoord;
                    void main() {
                        textureCoord = (vertexPosition.xy+1.0)/2.0;
                        gl_Position = vertexPosition;
                    }`,
                    
                fragment: `#version 300 es
                    precision mediump float;
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
                        
                        if (any(isnan(sampleColor)))
                            sampleColor = vec4(1.0, 0.0, 0.5, 1.0);
                        if (any(isinf(sampleColor)))
                            sampleColor = vec4(0.0, 1.0, 0.5, 1.0);
                        if (any(lessThan(sampleColor.rgb, vec3(0.0))))
                            sampleColor = vec4(0.5, 0.0, 1.0, 1.0);
                        
                        if (uColorLogScale > 0.0)
                            sampleColor = vec4(log(sampleColor.rgb + 1.0) / uColorLogScale, sampleColor.a);
                        
                        outTexelColor = vec4(sampleColor.rgb, 1.0);
                        gl_FragDepth = min(sampleColor.a / uMaxDepth, 1.0-EPSILON);
                    }`
            }], 
            ([tracerShaderProgram, passthroughShaderProgram]) => {
                this.tracerShaderProgram = tracerShaderProgram;
                this.passthroughShaderProgram = passthroughShaderProgram;
                        
                        // Tell WebGL how to pull out the positions from the position buffer into the vertexPosition attribute.
                        // (Bound again here: compiling is asynchronous, so something else may be bound by now.)
                        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
                        for (let shaderName of ['tracer', 'passthrough']) {
                            const attrib = this[shaderName + 'VertexAttrib'] = gl.getAttribLocation(this[shaderName + 'ShaderProgram'], 'vertexPosition');
                            gl.vertexAttribPointer(attrib, 2, gl.FLOAT, false, 0, 0);
                            gl.enableVertexAttribArray(attrib);
                        }
                        
                        // Store the addresses of uniforms that will be repeatedly modified
                        this.uniforms = {
                            randomSeed:                  gl.getUniformLocation(this.tracerShaderProgram,      "uRandomSeed"),
                            doRandomSample:              gl.getUniformLocation(this.tracerShaderProgram,      "uRendererRandomMultisample"),
                            maxBounceDepth:              gl.getUniformLocation(this.tracerShaderProgram,      "uMaxBounceDepth"),
                            tracerSampleCount:           gl.getUniformLocation(this.tracerShaderProgram,      "uSampleCount"),
                            fireflyClamp:                gl.getUniformLocation(this.tracerShaderProgram,      "uFireflyClamp"),
                                                         
                            tracerTexture_render:        gl.getUniformLocation(this.tracerShaderProgram,      "uSampleSumTexture"),
                            tracerTexture_normal:        gl.getUniformLocation(this.tracerShaderProgram,      "uNormalSumTexture"),
                            tracerTexture_variance:      gl.getUniformLocation(this.tracerShaderProgram,      "uVarianceTexture"),
                                                         
                            passthroughTexture_render:   gl.getUniformLocation(this.passthroughShaderProgram, "uSampleSumTexture"),
                            passthroughTexture_variance: gl.getUniformLocation(this.passthroughShaderProgram, "uVarianceTexture"),
                            passthroughTexture_normal:   gl.getUniformLocation(this.passthroughShaderProgram, "uNormalSumTexture"),
                                                         
                            passthroughSampleCount:      gl.getUniformLocation(this.passthroughShaderProgram, "uSampleCount"),
                            colorLogScale:               gl.getUniformLocation(this.passthroughShaderProgram, "uColorLogScale"),
                            maxDepth:                    gl.getUniformLocation(this.passthroughShaderProgram, "uMaxDepth"),
                            doDenoise:                   gl.getUniformLocation(this.passthroughShaderProgram, "uDoDenoise"),
                            denoiseThreshold:            gl.getUniformLocation(this.passthroughShaderProgram, "uDenoiseThreshold"),
                            denoiseSigma:                gl.getUniformLocation(this.passthroughShaderProgram, "uDenoiseSigma"),
                            denoiseKSigma:               gl.getUniformLocation(this.passthroughShaderProgram, "uDenoiseKSigma"),
                            denoiseNormalPower:          gl.getUniformLocation(this.passthroughShaderProgram, "uDenoiseNormalPower")
                        };
                        
                        if (callback)
                            callback();
            
            });
    }
    
    getShaderSourceDeclarations() {
        let ret = this.webgl_helper.getShaderSourceDeclarations() + "\n"
        +  `
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
            };
            vec4 rendererRayColor(in Ray in_ray, inout vec2 random_seed, inout vec4 first_hit_normal);
            uniform int uMaxBounceDepth;` + "\n";
        return ret
            + this.adapters.world.getShaderSourceDeclarations()  + "\n"
            + this.adapters.camera.getShaderSourceDeclarations() + "\n";
    }
    getShaderSource() {
        let ret = `
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
                    // canvasCoord += pixelSize * (rand2f(random_seed) - vec2(0.5)); // box filter
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
            vec4 rendererRayColor(in Ray in_ray, inout vec2 random_seed, inout vec4 first_hit_normal) {
                vec3 total_color = vec3(0.0);
                float initial_intersection_distance = 1E20;
                
                Ray r = in_ray;
                vec3 attenuation_color = vec3(1);
                ${Array.from({length: WebGLRendererAdapter.debugBallastRegisters}, (_, b) =>
                    `vec4 ballast${b} = vec4(uRandomSeed + ${(b + 0.123).toFixed(3)});`).join("\n                ")}

                // Camera rays see lights directly; after that, only exact bounces do (see worldRayColorShallow).
                bool countEmission = true;

                int i = 0;
                for (;i < uMaxBounceDepth; ++i) {
                    vec4 intersect_position = vec4(0);
                    vec3 intersect_normal = vec3(0);
                    RecursiveNextRays nextRays = RecursiveNextRays(0.0, vec4(0), vec3(0), 0.0, vec4(0), vec3(0), false, false);
                    vec3 contribution = attenuation_color * worldRayColorShallow(r, random_seed, intersect_position, nextRays, intersect_normal, countEmission);
                    ${WebGLRendererAdapter.debugTraversalHeatmap
                        // Heatmap mode returns before setting intersect_position, so the loop breaks before the normal
                        // is normally recorded. Record it here instead: it holds raw (nodes, prims, hit) counts.
                        ? `if (i == 0) first_hit_normal.xyz = intersect_normal;` : ``}

                    // Firefly clamp: cap the luminance of INDIRECT contributions (bounce >= 1) only. Directly
                    // visible surfaces and emitters (i == 0) are never clamped, so bright lights render at full
                    // intensity; only rare bright outliers from deeper bounces (the actual fireflies) are tamed.
                    if (i > 0 && uFireflyClamp > 0.0) {
                        float lum = max(max(contribution.r, contribution.g), contribution.b);
                        if (lum > uFireflyClamp)
                            contribution *= uFireflyClamp / lum;
                    }
                    total_color += contribution;
                    ${Array.from({length: WebGLRendererAdapter.debugBallastRegisters}, (_, b) =>
                        `ballast${b} += intersect_position + float(i);`).join("\n                    ")}

                    if (intersect_position.w == 0.0)
                        break;
                    
                    if (i == 0) {
                        initial_intersection_distance = length(r.o - intersect_position);
                        first_hit_normal.xyz = intersect_normal;
                    }
                    
                    bool do_next_ray = false;
                    
                    float next_ray_probability_sum = nextRays.reflectionProbability + nextRays.transmissionProbability;
                    if (next_ray_probability_sum > 0.0) {
                    
                        float next_ray_probability_sample = randf(random_seed) * max(next_ray_probability_sum, 1.0);
                        
                        next_ray_probability_sample -= nextRays.reflectionProbability;
                        if (next_ray_probability_sample <= 0.0
                            && normSquared(nextRays.reflectionDirection) > EPSILON)
                        {
                            r = Ray(intersect_position, nextRays.reflectionDirection);
                            attenuation_color *= nextRays.reflectionColor * max(next_ray_probability_sum, 1.0);
                            countEmission = nextRays.reflectionExact;
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
                }
                ${WebGLRendererAdapter.debugBallastRegisters > 0
                    ? `float ballastSum = 0.0; `
                        + Array.from({length: WebGLRendererAdapter.debugBallastRegisters}, (_, b) =>
                            `ballastSum += dot(ballast${b}, vec4(1.0));`).join(" ")
                        + ` total_color += vec3(ballastSum * 1e-30);`
                    : ``}

                first_hit_normal.w = float(i);
                return vec4(total_color, initial_intersection_distance);
            }`;
        return ret
            + this.webgl_helper.getShaderSource()
            + this.adapters.world.getShaderSource()
            + this.adapters.camera.getShaderSource();
    }
    
    writeShaderData() {
        this.gl.useProgram(this.tracerShaderProgram);
        
        this.gl.uniform2fv(this.gl.getUniformLocation(this.tracerShaderProgram, "uCanvasSize"), Vec.from([this.canvas.width, this.canvas.height]));
        
        this.webgl_helper.writeShaderData(this.gl, this.tracerShaderProgram);
        this.adapters.world.writeShaderData(this.gl, this.tracerShaderProgram, this.webgl_helper);
        this.adapters.camera.writeShaderData(this.gl, this.tracerShaderProgram, this.webgl_helper);
    }
    // Call after changing the world's structure (adding or removing objects or lights, or moving them between
    // aggregates). The world is visited again and all of its data re-uploaded. The shader is only recompiled if the
    // regenerated source differs from the compiled one: the editable shader (worldEditable) is written so that it
    // doesn't depend on what the scene contains, so it normally isn't, while the regular shader always is.
    // callback(recompiled) runs once the new world is being drawn.
    worldModified(callback=null) {
        const start = performance.now();
        const world = this.renderer.world;
        world.contentsChanged();
        this.adapters.world.visitWorld(world, this.webgl_helper);
        const fsSource = "#version 300 es \n" + this.getShaderSourceDeclarations() + this.getShaderSource();
        const finish = recompiled => {
            this.writeShaderData();
            this.resetDrawCount();
            this.lastWorldRebuild = { recompiled: recompiled, milliseconds: performance.now() - start };
            myconsole.log(`World rebuilt in ${(this.lastWorldRebuild.milliseconds / 1000).toFixed(3)} seconds`
                + (recompiled ? " (shader recompiled)." : " (no recompile needed)."));
            if (callback)
                callback(recompiled);
        };
        if (fsSource === this.tracerFragmentSource)
            return finish(false);

        // The source changed: rebuild the shader programs. Drawing is paused until they're ready.
        const gl = this.gl;
        this.rebuildingShaders = true;
        gl.deleteProgram(this.tracerShaderProgram);
        gl.deleteProgram(this.passthroughShaderProgram);
        gl.deleteFramebuffer(this.tracerBuffer);
        gl.deleteBuffer(this.positionBuffer);
        this.tracerShaderProgram = this.passthroughShaderProgram = null;
        this.buildShaders(gl, this.canvas, () => {
            this.rebuildingShaders = false;
            finish(true);
        });
    }
    
    resetDrawCount() {
        this.drawCount = 0;
    }
    
    useTracerProgram() {
        this.gl.useProgram(this.tracerShaderProgram);
    }
    getUniformLocation(name) {
        return this.gl.getUniformLocation(this.tracerShaderProgram, name)
    }

    moveCamera(rotateDelta, translateDelta) {
        this.gl.useProgram(this.tracerShaderProgram);
        if (this.adapters.camera.moveCamera(rotateDelta, translateDelta, this.gl, this.tracerShaderProgram))
            this.resetDrawCount();
    }
    setCameraTransform(transform, inv_transform) {
        this.gl.useProgram(this.tracerShaderProgram);
        this.adapters.camera.setTransform(transform, inv_transform, this.gl, this.tracerShaderProgram);
        this.resetDrawCount();
    }
    getCameraViewMatrix() {
        return this.adapters.camera.getViewMatrix();
    }
    getCameraTransform() {
        return this.adapters.camera.getTransform();
    }
    getCameraInverseTransform() {
        return this.adapters.camera.getInverseTransform();
    }
    getCameraPosition() {
        return this.adapters.camera.getPosition();
    }
    
    getMutableCameraParameters() {
        return this.adapters.camera.getMutableParameters();
    }
    cameraParameterModified(name, ...values) {
        this.gl.useProgram(this.tracerShaderProgram);
        if (this.adapters.camera.parameterModified(this.gl, this.tracerShaderProgram, name, ...values))
            this.resetDrawCount();
    }
    
    modifyMaterialSolidColor(material_index, new_color) {
        this.adapters.world.modifyMaterialSolidColor(material_index, new_color);
        this.resetDrawCount();
    }
    modifyMaterialScalar(material_index, new_scalar) {
        this.adapters.world.modifyMaterialScalar(material_index, new_scalar);
        this.resetDrawCount();
    }
    
    getRayForPixel(raster_x, raster_y) {
        const x =  2 * (raster_x / this.canvas.width)  - 1;
        const y = -2 * (raster_y / this.canvas.height) + 1;
        return this.adapters.camera.camera.getRayForPixel(x, y);
    }
    selectObjectAt(x, y) {
        return this.adapters.world.intersectRay(this.getRayForPixel(x, y), this, this.gl, this.tracerShaderProgram);
    }
    getLights() {
        return this.adapters.world.getLights(this, this.gl, this.tracerShaderProgram);
    }
    getLight(index) {
        return this.adapters.world.getLight(index, this, this.gl, this.tracerShaderProgram);
    }
    getObject(index) {
        return this.adapters.world.getObject(index, this, this.gl, this.tracerShaderProgram);
    }
    getSceneTree() {
        return this.adapters.world.getSceneTree(this.gl, this, this.tracerShaderProgram);
    }

    // In heatmap mode the normal-sum buffer accumulates raw per-pixel (nodes, prims, hit) counts across samples (see
    // WebGLWorldAdapter.worldRayColorShallow). Read it back, average per pixel, and log the distribution, both over
    // pixels whose primary ray hit geometry and over all pixels (background rays inside the root box still traverse).
    // Byte estimates assume one 16-byte texel per node and 4 texels (12-byte index + 3x 12-byte vertex) per triangle
    // test; prims that aren't untransformed BVH triangles cost differently, so treat that column as approximate.
    reportHeatmapStats() {
        const now = performance.now();
        if (this._lastHeatmapStatsTime !== undefined
            && now - this._lastHeatmapStatsTime < WebGLRendererAdapter.debugHeatmapStatsIntervalMs)
            return;
        this._lastHeatmapStatsTime = now;

        const gl = this.gl, w = this.canvas.width, h = this.canvas.height, count = w * h;
        if (!this._heatmapReadback || this._heatmapReadback.length != count * 4)
            this._heatmapReadback = new Float32Array(count * 4);
        const px = this._heatmapReadback;

        // The normal buffer is COLOR_ATTACHMENT1 of tracerBuffer, which still holds the just-written textures[0].
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.tracerBuffer);
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // Number of samples summed into the buffer just read (drawCount is incremented after this call).
        const n = this.doRandomSample ? this.drawCount + 1 : 1;

        const hitNodes = new Float64Array(count), hitPrims = new Float64Array(count);
        let hits = 0, allNodeSum = 0, allPrimSum = 0;
        for (let i = 0; i < count; ++i) {
            const nodes = px[4 * i] / n, prims = px[4 * i + 1] / n, hit = px[4 * i + 2] / n;
            allNodeSum += nodes;
            allPrimSum += prims;
            if (hit > 0.5) {
                hitNodes[hits] = nodes;
                hitPrims[hits] = prims;
                ++hits;
            }
        }

        function summarize(arr) {
            if (!arr.length)
                return null;
            const s = Float64Array.from(arr).sort();
            const pct = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
            let sum = 0;
            for (const v of s) sum += v;
            return { mean: sum / s.length, p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: s[s.length - 1] };
        }
        const fmt = st => st ? `mean ${st.mean.toFixed(1)}, p50 ${st.p50.toFixed(1)}, p90 ${st.p90.toFixed(1)}, `
            + `p99 ${st.p99.toFixed(1)}, max ${st.max.toFixed(1)}` : `n/a`;

        // "BVH rays": pixels whose primary ray got past the BVH root box (more than one node fetched), whether or not
        // it ended up hitting anything. This excludes rays that only pay the root-box fetch and then hit (or miss)
        // something outside the BVH, which otherwise dominate the hit-pixel median.
        const bvhNodes = new Float64Array(count), bvhPrims = new Float64Array(count);
        let bvhRays = 0;
        for (let i = 0; i < count; ++i) {
            const nodes = px[4 * i] / n;
            if (nodes > 1.5) {
                bvhNodes[bvhRays] = nodes;
                bvhPrims[bvhRays] = px[4 * i + 1] / n;
                ++bvhRays;
            }
        }
        const bn = summarize(bvhNodes.subarray(0, bvhRays)), bp = summarize(bvhPrims.subarray(0, bvhRays));

        const hn = summarize(hitNodes.subarray(0, hits)), hp = summarize(hitPrims.subarray(0, hits));
        const allNodeMean = allNodeSum / count, allPrimMean = allPrimSum / count;
        const bytes = (nodes, prims) => `~${(16 * nodes + 48 * prims).toFixed(0)} B/ray `
            + `(nodes ${(16 * nodes).toFixed(0)} B, tris ${(48 * prims).toFixed(0)} B)`;

        this.lastHeatmapStats = {
            hitPixelsPct: 100 * hits / count, bvhRaysPct: 100 * bvhRays / count,
            bvhNodes: bn, bvhPrims: bp, hitNodes: hn, hitPrims: hp, allNodeMean, allPrimMean };
        myconsole.log(
            `Heatmap stats (${w}x${h}, ${n} sample${n == 1 ? "" : "s"}, ${(100 * hits / count).toFixed(1)}% pixels hit):\n` +
            `  hit pixels   nodes: ${fmt(hn)}\n` +
            `  hit pixels   prims: ${fmt(hp)}\n` +
            `  hit pixels   ${hn ? bytes(hn.mean, hp.mean) : "n/a"}\n` +
            `  BVH rays (${(100 * bvhRays / count).toFixed(1)}% of pixels) nodes: ${fmt(bn)}\n` +
            `  BVH rays     prims: ${fmt(bp)}\n` +
            `  BVH rays     ${bn ? bytes(bn.mean, bp.mean) : "n/a"}\n` +
            `  all pixels   nodes mean ${allNodeMean.toFixed(1)}, prims mean ${allPrimMean.toFixed(1)}, ${bytes(allNodeMean, allPrimMean)}`);
    }

    // ---- GPU timer queries (debugGPUTimer) ----
    beginGPUTimer() {
        if (!WebGLRendererAdapter.debugGPUTimer && !(this.benchState && this.benchState.collecting))
            return null;
        if (!this.timerExt) {
            if (!this.warnedNoTimerExt)
                myconsole.error("debugGPUTimer: EXT_disjoint_timer_query_webgl2 is not available in this browser/GPU.");
            this.warnedNoTimerExt = true;
            return null;
        }
        const query = this.gl.createQuery();
        this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, query);
        return query;
    }
    endGPUTimer(query) {
        if (!query)
            return;
        this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
        this.pendingTimerQueries.push(query);
        this.collectGPUTimers();
    }
    collectGPUTimers() {
        const gl = this.gl;

        // A disjoint event invalidates every query in flight; drop them all rather than record bogus times.
        if (gl.getParameter(this.timerExt.GPU_DISJOINT_EXT)) {
            for (const q of this.pendingTimerQueries)
                gl.deleteQuery(q);
            this.pendingTimerQueries = [];
            return;
        }

        // Queries complete in order, so stop at the first one whose result isn't ready yet.
        while (this.pendingTimerQueries.length && gl.getQueryParameter(this.pendingTimerQueries[0], gl.QUERY_RESULT_AVAILABLE)) {
            const q = this.pendingTimerQueries.shift();
            const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; // ns -> ms
            this.gpuTimesMs.push(ms);
            if (this.benchState && this.benchState.collecting && !this.benchState.done)
                this.benchState.samples.push(ms);
            gl.deleteQuery(q);
        }
        // Don't let queries pile up without bound if results stop arriving.
        // (Generous, since with several draws per frame and a saturated GPU, results can lag by dozens of queries.)
        while (this.pendingTimerQueries.length > 512)
            gl.deleteQuery(this.pendingTimerQueries.shift());

        const now = performance.now();
        if (WebGLRendererAdapter.debugGPUTimer && now - this.lastGPUTimerReport >= WebGLRendererAdapter.debugGPUTimerIntervalMs) {
            this.lastGPUTimerReport = now;
            const t = this.gpuTimesMs.sort((a, b) => a - b);
            this.gpuTimesMs = [];
            if (t.length) {
                const mean = t.reduce((s, v) => s + v, 0) / t.length;
                const pct = p => t[Math.min(t.length - 1, Math.floor(p * t.length))];
                myconsole.log(`GPU tracer pass (${t.length} draws): mean ${mean.toFixed(2)} ms, `
                    + `p50 ${pct(0.5).toFixed(2)} ms, min ${t[0].toFixed(2)} ms, p90 ${pct(0.9).toFixed(2)} ms `
                    + `(~${(1000 / mean).toFixed(0)} tracer passes/s)`);
            }
        }
    }

    // ---- Benchmark harness (see the static bench* fields) ----
    // Called once per drawWorld, before the texture rotate, while textures[0] is still attached to tracerBuffer.
    benchTick() {
        const B = WebGLRendererAdapter;
        const now = performance.now();
        if (!this.benchState)
            this.benchState = { start: now, collecting: false, done: false, samples: [] };
        const b = this.benchState;
        if (b.done)
            return;
        if (!b.collecting && now - b.start >= B.benchWarmupMs) {
            b.collecting = true;
            b.collectStart = now;
            b.samples = [];
        }
        if (b.collecting && now - b.collectStart >= B.bench * 1000)
            this.finishBench();
    }
    // Read the accumulated render buffer and return a 64x64 per-pixel-average downsample (RGB), plus NaN/inf count.
    benchReadImage() {
        const gl = this.gl, w = this.canvas.width, h = this.canvas.height, D = 64;
        const px = new Float32Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.tracerBuffer);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const n = this.doRandomSample ? this.drawCount + 1 : 1;
        const sum = new Float64Array(D * D * 3), cnt = new Float64Array(D * D);
        let bad = 0;
        for (let y = 0; y < h; ++y) {
            const dy = Math.min(D - 1, Math.floor(y * D / h));
            for (let x = 0; x < w; ++x) {
                const i = 4 * (y * w + x), r = px[i] / n, g = px[i + 1] / n, bl = px[i + 2] / n;
                if (!isFinite(r) || !isFinite(g) || !isFinite(bl)) { ++bad; continue; }
                const d = dy * D + Math.min(D - 1, Math.floor(x * D / w));
                sum[3 * d] += r; sum[3 * d + 1] += g; sum[3 * d + 2] += bl; ++cnt[d];
            }
        }
        const down = new Array(D * D * 3);
        for (let d = 0; d < D * D; ++d)
            for (let c = 0; c < 3; ++c)
                down[3 * d + c] = cnt[d] ? sum[3 * d + c] / cnt[d] : 0;
        return { down, nonFinitePixels: bad, samples: n };
    }
    finishBench() {
        const B = WebGLRendererAdapter, b = this.benchState;
        b.done = true;
        b.collecting = false;

        const t = b.samples.slice().sort((x, y) => x - y);
        const pct = p => t.length ? t[Math.min(t.length - 1, Math.floor(p * t.length))] : null;
        const r3 = v => (v === null || v === undefined) ? v : Math.round(v * 1000) / 1000;
        const gpu = t.length ? {
            draws: t.length, mean: r3(t.reduce((s, v) => s + v, 0) / t.length),
            p10: r3(pct(0.1)), p50: r3(pct(0.5)), p90: r3(pct(0.9)), min: r3(t[0]) } : null;

        const flags = {};
        for (const k of Object.keys(B))
            if (k.startsWith("debug") && !k.startsWith("debugGPUTimer") && !k.startsWith("debugHeatmapStats"))
                flags[k] = B[k];

        const img = this.benchReadImage();
        let ref = null;
        try {
            if (B.benchRef == "save") {
                localStorage.setItem(B.benchRefKey, JSON.stringify(img.down));
                ref = { saved: B.benchRefKey };
            }
            else if (B.benchRef == "compare") {
                const stored = JSON.parse(localStorage.getItem(B.benchRefKey) || "null");
                if (stored && stored.length == img.down.length) {
                    let se = 0, maxAbs = 0, refMean = 0;
                    for (let i = 0; i < stored.length; ++i) {
                        const d = img.down[i] - stored[i];
                        se += d * d;
                        maxAbs = Math.max(maxAbs, Math.abs(d));
                        refMean += Math.abs(stored[i]);
                    }
                    refMean /= stored.length;
                    const rmse = Math.sqrt(se / stored.length);
                    ref = { key: B.benchRefKey, rmse: r3(rmse * 1000) / 1000, relRmse: r3(refMean ? rmse / refMean : 0), maxAbs: r3(maxAbs) };
                }
                else
                    ref = { error: "no stored reference under " + B.benchRefKey };
            }
        } catch (e) { ref = { error: String(e) }; }

        let meanRGB = [0, 0, 0];
        for (let i = 0; i < img.down.length; ++i) meanRGB[i % 3] += img.down[i];
        meanRGB = meanRGB.map(v => r3(v / (img.down.length / 3)));

        const result = {
            test: new URLSearchParams(window.location.search).get("test"),
            flags, maxBounceDepth: this.maxBounceDepth,
            compileSeconds: this.compileSeconds, shaderLines: this.shaderLineCount,
            canvas: [this.canvas.width, this.canvas.height], accumulatedSamples: img.samples,
            gpu, nonFinitePixels: img.nonFinitePixels, meanRGB, ref,
            heatmap: this.lastHeatmapStats || null,
            timerExt: !!this.timerExt
        };
        window.benchResult = result;
        myconsole.log("BENCH_RESULT " + JSON.stringify(result));
        if (typeof window.onBenchResult === "function")
            window.onBenchResult(result);
    }

    drawWorld(timestamp) {
        if (this.rebuildingShaders || !this.tracerShaderProgram)
            return;
        // Clear the screen, on all 4 standard channels.
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        
        // Tell WebGL to use our tracer program when drawing
        this.gl.useProgram(this.tracerShaderProgram);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.tracerBuffer);
        
        // Write the uniforms that vary between frames, 
        this.gl.uniform1f(this.uniforms.randomSeed, Math.random());
        this.gl.uniform1i(this.uniforms.doRandomSample, this.doRandomSample);
        this.gl.uniform1i(this.uniforms.tracerSampleCount, this.doRandomSample ? this.drawCount : 0);
        this.gl.uniform1i(this.uniforms.maxBounceDepth, this.maxBounceDepth);
        this.gl.uniform1f(this.uniforms.fireflyClamp, this.fireflyClamp);
        
        
        // Okay, this next part is simple, but looks complicated.
        // Basically, we have several different types of outputs (e.g., render, normal, error), each of which
        // has an array of associated textures we use to pass data between iterations. As we cannot write and read from
        // the same texture/buffer at the same time, we read from textures[1], and write to textures[0]. That way, at
        // the end of each iteration, we can just rotate the array of textures by one, and the previously written texture
        // will automatically be in the read slot.
        for (let k of WebGLRendererAdapter.BUFFER_TYPES) {
            // Give the shader access to textures[1] to read from and add to new sample(s)
            this.textures[1][k].bind(this.textureUnits[k]);
            this.gl.uniform1i(this.uniforms["tracerTexture_" + k], WebGLHelper.textureUnitIndex(this.textureUnits[k]));
        }
        
        // Set the buffers to render to textures[0]
        for (let [i,k] of ["render", "normal", "variance"].entries())
            this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl["COLOR_ATTACHMENT" + i],
                this.gl.TEXTURE_2D, this.textures[0][k].id(), 0);

        this.gl.drawBuffers(WebGLRendererAdapter.BUFFER_TYPES.map((x,i) => this.gl["COLOR_ATTACHMENT"+i]));
        if (this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER) === this.gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT)
            throw "Bad framebuffer texture linking";
        
        // Do ray-tracing shader magic, by rendering a simple square.
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
        this.gl.vertexAttribPointer(this.tracerVertexAttrib, 2, this.gl.FLOAT, false, 0, 0);
        const timerQuery = this.beginGPUTimer();
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
        this.endGPUTimer(timerQuery);
        
        
        // Alright, time to use the passthrough shader to clean up all our weird intermediary results
        // First, unset the framebuffer, so that webgl will output directly to the canvas, then switch to the passthrough shader.
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.useProgram(this.passthroughShaderProgram);
        
        // Set textures[0] (the textures that were just rendered/written to) to be readable in the passthrough/filter shader
        for (let k of ["render", "normal", "variance"]) {
            this.textures[0][k].bind(this.textureUnits[k]);
            this.gl.uniform1i(this.uniforms["passthroughTexture_" + k], WebGLHelper.textureUnitIndex(this.textureUnits[k]));
        }
        
        // Set passthrough uniforms. These are (almost) entirely modifiable within the UI.
        this.gl.uniform1f(this.uniforms.colorLogScale, this.colorLogScale);
        this.gl.uniform1f(this.uniforms.maxDepth, this.maxDepth);
        this.gl.uniform1i(this.uniforms.passthroughSampleCount, this.doRandomSample ? this.drawCount : 0);
        
        this.gl.uniform1i(this.uniforms.doDenoise, this.doDenoise);
        this.gl.uniform1f(this.uniforms.denoiseSigma, this.denoiseSigma);
        this.gl.uniform1f(this.uniforms.denoiseKSigma, this.denoiseKSigma);
        this.gl.uniform1f(this.uniforms.denoiseThreshold, this.denoiseThreshold);
        this.gl.uniform1f(this.uniforms.denoiseNormalPower, this.denoiseNormalPower);

        
        // Finally, draw with the passthrough shader. Note that this uses the same geometry array buffer that was used
        //      for the tracer shader, as nothing else has been bound to the relevant buffer since.
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
        
        
        // Heatmap diagnostics: periodically read back the raw traversal counts (must happen before the rotate below,
        // while textures[0] is still the set attached to tracerBuffer).
        if (WebGLRendererAdapter.debugTraversalHeatmap && WebGLRendererAdapter.debugHeatmapStatsIntervalMs > 0)
            this.reportHeatmapStats();
        if (WebGLRendererAdapter.bench > 0)
            this.benchTick();

        // Rotate each list of textures, so the next textures read from will be the last textures rendered.
        this.textures.rotate();
        
        
        // Update the draw count, which is used for multisample blending.
        ++this.drawCount;
    }
}