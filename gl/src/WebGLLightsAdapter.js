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
        else if (light instanceof DirectionalLight) {
            // Placed relative to the point being shaded: sampleLight adds that point (see src/lights.js).
            light_data.type          = WebGLLightsAdapter.LIGHT_TYPE_DIRECTIONAL;
            light_data.geometry      = geometry_adapter.visit(light.surface_geometry, webgl_helper, false, true);
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
    // world-space area, which sets its radiance and the density of its samples (0 for lights that are points).
    static updateLightDataTransforms(light_data) {
        const T = light_data.instance.getTransform(), light = light_data.light;
        light_data.area = (light instanceof RandomSampleAreaLight && !(light instanceof DirectionalLight && light.isPoint))
            ? light.surfaceArea(T) : 0;
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
        return ShaderLibrary.render("lights.glsl", "declarations");
    }
    getShaderSource(sceneEditable) {
        return ShaderLibrary.render("lights.glsl", "source", {
            lightTypeWorld:       WebGLLightsAdapter.LIGHT_TYPE_WORLD,
            lightTypeDirectional: WebGLLightsAdapter.LIGHT_TYPE_DIRECTIONAL,
            lightTypeArea:        WebGLLightsAdapter.LIGHT_TYPE_AREA,
            maxLights: sceneEditable ? WebGLWorldAdapter.editableCapacity(this.lights_data.length, 8) : Math.max(3, this.lights_data.length)
        });
    }
}