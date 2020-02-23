# JSRaytracer
JSRaytracer is a multi-threaded CPU raytracer written in javascript that runs
in your browser. To learn more about what it can do, continue reading, or try
out the [online demo|https://alitteneker.github.io/jsraytracer/]!

## Features
JSRaytracer supports a variety of material, camera, and lighting models,
and is constructed following modular design principles that allow for further
extensibility beyond what is currently supported.

The following is an incomplete list of currently supported features:
* Multi-threading with web workers
* Phong shading with reflection and refraction
* Point and area light sources
* Camera depth of field
* Bounding Volume Hierarchy (BVH) ray-geometry intersection acceleration
* OBJ, MTL, and texture file loading
* Path tracing following the Phong PDF

While this project is not currently under active development, there are a few
items on the TODO list.
* Solid angle sampling for polygonal area lights
* Ray bundling for batch intersection tests
* Adaptive multisampling to improve efficiency

## License
This software is released under an MIT license. See License.txt for more details.