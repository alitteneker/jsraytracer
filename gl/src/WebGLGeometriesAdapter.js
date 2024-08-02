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
        if (type >= WebGLGeometriesAdapter.MIN_SDF_ID && type - WebGLGeometriesAdapter.MIN_SDF_ID < WebGLGeometriesAdapter.SDF_BLOCK_COUNT)
            return "SDF: " + (type - WebGLGeometriesAdapter.MIN_SDF_ID + 1);
        if (type >= WebGLGeometriesAdapter.MIN_TRIANGLE_ID)
            return "Triangle";
        return "Unknown";
    }
    
    
    constructor(webgl_helper) {
        [this.triangle_data_texture_unit,    this.triangle_data_texture]    = webgl_helper.createDataTextureAndUnit(3, "FLOAT");
        [this.triangle_indices_texture_unit, this.triangle_indices_texture] = webgl_helper.createDataTextureAndUnit(3, "INTEGER");
        
        this.sdf_adapter = new WebGLSDFAdapter();
        
        this.triangle_data = new WebGLVecStore();
        this.reset();
        
        
        
        this.ShaderSourceModules = [
        // null
        new WebGLAbstractGeometryShaderSource(),
        
        // plane
        new WebGLStaticGeometryShaderSource("plane", `
            float planeIntersect(in Ray r, in float minDistance) {
                return planeIntersect(r, minDistance, vec4(0, 0, 1, 0), 0.0);
            }`,
            "", `
            void planeMaterialData(in vec4 position, inout GeometricMaterialData data) {
                data.normal = vec4(0, 0, 1, 0);
                data.UV = vec2(position.x, position.y);
            }`),
        
        // sphere
        new WebGLStaticGeometryShaderSource("sphere", `
            float sphereIntersect(in Ray r, in float minDistance) {
                float a = dot(r.d, r.d),
                      b = dot(r.o, r.d),
                      c = dot(r.o.xyz, r.o.xyz) - 1.0;
                float big = b * b - a * c;
                if (big < 0.0 || a == 0.0)
                    return minDistance - 1.0;
                big = sqrt(big);
                float t1 = (-b + big) / a,
                      t2 = (-b - big) / a;
                if (t1 >= minDistance && t2 >= minDistance)
                    return min(t1, t2);
                return (t2 < minDistance) ? t1 : t2;
            }`, `
            vec4 sphereSurfaceSample(inout vec2 random_seed) {
                return vec4(randomSpherePoint(random_seed), 1);
            }`, `
            void sphereMaterialData(in vec4 position, inout GeometricMaterialData data) {
                data.normal = vec4(normalize(position.xyz), 0);
                data.UV.x = 0.5 + atan(data.normal.z, data.normal.x) / (2.0 * PI);
                data.UV.y = 0.5 - asin(data.normal.y) / PI;
            }`),
        
        // unit box
        new WebGLStaticGeometryShaderSource("unitBox", `
            float unitBoxIntersect(in Ray r, in float minDistance) {
                vec2 t = AABBIntersects(r, vec4(0,0,0,1), vec4(0.5, 0.5, 0.5, 0), minDistance, 1e20);
                return (!isinf(t.x) && t.x >= minDistance) ? t.x : t.y;
            }`,
            "", `
            void unitBoxMaterialData(in vec4 p, inout GeometricMaterialData data) {
                float norm_dist = 0.0;
                data.normal = vec4(0.0);
                for (int i = 0; i < 3; ++i) {
                    float comp = p[i] / 0.5;
                    float abs_comp = abs(comp);
                    if (abs_comp > norm_dist) {
                        norm_dist = abs_comp;
                        data.normal = vec4(0.0);
                        data.normal[i] = sign(comp);
                    }
                }
                
                // TODO: what to do about UV?
            }`),
        
        // circle
        new WebGLStaticGeometryShaderSource("circle", `
            float circleIntersect(in Ray r, in float minDistance) {
                float t = planeIntersect(r, minDistance);
                if (t < minDistance)
                    return t;
                vec4 p = r.o + t * r.d;
                return (dot(p.xy, p.xy) <= 1.0) ? t : (minDistance - 1.0);
            }`,
            "", `
            void circleMaterialData(in vec4 position, inout GeometricMaterialData data) {
                planeMaterialData(position, data);
            }`),
        
        // square
        new WebGLStaticGeometryShaderSource("square", `
            float squareIntersect(in Ray r, in float minDistance) {
                float t = planeIntersect(r, minDistance);
                if (t < minDistance)
                    return t;
                vec4 p = r.o + t * r.d;
                return all(lessThanEqual(abs(p.xy), vec2(0.5))) ? t : (minDistance - 1.0);
            }`, `
            vec4 squareSurfaceSample(inout vec2 random_seed) {
                return vec4(randf(random_seed) - 0.5, randf(random_seed) - 0.5, 0, 1);
            }`, `
            void squareMaterialData(in vec4 position, inout GeometricMaterialData data) {
                planeMaterialData(position, data);
                data.UV += vec2(0.5);
            }`),
        
        // cylinder
        new WebGLStaticGeometryShaderSource("cylinder", `
            float cylinderIntersect(in Ray r, in float minDistance) {
                float cylMinDistance = minDistance;
                if (abs(r.o.z) > 1.0 && r.d.z != 0.0)
                    cylMinDistance = max(minDistance, -(r.o.z - sign(r.o.z)) / r.d.z);
                float t = sphereIntersect(Ray(r.o * vec4(1,1,0,1), r.d * vec4(1,1,0,1)), cylMinDistance);
                return (abs(r.o.z + t * r.d.z) <= 1.0) ? t : minDistance - 1.0;
            }`,
            "", `
            void cylinderMaterialData(in vec4 position, inout GeometricMaterialData data) {
                data.normal = vec4(normalize(position.xy), 0, 0);
                data.UV.x = 0.5 + atan(position.y, position.x) / (2.0 * PI),
                data.UV.y = 0.5 + position.z;
            }`),
        
        // origin point
        new WebGLStaticGeometryShaderSource("originPoint", ``, `
            vec4 originPointSurfaceSample(inout vec2 random_seed) {
                return vec4(0,0,0,1);
            }`, `
            void originPointMaterialData(in vec4 position, in vec4 direction, inout GeometricMaterialData data) {
                data.normal = normalize(-direction);
                data.UV.x = 0.5 + atan(data.normal.z, data.normal.x) / (2.0 * PI);
                data.UV.y = 0.5 - asin(data.normal.y) / PI;
            }`, true),
        
        // unit line
        new WebGLStaticGeometryShaderSource("unitLine", ``, `
            vec4 unitLineSurfaceSample(inout vec2 random_seed) {
                return vec4(0, randf(random_seed) - 0.5, 0, 1);
            }`, `
            void unitLineMaterialData(in vec4 position, in vec4 direction, inout GeometricMaterialData data) {
                vec2 n = normalize(-direction.xz);
                
                data.normal = vec4(n.x, 0, n.y, 0);
                data.UV.x = 0.5 + atan(n.y, n.x) / (2.0 * PI),
                data.UV.y = 0.5 + position.y;
            }`, true),
        
        // sdfs
        ...new Array(WebGLGeometriesAdapter.SDF_BLOCK_COUNT).fill(new WebGLSDFGeometryShaderSource()),
        
        // triangle
        new WebGLTriangleGeometryShaderSource()];
    }
    reset() {
        this.geometry_usage_map = {};
        for (let i = 0; i <= WebGLGeometriesAdapter.MIN_TRIANGLE_ID; ++i)
            this.geometry_usage_map[i] = { intersect: 0, sample: 0 };
        
        this.geometries = [ new Plane(), new Sphere(), new UnitBox(), new Circle(), new Square(), new Cylinder(), new OriginPoint(), new UnitLine() ].concat(Array(WebGLGeometriesAdapter.SDF_BLOCK_COUNT).fill(null));
        this.id_map = {};
        
        this.sdf_geometries = [];
        this.sdf_adapter.reset();
        
        this.triangle_data.clear();
        this.triangles = [];
    }
    destroy(gl) {
        this.triangle_data_texture.destroy();
        this.triangle_indices_texture.destroy();
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
        
        if (geometry.GEOMETRY_UID in this.id_map)
            return this.register_usage(this.id_map[geometry.GEOMETRY_UID], intersect, sample);
        
        if (geometry instanceof Triangle) {
            // Very small triangles frequently cause precision issues in WebGL, so simply skip them as a band aid
            if (geometry.area < 0.00001)
                return 0;
            this.triangles.push({
                vertex_indices: (geometry.ps                                             ).map(p => this.triangle_data.store(p)),
                normal_indices: (geometry.psdata.normal || Array(3).fill(geometry.normal)).map(v => this.triangle_data.store(v)),
                uv_indices:     (geometry.psdata.UV     || Array(3).fill(Vec.of(0,0)    )).map(v => this.triangle_data.store(Vec.of(...v, 0)))
            });
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
        // Write triangle data, as all other types need no data written for geometry
        this.triangle_data_texture.setDataPixelsUnit(this.triangle_data.flat(), this.triangle_data_texture_unit, "tTriangleData", program);
        this.triangle_indices_texture.setDataPixelsUnit(
            this.triangles.map(t => [...t.vertex_indices, ...t.normal_indices, ...t.uv_indices]).flat(),
            this.triangle_indices_texture_unit, "tTriangleIndices", program);
        this.sdf_adapter.writeShaderData(gl, program, webgl_helper);
    }
    
    
    getShaderSourceDeclarations(sceneEditable, needs_generics) {
        let ret = `
            #define GEOMETRY_SDF_MIN_INDEX ${WebGLGeometriesAdapter.MIN_SDF_ID}
            #define GEOMETRY_TRIANGLE_MIN_INDEX ${WebGLGeometriesAdapter.MIN_TRIANGLE_ID}
            
            struct GeometricMaterialData {
                vec3 baseColor;
                vec4 normal;
                vec2 UV;
            };
            
            uniform sampler2D tTriangleData;
            uniform isampler2D tTriangleIndices;
            
            float planeIntersect(in Ray r, in float minDistance, in vec4 n, in float delta);
            vec2 AABBIntersects(in Ray r, in vec4 center, in vec4 half_size, in float minDistance, in float maxDistance);
            
            vec4 sampleGeometrySurface(in int geometryID, inout vec2 random_seed);
            float geometryIntersect(in int geometryID, in Ray r, in float minDistance);
            GeometricMaterialData getGeometricMaterialData(in int geometryID, in vec4 position, in vec4 direction);
            GeometricMaterialData getSampleGeometricMaterialData(in int geometryID, in vec4 position, in vec4 direction);`;
        for (let [type_index, shader_src_module] of this.ShaderSourceModules.entries()) {
            const usage = this.geometry_usage_map[type_index];
            if (sceneEditable || usage.intersect || usage.sample)
                ret += "\n\n" + shader_src_module.getShaderSourceDeclarations(sceneEditable || usage.intersect, sceneEditable || usage.sample);
        }
        if (sceneEditable || needs_generics)
            ret += `
            float geometryIntersect(in int geometryID, in Ray r, in float minDistance);
            vec4 sampleGeometrySurface(in int geometryID, inout vec2 random_seed);`;
        return ret + "\n\n" + this.sdf_adapter.getShaderSourceDeclarations();
    }
    getShaderSource(sceneEditable, needs_generics) {
        let ret = `
            float planeIntersect(in Ray r, in float minDistance, in vec4 n, in float delta) {
                float denom = dot(r.d, n);
                if (abs(denom) < EPSILON)
                    return minDistance - 1.0;
                return (delta - dot(r.o, n)) / denom;
            }
            vec2 AABBIntersects(in Ray r, in vec4 center, in vec4 half_size, in float minDistance, in float maxDistance) {
                float t_min = minDistance - 1.0, t_max = maxDistance + 1.0;
                vec4 p = center - r.o;
                for (int i = 0; i < 3; ++i) {
                    if (abs(r.d[i]) > EPSILON) {
                        float t1 = (p[i] + half_size[i]) / r.d[i],
                              t2 = (p[i] - half_size[i]) / r.d[i];
                        if (t1 > t2) {
                            float tmp = t1;
                            t1 = t2;
                            t2 = tmp;
                        }
                        if (t1 > t_min)
                            t_min = t1;
                        if (t2 < t_max)
                            t_max = t2;
                        if (t_min > t_max || t_max < minDistance || t_min > maxDistance)
                            return vec2(minDistance - 1.0, minDistance - 1.0); //TODO: this needs to be infinite
                    }
                    else if (abs(p[i]) > half_size[i])
                        return vec2(minDistance - 1.0, minDistance - 1.0);
                }
                return vec2(t_min, t_max);
            }`;
            
        for (let [type_index, shader_src_module] of this.ShaderSourceModules.entries()) {
            const usage = this.geometry_usage_map[type_index];
            if (sceneEditable || usage.intersect || usage.sample)
            ret += "\n\n" + shader_src_module.getShaderSource(sceneEditable || usage.intersect, sceneEditable || usage.sample);
        }
        ret += `
        
        
        
            // ---------- Generics ----------
            vec4 sampleGeometrySurface(in int geometryID, inout vec2 random_seed) {
                switch(geometryID) {`;
        for (let type_index of WebGLGeometriesAdapter.SWITCHABLE_TYPES) {
            const shader_src_module = this.ShaderSourceModules[type_index];
            if (this.geometry_usage_map[type_index].sample)
                ret += `
                    case ${shader_src_module.src_type_name}: return ${shader_src_module.getSampleSurfaceShaderSource(type_index, "random_seed")}; break;`;
            }
        ret += `
                }
                return vec4(0);
            }
            GeometricMaterialData getSampleGeometricMaterialData(in int geometryID, in vec4 position, in vec4 direction) {
                GeometricMaterialData data;
                data.baseColor = vec3(1.0);
                switch(geometryID) {`;
        for (let type_index of WebGLGeometriesAdapter.SWITCHABLE_TYPES) {
            const shader_src_module = this.ShaderSourceModules[type_index];
            if (this.geometry_usage_map[type_index].sample)
                ret += `
                    case ${shader_src_module.src_type_name}: ${shader_src_module.getMaterialDataShaderSource(type_index, "position", "direction", "data")}; break;`;
            }
        ret += `
                }
                return data;
            }`;
        if (sceneEditable || needs_generics) {
            ret += `
            float geometryIntersect(in int geometryID, in Ray r, in float minDistance) {
                if (geometryID < GEOMETRY_SDF_MIN_INDEX) {
                    switch(geometryID) {`
            for (let type_index of WebGLGeometriesAdapter.SWITCHABLE_TYPES) {
                const shader_src_module = this.ShaderSourceModules[type_index];
                if (this.geometry_usage_map[type_index].intersect)
                    ret += `
                        case ${shader_src_module.src_type_name}: return ${shader_src_module.getIntersectShaderSource(type_index, "r", "minDistance")}; break;`;
            }
            ret += `
                        default: return minDistance - 1.0;
                    }
                }
                else {
                    if (geometryID < GEOMETRY_TRIANGLE_MIN_INDEX)
                        return sdfIntersect(r, minDistance, geometryID - GEOMETRY_SDF_MIN_INDEX);`;
            if (this.geometry_usage_map[WebGLGeometriesAdapter.MIN_TRIANGLE_ID].intersect)
                ret += `
                    else
                        return triangleIntersect(r, minDistance, geometryID - GEOMETRY_TRIANGLE_MIN_INDEX);`
            ret += `
                }
                return minDistance - 1.0;
            }
            GeometricMaterialData getGeometricMaterialData(in int geometryID, in vec4 position, in vec4 direction) {
                GeometricMaterialData data;
                data.baseColor = vec3(1.0);
                if (geometryID < GEOMETRY_SDF_MIN_INDEX) {
                    switch(geometryID) {`
            for (let type_index of WebGLGeometriesAdapter.SWITCHABLE_TYPES) {
                const shader_src_module = this.ShaderSourceModules[type_index];
                if (this.geometry_usage_map[type_index].intersect || this.geometry_usage_map[type_index].sample)
                    ret += `
                        case ${shader_src_module.src_type_name}: ${shader_src_module.getMaterialDataShaderSource(type_index, "position", "direction", "data")}; break;`;
            }
            ret += `
                    }
                }
                else {
                    if (geometryID < GEOMETRY_TRIANGLE_MIN_INDEX)
                        sdfMaterialData(position, data, geometryID - GEOMETRY_SDF_MIN_INDEX);`
            if (this.geometry_usage_map[WebGLGeometriesAdapter.MIN_TRIANGLE_ID].intersect)
                ret += `
                    else
                        triangleMaterialData(position, data, geometryID - GEOMETRY_TRIANGLE_MIN_INDEX);`
            ret += `
                }
                return data;
            }`;
        }
        else {
            ret += `
            GeometricMaterialData getGeometricMaterialData(in int geometryID, in vec4 position, in vec4 direction) {
                GeometricMaterialData data;
                data.baseColor = vec3(1.0);
                return data;
            }
            float geometryIntersect(in int geometryID, in Ray r, in float minDistance) {
                return minDistance - 1.0;
            }`;
        }
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

class WebGLStaticGeometryShaderSource extends WebGLAbstractGeometryShaderSource {
    static indent = "            ";
    constructor(type_name, intersect_src, sample_src, material_data_src, material_needs_direction=false) {
        super();
        this.type_name = type_name;
        this.src_type_name = `GEOMETRY_${this.type_name.toUpperCase()}_TYPE`;
        this.type_id = WebGLGeometriesAdapter[this.type_name.toUpperCase() + "_ID"];
        if (!this.type_id)
            throw "Something has gone very wrong...";
        this.intersect_src = intersect_src;
        this.sample_src = sample_src;
        this.material_data_src = material_data_src;
        this.mat_needs_dir = material_needs_direction;
    }
    canIntersect() { return !!this.intersect_src; }
    canSample() { return !!this.sample_src; }
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
            + (include_intersect ? this.intersect_src + "\n" : "")
            + (include_sample ? this.sample_src + "\n" : "")
            + ((include_intersect || include_sample) ? this.material_data_src : "");
    }
    getIntersectShaderSource(geometryID, ray_src, minDist_src) {
        if (this.intersect_src)
            return `${this.type_name}Intersect(${ray_src}, ${minDist_src})`;
        else
            return `${minDist_src} - 1.0`;
    }
    getSampleSurfaceShaderSource(geometryID, random_seed_src) {
        if (this.sample_src)
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
        return `
            float triangleIntersect(in Ray r, in float minDistance, in int triangleID);
            void triangleMaterialData(in vec4 position, inout GeometricMaterialData data, in int triangleID);`;
    }
    getShaderSource(include_intersect, include_sample) {
        return `
            vec3 getTriangleData(in int index) {
                return texelFetchByIndex(index, tTriangleData).rgb;
            }
            ivec3 getTriangleIndices(in int triangleID, in int dataOffset) {
                return itexelFetchByIndex(triangleID * 3 + dataOffset, tTriangleIndices).rgb;
            }
            void getTriangleVertices(in int triangleID, out vec4 p1, out vec4 p2, out vec4 p3) {
                ivec3 indices = getTriangleIndices(triangleID, 0);
                p1 = vec4(getTriangleData(indices[0]), 1);
                p2 = vec4(getTriangleData(indices[1]), 1);
                p3 = vec4(getTriangleData(indices[2]), 1);
            }
            void getTriangleNormals(in int triangleID, out vec4 n1, out vec4 n2, out vec4 n3) {
                ivec3 indices = getTriangleIndices(triangleID, 1);
                n1 = vec4(getTriangleData(indices[0]), 0);
                n2 = vec4(getTriangleData(indices[1]), 0);
                n3 = vec4(getTriangleData(indices[2]), 0);
            }
            void getTriangleUVs(in int triangleID, out vec2 uv1, out vec2 uv2, out vec2 uv3) {
                ivec3 indices = getTriangleIndices(triangleID, 2);
                uv1 = vec2(getTriangleData(indices[0]).xy);
                uv2 = vec2(getTriangleData(indices[1]).xy);
                uv3 = vec2(getTriangleData(indices[2]).xy);
            }
            float baryBlend(in vec3 bary, in float v1, in float v2, in float v3) {
                return (bary.x * v1) + (bary.y * v2) + (bary.z * v3);
            }
            vec2 baryBlend(in vec3 bary, in vec2 v1, in vec2 v2, in vec2 v3) {
                return (bary.x * v1) + (bary.y * v2) + (bary.z * v3);
            }
            vec3 baryBlend(in vec3 bary, in vec3 v1, in vec3 v2, in vec3 v3) {
                return (bary.x * v1) + (bary.y * v2) + (bary.z * v3);
            }
            vec4 baryBlend(in vec3 bary, in vec4 v1, in vec4 v2, in vec4 v3) {
                return (bary.x * v1) + (bary.y * v2) + (bary.z * v3);
            }
            vec3 triangleToBarycentric(in vec4 point, in vec4 p1, in vec4 p2, in vec4 p3) {
                vec4 v0 = p2 - p1,
                     v1 = p3 - p1,
                     v2 = point - p1;
                float d00 = dot(v0, v0),
                      d11 = dot(v1, v1),
                      d01 = dot(v0, v1),
                      d20 = dot(v2, v0),
                      d21 = dot(v2, v1),
                      denom = d00 * d11 - d01 * d01,
                      v = (d11 * d20 - d01 * d21) / denom,
                      w = (d00 * d21 - d01 * d20) / denom;
                return vec3(1.0 - v - w, v, w);
            }
            float triangleIntersect(in Ray r, in float minDistance, in vec4 p1, in vec4 p2, in vec4 p3) {
                vec4 normal = vec4(normalize(cross(vec3((p2 - p1).xyz), vec3((p3 - p1).xyz))), 0.0);
                float distance = planeIntersect(r, minDistance, normal, dot(p1, normal));
                if (distance < minDistance)
                    return distance;
                vec3 bary = triangleToBarycentric(r.o + (distance * r.d), p1, p2, p3);
                if (all(greaterThanEqual(bary, vec3(0.0))) && all(lessThanEqual(bary, vec3(1.0))))
                    return distance;
                return minDistance - 1.0;
            }
            float triangleIntersect(in Ray r, in float minDistance, in int triangleID) {
                vec4 p1, p2, p3;
                getTriangleVertices(triangleID, p1, p2, p3);
                return triangleIntersect(r, minDistance, p1, p2, p3);
            }
            void triangleMaterialData(in vec4 position, inout GeometricMaterialData data, in int triangleID) {
                vec4 p1, p2, p3, n1, n2, n3;
                vec2 uv1, uv2, uv3;
                getTriangleVertices(triangleID,  p1,  p2,  p3);
                getTriangleNormals( triangleID,  n1,  n2,  n3);
                getTriangleUVs(     triangleID, uv1, uv2, uv3);
                
                vec3 bary = triangleToBarycentric(position, p1, p2, p3);
                
                data.normal = baryBlend(bary,  n1,  n2,  n3);
                data.UV     = baryBlend(bary, uv1, uv2, uv3);
            }
        `;
    }
    getIntersectShaderSource(geometryID, ray_src, minDist_src) {
        return `triangleIntersect(${ray_src}, ${minDist_src}, ${geometryID - WebGLGeometriesAdapter.MIN_TRIANGLE_ID})`;
    }
    getMaterialDataShaderSource(geometryID, position_src, direction_src, data_src) {
        return `triangleMaterialData(${position_src}, ${data_src}, ${geometryID - WebGLGeometriesAdapter.MIN_TRIANGLE_ID})`;
    }
}














