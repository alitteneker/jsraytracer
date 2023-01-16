"use strict";

$(document).ready(function() {
    const scene_select = document.querySelector("#test-select");
    fetch("../tests/list.json").then(response => response.json()).then(function(json) {
        for (let o of json.sort()) {
            const option = document.createElement('option');
            option.value = "tests/" + (option.innerHTML = o);
            scene_select.appendChild(option);
        }
    });
    
    const canvas = document.querySelector('#glcanvas');
    const gl = canvas.getContext('webgl2');
    if (!gl)
        console.error('Unable to initialize WebGL. Your browser or machine may not support it.');
    
    let adapter = false;
    scene_select.addEventListener("change", function onChange(e) {
        if (adapter) {
            adapter.destroy();
            adapter = false;
        }
        
        if (scene_select.value === "")
            return;
        const scene_path = scene_select.value;
        
        import("../" + scene_path + "/test.js").then(function(module) {
            module.configureTest(function(test) {
                adapter = new WebGLAdapter(gl, test.renderer);
                adapter.drawScene();
            });
        });
    });
});

class WebGLAdapter {
    constructor(gl, renderer) {
        this.gl = gl;
        this.renderer = renderer;
        this.adapters = {
            camera: new WebGLCameraAdapter(renderer.camera),
            scene:  new WebGLSceneAdapter(renderer.scene)
        };
        this.buildShader(gl);
        this.writeShaderData(gl);
    }
    destroy() {
        if (this.shaderProgram)
            this.gl.deleteProgram(this.shaderProgram);
    }
    
    buildShader(gl) {
        // Build shader program sources
        const vsSource = "#version 300 es\nin vec4 vertexPosition;\n\nvoid main() { gl_Position = vertexPosition; }";
        const fsSource = "#version 300 es\nprecision mediump float;\n\n#define PI 3.14159265359\n" + this.getShaderSource();

        // Create vertex and fragment shaders with the created source.
        const vertexShader = WebGLAdapter.loadShader(gl, gl.VERTEX_SHADER, vsSource);
        const fragmentShader = WebGLAdapter.loadShader(gl, gl.FRAGMENT_SHADER, fsSource);

        // Create the shader program
        this.shaderProgram = gl.createProgram();
        gl.attachShader(this.shaderProgram, vertexShader);
        gl.attachShader(this.shaderProgram, fragmentShader);
        gl.linkProgram(this.shaderProgram);

        // If creating the shader program failed, alert
        if (!gl.getProgramParameter(this.shaderProgram, gl.LINK_STATUS))
            throw 'Unable to initialize the shader program: ' + gl.getProgramInfoLog(this.shaderProgram);

        // Create the position buffer data for a polygon covering the image.
        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([ 1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, -1.0 ]), gl.STATIC_DRAW);

        // Tell WebGL how to pull out the positions from the position buffer into the vertexPosition attribute.
        const vertexPosition = gl.getAttribLocation(this.shaderProgram, 'vertexPosition');
        gl.vertexAttribPointer(vertexPosition, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(vertexPosition);
    }
    
    getShaderSource() {
        return `void computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec4 ro, inout vec4 rd);
                vec3 sceneRayColor(in vec4 ro, in vec4 rd, in int maxBounceDepth);
                float sceneRayCast(in vec4 ro, in vec4 rd, in float minDistance, in bool shadowFlag, inout int objectID);
                float sceneRayCast(in vec4 ro, in vec4 rd, in float minDistance, in bool shadowFlag);
                vec3 colorForMaterial(in int materialID, in vec4 rp, in vec4 ro, in vec4 rd, in vec4 normal, in vec2 UV, inout vec4 reflection_direction, inout vec3 reflection_color);
                float geometryIntersect(in int geometryID, in vec4 ro, in vec4 rd, in float minDistance);
                void getGeometricMaterialProperties(in int geometryID, in vec4 position, in vec4 ro, in vec4 rd, inout vec4 normal, inout vec2 UV);
                void sampleLight(in int lightID, in vec4 position, out vec4 lightDirection, out vec3 lightColor);
                
                uniform vec2 uCanvasSize;
                uniform float uTime;
                uniform int uAllowedBounceDepth;
                
                out vec4 outTexelColor;

                void main() {
                    // TODO: seed noise

                    vec2 canvasCoord = 2.0 * (gl_FragCoord.xy / uCanvasSize) - vec2(1.0);
                    vec2 pixelSize = 2.0 / uCanvasSize;
                    
                    vec4 ro, rd;
                    computeCameraRayForTexel(canvasCoord, pixelSize, ro, rd);
                    outTexelColor = vec4(sceneRayColor(ro, rd, uAllowedBounceDepth), 1.0);
                }`
                + this.adapters.scene.getShaderSource()
                + this.adapters.camera.getShaderSource();
    }
    
    writeShaderData(gl) {
        this.gl.useProgram(this.shaderProgram);
        
        const canvas = document.querySelector('#glcanvas');
        gl.uniform2fv(gl.getUniformLocation(this.shaderProgram, "uCanvasSize"), Vec.from([canvas.width, canvas.height]));
        gl.uniform1i(gl.getUniformLocation(this.shaderProgram, "uAllowedBounceDepth"), this.renderer.maxRecursionDepth);
        // gl.uniform1f(gl.getUniformLocation(this.shaderProgram, "uTime"), /* Some way of measuring time uniquely? */);
        
        this.adapters.camera.writeShaderData(gl, this.shaderProgram);
        this.adapters.scene.writeShaderData(gl, this.shaderProgram);
    }

    drawScene() {
        // Tell WebGL to use our program when drawing
        this.gl.useProgram(this.shaderProgram);
        
        // Draw the magic square that begins ray-tracing shader magic.
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
    }
    
    // utility function to create a shader of the given type, with given textual source code, and compile it.
    static loadShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw 'An error occurred compiling the shader: ' + gl.getShaderInfoLog(shader);

        return shader;
    }
}

