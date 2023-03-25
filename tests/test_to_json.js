global["fs"] = require("fs");
global["fspromise"] = require("fs/promises");

const vm = require("vm");
const msgpack = require("@msgpack/msgpack");

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
for (let r of requirements) {
    const filename = `../src/${r}`;
    new vm.Script(fs.readFileSync(filename).toString(), { filename: filename }).runInThisContext();
}


const test_loc = process.argv.slice(2)[0];
console.log("Loading " + test_loc + "...");

import("./" + test_loc + "/test.mjs").then(function(module) {
    module.configureTest(function(test) {
        console.log("Loaded! Serializing...");
        
        const plain = new Serializer(test).plain();
        
        console.log("Writing to disk...");
        
        //fs.writeFileSync(test_loc + "/test.json", JSON.stringify(plain), 'utf8');

        const encoded = msgpack.encode(plain);
        fs.writeFileSync(test_loc + "/test.json_msp", Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength), 'binary');

        console.log("Finished!");
    });
});