class WebGLRendererAdapter {
    constructor(canvas, renderer) {
        const gl = canvas.getContext('webgl2');
        if (!gl)
            throw 'Unable to initialize WebGL. Your browser or machine may not support it.';
        gl.getExtension('EXT_color_buffer_float');
        gl.getExtension('EXT_float_blend');
        
        this.gl = gl;
        this.canvas = canvas;
        this.renderer = renderer;
        this.adapters = {
            camera: new WebGLCameraAdapter(renderer.camera),
            scene:  new WebGLSceneAdapter(renderer.scene),
            random: new WebGLRandomHelper()
        };
        
        console.log("Building shader...");
        this.buildShaders(gl, canvas);
        
        console.log("Writing shader data...");
        this.writeShaderData(gl);
        
        this.uniforms = {
            time: gl.getUniformLocation(this.tracerShaderProgram, "uTime"),
            doRandomSample: gl.getUniformLocation(this.tracerShaderProgram, "uRendererRandomMultisample"),
            sampleWeight: gl.getUniformLocation(this.tracerShaderProgram, "uSampleWeight"),
            tracerPreviousSamplesTexture: gl.getUniformLocation(this.tracerShaderProgram, "uPreviousSamplesTexture"),
            passthroughPreviousSamplesTexture: gl.getUniformLocation(this.passthroughShaderProgram, "uPreviousSamplesTexture")
        };
        this.doRandomSample = true;
        
        this.drawCount = 0;
    }
    destroy() {
        if (this.tracerShaderProgram)
            this.gl.deleteProgram(this.tracerShaderProgram);
    }
    
    buildShaders(gl, canvas) {

        // Compile and link shader program for the tracer
        this.tracerShaderProgram = WebGLRendererAdapter.compileShaderProgramFromSources(gl,
            `#version 300 es
            precision mediump float;
            in vec4 vertexPosition;
            void main() {
                gl_Position = vertexPosition;
            }`,
            
            `#version 300 es
            precision mediump float;` + "\n"
            + this.getShaderSourceDeclarations()
            + this.getShaderSource());
         
        // Create textures for intermediary rendering/blending
        this.textures = [0, 1].map(() => {
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.canvas.width, this.canvas.height, 0, gl.RGBA, gl.FLOAT, null);
            return tex;
        });
        gl.bindTexture(gl.TEXTURE_2D, null);
        
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
        
        // Because we're rendering to a texture, we also need a simple pass-through shader
        this.passthroughShaderProgram = WebGLRendererAdapter.compileShaderProgramFromSources(gl,
            `#version 300 es
            precision mediump float;
            in vec4 vertexPosition;
            out vec2 textureCoord;
            void main() {
                textureCoord = (vertexPosition.xy+1.0)/2.0;
                gl_Position = vertexPosition;
            }`,
            
            `#version 300 es
            precision mediump float;
            
            uniform sampler2D uPreviousSamplesTexture;
            in vec2 textureCoord;
            
            out vec4 outTexelColor;
            void main() {
                outTexelColor = vec4(texture(uPreviousSamplesTexture, textureCoord).rgb, 1.0);
            }`);

        // Tell WebGL how to pull out the positions from the position buffer into the vertexPosition attribute.
        for (let shaderName of ['tracer', 'passthrough']) {
            const attrib = this[shaderName + 'VertexAttrib'] = gl.getAttribLocation(this[shaderName + 'ShaderProgram'], 'vertexPosition');
            gl.vertexAttribPointer(attrib, 2, gl.FLOAT, false, 0, 0);
            gl.enableVertexAttribArray(attrib);
        }
    }
    
    // Create/compile vertex and fragment shaders with the specified sources
    static compileShaderProgramFromSources(gl, vsSource, fsSource) {
        const vertexShader   = WebGLRendererAdapter.compileShaderOfTypeFromSource(gl, gl.VERTEX_SHADER,   vsSource);
        const fragmentShader = WebGLRendererAdapter.compileShaderOfTypeFromSource(gl, gl.FRAGMENT_SHADER, fsSource);

        // Create the shader program
        const shaderProgram = gl.createProgram();
        gl.attachShader(shaderProgram, vertexShader);
        gl.attachShader(shaderProgram, fragmentShader);
        gl.linkProgram( shaderProgram);

        // If creating the shader program failed, throw an error
        if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS))
            throw 'Unable to initialize the shader program: ' + gl.getProgramInfoLog(this.tracerShaderProgram);
        
        return shaderProgram;
    }
    
    // Utility function to compile a shader of the given type from given source code
    static compileShaderOfTypeFromSource(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw 'An error occurred compiling the shader: ' + gl.getShaderInfoLog(shader);

        return shader;
    }
    
    getShaderSourceDeclarations() {
        return `
            #define PI 3.14159265359
            struct Ray { vec4 o; vec4 d; };` + "\n"
            + this.adapters.scene.getShaderSourceDeclarations() + "\n"
            + this.adapters.camera.getShaderSourceDeclarations() + "\n"
            + this.adapters.random.getShaderSourceDeclarations();
    }
    getShaderSource() {
        return `
            uniform sampler2D uPreviousSamplesTexture;
            uniform float uSampleWeight;
    
            uniform bool uRendererRandomMultisample;
            uniform float uTime;
            
            uniform vec2 uCanvasSize;
            uniform int uAllowedBounceDepth;
            
            out vec4 outTexelColor;

            void main() {
                vec4 previousSampleColor = texture(uPreviousSamplesTexture, gl_FragCoord.xy / uCanvasSize);
                
                vec2 random_seed = gl_FragCoord.xy + vec2(uTime);

                vec2 canvasCoord = 2.0 * (gl_FragCoord.xy / uCanvasSize) - vec2(1.0);
                vec2 pixelSize = 2.0 / uCanvasSize;
                
                if (uRendererRandomMultisample)
                    canvasCoord += pixelSize * (rand2f(random_seed) - vec2(0.5));
                
                Ray r;
                computeCameraRayForTexel(canvasCoord, pixelSize, r, random_seed);
                
                vec4 sampleColor = vec4(sceneRayColor(r, uAllowedBounceDepth, random_seed), 1.0);
                if (uSampleWeight == 0.0)
                    outTexelColor = sampleColor;
                else {
                    vec4 previousSampleColor = texture(uPreviousSamplesTexture, gl_FragCoord.xy / uCanvasSize);

                    outTexelColor = mix(sampleColor, previousSampleColor, uSampleWeight);
                }
            }`
            + this.adapters.scene.getShaderSource()
            + this.adapters.camera.getShaderSource()
            + this.adapters.random.getShaderSource();
    }
    
    writeShaderData(gl) {
        this.gl.useProgram(this.tracerShaderProgram);
        
        gl.uniform2fv(gl.getUniformLocation(this.tracerShaderProgram, "uCanvasSize"), Vec.from([this.canvas.width, this.canvas.height]));
        gl.uniform1i(gl.getUniformLocation(this.tracerShaderProgram, "uAllowedBounceDepth"), this.renderer.maxRecursionDepth);
        
        this.adapters.scene.writeShaderData(gl, this.tracerShaderProgram);
        this.adapters.camera.writeShaderData(gl, this.tracerShaderProgram);
        this.adapters.random.writeShaderData(gl, this.tracerShaderProgram);
    }

    moveCamera(rotateDelta, translateDelta) {
        this.gl.useProgram(this.tracerShaderProgram);
        if (this.adapters.camera.moveCamera(rotateDelta, translateDelta, this.gl, this.tracerShaderProgram))
            this.drawCount = 0;
    }
    
    changeLensSettings(focusDistance, apertureSize) {
        this.gl.useProgram(this.tracerShaderProgram);
        if (this.adapters.camera.changeLensSettings(focusDistance, apertureSize, this.gl, this.tracerShaderProgram))
            this.drawCount = 0;
    }

    drawScene(timestamp) {
        // Tell WebGL to use our program when drawing
        this.gl.useProgram(this.tracerShaderProgram);
        
        // Write the uniforms that vary between frames
        this.gl.uniform1f(this.uniforms.time, timestamp);
        this.gl.uniform1i(this.uniforms.doRandomSample, this.doRandomSample);
        this.gl.uniform1f(this.uniforms.sampleWeight, this.doRandomSample ? (this.drawCount / (this.drawCount + 1.0)) : 0.0);
        
        // Give the shader access to textures[0] to mix with new samples
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures[0]);
        this.gl.uniform1i(this.uniforms.tracerPreviousSamplesTexture, 0);
        
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
        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures[1]);
        this.gl.uniform1i(this.uniforms.passthroughPreviousSamplesTexture, 0);
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
        
        // Ping-pong the textures, so the next texture read from is the last texture rendered.
        this.textures.reverse();
        
        // Update the draw count, which is used for multisample blending.
        ++this.drawCount;
    }
}