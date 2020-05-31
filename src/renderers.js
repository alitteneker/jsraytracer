class SimpleRenderer {
    constructor(scene, camera, maxRecursionDepth=3) {
        this.scene = scene;
        this.camera = camera;
        this.maxRecursionDepth = maxRecursionDepth;
    }
    render(img, timelimit=0, callback=false, x_offset = 0, x_delt = 1) {
        const img_width = img.width(),
            img_height = img.height(),
            pixel_width = 2 / img_width,
            pixel_height = 2 / img_height;
        
        let timeCounter = 0,
            lastTime = Date.now();
        
        for (let px = x_offset; px < img_width; px += x_delt) {
            let x = 2 * (px / img_width) - 1;
            for (let py = 0; py < img_height; ++py) {
                
                let y = -2 * (py / img_height) + 1;
                img.setColor(px, py, this.getPixelColor(x, y, pixel_width, pixel_height));

                if (timelimit && callback) {
                    let currentTime = Date.now();
                    timeCounter += currentTime - lastTime;
                    lastTime = currentTime;
                    if (timeCounter >= timelimit) {
                        timeCounter = 0;
                        callback();
                    }
                }
            }
        }
        return img;
    }
    getPixelColor(x, y, pixel_width, pixel_height) {
        return this.scene.color(this.camera.getRayForPixel(x, y), this.maxRecursionDepth);
    }
}

class RandomMultisamplingRenderer extends SimpleRenderer {
    constructor(scene, camera, samplesPerPixel, maxRecursionDepth=3) {
        super(scene, camera, maxRecursionDepth);
        this.samplesPerPixel = samplesPerPixel;
    }
    getPixelColor(x, y, pixel_width, pixel_height) {
        let color = Vec.of(0, 0, 0);
        for (let i = 0; i < this.samplesPerPixel; ++i) {
            color = color.plus(this.scene.color(
                this.camera.getRayForPixel(
                    x + pixel_width  * (Math.random() - 0.5),
                    y + pixel_height * (Math.random() - 0.5)),
                this.maxRecursionDepth).times(1 / this.samplesPerPixel));
        }
        return color;
    }
}

class IncrementalMultisamplingRenderer extends SimpleRenderer {
    constructor(scene, camera, samplesPerPixel, maxRecursionDepth=3) {
        super(scene, camera, maxRecursionDepth);
        this.samplesPerPixel = samplesPerPixel;
    }
    render(img, timelimit=0, callback=false, x_offset = 0, x_delt = 1) {
        const img_width = img.width(),
            img_height = img.height(),
            pixel_width = 2 / img_width,
            pixel_height = 2 / img_height;
        
        let timeCounter = 0,
            lastTime = Date.now();
        
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
                        let currentTime = Date.now();
                        timeCounter += currentTime - lastTime;
                        lastTime = currentTime;
                        if (timeCounter >= timelimit) {
                            timeCounter = 0;
                            callback();
                        }
                    }
                }
            }
        }
        return img;
    }
}
