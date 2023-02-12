class WebGLLightsAdapter {
    constructor(webgl_helper) {
        this.lights_data = [];
    }
    destroy() {}
    visit(light) {
        const light_data = {};
        
        if (light instanceof SimplePointLight) {
            light_data.type = 0;
            light_data.color = light.color.times(light.intensity);
            light_data.transform = Mat4.translation(light.position);
        }
        else if (light instanceof RandomSampleAreaLight) {
            light_data.color = light.color.times(light.intensity);
            if (light.area instanceof SquareLightArea) {
                light_data.type = 1;
                light_data.transform = light.area.transform;
            }
            else
                throw "Unsupported light sample area type";
        }
        else {
            throw "Unsupported light type";
        }
        
        this.lights_data.push(light_data);
    }
    writeShaderData(gl, program) {
        gl.uniform1i(gl.getUniformLocation(program, "uNumLights"), this.lights_data.length);
        if (this.lights_data.length > 0) {
            gl.uniform1iv(      gl.getUniformLocation(program, "uLightTypes"),            this.lights_data.map(l => l.type));
            gl.uniform3fv(      gl.getUniformLocation(program, "uLightColors"),           this.lights_data.map(l => Array.from(l.color)).flat());
            gl.uniformMatrix4fv(gl.getUniformLocation(program, "uLightTransforms"), true, Mat.mats_flat(this.lights_data.map(l => l.transform)));
        }
    }
    getShaderSourceDeclarations() {
        return `
            uniform int uNumLights;
            struct LightStruct {
                int type;
                vec3 color;
                mat4 transform;
            };
            struct LightSample {
                vec4 direction;
                vec3 color;
            };
            LightSample sampleLight(in int lightID, in vec4 position, inout vec2 random_seed);`;
    }
    getShaderSource() {
        return `
            #define MAX_LIGHTS ${Math.max(1, this.lights_data.length)}
            uniform int  uLightTypes[MAX_LIGHTS];
            uniform vec3 uLightColors[MAX_LIGHTS];
            uniform mat4 uLightTransforms[MAX_LIGHTS];
            
            float lightFalloff(in vec4 delta) {
                float norm_squared = dot(delta, delta);
                if (norm_squared < EPSILON)
                    return 0.0;
                return 1.0 / (4.0 * PI * norm_squared);
            }
            LightStruct getLight(in int lightID) {
                return LightStruct(uLightTypes[lightID],
                                   uLightColors[lightID],
                                   uLightTransforms[lightID]);
            }
            LightSample sampleLight(in int lightID, in vec4 position, inout vec2 random_seed) {
                LightStruct light = getLight(lightID);
                
                vec4 lightPosition = vec4(0,0,0,1);
                if (light.type == 1)
                    lightPosition = vec4(rand2f(random_seed) - 0.5, 0, 1);
                lightPosition = light.transform * lightPosition;
                
                vec4 delta = lightPosition - position;
                LightSample ret = LightSample(delta, light.color * lightFalloff(delta));
                
                if (light.type == 1)
                    //ret.color *= abs(dot(normalize(ret.direction), normalize(light.transform * vec4(0,0,1,0))));
                    ret.color *= max(dot(normalize(ret.direction), normalize(light.transform * vec4(0,0,1,0))), 0.0);
                
                return ret;
            }`;
    }
}