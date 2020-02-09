class SimpleRenderer {
    constructor(scene, camera, maxRecursionDepth=1) {
        this.scene = scene;
        this.camera = camera;
        this.maxRecursionDepth = maxRecursionDepth;
    }
    render(img, timelimit=0, callback=false, x_offset = 0, x_delt = 1) {
        const img_width = img.width(),
            img_height = img.height(),
            pixel_width = 1 / img_width,
            pixel_height = 1 / img_height;
        
        let timeCounter = 0,
            lastTime = Date.now();

        
        for (let px = x_offset; px < img_width; px += x_delt) {
            let x = 2 * (px / img_width) - 1;
            for (let py = 0; py < img_height; ++py) {
                
                let y = -2 * (py / img_height) + 1;
                img.setColor(px, py, this.colorPixel(x, y, pixel_width, pixel_height));

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
    colorPixel(x, y, pixel_width, pixel_height) {
        return this.scene.color(this.camera.getRayForPixel(x, y), this.maxRecursionDepth);
    }
}

// TODO add GridMultisamplingRenderer(scene, maxRecursionDepth, samplesPerPixel)
// TODO add RandomMultisamplingRenderer(scene, maxRecursionDepth, samplesPerPixel)