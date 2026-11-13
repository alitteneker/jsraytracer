# BSDF checks

Node scripts that test the CPU BSDFs and integrators (`src/bsdf.js`, `src/integrators.js`). Run from the repository
root. See [Materials.md](../../Materials.md) for what each check means.

| Script | Checks | Expect |
|---|---|---|
| `node tests/bsdf_checks/ggx_identities.js` | GGX normalization: projected area, and visible projected area | 1 and cos(theta) |
| `node tests/bsdf_checks/lobes.js` | Each lobe's sampling against its evaluation, and its pdf against its sampler | z within about +-2, pdf integral = success rate |
| `node tests/bsdf_checks/multiscatter.js` | A white metal plus the Kulla-Conty lobe reflects everything | about 1.00 |
| `node tests/bsdf_checks/furnace.js` | White furnace: white materials under a white sky disappear | about 1.00 |
| `node tests/bsdf_checks/mis.js` | Light sampling, BSDF sampling and MIS converge to the same image | |z| < 3 |
