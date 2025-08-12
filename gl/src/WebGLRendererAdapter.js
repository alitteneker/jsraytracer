class WebGLRendererAdapter {
    static BUFFER_COUNT = 2;
    static BUFFER_TYPES = ["render", "error", "normal"];
    
    constructor(gl, canvas, renderer) {
        
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearDepth(1.0);
        
        // Store some useful initial variable values
        this.doRandomSample = true;
        this.drawCount = 0;
        
        // Sometimes it's useful to render into log color space, scaled to an appropriate level
        this.colorLogScale = 0.0;
        this.maxDepth = 1000.0;
        
        // We also include a denoiser with the passthrough shader. Let's specify some default parameters here.
        this.doDenoise = false;
        this.denoiseSigma = 5;
        this.denoiseKSigma = 2;
        this.denoiseThreshold = 0.1;
        
        // store the canvas and renderer for future usage
        this.canvas = canvas;
        this.renderer = renderer;
        
        this.maxBounceDepth = renderer.maxRecursionDepth;
        
        // create and store utility variables for managing the WebGL context
        this.gl = gl;
        this.webgl_helper = new WebGLHelper(gl);
        
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
            world:  new WebGLWorldAdapter( renderer.world,  this.webgl_helper, this)
        };
    }
    
    static build(gl, canvas, renderer, callback) {
        myconsole.log("Building adapters...");
        const ret = new WebGLRendererAdapter(gl, canvas, renderer);
        
        // Build the shader programs to make this render
        const start = Date.now();
        myconsole.log("Building shader...");
        ret.buildShaders(ret.gl, canvas, () => {
            myconsole.log(`Shader successfully built in ${(Date.now() - start) / 1000} seconds.`);
            
            // Write data to shaders
            myconsole.log("Writing shader data...");
            ret.writeShaderData(ret.gl);
            
            if (callback)
                callback(ret);
        });
    }
    
    resizeCanvas(new_width, new_height) {
        if (isNaN(new_width) || new_width < 1 || isNaN(new_height) || new_height < 1)
            return;
        
        this.canvas.width = new_width;
        this.canvas.height = new_height;
        
        for (let t of this.textures)
            for (let t of a)
                t.setPixels(null, 4, "FLOAT", new_width, new_height);
        this.gl.viewport(0, 0, new_width, new_height);
        
        this.gl.useProgram(this.tracerShaderProgram);
        this.gl.uniform2fv(this.gl.getUniformLocation(this.tracerShaderProgram, "uCanvasSize"), Vec.of(new_width, new_height));
        this.resetDrawCount();
    }

    destroy() {
        if (this.tracerShaderProgram)
            this.gl.deleteProgram(this.tracerShaderProgram);
        
        for (let s of this.textures)
            for (let t of Object.values(s))
                t.destroy();
        
        for (let b of Object.values(this.buffers))
            this.gl.deleteFramebuffer(b);
        
        this.webgl_helper.destroy(   this.gl);
        this.adapters.world.destroy( this.gl);
        this.adapters.camera.destroy(this.gl);
    }
    
    buildShaders(gl, canvas, callback) {
        
        // Create framebuffers into which we can render intermediary results
        this.buffers = {};
        for (let k of WebGLRendererAdapter.BUFFER_TYPES)
            this.buffers[k] = gl.createFramebuffer();

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
        myconsole.log(`Compiling generated shader with ${(fsSource.match(/\n/g)||[]).length + 1} lines`);

        
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
                    uniform sampler2D uNormalSumTexture;
					uniform int uSampleCount;
                    in vec2 textureCoord;
                    
                    uniform float uMaxDepth;
                    uniform float uColorLogScale;
                    
                    uniform bool uDoDenoise;
                    uniform float uDenoiseThreshold;
                    uniform float uDenoiseSigma;
                    uniform float uDenoiseKSigma;

                    // The following function is from https://github.com/BrutPitt/glslSmartDeNoise/tree/master
                    // Parameters:
                    //      sampler2D tex             - sampler image / texture
                    //      vec2 uv                   - actual fragment coord
                    //      float texture_factor      - multiplier for values from render texture
                    //      float uDenoiseSigma  >  0 - sigma Standard Deviation
                    //      float uDenoiseKSigma >= 0 - sigma coefficient
                    //          uDenoiseKSigma * uDenoiseSigma  -->  radius of the circular kernel
                    //      float uDenoiseThreshold   - edge sharpening threshold
                    vec4 smartDeNoise(in sampler2D tex, in vec2 uv, in float texture_factor) {
                        float radius = round(uDenoiseKSigma * uDenoiseSigma);
                        float radQ = radius * radius;

                        float invSigmaQx2 = .5 / (uDenoiseSigma * uDenoiseSigma);      // 1.0 / (uDenoiseSigma^2 * 2.0)
                        float invSigmaQx2PI = INV_PI * invSigmaQx2;                    // // 1/(2 * PI * uDenoiseSigma^2)

                        float invThresholdSqx2 = .5 / (uDenoiseThreshold * uDenoiseThreshold);     // 1.0 / (uDenoiseSigma^2 * 2.0)
                        float invThresholdSqrt2PI = INV_SQRT_OF_2PI / uDenoiseThreshold;           // 1.0 / (sqrt(2*PI) * uDenoiseSigma)

                        vec4 centrPx = texture(tex, uv) * texture_factor;

                        float zBuff = 0.0;
                        vec4 aBuff = vec4(0.0);
                        vec2 size = vec2(textureSize(tex, 0));

                        vec2 d;
                        for (d.x=-radius; d.x <= radius; d.x++) {
                            float pt = sqrt(radQ-d.x*d.x);       // pt = yRadius: have circular trend
                            for (d.y=-pt; d.y <= pt; d.y++) {
                                float blurFactor = exp( -dot(d , d) * invSigmaQx2 ) * invSigmaQx2PI;

                                vec4 walkPx =  texture(tex, uv + d / size) * texture_factor;
                                
                                vec4 dC = walkPx-centrPx;
                                float deltaFactor = exp( -dot(dC.rgb, dC.rgb) * invThresholdSqx2) * invThresholdSqrt2PI * blurFactor;

                                zBuff += deltaFactor;
                                aBuff += deltaFactor*walkPx;
                            }
                        }
                        return aBuff/zBuff;
                    }
                    
                    out vec4 outTexelColor;
                    void main() {
                        float texture_factor = 1.0 / float(max(uSampleCount + 1, 1));
                        
                        vec4 sampleColor;
                        if (uDoDenoise)
                            sampleColor = smartDeNoise(uSampleSumTexture, textureCoord, texture_factor);
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
                        for (let shaderName of ['tracer', 'passthrough']) {
                            const attrib = this[shaderName + 'VertexAttrib'] = gl.getAttribLocation(this[shaderName + 'ShaderProgram'], 'vertexPosition');
                            gl.vertexAttribPointer(attrib, 2, gl.FLOAT, false, 0, 0);
                            gl.enableVertexAttribArray(attrib);
                        }
                        
                        // Store the addresses of uniforms that will be repeatedly modified
                        this.uniforms = {
                            randomSeed:                gl.getUniformLocation(this.tracerShaderProgram,      "uRandomSeed"),
                            doRandomSample:            gl.getUniformLocation(this.tracerShaderProgram,      "uRendererRandomMultisample"),
                            maxBounceDepth:            gl.getUniformLocation(this.tracerShaderProgram,      "uMaxBounceDepth"),
                            tracerSampleCount:         gl.getUniformLocation(this.tracerShaderProgram,      "uSampleCount"),
                            
                            tracerTexture_render:      gl.getUniformLocation(this.tracerShaderProgram,      "uSampleSumTexture"),
							tracerTexture_error:       gl.getUniformLocation(this.tracerShaderProgram,      "uSampleErrorTexture"),
                            tracerTexture_normal:      gl.getUniformLocation(this.tracerShaderProgram,      "uNormalSumTexture"),
                            
                            passthroughTexture_render: gl.getUniformLocation(this.passthroughShaderProgram, "uSampleSumTexture"),
                            passthroughTexture_normal: gl.getUniformLocation(this.passthroughShaderProgram, "uNormalSumTexture"),
							
                            passthroughSampleCount:    gl.getUniformLocation(this.passthroughShaderProgram, "uSampleCount"),
                            colorLogScale:             gl.getUniformLocation(this.passthroughShaderProgram, "uColorLogScale"),
                            maxDepth:                  gl.getUniformLocation(this.passthroughShaderProgram, "uMaxDepth"),
                            doDenoise:                 gl.getUniformLocation(this.passthroughShaderProgram, "uDoDenoise"),
                            denoiseThreshold:          gl.getUniformLocation(this.passthroughShaderProgram, "uDenoiseThreshold"),
                            denoiseSigma:              gl.getUniformLocation(this.passthroughShaderProgram, "uDenoiseSigma"),
                            denoiseKSigma:             gl.getUniformLocation(this.passthroughShaderProgram, "uDenoiseKSigma")
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
            uniform sampler2D uSampleErrorTexture;
            uniform sampler2D uNormalSumTexture;
    
            uniform bool uRendererRandomMultisample;
            uniform int uSampleCount;
            uniform float uRandomSeed;
            
            uniform vec2 uCanvasSize;
            
            layout(location=0) out vec4 outSampleSum;
            layout(location=1) out vec4 outSampleError;
            layout(location=2) out vec4 outNormalSum;

            void main() {
                outSampleSum   = vec4(1.0, 0.0, 0.0, 1000.0);
                outSampleError = vec4(0.0, 1.0, 0.0, 1000.0);
                outNormalSum   = vec4(0.0, 0.0, 1.0, 1000.0);
                return;
            
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
                    outSampleError = vec4(0.0);
                    outNormalSum = firstHitNormal;
                }
                else {
                    vec4 sumSampleColor  = texture(uSampleSumTexture,   gl_FragCoord.xy / uCanvasSize);
                    vec4 sumSampleError  = texture(uSampleErrorTexture, gl_FragCoord.xy / uCanvasSize);
                    vec4 sumSampleNormal = texture(uNormalSumTexture,   gl_FragCoord.xy / uCanvasSize);

                    // The commented out line below would be simple summation, which can lead to precision issues with many samples
                    // outSampleSum = sumSampleColor + sampleColor;
                    
                    // Instead, let's use Kahan summation, which will adjust for the accumulated precision error in the sampleError buffer
                    vec4 y = sampleColor - sumSampleError;
                    vec4 t = sumSampleColor + y;
        
                    outSampleSum = t;
                    outSampleError = (t - sumSampleColor) - y;
                    
                    // Finally, add the computed normal to a buffer for possible first hit geometric edge detection.
                    // Note that the forth channel of this currently captures the number of bounces computed.
                    outNormalSum = sumSampleNormal + firstHitNormal;
                }
            }
            vec4 rendererRayColor(in Ray in_ray, inout vec2 random_seed, inout vec4 first_hit_normal) {
                vec3 total_color = vec3(0.0);
                float initial_intersection_distance = 1E20;
                
                Ray r = in_ray;
                vec3 attenuation_color = vec3(1);
                
                int i = 0;
                for (;i < uMaxBounceDepth; ++i) {
                    vec4 intersect_position = vec4(0);
                    vec3 intersect_normal = vec3(0);
                    RecursiveNextRays nextRays = RecursiveNextRays(0.0, vec4(0), vec3(0), 0.0, vec4(0), vec3(0));
                    total_color += attenuation_color * worldRayColorShallow(r, random_seed, intersect_position, nextRays, intersect_normal);
                    
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
                            do_next_ray = true;
                        }
                        
                        else {
                            next_ray_probability_sample -= nextRays.transmissionProbability;
                            if (next_ray_probability_sample <= 0.0
                                && normSquared(nextRays.transmissionDirection) > EPSILON)
                            {
                                r = Ray(intersect_position, nextRays.transmissionDirection);
                                attenuation_color *= nextRays.transmissionColor * max(next_ray_probability_sum, 1.0);
                                do_next_ray = true;
                            }
                        }
                    }
                    
                    if (!do_next_ray)
                        break;
                }
                
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
    worldModified() {
        this.adapters.world.visitWorld(this.renderer.world);
        this.writeShaderData();
        this.resetDrawCount();
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
    getCameraPosition() {
        return this.adapters.camera.getPosition();
    }
    getCameraTransform() {
        return this.adapters.camera.getTransform();
    }
    getCameraInverseTransform() {
        return this.adapters.camera.getInverseTransform();
    }
    setCameraTransform(transform, inv_transform) {
        this.gl.useProgram(this.tracerShaderProgram);
        this.adapters.camera.setTransform(transform, inv_transform, this.gl, this.tracerShaderProgram);
        this.resetDrawCount();
    }
    getCameraViewMatrix() {
        return this.adapters.camera.getViewMatrix();
    }
    getCameraFOV() {
        return this.adapters.camera.getFOV();
    }
    getCameraFocusDistance() {
        return this.adapters.camera.getFocusDistance();
    }
    getCameraSensorSize() {
        return this.adapters.camera.getSensorSize();
    }
    changeLensSettings(focusDistance, apertureSize, FOV) {
        this.gl.useProgram(this.tracerShaderProgram);
        if (this.adapters.camera.changeLensSettings(focusDistance, apertureSize, FOV, this.gl, this.tracerShaderProgram))
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
    
    changeMaxBounceDepth(newBounceDepth) {
        this.maxBounceDepth = newBounceDepth;
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

    drawWorld(timestamp) {
        // Clear the screen, on all 4 standard channels.
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        
        // Tell WebGL to use our tracer program when drawing
        this.gl.useProgram(this.tracerShaderProgram);
        
        // Write the uniforms that vary between frames, 
        this.gl.uniform1f(this.uniforms.randomSeed, Math.random());
        this.gl.uniform1i(this.uniforms.doRandomSample, this.doRandomSample);
        this.gl.uniform1i(this.uniforms.tracerSampleCount, this.doRandomSample ? this.drawCount : 0);
        this.gl.uniform1i(this.uniforms.maxBounceDepth, this.maxBounceDepth);
        
        
        // Okay, this next part is simple, but looks complicated.
        // Basically, we have several different types of buffers (e.g., render, normal, error), each of which
        // has an array of associated textures we use to pass data between iterations. As we cannot write and read from
        // the same texture/buffer at the same time, we read from textures[1], and write to textures[0]. That way, at
        // the end of each iteration, we can just rotate the array of textures by one, and the previously written texture
        // will automatically be in the read slot.
        for (let k of WebGLRendererAdapter.BUFFER_TYPES) {
            // Give the shader access to textures[1] to read from and add to new sample(s)
            this.textures[1][k].bind(this.textureUnits[k]);
            this.gl.uniform1i(this.uniforms["tracerTexture_" + k], WebGLHelper.textureUnitIndex(this.textureUnits[k]));
        }
        for (let [i,k] of ["render", "error", "normal"].entries()) {
            // Set the buffers to render to textures[0]
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.buffers[k]);
            this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl["COLOR_ATTACHMENT"+i],
                this.gl.TEXTURE_2D, this.textures[0][k].id(), 0);
            if (this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER) === this.gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT)
                throw "Bad framebuffer texture linking";
        }

        this.gl.drawBuffers(WebGLRendererAdapter.BUFFER_TYPES.map((x,i) => this.gl["COLOR_ATTACHMENT"+i]));
        
        // Do ray-tracing shader magic, by rendering a simple square.
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
        this.gl.vertexAttribPointer(this.tracerVertexAttrib, 2, this.gl.FLOAT, false, 0, 0);
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);


        const pixels = new Float32Array(4);
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.buffers.render);
        this.gl.readPixels(300,300,1,1, this.gl.RGBA, this.gl.FLOAT, pixels);
        console.log(pixels);
        
        
        // Alright, time to use the passthrough shader to clean up all our weird intermediary results
        // First, unset the framebuffer, so that webgl will output directly to the canvas, then switch to the passthrough shader.
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.useProgram(this.passthroughShaderProgram);
        
        // Set textures[0] (the textures that were just rendered/written to) to be readable in the passthrough/filter shader
        for (let k of ["render", "normal"]) {
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

        
        // Finally, draw with the passthrough shader. Note that this uses the same geometry array buffer that was used
        //      for the tracer shader, as nothing else has been bound to the relevant buffer since.
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
        
        
        // Rotate each list of textures, so the next textures read from will be the last textures rendered.
        this.textures.rotate();
        
        
        // Update the draw count, which is used for multisample blending.
        ++this.drawCount;
    }
}