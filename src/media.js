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
//   GridMedium: density from a voxel grid (VoxelGrid, loaded from a file made by tools/vdb_to_grid.py), filling the
//       grid's box. The grid's values are multiplied by the medium's density.
//
// Sampling (shared by the CPU and the GPU, see gl/shaders/media.glsl): where light first interacts along a ray is
// sampled from the transmittance itself. In a homogeneous medium that's exact: distance = -ln(1 - u) / density. In a
// grid, delta tracking samples against the majorant (an upper bound on the density) and accepts each tentative
// collision with probability density / majorant; the rest are "null" collisions that change nothing. Shadow rays
// estimate transmittance by ratio tracking: the same tentative collisions, each multiplying the estimate by
// 1 - density / majorant. Both are unbiased for any majorant at least the true density, and cheaper the tighter it is.

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

// Density values on a regular grid of voxels, filling a box. Stored as the bytes tools/vdb_to_grid.py writes: a byte
// b stands for max * (b / 255)^2, and sampling interpolates the bytes trilinearly before decoding (as the GPU's
// texture filtering does), with the edge voxels extending beyond the box.
class VoxelGrid {
    constructor({ dims, bounds, max }, codes, source = "") {
        this.dims = dims;
        this.bounds = { min: Vec.of(...bounds.min), max: Vec.of(...bounds.max) };
        this.max = max;
        this.codes = codes;
        this.source = source;
        this.voxelSize = [0, 1, 2].map(i => (bounds.max[i] - bounds.min[i]) / dims[i]);
    }
    // Loads a .vol.gz file (see tools/vdb_to_grid.py).
    static async load(url) {
        const response = await fetch(url);
        if (!response.ok)
            throw `Could not load the voxel grid ${url}: ${response.status} ${response.statusText}`;
        const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
        const magic = "JSVOL1\n";
        if (String.fromCharCode(...bytes.subarray(0, magic.length)) != magic)
            throw `${url} is not a voxel grid made by tools/vdb_to_grid.py`;
        const end = bytes.indexOf(10, magic.length);
        const header = JSON.parse(new TextDecoder().decode(bytes.subarray(magic.length, end)));
        if (header.encoding != "u8-squared")
            throw `${url}: unknown voxel encoding ${header.encoding}`;
        const codes = bytes.subarray(end + 1);
        if (codes.length != header.dims[0] * header.dims[1] * header.dims[2])
            throw `${url}: expected ${header.dims.join(" x ")} voxels, found ${codes.length} bytes`;
        return new VoxelGrid(header, codes, url);
    }
    // Byte value (0 to 255, interpolated) at a point in the grid's space.
    codeAt(p) {
        const [nx, ny, nz] = this.dims;
        const f = [0, 1, 2].map(i => (p[i] - this.bounds.min[i]) / this.voxelSize[i] - 0.5);
        const i0 = f.map(Math.floor), t = f.map((v, i) => v - i0[i]);
        const clamp = (v, n) => v < 0 ? 0 : v >= n ? n - 1 : v;
        let sum = 0;
        for (let dz = 0; dz < 2; ++dz) {
            const z = clamp(i0[2] + dz, nz), wz = dz ? t[2] : 1 - t[2];
            for (let dy = 0; dy < 2; ++dy) {
                const y = clamp(i0[1] + dy, ny), wy = dy ? t[1] : 1 - t[1];
                for (let dx = 0; dx < 2; ++dx) {
                    const x = clamp(i0[0] + dx, nx), wx = dx ? t[0] : 1 - t[0];
                    sum += wx * wy * wz * this.codes[(z * ny + y) * nx + x];
                }
            }
        }
        return sum;
    }
    valueAt(p) {
        const c = this.codeAt(p) / 255;
        return this.max * c * c;
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
