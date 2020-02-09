function parseIndices(ts) {
    return ts.slice(1).map(t => t.match(/(\d+)(?:\/(\d*)(?:\/(\d+))?)?/).slice(1).map(x => Number.parseInt(x) - 1));
}

function parseObjFile(data, defaultMaterial, transform=Mat4.identity()) {

    let lines = data.split("\n");

    const norm_transform = Mat4.inverse(transform).transposed();

    let positions = [],
        textures = [],
        normals = [],
        triangles = [],
        currentMaterial = defaultMaterial;

    for (let l of lines) {

        if (/^\s*($|#)/.test(l))
            continue;

        let t = l.match(/\S+/g) || [];

        // face: 3 or more 1 based index triples v/vt/vn corresponding to a planar polygon
        if (t[0] == "f") {
            let indices = parseIndices(t);
            for (let i = 2; i < indices.length; ++i) {
                const abc = [indices[0], indices[i-1], indices[i]];
                let data = {};
                if (abc.every(x => x[1] !== undefined && !isNaN(x[1])))
                    data.UV = abc.map(x => textures[x[1]]);
                if (abc.every(x => x[2] !== undefined && !isNaN(x[2])))
                    data.normal = abc.map(x => normals[x[2]]);
                triangles.push(new SceneObject(
                    new Triangle(abc.map(x => positions[x[0]]), data),
                    currentMaterial));
            }
            continue;
        }

        for (let i = 1; i < t.length; ++i)
            t[i] = Number.parseFloat(t[i]);

        // vertex position: 3-4 floats xyz[w], w defaults to 1
        if (t[0] == "v")
            positions.push(transform.times(Vec.of(t[1], t[2], t[3], (t.length < 5) ? 1 : t[4])));

        // texture: 1-3 floats u[v[w]], optionals default to 0
        else if (t[0] == "vt")
            textures.push(Vec.of(t[1], t[2] || 0, t[3] || 0));

        // normal: 3 floats xyz
        else if (t[0] == "vn")
            normals.push(norm_transform.times(Vec.of(t[1], t[2], t[3], 0)).to4(0).normalized());

        // throw away material, smoothing, group, and parameter data
        else if (t[0] == "mtllib" || t[0] == "usemtl" || t[0] == "s" || t[0] == "o" || t[0] == "g" || t[0] == "vp")
            continue;

        // throw an error if we see something we don't recognize
        else
            throw "Error while attempting to parse obj file on line \"" + l + "\"";

    }

    return triangles;

}

function loadObjFile(filename, defaultMaterial, transform, callback) {
    fetch(filename).then(response => response.text()).then(function(text) {
        callback(parseObjFile(text, defaultMaterial, transform));
    });
}

function loadObjFiles(files, callback, defaultMaterial=null, transform=Mat4.identity()) {
    let toDoCount = files.length;
    let triangle_sets = new Array(files.length).fill(null);
    for (let i = 0; i < files.length; ++i) {
        // wrap this in a new function scope to capture the current index
        (function(i) {
            loadObjFile(
                files[i].filename || files[i],
                files[i].defaultMaterial || defaultMaterial,
                files[i].transform || transform,
                function(obj_triangles) {
                    triangle_sets[i] = obj_triangles;
                    if (--toDoCount === 0)
                        callback(triangle_sets);
                }
            );
        })(i);
    }
}