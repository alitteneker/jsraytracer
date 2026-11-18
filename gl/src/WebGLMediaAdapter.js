// Uploads the world's volumes (participating media, src/media.js) for gl/shaders/media.glsl: a handful of uniforms
// per volume, and each voxel grid as two 3D textures: its brick atlas (bytes, R8, filtered trilinearly by the GPU as
// VoxelGrid.codeAt does on the CPU), and its index, one texel per cell (RGBA8UI: the brick's place in the atlas, and
// the cell's majorant). A volume glowing from a temperature grid adds that grid, its table of colors as a row of one
// float texture, and its light sampling distribution (GridMedium.emissionSampler) to another. Only path tracing uses them (see WebGLRendererAdapter.pathTracing).
class WebGLMediaAdapter {
    static MAX_VOLUMES = 8;
    static MAX_GRIDS = 4;     // each grid takes two texture units (its atlas and its index)
    static MAX_STEPS = 4096;  // see media.glsl
    static MAX_CELLS = 512;

    constructor(webgl_helper, worldadapter = null) {
        this.webgl_helper = webgl_helper;
        this.worldadapter = worldadapter;
        this.grid_textures = new Map();   // VoxelGrid -> { texture, unit, index, indexUnit }, kept across visits
        this.free_units = [];
        this.table_texture = null;
        this.table_unit = null;
        this.sampling_texture = null;
        this.sampling_unit = null;
        this.reset();
    }
    reset() {
        this.volumes = [];
        this.grids = [];
        this.tables = [];   // emission tables (Float32Array, RGB per byte), one per volume glowing from a grid
    }
    destroy(gl) {
        if (this.table_texture)
            gl.deleteTexture(this.table_texture);
        if (this.sampling_texture)
            gl.deleteTexture(this.sampling_texture);
        this.table_texture = this.sampling_texture = null;
        for (const g of this.grid_textures.values()) {
            gl.deleteTexture(g.texture);
            gl.deleteTexture(g.index);
        }
        this.grid_textures.clear();
    }
    // `instance` is an ObjectInstance of a Volume (World.volumes): the volume and the ancestors it's nested in.
    visit(instance) {
        if (this.volumes.length >= WebGLMediaAdapter.MAX_VOLUMES)
            throw `Too many volumes: at most ${WebGLMediaAdapter.MAX_VOLUMES} are supported`;
        const medium = instance.object.medium;
        const gridIndex = g => {
            let i = this.grids.indexOf(g);
            if (i < 0) {
                if (this.grids.length >= WebGLMediaAdapter.MAX_GRIDS)
                    throw `Too many voxel grids: at most ${WebGLMediaAdapter.MAX_GRIDS} are supported`;
                i = this.grids.push(g) - 1;
            }
            return i;
        };
        const grid = medium instanceof GridMedium ? gridIndex(medium.grid) : -1;
        // Emission: 0 none, 1 a constant color, 2 from a temperature grid (its index and its table's row).
        let emission = [0, 0, 0, 0];
        if (medium.emissive)
            emission = medium instanceof GridMedium ? [2, gridIndex(medium.temperature), this.tables.push(medium.emissionTable) - 1, 0] : [1, 0, 0, 0];
        this.volumes.push({ instance: instance, medium: medium, grid: grid, emission: emission });
    }
    getShaderSourceDeclarations() {
        return ShaderLibrary.render("media.glsl", "declarations", { count: this.volumes.length, gridCount: this.grids.length, tableCount: this.tables.length });
    }
    getShaderSource() {
        return ShaderLibrary.render("media.glsl", "source", {
            maxSteps: WebGLMediaAdapter.MAX_STEPS,
            maxCells: WebGLMediaAdapter.MAX_CELLS,
            gridCases: this.grids.map((_, i) => ShaderLibrary.render("media.glsl", "grid-case", { i: i })).join(""),
            majorantCases: this.grids.map((_, i) => ShaderLibrary.render("media.glsl", "majorant-case", { i: i })).join("")
        });
    }
    writeShaderData(gl, program) {
        // Grids no longer used give back their textures and units; new ones are uploaded once.
        for (const [grid, g] of this.grid_textures)
            if (!this.grids.includes(grid)) {
                gl.deleteTexture(g.texture);
                gl.deleteTexture(g.index);
                this.free_units.push(g.unit, g.indexUnit);
                this.grid_textures.delete(grid);
            }
        const upload = (dims, data, filter, internal = gl.R8, format = gl.RED) => {
            const unit = this.free_units.pop() || this.webgl_helper.allocateTextureUnit(), texture = gl.createTexture();
            gl.activeTexture(unit);
            gl.bindTexture(gl.TEXTURE_3D, texture);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texImage3D(gl.TEXTURE_3D, 0, internal, dims[0], dims[1], dims[2], 0, format, gl.UNSIGNED_BYTE, data);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
            for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R])
                gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE);
            return [texture, unit];
        };
        for (const grid of this.grids) {
            if (this.grid_textures.has(grid))
                continue;
            const limit = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
            if (Math.max(...grid.atlasBricks) > 255)   // the index holds a brick's place in bytes
                throw `The voxel grid ${grid.source} has too many bricks (${grid.brickCount}) for its index`;
            if (Math.max(...grid.atlasDims, ...grid.cellDims) > limit)
                throw `The voxel grid ${grid.source} needs a ${grid.atlasDims.join(" x ")} 3D texture, but this GPU allows at most ${limit} on a side`;
            const [texture, unit] = upload(grid.atlasDims, grid.atlas, gl.LINEAR);
            const [index, indexUnit] = upload(grid.cellDims, WebGLMediaAdapter.indexTexels(grid), gl.NEAREST, gl.RGBA8UI, gl.RGBA_INTEGER);
            this.grid_textures.set(grid, { texture: texture, unit: unit, index: index, indexUnit: indexUnit });
        }
        // The emission tables: rewritten every time (a few kilobytes), as a 256 x tables RGBA32F texture.
        if (this.tables.length) {
            if (!this.table_texture) {
                this.table_texture = gl.createTexture();
                this.table_unit = this.free_units.pop() || this.webgl_helper.allocateTextureUnit();
            }
            const n = GridMedium.EMISSION_TABLE, texels = new Float32Array(n * 4 * this.tables.length);
            this.tables.forEach((table, row) => {
                for (let k = 0; k < n; ++k)
                    texels.set([table[k * 3], table[k * 3 + 1], table[k * 3 + 2], 1], (row * n + k) * 4);
            });
            gl.activeTexture(this.table_unit);
            gl.bindTexture(gl.TEXTURE_2D, this.table_texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, this.tables.length, 0, gl.RGBA, gl.FLOAT, texels);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.uniform1i(gl.getUniformLocation(program, "uMediaEmissionTable"), WebGLHelper.textureUnitIndex(this.table_unit));
        }
        // Light sampling for glowing grids: per volume, its cells' CDF (normalized, with each entry's cell) and then
        // every cell's probability, as texels of an RGBA32F texture 2048 wide (media.glsl, mediaEmitTexel).
        const emitInfo = [];
        if (this.tables.length) {
            const parts = [];
            let used = 0;
            for (const v of this.volumes) {
                const m = v.medium, detInv = Integrator.detInv(v.instance);
                if (v.emission[0] != 2) {
                    emitInfo.push(0, 0, 0, v.emission[0] == 1 ? detInv / (m.shape == "sphere" ? 4 / 3 * Math.PI : 8) : 0);
                    continue;
                }
                const S = m.emissionSampler, n = S.cells.length, total = n ? S.cdf[n - 1] : 1;
                emitInfo.push(used, n, used + n, detInv / S.cellVolume);
                const part = new Float32Array((n + S.pmf.length) * 4);
                for (let k = 0; k < n; ++k) {
                    part[k * 4] = S.cdf[k] / total;
                    part[k * 4 + 1] = S.cells[k];
                }
                S.pmf.forEach((p, c) => part[(n + c) * 4] = p);
                parts.push(part);
                used += n + S.pmf.length;
            }
            const width = 2048, rows = Math.max(1, Math.ceil(used / width)), texels = new Float32Array(width * rows * 4);
            let at = 0;
            for (const part of parts) {
                texels.set(part, at);
                at += part.length;
            }
            if (!this.sampling_texture) {
                this.sampling_texture = gl.createTexture();
                this.sampling_unit = this.free_units.pop() || this.webgl_helper.allocateTextureUnit();
            }
            gl.activeTexture(this.sampling_unit);
            gl.bindTexture(gl.TEXTURE_2D, this.sampling_texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, rows, 0, gl.RGBA, gl.FLOAT, texels);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.uniform1i(gl.getUniformLocation(program, "uMediaEmitSampling"), WebGLHelper.textureUnitIndex(this.sampling_unit));
        }
        else
            for (const v of this.volumes)
                emitInfo.push(0, 0, 0, v.emission[0] == 1 ? Integrator.detInv(v.instance) / (v.medium.shape == "sphere" ? 4 / 3 * Math.PI : 8) : 0);
        if (!this.volumes.length)
            return;

        const inv = [], params = [], albedo = [], bmin = [], bmax = [], gridMax = [], gridOrigin = [], cellSize = [];
        const emission = [], emissionColor = [], fwd = [];
        for (const v of this.volumes) {
            const m = v.medium, kind = v.grid >= 0 ? 2 : (m.shape == "sphere" ? 1 : 0);
            const M = v.instance.getInvTransform(), F = v.instance.getTransform();
            for (let r = 0; r < 4; ++r)
                for (let c = 0; c < 4; ++c) {
                    inv.push(M[r][c]);
                    fwd.push(F[r][c]);
                }
            params.push(m.density, m.majorant, m.g, kind);
            albedo.push(m.albedo[0], m.albedo[1], m.albedo[2], Math.max(v.grid, 0));
            bmin.push(...m.bounds.min.slice(0, 3));
            bmax.push(...m.bounds.max.slice(0, 3));
            gridMax.push(v.grid >= 0 ? m.grid.max : 0);
            gridOrigin.push(...(v.grid >= 0 ? m.grid.origin : [0, 0, 0]));
            cellSize.push(...(v.grid >= 0 ? m.grid.voxelSize.map(s => s * VoxelGrid.MAJORANT_CELL) : [1, 1, 1]));
            emission.push(...v.emission);
            emissionColor.push(...(v.emission[0] == 1 ? m.emission.slice(0, 3) : [0, 0, 0]));
        }
        gl.uniform4fv(gl.getUniformLocation(program, "uMediaEmission"), emission);
        gl.uniform3fv(gl.getUniformLocation(program, "uMediaEmissionColor"), emissionColor);
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uMediaInvTransforms"), true, inv);
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "uMediaTransforms"), true, fwd);
        gl.uniform4fv(gl.getUniformLocation(program, "uMediaEmitInfo"), emitInfo);
        gl.uniform4fv(gl.getUniformLocation(program, "uMediaParams"), params);
        gl.uniform4fv(gl.getUniformLocation(program, "uMediaAlbedo"), albedo);
        gl.uniform3fv(gl.getUniformLocation(program, "uMediaBoundsMin"), bmin);
        gl.uniform3fv(gl.getUniformLocation(program, "uMediaBoundsMax"), bmax);
        gl.uniform1fv(gl.getUniformLocation(program, "uMediaGridMax"), gridMax);
        gl.uniform3fv(gl.getUniformLocation(program, "uMediaGridOrigin"), gridOrigin);
        gl.uniform3fv(gl.getUniformLocation(program, "uMediaCellSize"), cellSize);
        if (this.grids.length) {
            gl.uniform1iv(gl.getUniformLocation(program, "uMediaGrids"),
                this.grids.map(g => WebGLHelper.textureUnitIndex(this.grid_textures.get(g).unit)));
            gl.uniform1iv(gl.getUniformLocation(program, "uMediaIndex"),
                this.grids.map(g => WebGLHelper.textureUnitIndex(this.grid_textures.get(g).indexUnit)));
        }
    }
    // The index texture's texels, one per cell: the brick's place in the atlas (in bricks), and the cell's largest byte
    // (0 for a cell without a brick).
    static indexTexels(grid) {
        const cells = grid.cellBrick.length, texels = new Uint8Array(cells * 4);
        for (let i = 0; i < cells; ++i) {
            const b = grid.cellBrick[i];
            if (b < 0)
                continue;
            const o = grid.brickOrigin(b);
            texels.set([o[0] / VoxelGrid.BRICK, o[1] / VoxelGrid.BRICK, o[2] / VoxelGrid.BRICK, grid.cellMax[i]], i * 4);
        }
        return texels;
    }
}
