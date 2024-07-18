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
        if (type == WebGLGeometriesAdapter.NULL_ID)
            return "Null";
        if (type == WebGLGeometriesAdapter.PLANE_ID)
            return "Plane";
        if (type == WebGLGeometriesAdapter.SPHERE_ID)
            return "Sphere";
        if (type == WebGLGeometriesAdapter.UNITBOX_ID)
            return "UnitBox";
        if (type == WebGLGeometriesAdapter.CIRCLE_ID)
            return "Circle";
        if (type == WebGLGeometriesAdapter.SQUARE_ID)
            return "Square";
        if (type == WebGLGeometriesAdapter.CYLINDER_ID)
            return "Cylinder";
        if (type == WebGLGeometriesAdapter.ORIGINPOINT_ID)
            return "OriginPoint";
        if (type == WebGLGeometriesAdapter.UNITLINE_ID)
            return "UnitLine";
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
    }
    reset() {
        this.geometry_usage_map = {};
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
    register_usage(ID) {
        if (!(ID in this.geometry_usage_map))
            this.geometry_usage_map[ID] = 1;
        else
            ++this.geometry_usage_map[ID];
        return ID;
    }
    visit(geometry, webgl_helper) {
        if (geometry instanceof Plane)
            return this.register_usage(WebGLGeometriesAdapter.PLANE_ID);
        if (geometry instanceof Sphere)
            return this.register_usage(WebGLGeometriesAdapter.SPHERE_ID);
        if (geometry instanceof Cylinder)
            return this.register_usage(WebGLGeometriesAdapter.CYLINDER_ID);
        if (geometry instanceof UnitBox)
            return this.register_usage(WebGLGeometriesAdapter.UNITBOX_ID);
        if (geometry instanceof Circle)
            return this.register_usage(WebGLGeometriesAdapter.CIRCLE_ID);
        if (geometry instanceof Square)
            return this.register_usage(WebGLGeometriesAdapter.SQUARE_ID);
        if (geometry instanceof OriginPoint)
            return this.register_usage(WebGLGeometriesAdapter.ORIGINPOINT_ID);
        if (geometry instanceof UnitLine)
            return this.register_usage(WebGLGeometriesAdapter.UNITLINE_ID);
        
        if (geometry.GEOMETRY_UID in this.id_map)
            return this.register_usage(this.id_map[geometry.GEOMETRY_UID]);
        
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
            this.register_usage(WebGLGeometriesAdapter.MIN_TRIANGLE_ID);
            return this.id_map[geometry.GEOMETRY_UID];
        }
        if (geometry instanceof SDFGeometry) {
            if (WebGLGeometriesAdapter.SDF_BLOCK_COUNT == this.sdf_geometries.length)
                throw "Too many SDFs for current WebGL configuration";
            this.geometries[this.id_map[geometry.GEOMETRY_UID] = WebGLGeometriesAdapter.MIN_SDF_ID + this.sdf_geometries.length] = geometry;
            this.sdf_geometries.push(geometry);
            this.sdf_adapter.visitSDFGeometry(geometry, webgl_helper, this);
            return this.register_usage(this.id_map[geometry.GEOMETRY_UID]);
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
    getShaderSourceDeclarations(sceneEditable) {
        return `
            #define GEOMETRY_TRIANGLE_MIN_INDEX ${WebGLGeometriesAdapter.MIN_TRIANGLE_ID}
            struct GeometricMaterialData {
                vec3 baseColor;
                vec4 normal;
                vec2 UV;
            };
            
            float planeIntersect(in Ray r, in float minDistance);
            float squareIntersect(in Ray r, in float minDistance);
            float circleIntersect(in Ray r, in float minDistance);
            float unitBoxIntersect(in Ray r, in float minDistance);
            float unitSphereIntersect(in Ray r, in float minDistance);
            float cylinderIntersect(in Ray r, in float minDistance);
            float triangleIntersect(in Ray r, in float minDistance, in int triangleID);
            
            float geometryIntersect(in int geometryID, in Ray r, in float minDistance);
            GeometricMaterialData getGeometricMaterialData(in int geometryID, in vec4 position, in vec4 direction);
            vec4 sampleGeometrySurface(in int geometryID, inout vec2 random_seed);
            vec2 AABBIntersects(in Ray r, in vec4 center, in vec4 half_size, in float minDistance, in float maxDistance);`
            + this.sdf_adapter.getShaderSourceDeclarations();
    }
    getShaderSource(sceneEditable) {
        return `
            // ---- Plane ----
            #define GEOMETRY_PLANE_TYPE ${WebGLGeometriesAdapter.PLANE_ID}
            float planeIntersect(in Ray r, in float minDistance, in vec4 n, in float delta) {
                float denom = dot(r.d, n);
                if (abs(denom) < EPSILON)
                    return minDistance - 1.0;
                return (delta - dot(r.o, n)) / denom;
            }
            float planeIntersect(in Ray r, in float minDistance) {
                return planeIntersect(r, minDistance, vec4(0, 0, 1, 0), 0.0);
            }
            void planeMaterialData(in vec4 position, inout GeometricMaterialData data) {
                data.normal = vec4(0, 0, 1, 0);
                data.UV = vec2(position.x, position.y);
            }
            
            
            // ---- Square ----
            #define GEOMETRY_SQUARE_TYPE ${WebGLGeometriesAdapter.SQUARE_ID}
            float squareIntersect(in Ray r, in float minDistance) {
                float t = planeIntersect(r, minDistance);
                if (t < minDistance)
                    return t;
                vec4 p = r.o + t * r.d;
                return all(lessThanEqual(abs(p.xy), vec2(0.5))) ? t : (minDistance - 1.0);
            }
            vec4 squareSurfaceSample(inout vec2 random_seed) {
                return vec4(randf(random_seed) - 0.5, randf(random_seed) - 0.5, 0, 1);
            }
            void squareMaterialData(in vec4 position, inout GeometricMaterialData data) {
                planeMaterialData(position, data);
                data.UV += vec2(0.5);
            }
            
            
            // ---- Circle ----
            #define GEOMETRY_CIRCLE_TYPE ${WebGLGeometriesAdapter.CIRCLE_ID}
            float circleIntersect(in Ray r, in float minDistance) {
                float t = planeIntersect(r, minDistance);
                if (t < minDistance)
                    return t;
                vec4 p = r.o + t * r.d;
                return (dot(p.xy, p.xy) <= 1.0) ? t : (minDistance - 1.0);
            }
            void circleMaterialData(in vec4 position, inout GeometricMaterialData data) {
                planeMaterialData(position, data);
            }
            
            
            // ---- ORIGINPOINT ----
            #define GEOMETRY_ORIGINPOINT_TYPE ${WebGLGeometriesAdapter.ORIGINPOINT_ID}
            vec4 originPointSurfaceSample(inout vec2 random_seed) {
                return vec4(0,0,0,1);
            }
            void originPointMaterialData(in vec4 position, in vec4 direction, inout GeometricMaterialData data) {
                data.normal = normalize(-direction);
                data.UV.x = 0.5 + atan(data.normal.z, data.normal.x) / (2.0 * PI);
                data.UV.y = 0.5 - asin(data.normal.y) / PI;
            }
            
            
            // ---- UNITLINE ----
            #define GEOMETRY_UNITLINE_TYPE ${WebGLGeometriesAdapter.UNITLINE_ID}
            vec4 unitLineSurfaceSample(inout vec2 random_seed) {
                return vec4(0, randf(random_seed) - 0.5, 0, 1);
            }
            void unitLineMaterialData(in vec4 position, in vec4 direction, inout GeometricMaterialData data) {
                vec2 n = normalize(-direction.xz);
                
                data.normal = vec4(n.x, 0, n.y, 0);
                data.UV.x = 0.5 + atan(n.y, n.x) / (2.0 * PI),
                data.UV.y = 0.5 + position.y;
            }


            // ---- Sphere ----
            #define GEOMETRY_SPHERE_TYPE ${WebGLGeometriesAdapter.SPHERE_ID}
            float unitSphereIntersect(in Ray r, in float minDistance) {
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
            }
            vec4 unitSphereSurfaceSample(inout vec2 random_seed) {
                return vec4(randomSpherePoint(random_seed), 1);
            }
            void unitSphereMaterialData(in vec4 position, inout GeometricMaterialData data) {
                data.normal = vec4(normalize(position.xyz), 0);
                data.UV.x = 0.5 + atan(data.normal.z, data.normal.x) / (2.0 * PI);
                data.UV.y = 0.5 - asin(data.normal.y) / PI;
            }
            
            
            // ---- Cylinder ----
            #define GEOMETRY_CYLINDER_TYPE ${WebGLGeometriesAdapter.CYLINDER_ID}
            float cylinderIntersect(in Ray r, in float minDistance) {
                float cylMinDistance = minDistance;
                if (abs(r.o.z) > 1.0 && r.d.z != 0.0)
                    cylMinDistance = max(minDistance, -(r.o.z - sign(r.o.z)) / r.d.z);
                float t = unitSphereIntersect(Ray(r.o * vec4(1,1,0,1), r.d * vec4(1,1,0,1)), cylMinDistance);
                return (abs(r.o.z + t * r.d.z) <= 1.0) ? t : minDistance - 1.0;
            }

            void cylinderMaterialData(in vec4 position, inout GeometricMaterialData data) {
                data.normal = vec4(normalize(position.xy), 0, 0);
                data.UV.x = 0.5 + atan(position.y, position.x) / (2.0 * PI),
                data.UV.y = 0.5 + position.z;
            }


            // ---- Unit Box ----
            #define GEOMETRY_UNITBOX_TYPE ${WebGLGeometriesAdapter.UNITBOX_ID}
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
            }
            float unitBoxIntersect(in Ray r, in float minDistance) {
                vec2 t = AABBIntersects(r, vec4(0,0,0,1), vec4(0.5, 0.5, 0.5, 0), minDistance, 1e20);
                return (!isinf(t.x) && t.x >= minDistance) ? t.x : t.y;
            }
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
            }


            // ---- Triangle ----
            uniform sampler2D tTriangleData;
            vec3 getTriangleData(in int index) {
                return texelFetchByIndex(index, tTriangleData).rgb;
            }
            
            uniform isampler2D tTriangleIndices;
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
            
            #define GEOMETRY_SDF_MIN_INDEX ${WebGLGeometriesAdapter.MIN_SDF_ID}

            // ---- Generics ----
            float geometryIntersect(in int geometryID, in Ray r, in float minDistance) {
                if (geometryID < GEOMETRY_SDF_MIN_INDEX) {
                     switch(geometryID) {
                         case GEOMETRY_SPHERE_TYPE  : return unitSphereIntersect(r, minDistance); break;
                         case GEOMETRY_CYLINDER_TYPE: return cylinderIntersect  (r, minDistance); break;
                         case GEOMETRY_PLANE_TYPE   : return planeIntersect     (r, minDistance); break;
                         case GEOMETRY_CIRCLE_TYPE  : return circleIntersect    (r, minDistance); break;
                         case GEOMETRY_SQUARE_TYPE  : return squareIntersect    (r, minDistance); break;
                         case GEOMETRY_UNITBOX_TYPE : return unitBoxIntersect   (r, minDistance); break;
                     }
                }
                else {
                    if (geometryID < GEOMETRY_TRIANGLE_MIN_INDEX)
                        return sdfIntersect(r, minDistance, geometryID - GEOMETRY_SDF_MIN_INDEX);
                    else
                        return triangleIntersect(r, minDistance, geometryID - GEOMETRY_TRIANGLE_MIN_INDEX);
                }
                return minDistance - 1.0;
            }
            vec4 sampleGeometrySurface(in int geometryID, inout vec2 random_seed) {
                switch(geometryID) {
                    case GEOMETRY_SPHERE_TYPE     : return unitSphereSurfaceSample( random_seed); break;
                    case GEOMETRY_ORIGINPOINT_TYPE: return originPointSurfaceSample(random_seed); break;
                    case GEOMETRY_UNITLINE_TYPE   : return unitLineSurfaceSample(   random_seed); break;
                    case GEOMETRY_SQUARE_TYPE     : return squareSurfaceSample(     random_seed); break;
                }
                return vec4(0);
            }
            GeometricMaterialData getGeometricMaterialData(in int geometryID, in vec4 position, in vec4 direction) {
                GeometricMaterialData data;
                data.baseColor = vec3(1.0);
                if (geometryID < GEOMETRY_SDF_MIN_INDEX) {
                    switch(geometryID) { 
                        case GEOMETRY_SPHERE_TYPE     : unitSphereMaterialData (position, data); break;
                        case GEOMETRY_CYLINDER_TYPE   : cylinderMaterialData   (position, data); break;
                        case GEOMETRY_PLANE_TYPE      : planeMaterialData      (position, data); break;
                        case GEOMETRY_CIRCLE_TYPE     : circleMaterialData     (position, data); break;
                        case GEOMETRY_SQUARE_TYPE     : squareMaterialData     (position, data); break;
                        case GEOMETRY_UNITBOX_TYPE    : unitBoxMaterialData    (position, data); break;
                        case GEOMETRY_ORIGINPOINT_TYPE: originPointMaterialData(position, direction, data); break;
                        case GEOMETRY_UNITLINE_TYPE   : unitLineMaterialData   (position, direction, data); break;
                    }
                }
                else {
                    if (geometryID < GEOMETRY_TRIANGLE_MIN_INDEX)
                        sdfMaterialData(position, data, geometryID - GEOMETRY_SDF_MIN_INDEX);
                    else
                        triangleMaterialData(position, data, geometryID - GEOMETRY_TRIANGLE_MIN_INDEX);
                }
                return data;
            }`
            + this.sdf_adapter.getShaderSource();
    }
    getIntersectShaderSource(geometryID, ray_src, minDist_src) {
        if (geometryID < WebGLGeometriesAdapter.MIN_SDF_ID) {
            switch(geometryID) { 
                case WebGLGeometriesAdapter.SPHERE_ID  : return `unitSphereIntersect(${ray_src}, ${minDist_src})`;
                case WebGLGeometriesAdapter.CYLINDER_ID: return `cylinderIntersect(${ray_src}, ${minDist_src})`;
                case WebGLGeometriesAdapter.PLANE_ID   : return `planeIntersect(${ray_src}, ${minDist_src})`;
                case WebGLGeometriesAdapter.CIRCLE_ID  : return `circleIntersect(${ray_src}, ${minDist_src})`;
                case WebGLGeometriesAdapter.SQUARE_ID  : return `squareIntersect(${ray_src}, ${minDist_src})`;
                case WebGLGeometriesAdapter.UNITBOX_ID : return `unitBoxIntersect(${ray_src}, ${minDist_src})`;
                default                                : return `${minDist_src} - 1.0`;
            }
        }
        else {
            if (geometryID < WebGLGeometriesAdapter.MIN_TRIANGLE_ID)
                return `sdfIntersect(${ray_src}, ${minDist_src}, ${geometryID - WebGLGeometriesAdapter.MIN_SDF_ID})`;
            else
                return `triangleIntersect(${ray_src}, ${minDist_src}, ${geometryID - WebGLGeometriesAdapter.MIN_TRIANGLE_ID})`;
        }
    }
    getSampleSurfaceShaderSource(geometryID, random_seed_src) {
        switch(geometryID) {
            case WebGLGeometriesAdapter.SPHERE_ID     : return `unitSphereSurfaceSample( ${random_seed_src})`;
            case WebGLGeometriesAdapter.ORIGINPOINT_ID: return `originPointSurfaceSample(${random_seed_src})`;
            case WebGLGeometriesAdapter.UNITLINE_ID   : return `unitLineSurfaceSample(   ${random_seed_src})`;
            case WebGLGeometriesAdapter.SQUARE_ID     : return `squareSurfaceSample(     ${random_seed_src})`;
        }
        return `vec4(0)`;
    }
}

