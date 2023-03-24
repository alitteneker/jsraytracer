const fs = require("fs");
const vm = require("vm");

const requirements = [
    'math.js',
    'world.js',
    'pixelbuffer.js',
    'geometry.js',
    'materials.js',
    'cameras.js',
    'renderers.js',
    'lights.js',
    'objloader.js',
    'aggregates.js',
    'serializer.js'];
for (let r of requirements)
    new vm.Script(fs.readFileSync(`../src/${r}`).toString(), { filename: r }).runInThisContext();


const test_loc = process.argv.slice(2)[0];
console.log("Loading " + test_loc + "...");

import("./" + test_loc + "/test.mjs").then(function(module) {
    module.configureTest(function(test) {
        console.log("Loaded! Serializing...");
        
        fs.writeFileSync(test_loc + "/test.json", new Serializer(test).toJSON());
        
        console.log("Finished!");
    });
});