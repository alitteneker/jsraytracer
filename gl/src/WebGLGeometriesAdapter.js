class WebGLGeometriesAdapter {
    static PLANE_ID        = 0;
    static SPHERE_ID       = 1;
    static UNITBOX_ID      = 2;
    static CIRCLE_ID       = 3;
    static SQUARE_ID       = 4;
    static CYLINDER_ID     = 5;
    static MIN_TRIANGLE_ID = 6;
    
    constructor(webgl_helper) {
        this.id_map = {};
        this.geometries = [ new Plane(), new Sphere(), new UnitBox(), new Circle(), new Square(), new Cylinder() ];
        
        this.triangle_data = new WebGLVecStore();
        this.triangles = [];
        
        [this.triangle_data_texture_unit,    this.triangle_data_texture]    = webgl_helper.allocateDataTextureUnit(3, "FLOAT");
        [this.triangle_indices_texture_unit, this.triangle_indices_texture] = webgl_helper.allocateDataTextureUnit(3, "INTEGER");
    }
    destroy(gl) {
        gl.deleteTexture(this.triangle_data_texture);
        gl.deleteTexture(this.triangle_indices_texture);
    }
    visit(geometry) {
        if (geometry instanceof Plane)
            return WebGLGeometriesAdapter.PLANE_ID;
        if (geometry instanceof Sphere)
            return WebGLGeometriesAdapter.SPHERE_ID;
        if (geometry instanceof Cylinder)
            return WebGLGeometriesAdapter.CYLINDER_ID;
        if (geometry instanceof UnitBox)
            return WebGLGeometriesAdapter.UNITBOX_ID;
        if (geometry instanceof Circle)
            return WebGLGeometriesAdapter.CIRCLE_ID;
        if (geometry instanceof Square)
            return WebGLGeometriesAdapter.SQUARE_ID;
        
        if (geometry.GEOMETRY_UID in this.id_map)
            return this.id_map[geometry.GEOMETRY_UID];
        
        if (geometry instanceof Triangle) {
            // Very small triangles frequently cause precision issues in WebGL, so simply skip them as a band aid
            if (geometry.area < 0.00001)
                return -1;
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
    writeShaderData(gl, program, webgl_helper) {
        // Write triangle data, as all other types need no data written for geometry
        webgl_helper.setDataTexturePixelsUnit(this.triangle_data_texture, 3, "FLOAT", this.triangle_data_texture_unit, "tTriangleData", program,
            this.triangle_data.flat());
        webgl_helper.setDataTexturePixelsUnit(this.triangle_indices_texture, 3, "INTEGER", this.triangle_indices_texture_unit, "tTriangleIndices", program,
            this.triangles.map(t => [...t.vertex_indices, ...t.normal_indices, ...t.uv_indices]).flat());
    }
    getShaderSourceDeclarations() {
        return `
            struct GeometricMaterialData {
                vec4 normal;
                vec2 UV;
            };
            float geometryIntersect(in int geometryID, in Ray r, in float minDistance);
            void getGeometricMaterialData(in int geometryID, in vec4 position, in Ray r, inout GeometricMaterialData data);
            vec2 AABBIntersects(in Ray r, in vec4 center, in vec4 half_size, in float minDistance, in float maxDistance);`;
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
                vec4 n = vec4(normalize(position.xyz), 0);
                
                data.normal = vec4(normalize(n.xy), 0, 0);
                data.UV.x = 0.5 + atan(position.z, position.x) / (2.0 * PI),
                data.UV.y = 0.5 + position.y;
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

            // ---- Generics ----
            float geometryIntersect(in int geometryID, in Ray r, in float minDistance) {
                if      (geometryID < 0) return minDistance - 1.0;
                else if (geometryID == GEOMETRY_SPHERE_TYPE)   return unitSphereIntersect(r, minDistance);
                else if (geometryID == GEOMETRY_CYLINDER_TYPE) return cylinderIntersect(  r, minDistance);
                else if (geometryID == GEOMETRY_PLANE_TYPE)    return planeIntersect(     r, minDistance);
                else if (geometryID == GEOMETRY_CIRCLE_TYPE)   return circleIntersect(    r, minDistance);
                else if (geometryID == GEOMETRY_SQUARE_TYPE)   return squareIntersect(    r, minDistance);
                else if (geometryID == GEOMETRY_UNITBOX_TYPE)  return unitBoxIntersect(   r, minDistance);
                else
                    return triangleIntersect(r, minDistance, geometryID - GEOMETRY_TRIANGLE_MIN_INDEX);
            }
            void getGeometricMaterialData(in int geometryID, in vec4 position, in Ray r, inout GeometricMaterialData data) {
                if      (geometryID == GEOMETRY_SPHERE_TYPE)   unitSphereMaterialData(position, data);
                else if (geometryID == GEOMETRY_CYLINDER_TYPE) cylinderMaterialData(  position, data);
                else if (geometryID == GEOMETRY_PLANE_TYPE)    planeMaterialData(     position, data);
                else if (geometryID == GEOMETRY_CIRCLE_TYPE)   circleMaterialData(    position, data);
                else if (geometryID == GEOMETRY_SQUARE_TYPE)   squareMaterialData(    position, data);
                else if (geometryID == GEOMETRY_UNITBOX_TYPE)  unitBoxMaterialData(   position, r.d, data);
                else
                    triangleMaterialData(position, data, geometryID - GEOMETRY_TRIANGLE_MIN_INDEX);
            }`;
    }
}

