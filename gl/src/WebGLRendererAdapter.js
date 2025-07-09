class WebGLRendererAdapter {
    static DOUBLE_RECURSIVE = false;
    
    constructor(gl, canvas, renderer) {
        
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearDepth(1.0);
        
        // Store some useful initial variable values
        this.doRandomSample = true;
        this.drawCount = 0;
        
        // Sometimes it's useful to render into log color space, scaled to an appropriate level
        this.colorLogScale = 0.0;
        this.maxDepth = 1000.0;
        
        // store the canvas and renderer for future usage
        this.canvas = canvas;
        this.renderer = renderer;
        
        this.maxBounceDepth = renderer.maxRecursionDepth;
        
        // create and store utility variables for managing the WebGL context
        this.gl = gl;
        this.webgl_helper = new WebGLHelper(gl);
        
        // Create textures for intermediary rendering/blending
        this.renderTextureUnit = this.webgl_helper.allocateTextureUnit();
        this.errorTextureUnit = this.webgl_helper.allocateTextureUnit();
        this.textures = [0, 1, 2, 3].map(() => this.webgl_helper.createTexture(4, "FLOAT", canvas.width, canvas.height));
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
            t.setPixels(null, 4, "FLOAT", new_width, new_height);
        this.gl.viewport(0, 0, new_width, new_height);
        
        this.gl.useProgram(this.tracerShaderProgram);
        this.gl.uniform2fv(this.gl.getUniformLocation(this.tracerShaderProgram, "uCanvasSize"), Vec.of(new_width, new_height));
        this.resetDrawCount();
    }

    destroy() {
        if (this.tracerShaderProgram)
            this.gl.deleteProgram(this.tracerShaderProgram);
        
        for (let t of this.textures)
            t.destroy();
        if (this.samplebuffer)
            this.gl.deleteFramebuffer(this.samplebuffer);
        if (this.errorbuffer)
            this.gl.deleteFramebuffer(this.errorbuffer);
        
        this.webgl_helper.destroy(   this.gl);
        this.adapters.world.destroy( this.gl);
        this.adapters.camera.destroy(this.gl);
    }
    
    buildShaders(gl, canvas, callback) {
        
        // Create a framebuffer to finally render from
        this.samplebuffer = gl.createFramebuffer();
        this.errorbuffer  = gl.createFramebuffer();

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
                    
                    uniform sampler2D uSampleSumTexture;
					uniform int uSampleCount;
                    in vec2 textureCoord;
                    
                    uniform float uMaxDepth;
                    uniform float uColorLogScale;
                    
                    out vec4 outTexelColor;
                    void main() {
                        vec4 sampleColor = texture(uSampleSumTexture, textureCoord) / float(max(uSampleCount + 1, 1));
                        
                        if (any(isnan(sampleColor)))
                            sampleColor = vec4(1.0, 0.0, 0.5, sampleColor.a);
                        if (any(isinf(sampleColor)))
                            sampleColor = vec4(0.0, 1.0, 0.5, sampleColor.a);
                        if (any(lessThan(sampleColor.rgb, vec3(0.0))))
                            sampleColor = vec4(0.5, 0.0, 1.0, sampleColor.a);
                        
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
                            randomSeed:                  gl.getUniformLocation(this.tracerShaderProgram,      "uRandomSeed"),
                            doRandomSample:              gl.getUniformLocation(this.tracerShaderProgram,      "uRendererRandomMultisample"),
                            maxBounceDepth:              gl.getUniformLocation(this.tracerShaderProgram,      "uMaxBounceDepth"),
                            tracerSampleCount:           gl.getUniformLocation(this.tracerShaderProgram,      "uSampleCount"),
                            tracerSampleSumTexture:      gl.getUniformLocation(this.tracerShaderProgram,      "uSampleSumTexture"),
							tracerSampleErrorTexture:    gl.getUniformLocation(this.tracerShaderProgram,      "uSampleErrorTexture"),
                            passthroughSampleSumTexture: gl.getUniformLocation(this.passthroughShaderProgram, "uSampleSumTexture"),
							passthroughSampleCount:      gl.getUniformLocation(this.passthroughShaderProgram, "uSampleCount"),
                            colorLogScale:               gl.getUniformLocation(this.passthroughShaderProgram, "uColorLogScale"),
                            maxDepth:                    gl.getUniformLocation(this.passthroughShaderProgram, "uMaxDepth")
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
            vec4 rendererRayColor(in Ray in_ray, inout vec2 random_seed);` + "\n";
        if (WebGLRendererAdapter.DOUBLE_RECURSIVE)
            ret += `
                #define MAX_BOUNCE_DEPTH ${this.renderer.maxRecursionDepth}
                #define MAX_BOUNCE_QUEUE_LENGTH (1 << (MAX_BOUNCE_DEPTH+1))` + "\n";
        else
            ret += `
                uniform int uMaxBounceDepth;` + "\n";
        return ret
            + this.adapters.world.getShaderSourceDeclarations()  + "\n"
            + this.adapters.camera.getShaderSourceDeclarations() + "\n";
    }
    getShaderSource() {
        let ret = `
            uniform sampler2D uSampleSumTexture;
            uniform sampler2D uSampleErrorTexture;
    
            uniform bool uRendererRandomMultisample;
            uniform int uSampleCount;
            uniform float uRandomSeed;
            
            uniform vec2 uCanvasSize;
            
            layout(location=0) out vec4 outSampleSum;
            layout(location=1) out vec4 outSampleError;

            void main() {
                vec2 canvasCoord = 2.0 * (gl_FragCoord.xy / uCanvasSize) - vec2(1.0);
                vec2 pixelSize = 2.0 / uCanvasSize;
                
                vec2 random_seed = gl_FragCoord.xy + vec2(uRandomSeed);
                
                if (uRendererRandomMultisample)
                    // canvasCoord += pixelSize * (rand2f(random_seed) - vec2(0.5)); // box filter
                    canvasCoord += 0.5 * pixelSize * randomGaussian(random_seed); // gaussian filter
                
                Ray r = computeCameraRayForTexel(canvasCoord, pixelSize, random_seed);
                
                vec4 sampleColor = rendererRayColor(r, random_seed);

                if (uSampleCount == 0) {
                    outSampleSum = sampleColor;
                    outSampleError = vec4(0.0);
                }
                else {
                    vec4 sumSampleColor = texture(uSampleSumTexture, gl_FragCoord.xy / uCanvasSize);
                    vec4 sumSampleError = texture(uSampleErrorTexture, gl_FragCoord.xy / uCanvasSize);

                    // The commented out line below would be simple summation, which can lead to precision issues with many samples
                    // outSampleSum = sumSampleColor + sampleColor;
                    
                    // Instead, let's use Kahan summation, which will adjust for the accumulated precision error in the sampleError buffer
                    vec4 y = sampleColor - sumSampleError;
                    vec4 t = sumSampleColor + y;
        
                    outSampleSum = t;
                    outSampleError = (t - sumSampleColor) - y;
                }
            }`;
            
        if (WebGLRendererAdapter.DOUBLE_RECURSIVE)
            ret += `
            vec4 rendererRayColor(in Ray in_ray, inout vec2 random_seed) {
                vec3 total_color = vec3(0.0);
                float ray_depth = 1E20;
                
                int q_len = 0;
                Ray q_rays[MAX_BOUNCE_QUEUE_LENGTH];
                vec3 q_attenuation_colors[MAX_BOUNCE_QUEUE_LENGTH];
                int q_remaining_bounces[MAX_BOUNCE_QUEUE_LENGTH];
                
                if (MAX_BOUNCE_DEPTH > 0) {
                    q_rays[0] = in_ray;
                    q_attenuation_colors[0] = vec3(1.0);
                    q_remaining_bounces[0] = MAX_BOUNCE_DEPTH-1;
                    q_len = 1;
                }
                
                for (int i = 0; i < q_len; ++i) {
                    Ray r = q_rays[i];
                    vec3 attenuation_color = q_attenuation_colors[i];
                    int remaining_bounces = q_remaining_bounces[i];
                    
                    vec4 intersect_position = vec4(0);
                    RecursiveNextRays nextRays = RecursiveNextRays(0.0, vec4(0), vec3(0), 0.0, vec4(0), vec3(0));
                    total_color += attenuation_color * worldRayColorShallow(r, random_seed, intersect_position, nextRays);
                    
                    if (remaining_bounces > 0 && intersect_position.w != 0.0) {
                        if (i == 0)
                            ray_depth = length(r.o - intersect_position);
                        
                        if (dot(nextRays.reflectionDirection, nextRays.reflectionDirection) > EPSILON
                            && dot(nextRays.reflectionColor, nextRays.reflectionColor) > EPSILON)
                        {
                            q_rays[q_len] = Ray(intersect_position, nextRays.reflectionDirection);
                            q_attenuation_colors[q_len] = nextRays.reflectionProbability * attenuation_color * nextRays.reflectionColor;
                            q_remaining_bounces[q_len] = remaining_bounces - 1;
                            ++q_len;
                        }
                        
                        if (dot(nextRays.transmissionDirection, nextRays.transmissionDirection) > EPSILON
                            && dot(nextRays.transmissionColor, nextRays.transmissionColor) > EPSILON)
                        {
                            q_rays[q_len] = Ray(intersect_position, nextRays.transmissionDirection);
                            q_attenuation_colors[q_len] = nextRays.transmissionProbability * attenuation_color * nextRays.transmissionColor;
                            q_remaining_bounces[q_len] = remaining_bounces - 1;
                            ++q_len;
                        }
                    }
                }
                
                if (q_len == MAX_BOUNCE_QUEUE_LENGTH)
                    return vec4(1.0, 0.0, 0.5, ray_depth);
                
                return vec4(total_color, ray_depth);
            }`;
        else
            ret += `
            vec4 rendererRayColor(in Ray in_ray, inout vec2 random_seed) {
                vec3 total_color = vec3(0.0);
                float ray_depth = 1E20;
                
                Ray r = in_ray;
                vec3 attenuation_color = vec3(1);
                for (int i = 0; i < uMaxBounceDepth; ++i) {
                    vec4 intersect_position = vec4(0);
                    RecursiveNextRays nextRays = RecursiveNextRays(0.0, vec4(0), vec3(0), 0.0, vec4(0), vec3(0));
                    total_color += attenuation_color * worldRayColorShallow(r, random_seed, intersect_position, nextRays);
                    
                    if (intersect_position.w == 0.0)
                        break;
                    
                    if (i == 0)
                        ray_depth = length(r.o - intersect_position);
                    
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
                
                return vec4(total_color, ray_depth);
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
        if (!WebGLRendererAdapter.DOUBLE_RECURSIVE && newBounceDepth != this.maxBounceDepth) {
            this.maxBounceDepth = newBounceDepth;
            this.resetDrawCount();
        }
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
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        
        // Tell WebGL to use our program when drawing
        this.gl.useProgram(this.tracerShaderProgram);
        
        // Write the uniforms that vary between frames
        this.gl.uniform1f(this.uniforms.randomSeed, Math.random());
        this.gl.uniform1i(this.uniforms.doRandomSample, this.doRandomSample);
        this.gl.uniform1i(this.uniforms.tracerSampleCount, this.doRandomSample ? this.drawCount : 0);
        if (!WebGLRendererAdapter.DOUBLE_RECURSIVE)
            this.gl.uniform1i(this.uniforms.maxBounceDepth, this.maxBounceDepth);
        
        // Give the shader access to textures[0] to sum with new samples
        this.textures[0].bind(this.renderTextureUnit);
        this.gl.uniform1i(this.uniforms.tracerSampleSumTexture, WebGLHelper.textureUnitIndex(this.renderTextureUnit));
        
        // Give the shader access to textures[1] to sum with new samples
        this.textures[1].bind(this.errorTextureUnit);
        this.gl.uniform1i(this.uniforms.tracerSampleErrorTexture, WebGLHelper.textureUnitIndex(this.errorTextureUnit));
        
        // Set the errorbuffer to render to textures[2]
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.errorbuffer);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT1, this.gl.TEXTURE_2D, this.textures[2].id(), 0);
        if (this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER) === this.gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT)
            throw "Bad framebuffer texture linking";
        
        // Set the framebuffer to render to textures[3]
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.samplebuffer);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.textures[3].id(), 0);
        if (this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER) === this.gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT)
            throw "Bad framebuffer texture linking";
        
        // Do ray-tracing shader magic, by rendering a simple square.
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
        this.gl.vertexAttribPointer(this.tracerVertexAttrib, 2, this.gl.FLOAT, false, 0, 0);
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
        
        
        // Render textures[3] to the screen with the passthrough shader
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.useProgram(this.passthroughShaderProgram);
        this.textures[3].bind(this.renderTextureUnit);
        this.gl.uniform1i(this.uniforms.passthroughSampleSumTexture, WebGLHelper.textureUnitIndex(this.renderTextureUnit));
        
        // Set passthrough uniforms
        this.gl.uniform1f(this.uniforms.colorLogScale, this.colorLogScale);
        this.gl.uniform1f(this.uniforms.maxDepth, this.maxDepth);
        this.gl.uniform1i(this.uniforms.passthroughSampleCount, this.doRandomSample ? this.drawCount : 0);
        
        // draw with the passthrough shader
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
        
        
        // Ping-pong the textures, so the next texture reads will be the last textures rendered.
        this.textures.reverse();
        
        
        // Update the draw count, which is used for multisample blending.
        ++this.drawCount;
    }
}