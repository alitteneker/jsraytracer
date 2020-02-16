"use strict";

importScripts(
    'math.js',
    'scene.js',
    'pixelbuffer.js',
    'geometry.js',
    'materials.js',
    'cameras.js',
    'renderers.js',
    'lights.js',
    'objloader.js',
    'BSPScene.js');


onmessage = function(e) {

    const testName = e.data[0];
    const workerIndex = e.data[1];
    const workerCount = e.data[2];

    importScripts(testName);
    configureTest(function(test) {

        const buffer = new PixelBuffer(test.width, test.height);

        let startTime = Date.now();

        test.renderer.render(buffer, 1000, function() {
            postMessage([buffer.imgdata, workerIndex]);
        }, workerIndex, workerCount);

        console.log("Worker " + workerIndex + " finished in "
            + ((Date.now() - startTime) / 1000) + " seconds!");

        postMessage([buffer.imgdata, workerIndex]);
        postMessage(["finished", workerIndex]);
    });
}