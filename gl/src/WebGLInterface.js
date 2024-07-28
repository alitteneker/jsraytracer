class WebGLInterface {
    constructor() {
        const canvas = this.canvas = $('#glcanvas');
        
        const gl = this.gl = canvas.get(0).getContext('webgl2');
        if (!gl)
            throw 'Unable to initialize WebGL. Your browser or machine may not support it.';
        
        const ext = gl.getExtension('GMAN_debug_helper');
        if (ext) {
            ext.setConfiguration({
                failUnsetUniforms: false,
                throwOnError: false
            });
        }
        
        this.buildLineShader(gl);
        
        this.registerPointerEvents(canvas);
        this.registerKeyEvents();
        
        $("#renderer-controlgroup").controlgroup({ /* direction: "vertical" */ });
        
        $(".control-group").controlgroup();
        
        
        this.samplesPerDraw = 1;
        $("#samples-per-draw").on('spin', (e, ui) => {
            this.samplesPerDraw = Number.parseInt(ui.value);
        });
        
        if (WebGLRendererAdapter.DOUBLE_RECURSIVE)
            $("#renderer-depth").spinner("disable");
        else {
            $("#renderer-depth").on('spin', (e, ui) => {
                if (this.renderer_adapter)
                    this.renderer_adapter.changeMaxBounceDepth(Number.parseInt(ui.value));
            });
        }
        
        $("#renderer-log-color").on('spin', (e, ui) => {
            if (this.renderer_adapter)
                this.renderer_adapter.colorLogScale = Number.parseFloat(ui.value);
        });
        $("#renderer-random-sample").on('input', (e) => {
            if (this.renderer_adapter) {
                this.renderer_adapter.doRandomSample = e.target.checked;
                this.renderer_adapter.resetDrawCount();
            }
        });
        
        $("#canvas-width").on('spin spinstop', (e, ui) => {
            if (this.renderer_adapter) {
                const v = (ui && ui.value !== undefined) ? ui.value : $(e.target).val();
                this.renderer_adapter.resizeCanvas(Number.parseInt(v), this.canvas.attr('height'));
            }
        });
        $("#canvas-height").on('spin spinstop', (e, ui) => {
            if (this.renderer_adapter) {
                const v = (ui && ui.value !== undefined) ? ui.value : $(e.target).val();
                this.renderer_adapter.resizeCanvas(this.canvas.attr('width'), Number.parseInt(v));
            }
        });
        
        
        // setup standard listeners for changing lens settings
        $("#fov-range,#focus-distance,#sensor-size").on('input', this.changeLensSettings.bind(this));
        $(".camera-transform").on('spinstop', this.modifyCameraTransformValues.bind(this));
        $(".camera-transform").spinner({ step: 0.01, numberFormat: "N3" });
        
        $('#object-control-bar').controlgroup("disable");
        $("#transform-mode").selectmenu({ change: this.transformModeChange.bind(this), width: 'auto' });
            
        $("#selected-object-controls").dialog({ autoOpen: false, title: "Selected Object", minWidth: 400, maxHeight: 800 });
        $("#edit-object-button").on("click", function() { $("#selected-object-controls").dialog("open"); }.bind(this));
        
        $("#deselect-object-button").on("click", function() { this.selectObject(null); }.bind(this));
        $("#deselect-object-button").button({ icon: "ui-icon-closethick", showLabel: false });
        
        
        $("#world-objects").fancytree({
            source: [
                { title: "Objects", key: "_objects", folder: true, clickFolderMode: 2 },
                { title: "Lights",  key: "_lights",  folder: true, clickFolderMode: 2 }
            ],
            activate: this.selectObjectTree.bind(this)
        });
        
        // Setup the UI to pretty things up...
        $("#control-panel").accordion({ animate: false, collapsible:true, active: false, heightStyle: "content" });
        $("#help-button").button({ icon: "ui-icon-help", showLabel: false }).on("click", function() { $('#help-dialog').dialog("open") });
        $('#help-dialog').dialog({ autoOpen: false, title: "Help" })
    }
    
    lineShader = null;
    buildLineShader(gl) {
        WebGLHelper.compileShaderProgramFromSources(gl,
            `#version 300 es
            precision mediump float;
            
            in vec3 cubeCorner;
            
            uniform vec3 uCubeMin;
            uniform vec3 uCubeMax;
            uniform mat4 uModelMatrix;
            uniform mat4 uViewProjectionMatrix;
            
            out vec3 vertexPosition;
            void main() {
                vertexPosition = (uModelMatrix * vec4(mix(uCubeMin, uCubeMax, cubeCorner), 1)).xyz;
                gl_Position = uViewProjectionMatrix * vec4(vertexPosition, 1.0);
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
                    lineColor:            gl.getUniformLocation(shaderProgram, "uLineColor"),
                    cubeMin:              gl.getUniformLocation(shaderProgram, "uCubeMin"),
                    cubeMax:              gl.getUniformLocation(shaderProgram, "uCubeMax"),
                    maxDepth:             gl.getUniformLocation(shaderProgram, "uMaxDepth"),
                    cameraPosition:       gl.getUniformLocation(shaderProgram, "uCameraPosition"),
                    modelMatrix:          gl.getUniformLocation(shaderProgram, "uModelMatrix"),
                    viewProjectionMatrix: gl.getUniformLocation(shaderProgram, "uViewProjectionMatrix"),
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
    changeTest(test) {
        if (this.renderer_adapter) {
            if (this.selectedObject)
                this.selectObject(null);
            this.renderer_adapter.destroy();
            this.renderer_adapter = null;
        }
        
        // Reset some controls and tallies, to avoid cross contamination between setups.
        $("#samples-per-draw").val(this.samplesPerDraw = 1);
        this.timeDeltaHistory = [];
        this.timeDeltaHistorySum = 0;
        
        try {
            this.canvas.attr("width", test.width);
            this.canvas.attr("height", test.height);
            
            $("#canvas-width").val(test.width);
            $("#canvas-height").val(test.height);

            WebGLRendererAdapter.build(this.gl, this.canvas.get(0), test.renderer, function(adapter) {
                this.renderer_adapter = adapter;
                
                // Set the initial values for the controls
                this.getDefaultControlValues(adapter);
                
                this.initializeWorldControls(adapter);
                
                // reset the mouseDelta, to prevent any previous mouse input from making the camera jump on the first frame
                this.mouseMoveDelta = [0,0];
                
                myconsole.log("Starting draw world loop...");
                this.animation_request_id = window.requestAnimationFrame(this.draw.bind(this));

                $(".loading").css('visibility', 'hidden');
            }.bind(this));
        } catch(error) {
            myconsole.error(error);
            $(".loading").css('visibility', 'hidden');
        }
    }
    stopDrawLoop() {
        if (this.animation_request_id) {
            window.cancelAnimationFrame(this.animation_request_id);
            this.animation_request_id = null;
        }
        if (this.renderer_adapter) {
            if (this.selectedObject)
                this.selectObject(null);
            $('#fps-display').text(this.renderer_adapter.drawCount + " samples");
        }
        else
            $('#fps-display').text("");
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
        $("#renderer-random-sample").prop("checked", renderer_adapter.doRandomSample).checkboxradio("refresh");
        
        const focus_distance = renderer_adapter.getCameraFocusDistance();
        if (renderer_adapter.getCameraFocusDistance() != 1.0)
            $('#focus-distance').val(renderer_adapter.getCameraFocusDistance());
        else
            $('#focus-distance').val(renderer_adapter.getCameraPosition().minus(
                renderer_adapter.adapters.world.world.getFiniteBoundingBox().center).norm());
        
        $('#sensor-size').val(renderer_adapter.getCameraSensorSize());
        $('#fov-range').val(-renderer_adapter.getCameraFOV());
        
        this.changeLensSettings();
        this.updateCameraTransformValues();
    }
    

    lastDrawTimestamp = null;
    timeDeltaHistory = [];
    timeDeltaHistorySum = 0;
    timeDeltaHistoryMaxLength = 30;
    draw(timestamp) {
        const currentTimestamp = performance.now();
        const timeDelta = this.lastDrawTimestamp ? (currentTimestamp - this.lastDrawTimestamp) : 1;
        
        // draw the world, and request the next frame of animation
        if (this.renderer_adapter) {
            // Compute a running average of delta times and display a stable FPS count.
            this.timeDeltaHistory.push(timeDelta);
            this.timeDeltaHistorySum += timeDelta;
            if (this.timeDeltaHistory.length > this.timeDeltaHistoryMaxLength)
                this.timeDeltaHistorySum -= this.timeDeltaHistory.shift();
            const avgTimeDelta = this.timeDeltaHistorySum / this.timeDeltaHistory.length;
            $('#fps-display').text((1000 / avgTimeDelta).toFixed(1) + " FPS - " + this.renderer_adapter.drawCount + " samples");
            
            // Deal with any camera movements or object transforms that might be present since last frame.
            this.handleMovement(timeDelta);
            
            // Draw the scene, possibly fetching multiple samples.
            for (let i = 0; i < this.samplesPerDraw; ++i)
                this.renderer_adapter.drawWorld(currentTimestamp);
            
            // If any object is selected, draw it's wireframe.
            if (this.transformObject)
                this.drawWireframe(this.transformObject.getAncestorTransform(), this.transformObject.aabb, this.transformObject.isBeingTransformed ? Vec.of(0,0,1,1) : Vec.of(1,1,1,1));
            if (this.selectedObject && this.transformObject !== this.selectedObject)
                this.drawWireframe(this.selectedObject.getAncestorTransform(), this.selectedObject.aabb, Vec.of(1,0,0,1));
            
            // Request another frame of animation.
            this.animation_request_id = window.requestAnimationFrame(this.draw.bind(this));
        }
        
        // reset all intermediary input/timing variables
        this.lastDrawTimestamp = currentTimestamp;
    }
    drawWireframe(ancestorTransform, aabb, color) {
        if (this.lineShader) {
            const gl = this.gl;
            if (aabb.isFinite()) {
                gl.useProgram(this.lineShader.program);
                gl.bindTexture(gl.TEXTURE_2D, null);
                
                gl.uniform1f(       this.lineShader.uniforms.maxDepth,       this.renderer_adapter.maxDepth);
                gl.uniform4fv(      this.lineShader.uniforms.lineColor,      color);
                gl.uniform3fv(      this.lineShader.uniforms.cubeMin,        aabb.min.slice(0,3));
                gl.uniform3fv(      this.lineShader.uniforms.cubeMax,        aabb.max.slice(0,3));
                gl.uniform3fv(      this.lineShader.uniforms.cameraPosition, this.renderer_adapter.getCameraPosition().slice(0,3));
                gl.uniformMatrix4fv(this.lineShader.uniforms.modelMatrix,          true, ancestorTransform.flat());
                gl.uniformMatrix4fv(this.lineShader.uniforms.viewProjectionMatrix, true, this.renderer_adapter.getCameraViewMatrix().flat());
                
                gl.bindBuffer(gl.ARRAY_BUFFER, this.lineShader.vertexBuffer);
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineShader.indexBuffer);
                gl.vertexAttribPointer(this.lineShader.vertexAttribute, 3, gl.FLOAT, false, 0, 0);
                gl.drawElements(gl.LINES, 24, gl.UNSIGNED_SHORT, 0);
            }
        }
    }
    
    
    
    selectedObject = null;
    transformObject = null;
    selectObjectAt(x, y) {
        if (!this.renderer_adapter)
            return;
        this.selectObject(this.renderer_adapter.selectObjectAt(x, y));
    }
    selectObject(selectedObject) {
        if (this.selectedObject = selectedObject) {
            this.selectedObject.aabb = this.selectedObject.getBoundingBox();
            
            this.transformObject = selectedObject;
            while (this.transformObject && this.transformObject.notTransformable)
                this.transformObject = this.transformObject.ancestors.length ? this.transformObject.ancestors[this.transformObject.ancestors.length-1] : null;
            if (this.transformObject && this.transformObject !== this.selectedObject)
                this.transformObject.aabb = this.transformObject.getBoundingBox();
            
            const fancytree = $.ui.fancytree.getTree("#world-objects");
            const selecttreenode = fancytree.getNodeByKey((selectedObject.worldtype == "light" ? "l" : "o") + selectedObject.ID);
            if (selecttreenode)
                selecttreenode.setActive(true, {noEvents: true});
            else {
                const transformtreenode = fancytree.getNodeByKey((this.transformObject.worldtype == "light" ? "l" : "o") + this.transformObject.ID);
                if (transformtreenode)
                    transformtreenode.setActive(true, {noEvents: true});
                else
                    throw "Unable to find selected object representative in scene tree";
            }
            
            $('#object-control-bar').controlgroup("enable");
            
            this.buildSelectedObjectControls();
        }
        else {
            this.transformObject = null;
            const activeNode = $.ui.fancytree.getTree("#world-objects").getActiveNode();
            if (activeNode)
                activeNode.setActive(false);
            $('#object-control-bar').controlgroup("disable");
            $("#selected-object-controls").empty();
        }
    }
    selectObjectTree(e, d) {
        if (!("_worldtype" in d.node.data))
            return;
        if (d.node.data._worldobj && d.node.data._worldobj.type == "primitive") {
            const parentobj = d.node.parent.data._worldobj;
            this.selectObject(d.node.data._worldobj.toInstance(parentobj ? parentobj.ancestors.concat(parentobj) : []));
        }
        else
            this.selectObject(d.node.data._worldobj);
    }
    
    buildSelectedObjectControls() {
        const o = this.selectedObject;
        let oc = "";
        
        $("#selected-object-controls").empty();
        
        if (!o.notTransformable && WebGLGeometriesAdapter.SWITCHABLE_TYPES.indexOf(o.geometryIndex) >= 0) {
            oc += `<label for="geometry-type-select">Geometry Type:</label><select id="geometry-type-select">`;
            for (let t of WebGLGeometriesAdapter.SWITCHABLE_TYPES)
                oc += `<option value="${t}" ${t == o.geometryIndex ? "selected" : ""}>${WebGLGeometriesAdapter.TypeStringLabel(t)}</option>`;
            oc += "</select>";
        }
        oc += `<div class="object-geometry-controls">${this.getSourceForTransformControls(o.getWorldTransform(), o.index)}</div>`;
        
        
        const material = o.getMaterialValues();
        if (material) {
            oc += `<div class="object-material-controls"><table>`;
            for (let mk of Object.keys(material)) {
                const label = mk.substr(0,1).toLocaleUpperCase() + mk.substr(1);
                if (material[mk].type == "scalar") {
                    oc += `<tr><td><label for="material-${o.index}-${material[mk]._id}">${label}</label></td>
                            <td><input class="ui-spinner-input" id="material-${o.index}-${material[mk]._id}" data-mc-id="${material[mk]._id}" data-mc-type="scalar" value="${material[mk].value}"></td></tr>`;
                }
                if (material[mk].type == "solid") {
                    oc += `<tr><td><label for="material-${o.index}-${material[mk]._id}">${label}</label></td><td>
                                   <input class="ui-spinner-input" id="material-${o.index}-${material[mk]._id}-intensity" data-mc-id="${material[mk]._id}" data-mc-type="intensity" value="${Math.max(1, ...material[mk].color)}">
                                   <input type="color" id="material-${o.index}-${material[mk]._id}" data-mc-id="${material[mk]._id}" value="${rgbToHex(material[mk].color)}">
                               </td>
                               </tr>`;
                }
                if (material[mk].type == "checkerboard") {
                    oc += `<tr><td><span>${label}</span></td><td>
                               <input class="ui-spinner-input" id="material-${o.index}-${material[mk].color1._id}-intensity" data-mc-id="${material[mk].color1._id}" data-mc-type="intensity" value="${Math.max(1, ...material[mk].color1.color)}">
                               <input type="color" id="material-${o.index}-${material[mk].color1._id}" data-mc-id="${material[mk].color1._id}" value="${rgbToHex(material[mk].color1.color)}">
                               <input class="ui-spinner-input" id="material-${o.index}-${material[mk].color2._id}-intensity" data-mc-id="${material[mk].color2._id}" data-mc-type="intensity" value="${Math.max(1, ...material[mk].color2.color)}">
                               <input type="color" id="material-${o.index}-${material[mk].color2._id}" data-mc-id="${material[mk].color2._id}" value="${rgbToHex(material[mk].color2.color)}">
                           </td></tr>`;
                }
            }
            oc += "</table></div>";
        }
        
        
        const object_properties = o.getMutableObjectProperties && o.getMutableObjectProperties();
        if (object_properties) {
            oc += `<div class="object-properties-controls"><table>`;
            for (let [i,prop] of Object.entries(object_properties)) {
                if (prop.type == "num") {
                    oc += `<tr data-obj-pkey="${prop.key}"><td><label for="object-property-${o.index}-${prop.key}">${prop.title}</label></td><td><input class="ui-spinner-input" id="op-${o.index}-${prop.key}" data-obj-pindex="${i}" data-type="${prop.type}" value="${prop.value}"></td>
                               </tr>`;
                }
                if (prop.type == "mat") {
                    oc += `<tr><td colspan="100">${prop.title}</td></tr><tr data-obj-pkey="${prop.key}" data-obj-pindex="${i}"><td colspan="100">${this.getSourceForTransformControls(prop.value, prop.key)}</td>`;
                }
                if (prop.type == "vec") {
                    oc += `<tr><td colspan="100">${prop.title}</td></tr><tr data-obj-pkey="${prop.key}"><td colspan="100">
                        <input class="ui-spinner-input" id="op-${o.index}-${prop.key}" data-obj-pindex="${i}" data-type="${prop.type}" data-comp="0" value="${prop.value[0]}">
                        <input class="ui-spinner-input" id="op-${o.index}-${prop.key}" data-obj-pindex="${i}" data-type="${prop.type}" data-comp="1" value="${prop.value[1]}">
                        <input class="ui-spinner-input" id="op-${o.index}-${prop.key}" data-obj-pindex="${i}" data-type="${prop.type}" data-comp="2" value="${prop.value[2]}">
                        </td></tr>`;
                }
            }
            oc += `</table></div>`;
        }
        
        
        $("#selected-object-controls").append(oc);
        
        $(".object-geometry-controls .ui-spinner-input").spinner({ step: 0.01, numberFormat: "N3" });
        $(".object-material-controls .ui-spinner-input").spinner({ step: 0.01, numberFormat: "N3" });
        
        $(`#selected-object-controls input[type="color"]`).on('input', this.modifyMaterialColor.bind(this));
        $('.object-material-controls input.ui-spinner-input[data-mc-type="intensity"]').on('spin spinstop', this.modifyMaterialColorIntensity.bind(this));
        $('.object-material-controls input.ui-spinner-input[data-mc-type="scalar"]'   ).on('spin spinstop', this.modifyMaterialScalar.bind(this));
        
        $('#geometry-type-select').on('change', (function() {
            o.changeGeometryType(Number.parseInt($('#geometry-type-select').val()));
            const selecttreenode = $.ui.fancytree.getTree("#world-objects").getNodeByKey("o" + o.ID);
            if (selecttreenode)
                selecttreenode.setTitle(WebGLGeometriesAdapter.TypeStringLabel(o.geometryIndex) + " : " + o.object.OBJECT_UID);
        }).bind(this));
        
        if (o.notTransformable)
            $("#selected-object-controls .object-geometry-controls input[data-transform-type]").spinner("disable");
        else
            $("#selected-object-controls .object-geometry-controls input[data-transform-type]").on('spin spinstop',
                this.objectTransformModified.bind(this, this.setSelectedObjectTransform.bind(this)));
        
        $("#transform-mode").selectmenu(this.transformObject ? "enable" : "disable");
        
        if (object_properties) {
            for (let [i,prop] of Object.entries(object_properties)) {
                $(`.object-properties-controls [data-obj-pkey="${prop.key}"] .ui-spinner-input`).spinner({ step: prop.step || 0.01 });
                if (prop.type == "num")
                    $(`.object-properties-controls [data-obj-pkey="${prop.key}"] .ui-spinner-input[data-obj-pindex="${i}"]`)
                        .on('spin spinstop', 
                            ((prop, e, ui) => prop.modifyFn(prop.key, (ui && ui.value !== undefined) ? ui.value : $(e.target).val())).bind(this, prop));
                else if (prop.type == "mat")
                    $(`.object-properties-controls [data-obj-pkey="${prop.key}"][data-obj-pindex="${i}"] input[data-transform-type]`)
                        .on('spin spinstop', this.objectTransformModified.bind(this, prop.modifyFn.bind(this, prop.key)));
                else if (prop.type == "vec")
                    $(`.object-properties-controls [data-obj-pkey="${prop.key}"] .ui-spinner-input[data-obj-pindex="${i}"]`)
                        .on('spin spinstop', (function(prop, e, ui) {
                            const dim = prop.value.length, tc = $(e.target).attr("data-comp");
                            const v = Vec.from(Array(dim).fill(0));
                            for (let j = 0; j < dim; ++j)
                                v[j] = (tc == j && ui && ui.value !== undefined)
                                    ? ui.value
                                    : Number.parseFloat($(`[data-obj-pkey="${prop.key}"] .ui-spinner-input[data-obj-pindex="${i}"][data-comp="${j}"]`).val()) || 0;
                            prop.modifyFn(prop.key, v);
                        }).bind(this, prop));
            }
        }
    }
    
    initializeWorldControls(adapter) {
        const fancytree = $.ui.fancytree.getTree("#world-objects");
        
        const objects_root = fancytree.getNodeByKey("_objects");
        objects_root.removeChildren();
        objects_root.addChildren(adapter.getSceneTree().children.map(o => object_transformer(o, [])));
        
        function object_transformer(o, ancestors) {
            let title = "";
            if (o.type == "primitive") title = WebGLGeometriesAdapter.TypeStringLabel(o.geometryIndex);
            else{
                if (o.type_code == WebGLWorldAdapter.WORLD_NODE_BVH_NODE_TYPE)  title = "BVH Aggregate";
                else                                                            title = "Aggregate";
                title += " (" + o.getObjectCount() + ")";
            }
            return {
                key: "o" + (o.type == "primitive" && ancestors.length ? ancestors[ancestors.length-1].ID + ":" : "") + o.ID,
                _worldobj: o,
                _worldtype: "object",
                _worldancestors: (o.type == "primitive") ? ancestors : o.ancestors,
                children: [...(o.children || []).map(c => object_transformer(c, ancestors.concat(o)))],
                title: `${title} : ${o.object.OBJECT_UID}`
            };
        }
        objects_root.setExpanded(true);
        
        const lights_root = fancytree.getNodeByKey("_lights");
        lights_root.removeChildren();
        lights_root.addChildren(adapter.getLights().map(l => {
            return {
                key: "l" + l.index,
                _worldindex: l.index,
                _worldtype: "light",
                _worldobj: l,
                title: `${WebGLGeometriesAdapter.TypeStringLabel(l.geometry)} : ${l.index}`
            };
        }));
        lights_root.setExpanded(true);
    }
    
    // Material modification/viewing functionality
    modifyMaterialColor(e) {
        const target = $(e.target);
        const id = target.attr("data-mc-id");
        const intensity = Number.parseFloat($(`input[data-mc-id="${id}"][data-mc-type="intensity"]`).val() || "1");
        const color = hexToRgb(target.val());
        this.renderer_adapter.modifyMaterialSolidColor(id, color.times(intensity));
    }
    modifyMaterialColorIntensity(e, ui) {
        const target = $(e.target);
        const id = target.attr("data-mc-id");
        const intensity = (ui && ui.value !== undefined) ? ui.value : Number.parseFloat(target.val());
        const color = hexToRgb($(`input[data-mc-id="${id}"][type="color"]`).val());
        this.renderer_adapter.modifyMaterialSolidColor(id, color.times(intensity));
    }
    modifyMaterialScalar(e, ui) {
        const target = $(e.target);
        this.renderer_adapter.modifyMaterialScalar(target.attr("data-mc-id"), (ui && ui.value !== undefined) ? ui.value : target.val());
    }
    
    
    transformMode = "translate";
    transformRotateRate = 0.001;
    transformScaleRate = 0.01;
    transformModeChange() {
        this.transformMode = $('#transform-mode').val();
    }
    transformSelectedObjectWithMouse(beforeCameraTransform, beforeCameraInvTransform) {
        let deltaTransform = Mat4.identity(), deltaInvTransform = Mat4.identity();
        if (this.lastMousePos[0] != this.nextMousePos[0] || this.lastMousePos[1] != this.nextMousePos[1]) {
            if (this.transformMode == "translate") {
                const lastPos3D = this.renderer_adapter.getRayForPixel(this.lastMousePos[0], this.lastMousePos[1]).getPoint(this.transformObject.selectDepth);
                const nextPos3D = this.renderer_adapter.getRayForPixel(this.nextMousePos[0], this.nextMousePos[1]).getPoint(this.transformObject.selectDepth);
                
                deltaTransform    = Mat4.translation(nextPos3D.minus(lastPos3D));
                deltaInvTransform = Mat4.translation(lastPos3D.minus(nextPos3D));
            }
            else if (this.transformMode == "rotate") {
                const rotateDelta = [0,1].map(i => (this.nextMousePos[i] - this.lastMousePos[i]) * this.transformRotateRate);
                const rotation = Mat4.rotation(rotateDelta[0], beforeCameraTransform.times(Vec.of(0,1,0,0)))
                          .times(Mat4.rotation(rotateDelta[1], beforeCameraTransform.times(Vec.of(1,0,0,0))));
                const center = this.transformObject.getAncestorTransform().times(this.transformObject.aabb.center);
                
                deltaTransform    = Mat4.translation(center).times(rotation             ).times(Mat4.translation(center.times(-1)));
                deltaInvTransform = Mat4.translation(center).times(rotation.transposed()).times(Mat4.translation(center.times(-1)));
            }
            else if (this.transformMode == "scale") {
                const scale = 1 + (this.nextMousePos[1] - this.lastMousePos[1]) * this.transformScaleRate;
                const center = this.transformObject.getAncestorTransform().times(this.transformObject.aabb.center);
                
                deltaTransform    = Mat4.translation(center).times(Mat4.scale(scale)    ).times(Mat4.translation(center.times(-1)));
                deltaInvTransform = Mat4.translation(center).times(Mat4.scale(1 / scale)).times(Mat4.translation(center.times(-1)));
            }
        }
        
        const new_transform     = deltaTransform.times(this.renderer_adapter.getCameraTransform().times(beforeCameraInvTransform)).times(this.transformObject.getWorldTransform()),
              new_inv_transform = this.transformObject.getWorldInvTransform().times(beforeCameraTransform.times(this.renderer_adapter.getCameraInverseTransform())).times(deltaInvTransform);

        this.setSelectedObjectTransform(new_transform, new_inv_transform);
        this.updateSelectedObjectTransformValues();
    }
    
    getSourceForTransformControls(transform, id) {
        const [pos, rot, scale] = Mat4.breakdownTransform(transform);
        return `<div><table>
                    <tr><td>Position</td><td>
                        <input class="ui-spinner-input" data-transform-type="pos" data-comp="0" data-object-id="${id}" value="${pos[0].toFixed(2)}">
                        <input class="ui-spinner-input" data-transform-type="pos" data-comp="1" data-object-id="${id}" value="${pos[1].toFixed(2)}">
                        <input class="ui-spinner-input" data-transform-type="pos" data-comp="2" data-object-id="${id}" value="${pos[2].toFixed(2)}">
                    </td></tr>
                    <tr><td>Rotation</td><td>
                        <input class="ui-spinner-input" data-transform-type="rot" data-comp="0" data-object-id="${id}" value="${(rot[0] * 180 / Math.PI).toFixed(2)}">
                        <input class="ui-spinner-input" data-transform-type="rot" data-comp="1" data-object-id="${id}" value="${(rot[1] * 180 / Math.PI).toFixed(2)}">
                        <input class="ui-spinner-input" data-transform-type="rot" data-comp="2" data-object-id="${id}" value="${(rot[2] * 180 / Math.PI).toFixed(2)}">
                    </td></tr>
                    <tr><td>Scale</td><td>
                        <input class="ui-spinner-input" data-transform-type="scale" data-comp="0" data-object-id="${id}" value="${scale[0].toFixed(2)}">
                        <input class="ui-spinner-input" data-transform-type="scale" data-comp="1" data-object-id="${id}" value="${scale[1].toFixed(2)}">
                        <input class="ui-spinner-input" data-transform-type="scale" data-comp="2" data-object-id="${id}" value="${scale[2].toFixed(2)}">
                    </td></tr>
               </table></div>`;
    }
    objectTransformModified(modifyFn, e, ui) {
        const target = $(e.target);
        const tt = target.attr("data-transform-type"), tc = target.attr("data-comp"), id = target.attr("data-object-id");
        const [pos, rot, scale] = [Vec.of(0,0,0), Vec.of(0,0,0), Vec.of(0,0,0)];
        for (let i of [0,1,2]) {
            pos[i]   = (tt == "pos" && tc == i && ui && ui.value !== undefined) ? ui.value : Number.parseFloat($(`input[data-object-id="${id}"][data-comp="${i}"][data-transform-type="pos"]`  ).val());
            scale[i] = (tt == "scale" && tc == i && ui && ui.value !== undefined) ? ui.value : Number.parseFloat($(`input[data-object-id="${id}"][data-comp="${i}"][data-transform-type="scale"]`).val());
            rot[i]   = (tt == "rot" && tc == i && ui && ui.value !== undefined) ? ui.value : Number.parseFloat($(`input[data-object-id="${id}"][data-comp="${i}"][data-transform-type="rot"]`  ).val()) * Math.PI / 180;
        }
        modifyFn(...Mat4.transformAndInverseFromParts(pos, rot, scale));
    }
    
    updateSelectedObjectTransformValues() {
        if (!this.selectedObject)
            return;
        const [pos, rot, scale] = Mat4.breakdownTransform(this.selectedObject.getWorldTransform());
        for (let i of [0,1,2]) {
            $(`input[data-object-id="${this.selectedObject.index}"][data-comp="${i}"][data-transform-type="pos"]`  ).val(pos[i].toFixed(2));
            $(`input[data-object-id="${this.selectedObject.index}"][data-comp="${i}"][data-transform-type="scale"]`).val(scale[i].toFixed(2));
            $(`input[data-object-id="${this.selectedObject.index}"][data-comp="${i}"][data-transform-type="rot"]`  ).val((rot[i] * 180 / Math.PI).toFixed(2));
        }
    }
    
    setSelectedObjectTransform(transform, inv_transform) {
        if (!this.selectedObject || !this.transformObject)
            return;
        this.transformObject.setWorldTransform(transform, inv_transform);
        if (this.transformObject !== this.selectedObject)
            this.transformObject.aabb = this.transformObject.getBoundingBox();
        this.selectedObject.aabb = this.selectedObject.getBoundingBox();
    }
    
    
    
    
        
    keySpeed = 3.0;
    mouseSpeed = 0.0013;
    handleMovement(timeDelta) {
        const beforeCameraTransform    = this.renderer_adapter.getCameraTransform(),
              beforeCameraInvTransform = this.renderer_adapter.getCameraInverseTransform();
        
        const mouseMoveDelta = (this.transformObject && this.transformObject.isBeingTransformed) ? [0,0] : [0,1].map(i => this.nextMousePos[i] - this.lastMousePos[i]);
        if (timeDelta > 0 && (mouseMoveDelta.some(x => (x != 0)) || this.keyMoveDelta.some(x => (x != 0)))) {
            const normalizedMouseDelta = Vec.from(mouseMoveDelta.map(     v => this.mouseSpeed * v));
            const normalizedKeyDelta   = Vec.from(this.keyMoveDelta.map(  v => this.keySpeed   * v * timeDelta / 1000));
            
            this.renderer_adapter.moveCamera(normalizedMouseDelta, normalizedKeyDelta);
            this.updateCameraTransformValues();
        }
        
        if ((this.transformObject && this.transformObject.isBeingTransformed))
            this.transformSelectedObjectWithMouse(beforeCameraTransform, beforeCameraInvTransform);
        
        this.lastMousePos = this.nextMousePos;
    }
    updateCameraTransformValues() {
        if (!this.renderer_adapter)
            return;
        const [pos, rot, scale] = Mat4.breakdownTransform(this.renderer_adapter.getCameraTransform());
        for (let i of [0,1,2]) {
            $(`input.camera-transform[data-transform-type="pos${i}"]`  ).val(pos[i].toFixed(2));
            $(`input.camera-transform[data-transform-type="scale${i}"]`).val(scale[i].toFixed(2));
            $(`input.camera-transform[data-transform-type="rot${i}"]`  ).val((rot[i] * 180 / Math.PI).toFixed(2));
        }
    }
    modifyCameraTransformValues() {
        if (!this.renderer_adapter)
            return;
        const [pos, rot, scale] = [Vec.of(0,0,0), Vec.of(0,0,0), Vec.of(0,0,0)];
        for (let i of [0,1,2]) {
            pos[i]   = Number.parseFloat($(`input.camera-transform[data-transform-type="pos${i}"]`  ).val());
            scale[i] = Number.parseFloat($(`input.camera-transform[data-transform-type="scale${i}"]`).val());
            rot[i]   = Number.parseFloat($(`input.camera-transform[data-transform-type="rot${i}"]`  ).val()) * Math.PI / 180;
        }
        this.renderer_adapter.setCameraTransform(...Mat4.transformAndInverseFromParts(pos, rot, scale));
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
    keyTransformModeMap = {
        "e": "scale",
        "r": "rotate",
        "t": "translate"
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
        if (e.key in this.keyTransformModeMap) {
            $('#transform-mode').val(this.keyTransformModeMap[e.key]);
            $('#transform-mode').selectmenu("refresh");
            this.transformModeChange();
        }
        else if (e.key in this.keyDirMap) {
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
        if (e.target.hasPointerCapture(e.pointerID))
            e.target.releasePointerCapture(e.pointerID);
        this.hasMouseMoved = false;
        this.isMouseDown = true;
        if (this.renderer_adapter) {
            const rect = e.target.getBoundingClientRect();
            const mousePos = [event.clientX - rect.left, event.clientY - rect.top];
            if (this.transformObject) {
                const ray = this.renderer_adapter.getRayForPixel(mousePos[0], mousePos[1]).getTransformed(this.transformObject.getAncestorInvTransform());
                this.transformObject.selectDepth = this.transformObject.aabb.isFinite()
                    ? this.transformObject.aabb.intersect(ray) : this.transformObject.intersect(ray).distance;
                this.transformObject.isBeingTransformed = this.transformObject.selectDepth > 0 && !this.transformObject.notTransformable;
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
        if (this.transformObject) {
            if (this.transformObject.isBeingTransformed)
                this.lastMousePos = this.nextMousePos;
            this.transformObject.isBeingTransformed = false;
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