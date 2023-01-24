class WebGLGeometriesAdapter {
    constructor() {
        this.id_map = {};
        this.geometries = [ new Plane(), new Sphere(), new UnitBox() ];
        
        this.triangle_data_map = {};
        this.triangle_data = [];
        this.triangles = [];
    }
    visitTriangleData(vec) {
        vec = vec.slice(0, 3);
        const key = vec.to_string();
        if (key in this.triangle_data_map)
            return this.triangle_data_map[key];
        this.triangle_data_map[key] = this.triangle_data.length;
        this.triangle_data.push(Array.of(...vec));
        return this.triangle_data_map[key];
    }
    visit(geometry) {
        if (geometry instanceof Plane)
            return 0;
        if (geometry instanceof Sphere)
            return 1;
        if (geometry instanceof UnitBox)
            return 2;
        if (geometry.GEOMETRY_UID in this.id_map)
            return this.id_map[geometry.GEOMETRY_UID];
        if (geometry instanceof Triangle) {
            this.triangles.push({
                vertex_indices: (geometry.ps                                             ).map(p => this.visitTriangleData(p)),
                normal_indices: (geometry.psdata.normal || Array(3).fill(geometry.normal)).map(v => this.visitTriangleData(v)),
                uv_indices:     (geometry.psdata.UV     || Array(3).fill(Vec.of(0,0)    )).map(v => this.visitTriangleData(Vec.of(...v, 0)))
            });
            this.id_map[geometry.GEOMETRY_UID] = this.geometries.length;
            this.geometries.push(geometry);
            return this.id_map[geometry.GEOMETRY_UID];
        }
        throw "Unsupported geometry type";
    }
    writeShaderData(gl, program) {
        // Write triangle data, as all other types need no data written for geometry
        if (this.triangles.length) {
            gl.uniform3fv(gl.getUniformLocation(program, "ugTriangleData"),          this.triangle_data.flat());
            gl.uniform1iv(gl.getUniformLocation(program, "ugTriangleVertexIndices"), this.triangles.map(t => t.vertex_indices).flat());
            gl.uniform1iv(gl.getUniformLocation(program, "ugTriangleNormalIndices"), this.triangles.map(t => t.normal_indices).flat());
            gl.uniform1iv(gl.getUniformLocation(program, "ugTriangleUVIndices"),     this.triangles.map(t => t.uv_indices).flat());
        }
    }
    getShaderSourceDeclarations() {
        return `
                struct GeometricMaterialData { vec4 normal; vec2 UV; };
                float geometryIntersect(in int geometryID, in Ray r, in float minDistance);
                void getGeometricMaterialData(in int geometryID, in vec4 position, in Ray r, inout GeometricMaterialData data);`;
    }
    getShaderSource() {
        return `
            // ---- Plane ----
            #define GEOMETRY_PLANE_TYPE 0
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


            // ---- Sphere ----
            #define GEOMETRY_SPHERE_TYPE 1
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
            #define GEOMETRY_UNITBOX_TYPE 2
            float unitBoxIntersect(in Ray r, in float minDistance) {
                float t_min = minDistance - 1.0, t_max = 1e20;
                vec4 p = vec4(0,0,0,1) - r.o;
                for (int i = 0; i < 3; ++i) {
                    if (abs(r.d[i]) > 0.0000001) {
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
            #define GEOMETRY_TRIANGLE_MIN_INDEX 3

            #define MAX_TRIANGLES ${Math.max(this.triangles.length, 1)}
            #define MAX_TRIANGLE_DATA ${Math.max(this.triangle_data.length, 1)}
            
            uniform vec3 ugTriangleData         [MAX_TRIANGLE_DATA];
            uniform int  ugTriangleVertexIndices[MAX_TRIANGLES * 3];
            uniform int  ugTriangleNormalIndices[MAX_TRIANGLES * 3];
            uniform int  ugTriangleUVIndices    [MAX_TRIANGLES * 3];

            void getTriangleVertices(in int triangleID, out vec4 p1, out vec4 p2, out vec4 p3) {
                p1 = vec4(ugTriangleData[ugTriangleVertexIndices[triangleID * 3    ]], 1);
                p2 = vec4(ugTriangleData[ugTriangleVertexIndices[triangleID * 3 + 1]], 1);
                p3 = vec4(ugTriangleData[ugTriangleVertexIndices[triangleID * 3 + 2]], 1);
            }
            void getTriangleNormals(in int triangleID, out vec4 n1, out vec4 n2, out vec4 n3) {
                n1 = vec4(ugTriangleData[ugTriangleNormalIndices[triangleID * 3    ]], 0);
                n2 = vec4(ugTriangleData[ugTriangleNormalIndices[triangleID * 3 + 1]], 0);
                n3 = vec4(ugTriangleData[ugTriangleNormalIndices[triangleID * 3 + 2]], 0);
            }
            void getTriangleUVs(in int triangleID, out vec2 uv1, out vec2 uv2, out vec2 uv3) {
                uv1 = ugTriangleData[ugTriangleUVIndices[triangleID * 3    ]].xy;
                uv3 = ugTriangleData[ugTriangleUVIndices[triangleID * 3 + 2]].xy;
                uv2 = ugTriangleData[ugTriangleUVIndices[triangleID * 3 + 1]].xy;
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
                else if (geometryID == GEOMETRY_UNITBOX_TYPE)
                    return unitBoxIntersect(r, minDistance);
                return triangleIntersect(r, minDistance, geometryID - GEOMETRY_TRIANGLE_MIN_INDEX);
            }
            void getGeometricMaterialData(in int geometryID, in vec4 position, in Ray r, inout GeometricMaterialData data) {
                if (geometryID == GEOMETRY_SPHERE_TYPE)
                    unitSphereMaterialData(position, data);
                else if (geometryID == GEOMETRY_PLANE_TYPE)
                    planeMaterialData(position, data);
                else if (geometryID == GEOMETRY_UNITBOX_TYPE)
                    unitBoxMaterialData(position, r.d, data);
                else
                    triangleMaterialData(position, data, geometryID - GEOMETRY_TRIANGLE_MIN_INDEX);
            }`;
    }
}

