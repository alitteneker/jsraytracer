"use strict";

$(document).ready(function() {
    
    // Populate the list of scenes with the default test list
    const scene_select = $("#test-select");
    fetch("../tests/list.json").then(response => response.json()).then(function(json) {
        for (let o of json.sort())
            scene_select.append(`<option value="tests/${o}">${o}</option>`);
    });
    
    // Setup a listener so that the rendered scene will update anytime the scene selector is changed
    let adapter = null;
    const canvas = $('#glcanvas');
    const fps_div = $('#fps-display');
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
                
                const gl = canvas.get(0).getContext('webgl2');
                if (!gl)
                    throw 'Unable to initialize WebGL. Your browser or machine may not support it.';
                
                console.log("Building adapters from scene...");
                adapter = new WebGLRendererAdapter(gl, test.renderer);
                
                console.log("Starting draw scene loop...");
                drawScene();
            });
        });
    });
    
    
    let keyDelta = [0, 0, 0], keysDown = {};
    const keyDirMap = {
        "w":       [ 0, 0,-1],
        "s":       [ 0, 0, 1],
        "a":       [-1, 0, 0],
        "d":       [ 1, 0, 0],
        " ":       [ 0, 1, 0],
        "c":       [ 0,-1, 0],
        "Control": [ 0,-1, 0]};
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
    
    // Draw the scene, incorporating mouse/key deltas
    let lastDrawTimestamp = null;
    const keySpeed = 1.0, mouseSpeed = 0.02;
    function drawScene(timestamp) {
        const timeDelta = lastDrawTimestamp ? (timestamp - lastDrawTimestamp) : 1;
        fps_div.text((1000 / timeDelta).toFixed(1) + " FPS");
        
        // draw the scene, and request the next frame of animation
        if (adapter) {
            if (!mouseDelta.every(x => (x == 0)) || !keyDelta.every(x => (x == 0))) {
                const normalizedMouseDelta = Vec.from(mouseDelta.map(v => mouseSpeed * v / timeDelta));
                const normalizedKeyDelta   = Vec.from(keyDelta.map(  v => keySpeed   * v / timeDelta));
                adapter.moveCamera(normalizedMouseDelta, normalizedKeyDelta);
            }
            adapter.drawScene(timestamp);
            window.requestAnimationFrame(drawScene);
        }
        
        // reset all intermediary variables
        lastDrawTimestamp = timestamp;
        mouseDelta = [0,0];
    }
});

