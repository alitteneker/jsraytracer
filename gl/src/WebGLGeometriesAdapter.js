class WebGLGeometriesAdapter {
    static PLANE_ID        = 0;
    static SPHERE_ID       = 1;
    static UNITBOX_ID      = 2;
    static CIRCLE_ID       = 3;
    static SQUARE_ID       = 4;
    static MIN_TRIANGLE_ID = 5;
    
    constructor() {
        this.id_map = {};
        this.geometries = [ new Plane(), new Sphere(), new UnitBox(), new Circle(), new Square() ];
        
        this.triangle_data = new WebGLVecStore();
        this.triangles = [];
    }
    visit(geometry) {
        if (geometry instanceof Plane)
            return WebGLGeometriesAdapter.PLANE_ID;
        if (geometry instanceof Sphere)
            return WebGLGeometriesAdapter.SPHERE_ID;
        if (geometry instanceof UnitBox)
            return WebGLGeometriesAdapter.UNITBOX_ID;
        if (geometry instanceof Circle)
            return WebGLGeometriesAdapter.CIRCLE_ID;
        if (geometry instanceof Square)
            return WebGLGeometriesAdapter.SQUARE_ID;
        
        if (geometry.GEOMETRY_UID in this.id_map)
            return this.id_map[geometry.GEOMETRY_UID];
        if (geometry instanceof Triangle) {
            this.triangles.push({
                vertex_indices: (geometry.ps                                             ).map(p => this.triangle_data.visit(p)),
                normal_indices: (geometry.psdata.normal || Array(3).fill(geometry.normal)).map(v => this.triangle_data.visit(v)),
                uv_indices:     (geometry.psdata.UV     || Array(3).fill(Vec.of(0,0)    )).map(v => this.triangle_data.visit(Vec.of(...v, 0)))
            });
            this.id_map[geometry.GEOMETRY_UID] = this.geometries.length;
            this.geometries.push(geometry);
            return this.id_map[geometry.GEOMETRY_UID];
        }
        throw "Unsupported geometry type";
    }
    writeShaderData(gl, program) {
        // Write triangle data, as all other types need no data written for geometry
        {
            const square_size = Math.max(1, Math.ceil(Math.sqrt(this.triangle_data.size())));
            const square_data = Float32Array.from(Object.assign(new Array(3 * square_size * square_size).fill(0), this.triangle_data.to_webgl()));
            
            gl.activeTexture(gl.TEXTURE1);
            const triangleDataTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, triangleDataTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, square_size, square_size, 0, gl.RGB, gl.FLOAT, square_data);
            gl.uniform1i(gl.getUniformLocation(program, "tTriangleData"), 1);
        }
        
        {
            const square_size = Math.max(1, Math.ceil(Math.sqrt(3 * this.triangles.length)));
            const square_data = Int32Array.from(Object.assign(new Array(3 * square_size * square_size).fill(0),
                this.triangles.map(t => [t.vertex_indices, t.normal_indices, t.uv_indices]).flat().flat()));
            
            gl.activeTexture(gl.TEXTURE2);
            const triangleIndicesTexture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, triangleIndicesTexture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32I, square_size, square_size, 0, gl.RGB_INTEGER, gl.INT, square_data);
            gl.uniform1i(gl.getUniformLocation(program, "tTriangleIndices"), 2);
        }
    }
    getShaderSourceDeclarations() {
        return `
            struct GeometricMaterialData {
                vec4 normal;
                vec2 UV;
            };
            float geometryIntersect(in int geometryID, in Ray r, in float minDistance);
            void getGeometricMaterialData(in int geometryID, in vec4 position, in Ray r, inout GeometricMaterialData data);`;
    }
    getShaderSource() {
        return `
            // ---- Plane ----
            #define GEOMETRY_PLANE_TYPE ${WebGLGeometriesAdapter.PLANE_ID}
            float planeIntersect(in Ray r, in float minDistance, in vec4 n, in float delta) {
                float denom = dot(r.d, n);
                if (denom == 0.0)
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
            void squareMaterialData(in vec4 position, inout GeometricMaterialData data) {
                planeMaterialData(position, data);
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

            void unitSphereMaterialData(in vec4 position, inout GeometricMaterialData data) {
                data.normal = vec4(normalize(position.xyz), 0);
                data.UV.x = 0.5 + atan(data.normal.z, data.normal.x) / (2.0 * PI);
                data.UV.y = 0.5 - asin(data.normal.y) / PI;
            }


            // ---- Unit Box ----
            #define GEOMETRY_UNITBOX_TYPE ${WebGLGeometriesAdapter.UNITBOX_ID}
            float unitBoxIntersect(in Ray r, in float minDistance) {
                float t_min = minDistance - 1.0, t_max = 1e20;
                vec4 p = vec4(0,0,0,1) - r.o;
                for (int i = 0; i < 3; ++i) {
                    if (abs(r.d[i]) > EPSILON) {
                        float t1 = (p[i] + 0.5) / r.d[i],
                            t2 = (p[i] - 0.5) / r.d[i];
                        if (t1 > t2) {
                            float tmp = t1;
                            t1 = t2;
                            t2 = tmp;
                        }
                        if (t1 > t_min)
                            t_min = t1;
                        if (t2 < t_max)
                            t_max = t2;
                        if (t_min > t_max || t_max < minDistance)
                            return minDistance - 1.0;
                    }
                    else if (abs(p[i]) > 0.5)
                        return minDistance - 1.0;
                }
                if (t_min >= minDistance)
                    return t_min;
                return t_max;
            }
            void unitBoxMaterialData(in vec4 p, in vec4 rd, inout GeometricMaterialData data) {
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
                if (dot(data.normal, rd) > 0.0)
                    data.normal = -1.0 * data.normal;
                
                // TODO: what to do about UV?
            }


            // ---- Triangle ----
            #define GEOMETRY_TRIANGLE_MIN_INDEX ${WebGLGeometriesAdapter.MIN_TRIANGLE_ID}
            
            uniform sampler2D tTriangleData;
            ivec2 computeGenericIndex(in int index, in ivec2 size) {
                return ivec2(index % size.x, index / size.x);
            }
            vec3 getTriangleData(in int index) {
                return texelFetch(tTriangleData, computeGenericIndex(index, textureSize(tTriangleData, 0)), 0).rgb;
            }
            
            uniform highp isampler2D tTriangleIndices;
            ivec3 getIndices(in int triangleID, in int dataOffset) {
                return texelFetch(tTriangleIndices, computeGenericIndex(triangleID * 3 + dataOffset, textureSize(tTriangleIndices, 0)), 0).rgb;
            }
            void getTriangleVertices(in int triangleID, out vec4 p1, out vec4 p2, out vec4 p3) {
                ivec3 indices = getIndices(triangleID, 0);
                p1 = vec4(getTriangleData(indices[0]), 1);
                p2 = vec4(getTriangleData(indices[1]), 1);
                p3 = vec4(getTriangleData(indices[2]), 1);
            }
            void getTriangleNormals(in int triangleID, out vec4 n1, out vec4 n2, out vec4 n3) {
                ivec3 indices = getIndices(triangleID, 1);
                n1 = vec4(getTriangleData(indices[0]), 0);
                n2 = vec4(getTriangleData(indices[1]), 0);
                n3 = vec4(getTriangleData(indices[2]), 0);
            }
            void getTriangleUVs(in int triangleID, out vec2 uv1, out vec2 uv2, out vec2 uv3) {
                ivec3 indices = getIndices(triangleID, 2);
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
                vec4 normal = vec4(normalize(cross(vec3((p2 - p1).xyz), vec3((p3 - p1).xyz))), 1.0);
                float distance = planeIntersect(r, minDistance, normal, dot(p1, normal));
                if (distance < minDistance)
                    return distance;
                vec3 bary = triangleToBarycentric(r.o + (distance * r.d), p1, p2, p3);
                if (bary.x >= 0.0 && bary.x <= 1.0 && bary.y >= 0.0 && bary.y <= 1.0 && bary.z >= 0.0 && bary.z <= 1.0)
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

            // ---- Generics ----
            float geometryIntersect(in int geometryID, in Ray r, in float minDistance) {
                if (geometryID == GEOMETRY_SPHERE_TYPE)
                    return unitSphereIntersect(r, minDistance);
                else if (geometryID == GEOMETRY_PLANE_TYPE)
                    return planeIntersect(r, minDistance);
                else if (geometryID == GEOMETRY_CIRCLE_TYPE)
                    return circleIntersect(r, minDistance);
                else if (geometryID == GEOMETRY_SQUARE_TYPE)
                    return squareIntersect(r, minDistance);
                else if (geometryID == GEOMETRY_UNITBOX_TYPE)
                    return unitBoxIntersect(r, minDistance);
                return triangleIntersect(r, minDistance, geometryID - GEOMETRY_TRIANGLE_MIN_INDEX);
            }
            void getGeometricMaterialData(in int geometryID, in vec4 position, in Ray r, inout GeometricMaterialData data) {
                if (geometryID == GEOMETRY_SPHERE_TYPE)
                    unitSphereMaterialData(position, data);
                else if (geometryID == GEOMETRY_PLANE_TYPE)
                    planeMaterialData(position, data);
                else if (geometryID == GEOMETRY_CIRCLE_TYPE)
                    circleMaterialData(position, data);
                else if (geometryID == GEOMETRY_SQUARE_TYPE)
                    squareMaterialData(position, data);
                else if (geometryID == GEOMETRY_UNITBOX_TYPE)
                    unitBoxMaterialData(position, r.d, data);
                else
                    triangleMaterialData(position, data, geometryID - GEOMETRY_TRIANGLE_MIN_INDEX);
            }`;
    }
}

