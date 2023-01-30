class WebGLRendererAdapter {
    static DOUBLE_RECURSIVE = true;
    
    constructor(canvas, renderer) {
        const gl = canvas.getContext('webgl2');
        if (!gl)
            throw 'Unable to initialize WebGL. Your browser or machine may not support it.';
        gl.getExtension('EXT_color_buffer_float');
        gl.getExtension('EXT_float_blend');
        
        // store the canvas and renderer for future usage
        this.canvas = canvas;
        this.renderer = renderer;
        
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
        
        // Build the shader programs to make this render
        console.log("Building shader...");
        this.buildShaders(gl, canvas);
        
        // Store the addresses of uniforms that will be repeatedly modified
        this.uniforms = {
            time:                              gl.getUniformLocation(this.tracerShaderProgram,      "uTime"),
            doRandomSample:                    gl.getUniformLocation(this.tracerShaderProgram,      "uRendererRandomMultisample"),
            sampleWeight:                      gl.getUniformLocation(this.tracerShaderProgram,      "uSampleWeight"),
            tracerPreviousSamplesTexture:      gl.getUniformLocation(this.tracerShaderProgram,      "uPreviousSamplesTexture"),
            passthroughPreviousSamplesTexture: gl.getUniformLocation(this.passthroughShaderProgram, "uPreviousSamplesTexture")
        };
        
        // Write data to shaders
        console.log("Writing shader data...");
        this.writeShaderData(gl);
        
        // Store some useful initial variable values
        this.doRandomSample = true;
        this.drawCount = 0;
    }
    destroy() {
        if (this.tracerShaderProgram)
            this.gl.deleteProgram(this.tracerShaderProgram);
    }
    
    buildShaders(gl, canvas) {

        // Compile and link shader program for the tracer
        this.tracerShaderProgram = WebGLHelper.compileShaderProgramFromSources(gl,
            `#version 300 es
            precision highp float;
            in vec4 vertexPosition;
            void main() {
                gl_Position = vertexPosition;
            }`,
            
            `#version 300 es
            precision highp float;` + "\n"
            + this.getShaderSourceDeclarations()
            + this.getShaderSource());
        
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
        this.passthroughShaderProgram = WebGLHelper.compileShaderProgramFromSources(gl,
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
    
    getShaderSourceDeclarations() {
        return `
            #define PI 3.14159265359
            #define EPSILON 0.0001
            #define MAX_BOUNCE_DEPTH ${this.renderer.maxRecursionDepth}
            struct Ray { vec4 o; vec4 d; };` + "\n"
            + this.webgl_helper.getShaderSourceDeclarations() + "\n"
            + this.adapters.scene.getShaderSourceDeclarations() + "\n"
            + this.adapters.camera.getShaderSourceDeclarations() + "\n";
    }
    getShaderSource() {
        return `
            uniform sampler2D uPreviousSamplesTexture;
            uniform float uSampleWeight;
    
            uniform bool uRendererRandomMultisample;
            uniform float uTime;
            
            uniform vec2 uCanvasSize;
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
                
                vec4 sampleColor = vec4(sceneRayColor(r, random_seed), 1.0);
                if (uSampleWeight == 0.0)
                    outTexelColor = sampleColor;
                else {
                    vec4 previousSampleColor = texture(uPreviousSamplesTexture, gl_FragCoord.xy / uCanvasSize);

                    outTexelColor = mix(sampleColor, previousSampleColor, uSampleWeight);
                }
            }`
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
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
        
        // Ping-pong the textures, so the next texture read from is the last texture rendered.
        this.textures.reverse();
        
        // Update the draw count, which is used for multisample blending.
        ++this.drawCount;
    }
}