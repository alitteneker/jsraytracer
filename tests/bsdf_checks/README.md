# BSDF checks

Node scripts that test the CPU BSDFs, integrators, lights and media (`src/bsdf.js`, `src/integrators.js`,
`src/lights.js`, `src/media.js`). Run from the repository root. See [Materials.md](../../Materials.md) for what each
check means.

| Script | Checks | Expect |
|---|---|---|
| `node tests/bsdf_checks/ggx_identities.js` | GGX normalization: projected area, and visible projected area | 1 and cos(theta) |
| `node tests/bsdf_checks/lobes.js` | Each lobe's sampling against its evaluation, and its pdf against its sampler | z within about +-2, pdf integral = success rate |
| `node tests/bsdf_checks/multiscatter.js` | A white metal plus the Kulla-Conty lobe reflects everything | about 1.00 |
| `node tests/bsdf_checks/furnace.js` | White furnace: white materials under a white sky disappear | about 1.00 |
| `node tests/bsdf_checks/mis.js` | Light sampling, BSDF sampling and MIS converge to the same image (add `plastic 8 24 directional` for a directional light) | |z| < 3 |
| `node tests/bsdf_checks/media.js` | Participating media: transmittance against quadrature, majorant bounds, white furnaces, and light, phase and MIS sampling agreeing | all ok |
| `node tests/bsdf_checks/normalmaps.js` | Normal maps: the tangent frame from UVs, mirrored UVs, mirroring and rotated objects | all ok |
| `node tests/bsdf_checks/placement.js` | Rays find objects and lights where the scene and light sampling put them, inside transformed groups too | all ok |
