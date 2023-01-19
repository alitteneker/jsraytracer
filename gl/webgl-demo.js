"use strict";

$(document).ready(function() {
    const scene_select = $("#test-select");
    fetch("../tests/list.json").then(response => response.json()).then(function(json) {
        for (let o of json.sort())
            scene_select.append(`<option value="tests/${o}">${o}</option>`);
    });
    
    const canvas = document.querySelector('#glcanvas');
    
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
                canvas.width = test.width;
                canvas.height = test.height;
                
                const gl = canvas.getContext('webgl2');
                if (!gl)
                    throw 'Unable to initialize WebGL. Your browser or machine may not support it.';
                
                console.log("Building adapters from scene...");
                adapter = new WebGLRendererAdapter(gl, test.renderer);
                
                console.log("Drawing scene...");
                adapter.drawScene();
            });
        });
    });
});

