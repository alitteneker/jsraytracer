// Uploads the world's volumes (participating media, src/media.js) for gl/shaders/media.glsl: a handful of uniforms
// per volume, and the voxel grids as two 3D textures they all share: one brick atlas (bytes, R8, filtered trilinearly
// by the GPU as VoxelGrid.codeAt does on the CPU) holding every grid's bricks, and one index (RGBA8UI: per cell, its
// brick's place in the atlas, and its majorant) holding every grid's cells side by side. A volume glowing from a temperature grid adds that grid, its table of colors as a row of one
// float texture, and its light sampling distribution (GridMedium.emissionSampler) to another. Only path tracing uses them (see WebGLRendererAdapter.pathTracing).
class WebGLMediaAdapter {
    static MAX_VOLUMES = 8;
    static MAX_GRIDS = 8;
    static MAX_STEPS = 4096;  // see media.glsl
    static MAX_CELLS = 512;

    constructor(webgl_helper, worldadapter = null) {
        this.webgl_helper = webgl_helper;
        this.worldadapter = worldadapter;
        this.shared = null;   // the grids' shared textures: { grids, atlas, index, offsets }, kept while the grids are the same
        this.atlas_unit = this.index_unit = null;
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
        if (this.shared) {
            gl.deleteTexture(this.shared.atlas);
            gl.deleteTexture(this.shared.index);
        }
        this.shared = null;
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
    // Re-sends every volume's uniforms (after the editor moves a volume or changes its medium) and starts the image
    // over. The grids' textures stay as they are.
    refresh(renderer_adapter) {
        renderer_adapter.useTracerProgram();
        this.writeShaderData(renderer_adapter.gl, renderer_adapter.tracerShaderProgram);
        renderer_adapter.resetDrawCount();
    }
    getShaderSourceDeclarations() {
        return ShaderLibrary.render("media.glsl", "declarations", { count: this.volumes.length, gridCount: this.grids.length, tableCount: this.tables.length });
    }
    getShaderSource() {
        return ShaderLibrary.render("media.glsl", "source", {
            maxSteps: WebGLMediaAdapter.MAX_STEPS,
            maxCells: WebGLMediaAdapter.MAX_CELLS,
        });
    }
    writeShaderData(gl, program) {
        // The grids' shared textures, rebuilt only when the set of grids changes.
        if (this.grids.length && !(this.shared && this.shared.grids.length == this.grids.length
                                   && this.shared.grids.every((g, i) => g === this.grids[i])))
            this.uploadGrids(gl);
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
            gl.uniform1i(gl.getUniformLocation(program, "uMediaAtlas"), WebGLHelper.textureUnitIndex(this.atlas_unit));
            gl.uniform1i(gl.getUniformLocation(program, "uMediaIndex"), WebGLHelper.textureUnitIndex(this.index_unit));
            gl.uniform3iv(gl.getUniformLocation(program, "uMediaGridIndexOffset"), this.shared.offsets.flatMap(x => [x, 0, 0]));
            gl.uniform3iv(gl.getUniformLocation(program, "uMediaGridCells"), this.grids.flatMap(g => g.cellDims));
        }
    }
    // Packs every grid's bricks into one atlas (a single grid's own atlas as it is) and every grid's index into one,
    // side by side along x, and uploads both.
    uploadGrids(gl) {
        const grids = this.grids.slice(), B = VoxelGrid.BRICK, limit = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
        let atlas, atlasBricks, atlasDims;
        const base = [];
        if (grids.length == 1) {
            ({ atlas, atlasBricks, atlasDims } = grids[0]);
            base.push(0);
        }
        else {
            const total = grids.reduce((sum, g) => sum + g.brickCount, 0), n = Math.max(1, Math.ceil(Math.cbrt(total)));
            atlasBricks = [n, n, Math.max(1, Math.ceil(total / (n * n)))];
            atlasDims = atlasBricks.map(k => k * B);
            atlas = new Uint8Array(atlasDims[0] * atlasDims[1] * atlasDims[2]);
            let next = 0;
            for (const g of grids) {
                base.push(next);
                const [gx, gy] = g.atlasDims;
                for (let b = 0; b < g.brickCount; ++b, ++next) {
                    const from = g.brickOrigin(b), to = [(next % n) * B, (Math.floor(next / n) % n) * B, Math.floor(next / (n * n)) * B];
                    for (let k = 0; k < B; ++k) for (let j = 0; j < B; ++j) {
                        const src = ((from[2] + k) * gy + from[1] + j) * gx + from[0];
                        atlas.set(g.atlas.subarray(src, src + B), ((to[2] + k) * atlasDims[1] + to[1] + j) * atlasDims[0] + to[0]);
                    }
                }
            }
        }
        if (Math.max(...atlasBricks) > 255)   // the index holds a brick's place in bytes
            throw `The voxel grids have too many bricks (${atlasBricks.join(" x ")}) for their index`;
        const offsets = [];
        let width = 0;
        for (const g of grids) {
            offsets.push(width);
            width += g.cellDims[0];
        }
        const indexDims = [width, Math.max(...grids.map(g => g.cellDims[1])), Math.max(...grids.map(g => g.cellDims[2]))];
        if (Math.max(...atlasDims, ...indexDims) > limit)
            throw `The voxel grids need a ${atlasDims.join(" x ")} 3D texture, but this GPU allows at most ${limit} on a side`;
        const texels = new Uint8Array(indexDims[0] * indexDims[1] * indexDims[2] * 4);
        grids.forEach((g, i) => {
            const [cx, cy, cz] = g.cellDims;
            for (let z = 0, c = 0; z < cz; ++z) for (let y = 0; y < cy; ++y) for (let x = 0; x < cx; ++x, ++c) {
                const b = g.cellBrick[c];
                if (b < 0)
                    continue;
                const at = base[i] + b, n0 = atlasBricks[0], n1 = atlasBricks[1];
                texels.set([at % n0, Math.floor(at / n0) % n1, Math.floor(at / (n0 * n1)), g.cellMax[c]],
                           ((z * indexDims[1] + y) * indexDims[0] + offsets[i] + x) * 4);
            }
        });

        if (this.shared) {
            gl.deleteTexture(this.shared.atlas);
            gl.deleteTexture(this.shared.index);
        }
        if (!this.atlas_unit) {
            this.atlas_unit = this.free_units.pop() || this.webgl_helper.allocateTextureUnit();
            this.index_unit = this.free_units.pop() || this.webgl_helper.allocateTextureUnit();
        }
        const upload = (unit, dims, data, filter, internal, format) => {
            const texture = gl.createTexture();
            gl.activeTexture(unit);
            gl.bindTexture(gl.TEXTURE_3D, texture);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texImage3D(gl.TEXTURE_3D, 0, internal, dims[0], dims[1], dims[2], 0, format, gl.UNSIGNED_BYTE, data);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter);
            for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R])
                gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE);
            return texture;
        };
        this.shared = {
            grids: grids, offsets: offsets,
            atlas: upload(this.atlas_unit, atlasDims, atlas, gl.LINEAR, gl.R8, gl.RED),
            index: upload(this.index_unit, indexDims, texels, gl.NEAREST, gl.RGBA8UI, gl.RGBA_INTEGER)
        };
    }
}
