// Reads OpenVDB files (.vdb) directly, so the editor can import them in the browser (see gl/src/WebGLImporter.js), and
// turns their float grids into VoxelGrids (src/media.js) without resampling: OpenVDB's leaves are 8^3 voxels aligned to
// multiples of 8, exactly VoxelGrid's cells, so each leaf becomes a cell as it is.
//
// What's supported: file format 222 and later (OpenVDB 3 on), float grids of the standard 5-4-3 tree, stored plainly
// or as half floats, compressed with Blosc (LZ4 or BloscLZ inside), zlib, or not at all, with linear transforms that
// only scale and translate (what Houdini and most tools write for volumes). Not: other value types, rotated or frustum
// transforms, files written by OpenVDB 2 or earlier. tools/vdb_to_grid.py (OpenVDB's own Python module) handles those.
//
// The layout followed here is OpenVDB's io code: a header, the file's metadata, a table of grids, then each grid's
// compression flags, metadata, transform, tree topology (root tiles and children, each internal node's child and value
// masks and its tile values, each leaf's value mask) and finally the leaves' values, in the same order.

class VDBFile {
    static MAGIC = 0x56444220;   // " BDV"
    static COMPRESS_ZIP = 0x1;
    static COMPRESS_ACTIVE_MASK = 0x2;
    static COMPRESS_BLOSC = 0x4;
    static LOG2DIM = [5, 4, 3];  // internal (32^3 children), internal (16^3), leaf (8^3)

    // bytes: the whole file, as a Uint8Array (or an ArrayBuffer).
    constructor(bytes, name = "a VDB file") {
        this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
        this.name = name;
        this.pos = 0;
        this.readHeader();
    }

    // ---- Reading primitives (little endian, as OpenVDB writes) ----
    u8()  { return this.view.getUint8(this.pos++); }
    i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
    u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
    i64() { const v = Number(this.view.getBigInt64(this.pos, true)); this.pos += 8; return v; }
    f32() { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
    f64() { const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
    vec3d() { return [this.f64(), this.f64(), this.f64()]; }
    take(n) {
        if (this.pos + n > this.bytes.length)
            throw `${this.name} ends early (wanted ${n} bytes at ${this.pos})`;
        const b = this.bytes.subarray(this.pos, this.pos + n);
        this.pos += n;
        return b;
    }
    string() { return new TextDecoder().decode(this.take(this.i32())); }
    // A node mask of n bits, as 64-bit words (read as bytes; bit i is byte i >> 3, bit i & 7).
    mask(bits) { return this.take(bits >> 3).slice(); }
    static isOn(mask, i) { return (mask[i >> 3] >> (i & 7)) & 1; }
    static countOn(mask) {
        let n = 0;
        for (let i = 0; i < mask.length; ++i)
            for (let b = mask[i]; b; b &= b - 1)
                ++n;
        return n;
    }

    readHeader() {
        const magic = this.u32();
        this.pos += 4;   // the magic number's high half
        if (magic != VDBFile.MAGIC)
            throw `${this.name} is not an OpenVDB file`;
        this.version = this.u32();
        if (this.version < 222)
            throw `${this.name} was written by OpenVDB 2 or earlier (file format ${this.version}); convert it with tools/vdb_to_grid.py`;
        this.libraryVersion = [this.u32(), this.u32()];
        const hasGridOffsets = this.u8();
        this.uuid = new TextDecoder().decode(this.take(36));
        this.metadata = this.readMetadata();
        if (!hasGridOffsets)
            throw `${this.name} has no table of grids (written to a stream rather than a file), which this reader doesn't handle`;
        const count = this.i32();
        this.grids = [];
        for (let i = 0; i < count; ++i) {
            // Each grid's descriptor comes right before its data, and says where that ends: the next descriptor. A
            // grid's name may carry a suffix making it unique ("density\x1e1"); its type names the tree and value.
            const name = this.string().split("\x1e")[0], type = this.string();
            const instanceParent = this.string();
            const gridPos = this.i64(), blockPos = this.i64(), endPos = this.i64();
            this.grids.push({ name, type, instanceParent, gridPos, blockPos, endPos });
            this.pos = endPos;
        }
    }
    // Metadata: a count, then per entry its name, type name, and value (a byte count, then the bytes). Kept as raw
    // bytes, decoded for the few types worth showing.
    readMetadata() {
        const meta = {}, count = this.i32();
        for (let i = 0; i < count; ++i) {
            const name = this.string(), type = this.string(), data = this.take(this.i32());
            const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
            meta[name] = type == "string" ? new TextDecoder().decode(data)
                       : type == "bool" ? !!data[0]
                       : type == "int32" ? v.getInt32(0, true) : type == "int64" ? Number(v.getBigInt64(0, true))
                       : type == "float" ? v.getFloat32(0, true) : type == "double" ? v.getFloat64(0, true)
                       : type == "vec3i" ? [0, 1, 2].map(k => v.getInt32(4 * k, true))
                       : type == "vec3d" ? [0, 1, 2].map(k => v.getFloat64(8 * k, true)) : data;
        }
        return meta;
    }

    // The float grids, by name, as { name, transform: { scale, translate }, background, leaves: [{ origin, values }] }:
    // each leaf's origin in index space and its 512 values (z fastest, as OpenVDB orders them), with constant tiles
    // expanded into leaves.
    readGrid(descriptor) {
        if (descriptor.instanceParent)
            throw `the grid ${descriptor.name} in ${this.name} is an instance of another, which this reader doesn't handle`;
        if (!/^Tree_float_5_4_3(_HalfFloat)?$/.test(descriptor.type))
            throw `the grid ${descriptor.name} in ${this.name} is a ${descriptor.type}; only float grids are supported`;
        this.pos = descriptor.gridPos;
        this.compression = this.u32();
        const meta = this.readMetadata();
        const fromHalf = /_HalfFloat$/.test(descriptor.type) || meta.is_saved_as_half_float === true;
        const transform = this.readTransform(descriptor.name);

        if (this.i32() != 1)
            throw `the grid ${descriptor.name} in ${this.name} has several buffers per leaf, which this reader doesn't handle`;
        // Root: its background, tiles and children.
        const background = this.f32();
        this.background = background;
        const tileCount = this.u32(), childCount = this.u32();
        const tiles = [], leaves = [], leafNodes = [];
        const rootTileSize = 1 << (5 + 4 + 3);
        for (let i = 0; i < tileCount; ++i) {
            const origin = [this.i32(), this.i32(), this.i32()], value = this.f32(), active = this.u8();
            tiles.push({ origin, size: rootTileSize, value, active });
        }
        for (let i = 0; i < childCount; ++i)
            this.readInternalTopology([this.i32(), this.i32(), this.i32()], 0, fromHalf, tiles, leafNodes);
        // Then every leaf's values, in the same order: its value mask again, and the values.
        for (const leaf of leafNodes) {
            this.pos += 64;
            leaves.push({ origin: leaf.origin, values: this.readCompressedValues(512, leaf.valueMask, fromHalf) });
        }
        // Constant tiles (other than the background) become leaves too, 8^3 at a time.
        for (const t of tiles) {
            if (t.value == background)
                continue;
            const n = t.size >> 3;
            if (n * n * n > 1 << 18)
                throw `the grid ${descriptor.name} in ${this.name} has a constant region too large to expand (${t.size}^3 voxels)`;
            for (let x = 0; x < n; ++x) for (let y = 0; y < n; ++y) for (let z = 0; z < n; ++z)
                leaves.push({ origin: [t.origin[0] + 8 * x, t.origin[1] + 8 * y, t.origin[2] + 8 * z], values: new Float32Array(512).fill(t.value) });
        }
        return { name: descriptor.name, transform, background, leaves, metadata: meta };
    }
    // An internal node at `level` (0: 32^3 children, 1: 16^3): its masks, its tile values, then its children.
    readInternalTopology(origin, level, fromHalf, tiles, leafNodes) {
        const log2 = VDBFile.LOG2DIM[level], size = 1 << (3 * log2);
        const childLog2 = level == 0 ? 4 + 3 : 3;   // a child's size in voxels, as a power of 2
        const childMask = this.mask(size), valueMask = this.mask(size);
        const values = this.readCompressedValues(size, valueMask, fromHalf);
        const at = n => {
            const x = n >> (2 * log2), y = (n >> log2) & ((1 << log2) - 1), z = n & ((1 << log2) - 1);
            return [origin[0] + (x << childLog2), origin[1] + (y << childLog2), origin[2] + (z << childLog2)];
        };
        for (let n = 0; n < size; ++n)
            if (!VDBFile.isOn(childMask, n) && values[n] != this.background)
                tiles.push({ origin: at(n), size: 1 << childLog2, value: values[n], active: VDBFile.isOn(valueMask, n) });
        for (let n = 0; n < size; ++n) {
            if (!VDBFile.isOn(childMask, n))
                continue;
            if (level == 0)
                this.readInternalTopology(at(n), 1, fromHalf, tiles, leafNodes);
            else
                leafNodes.push({ origin: at(n), valueMask: this.mask(512) });
        }
    }
    // OpenVDB's io::readCompressedValues: a byte saying how inactive values were stored, maybe one or two of them and a
    // mask choosing between them, then the values themselves (all of them, or only the active ones if the grid uses
    // active mask compression), each run compressed as the grid says.
    readCompressedValues(count, valueMask, fromHalf) {
        const meta = this.u8();
        let inactive0 = meta == 0 ? this.background : -this.background, inactive1 = this.background;
        if (meta == 2 || meta == 4 || meta == 5) {
            inactive0 = this.f32();
            if (meta == 5)
                inactive1 = this.f32();
        }
        const selection = (meta == 3 || meta == 4 || meta == 5) ? this.mask(count) : null;
        const onlyActive = (this.compression & VDBFile.COMPRESS_ACTIVE_MASK) && meta != 6;
        const stored = onlyActive ? VDBFile.countOn(valueMask) : count;
        const raw = this.readData(stored * (fromHalf ? 2 : 4));
        const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const get = fromHalf ? i => VDBFile.half(dv.getUint16(2 * i, true)) : i => dv.getFloat32(4 * i, true);
        const out = new Float32Array(count);
        if (!onlyActive || stored == count) {
            for (let i = 0; i < count; ++i)
                out[i] = get(i);
            return out;
        }
        for (let i = 0, j = 0; i < count; ++i)
            out[i] = VDBFile.isOn(valueMask, i) ? get(j++) : (selection && VDBFile.isOn(selection, i) ? inactive1 : inactive0);
        return out;
    }
    // A run of n bytes, compressed as the grid says: Blosc and zlib runs start with their compressed size (an int64; 0
    // or negative means stored as is, that many bytes).
    readData(n) {
        if (!(this.compression & (VDBFile.COMPRESS_BLOSC | VDBFile.COMPRESS_ZIP)))
            return this.take(n);
        const size = this.i64();
        if (size <= 0) {
            if (-size != n)
                throw `${this.name}: a stored run has ${-size} bytes, expected ${n}`;
            return this.take(n);
        }
        const packed = this.take(size);
        const out = (this.compression & VDBFile.COMPRESS_BLOSC) ? Blosc.decompress(packed) : Inflate.zlib(packed, n);
        if (out.length != n)
            throw `${this.name}: a compressed run holds ${out.length} bytes, expected ${n}`;
        return out;
    }
    // The grid's transform, index space to world space, as a scale and a translation (index i is at i * scale + t).
    readTransform(gridName) {
        const type = this.string();
        let scale, translate = [0, 0, 0];
        if (type == "UniformScaleMap" || type == "ScaleMap") {
            scale = this.vec3d();
            this.pos += 4 * 24;   // voxel size, inverse scale, inverse scale squared, inverse twice scale
        }
        else if (type == "UniformScaleTranslateMap" || type == "ScaleTranslateMap") {
            translate = this.vec3d();
            scale = this.vec3d();
            this.pos += 4 * 24;
        }
        else if (type == "TranslationMap") {
            translate = this.vec3d();
            scale = [1, 1, 1];
        }
        else if (type == "AffineMap") {
            const m = Array.from({ length: 16 }, () => this.f64());   // row major, translation in the last row
            if ([1, 2, 4, 6, 8, 9].some(i => Math.abs(m[i]) > 1e-9))
                throw `the grid ${gridName} in ${this.name} has a rotated transform, which this reader doesn't handle`;
            scale = [m[0], m[5], m[10]];
            translate = [m[12], m[13], m[14]];
        }
        else
            throw `the grid ${gridName} in ${this.name} has a ${type} transform, which this reader doesn't handle`;
        return { scale, translate };
    }
    static half(h) {
        const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
        if (e == 0)
            return s * f * Math.pow(2, -24);
        if (e == 31)
            return f ? NaN : s * Infinity;
        return s * (1 + f / 1024) * Math.pow(2, e - 15);
    }

    // The named float grids as VoxelGrids sharing one lattice (so a temperature grid lines up with its density, see
    // GridMedium). Values are encoded as VoxelGrid's bytes against each grid's own largest value; negative ones count as
    // 0 (fog volumes have none). Missing grids are left out.
    toVoxelGrids(names) {
        const grids = names.map(n => this.grids.find(g => g.name == n)).filter(g => g).map(g => this.readGrid(g));
        if (!grids.length)
            return {};
        const t = grids[0].transform;
        for (const g of grids)
            if (g.transform.scale.some((v, i) => Math.abs(v - t.scale[i]) > 1e-9 * Math.abs(v))
                || g.transform.translate.some((v, i) => Math.abs(v - t.translate[i]) > 1e-9))
                throw `the grids in ${this.name} don't share a transform`;
        // The lattice: every leaf, with an empty cell on each side (so interpolation can fall off to 0 at the edges).
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const g of grids)
            for (const l of g.leaves)
                for (let k = 0; k < 3; ++k) {
                    lo[k] = Math.min(lo[k], l.origin[k]);
                    hi[k] = Math.max(hi[k], l.origin[k]);
                }
        if (!isFinite(lo[0]))
            throw `the grids in ${this.name} are empty`;
        const base = lo.map(v => v - 8), cellDims = hi.map((v, k) => (v - base[k]) / 8 + 2);
        const origin = base.map((b, k) => b * t.scale[k] + t.translate[k]);
        const end = cellDims.map((c, k) => origin[k] + c * 8 * t.scale[k]);
        const bounds = { min: origin.map((o, k) => Math.min(o, end[k])), max: origin.map((o, k) => Math.max(o, end[k])) };
        if (t.scale.some(s => s < 0))
            throw `the grids in ${this.name} have a mirrored transform, which this reader doesn't handle`;
        const result = {};
        for (const g of grids) {
            let max = 0;
            for (const l of g.leaves)
                for (const v of l.values)
                    if (v > max)
                        max = v;
            const cellLeaf = new Int32Array(cellDims[0] * cellDims[1] * cellDims[2]).fill(-1);
            const leaves = new Uint8Array(g.leaves.length * 512);
            let count = 0;
            for (const l of g.leaves) {
                const c = l.origin.map((v, k) => (v - base[k]) / 8), cell = (c[2] * cellDims[1] + c[1]) * cellDims[0] + c[0];
                const out = leaves.subarray(count * 512, count * 512 + 512);
                let any = 0;
                // OpenVDB orders a leaf's voxels z fastest (x * 64 + y * 8 + z); VoxelGrid's leaves go x fastest.
                for (let x = 0; x < 8; ++x) for (let y = 0; y < 8; ++y) for (let z = 0; z < 8; ++z) {
                    const v = l.values[x * 64 + y * 8 + z];
                    const b = v > 0 && max > 0 ? Math.round(Math.sqrt(v / max) * 255) : 0;
                    out[(z * 8 + y) * 8 + x] = b;
                    any |= b;
                }
                if (!any)
                    continue;
                if (cellLeaf[cell] >= 0)   // a tile and a leaf over the same cell: keep the leaf
                    continue;
                cellLeaf[cell] = count++;
            }
            result[g.name] = new VoxelGrid({ cellDims, origin, voxelSize: t.scale.slice(), bounds, max },
                cellLeaf, leaves.subarray(0, count * 512), `${this.name}:${g.name}`);
        }
        return result;
    }
}

// Blosc (version 1 format), as OpenVDB compresses with it: a 16-byte header (flags, element size, sizes), then the
// starts of each block, each block maybe split into one stream per byte of an element, each stream compressed with
// LZ4 or BloscLZ (or stored), and the bytes shuffled (byte k of every element together) if the header says so.
const Blosc = {
    decompress(src) {
        const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const flags = src[2], typesize = src[3], nbytes = dv.getUint32(4, true), blocksize = dv.getUint32(8, true);
        const out = new Uint8Array(nbytes);
        if (flags & 0x2) {   // stored as is
            out.set(src.subarray(16, 16 + nbytes));
            return out;
        }
        if (flags & 0x4)
            throw "Blosc bit-shuffled data isn't supported";
        const codec = (flags >> 5) & 0x7;   // 0: BloscLZ, 1: LZ4 (or LZ4HC)
        if (codec != 0 && codec != 1)
            throw `Blosc compressor ${["BloscLZ", "LZ4", "Snappy", "zlib", "Zstd"][codec] || codec} isn't supported`;
        const nblocks = Math.ceil(nbytes / blocksize), leftover = nbytes % blocksize;
        const block = new Uint8Array(blocksize);
        for (let j = 0; j < nblocks; ++j) {
            const bsize = (j == nblocks - 1 && leftover) ? leftover : blocksize;
            let at = dv.getInt32(16 + 4 * j, true);
            // Split into one stream per byte of an element, unless the header says not to (or the block is small).
            const split = !(flags & 0x10) && typesize <= 16 && bsize / typesize >= 128;
            const nsplits = split ? typesize : 1, neblock = bsize / nsplits;
            const dest = (flags & 0x1) ? block : out.subarray(j * blocksize, j * blocksize + bsize);
            for (let k = 0; k < nsplits; ++k) {
                const cbytes = dv.getInt32(at, true);
                at += 4;
                const part = dest.subarray(k * neblock, (k + 1) * neblock);
                if (cbytes == neblock)
                    part.set(src.subarray(at, at + cbytes));
                else if (cbytes == 0)
                    part.fill(0);
                else {
                    const n = codec == 1 ? Blosc.lz4(src.subarray(at, at + cbytes), part) : Blosc.blosclz(src.subarray(at, at + cbytes), part);
                    if (n != neblock)
                        throw `Blosc: a stream decompressed to ${n} bytes, expected ${neblock}`;
                }
                at += cbytes;
            }
            if (flags & 0x1) {   // unshuffle: stream k holds byte k of each element
                const o = out.subarray(j * blocksize, j * blocksize + bsize), n = Math.floor(bsize / typesize);
                for (let i = 0; i < n; ++i)
                    for (let k = 0; k < typesize; ++k)
                        o[i * typesize + k] = block[k * n + i];
                o.set(block.subarray(n * typesize, bsize), n * typesize);
            }
        }
        return out;
    },
    // An LZ4 block: sequences of literals then a match (offset back into the output, length), until the input ends.
    lz4(src, dst) {
        let i = 0, o = 0;
        while (i < src.length) {
            const token = src[i++];
            let lit = token >> 4;
            if (lit == 15)
                for (let b = 255; b == 255; lit += b)
                    b = src[i++];
            dst.set(src.subarray(i, i + lit), o);
            i += lit;
            o += lit;
            if (i >= src.length)
                break;
            const offset = src[i] | (src[i + 1] << 8);
            i += 2;
            let len = token & 15;
            if (len == 15)
                for (let b = 255; b == 255; len += b)
                    b = src[i++];
            len += 4;
            for (let k = 0; k < len; ++k, ++o)
                dst[o] = dst[o - offset];
        }
        return o;
    },
    // BloscLZ (FastLZ level 2): literal runs and matches, with long distances in an extra 16 bits.
    blosclz(src, dst) {
        let i = 0, o = 0, ctrl = src[i++] & 31;
        for (;;) {
            if (ctrl >= 32) {
                let len = (ctrl >> 5) - 1, ofs = (ctrl & 31) << 8;
                if (len == 7 - 1)
                    for (let b = 255; b == 255; len += b)
                        b = src[i++];
                const code = src[i++];
                len += 3;
                ofs += code;
                if (code == 255 && ofs == (31 << 8) + 255)
                    ofs = ((src[i++] << 8) | src[i++]) + 8191;
                let ref = o - ofs - 1;
                for (let k = 0; k < len; ++k)
                    dst[o++] = dst[ref++];
            }
            else {
                ++ctrl;
                dst.set(src.subarray(i, i + ctrl), o);
                i += ctrl;
                o += ctrl;
            }
            if (i >= src.length)
                break;
            ctrl = src[i++];
        }
        return o;
    }
};

// zlib (RFC 1950/1951) inflate, synchronous, for VDB files compressed with zip: stored, fixed and dynamic Huffman blocks.
const Inflate = {
    zlib(src, size) {
        return Inflate.raw(src.subarray(2), size);   // skip the 2-byte zlib header (the trailing checksum is ignored)
    },
    raw(src, size) {
        const out = new Uint8Array(size);
        let o = 0, bitbuf = 0, bitcnt = 0, i = 0;
        const bits = n => {
            while (bitcnt < n) {
                bitbuf |= (src[i++] || 0) << bitcnt;
                bitcnt += 8;
            }
            const v = bitbuf & ((1 << n) - 1);
            bitbuf >>>= n;
            bitcnt -= n;
            return v;
        };
        // A canonical Huffman code from code lengths: counts per length and symbols sorted by code.
        const build = lengths => {
            const counts = new Uint16Array(16), symbols = [], offs = new Uint16Array(16);
            for (const l of lengths) counts[l]++;
            counts[0] = 0;
            for (let l = 1; l < 16; ++l) offs[l] = offs[l - 1] + counts[l - 1];
            lengths.forEach((l, s) => { if (l) symbols[offs[l]++] = s; });
            return { counts, symbols };
        };
        const decode = h => {
            let code = 0, first = 0, index = 0;
            for (let l = 1; l < 16; ++l) {
                code |= bits(1);
                const c = h.counts[l];
                if (code - first < c)
                    return h.symbols[index + code - first];
                index += c;
                first = (first + c) << 1;
                code <<= 1;
            }
            throw "zlib: bad Huffman code";
        };
        const LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
        const LEXT = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
        const DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
        const DEXT = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
        let last = 0;
        while (!last) {
            last = bits(1);
            const type = bits(2);
            if (type == 0) {
                bitbuf = bitcnt = 0;
                const len = src[i] | (src[i + 1] << 8);
                i += 4;
                out.set(src.subarray(i, i + len), o);
                i += len;
                o += len;
                continue;
            }
            let lit, dist;
            if (type == 1) {
                lit = build([...Array(144).fill(8), ...Array(112).fill(9), ...Array(24).fill(7), ...Array(8).fill(8)]);
                dist = build(Array(30).fill(5));
            }
            else if (type == 2) {
                const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
                const order = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15], cl = Array(19).fill(0);
                for (let k = 0; k < hclen; ++k) cl[order[k]] = bits(3);
                const clh = build(cl), lengths = [];
                while (lengths.length < hlit + hdist) {
                    const s = decode(clh);
                    if (s < 16) lengths.push(s);
                    else if (s == 16) { const p = lengths[lengths.length - 1]; for (let r = 3 + bits(2); r--;) lengths.push(p); }
                    else if (s == 17) { for (let r = 3 + bits(3); r--;) lengths.push(0); }
                    else { for (let r = 11 + bits(7); r--;) lengths.push(0); }
                }
                lit = build(lengths.slice(0, hlit));
                dist = build(lengths.slice(hlit));
            }
            else
                throw "zlib: bad block type";
            for (;;) {
                const s = decode(lit);
                if (s < 256)
                    out[o++] = s;
                else if (s == 256)
                    break;
                else {
                    const len = LBASE[s - 257] + bits(LEXT[s - 257]), ds = decode(dist), d = DBASE[ds] + bits(DEXT[ds]);
                    for (let k = 0; k < len; ++k, ++o)
                        out[o] = out[o - d];
                }
            }
        }
        return out.subarray(0, o);
    }
};
