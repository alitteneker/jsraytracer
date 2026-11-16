// How a renderer turns radiance into displayed pixels: its film, or sensor, and the processing after it. Each scene
// sets its own, the way a photographer picks a sensitivity for the light they have.
//   exposure: in stops. Radiance is scaled by 2^exposure before the tone curve, so +1 doubles the brightness.
//   toneMap:  the curve that brings any radiance into the range a display can show:
//     "neutral"  Khronos PBR Neutral (the default). Colors up to about 0.8 pass through almost unchanged, so base
//                colors look as chosen; brighter ones roll off toward white instead of clipping.
//     "aces"     Narkowicz's fit of the ACES filmic curve: more contrast, and bright saturated colors desaturate.
//     "reinhard" x / (1 + x) per channel: never clips, but flattens everything.
//     "clip"     no curve: anything over 1 is clipped.
// The result is then encoded as sRGB, which is what displays expect. The GPU does the same in renderer.glsl
// (display.fragment), so both pages show a scene alike.
class Film {
    static TONE_MAPS = ["neutral", "aces", "reinhard", "clip"];
    constructor({ exposure = 0, toneMap = "neutral" } = {}) {
        if (!Film.TONE_MAPS.includes(toneMap))
            throw `Unknown tone map "${toneMap}": use one of ${Film.TONE_MAPS.join(", ")}`;
        this.exposure = exposure;
        this.toneMap = toneMap;
    }
    static coerce(film) {
        return (film instanceof Film) ? film : new Film(film || {});
    }
    static deserialize(data) {
        return new Film(data);
    }
    static toneMapRGB(name, c) {
        if (name == "aces")
            return c.map(x => (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
        if (name == "reinhard")
            return c.map(x => x / (1 + x));
        if (name == "neutral") {
            const startCompression = 0.8 - 0.04, desaturation = 0.15;
            const x = Math.min(...c), offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
            c = c.map(v => v - offset);
            const peak = Math.max(...c);
            if (peak < startCompression)
                return c;
            const d = 1 - startCompression, newPeak = 1 - d * d / (peak + d - startCompression);
            const g = 1 - 1 / (desaturation * (peak - newPeak) + 1);
            return c.map(v => (v * newPeak / peak) * (1 - g) + newPeak * g);
        }
        return c;
    }
    static encodeSRGB(x) {
        x = Math.min(Math.max(x, 0), 1);
        return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    }
    // Radiance (with an optional alpha, kept as is) to display values in [0, 1].
    display(color) {
        const scale = Math.pow(2, this.exposure);
        const rgb = Film.toneMapRGB(this.toneMap, [color[0] * scale, color[1] * scale, color[2] * scale]);
        return Vec.of(...rgb.map(Film.encodeSRGB), color.length > 3 ? color[3] : 1);
    }
}

class SimpleRenderer {
    // integrator: "whitted", "path", or "auto" (path tracing if any material asks for it; see Integrator.create).
    // film: a Film, or the settings for one ({ exposure, toneMap }).
    constructor(world, camera, maxRecursionDepth=3, integrator="auto", film={}) {
        this.world = world;
        this.camera = camera;
        this.maxRecursionDepth = maxRecursionDepth;
        this.integrator = integrator;
        this.film = Film.coerce(film);
    }
    // Scenes serialized before renderers had a film get the default one.
    getFilm() {
        return Film.coerce(this.film);
    }
    getIntegrator() {
        // Created on first use and kept off the serialized object (scenes are serialized with their renderer).
        if (!this._integrator || this._integratorName !== this.integrator) {
            Object.defineProperty(this, "_integrator", { value: Integrator.create(this.integrator || "auto", this.world), writable: true, configurable: true, enumerable: false });
            Object.defineProperty(this, "_integratorName", { value: this.integrator, writable: true, configurable: true, enumerable: false });
        }
        return this._integrator;
    }
    radiance(ray) {
        return this.getIntegrator().radiance(ray, this.maxRecursionDepth);
    }
    static computePixelCount(img, x_offset, x_delt) {
        return ((img.width() / x_delt) + Math.round(1 - x_offset/x_delt) * (img.width() % x_delt)) * img.height();
    }
    render(img, timelimit=0, callback=false, x_offset = 0, x_delt = 1) {
        const img_width = img.width(),
            img_height = img.height(),
            pixel_width = 2 / img_width,
            pixel_height = 2 / img_height,
            total_pixels = SimpleRenderer.computePixelCount(img, x_offset, x_delt),
            film = this.getFilm();
        
        let timeCounter = 0,
            lastTime = Date.now(),
            pixel_count = 0;
        
        for (let px = x_offset; px < img_width; px += x_delt) {
            let x = 2 * (px / img_width) - 1;
            for (let py = 0; py < img_height; ++py) {
                
                let y = -2 * (py / img_height) + 1;
                img.setColor(px, py, film.display(this.getPixelColor(x, y, pixel_width, pixel_height)));

                if (timelimit && callback) {
                    ++pixel_count;
                    let currentTime = Date.now();
                    timeCounter += currentTime - lastTime;
                    lastTime = currentTime;
                    if (timeCounter >= timelimit) {
                        timeCounter = 0;
                        callback({ pass: 0, completion: pixel_count / total_pixels });
                    }
                }
            }
        }
        return img;
    }
    getPixelColor(x, y, pixel_width, pixel_height) {
        return this.radiance(this.camera.getRayForPixel(x, y));
    }
}

class RandomMultisamplingRenderer extends SimpleRenderer {
    constructor(world, camera, samplesPerPixel, maxRecursionDepth=3, integrator="auto", film={}) {
        super(world, camera, maxRecursionDepth, integrator, film);
        this.samplesPerPixel = samplesPerPixel;
    }
    getPixelColor(x, y, pixel_width, pixel_height) {
        let color = Vec.of(0, 0, 0);
        for (let i = 0; i < this.samplesPerPixel; ++i) {
            color = color.plus(this.radiance(
                this.camera.getRayForPixel(
                    x + pixel_width  * (Math.random() - 0.5),
                    y + pixel_height * (Math.random() - 0.5))).times(1 / this.samplesPerPixel));
        }
        return color;
    }
}

class IncrementalMultisamplingRenderer extends SimpleRenderer {
    constructor(world, camera, samplesPerPixel, maxRecursionDepth=3, integrator="auto", film={}) {
        super(world, camera, maxRecursionDepth, integrator, film);
        this.samplesPerPixel = samplesPerPixel;
    }
    render(img, timelimit=0, callback=false, x_offset = 0, x_delt = 1) {
        const img_width = img.width(),
            img_height = img.height(),
            pixel_width = 2 / img_width,
            pixel_height = 2 / img_height,
            total_samples = SimpleRenderer.computePixelCount(img, x_offset, x_delt) * this.samplesPerPixel,
            film = this.getFilm();
        
        let timeCounter = 0,
            lastTime = Date.now(),
            sample_count = 0;
        
        let buffer = Array(img_width)
        for (let i = 0; i < img_width; ++i) {
            buffer[i] = Array(img_height);
            for (let j = 0; j < img_height; ++j)
                buffer[i][j] = Vec.of(0, 0, 0);
        }
        for (let iter = 0; iter < this.samplesPerPixel; ++iter) {
            for (let px = x_offset; px < img_width; px += x_delt) {
                const x = 2 * (px / img_width) - 1;
                for (let py = 0; py < img_height; ++py) {

                    const y = -2 * (py / img_height) + 1;
                    buffer[px][py] = buffer[px][py].plus(
                        this.getPixelColor(
                            x + pixel_width  * (Math.random() - 0.5),
                            y + pixel_height * (Math.random() - 0.5),
                            pixel_width, pixel_height).to4(true));
                    let color = img.setColor(px, py, film.display(buffer[px][py].times(1/(iter + 1))));
//                     for (let i = 0; i < color.length; ++i)
//                         if (isNaN(color[i]))
//                             console.log("Found Invalid Color");

                    if (timelimit && callback) {
                        ++sample_count;
                        let currentTime = Date.now();
                        timeCounter += currentTime - lastTime;
                        lastTime = currentTime;
                        if (timeCounter >= timelimit) {
                            timeCounter = 0;
                            callback({ pass: iter, completion: sample_count / total_samples });
                        }
                    }
                }
            }
        }
        return img;
    }
}
