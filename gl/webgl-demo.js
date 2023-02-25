"use strict";

$(document).ready(function() {
    const console_output = $('#console_output');
    
    window["myconsole"] = {
        log: function(...args) {
            console.log(...args);
            console_output.append('<p class="log">' + args.join("\t") + "</p>");
        },
        error: function(...args) {
            console.error(...args);
            console_output.append('<p class="error">' + args.join("\t") + "</p>");
        }
    };
    
    if (window["myerrors"].length) {
        for (let error_dict of window["myerrors"])
            window["myconsole"].error(error_dict.error, "@" + error_dict.url + ":" + error_dict.lineNo);
        return;
    }
    
    
    
    // Populate the list of worlds with the default test list
    fetch("../tests/list.json").then(response => response.json()).then(function(json) {
        for (let o of json.sort())
            $("#test-select").append(`<option value="tests/${o}">${o}</option>`);
    });
   
    const i = new WebGLInterface();
});

class WebGLInterface {
    constructor() {
        const canvas = this.canvas = $('#glcanvas');
        
        const gl = this.gl = canvas.get(0).getContext('webgl2');
        if (!gl)
            throw 'Unable to initialize WebGL. Your browser or machine may not support it.';
        
        this.buildLineShader(gl);
        
        $("#test-select").on("change", this.testChange.bind(this));
        
        this.registerPointerEvents(canvas);
        this.registerKeyEvents();
        
        
        // setup standard listeners for changing lens settings
        $("#fov-range,#focus-distance,#sensor-size").on('input', this.changeLensSettings.bind(this));
        
        $("#renderer-depth").on('spin', (e, ui) => {
            if (this.renderer_adapter)
                this.renderer_adapter.changeMaxBounceDepth(Number.parseInt(ui.value));
        });
        
        
        // Setup the UI to pretty things up...
        $("#control-panel").accordion({ animate: false, collapsible:true, active: -1 });
        $(".control-group").controlgroup();
        $("#help-button").button({
            icon: "ui-icon-help",
            showLabel: false
        });
    }
    
    lineShader = null;
    buildLineShader(gl) {
        WebGLHelper.compileShaderProgramFromSources(gl,
            `#version 300 es
            precision mediump float;
            
            in vec3 cubeCorner;
            
            uniform vec3 uCubeMin;
            uniform vec3 uCubeMax;
            uniform mat4 uModelviewProjection;
            
            out vec3 vertexPosition;
            void main() {
                vertexPosition = mix(uCubeMin, uCubeMax, cubeCorner);
                gl_Position = uModelviewProjection * vec4(vertexPosition, 1.0);
            }`,
            
            `#version 300 es
            precision mediump float;
            #define EPSILON 0.0001
            
            in vec3 vertexPosition;
            uniform vec3 uCameraPosition;
            uniform vec4 uLineColor;
            out vec4 outTexelColor;
            void main() {
                gl_FragDepth = min(length(uCameraPosition - vertexPosition) / 1000.0, 1.0-EPSILON);
                outTexelColor = uLineColor;
            }`,
            (shaderProgram) => {
                this.lineShader = {};
                this.lineShader.program = shaderProgram;
                this.lineShader.uniforms = {
                    lineColor:           gl.getUniformLocation(shaderProgram, "uLineColor"),
                    cubeMin:             gl.getUniformLocation(shaderProgram, "uCubeMin"),
                    cubeMax:             gl.getUniformLocation(shaderProgram, "uCubeMax"),
                    cameraPosition:      gl.getUniformLocation(shaderProgram, "uCameraPosition"),
                    modelviewProjection: gl.getUniformLocation(shaderProgram, "uModelviewProjection")
                };

                this.lineShader.vertexBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.lineShader.vertexBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                    0, 0, 0,
                    0, 0, 1,
                    0, 1, 1,
                    0, 1, 0,
                    1, 0, 0,
                    1, 0, 1,
                    1, 1, 1,
                    1, 1, 0
                ]), gl.STATIC_DRAW);
                
                this.lineShader.indexBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineShader.indexBuffer);
                gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([
                    0, 1, 1, 2, 2, 3, 3, 0,
                    4, 5, 5, 6, 6, 7, 7, 4,
                    0, 4, 1, 5, 2, 6, 3, 7
                ]), gl.STATIC_DRAW);
                
                this.lineShader.vertexAttribute = gl.getAttribLocation(shaderProgram, 'cubeCorner');
                gl.enableVertexAttribArray(this.lineShader.vertexAttribute);
                
                gl.enable(gl.DEPTH_TEST);
            }
        );
    }
    
    renderer_adapter = null;
    testChange() {
        if (this.animation_request_id) {
            window.cancelAnimationFrame(this.animation_request_id);
            this.animation_request_id = null;
        }
        if (this.renderer_adapter) {
            if (this.selectedObject)
                this.selectedObject = null;
            this.renderer_adapter.destroy();
            this.renderer_adapter = null;
        }
        
        const world_select = $("#test-select");
        if (world_select.value === "")
            return;
        const world_path = world_select.val();

        $("#loading-img").css('visibility', 'visible');
        
        myconsole.log("Loading " + world_path + "...");
        import("../" + world_path + "/test.js").then(function(module) {
            module.configureTest(function(test) {
                this.canvas.attr("width", test.width);
                this.canvas.attr("height", test.height);
                
                try {
                    const gl = this.gl;
                    gl.viewport(0, 0, test.width, test.height);
                    
                    WebGLRendererAdapter.build(gl, this.canvas.get(0), test.renderer, function(adapter) {
                        this.renderer_adapter = adapter;
                        
                        // Set the initial values for the controls
                        this.getDefaultControlValues(adapter);
                        
                        // reset the mouseDelta, to prevent any previous mouse input from making the camera jump on the first frame
                        this.mouseMoveDelta = [0,0];
                        
                        myconsole.log("Starting draw world loop...");
                        this.animation_request_id = window.requestAnimationFrame(this.draw.bind(this));

                        $("#loading-img").css('visibility', 'hidden');
                    }.bind(this));
                } catch(error) {
                    myconsole.error(error);
                    $("#loading-img").css('visibility', 'hidden');
                }
            }.bind(this));
        }.bind(this));
    }
    

    lastDrawTimestamp = null;
    draw(timestamp) {
        const currentTimestamp = performance.now();
        const timeDelta = this.lastDrawTimestamp ? (currentTimestamp - this.lastDrawTimestamp) : 1;
        
        // draw the world, and request the next frame of animation
        if (this.renderer_adapter) {
            $('#fps-display').text((1000 / timeDelta).toFixed(1) + " FPS - " + this.renderer_adapter.drawCount + " samples");
            
            this.handleMovement(timeDelta);
            
            this.renderer_adapter.drawWorld(currentTimestamp);
            
            if (this.selectedObject)
                this.drawWireframe(this.selectedObject.aabb)
            
            this.animation_request_id = window.requestAnimationFrame(this.draw.bind(this));
        }
        
        // reset all intermediary input/timing variables
        this.lastDrawTimestamp = currentTimestamp;
    }
    drawWireframe(aabb) {
        if (this.lineShader) {
            const gl = this.gl;
            if (aabb.isFinite()) {
                gl.useProgram(this.lineShader.program);
                gl.bindTexture(gl.TEXTURE_2D, null);
                
                gl.uniform4fv(      this.lineShader.uniforms.lineColor,      this.selectedObject.isBeingTransformed ? Vec.of(1,0,0,1) : Vec.of(1,1,1,1));
                gl.uniform3fv(      this.lineShader.uniforms.cubeMin,        aabb.min.slice(0,3));
                gl.uniform3fv(      this.lineShader.uniforms.cubeMax,        aabb.max.slice(0,3));
                gl.uniform3fv(      this.lineShader.uniforms.cameraPosition, this.renderer_adapter.getCameraPosition().slice(0,3));
                gl.uniformMatrix4fv(this.lineShader.uniforms.modelviewProjection, true, this.renderer_adapter.getCameraViewMatrix().flat());
                
                gl.bindBuffer(gl.ARRAY_BUFFER, this.lineShader.vertexBuffer);
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineShader.indexBuffer);
                gl.vertexAttribPointer(this.lineShader.vertexAttribute, 3, gl.FLOAT, false, 0, 0);
                gl.drawElements(gl.LINES, 24, gl.UNSIGNED_SHORT, 0);
            }
        }
    }
    
    selectedObject = null;
    selectObjectAt(x, y) {
        if (!this.renderer_adapter)
            return;
        
        this.selectedObject = this.renderer_adapter.selectObjectAt(x, y);
        if (this.selectedObject) {
            this.selectedObject.aabb = this.selectedObject.object.getBoundingBox();
        }
        
        // update the rest of the display?
    }
    
    changeLensSettings() {
        const focusValue  =  Number.parseFloat($('#focus-distance').val()),
              sensorValue =  Number.parseFloat($('#sensor-size').val()),
              fovValue    = -Number.parseFloat($('#fov-range').val());
        if (this.renderer_adapter)
            this.renderer_adapter.changeLensSettings(focusValue, sensorValue, fovValue);
        $('#focus-output').text(focusValue.toFixed(2));
        $('#sensor-output').text(sensorValue.toFixed(2));
        $('#fov-output').text((180 * fovValue / Math.PI).toFixed(2));
    }
    
    getDefaultControlValues(renderer_adapter) {
        $("#renderer-depth").val(renderer_adapter.maxBounceDepth);
        
        const focus_distance = renderer_adapter.getCameraFocusDistance();
        if (renderer_adapter.getCameraFocusDistance() != 1.0)
            $('#focus-distance').val(renderer_adapter.getCameraFocusDistance());
        else
            $('#focus-distance').val(renderer_adapter.getCameraPosition().minus(
                renderer_adapter.adapters.world.world.kdtree.aabb.center).norm()); // TODO
        
        $('#sensor-size').val(renderer_adapter.getCameraSensorSize());
        $('#fov-range').val(-renderer_adapter.getCameraFOV());
        
        this.changeLensSettings();
    }
    
    
    keySpeed = 3.0;
    mouseSpeed = 0.0013;
    handleMovement(timeDelta) {
        const beforeCameraTransform    = this.renderer_adapter.getCameraTransform(),
              beforeCameraInvTransform = this.renderer_adapter.getCameraInverseTransform();
        
        const mouseDelta = [0,1].map(i => this.nextMousePos[i] - this.lastMousePos[i]);
        const mouseMoveDelta = (this.selectedObject && this.selectedObject.isBeingTransformed) ? [0,0] : mouseDelta;
        if (timeDelta > 0 && (mouseMoveDelta.some(x => (x != 0)) || this.keyMoveDelta.some(x => (x != 0)))) {
            const normalizedMouseDelta = Vec.from(mouseMoveDelta.map(     v => this.mouseSpeed * v));
            const normalizedKeyDelta   = Vec.from(this.keyMoveDelta.map(  v => this.keySpeed   * v * timeDelta / 1000));
            
            this.renderer_adapter.moveCamera(normalizedMouseDelta, normalizedKeyDelta);
        }
        
        if (this.selectedObject && this.selectedObject.isBeingTransformed) {
            const lastPos3D = this.renderer_adapter.getRayForPixel(this.lastMousePos[0], this.lastMousePos[1]).getPoint(this.selectedObject.selectDepth);
            const nextPos3D = this.renderer_adapter.getRayForPixel(this.nextMousePos[0], this.nextMousePos[1]).getPoint(this.selectedObject.selectDepth);
            
            const cameraDeltaTransform    = this.renderer_adapter.getCameraTransform().times(beforeCameraInvTransform),
                  cameraDeltaInvTransform = beforeCameraTransform.times(this.renderer_adapter.getCameraInverseTransform());
            
            const new_transform     = Mat4.translation(nextPos3D.minus(lastPos3D)).times(cameraDeltaTransform).times(this.selectedObject.object.transform),
                  new_inv_transform = this.selectedObject.object.inv_transform.times(cameraDeltaInvTransform).times(Mat4.translation(lastPos3D.minus(nextPos3D)));
            this.renderer_adapter.setTransform(this.selectedObject.transform.index, new_inv_transform);
            
            this.selectedObject.object.setTransform(new_transform, new_inv_transform);
            this.selectedObject.aabb = this.selectedObject.object.getBoundingBox();
        }
        
        this.lastMousePos = this.nextMousePos;
    }
    
    
    
    // Key movement functionality
    keyMoveDelta = [0,0,0];
    keysDown = {};
    keyDirMap = {
        "w": [ 0, 0,-1],
        "s": [ 0, 0, 1],
        "a": [-1, 0, 0],
        "d": [ 1, 0, 0],
        " ": [ 0, 1, 0],
        "c": [ 0,-1, 0]
    };
    registerKeyEvents() {
        const canvas_widget = $("div.canvas-widget");
        canvas_widget.on("keydown", this.keyDown.bind(this));
        canvas_widget.on("keyup",   this.keyUp.bind(this));
        canvas_widget.on("blur",    this.keyReset.bind(this));
    }
    calcKeyDelta() {
        this.keyMoveDelta = [0,0,0];
        for (let [key, isDown] of Object.entries(this.keysDown))
            if (isDown && key in this.keyDirMap)
                for (let i = 0; i < 3; ++i)
                    this.keyMoveDelta[i] += this.keyDirMap[key][i];
    }
    keyDown(e) {
        if (e.key in this.keyDirMap) {
            e.stopPropagation();
            e.preventDefault();
            this.keysDown[e.key] = true;
        }
        this.calcKeyDelta();
    }
    keyUp(e) {
        if (e.key in this.keyDirMap)
            this.keysDown[e.key] = false;
        this.calcKeyDelta();
    }
    keyReset(e) {
        this.keysDown = {};
        this.calcKeyDelta();
    }
    
    
    // Mouse/pointer movement functionality
    lastMousePos = [0,0];
    nextMousePos = [0,0];
    isMouseDown = false;
    hasMouseMoved = false;
    registerPointerEvents(canvas) {
        canvas.on("pointerdown",   this.pointerDown.bind(this));
        canvas.on("pointerup",     this.pointerUp.bind(this));
        canvas.on("pointercancel", this.pointerLeave.bind(this));
        canvas.on("pointermove",   this.pointerMove.bind(this));
        canvas.on("blur", e => {
            this.isMouseDown = false;
            this.keyReset();
        });
    }
    pointerDown(e) {
        if (e.pointerType === 'mouse' && e.button !== 0)
            return;
        this.hasMouseMoved = false;
        this.isMouseDown = true;
        if (this.renderer_adapter) {
            const rect = e.target.getBoundingClientRect();
            const mousePos = [event.clientX - rect.left, event.clientY - rect.top];
            if (this.selectedObject) {
                const ray = this.renderer_adapter.getRayForPixel(mousePos[0], mousePos[1]);
                this.selectedObject.selectDepth = this.selectedObject.aabb.isFinite()
                    ? this.selectedObject.aabb.intersect(ray) : this.selectedObject.object.intersect(ray).distance;
                this.selectedObject.isBeingTransformed = this.selectedObject.selectDepth > 0;
            }
            this.nextMousePos = this.lastMousePos = mousePos;
        }
        this.canvas.get(0).setPointerCapture(e.pointerId);
    }
    pointerUp(e) {
        if (this.hasMouseMoved === false && this.renderer_adapter) {
            const rect = e.target.getBoundingClientRect();
            this.selectObjectAt(event.clientX - rect.left, event.clientY - rect.top);
        }
        this.pointerLeave(e);
    }
    pointerLeave(e) {
        if (this.selectedObject) {
            if (this.selectedObject.isBeingTransformed)
                this.lastMousePos = this.nextMousePos;
            this.selectedObject.isBeingTransformed = false;
        }
        this.isMouseDown = false;
        this.canvas.get(0).releasePointerCapture(e.pointerId);
    }
    pointerMove(e) {
        if (this.isMouseDown) {
            this.hasMouseMoved = true;
            if (this.renderer_adapter) {
                const rect = e.target.getBoundingClientRect();
                this.nextMousePos = [event.clientX - rect.left, event.clientY - rect.top];
            }
        }
    }
}

