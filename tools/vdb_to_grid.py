"""Converts a float grid in an OpenVDB file (a fog volume's "density", say) to the sparse grid format the tracer loads
(GridMedium.load in src/media.js):

    python3 tools/vdb_to_grid.py bunny_cloud.vdb assets/volumes/bunny_cloud.vol.gz

Needs OpenVDB's Python module (pyopenvdb, e.g. the python3-openvdb package on Debian and Ubuntu) and numpy.

The voxels are split into cells of 8^3 (like OpenVDB's leaves), and only cells with something in them are written. The
output is gzip compressed: the line "JSVOL2", a line of JSON describing the grid, one byte per cell (1 if it has a leaf,
x fastest, then y, then z), then each of those cells' 512 voxels in the same order, one byte each. The JSON gives:
    cellDims  [cx, cy, cz], the number of cells along each axis
    origin    [x, y, z], the center of the first voxel, in the VDB's world units; voxel k is at origin + k * voxelSize
    voxelSize [x, y, z]
    bounds    {"min": [x, y, z], "max": [x, y, z]}: the box where values can be nonzero (one voxel past the data)
    max       the largest value; a byte b stands for max * (b / 255)^2. The square spends more of the 256 levels on
              thin regions, where clouds and smoke have their wisps. Values are interpolated before decoding, on the CPU
              and the GPU alike.
    leaves    the number of cells written
    encoding  "u8-squared", the encoding above
The lattice starts one voxel before the data, so the falloff from the outermost voxels to zero is inside it too.
Downsampling averages blocks of voxels, which keeps the cloud's total density.
"""
import argparse, gzip, json, sys
import numpy as np
try:
    import pyopenvdb as vdb
except ImportError:
    sys.exit("This needs OpenVDB's Python module (pyopenvdb), e.g. the python3-openvdb package.")

parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
parser.add_argument("vdb")
parser.add_argument("output")
parser.add_argument("--grid", default="density", help="the grid to convert (default: density)")
parser.add_argument("--downsample", type=int, default=1, help="average blocks of N^3 voxels (default: 1, none)")
args = parser.parse_args()

grid = vdb.read(args.vdb, args.grid)
(imin, imax) = grid.evalActiveVoxelBoundingBox()
dims = [b - a + 1 for a, b in zip(imin, imax)]
dense = np.zeros(dims, dtype=np.float32)
grid.copyToArray(dense, ijk=imin)
voxel = np.array(grid.transform.voxelSize())

n = args.downsample
if n > 1:
    padded = np.zeros([(d + n - 1) // n * n for d in dims], dtype=np.float32)
    padded[:dims[0], :dims[1], :dims[2]] = dense
    s = padded.shape
    dense = padded.reshape(s[0] // n, n, s[1] // n, n, s[2] // n, n).mean(axis=(1, 3, 5))
    dims = list(dense.shape)

# Voxel i of the VDB is centered at i * voxel size + t (its transform's translation; only scaling and translating
# transforms are supported), so averaged voxel k (of n^3) is at imin + n k + (n - 1) / 2.
t = np.array(grid.transform.indexToWorld((0, 0, 0)))
if not np.allclose(np.array(grid.transform.indexToWorld((1, 1, 1))) - t, voxel):
    sys.exit(f"The grid {args.grid} has a rotated or non-linear transform, which isn't supported.")
size = voxel * n
first = (np.array(imin) + (n - 1) / 2) * voxel + t
dense = np.maximum(dense, 0)
peak = float(dense.max())
if not peak > 0:
    sys.exit(f"The grid {args.grid} is empty.")

# The lattice: one zero voxel, then the data, padded with zeros to whole cells.
cells = [(d + 2 + 7) // 8 for d in dims]
codes = np.zeros([c * 8 for c in cells], dtype=np.uint8)
codes[1:dims[0] + 1, 1:dims[1] + 1, 1:dims[2] + 1] = np.round(np.sqrt(dense / peak) * 255).astype(np.uint8)
del dense
# Leaves in cell order, each x fastest: [cz, cy, cx, 8z, 8y, 8x].
leaves = codes.reshape(cells[0], 8, cells[1], 8, cells[2], 8).transpose(4, 2, 0, 5, 3, 1).reshape(-1, 512)
mask = leaves.any(axis=1)
origin = first - size
lo, hi = origin, origin + (np.array(dims) + 1) * size

header = {"cellDims": cells, "origin": origin.tolist(), "voxelSize": size.tolist(), "bounds": {"min": lo.tolist(), "max": hi.tolist()},
          "max": peak, "leaves": int(mask.sum()), "encoding": "u8-squared", "source": args.vdb.split("/")[-1], "grid": args.grid}
with gzip.open(args.output, "wb", compresslevel=9) as f:
    f.write(b"JSVOL2\n")
    f.write((json.dumps(header) + "\n").encode())
    f.write(mask.astype(np.uint8).tobytes())
    f.write(np.ascontiguousarray(leaves[mask]).tobytes())
print(f"{args.output}: {dims[0]} x {dims[1]} x {dims[2]} voxels in {cells[0]} x {cells[1]} x {cells[2]} cells, "
      f"{header['leaves']} with data ({100 * header['leaves'] / mask.size:.1f}%), max {peak:.4g}")
