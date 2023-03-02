class WebGLLightsAdapter {
    static LIGHT_TYPE_WORLD = 1;
    static LIGHT_TYPE_DIRECTIONAL = 1;
    
    constructor(webgl_helper) {
        this.lights_data = [];
    }
    destroy() {}
    visit(light, geometry_adapter, material_adapter, webgl_helper) {
        const light_data = { light: light };
        
        if (light instanceof SimplePointLight) {
            light_data.type          = WebGLLightsAdapter.LIGHT_TYPE_WORLD;
            light_data.geometry      = geometry_adapter.visit(new OriginPoint());
            light_data.color_mc      = material_adapter.visitMaterialColor(light.color_mc, webgl_helper);
            light_data.transform     = Mat4.translation(light.position);
            light_data.inv_transform = Mat4.translation(light.position.times(-1));
        }
        else if (light instanceof RandomSampleAreaLight) {
            light_data.type          = WebGLLightsAdapter.LIGHT_TYPE_WORLD;
            light_data.geometry      = geometry_adapter.visit(light.surface_geometry);
            light_data.color_mc      = material_adapter.visitMaterialColor(light.color_mc, webgl_helper);
            light_data.transform     = light.transform;
            light_data.inv_transform = light.inv_transform;
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
            gl.uniform1iv(      gl.getUniformLocation(program, "uLightGeometries"),       this.lights_data.map(l => l.geometry));
            gl.uniform1iv(      gl.getUniformLocation(program, "uLightColorMCs"),         this.lights_data.map(l => l.color_mc));
            gl.uniformMatrix4fv(gl.getUniformLocation(program, "uLightTransforms"), true, Mat.mats_flat(this.lights_data.map(l => [l.transform, l.inv_transform]).flat()));
        }
    }
    getShaderSourceDeclarations() {
        return `
            uniform int uNumLights;
            struct LightStruct {
                int type;
                int geometry_id;
                int color_mc;
                mat4 transform;
                mat4 inv_transform;
            };
            struct LightSample {
                vec4 direction;
                vec3 color;
            };
            LightSample sampleLight(in int lightID, in vec4 position, inout vec2 random_seed);`;
    }
    getShaderSource() {
        return `
            #define LIGHT_TYPE_WORLD ${WebGLLightsAdapter.LIGHT_TYPE_WORLD}
            #define LIGHT_TYPE_DIRECTIONAL ${WebGLLightsAdapter.LIGHT_TYPE_DIRECTIONAL}
        
            #define MAX_LIGHTS ${Math.max(3, this.lights_data.length)}
            uniform int  uLightTypes[MAX_LIGHTS];
            uniform int  uLightGeometries[MAX_LIGHTS];
            uniform int  uLightColorMCs[MAX_LIGHTS];
            uniform mat4 uLightTransforms[MAX_LIGHTS * 2];
            
            float lightFalloff(in vec4 delta) {
                float norm_squared = dot(delta, delta);
                if (norm_squared < EPSILON)
                    return 0.0;
                return 1.0 / (4.0 * PI * norm_squared);
            }
            LightStruct getLight(in int lightID) {
                return LightStruct(uLightTypes[lightID],
                                   uLightGeometries[lightID],
                                   uLightColorMCs[lightID],
                                   uLightTransforms[lightID * 2],
                                   uLightTransforms[lightID * 2 + 1]);
            }
            LightSample sampleLight(in int lightID, in vec4 surface_position, inout vec2 random_seed) {
                LightStruct light = getLight(lightID);
                
                vec4 local_pos = sampleGeometrySurface(light.geometry_id, random_seed);
                vec4 world_pos = light.transform * local_pos;
                
                vec4 delta = world_pos - surface_position;
                GeometricMaterialData material_data = getGeometricMaterialData(light.geometry_id, local_pos, light.inv_transform * delta);
                return LightSample(delta,
                    getMaterialColor(light.color_mc, material_data.UV) * lightFalloff(delta)
                        * abs(dot(normalize(delta.xyz), normalize((transpose(light.inv_transform) * material_data.normal).xyz)))
                );
            }`;
    }
}