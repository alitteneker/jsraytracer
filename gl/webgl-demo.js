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
        
        this.registerPointerEvents(canvas);
        this.registerKeyEvents();
        
        $("#renderer-depth").on('spin', (e, ui) => {
            if (this.renderer_adapter)
                this.renderer_adapter.changeMaxBounceDepth(Number.parseInt(ui.value));
        });
        
        
        // setup standard listeners for changing lens settings
        $("#fov-range,#focus-distance,#sensor-size").on('input', this.changeLensSettings.bind(this));
        
        
        $("#transform-controls input").checkboxradio({ icon: false, disabled: true });
        $("#transform-controls input").on("change", this.transformModeChange.bind(this));
        
        $("#objects-controls").accordion({
            collapsible: true,
            active: false,
            heightStyle: "content",
            animate: false,
            activate: function(e, ui) {
                this.selectObject(this.objects[ui.newHeader.attr("data-object-index")]);
            }.bind(this) });
        
        // Setup the UI to pretty things up...
        $("#control-panel").accordion({ animate: false, collapsible:true, active: -1, heightStyle: "content" });
        $(".control-group").controlgroup();
        $("#help-button").button({
            icon: "ui-icon-help",
            showLabel: false
        });
        
        
        $("#test-select").on("change", this.testChange.bind(this));
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
            uniform float uMaxDepth;
            out vec4 outTexelColor;
            void main() {
                gl_FragDepth = min(length(uCameraPosition - vertexPosition) / uMaxDepth, 1.0-EPSILON);
                outTexelColor = uLineColor;
            }`,
            (shaderProgram) => {
                this.lineShader = {};
                this.lineShader.program = shaderProgram;
                this.lineShader.uniforms = {
                    lineColor:           gl.getUniformLocation(shaderProgram, "uLineColor"),
                    cubeMin:             gl.getUniformLocation(shaderProgram, "uCubeMin"),
                    cubeMax:             gl.getUniformLocation(shaderProgram, "uCubeMax"),
                    maxDepth:            gl.getUniformLocation(shaderProgram, "uMaxDepth"),
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
                this.selectObject(null);
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
                        
                        this.initializeWorldControls(adapter);
                        
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
                
                gl.uniform1f(       this.lineShader.uniforms.maxDepth,       this.renderer_adapter.maxDepth);
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

        this.selectObject(this.renderer_adapter.selectObjectAt(x, y));
        
        // update the rest of the display?
    }
    selectObject(selectedObject) {
        if (this.selectedObject = selectedObject) {
            this.selectedObject.aabb = this.selectedObject.object.getBoundingBox();
            $("#objects-controls").accordion("option", "active", selectedObject.index);
            $("#transform-controls input").checkboxradio("enable");
            
            this.updateSelectedObjectTransformValues();
        }
        else {
            $("#objects-controls").accordion("option", "active", false);
            $("#transform-controls input").checkboxradio("disable");
        }
    }
    
    
    
    objects = [];
    initializeWorldControls(adapter) {
        $("#objects-controls").empty();
        const objects = this.objects = adapter.getObjects();
        let oc = "";
        for (let o of objects) {
            oc += `<h4 data-object-index="${o.index}">${WebGLGeometriesAdapter.TypeStringLabel(o.geometry.index)}</h4><div class="object-control-container">`;
            
            const [pos, rot, scale] = Mat4.breakdownTransform(o.object.transform);
            oc += `<div class="object-geometry-controls"><div><table>
                        <tr><td>Position</td><td>
                            <input class="ui-spinner-input" data-transform-type="pos0" data-object-id="${o.index}">
                            <input class="ui-spinner-input" data-transform-type="pos1" data-object-id="${o.index}">
                            <input class="ui-spinner-input" data-transform-type="pos2" data-object-id="${o.index}">
                        </td></tr>
                        <tr><td>Rotation</td><td>
                            <input class="ui-spinner-input" data-transform-type="rot0" data-object-id="${o.index}">
                            <input class="ui-spinner-input" data-transform-type="rot1" data-object-id="${o.index}">
                            <input class="ui-spinner-input" data-transform-type="rot2" data-object-id="${o.index}">
                        </td></tr>
                        <tr><td>Scale</td><td>
                            <input class="ui-spinner-input" data-transform-type="scale0" data-object-id="${o.index}">
                            <input class="ui-spinner-input" data-transform-type="scale1" data-object-id="${o.index}">
                            <input class="ui-spinner-input" data-transform-type="scale2" data-object-id="${o.index}">
                        </td></tr>
                   </table></div></div>`;
            
            const material = o.material.value;
            oc += `<div class="object-material-controls"><table>`;
            for (let mk of WebGLMaterialsAdapter.MATERIAL_PROPERTIES) {
                if (material[mk].type == "solid")
                    oc += `<tr><td><input type="color" id="material-${o.index}-${material[mk]._id}" data-mc-id="${material[mk]._id}" value="${rgbToHex(material[mk].color)}"></td>
                               <td><label for="material-${o.index}-${material[mk]._id}">${mk}</label></td></tr>`;
                if (material[mk].type == "scalar")
                    oc += `<tr><td><input class="ui-spinner-input" id="material-${o.index}-${material[mk]._id}" data-mc-id="${material[mk]._id}" value="${material[mk].value}"></td>
                               <td><label for="material-${o.index}-${material[mk]._id}">${mk}</label></td></tr>`;
            }
            oc += "</table></div></div>";
        }
        $("#objects-controls").append(oc);
        
        $(`#objects-controls input[type="color"]`).on('input', this.modifyMaterialColor.bind(this));
        
        $("#objects-controls .ui-spinner-input").spinner({ step: 0.01, numberFormat: "N3" });
        $("#objects-controls input[data-transform-type]").on('spinstop', this.transformSelectedObjectValues.bind(this))
        
        $("#objects-controls").accordion("refresh");
        
        $("#lights-controls").empty();
        // for (let l of adapter.getLights()) {
        // }
    }
    
    
    modifyMaterialColor(e) {
        const target = $(e.target);
        this.renderer_adapter.modifyMaterialSolidColor(target.attr("data-mc-id"), hexToRgb(target.val()));
    }
    
    
    transformMode = "translate";
    transformRotateRate = 0.001;
    transformScaleRate = 0.01;
    transformModeChange() {
        this.transformMode = $("#transform-controls input:checked").val();
    }
    transformSelectedObjectWithMouse(beforeCameraTransform, beforeCameraInvTransform) {
        let deltaTransform = Mat4.identity(), deltaInvTransform = Mat4.identity();
        if (this.lastMousePos[0] != this.nextMousePos[0] || this.lastMousePos[1] != this.nextMousePos[1]) {
            if (this.transformMode == "translate") {
                const lastPos3D = this.renderer_adapter.getRayForPixel(this.lastMousePos[0], this.lastMousePos[1]).getPoint(this.selectedObject.selectDepth);
                const nextPos3D = this.renderer_adapter.getRayForPixel(this.nextMousePos[0], this.nextMousePos[1]).getPoint(this.selectedObject.selectDepth);
                
                deltaTransform    = Mat4.translation(nextPos3D.minus(lastPos3D));
                deltaInvTransform = Mat4.translation(lastPos3D.minus(nextPos3D));
            }
            if (this.transformMode == "rotate") {
                const rotateDelta = [0,1].map(i => (this.nextMousePos[i] - this.lastMousePos[i]) * this.transformRotateRate);
                const rotation = Mat4.rotation(rotateDelta[0], beforeCameraTransform.times(Vec.of(0,1,0,0)))
                          .times(Mat4.rotation(rotateDelta[1], beforeCameraTransform.times(Vec.of(1,0,0,0))));
                
                deltaTransform    = Mat4.translation(this.selectedObject.aabb.center).times(rotation             ).times(Mat4.translation(this.selectedObject.aabb.center.times(-1)));
                deltaInvTransform = Mat4.translation(this.selectedObject.aabb.center).times(rotation.transposed()).times(Mat4.translation(this.selectedObject.aabb.center.times(-1)));
            }
            if (this.transformMode == "scale") {
                const scale = 1 + (this.nextMousePos[1] - this.lastMousePos[1]) * this.transformScaleRate;
                
                deltaTransform    = Mat4.translation(this.selectedObject.aabb.center).times(Mat4.scale(scale)      ).times(Mat4.translation(this.selectedObject.aabb.center.times(-1)));
                deltaInvTransform = Mat4.translation(this.selectedObject.aabb.center).times(Mat4.scale(1 / scale)).times(Mat4.translation(this.selectedObject.aabb.center.times(-1)));
            }
        }
        
        const new_transform     = deltaTransform.times(this.renderer_adapter.getCameraTransform().times(beforeCameraInvTransform)).times(this.selectedObject.object.transform),
              new_inv_transform = this.selectedObject.object.inv_transform.times(beforeCameraTransform.times(this.renderer_adapter.getCameraInverseTransform())).times(deltaInvTransform);

        this.setSelectedObjectTransform(new_transform, new_inv_transform);
        this.updateSelectedObjectTransformValues();
    }
    
    transformSelectedObjectValues() {
        const [pos, rot, scale] = [Vec.of(0,0,0), Vec.of(0,0,0), Vec.of(0,0,0)];
        for (let i of [0,1,2]) {
            pos[i]   = Number.parseFloat($(`input[data-transform-type="pos${i}"][data-object-id="${this.selectedObject.index}"]`  ).val());
            scale[i] = Number.parseFloat($(`input[data-transform-type="scale${i}"][data-object-id="${this.selectedObject.index}"]`).val());
            rot[i]   = Number.parseFloat($(`input[data-transform-type="rot${i}"][data-object-id="${this.selectedObject.index}"]`  ).val()) * Math.PI / 180;
        }
        this.setSelectedObjectTransform(...Mat4.transformAndInverseFromParts(pos, rot, scale));
    }
    
    updateSelectedObjectTransformValues() {
        if (!this.selectedObject)
            return;
        const [pos, rot, scale] = Mat4.breakdownTransform(this.selectedObject.object.transform);
        for (let i of [0,1,2]) {
            $(`input[data-transform-type="pos${i}"][data-object-id="${this.selectedObject.index}"]`  ).val(pos[i].toFixed(2));
            $(`input[data-transform-type="scale${i}"][data-object-id="${this.selectedObject.index}"]`).val(scale[i].toFixed(2));
            $(`input[data-transform-type="rot${i}"][data-object-id="${this.selectedObject.index}"]`  ).val((rot[i] * 180 / Math.PI).toFixed(2));
        }
    }
    
    setSelectedObjectTransform(transform, inv_transform) {
        this.renderer_adapter.setTransform(this.selectedObject.transform.index, transform, inv_transform);
        this.selectedObject.aabb = this.selectedObject.object.getBoundingBox();
    }
    
    
    
    
        
    keySpeed = 3.0;
    mouseSpeed = 0.0013;
    handleMovement(timeDelta) {
        const beforeCameraTransform    = this.renderer_adapter.getCameraTransform(),
              beforeCameraInvTransform = this.renderer_adapter.getCameraInverseTransform();
        
        const mouseMoveDelta = (this.selectedObject && this.selectedObject.isBeingTransformed) ? [0,0] : [0,1].map(i => this.nextMousePos[i] - this.lastMousePos[i]);
        if (timeDelta > 0 && (mouseMoveDelta.some(x => (x != 0)) || this.keyMoveDelta.some(x => (x != 0)))) {
            const normalizedMouseDelta = Vec.from(mouseMoveDelta.map(     v => this.mouseSpeed * v));
            const normalizedKeyDelta   = Vec.from(this.keyMoveDelta.map(  v => this.keySpeed   * v * timeDelta / 1000));
            
            this.renderer_adapter.moveCamera(normalizedMouseDelta, normalizedKeyDelta);
        }
        
        if ((this.selectedObject && this.selectedObject.isBeingTransformed))
            this.transformSelectedObjectWithMouse(beforeCameraTransform, beforeCameraInvTransform);
        
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

