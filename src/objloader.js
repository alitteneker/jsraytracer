function makeMaterial(data, isPath) {
    const ambientMultiplier = 0.1;
    let ambient  = data.map_Ka || data.Ka || Vec.of(0,0,0),
        diffuse  = data.map_Kd || data.Kd || Vec.of(0,0,0),
        specular = data.map_Ks || data.Ks || Vec.of(0,0,0),
        smoothness = data.Ns || 0;
    // TODO: add support for illum
    return new (isPath ? PhongPathTracingMaterial : PhongMaterial)(
        Vec.of(0,0,0), MaterialColor.coerce(ambient, ambientMultiplier), diffuse, specular, smoothness);
}

function parseMtlFile(data, isPath=false) {
    const ret = {};

    let curr = null, name;
    for (const l of data.split("\n")) {
        if (/^\s*($|#)/.test(l))
            continue;

        let t = l.match(/\S+/g) || [];

        if (t[0] == "newmtl") {
            if (curr)
                ret[name] = makeMaterial(curr, isPath);
            name = t[1];
            curr = {};
            continue;
        }

        for (let i = 1; i < t.length; ++i) {
            const num = Number.parseFloat(t[i])
            if (!isNaN(num))
                t[i] = num;
        }

        if (t[0] == "Ka" || t[0] == "Kd" || t[0] == "Ks" || t[0] == "Ke" || t[0] == "Tf")
            curr[t[0]] = Vec.of(t[1], t[2], t[3]);

        else if (t[0] == "Ns" || t[0] == "Ni" || t[0] == "illum"
            || t[0] == "d" || t[0] == "Tr"
            || t[0] == "map_Ka" || t[0] == "map_Kd" || t[0] == "map_Ks")
            curr[t[0]] = t[1];
        
        else
            throw "Unsupported material parameter: " + t[0];
    }

    if (curr)
        ret[name] = makeMaterial(curr, isPath);

    return ret;
}

function loadMtlFile(filename, callback, isPath) {
    fetch(filename).then(function(response) {
        if (!response.ok)
            throw "Attempt to fetch " + filename + " was not successful.";
        return response.text();
    }).then(function(text) {
        callback(parseMtlFile(text, isPath));
    });
}

function loadMtlFiles(filenames, callback, isPath=false) {
    if (filenames.length == 0)
        callback({});
    let toDoCount = filenames.length;
    let materials = {};
    for (let i = 0; i < filenames.length; ++i) {
        (function(i) {
            loadMtlFile(
                filenames[i],
                function(mat) {
                    Object.assign(materials, mat);
                    if (--toDoCount === 0)
                        callback(materials);
                },
                isPath
            );
        })(i);
    }
}

function parseIndices(ts) {
    return ts.slice(1).map(t => t.match(/(\d+)(?:\/(\d*)(?:\/(\d+))?)?/).slice(1).map(
        x => Number.parseInt(x) - 1));
}

function parseObjFile(callback, data, prefix="", defaultMaterial=null, transform=Mat4.identity(), isPath=false) {

    let lines = data.split("\n");

    const mtllibs = [];
    for (const l of lines) {
        if (/^\s*($|#)/.test(l))
            continue;

        let t = l.match(/\S+/g) || [];

        if (t[0] == "mtllib")
            mtllibs.push(prefix + t[1]);
    }
    loadMtlFiles(mtllibs, function(materials) {

        const norm_transform = Mat4.inverse(transform).transposed();

        let positions = [],
            textures = [],
            normals = [],
            triangles = [],
            currentMaterial = defaultMaterial;

        for (const l of lines) {

            if (/^\s*($|#)/.test(l))
                continue;

            let t = l.match(/\S+/g) || [];

            if (t[0] == "mtllib")
                continue;

            if (t[0] == "usemtl") {
                if (!materials[t[1]])
                    throw "No material defined with name: " + t[1];
                currentMaterial = materials[t[1]];
                continue;
            }

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
            else if (t[0] == "mtllib" || t[0] == "usemtl" || t[0] == "s"
                || t[0] == "o" || t[0] == "g" || t[0] == "vp")
                continue;

            // throw an error if we see something we don't recognize
            else
                throw "Error while attempting to parse obj file on line \"" + l + "\"";

        }

        callback(triangles);

    }, isPath);
}

function loadObjFile(filename, defaultMaterial, transform, callback) {
    fetch(filename).then(function(response) {
        if (!response.ok)
            throw "Attempt to fetch " + filename + " was not successful.";
        return response.text();
    }).then(function(text) {
        let prefix = "";
        if (filename.lastIndexOf("/") > 0)
            prefix = filename.substring(0, filename.lastIndexOf("/") + 1);
        parseObjFile(callback, text, prefix, defaultMaterial, transform);
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