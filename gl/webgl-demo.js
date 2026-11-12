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
            $("#control-panel").accordion("option", "active", -1);
        }
    };
    
    if (window["myerrors"].length) {
        for (let error_dict of window["myerrors"])
            window["myconsole"].error(error_dict.error, "@" + error_dict.url + ":" + error_dict.lineNo);
        return;
    }
    
    
    // Benchmark harness option ?unthrottled=1: browsers stop requestAnimationFrame entirely while a page is hidden
    // (minimized window, background tab or pane), which stalls both shader-compile polling and the draw loop. This
    // swaps in a MessageChannel-driven stand-in, paced to ~60 Hz, so scripted runs keep going while hidden. GPU timer
    // results remain valid; only presentation is skipped. Not for normal use (it never yields to vsync).
    if (new URLSearchParams(window.location.search).get("unthrottled")) {
        const channel = new MessageChannel();
        let queue = [], last = 0, nextId = 1;
        channel.port1.onmessage = () => {
            const now = performance.now();
            if (now - last >= 16) {
                last = now;
                const callbacks = queue;
                queue = [];
                for (const [, cb] of callbacks)
                    cb(now);
            }
            if (queue.length)
                channel.port2.postMessage(0);
        };
        window.requestAnimationFrame = cb => {
            queue.push([nextId, cb]);
            if (queue.length === 1)
                channel.port2.postMessage(0);
            return nextId++;
        };
        window.cancelAnimationFrame = id => { queue = queue.filter(([i]) => i !== id); };
        console.log("URL parameter: unthrottled requestAnimationFrame stand-in installed");
    }

    // Diagnostics/benchmark harness: any URL parameter that names a static field of WebGLRendererAdapter
    // (debugFastAABB, debugTraversalOnly, bench, benchRef, ...) sets it before the scene is built, so a whole
    // experiment can be described by its URL, e.g. ?test=dragon&debugTraversalOnly=1&bench=5.
    // Values: "true"/"false" -> booleans, numeric strings -> numbers, anything else stays a string.
    // A parameter of the form ClassName.FIELD sets a static on another global class instead (for example
    // BVHAggregateNode.BINS_PER_AXIS=32), as long as that static already exists.
    for (const [key, raw] of new URLSearchParams(window.location.search)) {
        let target = WebGLRendererAdapter, field = key, targetName = "WebGLRendererAdapter";
        const dot = key.indexOf(".");
        if (dot > 0) {
            targetName = key.slice(0, dot);
            field = key.slice(dot + 1);
            if (!/^[A-Za-z_$][\w$]*$/.test(targetName))
                continue;
            try { target = (0, eval)(targetName); } catch (e) { continue; }
            if (typeof target !== "function")
                continue;
        }
        if (field === "test" || field === "prototype" || !(field in target))
            continue;
        let value = raw;
        if (raw === "true") value = true;
        else if (raw === "false") value = false;
        else if (raw !== "" && !isNaN(Number(raw))) value = Number(raw);
        target[field] = value;
        console.log(`URL parameter: ${targetName}.${field} = ${JSON.stringify(value)}`);
    }

    const i = new WebGLEditorInterface();
    // Exposed for scripted experiments: rebuild the current scene's shaders in place (after changing flags) with
    // jsrtEditor.stopDrawLoop(); jsrtEditor.changeTest(jsrtLastTest), without reloading the page or the assets.
    window.jsrtEditor = i;
    
    
    // Populate the list of worlds with the default test list
    fetch("../tests/list.json").then(response => response.json()).then(function(json) {
        for (let o of json.sort())
            $("#test-select").append(`<option value="${o}">${o}</option>`);
        
        const URLTest = new URLSearchParams(window.location.search).get('test');
        if (URLTest) {
            if (json.indexOf(URLTest) >= 0)
                $("#test-select").val(URLTest);
            loadTest(URLTest);
        }
    });
    
    window.onpopstate = function(e) {
        if (e.state && e.state.test)
            loadTest(e.state.test);
    }
    
    const defaultTitle = document.title;
    $("#test-select").on("change", function() {
        i.stopDrawLoop();
        
        const test = $("#test-select").val();
        
        window.history.pushState({ test: test }, test, test ? ("?test=" + test) : "");
        
        if (test === "")
            return;
        
        loadTest(test);
    });
    
    function loadTest(test) {
        $(".loading").css('visibility', 'visible');
        
        const start = Date.now();
        myconsole.log(`Loading test ${test}...`);
        try {
            import(`../tests/${test}/test.mjs`).then(function(module) {
                module.configureTest(function(test_data) {
                    myconsole.log(`Test ${test} successfully loaded in ${(Date.now() - start) / 1000} seconds.`);
                    window.jsrtLastTest = test_data;
                    i.changeTest(test_data);
                });
                document.title = defaultTitle + ": " + test;
            }, function(e) {
                myconsole.error(e);
                $(".loading").css('visibility', 'hidden');
            });
        }
        catch(e) {
            myconsole.error(e);
            $(".loading").css('visibility', 'hidden');
        }
    }
});

