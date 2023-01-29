class WebGLVecStore {
    constructor(components=3) {
        this.components = components;
        this.data_map = {};
        this.data = [];
    }
    size() {
        return this.data.length;
    }
    visit(vec) {
        vec = vec.slice(0, this.components);
        const key = vec.to_string();
        if (key in this.data_map)
            return this.data_map[key];
        this.data_map[key] = this.data.length;
        this.data.push(Array.of(...vec));
        return this.data_map[key];
    }
    to_webgl() {
        return this.data.flat();
    }
}



class WebGLHelper {
    constructor(gl) {
        this.gl = gl;
        
        this.channels_map = [ null, "R", "RG", "RGB", "RGBA" ];
        this.type_map = {
            "INTEGER"  : { type: "INT",   internal_format: "32I", format: "_INTEGER", array_type: Int32Array   },
            "NORM_INT" : { type: "INT",   internal_format: "32I", format: "",         array_type: Int32Array   },
            "FLOAT"    : { type: "FLOAT", internal_format: "32F", format: "",         array_type: Float32Array }
            // TODO: image data types
        };
        
        this.texture_units = [];
    }
    allocateTextureUnit() {
        const ret = this.gl.TEXTURE0 + this.texture_units.length;
        this.texture_units.push(ret);
        this.gl.activeTexture(ret);
        return ret;
    }
    textureUnitIndex(index) {
        return index - this.gl.TEXTURE0;
    }
    createTexture(channels=4, type="FLOAT", width=1, height=1, filter=false, data=null) {
        const texture_id = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, texture_id);
        if (!filter) {
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
        }
        this.setTexturePixels(texture_id, channels, type, width, height, data);
        return texture_id;
    }
    coerceToDataTextureData(channels, type, data) {
        if (!this.channels_map[channels] || !this.type_map[type])
            throw "Invalid texture channels or type passed";
        if (!data)
            data = [];
        const square_size = Math.max(1, Math.ceil(Math.sqrt(data.length / channels)));
        const square_data = this.type_map[type].array_type.from(Object.assign(new Array(channels * square_size * square_size).fill(0), data));
        return [square_size, square_data];
    }
    createDataTexture(channels, type, data=null) {
        const [square_size, square_data] = this.coerceToDataTextureData(channels, type, data);
        return this.createTexture(channels, type, square_size, square_size, false, square_data);
    }
    setTexturePixels(texture_id, channels, type, width, height, data=null) {
        const channel_str = this.channels_map[channels],
            type_data = this.type_map[type];
        if (!channel_str || !type_data)
            throw "Invalid texture channels or type passed";
        
        if (data && !(data instanceof type_data.array_type))
            data = type_data.array_type.from(data);
        
        this.gl.bindTexture(this.gl.TEXTURE_2D, texture_id);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl[channel_str + type_data.internal_format], width, height, 0,
            this.gl[channel_str + type_data.format], this.gl[type_data.type], data);
    }
    setDataTexturePixels(texture_id, channels, type, data=null) {
        const [square_size, square_data] = this.coerceToDataTextureData(channels, type, data);
        this.setTexturePixels(texture_id, channels, type, square_size, square_size, square_data);
    }
    getShaderSourceDeclarations() {
        return `
            highp float randf(inout vec2 seed);
            vec2 rand2f(inout vec2 seed);
            vec2 randomCirclePoint(inout vec2 seed);
            ivec2  computeGenericIndex(in int index, in ivec2 size);
            ivec2  computeGenericIndex(in int index, in        sampler2D texture);
            ivec2 icomputeGenericIndex(in int index, in highp isampler2D texture);
            vec4   texelFetchByIndex(  in int index, in        sampler2D texture);
            ivec4 itexelFetchByIndex(  in int index, in highp isampler2D texture);`;
    }
    getShaderSource() {
        return `
            // Random functions
            highp float randf(inout vec2 seed) {
                const highp float a = 12.9898;
                const highp float b = 78.233;
                const highp float c = 43758.5453;
                
                highp float dt= dot(seed.xy ,vec2(a,b));
                highp float sn= mod(dt,3.14);
                
                seed += vec2(1.0);
                
                return fract(sin(sn) * c);
            }
            vec2 rand2f(inout vec2 seed) {
                return vec2(randf(seed), randf(seed));
            }
            vec2 randomCirclePoint(inout vec2 seed) {
                float a = 2.0 * PI * randf(seed), r = sqrt(randf(seed));
                return vec2(r * cos(a), r * sin(a));
            }
        
            // Texel fetch by index functions
            ivec2 computeGenericIndex(in int index, in ivec2 size) {
                return ivec2(index % size.x, index / size.x);
            }
            ivec2 computeGenericIndex(in int index, in sampler2D texture) {
                return computeGenericIndex(index, textureSize(texture, 0));
            }
            ivec2 icomputeGenericIndex(in int index, in highp isampler2D texture) {
                return computeGenericIndex(index, textureSize(texture, 0));
            }
            vec4 texelFetchByIndex(in int index, in sampler2D texture) {
                return texelFetch(texture, computeGenericIndex(index, texture), 0);
            }
            ivec4 itexelFetchByIndex(in int index, in highp isampler2D texture) {
                return texelFetch(texture, icomputeGenericIndex(index, texture), 0);
            }`;
    }
    writeShaderData() {}
    
    // Create/compile vertex and fragment shaders with the specified sources
    static compileShaderProgramFromSources(gl, vsSource, fsSource) {
        const vertexShader   = WebGLHelper.compileShaderOfTypeFromSource(gl, gl.VERTEX_SHADER,   vsSource);
        const fragmentShader = WebGLHelper.compileShaderOfTypeFromSource(gl, gl.FRAGMENT_SHADER, fsSource);

        // Create the shader program
        const shaderProgram = gl.createProgram();
        gl.attachShader(shaderProgram, vertexShader);
        gl.attachShader(shaderProgram, fragmentShader);
        gl.linkProgram( shaderProgram);

        // If creating the shader program failed, throw an error
        if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS))
            throw 'Unable to initialize the shader program: ' + gl.getProgramInfoLog(shaderProgram);
        
        return shaderProgram;
    }
    
    // Utility function to compile a shader of the given type from given source code
    static compileShaderOfTypeFromSource(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
            throw 'An error occurred compiling the shader: ' + gl.getShaderInfoLog(shader);

        return shader;
    }
}