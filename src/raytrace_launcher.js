"use strict"

document.addEventListener("DOMContentLoaded", function(event) {

    const loading = document.querySelector("#loading-img");

    const canvas = document.querySelector("#main-canvas");
    const context = canvas.getContext("2d");

    // Populate the list of available tests from the manifest
    const select = document.querySelector("#test-select");
    fetch("tests/list.json").then(response => response.json()).then(function(json) {
        for (let o of json.sort()) {
            const option = document.createElement('option');
            option.value = "tests/" + (option.innerHTML = o);
            select.appendChild(option);
        }
    });

    const worker_selector = document.querySelector("#workers-count");

    // Do some initial setup for our workers.
    let activeWorkerCount = 0, startTime;
    let workers = [];
    
    // Construct a canvas and a context to store the result from each 
    let tempcanvas = [], tempcontext = [];

    document.querySelector("#render-button").addEventListener("click", function onClick(e) {

        // Terminate any active workers before going any further.
        stopWorkers();
        
        // Stop here if no valid test is selected.
        if (select.value === "")
            return;

        const workerCount = Number.parseInt(worker_selector.value);
        activeWorkerCount = workerCount;

        for (let i = tempcanvas.length; i < workerCount; ++i) {
            tempcanvas.push(document.createElement('canvas'));
            tempcontext.push(tempcanvas[i].getContext("2d"));
        }
        
        // Start the test!
        const testpath = select.value;
        loading.style.visibility = "visible";

        context.clearRect(0, 0, canvas.width, canvas.height);

        console.log("Starting render for " + testpath + " with " + workerCount + " workers.");

        startTime = Date.now();
        
        for (let i = 0; i < workerCount; ++i) {
            tempcontext[i].clearRect(0, 0, canvas.width, canvas.height);

            const worker = workers[i] = new Worker('src/worker.js');

            worker.postMessage(["../" + testpath + "/test.js", i, workerCount]);

            worker.onmessage = (function(e) {
                if (e.data[0] === "finished") {
                    worker.terminate();
                    workers[e.data[1]] = null;
                    if (--activeWorkerCount === 0) {
                        console.log("All workers finished in " + ((Date.now() - startTime)/1000) + " seconds!")
                        loading.style.visibility = "hidden";
                        workers = [];
                    }
                }
                else {                    
                    canvas.width = tempcanvas[e.data[1]].width = e.data[0].width;
                    canvas.height = tempcanvas[e.data[1]].height = e.data[0].height;

                    tempcontext[e.data[1]].putImageData(e.data[0], 0, 0);
                    for (let j = 0; j < workerCount; ++j)
                        context.drawImage(tempcanvas[j], 0, 0);
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
        loading.style.visibility = "hidden";
    }
});