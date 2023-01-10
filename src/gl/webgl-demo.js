"use strict";

$(document).ready(main);

//
// Start here
//
function main() {
    const canvas = document.querySelector('#glcanvas');
    const gl = canvas.getContext('webgl2');

    // If we don't have a GL context, give up now

    if (!gl) {
        console.error('Unable to initialize WebGL. Your browser or machine may not support it.');
        return;
    }

    // Vertex shader program

    $.get('./vertex.glsl', null, function(ve) {
        const vsSource = ve;
        $.get('./fragment.glsl', null, function(fe) {
            const fsSource = fe;

            // Initialize a shader program.
            const shaderProgram = initShaderProgram(gl, vsSource, fsSource);

            // Collect all the info needed to use the shader program.
            const programInfo = {
                program: shaderProgram,
                uniformLocations: {
                    modelViewMatrix:  gl.getUniformLocation(shaderProgram, 'uCameraTransform'),
                    canvasSize:       gl.getUniformLocation(shaderProgram, 'uCanvasSize'),
                    aspect:           gl.getUniformLocation(shaderProgram, 'uAspect'),
                    FOV:              gl.getUniformLocation(shaderProgram, 'uFOV')
                },
            };

            // Here's where we call the routine that builds all the objects we'll be drawing.
            const buffers = initBuffers(gl, programInfo);

            // Draw the scene
            drawScene(gl, programInfo, buffers);
        });
    });
}

// Initialize a shader program, so WebGL knows how to draw our data
function initShaderProgram(gl, vsSource, fsSource) {
    const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vsSource);
    const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);

    // Create the shader program
    const shaderProgram = gl.createProgram();
    gl.attachShader(shaderProgram, vertexShader);
    gl.attachShader(shaderProgram, fragmentShader);
    gl.linkProgram(shaderProgram);

    // If creating the shader program failed, alert
    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
        console.error('Unable to initialize the shader program: ' + gl.getProgramInfoLog(shaderProgram));
        return null;
    }

    return shaderProgram;
}

// creates a shader of the given type, uploads the source and compiles it.
function loadShader(gl, type, source) {
    const shader = gl.createShader(type);

    // Send the source to the shader object
    gl.shaderSource(shader, source);

    // Compile the shader program
    gl.compileShader(shader);

    // See if it compiled successfully
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('An error occurred compiling the shader: ' + gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }

    return shader;
}

function initBuffers(gl, programInfo) {
    // Create the position buffer data, and bind the square to it.
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([ 1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, -1.0 ]), gl.STATIC_DRAW);

    // Tell WebGL how to pull out the positions from the position buffer into the vertexPosition attribute.
    const vertexPosition = gl.getAttribLocation(programInfo.program, 'vertexPosition');
    gl.vertexAttribPointer(vertexPosition, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(vertexPosition);

    return { position: positionBuffer };
}


function drawScene(gl, programInfo) {
    gl.clearColor(0.0, 0.0, 0.0, 1.0); // Any calls to clear will reset all pixels to black, fully opaque
    gl.clearDepth(1.0);                // Any calls to clear will reset the depth buffer as well
    gl.enable(gl.DEPTH_TEST);          // Enable depth testing
    gl.depthFunc(gl.LEQUAL);           // Near things obscure far things
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);  // Using these settings, clear the canvas before we start drawing on it.

    // Tell WebGL to use our program when drawing
    gl.useProgram(programInfo.program);

    // Set the shader uniforms
    // ====================================================
    //gl.uniformMatrix4fv(programInfo.uniformLocations.modelViewMatrix, false, modelViewMatrix.to_webgl());
    
    const canvas = document.querySelector('#glcanvas');
    gl.uniform2fv(programInfo.uniformLocations.canvasSize, Vec.from([canvas.width, canvas.height]));
    
    // ---- Camera parameters ----
    // uniform mat4 uCameraTransform;
    // uniform float uAspect, uFOV;
    
    // ---- Scene-wide parameters ----
    // uniform vec4 uBackgroundColor;
    // uniform int uAllowedBounceDepth;
    // uniform int uNumObjects;
    
    // ---- Object Transforms ----
    // uniform mat4 uObjectTransforms[16];
    // uniform mat4 uObjectInverseTransforms[16];

    // ---- Object Mappings ----
    // uniform int usObjectGeometryIDs[MAX_OBJECTS]; // 1=Plane, 2=Sphere, 3+=Triangle instance
    // uniform int usObjectMaterialIDs[MAX_OBJECTS]; // 1+=SimpleMaterial instance
    // uniform int usObjectTransformIDs[MAX_OBJECTS];

    // ---- SimpleMaterial (Phong) ----
    // uniform vec4 umSimpleMaterialAmbients[MAX_SIMPLE_MATERIALS];
    // uniform vec4 umSimpleMaterialDiffuses[MAX_SIMPLE_MATERIALS];
    // uniform vec4 umSimpleMaterialSpeculars[MAX_SIMPLE_MATERIALS];
    // uniform float umSimpleMaterialSpecularFactors[MAX_SIMPLE_MATERIALS];
    
    // ---- Geometry: Triangles ----
    // uniform vec4 ugTriangleVertices[MAX_TRIANGLES * 3];
    // uniform vec4 ugTriangleNormals[MAX_TRIANGLES * 3];
    // uniform vec2 ugTriangleUVs[MAX_TRIANGLES * 3];


    // ====================================================
    
    // Draw the magic square that begins ray-tracing shader magic.
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
