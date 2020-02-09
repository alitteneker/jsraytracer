class PixelBuffer {
    constructor(width, height) {
        if (width instanceof ImageData)
            this.imgdata = width; // passed in existing imagedata
        else {
            this.imgdata = new ImageData(width, height);
        }
    }
    static fromImage(img) {
        let cnv = new OffscreenCanvas("canvas");
        let ctx = cnv.getContext("2d"); // NB: this only works in Chrome!
        cnv.width = img.width;
        cnv.height = img.height;
        ctx.drawImage(img, 0, 0);
        return new PixelBuffer(ctx.getImageData(0, 0, cnv.width, cnv.height));
    }
    static loadImageFromPath(path) {
        return new Promise(function loadImagePromise(resolve, reject) {
            let img = new Image();
            img.src = url;
            img.onload = function() {
                resolve(PixelBuffer.fromImage(img));
            };
        });
    }
    width() {
        return this.imgdata.width;
    }
    height() {
        return this.imgdata.height;
    }
    coord(x, y) {
        return y * (this.imgdata.width * 4) + x * 4;
    }
    getColor(x, y) {
        const r = this.coord(x, y);
        return Color.from([0, 1, 2, 3].map(i => this.imgdata[r + i] / 255));
    }
    setColor(x, y, color) {
        const r = this.coord(x, y);
        for (let i = 0; i < 4; ++i) {
            let comp = (color.length <= i) ? 1 : color[i];
            this.imgdata.data[r + i] = Math.round(255 * Math.min(Math.max(comp, 0), 1));
        }
    }
}
