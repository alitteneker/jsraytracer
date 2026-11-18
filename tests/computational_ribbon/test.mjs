// Computational Ribbon: a GPU-friendly generative composition.
//
// High-count detail is triangle-only and collected into one BVH. There are no cylinders,
// capsules, or per-strand analytic primitives. Fine atmospheric wisps use the renderer's
// sparse VoxelGrid/GridMedium path; one low-count fractal accent uses the GPU SDF path.

function makeRibbonGradient() {
    const stops = [
        [0.00, [0.015, 0.12, 0.72]],
        [0.16, [0.015, 0.55, 0.96]],
        [0.34, [0.035, 0.78, 0.82]],
        [0.55, [0.22, 0.20, 0.88]],
        [0.72, [0.72, 0.10, 0.72]],
        [0.88, [1.00, 0.24, 0.08]],
        [1.00, [1.00, 0.72, 0.22]]
    ];
    const width = 512, height = 2;
    const data = new Uint8ClampedArray(width * height * 4);

    for (let x = 0; x < width; ++x) {
        const u = x / (width - 1);
        let k = 0;
        while (k < stops.length - 2 && u > stops[k + 1][0])
            ++k;
        const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
        const a = (u - t0) / (t1 - t0);
        const c = c0.map((v, i) => v * (1 - a) + c1[i] * a);
        for (let y = 0; y < height; ++y) {
            const p = (y * width + x) * 4;
            data[p] = Math.round(c[0] * 255);
            data[p + 1] = Math.round(c[1] * 255);
            data[p + 2] = Math.round(c[2] * 255);
            data[p + 3] = 255;
        }
    }
    return new TextureMaterialColor({ width, height, data }, "bilinear", true, true, "srgb");
}

function addTriangle(out, points, normals, uvs, material) {
    out.push(new Primitive(new Triangle(
        points.map(p => p.to4(true)),
        {
            normal: normals.map(n => n.to4(false)),
            UV: uvs
        }
    ), material));
}

// A thin, open, two-triangle-wide strip following a polyline. It is a genuine triangle mesh,
// not a row of cylinders. normalHints can keep a curve attached to a ribbon surface; for free
// technical lines the strip is oriented toward the camera where possible.
function addPolylineStrip(out, points, normalHints, uValues, halfWidth, material) {
    if (points.length < 2)
        return;

    const left = [], right = [], normals = [];
    for (let i = 0; i < points.length; ++i) {
        const before = points[Math.max(0, i - 1)];
        const after = points[Math.min(points.length - 1, i + 1)];
        const tangent = after.minus(before).normalized();
        let hint = normalHints ? normalHints[i] : Vec.of(0, 0, 1);
        let side = hint.cross(tangent).normalized();
        if (side.norm() < 1e-6) {
            hint = Math.abs(tangent[2]) < 0.9 ? Vec.of(0, 0, 1) : Vec.of(0, 1, 0);
            side = hint.cross(tangent).normalized();
        }
        const normal = tangent.cross(side).normalized();
        left.push(points[i].minus(side.times(halfWidth)));
        right.push(points[i].plus(side.times(halfWidth)));
        normals.push(normal);
    }

    for (let i = 0; i + 1 < points.length; ++i) {
        const u0 = uValues ? uValues[i] : i / (points.length - 1);
        const u1 = uValues ? uValues[i + 1] : (i + 1) / (points.length - 1);
        const n0 = normals[i], n1 = normals[i + 1];
        // Winding is chosen so the interpolated normal faces the strip's hint direction.
        addTriangle(out,
            [left[i], left[i + 1], right[i + 1]], [n0, n1, n1],
            [Vec.of(u0, 0.5), Vec.of(u1, 0.5), Vec.of(u1, 0.5)], material);
        addTriangle(out,
            [left[i], right[i + 1], right[i]], [n0, n1, n0],
            [Vec.of(u0, 0.5), Vec.of(u1, 0.5), Vec.of(u0, 0.5)], material);
    }
}

function makeRibbonSurface({
    longitudinalSegments = 192,
    transverseSegments = 44,
    phase = 0,
    widthScale = 1,
    depthOffset = 0,
    waveScale = 1,
    twistTurns = 1,
    xStart = -9,
    xLength = 18,
    yOffset = 0
}, material, out) {
    const centers = [], tangents = [], frames = [], vertices = [], normals = [];

    const centerline = t => Vec.of(
        xStart + xLength * t,
        yOffset + waveScale * (1.08 * Math.sin(2 * Math.PI * 0.94 * t + phase)
            + 0.34 * Math.sin(2 * Math.PI * 2.55 * t + 0.4 + phase * 0.7)),
        depthOffset + waveScale * (1.46 * Math.sin(2 * Math.PI * 0.79 * t - 0.52 + phase * 0.45)
            + 0.38 * Math.sin(2 * Math.PI * 2.17 * t + 0.2 + phase))
    );

    for (let i = 0; i <= longitudinalSegments; ++i)
        centers.push(centerline(i / longitudinalSegments));
    for (let i = 0; i <= longitudinalSegments; ++i) {
        const a = centers[Math.max(0, i - 1)];
        const b = centers[Math.min(longitudinalSegments, i + 1)];
        tangents.push(b.minus(a).normalized());
    }

    // Parallel transport gives a stable frame through low-curvature and inflection regions.
    const up = Vec.of(0, 1, 0);
    let initial = up.minus(tangents[0].times(up.dot(tangents[0]))).normalized();
    if (initial.norm() < 1e-6)
        initial = Vec.of(0, 0, 1);
    frames.push(initial);
    for (let i = 1; i <= longitudinalSegments; ++i) {
        const a = tangents[i - 1], b = tangents[i];
        const axis = a.cross(b), axisLength = axis.norm();
        let n = frames[i - 1];
        if (axisLength > 1e-7) {
            const angle = Math.atan2(axisLength, Math.max(-1, Math.min(1, a.dot(b))));
            n = Mat4.rotation(angle, axis.divide(axisLength)).times(n.to4(0)).to3().normalized();
        }
        n = n.minus(b.times(n.dot(b))).normalized();
        frames.push(n);
    }

    for (let i = 0; i <= longitudinalSegments; ++i) {
        const t = i / longitudinalSegments;
        const tangent = tangents[i], frameN = frames[i];
        const frameB = tangent.cross(frameN).normalized();
        const twist = 0.22 + 2 * Math.PI * twistTurns * t
            + 0.34 * Math.sin(2 * Math.PI * 1.65 * t + phase);
        const widthDirection = frameN.times(Math.cos(twist)).plus(frameB.times(Math.sin(twist))).normalized();
        const width = widthScale * (0.86 + 0.24 * Math.sin(2 * Math.PI * 0.88 * t + phase + 0.2));
        const row = [];
        for (let j = 0; j <= transverseSegments; ++j) {
            const v = 2 * j / transverseSegments - 1;
            row.push(centers[i].plus(widthDirection.times(width * v)));
        }
        vertices.push(row);
    }

    for (let i = 0; i <= longitudinalSegments; ++i) {
        const row = [];
        for (let j = 0; j <= transverseSegments; ++j) {
            const p0 = vertices[Math.max(0, i - 1)][j];
            const p1 = vertices[Math.min(longitudinalSegments, i + 1)][j];
            const q0 = vertices[i][Math.max(0, j - 1)];
            const q1 = vertices[i][Math.min(transverseSegments, j + 1)];
            let n = p1.minus(p0).cross(q1.minus(q0)).normalized();
            if (n.norm() < 1e-6)
                n = Vec.of(0, 0, 1);
            row.push(n);
        }
        normals.push(row);
    }

    // The actual membrane: only Triangle geometry, gathered later into a single BVH.
    for (let i = 0; i < longitudinalSegments; ++i) {
        const u0 = i / longitudinalSegments, u1 = (i + 1) / longitudinalSegments;
        for (let j = 0; j < transverseSegments; ++j) {
            const p00 = vertices[i][j], p10 = vertices[i + 1][j];
            const p11 = vertices[i + 1][j + 1], p01 = vertices[i][j + 1];
            const n00 = normals[i][j], n10 = normals[i + 1][j];
            const n11 = normals[i + 1][j + 1], n01 = normals[i][j + 1];
            addTriangle(out, [p00, p10, p11], [n00, n10, n11],
                [Vec.of(u0, 0.5), Vec.of(u1, 0.5), Vec.of(u1, 0.5)], material);
            addTriangle(out, [p00, p11, p01], [n00, n11, n01],
                [Vec.of(u0, 0.5), Vec.of(u1, 0.5), Vec.of(u0, 0.5)], material);
        }
    }

    return { vertices, normals, longitudinalSegments, transverseSegments };
}

function addLongitudinalFilaments(surface, indices, width, material, out) {
    for (const j of indices) {
        const points = [], normals = [], u = [];
        for (let i = 0; i <= surface.longitudinalSegments; ++i) {
            points.push(surface.vertices[i][j]);
            normals.push(surface.normals[i][j]);
            u.push(i / surface.longitudinalSegments);
        }
        addPolylineStrip(out, points, normals, u, width, material);
    }
}

function addTransverseFilaments(surface, stride, width, material, out) {
    for (let i = stride; i < surface.longitudinalSegments; i += stride) {
        const points = [], normals = [], u = [];
        for (let j = 0; j <= surface.transverseSegments; ++j) {
            points.push(surface.vertices[i][j]);
            normals.push(surface.normals[i][j]);
            u.push(i / surface.longitudinalSegments);
        }
        addPolylineStrip(out, points, normals, u, width, material);
    }
}

function addSurfaceGlints(surface, count, material, out, seed) {
    // Small irregular triangular facets, distributed deterministically over the surface.
    let state = seed >>> 0;
    const random = () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 4294967296;
    };
    for (let k = 0; k < count; ++k) {
        const i = 1 + Math.floor(random() * (surface.longitudinalSegments - 1));
        const j = 1 + Math.floor(random() * (surface.transverseSegments - 1));
        const p = surface.vertices[i][j], n = surface.normals[i][j];
        const tangent = surface.vertices[i + 1][j].minus(surface.vertices[i - 1][j]).normalized();
        const across = surface.vertices[i][j + 1].minus(surface.vertices[i][j - 1]).normalized();
        const size = 0.008 + 0.027 * random();
        const a = p.plus(tangent.times(size));
        const b = p.minus(tangent.times(size * 0.58)).plus(across.times(size * 0.72));
        const c = p.minus(tangent.times(size * 0.58)).minus(across.times(size * 0.72));
        const u = i / surface.longitudinalSegments;
        addTriangle(out, [a, b, c], [n, n, n],
            [Vec.of(u, 0.5), Vec.of(u, 0.5), Vec.of(u, 0.5)], material);
    }
}

function makeProceduralWispMedium() {
    // A compact procedural voxel field. VoxelGrid.fromDense sparsifies it into 8^3 bricks,
    // the same representation used for the renderer's OpenVDB-derived grids and GPU 3D texture.
    const dims = [144, 48, 48];
    const bounds = { min: [-9.5, -4.0, -5.5], max: [9.5, 4.0, 5.5] };
    const codes = new Uint8Array(dims[0] * dims[1] * dims[2]);
    const [nx, ny, nz] = dims;

    for (let z = 0; z < nz; ++z) {
        const pz = bounds.min[2] + (z + 0.5) / nz * (bounds.max[2] - bounds.min[2]);
        for (let y = 0; y < ny; ++y) {
            const py = bounds.min[1] + (y + 0.5) / ny * (bounds.max[1] - bounds.min[1]);
            for (let x = 0; x < nx; ++x) {
                const px = bounds.min[0] + (x + 0.5) / nx * (bounds.max[0] - bounds.min[0]);
                const t = (px - bounds.min[0]) / (bounds.max[0] - bounds.min[0]);

                const cy = 0.12 + 0.72 * Math.sin(2 * Math.PI * 0.94 * t)
                    + 0.24 * Math.sin(2 * Math.PI * 2.55 * t + 0.4);
                const cz = -1.15 + 1.20 * Math.sin(2 * Math.PI * 0.79 * t - 0.52)
                    + 0.28 * Math.sin(2 * Math.PI * 2.17 * t + 0.2);
                const dy = py - cy, dz = pz - cz;
                const broad = Math.exp(-0.5 * ((dy / 0.78) ** 2 + (dz / 1.05) ** 2));

                const cy2 = cy + 0.48 * Math.sin(2 * Math.PI * 1.8 * t + 1.1);
                const cz2 = cz + 0.65 * Math.cos(2 * Math.PI * 1.35 * t - 0.4);
                const fine = Math.exp(-0.5 * (((py - cy2) / 0.23) ** 2 + ((pz - cz2) / 0.34) ** 2));
                const modulation = 0.48 + 0.24 * Math.sin(2 * Math.PI * (7.0 * t + 0.21 * py))
                    + 0.18 * Math.sin(2 * Math.PI * (11.0 * t - 0.17 * pz));
                let density = Math.max(0, Math.min(1, broad * modulation + fine * 0.28));
                if (density < 0.025)
                    density = 0;
                // VoxelGrid decodes a byte as max * (byte / 255)^2.
                codes[(z * ny + y) * nx + x] = Math.round(255 * Math.sqrt(density));
            }
        }
    }

    const grid = VoxelGrid.fromDense({ dims, bounds, max: 1 }, codes);
    return new GridMedium(grid, {
        density: 0.38,
        albedo: Vec.of(0.34, 0.53, 0.92),
        g: 0.42
    });
}

function makeSdfAccent() {
    // A small Menger-like subtractive SDF. This is intentionally one object, not thousands
    // of analytic primitives; the SDF adapter generates its distance function for the GPU.
    const scale = 3;
    const cross = new UnionSDF(
        new BoxSDF(Vec.of(Infinity, 1 / scale, 1 / scale), Vec.of(0.12, 0.38, 0.68)),
        new BoxSDF(Vec.of(1 / scale, Infinity, 1 / scale), Vec.of(0.12, 0.38, 0.68)),
        new BoxSDF(Vec.of(1 / scale, 1 / scale, Infinity), Vec.of(0.12, 0.38, 0.68))
    );
    const holes = new RecursiveTransformUnionSDF(
        cross,
        new SDFTransformerSequence(
            new SDFMatrixTransformer(Mat4.scale(1 / scale)),
            new SDFInfiniteRepetitionTransformer(Vec.of(2, 2, 2))
        ),
        4
    );
    return new SDFGeometry(new DifferenceSDF(new BoxSDF(1), holes), 240, 0.00003, 80);
}

function addBackgroundGrid(out, material) {
    const z = -5.7;
    for (let y = -3.6; y <= 3.61; y += 0.6) {
        const points = [Vec.of(-10.5, y, z), Vec.of(10.5, y, z)];
        addPolylineStrip(out, points, null, null, 0.0025, material);
    }
    for (let x = -10.0; x <= 10.01; x += 0.8) {
        const points = [Vec.of(x, -4.0, z), Vec.of(x, 4.0, z)];
        addPolylineStrip(out, points, null, null, 0.0025, material);
    }
}

function addWireSphere(out, center, radius, material) {
    const point = (lat, lon) => Vec.of(
        center[0] + radius * Math.cos(lat) * Math.cos(lon),
        center[1] + radius * Math.sin(lat),
        center[2] + radius * Math.cos(lat) * Math.sin(lon)
    );
    const addCurve = points => {
        const normals = points.map(p => p.minus(center).normalized());
        addPolylineStrip(out, points, normals, null, 0.0065, material);
    };
    for (const lat of [-1.08, -0.72, -0.36, 0, 0.36, 0.72, 1.08]) {
        const points = [];
        for (let i = 0; i <= 96; ++i)
            points.push(point(lat, 2 * Math.PI * i / 96));
        addCurve(points);
    }
    for (const lon of [0, Math.PI / 5, 2 * Math.PI / 5, 3 * Math.PI / 5, 4 * Math.PI / 5]) {
        const points = [];
        for (let i = 0; i <= 64; ++i)
            points.push(point(-Math.PI / 2 + Math.PI * i / 64, lon));
        addCurve(points);
    }
}

function addWireCube(out, center, size, material) {
    const h = size / 2;
    const corners = [];
    for (const z of [-h, h])
        for (const y of [-h, h])
            for (const x of [-h, h])
                corners.push(Vec.of(center[0] + x, center[1] + y, center[2] + z));
    const index = (x, y, z) => z * 4 + y * 2 + x;
    const line = (a, b) => addPolylineStrip(out, [a, b], null, null, 0.009, material);
    for (let z = 0; z < 2; ++z)
        for (let y = 0; y < 2; ++y)
            line(corners[index(0, y, z)], corners[index(1, y, z)]);
    for (let z = 0; z < 2; ++z)
        for (let x = 0; x < 2; ++x)
            line(corners[index(x, 0, z)], corners[index(x, 1, z)]);
    for (let y = 0; y < 2; ++y)
        for (let x = 0; x < 2; ++x)
            line(corners[index(x, y, 0)], corners[index(x, y, 1)]);

    // A few internal diagonals make it read as a technical construction, not a literal box.
    line(corners[index(0, 0, 0)], corners[index(1, 1, 1)]);
    line(corners[index(1, 0, 0)], corners[index(0, 1, 1)]);
    line(corners[index(0, 1, 0)], corners[index(1, 0, 1)]);
    line(corners[index(1, 1, 0)], corners[index(0, 0, 1)]);
}

function addBackgroundParticles(out, material) {
    let state = 0x4d595df4;
    const random = () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 4294967296;
    };
    for (let i = 0; i < 680; ++i) {
        const x = -10 + 20 * random();
        const y = -3.8 + 7.6 * random();
        const z = -5.35 + 0.12 * random();
        const s = 0.004 + 0.018 * random();
        const p = Vec.of(x, y, z);
        const n = Vec.of(0, 0, 1);
        const a = p.plus(Vec.of(s, 0, 0));
        const b = p.plus(Vec.of(-s * 0.7, s * 0.65, 0));
        const c = p.plus(Vec.of(-s * 0.7, -s * 0.65, 0));
        addTriangle(out, [a, b, c], [n, n, n],
            [Vec.of(0.5, 0.5), Vec.of(0.5, 0.5), Vec.of(0.5, 0.5)], material);
    }
}

export function configureTest(callback) {
    const width = 1200, height = 480;
    const camera = new PerspectiveCamera(
        0.37,
        width / height,
        Mat4.translation([0, 1.0, 24]).times(Mat4.rotation(-0.045, Vec.of(1, 0, 0)))
    );

    const gradient = makeRibbonGradient();
    const ribbonMaterial = new PrincipledMaterial({
        baseColor: gradient,
        metallic: 0.22,
        roughness: 0.24,
        ior: 1.46,
        emission: new ScaledMaterialColor(gradient, 0.055),
        emissionStrength: 1.0
    });
    const filamentMaterial = new PrincipledMaterial({
        baseColor: gradient,
        metallic: 0.12,
        roughness: 0.28,
        emission: new ScaledMaterialColor(gradient, 0.14),
        emissionStrength: 1.0
    });
    const secondaryMaterial = new PrincipledMaterial({
        baseColor: gradient,
        metallic: 0.28,
        roughness: 0.31,
        emission: new ScaledMaterialColor(gradient, 0.025),
        emissionStrength: 1.0
    });

    const triangles = [];
    const main = makeRibbonSurface({
        longitudinalSegments: 192,
        transverseSegments: 44,
        phase: 0.0,
        widthScale: 0.92,
        depthOffset: -0.15,
        waveScale: 1.0,
        twistTurns: 1.05
    }, ribbonMaterial, triangles);
    const second = makeRibbonSurface({
        longitudinalSegments: 168,
        transverseSegments: 28,
        phase: 1.65,
        widthScale: 0.55,
        depthOffset: -1.55,
        waveScale: 0.77,
        twistTurns: -0.72,
        yOffset: 0.22
    }, secondaryMaterial, triangles);
    const third = makeRibbonSurface({
        longitudinalSegments: 176,
        transverseSegments: 20,
        phase: -1.15,
        widthScale: 0.34,
        depthOffset: 1.45,
        waveScale: 0.62,
        twistTurns: 0.58,
        yOffset: -0.18
    }, secondaryMaterial, triangles);

    // Fine surface filigree: a mix of long contour strands and transverse topology lines.
    addLongitudinalFilaments(main, Array.from({ length: 28 }, (_, i) => 2 + Math.round(i * (main.transverseSegments - 4) / 27)), 0.0048, filamentMaterial, triangles);
    addTransverseFilaments(main, 3, 0.0038, filamentMaterial, triangles);
    addLongitudinalFilaments(second, Array.from({ length: 20 }, (_, i) => 1 + Math.round(i * (second.transverseSegments - 2) / 19)), 0.0040, filamentMaterial, triangles);
    addTransverseFilaments(second, 3, 0.0032, secondaryMaterial, triangles);
    addLongitudinalFilaments(third, Array.from({ length: 14 }, (_, i) => 1 + Math.round(i * (third.transverseSegments - 2) / 13)), 0.0035, secondaryMaterial, triangles);
    addTransverseFilaments(third, 3, 0.0028, secondaryMaterial, triangles);

    // Glints break up the smooth surfaces with tiny facets, still as ordinary triangles.
    addSurfaceGlints(main, 1350, filamentMaterial, triangles, 0x13579bdf);
    addSurfaceGlints(second, 520, secondaryMaterial, triangles, 0x2468ace0);

    // Technical linework is also triangle-only: no cylinder instances anywhere in the scene.
    const blueLine = new PrincipledMaterial({
        baseColor: Vec.of(0.055, 0.26, 0.72), metallic: 0.28, roughness: 0.3,
        emission: Vec.of(0.025, 0.16, 0.48), emissionStrength: 0.75
    });
    const dimLine = new PrincipledMaterial({
        baseColor: Vec.of(0.018, 0.055, 0.16), metallic: 0.15, roughness: 0.42,
        emission: Vec.of(0.008, 0.035, 0.11), emissionStrength: 0.8
    });
    const goldLine = new PrincipledMaterial({
        baseColor: Vec.of(0.72, 0.34, 0.075), metallic: 0.35, roughness: 0.34,
        emission: Vec.of(0.30, 0.095, 0.018), emissionStrength: 0.65
    });

    addBackgroundGrid(triangles, dimLine);
    addWireSphere(triangles, Vec.of(-7.55, 1.05, -3.25), 1.08, blueLine);
    addWireCube(triangles, Vec.of(7.35, -0.30, -3.4), 2.05, blueLine);

    // A logarithmic-looking construction spiral and a sparse set of radial ticks.
    const spiralCenter = Vec.of(-7.6, -1.8, -3.15);
    const spiral = [];
    for (let i = 0; i <= 180; ++i) {
        const t = i / 180;
        const a = -0.75 * Math.PI + 2.25 * Math.PI * t;
        const r = 0.10 + 1.18 * t;
        spiral.push(Vec.of(spiralCenter[0] + r * Math.cos(a), spiralCenter[1] + 0.68 * r * Math.sin(a), spiralCenter[2]));
    }
    addPolylineStrip(triangles, spiral, null, null, 0.006, goldLine);
    for (let i = 0; i <= 10; ++i) {
        const a = -0.7 * Math.PI + 1.7 * Math.PI * i / 10;
        const p = Vec.of(spiralCenter[0] + 1.25 * Math.cos(a), spiralCenter[1] + 0.72 * Math.sin(a), spiralCenter[2]);
        const q = Vec.of(spiralCenter[0] + 1.40 * Math.cos(a), spiralCenter[1] + 0.82 * Math.sin(a), spiralCenter[2]);
        addPolylineStrip(triangles, [p, q], null, null, 0.0045, dimLine);
    }
    addBackgroundParticles(triangles, dimLine);

    // All high-count surface/detail geometry is packed into this one triangle BVH.
    const mesh = BVHAggregate.build(triangles, Mat4.identity(), Infinity, 8);

    const objects = [
        mesh,
        new Primitive(
            makeSdfAccent(),
            new PrincipledMaterial({
                baseColor: Vec.of(0.035, 0.16, 0.34), metallic: 0.5, roughness: 0.28,
                emission: Vec.of(0.012, 0.075, 0.22), emissionStrength: 0.55
            }),
            Mat4.translation([7.45, 1.45, -4.4]).times(Mat4.scale(0.72))
        ),
        new Volume(makeProceduralWispMedium(), Mat4.identity())
    ];

    const lights = [
        new RandomSampleAreaLight(
            new Square(),
            Mat4.translation([-1.8, 6.5, 3.0])
                .times(Mat4.rotation(Math.PI / 2, Vec.of(1, 0, 0)))
                .times(Mat4.scale([5.5, 2.4, 1])),
            Vec.of(0.36, 0.62, 1.0), 1450, 8
        ),
        new RandomSampleAreaLight(
            new Square(),
            Mat4.translation([5.4, 3.1, 1.6])
                .times(Mat4.rotation(Math.PI / 2, Vec.of(1, 0, 0)))
                .times(Mat4.rotation(0.22, Vec.of(0, 0, 1)))
                .times(Mat4.scale([3.2, 1.8, 1])),
            Vec.of(1.0, 0.30, 0.10), 760, 8
        ),
        new SimplePointLight(Vec.of(-5.8, 1.2, 5.0, 1), Vec.of(0.12, 0.35, 1.0), 260)
    ];

    const world = new World(objects, lights, Vec.of(0.0025, 0.004, 0.014));
    callback({
        renderer: new IncrementalMultisamplingRenderer(
            world, camera, 32, 6, "auto", { exposure: -0.25, toneMap: "aces" }
        ),
        width,
        height
    });
}
