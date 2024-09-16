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
    store(vec) {
        vec = vec.slice(0, this.components);
        if (!this.reuse) {
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
    store(mat) {
        if (!this.reuse) {
            this.data.push(mat);
            return this.data.length - 1;
        }
        const key = mat.toString();
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
        return [texture_unit, texture_id];
    }
    createDataTexture(channels, type, data=null) {
        const [square_size, square_data] = WebGLTexture.coerceToDataTextureData(channels, type, data);
        return this.createTexture(channels, type, square_size, square_size, false, square_data);
    }
    createDataTextureAndUnit(channels, type, data=null) {
        const texture_unit = this.allocateTextureUnit();
        const texture = this.createDataTexture(channels, type, data);
        return [texture_unit, texture];
    }
    
    getShaderSourceDeclarations() {
        return `
            precision highp int;
            precision highp float;
            precision highp isampler2D;
            
            float normSquared(in vec2 v);
            float normSquared(in vec3 v);
            float normSquared(in vec4 v);
            float sum(in vec2 v);
            float sum(in vec3 v);
            float sum(in vec4 v);
            float average(in vec2 v);
            float average(in vec3 v);
            float average(in vec4 v);
            
            vec3 unitAxis3(in int dim);
            vec4 unitAxis4(in int dim);
            
            float randf(inout vec2 seed);
            vec2 rand2f(inout vec2 seed);
            vec2 randomCirclePoint(inout vec2 seed);
            vec3 randomSpherePoint(inout vec2 seed);
            
            float safePow(in float x, in float y);
            
            ivec2  computeGenericIndex(in int index, in ivec2 size);
            ivec2  computeGenericIndex(in int index, in  sampler2D texture);
            ivec2 icomputeGenericIndex(in int index, in isampler2D texture);
            vec4   texelFetchByIndex(  in int index, in  sampler2D texture);
            ivec4 itexelFetchByIndex(  in int index, in isampler2D texture);`;
    }
    getShaderSource() {
        return `
            // Utility Functions
            float normSquared(in vec2 v) { return dot(v, v); }
            float normSquared(in vec3 v) { return dot(v, v); }
            float normSquared(in vec4 v) { return dot(v, v); }
            float sum(in vec2 v)         { return dot(v, vec2(1.0)); }
            float sum(in vec3 v)         { return dot(v, vec3(1.0)); }
            float sum(in vec4 v)         { return dot(v, vec4(1.0)); }
            float average(in vec2 v)     { return sum(v) / 2.0; }
            float average(in vec3 v)     { return sum(v) / 3.0; }
            float average(in vec4 v)     { return sum(v) / 4.0; }
            
            vec3 unitAxis3(in int dim) {
                vec3 ret = vec3(0.0);
                ret[dim] = 1.0;
                return ret;
            }
            vec4 unitAxis4(in int dim) {
                vec4 ret = vec4(0.0);
                ret[dim] = 1.0;
                return ret;
            }
        
        
            // Random functions
            
            // A single iteration of Bob Jenkins' One-At-A-Time hashing algorithm.
            uint hash_uint( uint x ) {
                x += ( x << 10u );
                x ^= ( x >>  6u );
                x += ( x <<  3u );
                x ^= ( x >> 11u );
                x += ( x << 15u );
                return x;
            }
            uint hash_uint( uvec2 v ) {
                return hash_uint( v.x ^ hash_uint(v.y));
            }

            // Construct a float with half-open range [0:1] using low 23 bits.
            // All zeroes yields 0.0, all ones yields the next smallest representable value below 1.0.
            float floatConstruct( uint m ) {
                const uint ieeeMantissa = 0x007FFFFFu; // binary32 mantissa bitmask
                const uint ieeeOne      = 0x3F800000u; // 1.0 in IEEE binary32

                m &= ieeeMantissa;                     // Keep only mantissa bits (fractional part)
                m |= ieeeOne;                          // Add fractional part to 1.0

                float  f = uintBitsToFloat( m );       // Range [1:2]
                return f - 1.0;                        // Range [0:1]
            }

            float random_hash( vec2  v ) {
                return floatConstruct( hash_uint( floatBitsToUint(v) ) );
            }
            
            float random_fractsin(in vec2 seed) {
                const float a = 12.9898;
                const float b = 78.233;
                const float c = 43758.5453;
                
                float dt = dot(seed.xy ,vec2(a,b));
                float sn = mod(dt, PI);
                
                return fract(sin(sn) * c);
            }
            
            float randf(inout vec2 seed) {
                const float random_advance = 65.60358;
                
                float ret = random_hash(seed);
                //float ret = random_fractsin(seed);
                
                seed += vec2(random_advance);
                
                return ret;
            }
            vec2 rand2f(inout vec2 seed) {
                return vec2(randf(seed), randf(seed));
            }
            vec2 randomCirclePoint(inout vec2 seed) {
                float a = 2.0 * PI * randf(seed), r = sqrt(randf(seed));
                return vec2(r * cos(a), r * sin(a));
            }
            vec3 randomSpherePoint(inout vec2 seed) {
                float theta = 2.0 * PI * randf(seed),
                    phi = acos(2.0 * randf(seed) - 1.0);
                float sin_phi = sin(phi);
                return vec3(
                    cos(theta) * sin_phi,
                                 cos(phi),
                    sin(theta) * sin_phi);
            }
            vec3 randomHemispherePoint(in vec3 N, inout vec2 seed) {
                vec3 dir = randomSpherePoint(seed);
                if (dot(dir, N) < 0.0)
                    return -dir;
                return dir;
            }
            vec4 getFurthestAxis(in vec4 R) {
                vec4  best_axis = vec4(1,0,0,0);
                float best_score = 1.0-abs(dot(R, best_axis));
                for (int i = 1; i < 3; ++i) {
                    vec4 axis = unitAxis4(i);
                    float score = 1.0-abs(dot(R, axis));
                    if (score > best_score) {
                        best_score = score;
                        best_axis  = axis;
                    }
                }
                return best_axis;
            }
            mat4 transformToAlignY(in vec4 R) {
                vec4 axis = getFurthestAxis(R);
                
                mat4 space_transform = mat4(1.0);
                space_transform[0] = vec4(normalize(cross(axis.xyz, R.xyz)).xyz, 0);
                space_transform[1] = R;
                space_transform[2] = vec4(normalize(cross(R.xyz, space_transform[0].xyz)).xyz, 0);
                
                return space_transform;
            }
            
            float safePow(in float x, in float y) {
                if (x < 0.0 || (x == 0.0 && y <= 0.0))
                    return 0.0;
                return pow(x, y);
            }
        
            // Texel fetch by index functions
            ivec2 computeGenericIndex(in int index, in ivec2 size) {
                return ivec2(index % size.x, index / size.x);
            }
            ivec2  computeGenericIndex(in int index, in  sampler2D texture) { return computeGenericIndex(index, textureSize(texture, 0)); }
            ivec2 icomputeGenericIndex(in int index, in isampler2D texture) { return computeGenericIndex(index, textureSize(texture, 0)); }
            vec4   texelFetchByIndex(  in int index, in  sampler2D texture) { return texelFetch(texture,  computeGenericIndex(index, texture), 0);
            }
            ivec4 itexelFetchByIndex(  in int index, in isampler2D texture) { return texelFetch(texture, icomputeGenericIndex(index, texture), 0); }`;
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
                    $(".loading").css('visibility', 'hidden');
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
    static coerceToDataTextureData(channels, type, data) {
        if (!WebGLTexture.channels_map[channels] || !WebGLTexture.type_map[type])
            throw "Invalid texture channels or type passed";
        if (!data)
            data = [];
        const square_size = Math.max(1, Math.ceil(Math.sqrt(data.length / channels)));
        const square_data = WebGLTexture.type_map[type].array_type.from(Object.assign(new Array(channels * square_size * square_size).fill(0), data));
        return [square_size, square_data];
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
        
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture_id);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl[channel_str + type_data.internal_format], width, height, 0,
            this.gl[channel_str + type_data.format], this.gl[type_data.type], data);
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
        const [square_size, square_data] = WebGLTexture.coerceToDataTextureData(channels, type, data);
        this.setPixels(square_data, channels, type, square_size, square_size);
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
        
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture_id);
        this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0,
            x, y, 1, 1, this.gl[channel_str + type_data.format], this.gl[type_data.type], new_value);
    }
    modifyDataPixel(index, new_value) {
        this.modifyPixel(index % this.width, Math.floor(index / this.width), new_value);
    }
}