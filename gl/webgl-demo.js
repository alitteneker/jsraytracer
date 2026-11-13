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
        
        const URLParams = new URLSearchParams(window.location.search);
        if (URLParams.get("renderAll")) {
            renderAllScenes(json.sort(), URLParams);
            return;
        }
        const URLTest = URLParams.get('test');
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
        
        // Keep the shader mode (?worldEditable=true) across scene changes.
        const params = test ? "?test=" + test + (WebGLRendererAdapter.worldEditable ? "&worldEditable=true" : "") : "";
        window.history.pushState({ test: test }, test, params);
        
        if (test === "")
            return;
        
        loadTest(test);
    });
    
    // Returns a promise that resolves once the scene is configured (its shader is still to be built), or rejects if
    // its module can't be loaded.
    function loadTest(test) {
        $(".loading").css('visibility', 'visible');
        
        const start = Date.now();
        myconsole.log(`Loading test ${test}...`);
        return new Promise((resolve, reject) => {
            try {
                import(`../tests/${test}/test.mjs`).then(function(module) {
                    module.configureTest(function(test_data) {
                        myconsole.log(`Test ${test} successfully loaded in ${(Date.now() - start) / 1000} seconds.`);
                        window.jsrtLastTest = test_data;
                        i.changeTest(test_data);
                        resolve(test_data);
                    });
                    document.title = defaultTitle + ": " + test;
                }, function(e) {
                    myconsole.error(e);
                    $(".loading").css('visibility', 'hidden');
                    reject(e);
                });
            }
            catch(e) {
                myconsole.error(e);
                $(".loading").css('visibility', 'hidden');
                reject(e);
            }
        });
    }

    // Image harness, ?renderAll=1: renders every scene in tests/list.json in turn and downloads each as <scene>.png.
    //   samples=N      samples per pixel to stop at (default 2048)
    //   maxSeconds=S   stop a scene after S seconds of rendering even if it hasn't reached N (default 120)
    //   loadSeconds=S  give up on a scene that hasn't started rendering after S seconds (default 180)
    //   only=a,b       just these scenes;  from=name  start at this scene (to resume)
    //   editable=true  use the editable shader for every scene
    // Keep the tab visible (browsers pause drawing in hidden tabs), and allow multiple downloads when Chrome asks.
    async function renderAllScenes(tests, params) {
        const samples = Number(params.get("samples") || 2048),
              maxSeconds = Number(params.get("maxSeconds") || 120),
              loadSeconds = Number(params.get("loadSeconds") || 180);
        if (params.get("only"))
            tests = tests.filter(t => params.get("only").split(",").includes(t));
        if (params.get("from") && tests.includes(params.get("from")))
            tests = tests.slice(tests.indexOf(params.get("from")));
        WebGLRendererAdapter.worldEditable = params.get("editable") == "true";

        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const download = (blob, name) => {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        };
        const results = [];
        myconsole.log(`Rendering ${tests.length} scenes to ${samples} samples each (at most ${maxSeconds} s per scene)...`);
        for (const test of tests) {
            const started = performance.now();
            try {
                i.stopDrawLoop();
                $("#test-select").val(test);
                await Promise.race([loadTest(test), sleep(loadSeconds * 1000).then(() => { throw "timed out loading"; })]);

                // Wait for the shader to compile and drawing to begin.
                while (!(i.renderer_adapter && i.renderer_adapter.drawCount > 0)) {
                    if (performance.now() - started > loadSeconds * 1000)
                        throw "timed out building the shader";
                    await sleep(100);
                }

                // Render, raising the samples drawn per frame while frames stay quick, so fast scenes don't sit at
                // one sample per display refresh.
                const renderStart = performance.now();
                i.samplesPerDraw = 1;
                while (i.renderer_adapter.drawCount < samples && performance.now() - renderStart < maxSeconds * 1000) {
                    await sleep(500);
                    const h = i.timeDeltaHistory, frameMs = h.length ? i.timeDeltaHistorySum / h.length : 1000;
                    if (frameMs < 25 && i.samplesPerDraw < 256)
                        i.samplesPerDraw *= 2;
                    else if (frameMs > 60 && i.samplesPerDraw > 1)
                        i.samplesPerDraw = Math.max(1, i.samplesPerDraw >> 1);
                    $("#samples-per-draw").val(i.samplesPerDraw);
                }
                const reached = i.renderer_adapter.drawCount;
                download(await i.captureImage(), `${test}.png`);
                const seconds = ((performance.now() - started) / 1000).toFixed(1);
                results.push({ test: test, samples: reached, seconds: seconds });
                myconsole.log(`Saved ${test}.png: ${reached} samples, ${seconds} s` + (reached < samples ? " (stopped at the time limit)" : ""));
            } catch (e) {
                results.push({ test: test, error: String(e) });
                myconsole.error(`Skipped ${test}: ${e}`);
            }
        }
        i.stopDrawLoop();
        window.jsrtRenderAllResults = results;
        const failed = results.filter(r => r.error), short = results.filter(r => !r.error && r.samples < samples);
        myconsole.log(`Done: ${results.length - failed.length} of ${results.length} scenes saved.`
            + (short.length ? ` Stopped early: ${short.map(r => `${r.test} (${r.samples})`).join(", ")}.` : "")
            + (failed.length ? ` Skipped: ${failed.map(r => r.test).join(", ")}.` : ""));
    }
});

