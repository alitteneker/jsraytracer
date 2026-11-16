"use strict";

importScripts(
    'math.js',
    'world.js',
    'pixelbuffer.js',
    'geometry.js',
    'bsdf.js',
    'materials.js',
    'cameras.js',
    'renderers.js',
    'integrators.js',
    'lights.js',
    'objloader.js',
    'sdf.js',
    'aggregates.js');


onmessage = function(e) {

    const testName = e.data[0];
    const workerIndex = e.data[1];
    const workerCount = e.data[2];

    // Problems are sent to the page (see raytrace_launcher.js), which shows them: warnings (myconsole.warn, used by
    // the OBJ loader), and any error that stops this worker, including those in promise chains nothing waits on.
    self.myconsole = {
        log:  (...args) => console.log(...args),
        warn: (...args) => postMessage(["warning", workerIndex, args.join(" ")])
    };
    const fail = error => postMessage(["error", workerIndex, String(error && error.stack ? error.stack : error)]);
    self.addEventListener("unhandledrejection", e => fail(e.reason));

    import(testName).then(function(module) {
        module.configureTest(function(test) {
    
            const buffer = new PixelBuffer(test.width, test.height);
    
            let startTime = Date.now();
    
            test.renderer.render(buffer, 1000, function(stats) {
                postMessage([buffer.imgdata, workerIndex, stats]);
            }, workerIndex, workerCount);
    
            console.log("Worker " + workerIndex + " finished in "
                + ((Date.now() - startTime) / 1000) + " seconds!");
    
            postMessage([buffer.imgdata, workerIndex, null]);
            postMessage(["finished", workerIndex, null]);
        });
    }).catch(fail);
}
