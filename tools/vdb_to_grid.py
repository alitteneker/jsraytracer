"""Converts a float grid in an OpenVDB file (a fog volume's "density", say) to the dense grid format the tracer loads
(GridMedium.load in src/media.js):

    python3 tools/vdb_to_grid.py bunny_cloud.vdb assets/volumes/bunny_cloud.vol.gz --downsample 2

Needs OpenVDB's Python module (pyopenvdb, e.g. the python3-openvdb package on Debian and Ubuntu) and numpy.

The output is gzip compressed: the line "JSVOL1", a line of JSON describing the grid, then one byte per voxel, x
fastest, then y, then z. The JSON gives:
    dims      [nx, ny, nz]
    bounds    {"min": [x, y, z], "max": [x, y, z]}: the box the voxels fill, in the VDB's world units
    max       the largest value; a byte b stands for max * (b / 255)^2. The square spends more of the 256 levels on
              thin regions, where clouds and smoke have their wisps. Values are interpolated before decoding, on the CPU
              and the GPU alike.
    encoding  "u8-squared", the encoding above
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

# Voxel i of the VDB is centered at i * voxel size, so the voxels fill from (imin - 1/2) voxels on.
lo = (np.array(imin) - 0.5) * voxel
hi = lo + np.array(dims) * voxel * n
dense = np.maximum(dense, 0)
peak = float(dense.max())
codes = np.round(np.sqrt(dense / peak) * 255).astype(np.uint8)

header = {"dims": dims, "bounds": {"min": lo.tolist(), "max": hi.tolist()}, "max": peak, "encoding": "u8-squared",
          "source": args.vdb.split("/")[-1], "grid": args.grid}
with gzip.open(args.output, "wb", compresslevel=9) as f:
    f.write(b"JSVOL1\n")
    f.write((json.dumps(header) + "\n").encode())
    f.write(np.ascontiguousarray(codes.transpose(2, 1, 0)).tobytes())  # x fastest, then y, then z
print(f"{args.output}: {dims[0]} x {dims[1]} x {dims[2]} voxels, max {peak:.4g}, bounds {lo.round(3).tolist()} to {hi.round(3).tolist()}")
