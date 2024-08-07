class SimpleRenderer {
    constructor(world, camera, maxRecursionDepth=3) {
        this.world = world;
        this.camera = camera;
        this.maxRecursionDepth = maxRecursionDepth;
    }
    static computePixelCount(img, x_offset, x_delt) {
        return ((img.width() / x_delt) + Math.round(1 - x_offset/x_delt) * (img.width() % x_delt)) * img.height();
    }
    render(img, timelimit=0, callback=false, x_offset = 0, x_delt = 1) {
        const img_width = img.width(),
            img_height = img.height(),
            pixel_width = 2 / img_width,
            pixel_height = 2 / img_height,
            total_pixels = SimpleRenderer.computePixelCount(img, x_offset, x_delt);
        
        let timeCounter = 0,
            lastTime = Date.now(),
            pixel_count = 0;
        
        for (let px = x_offset; px < img_width; px += x_delt) {
            let x = 2 * (px / img_width) - 1;
            for (let py = 0; py < img_height; ++py) {
                
                let y = -2 * (py / img_height) + 1;
                img.setColor(px, py, this.getPixelColor(x, y, pixel_width, pixel_height));

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
        return this.world.color(this.camera.getRayForPixel(x, y), this.maxRecursionDepth);
    }
}

class RandomMultisamplingRenderer extends SimpleRenderer {
    constructor(world, camera, samplesPerPixel, maxRecursionDepth=3) {
        super(world, camera, maxRecursionDepth);
        this.samplesPerPixel = samplesPerPixel;
    }
    getPixelColor(x, y, pixel_width, pixel_height) {
        let color = Vec.of(0, 0, 0);
        for (let i = 0; i < this.samplesPerPixel; ++i) {
            color = color.plus(this.world.color(
                this.camera.getRayForPixel(
                    x + pixel_width  * (Math.random() - 0.5),
                    y + pixel_height * (Math.random() - 0.5)),
                this.maxRecursionDepth).times(1 / this.samplesPerPixel));
        }
        return color;
    }
}

class IncrementalMultisamplingRenderer extends SimpleRenderer {
    constructor(world, camera, samplesPerPixel, maxRecursionDepth=3) {
        super(world, camera, maxRecursionDepth);
        this.samplesPerPixel = samplesPerPixel;
    }
    render(img, timelimit=0, callback=false, x_offset = 0, x_delt = 1) {
        const img_width = img.width(),
            img_height = img.height(),
            pixel_width = 2 / img_width,
            pixel_height = 2 / img_height,
            total_samples = SimpleRenderer.computePixelCount(img, x_offset, x_delt) * this.samplesPerPixel;
        
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
                    let color = img.setColor(px, py, buffer[px][py].times(1/(iter + 1)));
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
