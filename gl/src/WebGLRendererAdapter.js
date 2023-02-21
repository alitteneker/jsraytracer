class WebGLRendererAdapter {
    static DOUBLE_RECURSIVE = false;
    
    constructor(gl, canvas, renderer) {
        
        // Store some useful initial variable values
        this.doRandomSample = true;
        this.drawCount = 0;
        
        // Sometimes it's useful to render into log color space, scaled to an appropriate level
        this.colorLogScale = 0.0;
        
        // store the canvas and renderer for future usage
        this.canvas = canvas;
        this.renderer = renderer;
        
        this.maxBounceDepth = renderer.maxRecursionDepth;
        
        // create and store utility variables for managing the WebGL context
        this.gl = gl;
        this.webgl_helper = new WebGLHelper(gl);
        
        // Create textures for intermediary rendering/blending
        this.renderTextureUnit = this.webgl_helper.allocateTextureUnit();
        this.textures = [0, 1].map(() => this.webgl_helper.createTexture(4, "FLOAT", canvas.width, canvas.height));
        gl.bindTexture(gl.TEXTURE_2D, null);
        
        // Create the adapters for the scene, which will also validate the data for the scene
        this.adapters = {
            camera: new WebGLCameraAdapter(renderer.camera, this.webgl_helper),
            scene:  new WebGLSceneAdapter(renderer.scene, this.webgl_helper)
        };
    }
    
    static build(gl, canvas, renderer, callback) {
        myconsole.log("Building adapters...");
        const ret = new WebGLRendererAdapter(gl, canvas, renderer);
        
        // Build the shader programs to make this render
        myconsole.log("Building shader...");
        ret.buildShaders(ret.gl, canvas, () => {
            
            // Write data to shaders
            myconsole.log("Writing shader data...");
            ret.writeShaderData(ret.gl);
            
            if (callback)
                callback(ret);
        });
    }
    
    visit(renderer) {
        this.renderer = renderer;
        this.adapters.camera.visit(renderer.camera, this.webgl_helper);
        this.adapters.scene .visit(renderer.scene,  this.webgl_helper);
    }
    reset() {
        this.adapters.scene.reset( this.gl, this.webgl_helper);
        this.adapters.camera.reset(this.gl, this.webgl_helper);
    }
    destroy() {
        if (this.tracerShaderProgram)
            this.gl.deleteProgram(this.tracerShaderProgram);
        
        for (let t of this.textures)
            this.gl.deleteTexture(t);
        if (this.framebuffer)
            this.gl.deleteFramebuffer(this.framebuffer);
        
        this.webgl_helper.destroy(   this.gl);
        this.adapters.scene.destroy( this.gl);
        this.adapters.camera.destroy(this.gl);
    }
    
    buildShaders(gl, canvas, callback) {
        
        // Create a framebuffer to finally render from
        this.framebuffer = gl.createFramebuffer();

        // Create the position buffer data for a polygon covering the image.
        this.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                 1.0,  1.0,
                -1.0,  1.0,
                 1.0, -1.0,
                -1.0, -1.0
            ]), gl.STATIC_DRAW);

        WebGLHelper.compileMultipleShaderProgramsFromSources(gl,
            // Compile and link shader program for the tracer
            [{
                vertex: `#version 300 es
                    precision highp float;
                    in vec4 vertexPosition;
                    void main() {
                        gl_Position = vertexPosition;
                    }`,
            
                fragment: "#version 300 es \n"
                    + this.getShaderSourceDeclarations()
                    + this.getShaderSource()
            },
            
            // Because we're rendering to a texture, we also need a simple pass-through shader
            {
                vertex: `#version 300 es
                    precision mediump float;
                    in vec4 vertexPosition;
                    out vec2 textureCoord;
                    void main() {
                        textureCoord = (vertexPosition.xy+1.0)/2.0;
                        gl_Position = vertexPosition;
                    }`,
                    
                fragment: `#version 300 es
                    precision mediump float;
                    
                    uniform sampler2D uPreviousSamplesTexture;
                    in vec2 textureCoord;
                    
                    uniform float uColorLogScale;
                    
                    out vec4 outTexelColor;
                    void main() {
                        vec3 sampleColor = texture(uPreviousSamplesTexture, textureCoord).rgb;
                        
                        if (any(isnan(sampleColor)))
                            sampleColor = vec3(1.0, 0.0, 0.5);
                        if (any(isinf(sampleColor)))
                            sampleColor = vec3(0.0, 1.0, 0.5);
                        if (any(lessThan(sampleColor, vec3(0.0))))
                            sampleColor = vec3(0.5, 0.0, 1.0);
                        
                        if (uColorLogScale > 0.0)
                            sampleColor = log(sampleColor + 1.0) / uColorLogScale;
                        
                        outTexelColor = vec4(sampleColor, 1.0);
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
                            randomSeed:                        gl.getUniformLocation(this.tracerShaderProgram,      "uRandomSeed"),
                            doRandomSample:                    gl.getUniformLocation(this.tracerShaderProgram,      "uRendererRandomMultisample"),
                            sampleWeight:                      gl.getUniformLocation(this.tracerShaderProgram,      "uSampleWeight"),
                            maxBounceDepth:                    gl.getUniformLocation(this.tracerShaderProgram,      "uMaxBounceDepth"),
                            tracerPreviousSamplesTexture:      gl.getUniformLocation(this.tracerShaderProgram,      "uPreviousSamplesTexture"),
                            passthroughPreviousSamplesTexture: gl.getUniformLocation(this.passthroughShaderProgram, "uPreviousSamplesTexture"),
                            colorLogScale:                     gl.getUniformLocation(this.passthroughShaderProgram, "uColorLogScale")
                        };
                        
                        if (callback)
                            callback();
            
            });
    }
    
    getShaderSourceDeclarations() {
        let ret = this.webgl_helper.getShaderSourceDeclarations() + "\n"
        +  `#define PI 3.14159265359
            #define EPSILON 0.0001
            
            struct Ray { vec4 o; vec4 d; };
            struct RecursiveNextRays {
                float reflectionProbability;
                vec4  reflectionDirection;
                vec3  reflectionColor;
                
                float refractionProbability;
                vec4  refractionDirection;
                vec3  refractionColor;
            };
            vec3 rendererRayColor(in Ray in_ray, inout vec2 random_seed);` + "\n";
        if (WebGLRendererAdapter.DOUBLE_RECURSIVE)
            ret += `
                #define MAX_BOUNCE_DEPTH ${this.renderer.maxRecursionDepth}
                #define MAX_BOUNCE_QUEUE_LENGTH (1 << (MAX_BOUNCE_DEPTH+1))` + "\n";
        else
            ret += `
                uniform int uMaxBounceDepth;` + "\n";
        return ret
            + this.adapters.scene.getShaderSourceDeclarations() + "\n"
            + this.adapters.camera.getShaderSourceDeclarations() + "\n";
    }
    getShaderSource() {
        let ret = `
            uniform sampler2D uPreviousSamplesTexture;
            uniform float uSampleWeight;
    
            uniform bool uRendererRandomMultisample;
            uniform float uRandomSeed;
            
            uniform vec2 uCanvasSize;
            out vec4 outTexelColor;

            void main() {
                vec2 canvasCoord = 2.0 * (gl_FragCoord.xy / uCanvasSize) - vec2(1.0);
                vec2 pixelSize = 2.0 / uCanvasSize;
                
                vec2 random_seed = gl_FragCoord.xy + vec2(uRandomSeed);
                
                if (uRendererRandomMultisample)
                    canvasCoord += pixelSize * (rand2f(random_seed) - vec2(0.5));
                
                Ray r = computeCameraRayForTexel(canvasCoord, pixelSize, random_seed);
                
                vec4 sampleColor = vec4(rendererRayColor(r, random_seed), 1.0);
                
                if (any(isnan(sampleColor)))
                    sampleColor = vec4(1.0, 0.0, 0.5, 1.0);
                if (any(isinf(sampleColor)))
                    sampleColor = vec4(0.0, 1.0, 0.5, 1.0);
                if (any(lessThan(sampleColor, vec4(0.0))))
                    sampleColor = vec4(0.5, 0.0, 1.0, 1.0);
                
                if (uSampleWeight == 0.0)
                    outTexelColor = sampleColor;
                else {
                    vec4 previousSampleColor = texture(uPreviousSamplesTexture, gl_FragCoord.xy / uCanvasSize);
                    outTexelColor = mix(sampleColor, previousSampleColor, uSampleWeight);
                }
            }`;
            
        if (WebGLRendererAdapter.DOUBLE_RECURSIVE)
            ret += `
                vec3 rendererRayColor(in Ray in_ray, inout vec2 random_seed) {
                    vec3 total_color = vec3(0.0);
                    
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
                        total_color += attenuation_color * sceneRayColorShallow(r, random_seed, intersect_position, nextRays);
                        
                        if (remaining_bounces > 0 && intersect_position.w != 0.0) {
                            if (dot(nextRays.reflectionDirection, nextRays.reflectionDirection) > EPSILON
                                && dot(nextRays.reflectionColor, nextRays.reflectionColor) > EPSILON)
                            {
                                q_rays[q_len] = Ray(intersect_position, nextRays.reflectionDirection);
                                q_attenuation_colors[q_len] = nextRays.reflectionProbability * attenuation_color * nextRays.reflectionColor;
                                q_remaining_bounces[q_len] = remaining_bounces - 1;
                                ++q_len;
                            }
                            
                            if (dot(nextRays.refractionDirection, nextRays.refractionDirection) > EPSILON
                                && dot(nextRays.refractionColor, nextRays.refractionColor) > EPSILON)
                            {
                                q_rays[q_len] = Ray(intersect_position, nextRays.refractionDirection);
                                q_attenuation_colors[q_len] = nextRays.refractionProbability * attenuation_color * nextRays.refractionColor;
                                q_remaining_bounces[q_len] = remaining_bounces - 1;
                                ++q_len;
                            }
                        }
                    }
                    
                    if (q_len == MAX_BOUNCE_QUEUE_LENGTH)
                        return vec3(1.0, 0.0, 0.5);
                    
                    return total_color;
                }`;
        else
            ret += `
                vec3 rendererRayColor(in Ray in_ray, inout vec2 random_seed) {
                    vec3 total_color = vec3(0.0);
                    
                    Ray r = in_ray;
                    vec3 attenuation_color = vec3(1);
                    for (int i = 0; i < uMaxBounceDepth; ++i) {
                        vec4 intersect_positon = vec4(0);
                        RecursiveNextRays nextRays = RecursiveNextRays(0.0, vec4(0), vec3(0), 0.0, vec4(0), vec3(0));
                        total_color += attenuation_color * sceneRayColorShallow(r, random_seed, intersect_positon, nextRays);
                        
                        if (intersect_positon.w == 0.0)
                            break;
                        
                        bool do_next_ray = false;
                        
                        float next_ray_probability_sum = nextRays.reflectionProbability + nextRays.refractionProbability;
                        if (next_ray_probability_sum > 0.0) {
                        
                            float next_ray_probability_sample = randf(random_seed) / min(next_ray_probability_sum, 1.0);
                            
                            next_ray_probability_sample -= nextRays.reflectionProbability;
                            if (next_ray_probability_sample <= 0.0
                                && normSquared(nextRays.reflectionDirection) > EPSILON)
                            {
                                r = Ray(intersect_positon, nextRays.reflectionDirection);
                                attenuation_color *= nextRays.reflectionColor;
                                do_next_ray = true;
                            }
                            
                            else {
                                next_ray_probability_sample -= nextRays.refractionProbability;
                                if (next_ray_probability_sample <= 0.0
                                    && normSquared(nextRays.refractionDirection) > EPSILON)
                                {
                                    r = Ray(intersect_positon, nextRays.refractionDirection);
                                    attenuation_color *= nextRays.refractionColor;
                                    do_next_ray = true;
                                }
                            }
                        }
                        
                        if (!do_next_ray) {
                            break;
                        }
                    }
                    
                    return total_color;
                }`;
        return ret
            + this.webgl_helper.getShaderSource()
            + this.adapters.scene.getShaderSource()
            + this.adapters.camera.getShaderSource();
    }
    
    writeShaderData(gl) {
        this.gl.useProgram(this.tracerShaderProgram);
        
        gl.uniform2fv(gl.getUniformLocation(this.tracerShaderProgram, "uCanvasSize"), Vec.from([this.canvas.width, this.canvas.height]));
        
        this.webgl_helper.writeShaderData(gl, this.tracerShaderProgram);
        this.adapters.scene.writeShaderData(gl, this.tracerShaderProgram, this.webgl_helper);
        this.adapters.camera.writeShaderData(gl, this.tracerShaderProgram, this.webgl_helper);
    }
    
    resetDrawCount() {
        this.drawCount = 0;
    }

    moveCamera(rotateDelta, translateDelta) {
        this.gl.useProgram(this.tracerShaderProgram);
        if (this.adapters.camera.moveCamera(rotateDelta, translateDelta, this.gl, this.tracerShaderProgram))
            this.resetDrawCount();
    }
    changeLensSettings(focusDistance, apertureSize, FOV) {
        this.gl.useProgram(this.tracerShaderProgram);
        if (this.adapters.camera.changeLensSettings(focusDistance, apertureSize, FOV, this.gl, this.tracerShaderProgram))
            this.resetDrawCount();
    }
    
    changeMaxBounceDepth(newBounceDepth) {
        if (newBounceDepth != this.maxBounceDepth) {
            this.maxBounceDepth = newBounceDepth;
            this.resetDrawCount();
        }
    }
    
    selectObjectAt(x, y) {
        const ray = this.adapters.camera.camera.getRayForPixel(x, y);
        return this.adapters.scene.intersectRay(ray);
    }

    drawScene(timestamp) {
        // Tell WebGL to use our program when drawing
        this.gl.useProgram(this.tracerShaderProgram);
        
        // Write the uniforms that vary between frames
        this.gl.uniform1f(this.uniforms.randomSeed, Math.random());
        this.gl.uniform1i(this.uniforms.doRandomSample, this.doRandomSample);
        this.gl.uniform1f(this.uniforms.sampleWeight, this.doRandomSample ? (this.drawCount / (this.drawCount + 1.0)) : 0.0);
        if (!WebGLRendererAdapter.DOUBLE_RECURSIVE)
            this.gl.uniform1i(this.uniforms.maxBounceDepth, this.maxBounceDepth);
        
        // Give the shader access to textures[0] to mix with new samples
        this.gl.activeTexture(this.renderTextureUnit);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures[0]);
        this.gl.uniform1i(this.uniforms.tracerPreviousSamplesTexture, this.webgl_helper.textureUnitIndex(this.renderTextureUnit));
        
        // Set the framebuffer to render to textures[1]
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.textures[1], 0);
        if (this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER) === this.gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT)
            throw "Bad framebuffer texture linking";
        
        // Do ray-tracing shader magic, by rendering a simple square.
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
        this.gl.vertexAttribPointer(this.tracerVertexAttrib, 2, this.gl.FLOAT, false, 0, 0);
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
        
        // Render textures[1] to the screen with the passthrough shader
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        this.gl.useProgram(this.passthroughShaderProgram);
        this.gl.activeTexture(this.renderTextureUnit);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures[1]);
        this.gl.uniform1i(this.uniforms.passthroughPreviousSamplesTexture, this.webgl_helper.textureUnitIndex(this.renderTextureUnit));
        this.gl.uniform1f(this.uniforms.colorLogScale, this.colorLogScale);
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
        
        // Ping-pong the textures, so the next texture read from is the last texture rendered.
        this.textures.reverse();
        
        // Update the draw count, which is used for multisample blending.
        ++this.drawCount;
    }
}