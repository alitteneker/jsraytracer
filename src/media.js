// Participating media: smoke, clouds, fog and other stuff light travels through rather than bouncing off. A medium
// absorbs and scatters light at every point inside it, in proportion to its density there:
//   density (sigma_t, the extinction coefficient): the chance per unit length that light traveling through it hits
//       something. A ray crossing a stretch of length d at density s keeps exp(-s d) of its light (the transmittance).
//   albedo: the fraction of that which is scattered rather than absorbed (sigma_s / sigma_t), per color channel. 1 is a
//       white cloud that loses no light, 0 is black smoke. (Extinction itself is gray here: colored absorption, as in
//       jade or milk, would need a density per channel.)
//   g: the Henyey-Greenstein phase function's anisotropy, the average cosine of the scattering angle. 0 scatters
//       equally in every direction, values toward 1 mostly forward (clouds are about 0.8), toward -1 mostly back.
//
// A Volume places a medium in the world. Its density is per unit length of the volume's own space, before its
// transform, so scaling a volume scales its look with it, as scaling a model does. Volumes aren't surfaces: rays pass
// into them without stopping or bending, and only the path integrator sees them (PathIntegrator samples where light
// scatters inside, and shadow rays take their transmittance). They may not overlap each other yet.
//
// Two media:
//   HomogeneousMedium: the same density everywhere, inside a box ([-1, 1]^3) or a sphere (radius 1).
//   GridMedium: density from a sparse voxel grid (VoxelGrid, loaded from a file made by tools/vdb_to_grid.py), filling the
//       grid's box. The grid's values are multiplied by the medium's density.
//
// Sampling (shared by the CPU and the GPU, see gl/shaders/media.glsl): where light first interacts along a ray is
// sampled from the transmittance itself. In a homogeneous medium that's exact: distance = -ln(1 - u) / density. In a
// grid, delta tracking samples against the majorant (an upper bound on the density) and accepts each tentative
// collision with probability density / majorant; the rest are "null" collisions that change nothing. Shadow rays
// estimate transmittance by ratio tracking: the same tentative collisions, each multiplying the estimate by
// 1 - density / majorant. Both are unbiased for any majorant at least the true density, and cheaper the tighter it is,
// so grids keep a majorant per cell of 8^3 voxels (VoxelGrid.majorantCodes) and track cell by cell along the ray: thin
// or empty regions are crossed in a few long steps instead of many short ones at the peak density's rate.

class HenyeyGreenstein {
    // The density of scattering into wi, for light that was traveling along d (both unit vectors, cos = d . wi). It
    // integrates to 1 over the sphere, and doubles as the pdf of sample().
    static eval(g, cos) {
        const d = 1 + g * g - 2 * g * cos;
        return (1 - g * g) / (4 * Math.PI * d * Math.sqrt(d));
    }
    // A direction distributed exactly as eval, so the phase function's weight (value / pdf) is 1.
    static sample(g, d, u1 = Math.random(), u2 = Math.random()) {
        let cos;
        if (Math.abs(g) < 1e-3)
            cos = 1 - 2 * u1;
        else {
            const s = (1 - g * g) / (1 - g + 2 * g * u1);
            cos = (1 + g * g - s * s) / (2 * g);
        }
        cos = Math.min(1, Math.max(-1, cos));
        const sin = Math.sqrt(Math.max(0, 1 - cos * cos)), phi = 2 * Math.PI * u2;
        // A frame around d.
        const a = Math.abs(d[0]) > 0.9 ? Vec.of(0, 1, 0, 0) : Vec.of(1, 0, 0, 0);
        const t = a.minus(d.times(a.dot(d))).normalized(), b = Vec.of(d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0], 0);
        const wi = d.times(cos).plus(t.times(sin * Math.cos(phi))).plus(b.times(sin * Math.sin(phi)));
        return { wi: wi, pdf: HenyeyGreenstein.eval(g, cos) };
    }
}

class Medium {
    constructor({ density = 1, albedo = Vec.of(1, 1, 1), g = 0 } = {}) {
        this.density = density;
        this.albedo = Vec.from(Array.isArray(albedo) || albedo instanceof Float32Array ? albedo : [albedo, albedo, albedo]);
        this.g = g;
    }
    get homogeneous() {
        return false;
    }
    // Where the medium is, in the volume's own space: "box" or "sphere", within these bounds.
    get shape() {
        return "box";
    }
    get bounds() {
        return { min: Vec.of(-1, -1, -1), max: Vec.of(1, 1, 1) };
    }
}

class HomogeneousMedium extends Medium {
    constructor({ shape = "box", ...params } = {}) {
        super(params);
        if (shape != "box" && shape != "sphere")
            throw `Unknown medium shape "${shape}": use "box" or "sphere"`;
        this._shape = shape;
    }
    get homogeneous() {
        return true;
    }
    get shape() {
        return this._shape;
    }
    get majorant() {
        return this.density;
    }
    densityAt(p) {
        return this.density;
    }
}

// Density values on a regular lattice of voxels, stored sparsely: the lattice is split into cells of 8^3 voxels (as
// OpenVDB's leaves are), and only cells near something nonzero keep their values. Each such cell gets a brick of 9^3
// bytes in one big array, the atlas: its own 8^3 voxels plus the first voxel of each neighbor above it in x, y and z.
// That one extra layer is all trilinear interpolation needs, since a point in cell c only ever mixes voxels 8c to 8c + 8,
// so the GPU can upload the atlas as one 3D texture and filter within a brick (WebGLMediaAdapter), and the CPU reads the
// same bytes the same way (codeAt). A small index, one entry per cell, says which brick holds a cell, or that it's
// empty; it also keeps each brick's largest byte, which is exactly the majorant for that cell (majorantCodes).
//
// A byte b stands for max * (b / 255)^2, as tools/vdb_to_grid.py writes it, and values are interpolated as bytes before
// decoding (as the GPU's texture filtering does). Voxel k's center is at origin + k * voxelSize, in the grid's own
// space, and the grid's values only count inside bounds (the medium's box, where Volume.interval clips rays).
class VoxelGrid {
    static MAJORANT_CELL = 8;   // voxels per cell along each axis
    static BRICK = 9;           // bytes per brick along each axis: a cell, plus one more voxel above

    // cellLeaf: per cell (x fastest), the index of its leaf in leaves (8^3 bytes each, x fastest), or -1 for all zero.
    constructor({ cellDims, origin, voxelSize, bounds, max }, cellLeaf, leaves, source = "") {
        this.cellDims = cellDims.slice();
        this.dims = cellDims.map(n => n * VoxelGrid.MAJORANT_CELL);
        this.origin = origin.slice();
        this.voxelSize = voxelSize.slice();
        this.bounds = { min: Vec.of(...bounds.min), max: Vec.of(...bounds.max) };
        this.max = max;
        this.source = source;
        this.leafCount = leaves.length / 512;
        this.buildBricks(cellLeaf, leaves);
    }
    buildBricks(cellLeaf, leaves) {
        const [cx, cy, cz] = this.cellDims, B = VoxelGrid.BRICK;
        const leafAt = (x, y, z) => x < cx && y < cy && z < cz ? cellLeaf[(z * cy + y) * cx + x] : -1;
        // What a cell's brick borrows from the neighbor at offset d (bits: x, y, z) is that leaf's voxels at 0 along
        // each axis in d: a face, an edge or a corner. borrows[l * 8 + d] is whether those are nonzero for leaf l.
        const leafCount = leaves.length / 512, borrows = new Uint8Array(leafCount * 8);
        for (let l = 0; l < leafCount; ++l)
            for (let d = 0; d < 8; ++d) {
                const nx = d & 1 ? 1 : 8, ny = d & 2 ? 1 : 8, nz = d & 4 ? 1 : 8;
                let any = 0;
                for (let k = 0; k < nz && !any; ++k) for (let j = 0; j < ny && !any; ++j) for (let h = 0; h < nx; ++h)
                    any |= leaves[l * 512 + (k * 8 + j) * 8 + h];
                borrows[l * 8 + d] = any ? 1 : 0;
            }
        // A cell needs a brick if it has a leaf, or borrows nonzero voxels from a neighbor's.
        const cellBrick = new Int32Array(cx * cy * cz).fill(-1);
        let count = 0;
        for (let z = 0, i = 0; z < cz; ++z) for (let y = 0; y < cy; ++y) for (let x = 0; x < cx; ++x, ++i)
            for (let d = 0; d < 8; ++d) {
                const l = leafAt(x + (d & 1), y + (d >> 1 & 1), z + (d >> 2));
                if (l >= 0 && borrows[l * 8 + d]) {
                    cellBrick[i] = count++;
                    break;
                }
            }
        // The atlas: bricks in a roughly cubic block, so its sides stay well under the GPU's 3D texture limit.
        const n = Math.max(1, Math.ceil(Math.cbrt(count)));
        this.atlasBricks = [n, n, Math.max(1, Math.ceil(count / (n * n)))];
        this.atlasDims = this.atlasBricks.map(k => k * B);
        const [ax, ay] = this.atlasDims, atlas = new Uint8Array(ax * ay * this.atlasDims[2]);
        const cellMax = new Uint8Array(cx * cy * cz);
        for (let z = 0, i = 0; z < cz; ++z) for (let y = 0; y < cy; ++y) for (let x = 0; x < cx; ++x, ++i) {
            const b = cellBrick[i];
            if (b < 0)
                continue;
            const [ox, oy, oz] = this.brickOrigin(b);
            for (let k = 0; k < B; ++k) {
                const zc = z + (k >> 3), zl = k & 7;
                for (let j = 0; j < B; ++j) {
                    const yc = y + (j >> 3), yl = j & 7, row = (zl * 8 + yl) * 8;
                    const dst = ((oz + k) * ay + oy + j) * ax + ox;
                    const l0 = leafAt(x, yc, zc), l1 = leafAt(x + 1, yc, zc);
                    if (l0 >= 0)
                        atlas.set(leaves.subarray(l0 * 512 + row, l0 * 512 + row + 8), dst);
                    if (l1 >= 0)
                        atlas[dst + 8] = leaves[l1 * 512 + row];
                }
            }
            let m = 0;
            for (let k = 0; k < B; ++k) for (let j = 0; j < B; ++j) {
                const row = ((oz + k) * ay + oy + j) * ax + ox;
                for (let x = 0; x < B; ++x)
                    if (atlas[row + x] > m)
                        m = atlas[row + x];
            }
            cellMax[i] = m;
            if (m == 0)
                cellBrick[i] = -1;   // only borrowed zeros: leave its slot unused
        }
        this.cellBrick = cellBrick;
        this.cellMax = cellMax;
        this.brickCount = count;
        this.atlas = atlas;
    }
    // Where brick b starts in the atlas, in bytes along each axis.
    brickOrigin(b) {
        const [nx, ny] = this.atlasBricks, B = VoxelGrid.BRICK;
        return [(b % nx) * B, (Math.floor(b / nx) % ny) * B, Math.floor(b / (nx * ny)) * B];
    }

    // A grid from dense bytes ({ dims, bounds, max }, codes x fastest), filling bounds the way the first file format
    // (JSVOL1) did: voxel centers half a voxel in from its faces, and values held constant past the outermost ones. The
    // lattice gets one more voxel on every side, copying its neighbor, which reproduces that exactly.
    static fromDense({ dims, bounds, max }, codes, source = "") {
        const size = [0, 1, 2].map(i => (bounds.max[i] - bounds.min[i]) / dims[i]), C = VoxelGrid.MAJORANT_CELL;
        const cellDims = dims.map(n => Math.ceil((n + 2) / C));
        const cellLeaf = new Int32Array(cellDims[0] * cellDims[1] * cellDims[2]).fill(-1), leaves = [];
        const leaf = new Uint8Array(512), clamp = (v, n) => Math.min(n - 1, Math.max(0, v));
        for (let z = 0, i = 0; z < cellDims[2]; ++z) for (let y = 0; y < cellDims[1]; ++y) for (let x = 0; x < cellDims[0]; ++x, ++i) {
            let any = 0;
            for (let k = 0; k < 8; ++k) for (let j = 0; j < 8; ++j) for (let h = 0; h < 8; ++h) {
                const v = codes[(clamp(z * C + k - 1, dims[2]) * dims[1] + clamp(y * C + j - 1, dims[1])) * dims[0] + clamp(x * C + h - 1, dims[0])];
                leaf[(k * 8 + j) * 8 + h] = v;
                any |= v;
            }
            if (any) {
                cellLeaf[i] = leaves.length;
                leaves.push(leaf.slice());
            }
        }
        const all = new Uint8Array(leaves.length * 512);
        leaves.forEach((l, i) => all.set(l, i * 512));
        return new VoxelGrid({ cellDims: cellDims, origin: bounds.min.map((m, i) => m - 0.5 * size[i]), voxelSize: size,
                               bounds: bounds, max: max }, cellLeaf, all, source);
    }
    // Loads a .vol.gz file made by tools/vdb_to_grid.py: sparse leaves (JSVOL2), or a dense grid (JSVOL1, older files).
    static async load(url) {
        const response = await fetch(url);
        if (!response.ok)
            throw `Could not load the voxel grid ${url}: ${response.status} ${response.statusText}`;
        return VoxelGrid.parse(new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()), url);
    }
    // A grid from a .vol.gz file's bytes, once decompressed.
    static parse(bytes, url = "") {
        const magic = String.fromCharCode(...bytes.subarray(0, 7));
        if (magic != "JSVOL1\n" && magic != "JSVOL2\n")
            throw `${url} is not a voxel grid made by tools/vdb_to_grid.py`;
        const end = bytes.indexOf(10, 7);
        const header = JSON.parse(new TextDecoder().decode(bytes.subarray(7, end)));
        if (header.encoding != "u8-squared")
            throw `${url}: unknown voxel encoding ${header.encoding}`;
        const data = bytes.subarray(end + 1);
        if (magic == "JSVOL1\n") {
            if (data.length != header.dims[0] * header.dims[1] * header.dims[2])
                throw `${url}: expected ${header.dims.join(" x ")} voxels, found ${data.length} bytes`;
            return VoxelGrid.fromDense(header, data, url);
        }
        // JSVOL2: one byte per cell (1 if it has a leaf), then the leaves in cell order.
        const [cx, cy, cz] = header.cellDims, cells = cx * cy * cz;
        if (data.length != cells + header.leaves * 512)
            throw `${url}: expected ${cells} cells and ${header.leaves} leaves, found ${data.length} bytes`;
        const cellLeaf = new Int32Array(cells);
        let n = 0;
        for (let i = 0; i < cells; ++i)
            cellLeaf[i] = data[i] ? n++ : -1;
        return new VoxelGrid(header, cellLeaf, data.subarray(cells), url);
    }

    // The cell a point (in the grid's space) falls in, clamped into the grid, as [x, y, z], and its continuous voxel
    // coordinates.
    locate(p) {
        const f = [0, 1, 2].map(i => (p[i] - this.origin[i]) / this.voxelSize[i]);
        const c = f.map((v, i) => Math.min(this.cellDims[i] - 1, Math.max(0, Math.floor(v / VoxelGrid.MAJORANT_CELL))));
        return [c, f];
    }
    cellIndex(c) {
        return (c[2] * this.cellDims[1] + c[1]) * this.cellDims[0] + c[0];
    }
    // Byte value (0 to 255, interpolated) at a point in the grid's space: trilinear within the cell's brick.
    codeAt(p) {
        const [c, f] = this.locate(p), b = this.cellBrick[this.cellIndex(c)];
        if (b < 0)
            return 0;
        const g = f.map((v, i) => Math.min(8, Math.max(0, v - c[i] * VoxelGrid.MAJORANT_CELL)));
        const i0 = g.map(v => Math.min(7, Math.floor(v))), t = g.map((v, i) => v - i0[i]);
        const o = this.brickOrigin(b), [ax, ay] = this.atlasDims, atlas = this.atlas;
        const base = ((o[2] + i0[2]) * ay + o[1] + i0[1]) * ax + o[0] + i0[0];
        let sum = 0;
        for (let dz = 0; dz < 2; ++dz) for (let dy = 0; dy < 2; ++dy) {
            const row = base + (dz * ay + dy) * ax, w = (dz ? t[2] : 1 - t[2]) * (dy ? t[1] : 1 - t[1]);
            sum += w * ((1 - t[0]) * atlas[row] + t[0] * atlas[row + 1]);
        }
        return sum;
    }
    valueAt(p) {
        const c = this.codeAt(p) / 255;
        return this.max * c * c;
    }

    // Majorants per cell: the largest byte in its brick, which bounds every value interpolated inside the cell.
    // (Decoding is increasing, so the decoded largest byte bounds the decoded interpolated ones.) x fastest.
    get majorantDims() {
        return this.cellDims;
    }
    get majorantCodes() {
        return this.cellMax;
    }
    // Calls visit(ta, tb, majorant) for each majorant cell a ray (in the grid's space) crosses within [t0, t1], in
    // order, until visit returns true. A 3D DDA over the cells (Amanatides and Woo).
    traverse(local, t0, t1, visit) {
        const cs = this.voxelSize.map(v => v * VoxelGrid.MAJORANT_CELL), cd = this.majorantDims, codes = this.majorantCodes;
        const o = local.origin, d = local.direction, min = this.origin;
        const idx = [0, 0, 0], step = [0, 0, 0], tNext = [0, 0, 0], tDelta = [0, 0, 0];
        for (let i = 0; i < 3; ++i) {
            const q = (o[i] + d[i] * t0 - min[i]) / cs[i], dq = d[i] / cs[i];
            idx[i] = Math.min(cd[i] - 1, Math.max(0, Math.floor(q)));
            step[i] = dq >= 0 ? 1 : -1;
            tNext[i] = dq == 0 ? Infinity : t0 + (idx[i] + (dq > 0 ? 1 : 0) - q) / dq;
            tDelta[i] = dq == 0 ? Infinity : Math.abs(1 / dq);
        }
        let t = t0;
        while (t < t1) {
            const axis = tNext[0] < tNext[1] ? (tNext[0] < tNext[2] ? 0 : 2) : (tNext[1] < tNext[2] ? 1 : 2);
            const tb = Math.min(tNext[axis], t1);
            const c = codes[(idx[2] * cd[1] + idx[1]) * cd[0] + idx[0]] / 255;
            if (tb > t && visit(t, tb, this.max * c * c))
                return;
            t = tb;
            idx[axis] += step[axis];
            tNext[axis] += tDelta[axis];
            if (idx[axis] < 0 || idx[axis] >= cd[axis])
                return;
        }
    }
}

class GridMedium extends Medium {
    constructor(grid, params = {}) {
        super(params);
        this.grid = grid;
    }
    static async load(url, params = {}) {
        return new GridMedium(await VoxelGrid.load(url), params);
    }
    get bounds() {
        return this.grid.bounds;
    }
    get majorant() {
        return this.density * this.grid.max;
    }
    densityAt(p) {
        return this.density * this.grid.valueAt(p);
    }
}

class Volume extends WorldObject {
    constructor(medium, transform = Mat4.identity(), inv_transform = Mat4.inverse(transform)) {
        super(transform, inv_transform);
        this.medium = medium;
    }
    // Not a surface: rays never stop at a volume (World.cast passes through it). The integrator finds volumes with
    // World.volumes instead.
    intersect(ray, minDistance, maxDistance = Infinity, intersectTransparent = true) {
        return { distance: Infinity, ancestors: [], object: this };
    }
    buildBoundingBox() {
        const { min, max } = this.medium.bounds;
        return AABB.fromMinMax(min.to4(1), max.to4(1)).getBoundingBox(this.transform, this.inv_transform);
    }

    // The part of a ray inside the medium, as [t0, t1] in the ray's own parameter, clipped to [tMin, tMax]; null if
    // none. `local` is the ray in the volume's own space (which keeps the parameter).
    static interval(medium, local, tMin, tMax) {
        const o = local.origin, d = local.direction;
        let t0 = tMin, t1 = tMax;
        if (medium.shape == "sphere") {
            const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2], b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
            const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - 1, disc = b * b - a * c;
            if (disc <= 0)
                return null;
            const r = Math.sqrt(disc);
            t0 = Math.max(t0, (-b - r) / a);
            t1 = Math.min(t1, (-b + r) / a);
        }
        else {
            const { min, max } = medium.bounds;
            for (let i = 0; i < 3; ++i) {
                const inv = 1 / d[i];
                let ta = (min[i] - o[i]) * inv, tb = (max[i] - o[i]) * inv;
                if (ta > tb)
                    [ta, tb] = [tb, ta];
                if (!(ta <= tb))   // d[i] == 0 and outside the slab gives NaN
                    return null;
                t0 = Math.max(t0, ta);
                t1 = Math.min(t1, tb);
            }
        }
        return t0 < t1 ? [t0, t1] : null;
    }
    // Delta tracking: the parameter of the first real collision in [t0, t1], or null if the ray passes through.
    static sampleCollision(medium, local, t0, t1) {
        if (medium instanceof GridMedium) {
            const speed = local.direction.norm();
            let result = null;
            medium.grid.traverse(local, t0, t1, (ta, tb, cellMax) => {
                const majorant = medium.density * cellMax;
                if (!(majorant > 0))
                    return false;
                for (let t = ta;;) {
                    t -= Math.log(1 - Math.random()) / (majorant * speed);
                    if (t >= tb)
                        return false;
                    if (Math.random() * majorant < medium.densityAt(local.getPoint(t))) {
                        result = t;
                        return true;
                    }
                }
            });
            return result;
        }
        const majorant = medium.majorant, speed = local.direction.norm();
        if (!(majorant > 0))
            return null;
        let t = t0;
        for (;;) {
            t -= Math.log(1 - Math.random()) / (majorant * speed);
            if (t >= t1)
                return null;
            if (medium.homogeneous || Math.random() * majorant < medium.densityAt(local.getPoint(t)))
                return t;
        }
    }
    // The transmittance over [t0, t1]: exact for a homogeneous medium, otherwise a ratio tracking estimate, with
    // Russian roulette once it gets small (so it can come out 0).
    static transmittance(medium, local, t0, t1) {
        const majorant = medium.majorant, speed = local.direction.norm();
        if (!(majorant > 0))
            return 1;
        if (medium.homogeneous)
            return Math.exp(-majorant * speed * (t1 - t0));
        if (medium instanceof GridMedium) {
            let T = 1;
            medium.grid.traverse(local, t0, t1, (ta, tb, cellMax) => {
                const cellMajorant = medium.density * cellMax;
                if (!(cellMajorant > 0))
                    return false;
                for (let t = ta;;) {
                    t -= Math.log(1 - Math.random()) / (cellMajorant * speed);
                    if (t >= tb)
                        return false;
                    T *= 1 - medium.densityAt(local.getPoint(t)) / cellMajorant;
                    if (T < 0.1) {
                        if (Math.random() < 0.5) {
                            T = 0;
                            return true;
                        }
                        T *= 2;
                    }
                }
            });
            return T;
        }
        let T = 1, t = t0;
        for (;;) {
            t -= Math.log(1 - Math.random()) / (majorant * speed);
            if (t >= t1)
                return T;
            T *= 1 - medium.densityAt(local.getPoint(t)) / majorant;
            if (T < 0.1) {
                if (Math.random() < 0.5)
                    return 0;
                T *= 2;
            }
        }
    }
}
