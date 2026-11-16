class UIProperties {
    static fillTemplate(src, props) {
        const props_filled = {};
        if (!src)
            return src;
        
        // Each ${expression} is evaluated with the properties as arguments. (Passing them through JSON.stringify, as
        // this used to, turned Infinity and NaN into null: an infinite box SDF showed its size as null.)
        const block_matches = src.matchAll(/\$\{([^\}]*)\}/g);
        if (block_matches)
            for (const block_match of [...block_matches])
                src = src.replace(block_match[0], Function(...Object.keys(props), "return " + block_match[1])(...Object.values(props)));
    
        const var_matches = src.matchAll(/\$(\w+)\b/g);
        if (var_matches) {
            for (const prop_to_fill of [...var_matches]) {
                if (!props_filled[prop_to_fill[1]]) {
                    if (!(prop_to_fill[1] in props))
                        throw "Attempt to use unavailable property from template: " + prop_to_fill[1];
                    src = src.replaceAll(prop_to_fill[0], props[prop_to_fill[1]]);
                    props_filled[prop_to_fill[1]] = true;
                }
            }
        }
        return src;
    }

    static listeners = {
        bool:         { e: 'input',                          c: UIProperties.boolPropertyChanged },
        select:       { e: 'change selectmenuchange',        c: UIProperties.selectPropertyChanged },
        number:       { e: 'spin spinstop input',            c: UIProperties.numberPropertyChanged },
        vec:          { e: 'spin spinstop input',            c: UIProperties.vecPropertyChanged },
        mat:          { e: 'spin spinstop input',            c: UIProperties.matPropertyChanged },
        color:        { e: 'spin spinstop spinchange input', c: UIProperties.colorPropertyChanged },
        checkerboard: { e: 'spin spinstop spinchange input', c: UIProperties.colorPropertyChanged },
    };
    static listenToControls(root, name, prop, callback) {
        if (prop.type in UIProperties.listeners) {
            const l = UIProperties.listeners[prop.type];
            const input = root.find(`[data-field-name="${name}"]`);
            if (!input || input.length == 0)
                throw `No valid inputs found to listen to for property ${name}`;
            input.on(l.e, l.c.bind(null, name, prop, callback));
            
            const output = root.find(`output[for="${name}"]`);
            if (output && output.length)
                input.on(l.e, l.c.bind(null, name, prop, function(n, p, t, value) { output.text(value.toFixed(2)); }));
        }
        else
            throw "Unable to automatically handle listening to property type " + prop.type;
    }
    static fillPropertyControls(root, props, callback) {
        const insertion_point = root.find(".template-insertion-point");
        if (!insertion_point || insertion_point.length == 0)
            throw "No valid insertion point found to fill property controls";
        insertion_point.empty();
        for (const [name, raw_prop] of Object.entries(props)) {
            const template = root.find(`.template-holder script[data-template-type="${raw_prop.type}"]`);
            if (!template || template.length==0)
                throw "Unable to find appropriate template for property type " + raw_prop.type;
            
            const prop = Object.assign({}, raw_prop, {name: name});
            if (prop.type == "mat") {
                [prop.pos, prop.rot, prop.scale] = Mat4.breakdownTransform(prop.value);
                prop.rot = prop.rot.times(180 / Math.PI);
            }
            insertion_point.append(UIProperties.fillTemplate(template.html(), prop));
        }

        (insertion_point.hasClass("control-group") ? insertion_point : insertion_point.parents(".control-group")).controlgroup("refresh");
        
        for (const [name, prop] of Object.entries(props))
            UIProperties.listenToControls(root, name, prop, callback);
    }
    
    static selectPropertyChanged(name, prop, callback, e, ui) {
        callback(name, prop, $(e.target), $(e.target).val());
    }
    static boolPropertyChanged(name, prop, callback, e, ui) {
        callback(name, prop, $(e.target), e.target.checked);
    }
    static numberPropertyChanged(name, prop, callback, e, ui) {
        const target = $(e.target);
        const v = (ui && ui.value !== undefined) ? ui.value : target.val();
        callback(name, prop, target, Number.parseFloat(v));
    }
    static vecPropertyChanged(name, prop, callback, e, ui) {
        const target = $(e.target);
        const dim = prop.value.length, tc = target.attr("data-comp");
        const v = Vec.from(Array(dim).fill(0));
        for (let j = 0; j < dim; ++j)
            v[j] = (tc == j && ui && ui.value !== undefined)
                ? ui.value
                : Number.parseFloat(target.parents("tr").find(`input[data-comp="${j}"]`).val()) || 0;
        callback(name, prop, target, v);
    }
    static matPropertyChanged(name, prop, callback, e, ui) {
        const target = $(e.target);
        const tt = target.attr("data-transform-type"), tc = target.attr("data-transform-comp"), root = target.parents(".transform-table");
        const vals = {pos: Vec.of(0,0,0), scale: Vec.of(0,0,0), rot: Vec.of(0,0,0)};
        for (let i of [0,1,2]) {
            for (let k of ["pos", "scale", "rot"]) {
                vals[k][i] = (tt == k && tc == i && ui && ui.value !== undefined) ? ui.value
                    : Number.parseFloat(root.find(`input[data-transform-comp="${i}"][data-transform-type="${k}"]`).val());
            }
        }
        callback(name, prop, target, ...Mat4.transformAndInverseFromParts(vals.pos, vals.rot.times(Math.PI / 180), vals.scale));
    }
    static updateTransformInputs(root, transform) {
        const [pos, rot, scale] = Mat4.breakdownTransform(transform);
        for (const [type, val] of Object.entries({ pos: pos, rot: rot.times(180 / Math.PI), scale: scale }))
            for (let i of [0,1,2])
                root.find(`input[data-transform-comp="${i}"][data-transform-type="${type}"]`).val(val[i].toFixed(2));
    }
    static colorPropertyChanged(name, prop, callback, e, ui) {
        const target = $(e.target);
        const type = target.attr("data-mc-type");
        const intensity = Number.parseFloat((type == "intensity" && ui && ui.value) ? ui.value : target.parents("tr").find(`input[data-mc-type="intensity"]`).val());
        const color = hexToRgb(type == "color" ? target.val() : target.parents("tr").find(`input[data-mc-type="color"]`).val());
        callback(name, prop, target, color.times(intensity));
    }
}


class WebGLEditorInterface {
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
        
        
        this.samplesPerDraw = 1;
        
        $(".control-group").controlgroup();
        $("#renderer-controlgroup").controlgroup({ direction: "vertical" });
        
        $('#object-control-bar').controlgroup("disable");
        $("#transform-mode").selectmenu({ change: this.transformModeChange.bind(this), width: 'auto' });
            
        $("#selected-object-controls").dialog({ autoOpen: false, title: "Selected Object", minWidth: 400, maxHeight: 800 });
        $("#edit-object-button").on("click", function() { $("#selected-object-controls").dialog("open"); }.bind(this));
        
        $("#deselect-object-button").on("click", function() { this.selectObject(null); }.bind(this));
        $("#delete-object-button").on("click", function() { this.deleteSelectedObject(); }.bind(this));
        $("#delete-object-button").button({ icon: "ui-icon-trash", showLabel: false });
        $("#add-object-type").selectmenu({ width: 'auto' });
        $("#add-object-button").on("click", function() { this.addObject($("#add-object-type").val()); }.bind(this));
        $("#world-edit-bar").controlgroup("disable");
        $("#add-light-type").selectmenu({ width: 'auto' });
        $("#add-light-button").on("click", () => this.addObject($("#add-light-type").val()));
        $("#light-edit-bar").controlgroup("disable");
        this.initializeMaterialControls();
        $("#render-toggle-button").button({ icon: "ui-icon-pause", disabled: true })
            .on("click", () => this.renderingPaused ? this.resumeRendering() : this.pauseRendering());
        $("#deselect-object-button").button({ icon: "ui-icon-closethick", showLabel: false });
        
        
        // The World tree. Each heading has a + button that adds one of its kind (see openTreeAddMenu).
        const heading = (title, kind) => `${title}<button class="tree-add" data-add-kind="${kind}" title="Add">+</button>`;
        $("#world-objects").fancytree({
            source: [
                { title: heading("Objects",   "objects"),   key: "_objects",   folder: true, clickFolderMode: 2 },
                { title: heading("Lights",    "lights"),    key: "_lights",    folder: true, clickFolderMode: 2 },
                { title: heading("Materials", "materials"), key: "_materials", folder: true, clickFolderMode: 2 }
            ],
            activate: this.selectObjectTree.bind(this),
            click: (e, d) => {
                const button = $(e.originalEvent && e.originalEvent.target).closest(".tree-add");
                if (!button.length)
                    return true;
                this.openTreeAddMenu(button, button.attr("data-add-kind"));
                return false;
            }
        });
        $("#tree-add-menu").menu({ select: (e, ui) => {
            $("#tree-add-menu").hide();
            const value = ui.item.attr("data-value"), kind = $("#tree-add-menu").attr("data-kind");
            if (kind == "materials")
                this.addLibraryMaterial(value);
            else
                this.addObject(value);
        }});
        $(document).on("mousedown", e => {
            if (!$(e.target).closest("#tree-add-menu, .tree-add").length)
                $("#tree-add-menu").hide();
        });

        // Editing an SDF's structure (see WebGLSDFEditor and editSDFStructure).
        const options = o => Object.entries(o).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
        $("#sdf-add-type, #sdf-replace-type").html(options(WebGLSDFEditor.PRIMITIVES));
        $("#sdf-wrap-type").html(options(WebGLSDFEditor.WRAPPERS));
        $("#sdf-tree").fancytree({ source: [], activate: (e, d) => this.selectSDFNode(d.node.data._sdf) });
        $("#sdf-add").on("click",     () => this.editSDFStructure(WebGLSDFEditor.addChild, $("#sdf-add-type").val()));
        $("#sdf-wrap").on("click",    () => this.editSDFStructure(WebGLSDFEditor.wrap,     $("#sdf-wrap-type").val()));
        $("#sdf-replace").on("click", () => this.editSDFStructure(WebGLSDFEditor.replace,  $("#sdf-replace-type").val()));
        $("#sdf-unwrap").on("click",  () => this.editSDFStructure(WebGLSDFEditor.unwrap));
        $("#sdf-delete").on("click",  () => this.editSDFStructure(WebGLSDFEditor.remove));

        $("#geometry-type-select").append(
            WebGLGeometriesAdapter.SWITCHABLE_TYPES.map(t => `<option value="${t}" data-type="normal">${WebGLGeometriesAdapter.TypeStringLabel(t)}</option>`).join("\n"));
        UIProperties.listenToControls($("#object-transform"), "object-transform", { type: "mat" }, (function(name, prop, target, trans, inv_trans) {
            this.setSelectedObjectTransform(trans, inv_trans);
        }).bind(this));
        
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
    // beforeControls(adapter), if given, runs once the new adapter is built, before the controls are filled in.
    changeTest(test, beforeControls=null) {
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

            WebGLRendererAdapter.build(this.gl, this.canvas.get(0), test.renderer, function(adapter) {
                this.renderer_adapter = adapter;
                if (beforeControls)
                    beforeControls(adapter);
                
                // Set the initial values for the controls
                this.initializeRendererControls(adapter);
                this.initializeCameraControls(adapter);
                this.initializeWorldControls(adapter);
                $("#world-edit-bar").controlgroup("enable");
                $("#light-edit-bar").controlgroup("enable");
                
                this.startDrawLoop();

                $(".loading").css('visibility', 'hidden');
            }.bind(this));
        } catch(error) {
            myconsole.error(error);
            $(".loading").css('visibility', 'hidden');
        }
    }
    startDrawLoop() {
        if (this.renderer_adapter) {
                this.mouseMoveDelta = [0,0];
                
                myconsole.log("Starting draw world loop...");
                this.animation_request_id = window.requestAnimationFrame(this.draw.bind(this));
        }
        // Starting the loop for any reason (a scene loading, say) ends a pause.
        this.setRenderingPaused(false);
    }
    // The Stop rendering button: stops drawing samples without unloading anything, so the GPU goes idle and the
    // image, the camera and the selection all stay as they are. Resuming carries on accumulating samples.
    renderingPaused = false;
    pauseRendering() {
        if (!this.animation_request_id)
            return;
        window.cancelAnimationFrame(this.animation_request_id);
        this.animation_request_id = null;
        this.lastDrawTimestamp = null;
        this.setRenderingPaused(true);
        $('#fps-display').text(this.renderer_adapter.drawCount + " samples (stopped)");
    }
    resumeRendering() {
        if (!this.animation_request_id)
            this.startDrawLoop();
    }
    setRenderingPaused(paused) {
        this.renderingPaused = paused;
        $("#render-toggle-button").button("option", {
            label: paused ? "Resume rendering" : "Stop rendering",
            icon: paused ? "ui-icon-play" : "ui-icon-pause",
            disabled: !this.renderer_adapter
        });
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
    
    
    // Switches to or from the editable shader (?worldEditable=true) by rebuilding the renderer around the same scene
    // and camera. Both hold every edit made so far (the adapters write edits back into them), so nothing is lost;
    // display settings carry over too. Takes as long as loading the scene's shader does.
    setWorldEditable(editable) {
        const ra = this.renderer_adapter;
        editable = !!editable;
        if (!ra || !!ra.adapters.world.WORLD_EDITABLE == editable)
            return;
        WebGLRendererAdapter.worldEditable = editable;
        const url = new URL(window.location.href);
        if (editable)
            url.searchParams.set("worldEditable", "true");
        else
            url.searchParams.delete("worldEditable");
        window.history.replaceState(window.history.state, "", url);

        const settings = ra.getMutableRendererParameters(), samples = this.samplesPerDraw;
        this.stopDrawLoop();
        $(".loading").css('visibility', 'visible');
        myconsole.log(`Switching to the ${editable ? "editable" : "scene-specific"} shader...`);
        this.changeTest({ renderer: ra.renderer, width: ra.canvas.width, height: ra.canvas.height }, adapter => {
            for (const [name, p] of Object.entries(settings))
                if (!["canvasWidth", "canvasHeight", "worldEditable"].includes(name))
                    adapter.rendererParameterModified(name, p.value);
            $("#samples-per-draw").val(this.samplesPerDraw = samples);
        });
    }
    initializeRendererControls(renderer_adapter) {
        UIProperties.fillPropertyControls($('#renderer-controls'), renderer_adapter.getMutableRendererParameters(),  (function(name, prop, target, value) {
            if (name == "worldEditable")
                return this.setWorldEditable(value);
            if (this.renderer_adapter)
                this.renderer_adapter.rendererParameterModified(name, value);
            this.refreshPausedView();
        }).bind(this));
    }
    initializeCameraControls(renderer_adapter) {
        const params = Object.assign({}, renderer_adapter.getMutableCameraParameters());
        params.FOV.value != -1;
        if (params.focus_distance.value == 1)
            params.focus_distance.value = renderer_adapter.getCameraPosition().minus(
                renderer_adapter.adapters.world.world.getFiniteBoundingBox().center).norm();
        UIProperties.fillPropertyControls($("#camera-controls"), params, (function(name, prop, target, ...value) {
            if (this.renderer_adapter)
                this.renderer_adapter.cameraParameterModified(name, ...value);
        }).bind(this));
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

            // A WebGL canvas only holds its image until the frame is shown, so captures happen right after drawing.
            if (this.pendingCaptures.length) {
                const captures = this.pendingCaptures;
                this.pendingCaptures = [];
                for (const [resolve, type, quality] of captures)
                    this.canvas.get(0).toBlob(resolve, type, quality);
            }
            
            this.drawSelectionWireframes();
            
            // Request another frame of animation.
            this.animation_request_id = window.requestAnimationFrame(this.draw.bind(this));
        }
        
        // reset all intermediary input/timing variables
        this.lastDrawTimestamp = currentTimestamp;
    }
    // Resolves with an image of the canvas (a PNG, or e.g. "image/jpeg" with a quality from 0 to 1) as the next frame
    // draws it, before any selection wireframe.
    pendingCaptures = [];
    captureImage(type="image/png", quality=undefined) {
        return new Promise(resolve => this.pendingCaptures.push([resolve, type, quality]));
    }
    // If any object is selected, draw its wireframe.
    drawSelectionWireframes() {
        // A directional light is drawn where the camera sees it, so its box moves with the camera.
        const ra = this.renderer_adapter;
        for (const o of [this.transformObject, this.selectedObject])
            if (o && o.object instanceof DirectionalLight && ra)
                o.aabb = o.getBoundingBox(ra.getCameraPosition());
        if (this.transformObject)
            this.drawWireframe(this.transformObject.getAncestorTransform(), this.transformObject.aabb, this.transformObject.isBeingTransformed ? Vec.of(0,0,1,1) : Vec.of(1,1,1,1));
        if (this.selectedObject && this.transformObject !== this.selectedObject)
            this.drawWireframe(this.selectedObject.getAncestorTransform(), this.selectedObject.aabb, Vec.of(1,0,0,1));
    }
    // While rendering is stopped nothing redraws the canvas, so changes to what it shows without new samples (the
    // selection, display settings such as exposure or denoising) redraw it here.
    refreshPausedView() {
        if (!this.renderingPaused || !this.renderer_adapter)
            return;
        this.renderer_adapter.redisplay();
        this.drawSelectionWireframes();
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
        if (selectedObject && this.selectedMaterial) {
            this.selectedMaterial = null;
            this.showObjectSections(true);
        }
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
            if (activeNode && !activeNode.data._material)
                activeNode.setActive(false);
            $('#object-control-bar').controlgroup("disable");
            //$("#selected-object-controls").empty();
        }
        this.refreshPausedView();
    }
    selectObjectTree(e, d) {
        if (d.node.data._material)
            return this.selectMaterial(d.node.data._material);
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

        // First, deal with the geometry type selection control.
        const gid = o.geometryIndex;
        const geometry_select = $("#geometry-type-select");
        if (WebGLGeometriesAdapter.SWITCHABLE_TYPES.indexOf(gid) >= 0) {
            geometry_select.find('option[data-type="unusual"]').hide();
            geometry_select.val(gid);
            geometry_select.prop('disabled', false);
        }
        else {
            geometry_select.find('option[data-type="unusual"]').show();
            if (WebGLGeometriesAdapter.isTypeSDF(gid))      geometry_select.val("SDF");
            if (WebGLGeometriesAdapter.isTypeTriangle(gid)) geometry_select.val("triangle");
            geometry_select.prop('disabled', true);
        }
        $('#geometry-type-select').off('change').on('change', (function() {
            o.changeGeometryType(Number.parseInt(geometry_select.val()));
            const selecttreenode = $.ui.fancytree.getTree("#world-objects").getNodeByKey("o" + o.ID);
            if (selecttreenode)
                selecttreenode.setTitle(WebGLGeometriesAdapter.TypeStringLabel(o.geometryIndex) + " : " + o.object.OBJECT_UID);
        }).bind(this));

        
        // Second, fill in the transform values, and disable if the object is not transformable.
        UIProperties.updateTransformInputs($("#object-transform"), o.getTransform());
        $("#object-transform").find("input").spinner(o.notTransformable ? "disable" : "enable");

        // Similarly, disable the transformable type menu if the object is not transformable.
        $("#transform-mode").selectmenu(this.transformObject ? "enable" : "disable");
        
        // Third, fill in the material property controls.
        this.fillMaterialProperties(o.getMaterialValues());
        this.fillMaterialControls();

        
        // Fourth, fill in the object property controls (usually only used for SDFs). An SDF gets its tree, with the
        // selected node's properties.
        if (this.buildSDFControls())
            return;
        const object_properties = o.worldtype == "light" ? this.lightObjectProperties(o)
            : (o.getMutableObjectProperties && o.getMutableObjectProperties()) || {};
        UIProperties.fillPropertyControls($("#object-properties"), object_properties, (function(name, prop, target, ...value) {
            prop.modifyFn(prop.key, ...value);
        }).bind(this));
    }

    // ---- A light's own properties ----
    lightObjectProperties(o) {
        return {
            "light-directional": {
                type: "bool", key: "directional", title: "Directional",
                tooltip: "Moves with whoever looks at it (the point being lit, or a ray's origin), like the sun",
                value: o.object instanceof DirectionalLight,
                modifyFn: (key, value) => this.setLightDirectional(o, value)
            }
        };
    }
    // Swaps a light between directional (placed relative to the observer, see DirectionalLight) and fixed in the
    // world, keeping it where the camera sees it now: a world light at p becomes a directional light offset by
    // p - camera, and back. The light keeps its shape, color, power and samples, so from the camera it looks the same.
    setLightDirectional(o, directional) {
        const ra = this.renderer_adapter, light = o.object;
        if (!ra || ra.rebuildingShaders || (light instanceof DirectionalLight) == directional)
            return;
        // Work in the light's parent space, which its own transform is relative to.
        const ancestors = o.instance.ancestors;
        const cam = o.instance.getAncestorInvTransform().times(ra.getCameraPosition());
        const T = light.getTransform();
        let replacement;
        if (directional) {
            const geometry = light instanceof RandomSampleAreaLight ? light.surface_geometry : new OriginPoint();
            replacement = new DirectionalLight(geometry, Mat4.translation(cam.to3().times(-1)).times(T), Vec.of(1, 1, 1), 1, light.samples || 1);
        }
        else if (light.isPoint)
            replacement = new SimplePointLight(T.column(3).plus(cam.to4(0)), Vec.of(1, 1, 1));
        else
            replacement = new RandomSampleAreaLight(light.surface_geometry, Mat4.translation(cam.to3()).times(T), Vec.of(1, 1, 1), 1, light.samples);
        replacement.color_mc = light.color_mc;

        // Put it where the light was.
        const parent = ancestors.length ? ancestors[ancestors.length - 1] : null;
        if (parent instanceof TransformedWorldObject)
            parent.object = replacement;
        else {
            const list = parent ? parent.objects : ra.renderer.world.objects, i = list.indexOf(light);
            if (i < 0) {
                myconsole.error("Could not find the light in its parent.");
                return;
            }
            list[i] = replacement;
        }
        for (const a of ancestors)
            a.contentsChanged();
        this.rebuildWorld(replacement);
    }
    
    // ---- Editing an SDF's structure ----
    // The selected object's SDF tree is shown above its properties. Selecting a node there shows that node's
    // properties; the buttons under it change the tree (WebGLSDFEditor) and then rebuild the renderer from the scene,
    // which means a recompile, since an SDF's structure is part of the shader.
    selectedSDFNode = null;
    selectedSDFGeometry() {
        const o = this.selectedObject;
        return (o && o.object && o.object.geometry instanceof SDFGeometry) ? o.object.geometry : null;
    }
    buildSDFControls() {
        const g = this.selectedSDFGeometry();
        $("#sdf-structure").toggle(!!g);
        if (!g)
            return false;
        if (!this.selectedSDFNode || (this.selectedSDFNode !== g.root_sdf && !SDF.findParent(g.root_sdf, this.selectedSDFNode)))
            this.selectedSDFNode = g.root_sdf;
        const tree = $.ui.fancytree.getTree("#sdf-tree"), selected = this.selectedSDFNode;
        Promise.resolve(tree.reload([WebGLSDFEditor.treeSource(g.root_sdf)])).then(() => {
            const tree_node = tree.getNodeByKey("sdf" + selected.UID);
            if (tree_node)
                tree_node.setActive(true, { noEvents: true });
        });
        this.fillSDFNodeControls();
        return true;
    }
    selectSDFNode(node) {
        this.selectedSDFNode = node;
        this.fillSDFNodeControls();
    }
    fillSDFNodeControls() {
        const g = this.selectedSDFGeometry(), node = this.selectedSDFNode, ra = this.renderer_adapter;
        if (!g || !node || !ra)
            return;
        for (const [id, can] of [["#sdf-add",     WebGLSDFEditor.canAddChild(g, node)],
                                 ["#sdf-replace", WebGLSDFEditor.canReplace(g, node)],
                                 ["#sdf-unwrap",  WebGLSDFEditor.canUnwrap(g, node)],
                                 ["#sdf-delete",  WebGLSDFEditor.canDelete(g, node)]])
            $(id).prop("disabled", !can);
        const sdf_adapter = ra.adapters.world.adapters.geometries.sdf_adapter;
        const index = sdf_adapter.geometries.indexOf(g);
        if (index < 0)
            return;
        UIProperties.fillPropertyControls($("#object-properties"), sdf_adapter.getMutableObjectProperties(index, ra, node),
            (name, prop, target, ...value) => prop.modifyFn(prop.key, ...value));
    }
    editSDFStructure(edit, kind) {
        const g = this.selectedSDFGeometry(), ra = this.renderer_adapter;
        if (!g || !this.selectedSDFNode || !ra || ra.rebuildingShaders)
            return;
        this.selectedSDFNode = edit(g, this.selectedSDFNode, kind) || g.root_sdf;
        myconsole.log("Rebuilding the shader for the SDF's new structure...");
        this.rebuildWorld(this.selectedObject.object);
    }

    // ---- Adding and removing objects ----
    // Structural edits change the CPU world (src/), then ask the renderer to rebuild its data from it
    // (WebGLRendererAdapter.worldModified). With the editable shader (?worldEditable=true) that takes milliseconds;
    // with the regular shader it means a recompile.
    static defaultMaterial() {
        return new PhongMaterial(Vec.of(0.8, 0.8, 0.8), 0.1, 0.6, 0.3, 50, 0.1);
    }
    addObject(kind) {
        const ra = this.renderer_adapter;
        if (!ra || ra.rebuildingShaders)
            return;
        const world = ra.renderer.world;

        // Place the new object in front of the camera, at roughly the distance of the scene, sized to match.
        const box = world.getFiniteBoundingBox();
        const distance = Math.min(50, Math.max(1, box.isFinite() ? ra.getCameraPosition().minus(box.center).norm() : 5));
        const size = 0.15 * distance;
        const position = ra.getCameraTransform().times(Vec.of(0, 0, -distance, 1));
        const T = Mat4.translation(position.to3());
        const facingCamera = ra.getCameraTransform().times(Mat4.translation(Vec.of(0, 0, -distance)));
        const brightness = 4 * Math.PI * distance * distance;   // about unit irradiance at the scene

        let obj = null;
        switch (kind) {
            case "sphere":      obj = new Primitive(new Sphere(),   WebGLEditorInterface.defaultMaterial(), T.times(Mat4.scale(size)));     break;
            case "box":         obj = new Primitive(new UnitBox(),  WebGLEditorInterface.defaultMaterial(), T.times(Mat4.scale(size)));     break;
            case "cylinder":    obj = new Primitive(new Cylinder(), WebGLEditorInterface.defaultMaterial(), T.times(Mat4.scale(size)));     break;
            case "square":      obj = new Primitive(new Square(),   WebGLEditorInterface.defaultMaterial(), facingCamera.times(Mat4.scale(2 * size))); break;
            case "circle":      obj = new Primitive(new Circle(),   WebGLEditorInterface.defaultMaterial(), facingCamera.times(Mat4.scale(size)));     break;
            case "sdf":         obj = new Primitive(new SDFGeometry(new SphereSDF(1), 300, 1e-4, 100),
                                    WebGLEditorInterface.defaultMaterial(), T.times(Mat4.scale(size)));      break;
            case "plane":       obj = new Primitive(new Plane(),    WebGLEditorInterface.defaultMaterial(),
                                    Mat4.translation([0, box.isFinite() ? box.min[1] : 0, 0]).times(Mat4.rotation(Math.PI / 2, Vec.of(1, 0, 0)))); break;
            case "point-light": obj = new SimplePointLight(position, Vec.of(1, 1, 1), brightness);                                      break;
            case "area-light":  obj = new RandomSampleAreaLight(new Square(), facingCamera.times(Mat4.scale(2 * size)), Vec.of(1, 1, 1), brightness); break;
            case "directional-light": {
                // A disc ahead of the camera, up and to the right (so it's in view, drawn relative to the camera),
                // facing back at whoever sees it (the observer is at its origin), at the scene's distance; it
                // subtends about 6 degrees, enough to show soft shadows.
                const toLight = ra.getCameraTransform().times(Vec.of(0.3, 0.35, -1, 0)).to3().normalized();
                const offset = toLight.times(distance);
                const z = toLight.times(-1), x = (Math.abs(z[1]) < 0.9 ? Vec.of(0, 1, 0) : Vec.of(1, 0, 0)).cross(z).normalized(), y = z.cross(x);
                const orient = Mat.of([x[0], y[0], z[0], offset[0]], [x[1], y[1], z[1], offset[1]], [x[2], y[2], z[2], offset[2]], [0, 0, 0, 1]);
                // Same power as the other lights' defaults (about unit irradiance), as an area light: Phi / (2 pi d^2).
                obj = new DirectionalLight(new Circle(), orient.times(Mat4.scale(0.05 * distance)), Vec.of(1, 1, 1), 2 * Math.PI * distance * distance);
                break;
            }
            default: return;
        }
        world.objects.push(obj);
        this.rebuildWorld(obj);
    }
    // Removes the selected object from the aggregate it sits in. A primitive that can't be moved on its own (one
    // inside a BVH) takes its whole BVH with it, the same object the transform tools act on.
    deleteSelectedObject() {
        const ra = this.renderer_adapter;
        if (!ra || ra.rebuildingShaders || !this.selectedObject)
            return;
        const world = ra.renderer.world;
        let target = this.selectedObject.worldtype == "light" ? this.selectedObject : (this.transformObject || this.selectedObject);

        // The CPU objects to remove, and the chain of CPU containers above it (outermost first).
        let obj, containers;
        if (target.worldtype == "light") {
            obj = target.light;
            containers = target.instance.ancestors.slice();
        }
        else {
            obj = target.object.lightEmitterFor || target.object;
            // The adapter's root aggregate stands for world.objects; it appears in some ancestor lists (objects
            // picked from the tree) and not others (objects picked in the view).
            const root = ra.adapters.world.aggregates[0];
            containers = target.ancestors.filter(a => a !== root).map(a => a.object);
        }
        // Can't take a single object out of a built BVH, or out of a TransformedWorldObject: go up a level instead.
        while (containers.length && (containers[containers.length - 1] instanceof BVHAggregate
                                  || containers[containers.length - 1] instanceof TransformedWorldObject))
            obj = containers.pop();

        const list = containers.length ? containers[containers.length - 1].objects : world.objects;
        const i = list.indexOf(obj);
        if (i < 0) {
            myconsole.error("Could not find the selected object in its parent.");
            return;
        }
        list.splice(i, 1);
        for (const c of containers)
            c.contentsChanged();
        this.selectObject(null);
        this.rebuildWorld(null);
    }
    rebuildWorld(selectAfter) {
        const ra = this.renderer_adapter;
        this.selectObject(null);
        ra.worldModified(() => {
            this.initializeWorldControls(ra);
            if (!selectAfter)
                return;
            try {
                const wa = ra.adapters.world;
                if (selectAfter instanceof Material)
                    this.selectMaterial(selectAfter);
                else if (selectAfter instanceof Light)
                    this.selectObject(ra.getLights().find(l => l.light === selectAfter) || null);
                else if (selectAfter.OBJECT_UID in wa.primitive_id_index_map)
                    this.selectObject(wa.primitives[wa.primitive_id_index_map[selectAfter.OBJECT_UID]].toInstance([]));
            } catch (e) {
                this.selectObject(null);
            }
        });
    }

    // ---- Managing materials (see WebGLMaterialEditor) ----
    // The material panel shows either the selected object's material, or a material picked from the World tree's
    // Materials list (this.selectedMaterial, when no object is selected). Its controls choose, name, copy, add and
    // delete materials. Assigning a material changes primitives' .material in the scene, then rebuilds the renderer:
    // immediate with the editable shader, a recompile with the regular one, as material indices are compiled in.
    selectedMaterial = null;
    initializeMaterialControls() {
        $("#material-new-type").html(Object.entries(WebGLMaterialEditor.TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join(""));
        $("#material-unique, #material-new, #material-delete").button();
        $("#material-select").on("change", () => {
            const ctx = this.materialContext(), chosen = this.materialChoices && this.materialChoices.get(Number($("#material-select").val()));
            if (!ctx || !chosen || chosen === ctx.material)
                return;
            if (!ctx.scope)
                return this.selectMaterial(chosen);
            const n = WebGLMaterialEditor.assign(this.renderer_adapter.renderer.world, ctx.scope, ctx.material, chosen);
            myconsole.log(`Assigned ${WebGLMaterialEditor.label(chosen)} to ${n} primitive(s).`);
            this.materialEdited(chosen);
        });
        $("#material-name").on("change", () => {
            const ctx = this.materialContext();
            if (!ctx)
                return;
            const name = $("#material-name").val().trim();
            if (name)
                ctx.material.name = name;
            else
                delete ctx.material.name;
            this.refreshMaterialsTree();
            this.fillMaterialControls();
        });
        $("#material-unique").on("click", () => {
            const ctx = this.materialContext();
            if (!ctx || !ctx.scope || this.renderer_adapter.rebuildingShaders)
                return;
            this.materialEdited(WebGLMaterialEditor.makeUnique(this.renderer_adapter.renderer.world, ctx.scope, ctx.material));
        });
        $("#material-new").on("click", () => {
            const ctx = this.materialContext(), type = $("#material-new-type").val();
            if (!ctx || this.renderer_adapter.rebuildingShaders)
                return;
            if (!ctx.scope)
                return this.addLibraryMaterial(type);
            const material = WebGLMaterialEditor.create(type);
            WebGLMaterialEditor.assign(this.renderer_adapter.renderer.world, ctx.scope, ctx.material, material);
            this.materialEdited(material);
        });
        $("#material-delete").on("click", () => {
            const ctx = this.materialContext();
            if (!ctx || ctx.scope || this.renderer_adapter.rebuildingShaders)
                return;
            const n = WebGLMaterialEditor.remove(this.renderer_adapter.renderer.world, ctx.material);
            myconsole.log(`Deleted ${WebGLMaterialEditor.label(ctx.material)}` + (n ? `; ${n} primitive(s) now use a default material.` : "."));
            this.selectedMaterial = null;
            this.showObjectSections(true);
            $("#selected-object-controls").dialog("close");
            this.rebuildWorld(null);
        });
    }
    // What the material controls act on: { material, scope }, where scope is the scene object whose primitives an
    // assignment changes (the object the transform tools move: a whole mesh for one of its triangles), or null when
    // the material was picked from the Materials list. Null if there's no material to manage (a light, an aggregate).
    materialContext() {
        if (this.selectedMaterial)
            return { material: this.selectedMaterial, scope: null };
        const o = this.selectedObject;
        if (!o || !(o.object instanceof Primitive) || o.object.lightEmitterFor)
            return null;
        const target = this.transformObject || o;
        return { material: o.object.material, scope: target.object || o.object };
    }
    // After the selected object's material changed: rebuild, then show it with its new material. An object inside
    // a mesh or other aggregate can't be found again after the rebuild (see rebuildWorld), so the material is shown.
    materialEdited(material) {
        const o = this.selectedObject, world = this.renderer_adapter.renderer.world;
        const reselect = o && this.transformObject === o && world.objects.includes(o.object);
        this.rebuildWorld(reselect ? o.object : material);
    }
    addLibraryMaterial(type) {
        const ra = this.renderer_adapter;
        if (!ra || ra.rebuildingShaders)
            return;
        this.rebuildWorld(WebGLMaterialEditor.add(ra.renderer.world, type));
    }
    selectMaterial(material) {
        const ra = this.renderer_adapter;
        if (!ra)
            return;
        if (this.selectedObject)
            this.selectObject(null);
        this.selectedMaterial = material;
        this.showObjectSections(false);
        const node = $.ui.fancytree.getTree("#world-objects").getNodeByKey("m" + material.MATERIAL_UID);
        if (node)
            node.setActive(true, { noEvents: true });
        const materials = ra.adapters.world.adapters.materials;
        this.fillMaterialProperties(materials.getMaterial(materials.material_id_map[material.MATERIAL_UID]) || {});
        this.fillMaterialControls();
        $("#selected-object-controls").dialog("open");
    }
    // A selected material has no geometry, transform or object properties to show.
    showObjectSections(show) {
        $("#object-geometry-types, #object-transform, #object-properties").toggle(show);
        $("#selected-object-controls").dialog("option", "title", show ? "Selected Object" : "Material");
    }
    fillMaterialProperties(values) {
        UIProperties.fillPropertyControls($("#object-material-properties"), values, (function(name, prop, target, value) {
            if (this.renderer_adapter)
                this.renderer_adapter.modifyMaterialSolidColor(target.attr("data-mc-id"), value);
            this.refreshPausedView();
        }).bind(this));
    }
    fillMaterialControls() {
        const ctx = this.materialContext(), ra = this.renderer_adapter;
        $("#material-controls").toggle(!!(ctx && ra));
        if (!ctx || !ra)
            return;
        const world = ra.renderer.world, list = WebGLMaterialEditor.list(world);
        this.materialChoices = new Map(list.map(e => [e.material.MATERIAL_UID, e.material]));
        $("#material-select").html(list.map(e =>
            `<option value="${e.material.MATERIAL_UID}">${WebGLEditorInterface.escapeHTML(WebGLMaterialEditor.label(e.material))} (${e.users})</option>`).join(""))
            .val(ctx.material.MATERIAL_UID);
        $("#material-name").val(ctx.material.name || "");
        const users = (list.find(e => e.material === ctx.material) || { users: 0 }).users;
        $("#material-unique").toggle(!!ctx.scope).button("option", "disabled", !(ctx.scope && WebGLMaterialEditor.isShared(world, ctx.scope, ctx.material)));
        $("#material-delete").toggle(!ctx.scope);
        let text = users ? `Used by ${users} primitive${users == 1 ? "" : "s"}` : "Not used by anything";
        if (ctx.scope) {
            const inside = WebGLMaterialEditor.primitives(ctx.scope).filter(p => p.material === ctx.material).length;
            if (inside < users)
                text += `, ${inside} of them in this object. Edits change all of them; Make unique to change only this object's.`;
            else
                text += ", all in this object.";
        }
        else
            text += ".";
        $("#material-users").text(text);
    }
    refreshMaterialsTree() {
        const ra = this.renderer_adapter, root = $.ui.fancytree.getTree("#world-objects").getNodeByKey("_materials");
        if (!root || !ra)
            return;
        const list = WebGLMaterialEditor.list(ra.renderer.world);
        if (this.selectedMaterial && !list.some(e => e.material === this.selectedMaterial)) {
            this.selectedMaterial = null;
            this.showObjectSections(true);
            $("#selected-object-controls").dialog("close");
        }
        root.removeChildren();
        root.addChildren(list.map(e => ({
            key: "m" + e.material.MATERIAL_UID,
            _material: e.material,
            title: `${WebGLEditorInterface.escapeHTML(WebGLMaterialEditor.label(e.material))} (${e.users})`
        })));
    }
    // "Point Light", "Area Light (Square)", "Directional Light (Circle)".
    static lightLabel(light) {
        const kind = light instanceof DirectionalLight ? "Directional Light"
                   : light instanceof RandomSampleAreaLight ? "Area Light"
                   : light instanceof SimplePointLight ? "Point Light" : light.constructor.name;
        const geometry = light.surface_geometry && !(light.surface_geometry instanceof OriginPoint)
            ? ` (${light.surface_geometry.constructor.name})` : "";
        return kind + geometry;
    }
    static escapeHTML(text) {
        return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    }
    // The + buttons on the World tree's headings open a menu of what can be added there: the same kinds as the
    // add bars under the canvas, or new materials.
    openTreeAddMenu(button, kind) {
        if (!this.renderer_adapter || this.renderer_adapter.rebuildingShaders)
            return;
        const options = kind == "materials" ? Object.entries(WebGLMaterialEditor.TYPES)
                      : $(kind == "lights" ? "#add-light-type option" : "#add-object-type option").toArray().map(o => [o.value, o.textContent]);
        const menu = $("#tree-add-menu");
        menu.attr("data-kind", kind)
            .html(options.map(([value, label]) => `<li data-value="${value}"><div>${label}</div></li>`).join(""))
            .menu("refresh").show()
            .position({ my: "left top", at: "left bottom", of: button });
    }

    initializeWorldControls(adapter) {
        const fancytree = $.ui.fancytree.getTree("#world-objects");
        
        const objects_root = fancytree.getNodeByKey("_objects");
        objects_root.removeChildren();
        // Lights' stand-in primitives (see WebGLWorldAdapter.makeLightEmitterProxy) are listed under Lights instead.
        const not_light = o => !(o.object && o.object.lightEmitterFor);
        objects_root.addChildren(adapter.getSceneTree().children
            .filter(not_light)
            .map(o => object_transformer(o, [])));
        
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
                children: [...(o.children || []).filter(not_light).map(c => object_transformer(c, ancestors.concat(o)))],
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
                title: `${WebGLEditorInterface.lightLabel(l.object)} : ${l.index}`
            };
        }));
        lights_root.setExpanded(true);

        this.refreshMaterialsTree();
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
    
    updateSelectedObjectTransformValues() {
        if (!this.selectedObject)
            return;
        UIProperties.updateTransformInputs($("#object-transform"), this.selectedObject.getWorldTransform());
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
            UIProperties.updateTransformInputs($("#camera-controls .transform-table"), this.renderer_adapter.getCameraTransform());
        }
        
        if ((this.transformObject && this.transformObject.isBeingTransformed))
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
        if (e.key == "Delete") {
            this.deleteSelectedObject();
            return;
        }
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