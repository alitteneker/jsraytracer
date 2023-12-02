class WebGLSDFAdapter {
    constructor(webgl_helper) {
        this.reset();
    }
    destroy() {}
    reset() {
        this.ID_GEN = 1;
        this.geometries = [];
        this.sdfs = {};
        this.transforms = {};
    }
    visitSDFGeometry(geometry, geometry_adapter, webgl_helper) {
        this.geometries.push(geometry);
        this.wrapNodeSDF(geometry.root_sdf);
    }
    wrapNodeSDF(sdf) {
        if (!sdf)
            throw "Attempt to wrap null/false SDF node";
        
        if (sdf.UID in this.sdfs)
            return sdfs[sdf.UID];
        let adapter_ = null;
        
        if (sdf instanceof UnionSDF)
            adapter_ = new WebGLUnionSDFDecorator(sdf, this);
        else if (sdf instanceof IntersectionSDF)
            adapter_ = new WebGLIntersectionSDFDecorator(sdf, this);
        else if (sdf instanceof DifferenceSDF)
            adapter_ = new WebGLDifferenceSDFDecorator(sdf, this);
        else if (sdf instanceof TransformSDF)
            adapter_ = new WebGLTransformSDFDecorator(sdf, this);
        else if (sdf instanceof RecursiveTransformUnionSDF)
            adapter_ = new WebGLRecursiveTransformUnionSDFDecorator(sdf, this);
        
        else if (sdf instanceof SphereSDF)
            adapter_ = new WebGLSphereSDFDecorator(sdf, this);
        else if (sdf instanceof BoxSDF)
            adapter_ = new WebGLBoxSDFDecorator(sdf, this);
        else if (sdf instanceof PlaneSDF)
            adapter_ = new WebGLPlaneSDFDecorator(sdf, this);
        else if (sdf instanceof TetrahedronSDF)
            adapter_ = new WebGLTetrahedronSDFDecorator(sdf, this);
        
        else
            throw "Unsupported SDF node type";
        
        return this.sdfs[sdf.UID] = adapter_;
    }
    wrapNodeTransformer(transform) {
        if (!transform)
            throw "Attempt to wrap null/false transformer node";
        
        if (transform.UID in this.transforms)
            return this.transforms[transform.UID];
        let decorator = null;
        
        if (transform instanceof SDFTransformerSequence)
            decorator = new WebGLTransformerSequenceSDFDecorator(transform, this);
        else if (transform instanceof SDFMatrixTransformer)
            decorator = new WebGLMatrixTransformSDFDecorator(transform, this);
        else if (transform instanceof SDFReflectionTransformer)
            decorator = new WebGLSDFReflectionTransformerSDFDecorator(transform, this);
        else if (transform instanceof SDFRecursiveTransformer)
            decorator = new WebGLSDFRecursiveTransformerSDFDecorator(transform, this);
        else if (transform instanceof SDFInfiniteRepetitionTransformer)
            decorator = new WebGLSDFInfiniteRepetitionTransformerSDFDecorator(transform, this);
        
            
        else
            throw "Unsupported SDF transformer node type";
        
        return this.transforms[transform.UID] = decorator;
    }
    getShaderSourceDeclarations() {
        return `
            // =============== SDF ===============
            float sdfIntersect(in Ray r, in float minDistance, in int sdfID);
            void sdfMaterialData(in vec4 position, inout GeometricMaterialData data, in int sdfID);`
        + this.geometries.map((g, i) => `
            float sdfIntersect_${i}(in Ray r, in float minDistance);
            void sdfMaterialData_${i}(in vec4 position, inout GeometricMaterialData data);`).join("\n")
        + Object.values(this.sdfs).map(d => d.getShaderSourceDeclarations()).join("\n")
        + Object.values(this.transforms).map(d => d.getShaderSourceDeclarations()).join("\n");
    }
    getShaderSource() {
        return `
            // =============== SDF ===============
            float sdfBoxDistance(in vec4 p, in vec4 size) {
                p = abs(p) - size;
                return length(max(p.xyz, vec3(0.0))) + min(max(p[0], max(p[1], p[2])), 0.0);
            }
            float sdfUnitTetrahedronDistance(in vec4 p) {
                return (max(abs(p[0] + p[1]) - p[2],
                            abs(p[0] - p[1]) + p[2]) - 1.0) / sqrt(3.0);
            }
            float sdfIntersect(in Ray r, in float minDistance, in int sdfID) {
${this.geometries.map((g, i) => `                if (sdfID == ${i}) return sdfIntersect_${i}(r, minDistance);`).join("\n")}
                return minDistance - 1.0;
            }
            void sdfMaterialData(in vec4 position, inout GeometricMaterialData data, in int sdfID) {
${this.geometries.map((g, i) => `                if (sdfID == ${i}) sdfMaterialData_${i}(position, data);`).join("\n")}
            }`
        + this.geometries.map((g, i) => `
            uniform int sdf_${i}_max_samples;
            uniform float sdf_${i}_distance_epsilon;
            uniform float sdf_${i}_max_trace_distance;
            uniform float sdf_${i}_normal_step_size;
        
            float sdfGeometryDistance_${i}(in vec4 position) {
                return ${this.sdfs[g.root_sdf.UID].getDistanceShaderSource("position")};
            }
            float sdfIntersect_${i}(in Ray r, in float minDistance) {
                float t = minDistance;
                float rd_norm = length(r.d);
                for (int i = 0; i < sdf_${i}_max_samples; ++i) {
                    vec4 p = r.o + t * r.d;
                    float distance = sdfGeometryDistance_${i}(r.o + t * r.d);
                    
                    if (isinf(distance) || isnan(distance))
                        break;
                    
                    if (distance <= sdf_${i}_distance_epsilon)
                        return t;
                    
                    t += distance / rd_norm;
                    if (t < minDistance || (t - minDistance) * rd_norm > sdf_${i}_max_trace_distance)
                        break;
                }
                return minDistance - 1.0;
            }
            void sdfMaterialData_${i}(in vec4 position, inout GeometricMaterialData data) {
                float distance = sdfGeometryDistance_${i}(position);
                for (int i = 0; i < 3; ++i)
                    data.normal[i] = (sdfGeometryDistance_${i}(position + sdf_${i}_normal_step_size * unitAxis4(i)) - distance) / sdf_${i}_normal_step_size;
                
                GeometricMaterialData sdf_data = ${this.sdfs[g.root_sdf.UID].getMaterialShaderSource("position")};
                data.UV = sdf_data.UV;
                data.baseColor = sdf_data.baseColor;
            }`).join("\n")
        + Object.values(this.sdfs).map(d => d.getShaderSource()).join("\n")
        + Object.values(this.transforms).map(d => d.getShaderSource()).join("\n");
            
    }
    writeShaderData(gl, program) {
        for (const [i, g] of Object.entries(this.geometries)) {
            gl.uniform1i(gl.getUniformLocation(program, `sdf_${i}_max_samples`), g.max_samples);
            gl.uniform1f(gl.getUniformLocation(program, `sdf_${i}_distance_epsilon`), g.distance_epsilon);
            gl.uniform1f(gl.getUniformLocation(program, `sdf_${i}_max_trace_distance`), g.max_trace_distance);
            gl.uniform1f(gl.getUniformLocation(program, `sdf_${i}_normal_step_size`), g.normal_step_size);
        }
        for (const [k, dec] of Object.entries(this.sdfs))
            dec.writeShaderData(gl, program);
        for (const [k, dec] of Object.entries(this.transforms))
            dec.writeShaderData(gl, program);
    }
}

class WebGLSDFDecorator {
    constructor(raw, adapter) {
        this.raw = raw;
        this.ID = adapter.ID_GEN++;
    }
    writeShaderData(gl, program) {}
    getShaderSourceDeclarations() {
        return "";
    }
    getShaderSource() {
        return "";
    }
    getDistanceShaderSource(position_src) {
        throw "Subclass has not implemented getShaderSource";
    }
    getMaterialShaderSource(position_src) {
        throw "Subclass has not implemented getMaterialShaderSource";
    }
    getTransformShaderSource(position_src, scale_src) {
        throw "Subclass has not implemented getTransformShaderSource";
    }
}

class WebGLUnionSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
        this.children = raw.children.map(c => adapter.wrapNodeSDF(c));
    }
    getShaderSourceDeclarations() {
        return `
            float sdfDistance_${this.ID}(in vec4 position);
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position);`;
    }
    getShaderSource() {
        const cs = this.children.map(c => c.getDistanceShaderSource("position"));
        const cm = this.children.map(c => c.getMaterialShaderSource("position"));
        return `
            float sdfDistance_${this.ID}(in vec4 position) {
                return ${cs.slice(0, -1).map(c => `min(${c},`).join('') + cs[cs.length - 1] + ")".repeat(cs.length - 1)};
            }
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position) {
                float bestDist = ${cs[0]};
                GeometricMaterialData ret = ${cm[0]};
                ${cs.slice(1).map((c,i) => `if (${c} < bestDist) ret = ${cm[i+1]};`).join('\n')}
                return ret;
            }`;
    }
    getDistanceShaderSource(position_src) {
        return `sdfDistance_${this.ID}(${position_src})`;
    }
    getMaterialShaderSource(position_src) {
        return `sdfMaterialData_${this.ID}(${position_src})`;
    }
}

class WebGLIntersectionSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
        this.children = raw.children.map(c => adapter.wrapNodeSDF(c));
    }
    getShaderSourceDeclarations() {
        return `
            float sdfDistance_${this.ID}(in vec4 position);
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position);`;
    }
    getShaderSource() {
        const cs = this.children.map(c => c.getDistanceShaderSource("position"));
        const cm = this.children.map(c => c.getMaterialShaderSource("position"));
        return `
            float sdfDistance_${this.ID}(in vec4 position) {
                return ${cs.slice(0, -1).map(c => `max(${c},`).join('') + cs[cs.length - 1] + ")".repeat(cs.length - 1)};
            }
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position) {
                float bestDist = ${cs[0]};
                GeometricMaterialData ret = ${cm[0]};
                ${cs.slice(1).map((c,i) => `if (${c} > bestDist) ret = ${cm[i+1]};`).join('\n')}
                return ret;
            }`;
    }
    getDistanceShaderSource(position_src) {
        return `sdfDistance_${this.ID}(${position_src})`;
    }
    getMaterialShaderSource(position_src) {
        return `sdfMaterialData_${this.ID}(${position_src})`;
    }
}

class WebGLDifferenceSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
        this.positive = adapter.wrapNodeSDF(raw.positive);
        this.negative = adapter.wrapNodeSDF(raw.negative);
    }
    getShaderSourceDeclarations() {
        return `GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position);`;
    }
    getShaderSource() {
        return `
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position) {
                if (${this.positive.getDistanceShaderSource("position")} > -${this.negative.getDistanceShaderSource("position")})
                    return ${this.positive.getMaterialShaderSource("position")};
                return ${this.negative.getMaterialShaderSource("position")};
            }`;
    }
    getDistanceShaderSource(position_src) {
        return `max(${this.positive.getDistanceShaderSource(position_src)}, -${this.negative.getDistanceShaderSource(position_src)})`;
    }
    getMaterialShaderSource(position_src) {
        return `sdfMaterialData_${this.ID}(${position_src})`;
    }
}

class WebGLTransformSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
        this.transform = adapter.wrapNodeTransformer(raw.transformer);
        this.sdf = adapter.wrapNodeSDF(raw.child_sdf);
    }
    getShaderSourceDeclarations() {
        return `float sdf_transformDistance_${this.ID}(in vec4 position);`;
    }
    getShaderSource() {
        return `
            float sdf_transformDistance_${this.ID}(in vec4 position) {
                float scale = 1.0;
                position = ${this.transform.getTransformShaderSource("position", "scale")};
                return ${this.sdf.getDistanceShaderSource("position")} * scale;
            }`;
    }
    getDistanceShaderSource(position_src) {
        return `sdf_transformDistance_${this.ID}(${position_src})`;
    }
    getMaterialShaderSource(position_src) {
        return this.sdf.getMaterialShaderSource(position_src);
    }
}

class WebGLRecursiveTransformUnionSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
        this.transformer = adapter.wrapNodeTransformer(raw.transformer);
        this.sdf = adapter.wrapNodeSDF(raw.sdf);
    }
    getShaderSourceDeclarations() {
        return `
            uniform int sdf_recursiveUnionIterations_${this.ID};
            float sdf_recursiveUnionDistance_${this.ID}(in vec4 position);`;
    }
    writeShaderData(gl, program) {
        gl.uniform1i(gl.getUniformLocation(program, `sdf_recursiveUnionIterations_${this.ID}`), this.raw.iterations);
    }
    getShaderSource() {
        return `
            float sdf_recursiveUnionDistance_${this.ID}(in vec4 position) {
                float s = 1.0;
                float bestDist = ${this.sdf.getDistanceShaderSource("position")};
                for (int i = 0; i < sdf_recursiveUnionIterations_${this.ID}; ++i) {
                    position = ${this.transformer.getTransformShaderSource("position", "s")};
                    bestDist = min(${this.sdf.getDistanceShaderSource("position")} * s, bestDist);
                }
                return bestDist;
            }`;
    }
    getDistanceShaderSource(position_src) {
        return `sdf_recursiveUnionDistance_${this.ID}(${position_src})`;
    }
    getMaterialShaderSource(position_src) {
        return this.sdf.getMaterialShaderSource(position_src);
    }
}

// TODO: RoundSDF

class WebGLSphereSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
    }
    getShaderSourceDeclarations() {
        return `
            uniform float sdf_radius_${this.ID};
            uniform vec3 sdf_basecolor_${this.ID};
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position);`;
    }
    getShaderSource() {
        return `
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position) {
                GeometricMaterialData ret;
                vec3 n = normalize(position.xyz);
                ret.UV.x = 0.5 + atan(n.z, n.x) / (2.0 * PI);
                ret.UV.y = 0.5 - asin(n.y) / PI;
                ret.baseColor = sdf_basecolor_${this.ID};
                return ret;
            }`;
    }
    writeShaderData(gl, program) {
        gl.uniform1f(gl.getUniformLocation(program, `sdf_radius_${this.ID}`), this.raw.radius)
        gl.uniform3fv(gl.getUniformLocation(program, `sdf_basecolor_${this.ID}`), this.raw.basecolor || Vec.of(1,1,1));
    }
    getDistanceShaderSource(position_src) {
        return `(length(${position_src}.xyz) - sdf_radius_${this.ID})`;
    }
    getMaterialShaderSource(position_src) {
        return `sdfMaterialData_${this.ID}(${position_src})`;
    }
}

class WebGLBoxSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
    }
    getShaderSourceDeclarations() {
        return `
            uniform vec4 sdf_boxsize_${this.ID};
            uniform vec3 sdf_basecolor_${this.ID};
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position);`;
    }
    getShaderSource() {
        return `
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position) {
                GeometricMaterialData ret;
                ret.baseColor = sdf_basecolor_${this.ID};
                return ret;
            }`;
    }
    writeShaderData(gl, program) {
        gl.uniform4fv(gl.getUniformLocation(program, `sdf_boxsize_${this.ID}`), this.raw.size);
        gl.uniform3fv(gl.getUniformLocation(program, `sdf_basecolor_${this.ID}`), this.raw.basecolor || Vec.of(1,1,1));
    }
    getDistanceShaderSource(position_src) {
        return `sdfBoxDistance(${position_src}, sdf_boxsize_${this.ID})`;
    }
    getMaterialShaderSource(position_src) {
        return `sdfMaterialData_${this.ID}(${position_src})`;
    }
}

class WebGLPlaneSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
    }
    getShaderSourceDeclarations() {
        return `
            uniform vec4 sdf_planenormal_${this.ID};
            uniform float sdf_planedelta_${this.ID};
            uniform vec3 sdf_basecolor_${this.ID};
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position);`;
    }
    getShaderSource() {
        return `
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position) {
                GeometricMaterialData ret;
                data.UV = vec2(position.x, position.y);
                ret.baseColor = sdf_basecolor_${this.ID};
                return ret;
            }`;
    }
    writeShaderData(gl, program) {
        gl.uniform4fv(gl.getUniformLocation(program, `sdf_planenormal_${this.ID}`), this.raw.normal);
        gl.uniform1f(gl.getUniformLocation(program, `sdf_planedelta_${this.ID}`), this.raw.delta);
        gl.uniform3fv(gl.getUniformLocation(program, `sdf_basecolor_${this.ID}`), this.raw.basecolor || Vec.of(1,1,1));
    }
    getDistanceShaderSource(position_src) {
        return `(dot(${position_src}, sdf_planenormal_${this.ID}) + sdf_planedelta_${this.ID})`;
    }
    getMaterialShaderSource(position_src) {
        return `sdfMaterialData_${this.ID}(${position_src})`;
    }
}

class WebGLTetrahedronSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
    }
    getShaderSourceDeclarations() {
        return `
            uniform vec3 sdf_basecolor_${this.ID};
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position);`;
    }
    getShaderSource() {
        return `
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position) {
                GeometricMaterialData ret;
                ret.baseColor = sdf_basecolor_${this.ID};
                return ret;
            }`;
    }
    writeShaderData(gl, program) {
        gl.uniform3fv(gl.getUniformLocation(program, `sdf_basecolor_${this.ID}`), this.raw.basecolor || Vec.of(1,1,1));
    }
    getDistanceShaderSource(position_src) {
        return `sdfUnitTetrahedronDistance(${position_src})`;
    }
    getMaterialShaderSource(position_src) {
        return `sdfMaterialData_${this.ID}(${position_src})`;
    }
}



class WebGLMatrixTransformSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
    }
    getShaderSourceDeclarations() {
        return `
            uniform mat4  sdf_transform_invmatrix_${this.ID};
            uniform float sdf_transform_scale_${this.ID};
            vec4 sdf_transform_${this.ID}(in vec4 position, inout float scale);`;
    }
    writeShaderData(gl, program) {
        gl.uniformMatrix4fv(gl.getUniformLocation(program, `sdf_transform_invmatrix_${this.ID}`), true, this.raw._inv_transform.flat());
        gl.uniform1f(gl.getUniformLocation(program, `sdf_transform_scale_${this.ID}`), this.raw._scale);
    }
    getShaderSource() {
        return `
            vec4 sdf_transform_${this.ID}(in vec4 position, inout float scale) {
                scale *= sdf_transform_scale_${this.ID};
                return sdf_transform_invmatrix_${this.ID} * position;
            }`;
    }
    getTransformShaderSource(position_src, scale_src) {
        return `sdf_transform_${this.ID}(${position_src}, ${scale_src})`;
    }
}

class WebGLTransformerSequenceSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
        this.transformers = raw.transformers.map(t => adapter.wrapNodeTransformer(t));
    }
    getShaderSourceDeclarations() {
        return `
            vec4 sdf_transform_${this.ID}(in vec4 position, inout float scale);`;
    }
    getShaderSource() {
        return `
            vec4 sdf_transform_${this.ID}(in vec4 position, inout float scale) {
${this.transformers.map(t => "                position = " + t.getTransformShaderSource("position", "scale") + ";").join("\n")}
                return position;
            }`;
    }
    getTransformShaderSource(position_src, scale_src) {
        return `sdf_transform_${this.ID}(${position_src}, ${scale_src})`;
    }
}

class WebGLSDFReflectionTransformerSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
    }
    getShaderSourceDeclarations() {
        return `
            uniform vec4  sdf_transform_normal_${this.ID};
            uniform float sdf_transform_delta_${this.ID};
            vec4 sdf_transform_${this.ID}(in vec4 position, inout float scale);`;
    }
    writeShaderData(gl, program) {
        gl.uniform4fv(gl.getUniformLocation(program, `sdf_transform_normal_${this.ID}`), this.raw.normal);
        gl.uniform1f(gl.getUniformLocation(program, `sdf_transform_delta_${this.ID}`), this.raw.delta);
    }
    getShaderSource() {
        return `
            vec4 sdf_transform_${this.ID}(in vec4 position) {
                float d = dot(position, sdf_transform_normal_${this.ID}) - sdf_transform_delta_${this.ID};
                return (d >= 0.0) ? position : position - 2.0 * d * sdf_transform_normal_${this.ID};
            }`;
    }
    getTransformShaderSource(position_src, scale_src) {
        return `sdf_transform_${this.ID}(${position_src})`;
    }
}

class WebGLSDFRecursiveTransformerSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
        this.transformer = adapter.wrapNodeTransformer(raw.transformer);
    }
    getShaderSourceDeclarations() {
        return `
            uniform int sdf_transform_iterations_${this.ID};
            vec4 sdf_transform_${this.ID}(in vec4 position, inout float scale);`;
    }
    writeShaderData(gl, program) {
        gl.uniform1i(gl.getUniformLocation(program, `sdf_transform_iterations_${this.ID}`), this.raw.iterations);
    }
    getShaderSource() {
        return `
            vec4 sdf_transform_${this.ID}(in vec4 position, inout float scale) {
                for (int i = 0; i < sdf_transform_iterations_${this.ID}; ++i)
                    position = ${this.transformer.getTransformShaderSource("position", "scale")};
                return position;
            }`;
    }
    getTransformShaderSource(position_src, scale_src) {
        return `sdf_transform_${this.ID}(${position_src}, ${scale_src})`;
    }
}

class WebGLSDFInfiniteRepetitionTransformerSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
    }
    getShaderSourceDeclarations() {
        return `
            uniform vec3 sdf_transform_sizes_${this.ID};
            vec4 sdf_transform_${this.ID}(in vec4 position);`;
    }
    writeShaderData(gl, program) {
        gl.uniform3fv(gl.getUniformLocation(program, `sdf_transform_sizes_${this.ID}`), this.raw.sizes.to3());
    }
    getShaderSource() {
        return `
            vec4 sdf_transform_${this.ID}(in vec4 position) {
                return position - vec4(sdf_transform_sizes_${this.ID} * round(position.xyz / sdf_transform_sizes_${this.ID}), 0);
            }`;
    }
    getTransformShaderSource(position_src, scale_src) {
        return `sdf_transform_${this.ID}(${position_src})`;
    }
}
