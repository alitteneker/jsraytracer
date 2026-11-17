// Uploads the world's volumes (participating media, src/media.js) for gl/shaders/media.glsl: a handful of uniforms
// per volume, and each voxel grid as a 3D texture of bytes (R8), filtered trilinearly by the GPU as VoxelGrid.codeAt
// does on the CPU. Only path tracing uses them (see WebGLRendererAdapter.pathTracing).
class WebGLMediaAdapter {
    static MAX_VOLUMES = 8;
    static MAX_GRIDS = 4;     // each grid takes a texture unit
    static MAX_STEPS = 4096;  // see media.glsl

    constructor(webgl_helper, worldadapter = null) {
        this.webgl_helper = webgl_helper;
        this.worldadapter = worldadapter;
        this.grid_textures = new Map();   // VoxelGrid -> { texture, unit }, kept across visits
        this.free_units = [];
        this.reset();
    }
    reset() {
        this.volumes = [];
        this.grids = [];
    }
    destroy(gl) {
        for (const g of this.grid_textures.values())
            gl.deleteTexture(g.texture);
        this.grid_textures.clear();
    }
    // `instance` is an ObjectInstance of a Volume (World.volumes): the volume and the ancestors it's nested in.
    visit(instance) {
        if (this.volumes.length >= WebGLMediaAdapter.MAX_VOLUMES)
            throw `Too many volumes: at most ${WebGLMediaAdapter.MAX_VOLUMES} are supported`;
        const medium = instance.object.medium;
        let grid = -1;
        if (medium instanceof GridMedium) {
            grid = this.grids.indexOf(medium.grid);
            if (grid < 0) {
                if (this.grids.length >= WebGLMediaAdapter.MAX_GRIDS)
                    throw `Too many voxel grids: at most ${WebGLMediaAdapter.MAX_GRIDS} are supported`;
                grid = this.grids.push(medium.grid) - 1;
            }
        }
        this.volumes.push({ instance: instance, medium: medium, grid: grid });
    }
    getShaderSourceDeclarations() {
        return ShaderLibrary.render("media.glsl", "declarations", { count: this.volumes.length, gridCount: this.grids.length });
    }
    getShaderSource() {
        return ShaderLibrary.render("media.glsl", "source", {
            maxSteps: WebGLMediaAdapter.MAX_STEPS,
            gridCases: this.grids.map((_, i) => ShaderLibrary.render("media.glsl", "grid-case", { i: i })).join("")
        });
    }
    writeShaderData(gl, program) {
        // Grids no longer used give back their textures and units; new ones are uploaded once.
        for (const [grid, g] of this.grid_textures)
            if (!this.grids.includes(grid)) {
                gl.deleteTexture(g.texture);
                this.free_units.push(g.unit);
                this.grid_textures.delete(grid);
            }
        for (const grid of this.grids) {
            if (this.grid_textures.has(grid))
                continue;
            const unit = this.free_units.pop() || this.webgl_helper.allocateTextureUnit(), texture = gl.createTexture();
            gl.activeTexture(unit);
            gl.bindTexture(gl.TEXTURE_3D, texture);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, grid.dims[0], grid.dims[1], grid.dims[2], 0, gl.RED, gl.UNSIGNED_BYTE, grid.codes);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R])
                gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE);
            this.grid_textures.set(grid, { texture: texture, unit: unit });
        }
        if (!this.volumes.length)
            return;

        const inv = [], params = [], albedo = [], bmin = [], bmax = [], gridMax = [];
        for (const v of this.volumes) {
            const m = v.medium, kind = v.grid >= 0 ? 2 : (m.shape == "sphere" ? 1 : 0);
            const M = v.instance.getInvTransform();
            for (let r = 0; r < 4; ++r)
                for (let c = 0; c < 4; ++c)
                    inv.push(M[r][c]);
            params.push(m.density, m.majorant, m.g, kind);
            albedo.push(m.albedo[0], m.albedo[1], m.albedo[2], Math.max(v.grid, 0));
            bmin.push(...m.bounds.min.slice(0, 3));
            bmax.push(...m.bounds.max.slice(0, 3));
            gridMax.push(v.grid >= 0 ? m.grid.max : 0);
        }
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uMediaInvTransforms"), true, inv);
        gl.uniform4fv(gl.getUniformLocation(program, "uMediaParams"), params);
        gl.uniform4fv(gl.getUniformLocation(program, "uMediaAlbedo"), albedo);
        gl.uniform3fv(gl.getUniformLocation(program, "uMediaBoundsMin"), bmin);
        gl.uniform3fv(gl.getUniformLocation(program, "uMediaBoundsMax"), bmax);
        gl.uniform1fv(gl.getUniformLocation(program, "uMediaGridMax"), gridMax);
        if (this.grids.length)
            gl.uniform1iv(gl.getUniformLocation(program, "uMediaGrids"),
                this.grids.map(g => WebGLHelper.textureUnitIndex(this.grid_textures.get(g).unit)));
    }
}
