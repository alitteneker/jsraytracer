class WebGLGeometriesAdapter {
    static NULL_ID         = 0;
    static PLANE_ID        = 1;
    static SPHERE_ID       = 2;
    static UNITBOX_ID      = 3;
    static CIRCLE_ID       = 4;
    static SQUARE_ID       = 5;
    static CYLINDER_ID     = 6;
    static ORIGINPOINT_ID  = 7;
    static UNITLINE_ID     = 8;
    
    static MIN_SDF_ID      = 9;
    static SDF_BLOCK_COUNT = 8;
    
    static MIN_TRIANGLE_ID = WebGLGeometriesAdapter.MIN_SDF_ID + WebGLGeometriesAdapter.SDF_BLOCK_COUNT;
    
    static SWITCHABLE_TYPES = Math.range(1, 9);

    static isTypeSDF(type) {
        return type >= WebGLGeometriesAdapter.MIN_SDF_ID && type - WebGLGeometriesAdapter.MIN_SDF_ID < WebGLGeometriesAdapter.SDF_BLOCK_COUNT;
    }
    static isTypeTriangle(type) {
        return type >= WebGLGeometriesAdapter.MIN_TRIANGLE_ID;
    }
    static TypeStringLabel(type) {
        if (type == WebGLGeometriesAdapter.NULL_ID)        return "Null";
        if (type == WebGLGeometriesAdapter.PLANE_ID)       return "Plane";
        if (type == WebGLGeometriesAdapter.SPHERE_ID)      return "Sphere";
        if (type == WebGLGeometriesAdapter.UNITBOX_ID)     return "UnitBox";
        if (type == WebGLGeometriesAdapter.CIRCLE_ID)      return "Circle";
        if (type == WebGLGeometriesAdapter.SQUARE_ID)      return "Square";
        if (type == WebGLGeometriesAdapter.CYLINDER_ID)    return "Cylinder";
        if (type == WebGLGeometriesAdapter.ORIGINPOINT_ID) return "OriginPoint";
        if (type == WebGLGeometriesAdapter.UNITLINE_ID)    return "UnitLine";
        if (WebGLGeometriesAdapter.isTypeSDF(type))
            return "SDF: " + (type - WebGLGeometriesAdapter.MIN_SDF_ID + 1);
        if (WebGLGeometriesAdapter.isTypeTriangle(type))
            return "Triangle";
        return "Unknown";
    }
    
    
    constructor(webgl_helper) {
        [this.triangle_data_texture_unit,    this.triangle_data_texture]    = webgl_helper.createDataTextureAndUnit(3, "FLOAT");
        [this.triangle_indices_texture_unit, this.triangle_indices_texture] = webgl_helper.createDataTextureAndUnit(3, "INTEGER");
        // Positions duplicated per triangle (3 consecutive RGB32F texels), for intersection without an index lookup.
        [this.triangle_verts_texture_unit,   this.triangle_verts_texture]   = webgl_helper.createDataTextureAndUnit(3, "FLOAT");
        
        this.sdf_adapter = new WebGLSDFAdapter();
        
        this.triangle_data = new WebGLVecStore();
        this.reset();
        
        
        
        this.ShaderSourceModules = [
        // null
        new WebGLAbstractGeometryShaderSource(),
        
        // The primitives. Their GLSL is in geometries.glsl, in sections named after them.
        new WebGLStaticGeometryShaderSource("plane",       { intersect: true,  sample: false }),
        new WebGLStaticGeometryShaderSource("sphere",      { intersect: true,  sample: true  }),
        new WebGLStaticGeometryShaderSource("unitBox",     { intersect: true,  sample: false }),
        // A circle and a square are bounded planes: their GLSL calls the plane's (planeIntersect, planeMaterialData).
        new WebGLStaticGeometryShaderSource("circle",      { intersect: true,  sample: true, requires: ["plane"] }),
        new WebGLStaticGeometryShaderSource("square",      { intersect: true,  sample: true, requires: ["plane"] }),
        // A cylinder intersects its side as a sphere flattened along z (sphereIntersect).
        new WebGLStaticGeometryShaderSource("cylinder",    { intersect: true,  sample: false, requires: ["sphere"] }),
        new WebGLStaticGeometryShaderSource("originPoint", { intersect: false, sample: true, materialNeedsDirection: true }),
        new WebGLStaticGeometryShaderSource("unitLine",    { intersect: false, sample: true, materialNeedsDirection: true }),
        
        // sdfs
        ...new Array(WebGLGeometriesAdapter.SDF_BLOCK_COUNT).fill(new WebGLSDFGeometryShaderSource()),
        
        // triangle
        new WebGLTriangleGeometryShaderSource()];
    }
    static triangleDataGenerations = 0;
    reset() {
        this.geometry_usage_map = {};
        for (let i = 0; i <= WebGLGeometriesAdapter.MIN_TRIANGLE_ID; ++i)
            this.geometry_usage_map[i] = { intersect: 0, sample: 0 };
        
        this.geometries = [ new Plane(), new Sphere(), new UnitBox(), new Circle(), new Square(), new Cylinder(), new OriginPoint(), new UnitLine() ].concat(Array(WebGLGeometriesAdapter.SDF_BLOCK_COUNT).fill(null));
        this.id_map = {};
        
        this.sdf_geometries = [];
        this.sdf_adapter.reset();
        
        // Triangle vertex data is kept across re-visits of the world (after an edit, see
        // WebGLRendererAdapter.worldModified): each Triangle remembers where its data was stored, so a mesh that is
        // still in the scene isn't stored again. The store is only cleared once most of it is stale.
        if (!this.triangle_data_generation || (this.triangles && this.triangles.length < 0.5 * this.triangle_data_triangle_count)) {
            this.triangle_data.clear();
            // Unique across adapters: a new adapter (a new scene load) must never accept data cached by an old one.
            this.triangle_data_generation = ++WebGLGeometriesAdapter.triangleDataGenerations;
            this.triangle_data_triangle_count = 0;
        }
        this.triangles = [];
    }
    destroy(gl) {
        this.triangle_data_texture.destroy();
        this.triangle_indices_texture.destroy();
        this.triangle_verts_texture.destroy();
    }
    register_usage(ID, intersect, sample) {
        ID = Math.min(ID, WebGLGeometriesAdapter.MIN_TRIANGLE_ID);
        if (!this.geometry_usage_map[ID])
            throw "Attempt to register usage of invalid geometry";
        if (intersect)
            ++this.geometry_usage_map[ID].intersect;
        if (sample)
            ++this.geometry_usage_map[ID].sample;
        return ID;
    }
    visit(geometry, webgl_helper, intersect=true, sample=false) {
        if (geometry instanceof Plane)
            return this.register_usage(WebGLGeometriesAdapter.PLANE_ID, intersect, sample);
        if (geometry instanceof Sphere)
            return this.register_usage(WebGLGeometriesAdapter.SPHERE_ID, intersect, sample);
        if (geometry instanceof Cylinder)
            return this.register_usage(WebGLGeometriesAdapter.CYLINDER_ID, intersect, sample);
        if (geometry instanceof UnitBox)
            return this.register_usage(WebGLGeometriesAdapter.UNITBOX_ID, intersect, sample);
        if (geometry instanceof Circle)
            return this.register_usage(WebGLGeometriesAdapter.CIRCLE_ID, intersect, sample);
        if (geometry instanceof Square)
            return this.register_usage(WebGLGeometriesAdapter.SQUARE_ID, intersect, sample);
        if (geometry instanceof OriginPoint)
            return this.register_usage(WebGLGeometriesAdapter.ORIGINPOINT_ID, intersect, sample);
        if (geometry instanceof UnitLine)
            return this.register_usage(WebGLGeometriesAdapter.UNITLINE_ID, intersect, sample);
        
        // Already registered: count the usage, but return the geometry's own id. (register_usage clamps every
        // triangle to the triangle type id, which is right for usage counting but would lose which triangle this is.)
        if (geometry.GEOMETRY_UID in this.id_map) {
            this.register_usage(this.id_map[geometry.GEOMETRY_UID], intersect, sample);
            return this.id_map[geometry.GEOMETRY_UID];
        }
        
        if (geometry instanceof Triangle) {
            // Very small triangles frequently cause precision issues in WebGL, so simply skip them as a band aid
            if (geometry.area < 0.00001)
                return 0;
            let cached = geometry._webglTriangleData;
            if (!cached || cached.generation !== this.triangle_data_generation) {
                cached = {
                    generation: this.triangle_data_generation,
                    entry: {
                        positions: geometry.ps.map(p => [p[0], p[1], p[2]]),
                        vertex_indices: (geometry.ps                                             ).map(p => this.triangle_data.store(p)),
                        normal_indices: (geometry.psdata.normal || Array(3).fill(geometry.normal)).map(v => this.triangle_data.store(v)),
                        uv_indices:     (geometry.psdata.UV     || Array(3).fill(Vec.of(0,0)    )).map(v => this.triangle_data.store(Vec.of(...v, 0)))
                    }
                };
                // Not enumerable, so it's never serialized with the scene.
                Object.defineProperty(geometry, "_webglTriangleData", { value: cached, writable: true, enumerable: false, configurable: true });
            }
            this.triangles.push(cached.entry);
            this.triangle_data_triangle_count = Math.max(this.triangle_data_triangle_count, this.triangles.length);
            this.id_map[geometry.GEOMETRY_UID] = this.geometries.length + 1;
            this.geometries.push(geometry);
            this.register_usage(WebGLGeometriesAdapter.MIN_TRIANGLE_ID, intersect, sample);
            return this.id_map[geometry.GEOMETRY_UID];
        }
        if (geometry instanceof SDFGeometry) {
            if (WebGLGeometriesAdapter.SDF_BLOCK_COUNT == this.sdf_geometries.length)
                throw "Too many SDFs for current WebGL configuration";
            this.geometries[this.id_map[geometry.GEOMETRY_UID] = WebGLGeometriesAdapter.MIN_SDF_ID + this.sdf_geometries.length] = geometry;
            this.sdf_geometries.push(geometry);
            this.sdf_adapter.visitSDFGeometry(geometry, webgl_helper, this);
            return this.register_usage(this.id_map[geometry.GEOMETRY_UID], intersect, sample);
        }
        throw "Unsupported geometry type";
    }
    getGeometry(index) {
        return this.geometries[index];
    }
    getMutableObjectProperties(index, renderer_adapter) {
        return (index >= WebGLGeometriesAdapter.MIN_SDF_ID && index < WebGLGeometriesAdapter.MIN_TRIANGLE_ID)
            ? this.sdf_adapter.getMutableObjectProperties(index - WebGLGeometriesAdapter.MIN_SDF_ID, renderer_adapter) : [];
    }
    writeShaderData(gl, program, webgl_helper) {
        // Write triangle data, as all other types need no data written for geometry. After an edit that left the
        // triangles alone (the same entries in the same order, and nothing new stored), the textures already hold the
        // right data for this program, so only the sampler uniforms are set.
        const unchanged = this.uploaded && this.uploaded.program === program
            && this.uploaded.dataSize === this.triangle_data.size()
            && this.uploaded.triangles.length === this.triangles.length
            && this.triangles.every((t, i) => t === this.uploaded.triangles[i]);
        if (unchanged) {
            for (const [unit, name] of [[this.triangle_data_texture_unit, "tTriangleData"], [this.triangle_indices_texture_unit, "tTriangleIndices"],
                                        [this.triangle_verts_texture_unit, "tTriangleVerts"]])
                gl.uniform1i(gl.getUniformLocation(program, name), WebGLHelper.textureUnitIndex(unit));
        }
        else {
            this.triangle_data_texture.setDataPixelsUnit(this.triangle_data.flat(), this.triangle_data_texture_unit, "tTriangleData", program);
            this.triangle_indices_texture.setDataPixelsUnit(
                this.triangles.map(t => [...t.vertex_indices, ...t.normal_indices, ...t.uv_indices]).flat(),
                this.triangle_indices_texture_unit, "tTriangleIndices", program);
            this.triangle_verts_texture.setDataPixelsUnit(
                this.triangles.map(t => t.positions).flat(2),
                this.triangle_verts_texture_unit, "tTriangleVerts", program);
            this.uploaded = { program: program, dataSize: this.triangle_data.size(), triangles: this.triangles.slice() };
        }
        this.sdf_adapter.writeShaderData(gl, program, webgl_helper);
    }
    
    
    getShaderSourceDeclarations(sceneEditable, needs_generics) {
        let ret = ShaderLibrary.render("geometries.glsl", "declarations", {
            minSdfId:      WebGLGeometriesAdapter.MIN_SDF_ID,
            minTriangleId: WebGLGeometriesAdapter.MIN_TRIANGLE_ID
        });
        const needed = this.neededModules();
        for (let [type_index, shader_src_module] of this.ShaderSourceModules.entries()) {
            const usage = needed[type_index];
            if (sceneEditable || usage.intersect || usage.sample)
                ret += "\n\n" + shader_src_module.getShaderSourceDeclarations(sceneEditable || usage.intersect, sceneEditable || usage.sample);
        }
        if (sceneEditable || needs_generics)
            ret += ShaderLibrary.render("geometries.glsl", "declarations.generics");
        return ret + "\n\n" + this.sdf_adapter.getShaderSourceDeclarations(sceneEditable);
    }
    // Which parts of each module's GLSL the shader needs: what the scene uses (geometry_usage_map), plus what those
    // parts call in other modules (their `requires`), whose intersection code and material data come along. Only the
    // code: the generic functions' switches still get cases for the types the scene actually uses.
    neededModules() {
        const needed = {};
        for (const [i, usage] of Object.entries(this.geometry_usage_map))
            needed[i] = { intersect: usage.intersect, sample: usage.sample };
        for (const [i, m] of this.ShaderSourceModules.entries()) {
            const usage = needed[i];
            if (!usage || !(usage.intersect || usage.sample))
                continue;
            for (const name of m.requires || []) {
                const j = this.ShaderSourceModules.findIndex(other => other.type_name === name);
                if (j < 0)
                    throw `Geometry ${m.type_name} requires unknown geometry ${name}`;
                needed[j].intersect = Math.max(needed[j].intersect, 1);
            }
        }
        return needed;
    }
    getShaderSource(sceneEditable, needs_generics) {
        let ret = ShaderLibrary.render("geometries.glsl", "helpers");
        const needed = this.neededModules();
        for (let [type_index, shader_src_module] of this.ShaderSourceModules.entries()) {
            const usage = needed[type_index];
            if (sceneEditable || usage.intersect || usage.sample)
                ret += "\n\n" + shader_src_module.getShaderSource(sceneEditable || usage.intersect, sceneEditable || usage.sample);
        }

        // The generic functions switch on the geometry type, with a case for each type the scene uses.
        const usage = this.geometry_usage_map, T = WebGLGeometriesAdapter.MIN_TRIANGLE_ID;
        const cases = (used, section, value) => WebGLGeometriesAdapter.SWITCHABLE_TYPES
            .filter(type_index => sceneEditable || used(usage[type_index]))
            .map(type_index => {
                const m = this.ShaderSourceModules[type_index];
                return ShaderLibrary.render("geometries.glsl", section, Object.assign({ type: m.src_type_name }, value(m, type_index)));
            }).join("");
        ret += ShaderLibrary.render("geometries.glsl", "generics.sampling", {
            sampleCases:     cases(u => u.sample, "case.return",
                (m, i) => ({ expression: m.getSampleSurfaceShaderSource(i, "random_seed") })),
            sampleDataCases: cases(u => u.sample, "case.statement",
                (m, i) => ({ statement: m.getMaterialDataShaderSource(i, "position", "direction", "data") }))
        });
        if (sceneEditable || needs_generics) {
            const triangles = sceneEditable || usage[T].intersect;
            ret += ShaderLibrary.render("geometries.glsl", "generics.dispatch", {
                intersectCases: cases(u => u.intersect, "case.return",
                    (m, i) => ({ expression: m.getIntersectShaderSource(i, "r", "minDistance") })),
                dataCases:      cases(u => u.intersect || u.sample, "case.statement",
                    (m, i) => ({ statement: m.getMaterialDataShaderSource(i, "position", "direction", "data") })),
                triangleIntersect: triangles ? ShaderLibrary.render("geometries.glsl", "generics.triangle-intersect") : "",
                triangleData:      triangles ? ShaderLibrary.render("geometries.glsl", "generics.triangle-data") : ""
            });
        }
        else
            ret += ShaderLibrary.render("geometries.glsl", "generics.none");
        return ret + this.sdf_adapter.getShaderSource();
    }
    
    
    getIntersectShaderSource(geometryID, ray_src, minDist_src) {
        const id = Math.min(geometryID, WebGLGeometriesAdapter.MIN_TRIANGLE_ID);
        if (id >= 0 && this.ShaderSourceModules[id].canIntersect())
            return this.ShaderSourceModules[id].getIntersectShaderSource(geometryID, ray_src, minDist_src);
        throw "Unsupported geometry type: " + geometryID;
    }
    getSampleSurfaceShaderSource(geometryID, random_seed_src) {
        const id = Math.min(geometryID, WebGLGeometriesAdapter.MIN_TRIANGLE_ID);
        if (id >= 0 && this.ShaderSourceModules[id].canSample())
            return this.ShaderSourceModules[id].getSampleSurfaceShaderSource(geometryID, random_seed_src);
        throw "Unsupported geometry type: " + geometryID;
    }
    getMaterialDataShaderSource(geometryID, position_src, direction_src, data_src) {
        const id = Math.min(geometryID, WebGLGeometriesAdapter.MIN_TRIANGLE_ID);
        if (id >= 0)
            return this.ShaderSourceModules[id].getMaterialDataShaderSource(geometryID, position_src, direction_src, data_src);
        throw "Unsupported geometry type: " + geometryID;
    }
}


class WebGLAbstractGeometryShaderSource {
    canIntersect() { return false; }
    canSample() { return false; }
    getShaderSourceDeclarations(include_intersect, include_sample) { return ""; }
    getShaderSource(include_intersect, include_sample) { return ""; }
    getIntersectShaderSource(geometryID, ray_src, minDist_src) { return `${minDist_src} - 1.0`; }
    getSampleSurfaceShaderSource(geometryID, random_seed_src) { return `vec4(0)`; }
    getMaterialDataShaderSource(geometryID, position_src, direction_src, data_src) { return ""; }
}

// A primitive whose GLSL is fixed: sections <type_name>.intersect, .sample and .material of geometries.glsl.
class WebGLStaticGeometryShaderSource extends WebGLAbstractGeometryShaderSource {
    static indent = "            ";
    constructor(type_name, { intersect, sample, materialNeedsDirection=false, requires=[] }) {
        super();
        this.type_name = type_name;
        this.src_type_name = `GEOMETRY_${this.type_name.toUpperCase()}_TYPE`;
        this.type_id = WebGLGeometriesAdapter[this.type_name.toUpperCase() + "_ID"];
        if (!this.type_id)
            throw "Something has gone very wrong...";
        this.has_intersect = intersect;
        this.has_sample = sample;
        this.mat_needs_dir = materialNeedsDirection;
        this.requires = requires;   // other modules whose GLSL this one calls (see WebGLGeometriesAdapter.neededModules)
    }
    canIntersect() { return this.has_intersect; }
    canSample() { return this.has_sample; }
    section(part) {
        return ShaderLibrary.render("geometries.glsl", `${this.type_name}.${part}`);
    }
    getShaderSourceDeclarations(include_intersect, include_sample) {
        return [((include_intersect || include_sample) &&  `#define ${this.src_type_name} ${this.type_id}`),
            (include_intersect && `float ${this.type_name}Intersect(in Ray r, in float minDistance);`),
            (include_sample    && `vec4 ${this.type_name}SurfaceSample(inout vec2 random_seed);`),
            ((include_intersect || include_sample) && `void ${this.type_name}MaterialData(in vec4 position,`
                + `${this.mat_needs_dir ? " in vec4 direction," : "" }inout GeometricMaterialData data);`)]
                .filter(v => v).map(v => WebGLStaticGeometryShaderSource.indent + v).join("\n");
    }
    getShaderSource(include_intersect, include_sample) {
        return WebGLStaticGeometryShaderSource.indent + `// ---------- ${this.type_name} ----------`
            + (include_intersect && this.has_intersect ? this.section("intersect") + "\n" : "")
            + (include_sample && this.has_sample ? this.section("sample") + "\n" : "")
            + ((include_intersect || include_sample) ? this.section("material") : "");
    }
    getIntersectShaderSource(geometryID, ray_src, minDist_src) {
        if (this.has_intersect)
            return `${this.type_name}Intersect(${ray_src}, ${minDist_src})`;
        else
            return `${minDist_src} - 1.0`;
    }
    getSampleSurfaceShaderSource(geometryID, random_seed_src) {
        if (this.has_sample)
            return `${this.type_name}SurfaceSample( ${random_seed_src})`;
        else
            return `vec4(0)`;
    }
    getMaterialDataShaderSource(geometryID, position_src, direction_src, data_src) {
        return `${this.type_name}MaterialData(${position_src},${this.mat_needs_dir ? direction_src + "," : ""} ${data_src})`;
    }
}

class WebGLSDFGeometryShaderSource extends WebGLAbstractGeometryShaderSource  {
    canIntersect() { return true; }
    getIntersectShaderSource(geometryID, ray_src, minDist_src) {
        return `sdfIntersect(${ray_src}, ${minDist_src}, ${geometryID - WebGLGeometriesAdapter.MIN_SDF_ID})`;
    }
    getMaterialDataShaderSource(geometryID, position_src, direction_src, data_src) {
        return `sdfMaterialData(${position_src}, ${data_src}, ${geometryID - WebGLGeometriesAdapter.MIN_SDF_ID})`;
    }
}

class WebGLTriangleGeometryShaderSource extends WebGLAbstractGeometryShaderSource  {
    canIntersect() {
        return true;
    }
    getShaderSourceDeclarations(include_intersect, include_sample) {
        return ShaderLibrary.render("geometries.glsl", "triangle.declarations");
    }
    getShaderSource(include_intersect, include_sample) {
        return ShaderLibrary.render("geometries.glsl", "triangle.source");
    }
    getIntersectShaderSource(geometryID, ray_src, minDist_src) {
        return `triangleIntersect(${ray_src}, ${minDist_src}, ${geometryID - WebGLGeometriesAdapter.MIN_TRIANGLE_ID})`;
    }
    getMaterialDataShaderSource(geometryID, position_src, direction_src, data_src) {
        return `triangleMaterialData(${position_src}, ${data_src}, ${geometryID - WebGLGeometriesAdapter.MIN_TRIANGLE_ID})`;
    }
}














