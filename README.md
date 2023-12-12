# JSRaytracer
JSRaytracer is a lightweight ray/path tracing javascript library that runs
in your browser. To learn more about what it can do, continue reading, or try
out the [CPU](https://alitteneker.github.io/jsraytracer/) or
[GPU demos](https://alitteneker.github.io/jsraytracer/gl)!

## Features
The core of the JSRaytracer library is a set of pure JS classes that allow for
complex scenes to be modeled by combining instances of a variety of types of
geometries, materials, and lights into a scene graph, with each class designed
following modular design principles that allow for further extensibility beyond
what is currently supported.

Once a scene graph is constructed, the scene can be rendered in one of two
modes:
1. GPU parallelization by constructing a GLSL shader usable in a WebGL2
context, capable of rendering each pass (a single sample of each pixel) of most
scenes at a minimum of 30-60FPS, allowing for real-time rendering.
Additionally, the web interface wrapped around this mode supports real time
modifications of many scene properties, including transformations and materials.
2. CPU multi-threading with web workers, allowing for each pass of most scenes
to be processed in ~1 minute or less. While slower, this rendering mode allows
much easier debugging and analysis.

The following is an incomplete list of features currently supported by both
rendering modes:
* Various geometry types including triangles, spheres, cylinders, and more
* Geometry can also be modeled as a signed distance field (SDF), constructed
from simple functional operators assembled into a tree, and intersected with
ray marching
* Incremental per-pixel multisampling
* Point and area light sources
* Camera depth of field
* Bounding Volume Hierarchy (BVH) ray-geometry intersection acceleration
* OBJ, MTL, and texture file loading
* Phong shading with reflection, refraction, and surface transmission
* Path tracing following an approximated Phong BXDF


While this project is not currently under active development, there are a few
items on the TODO list.
* Solid angle sampling for area lights
* Disney principled BXDF for better materials
* Ray bundling for acceleration of batch intersection tests
* Adaptive multisampling to improve efficiency for incremental rendering

## License
This software is released under an MIT license. See License.txt for more details.