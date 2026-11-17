"use strict"

document.addEventListener("DOMContentLoaded", function(event) {

    const loading = document.querySelector("#loading-img");
    
    const progress = document.querySelector("#progress");
    const progress_label = document.querySelector("#progress-label");
    const progress_bar = document.querySelector("#progress-bar");

    const canvas = document.querySelector("#main-canvas");
    const context = canvas.getContext("2d");

    // The scene picker (shared with the GPU page, see gl/src/ScenePicker.js), filled from the manifest. Choosing a
    // scene starts rendering it; ?test=<scene> in the URL picks one on load, and with no scene the picker opens.
    let currentTest = "";
    const sceneButton = document.querySelector("#scene-button");
    ScenePicker.fetchManifest("tests/list.json").then(function(manifest) {
        const picker = new ScenePicker(document.querySelector("#scene-picker"), manifest, function(test) {
            window.history.pushState({ test: test }, test, "?test=" + encodeURIComponent(test));
            selectTest(test);
        }, "tests");
        sceneButton.addEventListener("click", () => picker.open());
        function selectTest(test) {
            currentTest = test;
            picker.setCurrent(test);
            sceneButton.textContent = test + " \u25BE";
            document.title = "Ray Tracer: " + test;
            document.querySelector("#render-button").click();
        }
        window.addEventListener("popstate", e => { if (e.state && e.state.test) selectTest(e.state.test); });
        const URLTest = new URLSearchParams(window.location.search).get("test");
        if (URLTest)
            selectTest(URLTest);
        else
            picker.open();
    });

    const worker_selector = document.querySelector("#workers-count");

    // Do some initial setup for our workers.
    let workerCount=0, activeWorkerCount=0, startTime=0;
    let workers=[], percentages=[], passes=[];
    
    // Construct a canvas and a context to store the result from each worker
    let tempcanvas = [], tempcontext = [];

    document.querySelector("#render-button").addEventListener("click", function onClick(e) {

        // Terminate any active workers before going any further.
        stopWorkers();
        
        // Stop here if no scene has been chosen.
        if (currentTest === "")
            return;

        workerCount = Number.parseInt(worker_selector.value);
        activeWorkerCount = workerCount;

        for (let i = tempcanvas.length; i < workerCount; ++i) {
            tempcanvas.push(document.createElement('canvas'));
            tempcontext.push(tempcanvas[i].getContext("2d"));
            percentages.push(0);
            passes.push(0);
            if (workers.length < i)
                workers.push(null);
        }
        
        // Start the test!
        const testpath = "tests/" + currentTest;
        loading.style.visibility = "visible";
        progress.style.visibility = "visible";

        context.clearRect(0, 0, canvas.width, canvas.height);

        console.log("Starting render for " + testpath + " with " + workerCount + " workers.");

        startTime = Date.now();
        
        for (let i = 0; i < workerCount; ++i) {
            tempcontext[i].clearRect(0, 0, canvas.width, canvas.height);

            const worker = workers[i] = new Worker('src/worker.js');

            worker.postMessage(["../" + testpath + "/test.mjs", i, workerCount]);

            worker.onmessage = (function(e) {
                // Every worker loads the scene, so each would report the same warnings: show the first's.
                if (e.data[0] === "warning") {
                    if (e.data[1] === 0)
                        console.warn(e.data[2]);
                }
                else if (e.data[0] === "error") {
                    console.error(e.data[2]);
                    stopWorkers();
                    loading.style.visibility = "hidden";
                    progress.style.visibility = "visible";
                    progress_label.textContent = "Error: " + e.data[2].split("\n")[0];
                }
                else if (e.data[0] === "finished") {
                    worker.terminate();
                    workers[e.data[1]] = null;
                    percentages[e.data[1]] = 1;
                    ++passes[e.data[1]];
                    if (--activeWorkerCount === 0) {
                        console.log("All workers finished in " + ((Date.now() - startTime)/1000) + " seconds!")
                        loading.style.visibility = "hidden";
                        progress.style.visibility = "hidden";
                        progress_label.innerHTML = "";
                        workers = [];
                    }
                }
                else {
                    if (e.data[2]) {
                        percentages[e.data[1]] = e.data[2].completion;
                        passes[e.data[1]] = e.data[2].pass;
                    }
                    
                    canvas.width = tempcanvas[e.data[1]].width = e.data[0].width;
                    canvas.height = tempcanvas[e.data[1]].height = e.data[0].height;

                    tempcontext[e.data[1]].putImageData(e.data[0], 0, 0);
                    for (let j = 0; j < workerCount; ++j)
                        context.drawImage(tempcanvas[j], 0, 0);
                    
                    updateCompletionEstimates();
                }
            });
        }

    });

    document.querySelector("#stop-button").addEventListener("click", function onClick(e) {
        console.log("Stopping " + activeWorkerCount + " active worker(s).");
        stopWorkers();
    });

    function stopWorkers() {
        for (let i = 0; i < workers.length; ++i) {
            if (workers[i]) {
                workers[i].terminate();
                workers[i] = null;
            }
        }
        workers = [];
        percentages = [];
        passes = [];
        loading.style.visibility = "hidden";
        progress.style.visibility = "hidden";
        progress_label.innerHTML = "";
    }
    
    function updateCompletionEstimates() {
        const percentage = percentages.reduce((sum,value) => sum + (value||0), 0) / workerCount;
        const pass = passes.reduce((sum,value) => sum + (value||0), 0) / workerCount;
        
        const time_so_far = Date.now() - startTime;
        const total_time = time_so_far / percentage;
        const remaining_time = total_time - time_so_far;
        
        progress_bar.style.width = (percentage * 100) + "%";
        progress_label.innerHTML = (percentage * 100).toFixed(1) + "% after " + pass.toFixed(1) + " passes : " + (remaining_time / 1000).toFixed(1) + "s left of " + (total_time / 1000).toFixed(1) + "s est.";
    }
});