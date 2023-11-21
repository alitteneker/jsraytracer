class WebGLSDFAdapter {
    constructor(webgl_helper) {
        this.reset();
    }
    destroy() {}
    reset() {
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
            
        else
            throw "Unsupported SDF node type";
        
        return this.transforms[transform.UID] = decorator;
    }
    getShaderSourceDeclarations() {
        return `
            // =============== SDF ===============
            float sdfIntersect(in Ray r, in float minDistance, in int sdfID);
            void sdfMaterialData(in vec4 position, inout GeometricMaterialData data, in int sdfID);`
        + this.geometries.map((g, i) => `
            float sdfIntersect_${i}(in Ray r, in float minDistance);
            void sdfMaterialData_${i}(in vec4 position, inout GeometricMaterialData data);`).join("")
        + Object.values(this.sdfs).map(d => d.getShaderSourceDeclarations()).join("")
        + Object.values(this.transforms).map(d => d.getShaderSourceDeclarations()).join("");
    }
    getShaderSource() {
        return `
            // =============== SDF ===============
            float sdfBoxDistance(in vec4 p, in vec4 size) {
                p = abs(p) - size;
                return length(max(p, vec4(0.0))) + min(max(p[0], max(p[1], p[2])), 0.0);
            }
            float sdfUnitTetrahedronDistance(in vec4 p) {
                return (max(abs(p[0] + p[1]) - p[2],
                            abs(p[0] - p[1]) + p[2]) - 1.0) / sqrt(3.0);
            }
            float sdfIntersect(in Ray r, in float minDistance, in int sdfID) {
                ${this.geometries.map((g, i) => `if (sdfID == ${i}) return sdfIntersect_${i}(r, minDistance);`).join("\n")}
                return minDistance - 1.0;
            }
            void sdfMaterialData(in vec4 position, inout GeometricMaterialData data, in int sdfID) {
                ${this.geometries.map((g, i) => `if (sdfID == ${i}) sdfMaterialData_${i}(position, data);`).join("\n")}
            }`
        + this.geometries.map((g, i) => `
            uniform int sdf_${i}_maxSamples;
            uniform float sdf_${i}_distance_epsilon;
            uniform float sdf_${i}_max_trace_distance;
            uniform float sdf_${i}_normal_step_size;
        
            float sdfDistance_${i}(in vec4 position) {
                return ${this.sdfs[g.root_sdf.UID].getDistanceShaderSource("position")};
            }
            float sdfIntersect_${i}(in Ray r, in float minDistance) {
                float t = minDistance;
                float rd_norm = length(r.d);
                for (int i = 0; i < sdf_${i}_maxSamples; ++i) {
                    vec4 p = r.o + t * r.d;
                    float distance = sdfDistance_${i}(r.o + t * r.d);
                    
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
                float distance = sdfDistance_${i}(position);
                for (int i = 0; i < 3; ++i)
                    data.normal[i] = (sdfDistance_${i}(position + sdf_${i}_normal_step_size * unitAxis4(i)) - distance) / sdf_${i}_normal_step_size;
            }`).join("")
        + Object.values(this.sdfs).map(d => d.getShaderSource()).join("")
        + Object.values(this.transforms).map(d => d.getShaderSource()).join("");
            
    }
    writeShaderData(gl, program) {
        for (const [i, g] of Object.entries(this.geometries)) {
            gl.uniform1i(gl.getUniformLocation(program, `sdf_${i}_maxSamples`), g.maxSamples);
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
    constructor(raw) {
        this.raw = raw;
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
    getTransformShaderSource(position_src, scale_src) {
        throw "Subclass has not implemented getTransformShaderSource";
    }
}

class WebGLUnionSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw);
        this.children = raw.children.map(c => adapter.wrapNodeSDF(c));
    }
    getDistanceShaderSource(position_src) {
        if (this.children.length == 0)
            return "1000.0";
        const cs = this.children.map(c => c.getDistanceShaderSource(position_src));
        return cs.slice(0, -1).map(c => `min(${c},`).join('') + cs[cs.length - 1] + ")".repeat(cs.length - 1);
    }
}

class WebGLIntersectionSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw);
        this.children = raw.children.map(c => adapter.wrapNodeSDF(c));
    }
    getDistanceShaderSource(position_src) {
        if (this.children.length == 0)
            return "1000.0";
        const cs = this.children.map(c => c.getDistanceShaderSource(position_src));
        return cs.slice(0, -1).map(c => `max(${c},`).join('') + cs[cs.length - 1] + ")".repeat(cs.length - 1);
    }
}

class WebGLDifferenceSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw);
        this.positive = adapter.wrapNodeSDF(raw.positive);
        this.negative = adapter.wrapNodeSDF(raw.negative);
    }
    getDistanceShaderSource(position_src) {
        return `max(${this.positive.getDistanceShaderSource(position_src)}, -${this.negative.getDistanceShaderSource(position_src)})`;
    }
}

class WebGLTransformSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw);
        this.transform = adapter.wrapNodeTransformer(raw.transformer);
        this.sdf = adapter.wrapNodeSDF(raw.child_sdf);
    }
    getShaderSourceDeclarations() {
        return `float sdf_transformDistance_${this.raw.UID}(in vec4 position);`;
    }
    getShaderSource() {
        return `
            float sdf_transformDistance_${this.raw.UID}(in vec4 position) {
                float scale = 1.0;
                return ${this.sdf.getDistanceShaderSource(`${this.transform.getTransformShaderSource("position", "scale")}`)} * scale;
            }`;
    }
    getDistanceShaderSource(position_src) {
        return `sdf_transformDistance_${this.raw.UID}(${position_src})`;
    }
}

// TODO: RoundSDF
// TODO: RecursiveTransformUnionSDF

class WebGLSphereSDFDecorator extends WebGLSDFDecorator {
    constructor(raw) {
        super(raw);
    }
    getShaderSourceDeclarations() {
        return `uniform float sdf_radius_${this.raw.UID};`;
    }
    writeShaderData(gl, program) {
        gl.uniform1f(gl.getUniformLocation(program, `sdf_radius_${this.raw.UID}`), this.raw.radius);
    }
    getDistanceShaderSource(position_src) {
        return `(length(${position_src}) - sdf_radius_${this.raw.UID})`;
    }
}

class WebGLBoxSDFDecorator extends WebGLSDFDecorator {
    constructor(raw) {
        super(raw);
    }
    getShaderSourceDeclarations() {
        return `uniform vec4 sdf_boxsize_${this.raw.UID};`;
    }
    writeShaderData(gl, program) {
        gl.uniform4fv(gl.getUniformLocation(program, `sdf_boxsize_${this.raw.UID}`), this.raw.size);
    }
    getDistanceShaderSource(position_src) {
        return `sdfBoxDistance(${position_src}, sdf_boxsize_${this.raw.UID})`;
    }
}

class WebGLPlaneSDFDecorator extends WebGLSDFDecorator {
    constructor(raw) {
        super(raw);
    }
    getShaderSourceDeclarations() {
        return `
            uniform vec4 sdf_planenormal_${this.raw.UID};
            uniform float sdf_planedelta_${this.raw.UID};`;
    }
    writeShaderData(gl, program) {
        gl.uniform4fv(gl.getUniformLocation(program, `sdf_planenormal_${this.raw.UID}`), this.raw.normal);
        gl.uniform1f(gl.getUniformLocation(program, `sdf_planedelta_${this.raw.UID}`), this.raw.delta);
    }
    getDistanceShaderSource(position_src) {
        return `(dot(${position_src}, sdf_planenormal_${this.raw.UID}) + sdf_planedelta_${this.raw.UID})`;
    }
}

class WebGLTetrahedronSDFDecorator extends WebGLSDFDecorator {
    constructor(raw) {
        super(raw);
    }
    getDistanceShaderSource(position_src) {
        return `sdfUnitTetrahedronDistance(${position_src})`;
    }
}



class WebGLMatrixTransformSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw);
    }
    getShaderSourceDeclarations() {
        return `
            uniform mat4  sdf_transform_invmatrix_${this.raw.UID};
            uniform float sdf_transform_scale_${this.raw.UID};
            vec4 sdf_transform_${this.raw.UID}(in vec4 position, inout float scale);`;
    }
    writeShaderData(gl, program) {
        gl.uniformMatrix4fv(gl.getUniformLocation(program, `sdf_transform_invmatrix_${this.raw.UID}`), true, this.raw._inv_transform.flat());
        gl.uniform1f(gl.getUniformLocation(program, `sdf_transform_scale_${this.raw.UID}`), this.raw.scale);
    }
    getShaderSource() {
        return `
            vec4 sdf_transform_${this.raw.UID}(in vec4 position, inout float scale) {
                scale *= sdf_transform_scale_${this.raw.UID};
                return sdf_transform_invmatrix_${this.raw.UID} * position;
            }`;
    }
    getTransformShaderSource(position_src, scale_src) {
        return `sdf_transform_${this.raw.UID}(${position_src}, ${scale_src})`;
    }
}

class WebGLTransformerSequenceSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw);
        this.transformers = raw.transformers.map(t => adapter.wrapNodeTransformer(t));
    }
    getShaderSourceDeclarations() {
        return `
            vec4 sdf_transform_${this.raw.UID}(in vec4 position, inout float scale);`;
    }
    getShaderSource() {
        return `
            vec4 sdf_transform_${this.raw.UID}(in vec4 position, inout float scale) {
                ${this.transformers.map(t => "position = " + t.getTransformShaderSource("position", "scale") + ";").join("\n")}
                return position;
            }`;
    }
    getTransformShaderSource(position_src, scale_src) {
        return `sdf_transform_${this.raw.UID}(${position_src}, ${scale_src})`;
    }
}

// TODO: SDFRecursiveTransformer
// TODO: SDFReflectionTransformer
// TODO: SDFInfiniteRepetitionTransformer