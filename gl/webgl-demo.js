"use strict";

$(document).ready(function() {
    
    // Populate the list of scenes with the default test list
    const scene_select = $("#test-select");
    fetch("../tests/list.json").then(response => response.json()).then(function(json) {
        for (let o of json.sort())
            scene_select.append(`<option value="tests/${o}">${o}</option>`);
    });
    
    const canvas = $('#glcanvas');
    const fps_div = $('#fps-display');
    const focusSlider = $('#focus-distance');
    const apertureSlider = $('#aperture-size');
    
    // Setup a listener so that the rendered scene will update anytime the scene selector is changed
    let adapter = null;
    scene_select.on("change", function onChange(e) {
        if (adapter) {
            adapter.destroy();
            adapter = null;
        }
        
        if (scene_select.value === "")
            return;
        const scene_path = scene_select.val();
        
        import("../" + scene_path + "/test.js").then(function(module) {
            module.configureTest(function(test) {
                canvas.attr("width", test.width);
                canvas.attr("height", test.height);
                
                console.log("Building adapters from scene...");
                adapter = new WebGLRendererAdapter(canvas.get(0), test.renderer);
                
                // Set the initial slider values for the camera settings to the display
                focusSlider.val(adapter.adapters.camera.focus_distance);
                apertureSlider.val(adapter.adapters.camera.aperture_size);
                changeLensSettings();
                
                // reset the mouseDelta, to prevent any previous mouse input from making the camera jump on the first frame
                mouseDelta = [0,0];
                
                console.log("Starting draw scene loop...");
                window.requestAnimationFrame(drawScene);
            });
        });
    });
    
    
    // Setup key mappings so that the camera can be moved
    let keyDelta = [0, 0, 0], keysDown = {};
    const keyDirMap = {
        "w": [ 0, 0,-1],
        "s": [ 0, 0, 1],
        "a": [-1, 0, 0],
        "d": [ 1, 0, 0],
        " ": [ 0, 1, 0],
        "c": [ 0,-1, 0]};
    function calcKeyDelta() {
        keyDelta = [0,0,0];
        for (let [key, isDown] of Object.entries(keysDown))
            if (isDown && key in keyDirMap)
                for (let i = 0; i < 3; ++i)
                    keyDelta[i] += keyDirMap[key][i];
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
    let mouseDelta = [0, 0], lastMousePos = null, isMouseDown = false;
    function pointerDown(e) {
        if (e.pointerType === 'mouse' && e.button !== 0)
            return;
        isMouseDown = true;
        lastMousePos = [event.clientX, event.clientY];
        canvas.get(0).setPointerCapture(e.pointerId);
    }
    function pointerLeave(e) {
        isMouseDown = false;
        canvas.get(0).releasePointerCapture(e.pointerId);
    }
    function pointerMove(e) {
        const mousePos = [event.clientX, event.clientY];
        if (adapter && isMouseDown)
            mouseDelta = [0,1].map(i => mouseDelta[i] + mousePos[i] - lastMousePos[i]);
        lastMousePos = mousePos;
    }
    canvas.on("pointerdown", pointerDown);
    canvas.on("pointerup pointercancel", pointerLeave);
    canvas.on("pointermove", pointerMove);
    canvas.on("blur", e => { isMouseDown = false; });
    
    
    // setup listeners to change the camera focus settings whenever the sliders change
    function changeLensSettings() {
        const focusValue = Number.parseFloat(focusSlider.val()), apertureValue = Number.parseFloat(apertureSlider.val());
        if (adapter)
            adapter.changeLensSettings(focusValue, apertureValue);
        $('#focus-output').text(focusValue.toFixed(2));
        $('#aperture-output').text(apertureValue.toFixed(2));
    }
    focusSlider.on('input', changeLensSettings);
    apertureSlider.on('input', changeLensSettings);
    
    
    
    // Draw the scene, incorporating mouse/key deltas
    let lastDrawTimestamp = null;
    const keySpeed = 1.0, mouseSpeed = 0.02;
    function drawScene(timestamp) {
        const timeDelta = lastDrawTimestamp ? (timestamp - lastDrawTimestamp) : 1;
        
        // draw the scene, and request the next frame of animation
        if (adapter) {
            fps_div.text((1000 / timeDelta).toFixed(1) + " FPS - " + adapter.drawCount + " samples");
            if (timeDelta > 0 && (mouseDelta.some(x => (x != 0)) || keyDelta.some(x => (x != 0)))) {
                const normalizedMouseDelta = Vec.from(mouseDelta.map(v => mouseSpeed * v / timeDelta));
                const normalizedKeyDelta   = Vec.from(keyDelta.map(  v => keySpeed   * v / timeDelta));
                adapter.moveCamera(normalizedMouseDelta, normalizedKeyDelta);
                mouseDelta = [0,0];
            }
            adapter.drawScene(timestamp);
            window.requestAnimationFrame(drawScene);
        }
        
        // reset all intermediary input/timing variables
        lastDrawTimestamp = timestamp;
    }
});

