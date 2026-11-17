class WebGLVecStore {
    constructor(components=3, reuse=true) {
        this.reuse = reuse;
        this.components = components;
        this.data_map = {};
        this.data = [];
    }
    clear() {
        this.data_map = {};
        this.data = [];
    }
    size() {
        return this.data.length;
    }
    store(vec, allow_reuse) {
        vec = vec.slice(0, this.components);
        if (!this.reuse || !allow_reuse) {
            this.data.push(Array.from(vec));
            return this.data.length - 1;
        }
        const key = vec.to_string();
        if (!(key in this.data_map)) {
            this.data_map[key] = this.data.length;
            this.data.push(Array.from(vec));
        }
        return this.data_map[key];
    }
    get(index) {
        return Vec.of(this.data[index]);
    }
    set(index, value) {
        return this.data[index] = Array.from(value);
    }
    flat() {
        return this.data.flat();
    }
}

class WebGLTransformStore {
    constructor(components=4, reuse=true) {
        this.reuse = reuse;
        this.components = components;
        this.data_map = {};
        this.data = [];
    }
    clear() {
        this.data_map = {};
        this.data = [];
    }
    size() {
        return this.data.length;
    }
    store(mat, allow_reuse) {
        if (!this.reuse|| !allow_reuse) {
            this.data.push(mat);
            return this.data.length - 1;
        }
        // Most primitives in big meshes have identity transforms; skip building a string key for those.
        const key = mat.is_identity(0) ? "identity" : mat.toString();
        if (!(key in this.data_map)) {
            this.data_map[key] = this.data.length;
            this.data.push(mat);
        }
        return this.data_map[key];
    }
    get(index) {
        return this.data[index];
    }
    set(index, value) {
        return this.data[index] = value;
    }
    flat(transpose=false) {
        return Mat.mats_flat(this.data, transpose);
    }
}

class WebGLHelper {
    constructor(gl) {
        this.gl = gl;
        
        gl.getExtension('EXT_color_buffer_float');
        gl.getExtension('EXT_float_blend');
        
        this.texture_units = [];
    }
    
    destroy() {}
    
    allocateTextureUnit() {
        const ret = this.gl.TEXTURE0 + this.texture_units.length;
        this.texture_units.push(ret);
        this.gl.activeTexture(ret);
        return ret;
    }
    static textureUnitIndex(index) {
        return index - WebGL2RenderingContext.TEXTURE0;
    }
    createTexture(channels=4, type="FLOAT", width=1, height=1, interp=false, data=null) {
        return new WebGLTexture(this.gl, channels, type, width, height, interp, data);
    }
    createTextureAndUnit(channels=4, type="FLOAT", width=1, height=1, filter=false, data=null) {
        const texture_unit = this.allocateTextureUnit();
        const texture_id = this.createTexture(channels, type, width, height, filter, data);
        texture_id.texture_unit = texture_unit;
        return [texture_unit, texture_id];
    }
    createDataTexture(channels, type, data=null) {
        const [width, height, texture_data] = WebGLTexture.coerceToDataTextureData(channels, type, data);
        return this.createTexture(channels, type, width, height, false, texture_data);
    }
    createDataTextureAndUnit(channels, type, data=null) {
        const texture_unit = this.allocateTextureUnit();
        const texture = this.createDataTexture(channels, type, data);
        texture.texture_unit = texture_unit;
        return [texture_unit, texture];
    }
    
    color_attachment(i) {
        return this.gl["COLOR_ATTACHMENT"+i];
    }
    
    getShaderSourceDeclarations() {
        return ShaderLibrary.render("util.glsl", "declarations");
    }
    getShaderSource() {
        return ShaderLibrary.render("util.glsl", "source", {
            dataTextureWidth: WebGLTexture.DATA_TEXTURE_WIDTH,
            dataTextureMask:  WebGLTexture.DATA_TEXTURE_WIDTH - 1,
            dataTextureShift: Math.log2(WebGLTexture.DATA_TEXTURE_WIDTH)
        });
    }
    writeShaderData() {}
    
    static compileMultipleShaderProgramsFromSources(gl, sources, callback=null) {
        let todoCount = sources.length;
        const ret = new Array(sources.length);
        sources.forEach((source, i) => {
            if (!source.vertex || !source.fragment)
                throw "Undefined source or fragment shader";
            ret[i] = WebGLHelper.compileShaderProgramFromSources(gl, source.vertex, source.fragment, program => {
                ret[i] = program;
                if (--todoCount == 0 && callback)
                    callback(ret);
            });
        });
        return ret;
    }
    
    // Create/compile vertex and fragment shaders with the specified sources
    // As shader compilation may take a long time, potentially locking the browser for the duration,
    // this provides async support for the KHR_parallel_shader_compile extension.
    static compileShaderProgramFromSources(gl, vsSource, fsSource, callback=null) {
        const parallel_compile_ext = callback && gl.getExtension('KHR_parallel_shader_compile');
        
        const vertexShader   = WebGLHelper.compileShaderOfTypeFromSource(gl, gl.VERTEX_SHADER,   vsSource);
        const fragmentShader = WebGLHelper.compileShaderOfTypeFromSource(gl, gl.FRAGMENT_SHADER, fsSource);

        // Create the shader program
        const shaderProgram = gl.createProgram();
        gl.attachShader(shaderProgram, vertexShader);
        gl.attachShader(shaderProgram, fragmentShader);
        gl.linkProgram( shaderProgram);

        // If creating the shader program failed, throw an error
        function checkToUseProgram() {
            if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
                if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS))
                    throw 'An error occurred compiling the vertex shader: ' + gl.getShaderInfoLog(vertexShader);
                if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
                    const flines = fsSource.split("\n");
                    const error_txt = gl.getShaderInfoLog(fragmentShader);
                    throw 'An error occurred compiling the fragment shader: ' + error_txt;
                }
                throw 'Unable to initialize the shader program: ' + gl.getProgramInfoLog(shaderProgram);
            }
            if (callback)
                callback(shaderProgram);
        }

        if (parallel_compile_ext) {
            function checkCompletion() {
                try {
                    if (gl.getProgramParameter(shaderProgram, parallel_compile_ext.COMPLETION_STATUS_KHR))
                        checkToUseProgram();
                    else
                        requestAnimationFrame(checkCompletion);
                }
                catch(e) {
                    myconsole.error(e);
                    LoadingStatus.failed();
                }
            }
            requestAnimationFrame(checkCompletion);
        }
        else
            checkToUseProgram();
        
        return shaderProgram;
    }
    
    // Utility function to compile a shader of the given type from given source code
    static compileShaderOfTypeFromSource(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        return shader;
    }
}

class WebGLTexture {
    static channels_map = [ null, "R", "RG", "RGB", "RGBA" ];
    static type_map = {
        "INTEGER"   : { type: "INT",           internal_format: "32I", format: "_INTEGER", array_type: Int32Array   },
        "FLOAT"     : { type: "FLOAT",         internal_format: "32F", format: "",         array_type: Float32Array },
        "IMAGEDATA" : { type: "UNSIGNED_BYTE", internal_format: "",    format: "",         array_type: ImageData    },
    };
    // Data-texture layout: every data texture is DATA_TEXTURE_WIDTH texels wide (a power of two) and as tall as
    // needed, so the shader can turn an index into a texel with a mask and shift (see computeGenericIndex).
    static DATA_TEXTURE_WIDTH = 2048;
    static coerceToDataTextureData(channels, type, data) {
        if (!WebGLTexture.channels_map[channels] || !WebGLTexture.type_map[type])
            throw "Invalid texture channels or type passed";
        if (!data)
            data = [];
        const texels = Math.max(1, Math.ceil(data.length / channels));
        const width = WebGLTexture.DATA_TEXTURE_WIDTH, height = Math.ceil(texels / width);
        const out = new WebGLTexture.type_map[type].array_type(channels * width * height);
        out.set(data);
        return [width, height, out];
    }
    
    constructor(gl, channels=4, type="FLOAT", width=1, height=1, interp=false, data=null) {
        this.gl = gl;
        this.interp = interp;
        
        this.texture_id = gl.createTexture();
        this.setPixels(data, channels, type, width, height);
    }
    destroy() {
        this.gl.deleteTexture(this.texture_id);
    }
    id() {
        return this.texture_id;
    }
    bind(texture_unit=null) {
        if (texture_unit)
            this.gl.activeTexture(texture_unit);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture_id);
    }
    setPixels(data=null, channels=this.channels, type=this.type, width=this.width, height=this.height) {
        const channel_str = WebGLTexture.channels_map[channels],
              type_data   = WebGLTexture.type_map[type];
        if (!channel_str || !type_data)
            throw "Invalid texture channels or type passed";
        
        if (data && !(data instanceof type_data.array_type))
            data = type_data.array_type.from(data);
        
        this.channels = channels;
        this.type = type;
        this.width = width;
        this.height = height;
        
        if (this.texture_unit)
            this.gl.activeTexture(this.texture_unit);   // see modifyPixel
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture_id);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl[channel_str + type_data.internal_format], width, height, 0,
            this.gl[(channels == 1 ? "RED" : channel_str) + type_data.format], this.gl[type_data.type], data);
        if (this.interp) {
            if (Math.isPowerOf2(width) && Math.isPowerOf2(height))
                this.gl.generateMipmap(this.gl.TEXTURE_2D);
            else
                this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        }
        else {
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
        }
    }
    setDataPixels(data=null, channels=this.channels, type=this.type) {
        const [width, height, texture_data] = WebGLTexture.coerceToDataTextureData(channels, type, data);
        this.setPixels(texture_data, channels, type, width, height);
    }
    setDataPixelsUnit(data=null, texture_unit=null, uniform_name=null, shader_program=null, channels=this.channels, type=this.type) {
        if (texture_unit)
            this.gl.activeTexture(texture_unit);
        this.setDataPixels(data, channels, type);
        if (texture_unit && uniform_name && shader_program)
            this.gl.uniform1i(this.gl.getUniformLocation(shader_program, uniform_name), WebGLHelper.textureUnitIndex(texture_unit));
    }
    modifyPixel(x, y, new_value) {
        const channel_str = WebGLTexture.channels_map[this.channels],
              type_data   = WebGLTexture.type_map[this.type];
        if (!channel_str || !type_data)
            throw "Invalid texture channels or type passed";
        
        if (new_value && !(new_value instanceof type_data.array_type))
            new_value = type_data.array_type.from(new_value);
        
        // Bind on this texture's own unit. Binding on whatever unit happens to be active replaces that unit's texture:
        // after a data upload that can be another data texture, and if the sampler types differ every draw then
        // fails with INVALID_OPERATION.
        if (this.texture_unit)
            this.gl.activeTexture(this.texture_unit);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture_id);
        this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0,
            x, y, 1, 1, this.gl[(this.channels == 1 ? "RED" : channel_str) + type_data.format], this.gl[type_data.type], new_value);
    }
    modifyDataPixel(index, new_value) {
        this.modifyPixel(index % this.width, Math.floor(index / this.width), new_value);
    }
}

// The loading indicator: the spinner beside the scene button and a label over the canvas, which say which phase of
// loading a scene is in. Each phase starts with phase(), and the first frame drawn ends it all with done(). An error
// while a scene is loading means it won't arrive, so failed() stops the spinner and says so; an error at any other
// time is only logged, since nothing is loading then.
class LoadingStatus {
    static active = false;
    static phase(label) {
        LoadingStatus.active = true;
        $("#loading-overlay").text(label + "...").removeClass("failed");
        $(".loading").css("visibility", "visible");
    }
    static done() {
        LoadingStatus.active = false;
        $(".loading").css("visibility", "hidden");
    }
    // Returns whether a scene was loading (and so has now failed).
    static failed() {
        if (!LoadingStatus.active)
            return false;
        LoadingStatus.active = false;
        $("#loading-img").css("visibility", "hidden");
        $("#loading-overlay").text("Loading failed: see the log").addClass("failed").css("visibility", "visible");
        return true;
    }
    // Runs fn once the browser has had a chance to show a new phase: after the next frame, or after 50 ms if no frame
    // comes (a hidden tab draws none). Long synchronous steps would otherwise run before the label ever appears.
    static afterPaint(fn) {
        let ran = false;
        const run = () => {
            if (!ran) {
                ran = true;
                fn();
            }
        };
        requestAnimationFrame(() => setTimeout(run, 0));
        setTimeout(run, 50);
    }
}
