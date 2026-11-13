class WebGLLightsAdapter {
    static LIGHT_TYPE_WORLD = 1;
    static LIGHT_TYPE_DIRECTIONAL = 2;
    static LIGHT_TYPE_AREA = 3;
    
    constructor(webgl_helper, worldadapter=null) {
        this.worldadapter = worldadapter;
        this.reset();
    }
    destroy() {}
    reset() {
        this.lights_data = [];
    }
    // `instance` is a LightInstance (see src/lights.js): the light plus the ancestors it's nested in, so the light is
    // sampled with its world transform even when it sits inside a transformed aggregate.
    visit(instance, geometry_adapter, material_adapter, webgl_helper) {
        const light = instance.light;
        const light_data = { index: this.lights_data.length, ID: this.lights_data.length, worldtype: "light", light: light, instance: instance };
        
        if (light instanceof SimplePointLight) {
            light_data.type          = WebGLLightsAdapter.LIGHT_TYPE_WORLD;
            light_data.geometry      = geometry_adapter.visit(new OriginPoint(), webgl_helper, false, true);
            light_data.color_mc      = material_adapter.visitMaterialColor(light.color_mc, webgl_helper);
            material_adapter.bindToScene(light_data.color_mc, v => light.color_mc = MaterialColor.coerce(v));
        }
        else if (light instanceof RandomSampleAreaLight) {
            light_data.type          = WebGLLightsAdapter.LIGHT_TYPE_AREA;
            light_data.geometry      = geometry_adapter.visit(light.surface_geometry, webgl_helper, false, true);
            light_data.color_mc      = material_adapter.visitMaterialColor(light.color_mc, webgl_helper);
            material_adapter.bindToScene(light_data.color_mc, v => light.color_mc = MaterialColor.coerce(v));
        }
        else {
            throw "Unsupported light type";
        }
        WebGLLightsAdapter.updateLightDataTransforms(light_data);
        
        this.lights_data.push(light_data);
    }
    // World-space transforms used for sampling (a point light only needs its position), and an area light's
    // world-space area, which sets its radiance and the density of its samples.
    static updateLightDataTransforms(light_data) {
        const T = light_data.instance.getTransform();
        light_data.area = light_data.light instanceof RandomSampleAreaLight ? light_data.light.surfaceArea(T) : 0;
        if (light_data.light instanceof SimplePointLight) {
            const p = T.column(3);
            light_data.transform     = Mat4.translation(p);
            light_data.inv_transform = Mat4.translation([-p[0], -p[1], -p[2]]);
        }
        else {
            light_data.transform     = T;
            light_data.inv_transform = light_data.instance.getInvTransform();
        }
    }
    getLights() {
        return this.lights_data;
    }
    getLight(index) {
        return this.lights_data[index];
    }
    setTransform(index, new_transform, new_inv_transform, renderer_adapter) {
        const light = this.lights_data[index];
        
        
        // new_transform is a world transform; the instance converts it into the light's own (possibly nested) one.
        light.instance.setWorldTransform(new_transform, new_inv_transform);
        // Any other instances of the same light (it may be referenced from several aggregates) move too.
        for (const l of this.lights_data)
            if (l.light === light.light)
                WebGLLightsAdapter.updateLightDataTransforms(l);

        // Move the light's visible surface (its stand-in primitive in the world adapter) along with it.
        if (this.worldadapter)
            this.worldadapter.lightTransformChanged(light.light);
        
        renderer_adapter.useTracerProgram();
        renderer_adapter.gl.uniformMatrix4fv(renderer_adapter.getUniformLocation("uLightTransforms"), true, Mat.mats_flat(this.lights_data.map(l => [l.transform, l.inv_transform]).flat()));
        renderer_adapter.gl.uniform1fv(renderer_adapter.getUniformLocation("uLightAreas"), this.lights_data.map(l => l.area));
        renderer_adapter.resetDrawCount();
    }
    writeShaderData(gl, program) {
        gl.uniform1i(gl.getUniformLocation(program, "uNumLights"), this.lights_data.length);
        if (this.lights_data.length > 0) {
            gl.uniform1iv(      gl.getUniformLocation(program, "uLightTypes"),            this.lights_data.map(l => l.type));
            gl.uniform1iv(      gl.getUniformLocation(program, "uLightGeometries"),       this.lights_data.map(l => l.geometry));
            gl.uniform1iv(      gl.getUniformLocation(program, "uLightColorMCs"),         this.lights_data.map(l => l.color_mc._id));
            gl.uniformMatrix4fv(gl.getUniformLocation(program, "uLightTransforms"), true, Mat.mats_flat(this.lights_data.map(l => [l.transform, l.inv_transform]).flat()));
            gl.uniform1fv(      gl.getUniformLocation(program, "uLightAreas"),            this.lights_data.map(l => l.area));
        }
    }
    getShaderSourceDeclarations(sceneEditable) {
        return `
            uniform int uNumLights;
            struct LightStruct {
                int type;
                int geometry_id;
                int color_mc;
                mat4 transform;
                mat4 inv_transform;
            };
            // direction: toward the sampled point (unnormalized; it's also the shadow ray). color: the radiance
            // arriving along it divided by pdf. pdf: the density of choosing that direction, per unit solid angle, or 0
            // for a point light, which has exactly one.
            struct LightSample {
                vec4 direction;
                vec3 color;
                float pdf;
            };
            LightSample sampleLight(in int lightID, in vec4 position, inout vec2 random_seed);`;
    }
    getShaderSource(sceneEditable) {
        return `
            #define LIGHT_TYPE_WORLD ${WebGLLightsAdapter.LIGHT_TYPE_WORLD}
            #define LIGHT_TYPE_DIRECTIONAL ${WebGLLightsAdapter.LIGHT_TYPE_DIRECTIONAL}
            #define LIGHT_TYPE_AREA ${WebGLLightsAdapter.LIGHT_TYPE_AREA}
        
            #define MAX_LIGHTS ${sceneEditable ? WebGLWorldAdapter.editableCapacity(this.lights_data.length, 8) : Math.max(3, this.lights_data.length)}
            uniform int  uLightTypes[MAX_LIGHTS];
            uniform int  uLightGeometries[MAX_LIGHTS];
            uniform int  uLightColorMCs[MAX_LIGHTS];
            uniform mat4 uLightTransforms[MAX_LIGHTS * 2];
            uniform float uLightAreas[MAX_LIGHTS];

            // A light's color is its power. A point light spreads it over the whole sphere, so the irradiance at
            // distance d is color / (4 pi d^2). An area light emits from both sides of its surface as a Lambertian
            // emitter, radiance Le = color / (2 pi A); a point picked uniformly on it (density 1 / A) brings
            // Le A |cos_light| / d^2 = color |cos_light| / (2 pi d^2). See src/lights.js.
            float lightFalloff(in vec4 delta, in int type) {
                float norm_squared = dot(delta, delta);
                if (norm_squared < EPSILON)
                    return 0.0;
                return 1.0 / ((type == LIGHT_TYPE_AREA ? 2.0 : 4.0) * PI * norm_squared);
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
                
                if (light.type == LIGHT_TYPE_DIRECTIONAL)
                    world_pos += surface_position;
                
                vec4 delta = world_pos - surface_position;
                GeometricMaterialData material_data = getSampleGeometricMaterialData(light.geometry_id, local_pos, light.inv_transform * delta);
                float cosLight = abs(dot(normalize(delta.xyz), normalize((transpose(light.inv_transform) * material_data.normal).xyz)));
                // Uniform area sampling, converted to solid angle: pdf = d^2 / (A |cos_light|).
                float pdf = 0.0;
                if (light.type == LIGHT_TYPE_AREA)
                    pdf = cosLight > 0.0 ? dot(delta.xyz, delta.xyz) / (uLightAreas[lightID] * cosLight) : 1e30;
                return LightSample(delta,
                    getMaterialColor(light.color_mc, material_data.UV) * lightFalloff(delta, light.type) * cosLight,
                    pdf);
            }`;
    }
}