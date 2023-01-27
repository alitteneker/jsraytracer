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


class WebGLRandomHelper {
    constructor() {
    }
    writeShaderData(gl, program) {
    }
    getShaderSourceDeclarations() {
        return `
                highp float randf(inout vec2 seed);
                vec2 rand2f(inout vec2 seed);
                vec2 randomCirclePoint(inout vec2 seed);`;
    }
    getShaderSource() {
        return `
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
        }`;
    }
}