// The editor's Import: files picked from disk (or dropped on the page) are read right here in the browser, nothing is
// uploaded, and added to the scene in front of the camera, sized to fit the view:
//   - meshes (.obj with its .mtl and textures, .gltf with its .bin and images, or .glb) become one BVH the editor can
//     select and move as a whole, with PBR (principled) materials;
//   - voxel grids (.vdb, read by src/vdb.js, or .vol.gz from tools/vdb_to_grid.py) become a volume: its "density"
//     grid (or the file's first float grid), glowing from its "temperature" grid if it has one.
// Files a model refers to (an OBJ's MTL and textures, a glTF's buffers and images) are found by name among the files
// picked with it, whatever folders their paths name, so pick them together.
class WebGLImporter {
    static ACCEPT = ".obj,.mtl,.gltf,.glb,.bin,.vdb,.gz,.png,.jpg,.jpeg,.tga,.bmp,.webp,.gif";

    static async importFiles(fileList, editor) {
        const ra = editor.renderer_adapter, files = [...fileList];
        if (!ra || ra.rebuildingShaders || !files.length)
            return;
        // Every picked file, by lowercased name, for the loaders to find (see objLoaderFetch).
        objLoaderLocalFiles.clear();
        for (const f of files)
            objLoaderLocalFiles.set(f.name.toLowerCase(), f);
        const resolve = async uri => {
            const f = objLoaderLocalFiles.get(uri.split(/[\\/]/).pop().toLowerCase());
            if (!f)
                throw `${uri} wasn't among the files picked (pick a model's files together)`;
            return f.arrayBuffer();
        };

        const added = [];
        for (const f of files) {
            const name = f.name.toLowerCase();
            const kind = name.endsWith(".obj") ? "mesh" : (name.endsWith(".gltf") || name.endsWith(".glb")) ? "gltf"
                       : name.endsWith(".vdb") ? "vdb" : name.endsWith(".vol.gz") ? "grid" : null;
            if (!kind)
                continue;
            try {
                LoadingStatus.phase(`Importing ${f.name}`);
                await new Promise(r => LoadingStatus.afterPaint(r));
                const t0 = performance.now();
                let obj;
                if (kind == "mesh")
                    obj = WebGLImporter.meshObject(await WebGLImporter.loadOBJ(f), editor);
                else if (kind == "gltf") {
                    const { primitives, warnings } = await GLTFLoader.load(await f.arrayBuffer(), resolve, f.name);
                    for (const w of warnings)
                        myconsole.log(`${f.name}: ${w}.`);
                    obj = WebGLImporter.meshObject(primitives, editor);
                }
                else if (kind == "vdb") {
                    const vdb = new VDBFile(await f.arrayBuffer(), f.name);
                    const floats = vdb.grids.filter(g => /^Tree_float_5_4_3/.test(g.type)).map(g => g.name);
                    const density = floats.includes("density") ? "density" : floats[0];
                    if (!density)
                        throw "it has no float grid";
                    const grids = vdb.toVoxelGrids([density, ...(density == "density" && floats.includes("temperature") ? ["temperature"] : [])]);
                    obj = WebGLImporter.volumeObject(grids[density], grids.temperature, editor);
                    myconsole.log(`${f.name}: grids ${vdb.grids.map(g => g.name).join(", ")}; used ${density}${grids.temperature ? " and temperature (as glowing fire)" : ""}.`);
                }
                else {
                    const bytes = new Uint8Array(await new Response(f.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
                    obj = WebGLImporter.volumeObject(VoxelGrid.parse(bytes, f.name), null, editor);
                }
                if (!obj)
                    throw "it has nothing to show";
                added.push(obj);
                myconsole.log(`Imported ${f.name} in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
            }
            catch (e) {
                myconsole.error(`Could not import ${f.name}: ${e && e.message ? e.message : e}`);
            }
        }
        LoadingStatus.done();
        if (!added.length) {
            if (!files.some(f => /\.(obj|gltf|glb|vdb|vol\.gz)$/i.test(f.name)))
                myconsole.log("Nothing to import: pick an .obj (with its .mtl and textures), a .gltf (with its .bin and images) or .glb, a .vdb or a .vol.gz.");
            return;
        }
        editor.addObjects(added);
    }

    static loadOBJ(file) {
        return file.text().then(text => new Promise((resolve, reject) => {
            try {
                parseObjFile(resolve, text, "", WebGLEditorInterface.defaultMaterial(), Mat4.identity(), 0, "principled");
            }
            catch (e) {
                reject(e);
            }
        }));
    }

    // Where an import goes: in front of the camera at the scene's distance, its largest side about 0.6 of that.
    static placement(editor, box) {
        const p = editor.placementInFrontOfCamera();
        const extent = Math.max(...box.half_size.slice(0, 3)) * 2;
        const scale = extent > 0 ? 4 * p.size / extent : 1;
        return Mat4.translation(p.position.to3()).times(Mat4.scale(scale)).times(Mat4.translation(box.center.to3().times(-1)));
    }
    static meshObject(primitives, editor) {
        if (!primitives.length)
            return null;
        const box = AABB.hull(primitives.map(p => p.getBoundingBox()));
        return BVHAggregate.build(primitives, WebGLImporter.placement(editor, box));
    }
    // A volume for a grid: dense enough to read as a cloud (light crossing its middle meets an optical depth of about
    // 4, from its average nonzero value), as a smoky fire if it has a temperature grid. Density, albedo and g can be
    // changed in the editor afterwards.
    static volumeObject(grid, temperature, editor) {
        let sum = 0, n = 0;
        for (const b of grid.atlas)
            if (b) {
                sum += (b / 255) * (b / 255);
                ++n;
            }
        const mean = n ? grid.max * sum / n : 1;
        const { min, max } = grid.bounds, extent = Math.max(...[0, 1, 2].map(i => max[i] - min[i]));
        const density = mean > 0 && extent > 0 ? 4 / (mean * extent / 2) : 1;
        const medium = new GridMedium(grid, temperature
            ? { density, albedo: 0.55, g: 0.3, emission: { temperature, kelvin: 3800, offset: 0.05, scale: 40 } }
            : { density, albedo: 0.95, g: 0.6 });
        const box = AABB.fromMinMax(Vec.of(...min, 1), Vec.of(...max, 1));
        return new Volume(medium, WebGLImporter.placement(editor, box));
    }
}
