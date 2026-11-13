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
            return this.sdfs[sdf.UID];
        let adapter_ = null;
        
        if (sdf instanceof UnionSDF)
            adapter_ = new WebGLUnionSDFDecorator(sdf, this);
        else if (sdf instanceof IntersectionSDF)
            adapter_ = new WebGLIntersectionSDFDecorator(sdf, this);
        else if (sdf instanceof DifferenceSDF)
            adapter_ = new WebGLDifferenceSDFDecorator(sdf, this);
        
        else if (sdf instanceof SmoothUnionSDF)
            adapter_ = new WebGLSmoothUnionSDFDecorator(sdf, this);
        else if (sdf instanceof SmoothIntersectionSDF)
            adapter_ = new WebGLSmoothIntersectionSDFDecorator(sdf, this);
        else if (sdf instanceof SmoothDifferenceSDF)
            adapter_ = new WebGLSmoothDifferenceSDFDecorator(sdf, this);
        
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
    getMutableObjectProperties(index, renderer_adapter) {
        const g = this.geometries[index], modifyFn = this.modifyGeometryProperty.bind(this, renderer_adapter, index);
        return [
            { title: "max_samples",        key: "max_samples",        value: g.max_samples,        type: "number", step: 1, modifyFn: modifyFn },
            { title: "distance_epsilon",   key: "distance_epsilon",   value: g.distance_epsilon,   type: "number", modifyFn: modifyFn },
            { title: "max_trace_distance", key: "max_trace_distance", value: g.max_trace_distance, type: "number", modifyFn: modifyFn },
            { title: "normal_step_size",   key: "normal_step_size",   value: g.normal_step_size,   type: "number", modifyFn: modifyFn }
        ].concat(this.sdfs[g.root_sdf.UID].getMutableObjectProperties(renderer_adapter));
    }
    modifyGeometryProperty(renderer_adapter, index, key, newvalue) {
        this.geometries[index][key] = newvalue;
        
        renderer_adapter.useTracerProgram();
        this.writeGeometryShaderData(renderer_adapter.gl, renderer_adapter.tracerShaderProgram, index);
        renderer_adapter.resetDrawCount();
    }
    getShaderSourceDeclarations(sceneEditable) {
        // Bake SDF parameters into the scene-specific shader as constants (see WebGLSDFDecorator.param). The
        // editable shader keeps uniforms, so that editing them stays instant.
        this.useConstants = WebGLRendererAdapter.sdfConstants && !sceneEditable && !this.forceUniforms;
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
    getShaderSource(sceneEditable) {
        if (Object.keys(this.sdfs).length == 0)
            return `
            // =============== SDF ===============
            float sdfIntersect(in Ray r, in float minDistance, in int sdfID) { return minDistance - 1.0; }
            void sdfMaterialData(in vec4 position, inout GeometricMaterialData data, in int sdfID) {}`;
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
            float sdfSmoothMin(in float a, in float b, in float k) {
                float h = max( k - abs( a - b ), 0.0 ) / k;
                return min( a, b ) - h * h * h * k * (1.0 / 6.0);
            }
            float sdfSmoothMinBlend(in float a, in float b, in float k) {
                float h = max( k - abs( a - b ), 0.0 ) / k;
                float m = h * h * h * 0.5;
                return (a < b) ? m : (1.0 - m);
            }
            GeometricMaterialData sdfBlendMaterialData(in float mix_factor, in GeometricMaterialData data_a, in GeometricMaterialData data_b) {
                if      (mix_factor <= 0.0) return data_a;
                else if (mix_factor >= 1.0) return data_b;
                GeometricMaterialData ret;
                ret.baseColor = mix(data_a.baseColor, data_b.baseColor, mix_factor);
                ret.UV = mix(data_a.UV, data_b.UV, mix_factor);
                return ret;
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
            uniform vec3 sdf_${i}_aabb_min;
            uniform vec3 sdf_${i}_aabb_max;
        
            float sdfGeometryDistance_${i}(in vec4 position) {
                return ${this.sdfs[g.root_sdf.UID].getDistanceShaderSource("position")};
            }
            float sdfIntersect_${i}(in Ray r, in float minDistance) {
                float rd_norm = length(r.d);
                float t = minDistance, tEnd = minDistance + sdf_${i}_max_trace_distance / rd_norm;${WebGLRendererAdapter.debugSDFBounds ? `
                // March only inside the SDF's bounding box (a slab test, in the SDF's own space): start where the
                // ray enters it and stop where it leaves. Rays that miss it entirely cost nothing.
                {
                    vec3 invD = 1.0 / r.d.xyz;
                    vec3 t0 = (sdf_${i}_aabb_min - r.o.xyz) * invD, t1 = (sdf_${i}_aabb_max - r.o.xyz) * invD;
                    vec3 tn = min(t0, t1), tf = max(t0, t1);
                    float tEnter = max(max(tn.x, tn.y), tn.z), tExit = min(min(tf.x, tf.y), tf.z);
                    if (tExit < tEnter || tExit < minDistance)
                        return minDistance - 1.0;
                    if (!isnan(tEnter) && !isnan(tExit)) {
                        t = max(t, tEnter);
                        tEnd = min(tEnd, tExit + sdf_${i}_distance_epsilon / rd_norm);
                    }
                }` : ``}
                for (int i = 0; i < sdf_${i}_max_samples; ++i) {
                    float distance = sdfGeometryDistance_${i}(r.o + t * r.d);
                    
                    if (isinf(distance) || isnan(distance))
                        break;
                    
                    if (distance <= sdf_${i}_distance_epsilon)
                        return t;
                    
                    t += distance / rd_norm;
                    if (t < minDistance || t > tEnd)
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
    writeGeometryShaderData(gl, program, i) {
        const g = this.geometries[i];
        // Editing an SDF's parameters can change its extent, so the bounds are recomputed on every write.
        g.aabb = g.root_sdf.getBoundingBox(Mat4.identity(), Mat4.identity());
        gl.uniform1i(gl.getUniformLocation(program, `sdf_${i}_max_samples`),        g.max_samples);
        gl.uniform1f(gl.getUniformLocation(program, `sdf_${i}_distance_epsilon`),   g.distance_epsilon);
        gl.uniform1f(gl.getUniformLocation(program, `sdf_${i}_max_trace_distance`), g.max_trace_distance);
        gl.uniform1f(gl.getUniformLocation(program, `sdf_${i}_normal_step_size`),   g.normal_step_size);
        // Infinite bounds (repetition) are clamped to a large finite value; the slab test then never clips.
        const finite = v => [0, 1, 2].map(k => Math.max(-1e30, Math.min(1e30, v[k])));
        gl.uniform3fv(gl.getUniformLocation(program, `sdf_${i}_aabb_min`), finite(g.aabb.min));
        gl.uniform3fv(gl.getUniformLocation(program, `sdf_${i}_aabb_max`), finite(g.aabb.max));
    }
    writeShaderData(gl, program) {
        for (let i = 0; i < this.geometries.length; ++i)
            this.writeGeometryShaderData(gl, program, i);
        for (const [k, dec] of Object.entries(this.sdfs))
            dec.writeShaderData(gl, program);
        for (const [k, dec] of Object.entries(this.transforms))
            dec.writeShaderData(gl, program);
    }
}

class WebGLSDFDecorator {
    constructor(raw, adapter) {
        this._adapter = adapter;
        this.raw = raw;
        this.ID = adapter.ID_GEN++;
    }
    writeShaderData(gl, program) {}

    // An SDF parameter is either a uniform, written by writeShaderData, or a constant baked into the shader, which
    // lets the compiler fold it: zeros in a matrix, infinite box sizes, fixed loop counts. See
    // WebGLRendererAdapter.sdfConstants and modifyProperty.
    get constants() { return !!this._adapter.useConstants; }
    static glslFloat(x) {
        if (!isFinite(x))
            return x > 0 ? "1e30" : "-1e30";
        const s = String(Number(x));
        return /[.e]/.test(s) ? s : s + ".0";
    }
    static glslLiteral(type, value) {
        const F = WebGLSDFDecorator.glslFloat;
        if (type == "float") return F(value);
        if (type == "int")   return String(Math.round(value));
        if (type == "vec3")  return `vec3(${[0, 1, 2].map(i => F(value[i])).join(", ")})`;
        if (type == "vec4")  return `vec4(${[0, 1, 2, 3].map(i => F(value[i])).join(", ")})`;
        // mat4 values are row-major (as uploaded with transpose = true); GLSL's constructor takes columns.
        if (type == "mat4")  return `mat4(${[0, 1, 2, 3].map(c => [0, 1, 2, 3].map(r => F(value[r * 4 + c]))).flat().join(", ")})`;
        throw "Unsupported SDF parameter type " + type;
    }
    param(type, name, value) {
        return this.constants
            ? `const ${type} ${name} = ${WebGLSDFDecorator.glslLiteral(type, value)};`
            : `uniform ${type} ${name};`;
    }
    writeParam(gl, program, type, name, value) {
        if (this.constants)
            return;
        const loc = gl.getUniformLocation(program, name);
        if (type == "float")     gl.uniform1f(loc, value);
        else if (type == "int")  gl.uniform1i(loc, value);
        else if (type == "vec3") gl.uniform3fv(loc, value.slice(0, 3));
        else if (type == "vec4") gl.uniform4fv(loc, value.slice(0, 4));
        else if (type == "mat4") gl.uniformMatrix4fv(loc, true, value);
    }
    getShaderSourceDeclarations() {
        return "";
    }
    getShaderSource() {
        return "";
    }
    getMutableObjectProperties(renderer_adapter) {
        const ret = [], titlebase = `${this.raw.constructor.name} ${this.ID}: `;
        for (const [k,v] of Object.entries(this.raw)) {
            if (typeof v === 'number' && k != "UID")
                ret.push({ title: titlebase + k, key: k, value: v, type: "number", modifyFn: this.modifyProperty.bind(this, renderer_adapter) });
            else if (v instanceof Vec)
                ret.push({ title: titlebase + k, key: k, value: v, type: k == "basecolor" ? "color" : "vec", modifyFn: this.modifyProperty.bind(this, renderer_adapter) });
            else if (v instanceof Mat)
                ret.push({ title: titlebase + k, key: k, value: v, type: "mat", modifyFn: this.modifyProperty.bind(this, renderer_adapter) });
        }
        for (const [k,v] of Object.entries(this)) {
            if (v instanceof WebGLSDFDecorator)
                ret.push(... v.getMutableObjectProperties(renderer_adapter));
            if (v instanceof Array)
                ret.push(... v.filter(e => e instanceof WebGLSDFDecorator).map(e => e.getMutableObjectProperties(renderer_adapter)).flat());
        }
        return ret;
    }
    modifyProperty(renderer_adapter, key, newvalue) {
        this.raw[key] = newvalue;
        if (this.constants) {
            // The value was compiled into the shader. Rebuild it once with uniforms, so that this and later edits
            // (dragging a value, say) don't each need a recompile.
            myconsole.log("Editing an SDF: rebuilding the shader with SDF parameters as uniforms...");
            this._adapter.forceUniforms = true;
            renderer_adapter.worldModified();
            return;
        }
        
        renderer_adapter.useTracerProgram();
        this.writeShaderData(renderer_adapter.gl, renderer_adapter.tracerShaderProgram);
        // The edit may have changed the SDF's bounds.
        for (let i = 0; i < this._adapter.geometries.length; ++i)
            this._adapter.writeGeometryShaderData(renderer_adapter.gl, renderer_adapter.tracerShaderProgram, i);
        renderer_adapter.resetDrawCount();
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
                float d;
                ${cs.slice(1).map((c,i) => `d = ${c};
                if (d < bestDist) { bestDist = d; ret = ${cm[i+1]}; }`).join('\n')}
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
                float d;
                ${cs.slice(1).map((c,i) => `d = ${c};
                if (d > bestDist) { bestDist = d; ret = ${cm[i+1]}; }`).join('\n')}
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

class WebGLSmoothUnionSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
        this.childA = adapter.wrapNodeSDF(raw.childA);
        this.childB = adapter.wrapNodeSDF(raw.childB);
    }
    getShaderSourceDeclarations() {
        return `${this.param("float", `sdf_smoothK_${this.ID}`, this.raw.k)}`;
    }
    getDistanceShaderSource(position_src) {
        return `sdfSmoothMin(${this.childA.getDistanceShaderSource(position_src)}, ${this.childB.getDistanceShaderSource(position_src)}, sdf_smoothK_${this.ID})`;
    }
    getMaterialShaderSource(position_src) {
        return `sdfBlendMaterialData(sdfSmoothMinBlend(${this.childA.getDistanceShaderSource(position_src)}, ${this.childB.getDistanceShaderSource(position_src)}, sdf_smoothK_${this.ID}), ${this.childA.getMaterialShaderSource(position_src)}, ${this.childB.getMaterialShaderSource(position_src)})`;
    }
    writeShaderData(gl, program) {
        this.writeParam(gl, program, "float", `sdf_smoothK_${this.ID}`, this.raw.k);
    }
}

class WebGLSmoothIntersectionSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
        this.childA = adapter.wrapNodeSDF(raw.childA);
        this.childB = adapter.wrapNodeSDF(raw.childB);
    }
    getShaderSourceDeclarations() {
        return `${this.param("float", `sdf_smoothK_${this.ID}`, this.raw.k)}`;
    }
    getDistanceShaderSource(position_src) {
        return `-sdfSmoothMin(-${this.childA.getDistanceShaderSource(position_src)}, -${this.childB.getDistanceShaderSource(position_src)}, sdf_smoothK_${this.ID})`;
    }
    getMaterialShaderSource(position_src) {
        return `sdfBlendMaterialData(1.0-sdfSmoothMinBlend(-${this.childA.getDistanceShaderSource(position_src)}, -${this.childB.getDistanceShaderSource(position_src)}, sdf_smoothK_${this.ID}), ${this.childA.getMaterialShaderSource(position_src)}, ${this.childB.getMaterialShaderSource(position_src)})`;
    }
    writeShaderData(gl, program) {
        this.writeParam(gl, program, "float", `sdf_smoothK_${this.ID}`, this.raw.k);
    }
}

class WebGLSmoothDifferenceSDFDecorator extends WebGLSDFDecorator {
    constructor(raw, adapter) {
        super(raw, adapter);
        this.positive = adapter.wrapNodeSDF(raw.positive);
        this.negative = adapter.wrapNodeSDF(raw.negative);
    }
    getShaderSourceDeclarations() {
        return `${this.param("float", `sdf_smoothK_${this.ID}`, this.raw.k)}`;
    }
    getDistanceShaderSource(position_src) {
        return `-sdfSmoothMin(-${this.positive.getDistanceShaderSource(position_src)}, ${this.negative.getDistanceShaderSource(position_src)}, sdf_smoothK_${this.ID})`;
    }
    getMaterialShaderSource(position_src) {
        return `sdfBlendMaterialData(sdfSmoothMinBlend(-${this.positive.getDistanceShaderSource(position_src)}, ${this.negative.getDistanceShaderSource(position_src)}, sdf_smoothK_${this.ID}), ${this.positive.getMaterialShaderSource(position_src)}, ${this.negative.getMaterialShaderSource(position_src)})`;
    }
    writeShaderData(gl, program) {
        this.writeParam(gl, program, "float", `sdf_smoothK_${this.ID}`, this.raw.k);
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
            ${this.param("int", `sdf_recursiveUnionIterations_${this.ID}`, this.raw.iterations)}
            float sdf_recursiveUnionDistance_${this.ID}(in vec4 position);`;
    }
    writeShaderData(gl, program) {
        this.writeParam(gl, program, "int", `sdf_recursiveUnionIterations_${this.ID}`, this.raw.iterations);
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
            ${this.param("float", `sdf_radius_${this.ID}`, this.raw.radius)}
            ${this.param("vec3", `sdf_basecolor_${this.ID}`, this.raw.basecolor || Vec.of(1,1,1))}
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
        this.writeParam(gl, program, "float", `sdf_radius_${this.ID}`, this.raw.radius);
        this.writeParam(gl, program, "vec3", `sdf_basecolor_${this.ID}`, this.raw.basecolor || Vec.of(1,1,1));
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
            ${this.param("vec4", `sdf_boxsize_${this.ID}`, this.raw.size)}
            ${this.param("vec3", `sdf_basecolor_${this.ID}`, this.raw.basecolor || Vec.of(1,1,1))}
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
        this.writeParam(gl, program, "vec4", `sdf_boxsize_${this.ID}`, this.raw.size);
        this.writeParam(gl, program, "vec3", `sdf_basecolor_${this.ID}`, this.raw.basecolor || Vec.of(1,1,1));
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
            ${this.param("vec4", `sdf_planenormal_${this.ID}`, this.raw.normal)}
            ${this.param("float", `sdf_planedelta_${this.ID}`, this.raw.delta)}
            ${this.param("vec3", `sdf_basecolor_${this.ID}`, this.raw.basecolor || Vec.of(1,1,1))}
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position);`;
    }
    getShaderSource() {
        return `
            GeometricMaterialData sdfMaterialData_${this.ID}(in vec4 position) {
                GeometricMaterialData ret;
                ret.UV = vec2(position.x, position.y);
                ret.baseColor = sdf_basecolor_${this.ID};
                return ret;
            }`;
    }
    writeShaderData(gl, program) {
        this.writeParam(gl, program, "vec4", `sdf_planenormal_${this.ID}`, this.raw.normal);
        this.writeParam(gl, program, "float", `sdf_planedelta_${this.ID}`, this.raw.delta);
        this.writeParam(gl, program, "vec3", `sdf_basecolor_${this.ID}`, this.raw.basecolor || Vec.of(1,1,1));
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
            ${this.param("vec3", `sdf_basecolor_${this.ID}`, this.raw.basecolor || Vec.of(1,1,1))}
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
        this.writeParam(gl, program, "vec3", `sdf_basecolor_${this.ID}`, this.raw.basecolor || Vec.of(1,1,1));
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
            ${this.param("mat4", `sdf_transform_invmatrix_${this.ID}`, this.raw._inv_transform.flat())}
            ${this.param("float", `sdf_transform_scale_${this.ID}`, this.raw._scale)}
            vec4 sdf_transform_${this.ID}(in vec4 position, inout float scale);`;
    }
    writeShaderData(gl, program) {
        this.writeParam(gl, program, "mat4", `sdf_transform_invmatrix_${this.ID}`, this.raw._inv_transform.flat());
        this.writeParam(gl, program, "float", `sdf_transform_scale_${this.ID}`, this.raw._scale);
    }
    getMutableObjectProperties(renderer_adapter) {
        return super.getMutableObjectProperties(renderer_adapter).filter(x => x.key == "_transform");
    }
    modifyProperty(renderer_adapter, key, newvalue, inv_newvalue) {
        if (key == "_transform") {
            this.raw._transform = newvalue;
            this.raw._inv_transform = inv_newvalue || Mat4.inverse(newvalue);
            this.raw._scale = SDFMatrixTransformer.calcScaleForTransform(newvalue);
        }
        super.modifyProperty(renderer_adapter, key, newvalue);
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
            ${this.param("vec4", `sdf_transform_normal_${this.ID}`, this.raw.normal)}
            ${this.param("float", `sdf_transform_delta_${this.ID}`, this.raw.delta)}
            vec4 sdf_transform_${this.ID}(in vec4 position, inout float scale);`;
    }
    writeShaderData(gl, program) {
        this.writeParam(gl, program, "vec4", `sdf_transform_normal_${this.ID}`, this.raw.normal);
        this.writeParam(gl, program, "float", `sdf_transform_delta_${this.ID}`, this.raw.delta);
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
            ${this.param("int", `sdf_transform_iterations_${this.ID}`, this.raw.iterations)}
            vec4 sdf_transform_${this.ID}(in vec4 position, inout float scale);`;
    }
    writeShaderData(gl, program) {
        this.writeParam(gl, program, "int", `sdf_transform_iterations_${this.ID}`, this.raw.iterations);
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
            ${this.param("vec3", `sdf_transform_sizes_${this.ID}`, this.raw.sizes.to3())}
            vec4 sdf_transform_${this.ID}(in vec4 position);`;
    }
    writeShaderData(gl, program) {
        this.writeParam(gl, program, "vec3", `sdf_transform_sizes_${this.ID}`, this.raw.sizes.to3());
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
