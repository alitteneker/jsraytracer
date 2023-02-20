"use strict";

$(document).ready(function() {
    
    const canvas = $('#glcanvas');
    const console_output = $('#console_output');
    const loading_spinner = $("#loading-img");
    const fps_div = $('#fps-display');
    
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
    
    // Populate the list of scenes with the default test list
    const scene_select = $("#test-select");
    fetch("../tests/list.json").then(response => response.json()).then(function(json) {
        for (let o of json.sort())
            scene_select.append(`<option value="tests/${o}">${o}</option>`);
    });
    
    // Setup a listener so that the rendered scene will update anytime the scene selector is changed
    let renderer_adapter = null, animation_request_id = null;
    scene_select.on("change", function onChange(e) {
        if (animation_request_id) {
            window.cancelAnimationFrame(animation_request_id);
            animation_request_id = null;
        }
        if (renderer_adapter) {
            renderer_adapter.destroy();
            renderer_adapter = null;
        }
        
        if (scene_select.value === "")
            return;
        const scene_path = scene_select.val();

        loading_spinner.css('visibility', 'visible');
        
        myconsole.log("Loading " + scene_path + "...");
        import("../" + scene_path + "/test.js").then(function(module) {
            module.configureTest(function(test) {
                canvas.attr("width", test.width);
                canvas.attr("height", test.height);
                
                try {
                    WebGLRendererAdapter.build(canvas.get(0), test.renderer, function(adapter) {
                        renderer_adapter = adapter;
                        
                        // Set the initial values for the controls
                        getDefaultControlValues(renderer_adapter);
                        
                        // reset the mouseDelta, to prevent any previous mouse input from making the camera jump on the first frame
                        mouseMoveDelta = [0,0];
                        
                        myconsole.log("Starting draw scene loop...");
                        animation_request_id = window.requestAnimationFrame(drawScene);

                        loading_spinner.css('visibility', 'hidden');
                    });
                } catch(error) {
                    myconsole.error(error);
                    loading_spinner.css('visibility', 'hidden');
                }
            });
        });
    });
    
    
    
    // Draw the scene, incorporating mouse/key deltas
    let lastDrawTimestamp = null;
    let keyMoveDelta = [0,0,0], mouseMoveDelta = [0,0];
    const keySpeed = 3.0, mouseSpeed = 0.08;
    function drawScene(timestamp) {
        const currentTimestamp = performance.now();
        const timeDelta = lastDrawTimestamp ? (currentTimestamp - lastDrawTimestamp) : 1;
        
        // draw the scene, and request the next frame of animation
        if (renderer_adapter) {
            fps_div.text((1000 / timeDelta).toFixed(1) + " FPS - " + renderer_adapter.drawCount + " samples");
            if (timeDelta > 0 && (mouseMoveDelta.some(x => (x != 0)) || keyMoveDelta.some(x => (x != 0)))) {
                const normalizedMouseDelta = Vec.from(mouseMoveDelta.map(v => mouseSpeed * v * timeDelta / 1000));
                const normalizedKeyDelta   = Vec.from(keyMoveDelta.map(  v => keySpeed   * v * timeDelta / 1000));
                renderer_adapter.moveCamera(normalizedMouseDelta, normalizedKeyDelta);
                mouseMoveDelta = [0,0];
            }
            renderer_adapter.drawScene(currentTimestamp);
            animation_request_id = window.requestAnimationFrame(drawScene);
        }
        
        // reset all intermediary input/timing variables
        lastDrawTimestamp = currentTimestamp;
    }
    
    
    
    // Setup key mappings so that the camera can be moved
    let keysDown = {};
    const keyDirMap = {
        "w": [ 0, 0,-1],
        "s": [ 0, 0, 1],
        "a": [-1, 0, 0],
        "d": [ 1, 0, 0],
        " ": [ 0, 1, 0],
        "c": [ 0,-1, 0]};
    function calcKeyDelta() {
        keyMoveDelta = [0,0,0];
        for (let [key, isDown] of Object.entries(keysDown))
            if (isDown && key in keyDirMap)
                for (let i = 0; i < 3; ++i)
                    keyMoveDelta[i] += keyDirMap[key][i];
    }
    function keyDown(e) {
        if (e.key in keyDirMap)
            keysDown[e.key] = true;
        calcKeyDelta();
    }
    function keyUp(e) {
        if (e.key in keyDirMap)
            keysDown[e.key] = false;
        calcKeyDelta();
    }
    function keyReset(e) {
        keysDown = {};
        calcKeyDelta();
    }
    $("div.canvas-widget").on("keydown", keyDown);
    $("div.canvas-widget").on("keyup", keyUp);
    $("div.canvas-widget").on("blur", keyReset);
    
    
    // setup some mouse listeners to track mouse movements while the cursor is pressed over the canvas
    let lastMousePos = null, isMouseDown = false, hasMouseMoved = false;
    function pointerDown(e) {
        if (e.pointerType === 'mouse' && e.button !== 0)
            return;
        hasMouseMoved = false;
        isMouseDown = true;
        lastMousePos = [event.clientX, event.clientY];
        canvas.get(0).setPointerCapture(e.pointerId);
    }
    function pointerUp(e) {
        if (hasMouseMoved === false && renderer_adapter) {
            const rect = e.target.getBoundingClientRect();
            selectObjectAt(e.clientX - rect.left, e.clientY - rect.top);
        }
        pointerLeave(e);
    }
    function pointerLeave(e) {
        isMouseDown = false;
        canvas.get(0).releasePointerCapture(e.pointerId);
    }
    function pointerMove(e) {
        const mousePos = [event.clientX, event.clientY];
        if (isMouseDown) {
            hasMouseMoved = true;
            if (renderer_adapter)
                mouseMoveDelta = [0,1].map(i => mouseMoveDelta[i] + mousePos[i] - lastMousePos[i]);
        }
        lastMousePos = mousePos;
    }
    canvas.on("pointerdown",   pointerDown);
    canvas.on("pointerup",     pointerUp);
    canvas.on("pointercancel", pointerLeave);
    canvas.on("pointermove",   pointerMove);
    canvas.on("blur", e => { isMouseDown = false; });
    
    
    
    const fovSlider = $('#fov-range');
    const focusSlider = $('#focus-distance');
    const apertureSlider = $('#aperture-size');
    const rendererDepthInput = $('#renderer-depth');
    
    
    function getDefaultControlValues(renderer_adapter) {
        rendererDepthInput.val(renderer_adapter.maxBounceDepth);
        
        if (renderer_adapter.adapters.camera.focus_distance != 1.0)
            focusSlider.val(renderer_adapter.adapters.camera.focus_distance);
        else
            focusSlider.val(renderer_adapter.adapters.camera.camera_transform.column(3).minus(
                renderer_adapter.adapters.scene.scene.kdtree.aabb.center).norm());
        
        apertureSlider.val(renderer_adapter.adapters.camera.aperture_size);
        fovSlider.val(-renderer_adapter.adapters.camera.FOV);
        
        changeLensSettings();
    }

    
    // setup listeners to change the camera focus settings whenever the sliders change
    function changeLensSettings() {
        const focusValue    =  Number.parseFloat(focusSlider.val()),
              apertureValue =  Number.parseFloat(apertureSlider.val()),
              fovValue      = -Number.parseFloat(fovSlider.val());
        if (renderer_adapter)
            renderer_adapter.changeLensSettings(focusValue, apertureValue, fovValue);
        $('#focus-output').text(focusValue.toFixed(2));
        $('#aperture-output').text(apertureValue.toFixed(2));
        $('#fov-output').text((180 * fovValue / Math.PI).toFixed(2));
    }
    focusSlider.on('input', changeLensSettings);
    apertureSlider.on('input', changeLensSettings);
    fovSlider.on('input', changeLensSettings);
    
    rendererDepthInput.on('spin', function(e, ui) {
        if (renderer_adapter)
            renderer_adapter.changeMaxBounceDepth(Number.parseInt(ui.value));
    });
    
    
    
    function selectObjectAt(raster_x, raster_y) {
        if (!renderer_adapter)
            return;
        
        let x =  2 * (raster_x / canvas.attr("width"))  - 1;
        let y = -2 * (raster_y / canvas.attr("height")) + 1;
        
        const selected = renderer_adapter.selectObjectAt(x, y);
        // TODO: do something with it
        myconsole.log(x,y,selected.object);
    }
    
    
    
    // Setup the UI to pretty things up...
    $("#control-panel").accordion({ collapsible:true, active: -1 });
    $(".control-group").controlgroup();
    $("#help-button").button({
        icon: "ui-icon-help",
        showLabel: false
    });
});

