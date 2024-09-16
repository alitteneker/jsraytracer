Array.prototype.all = function(p = (x => x)) {
    for (let x of this)
        if (!p(x))
            return false;
    return true;
};
Array.prototype.any = function(p = (x => x)) {
    for (let x of this)
        if (p(x))
            return true;
    return false;
};

Math.fmod = function (a,b) { return Number((a - (Math.floor(a / b) * b)).toPrecision(8)); };
Math.range = function(start, stop, step = 1) {
    if (start !== undefined && stop === undefined) {
        stop = start;
        start = 0;
    }
    return new Array(Math.ceil((stop - start) / step)).fill(start).map((x, y) => x + y * step);
};
Math.sum = function(arr) {
    return arr.reduce((acc, x, i) => { return acc + x }, 0);
};
Math.average = function(arr) {
    return (arr.length > 0) ? (Math.sum(arr) / arr.length) : 0;
};

Math.isPowerOf2 = function(value) {
    return (value & (value - 1)) === 0;
};

Math.normalize = function(c, min, max) {
    return (c - min) / (max - min);
};
Math.clamp = function(a, min, max) {
    return Math.min(Math.max(a, min), max);
};

Math.indexOfMin = function(...args) {
    let min = Infinity, minIndex = -1;
    for (let i = 0; i < args.length; ++i)
        if (args[i] < min) {
            min = args[i];
            minIndex = i;
        }
    return minIndex;
};
Math.indexOfMax = function(...args) {
    let max = -Infinity, maxIndex = -1;
    for (let i = 0; i < args.length; ++i)
        if (args[i] > max) {
            max = args[i];
            maxIndex = i;
        }
    return maxIndex;
};

function componentToHex(c) {
    const hex = Math.round(Math.clamp(c, 0, 1) * 255).toString(16);
    return (hex.length == 1) ? ("0" + hex) : hex;
}

function rgbToHex([r, g, b]) {
    const minVal = Math.min(r, g, b, 0), maxVal = Math.max(r, g, b, 1);
    return "#" + componentToHex(Math.normalize(r, minVal, maxVal))
               + componentToHex(Math.normalize(g, minVal, maxVal))
               + componentToHex(Math.normalize(b, minVal, maxVal));
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? Vec.of(
        parseInt(result[1], 16) / 255,
        parseInt(result[2], 16) / 255,
        parseInt(result[3], 16) / 255
    ) : null;
}


// Code for QuickSelect/median
function swap(arr, i, j) {
    var tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
}

function defaultCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function quickSelectStep(arr, k, left=0, right=arr.length-1, compare=defaultCompare) {

    while (right > left) {
        if (right - left > 600) {
            var n = right - left + 1;
            var m = k - left + 1;
            var z = Math.log(n);
            var s = 0.5 * Math.exp(2 * z / 3);
            var sd = 0.5 * Math.sqrt(z * s * (n - s) / n) * (m - n / 2 < 0 ? -1 : 1);
            var newLeft = Math.max(left, Math.floor(k - m * s / n + sd));
            var newRight = Math.min(right, Math.floor(k + (n - m) * s / n + sd));
            quickSelectStep(arr, k, newLeft, newRight, compare);
        }

        var t = arr[k];
        var i = left;
        var j = right;

        swap(arr, left, k);
        if (compare(arr[right], t) > 0) swap(arr, left, right);

        while (i < j) {
            swap(arr, i, j);
            i++;
            j--;
            while (compare(arr[i], t) < 0) i++;
            while (compare(arr[j], t) > 0) j--;
        }

        if (compare(arr[left], t) === 0) swap(arr, left, j);
        else {
            j++;
            swap(arr, j, right);
        }

        if (j <= k) left = j + 1;
        if (k <= j) right = j - 1;
    }
}

function quickSelect(arr, k) {
    quickSelectStep(arr, k);
    return arr[k];
}

function median(arr) {
    if (arr.length == 0)
        return NaN;
    const len2 = Math.floor(arr.length / 2);
    if (arr.length % 2 == 1)
        return quickSelect(arr, len2);
    return (quickSelect(arr, len2) + quickSelect(arr, len2 + 1)) / 2;
}

// Much of this file was adapted from code written by Garett Ridge for tiny-graphics.js
class Vec extends Float32Array {
    serialize() {
        return Array.from(this);
    }
    static deserialize(data) {
        return Vec.from(data);
    }
    copy() {
        return Vec.from(this)
    }
    static axis(axis, dim, amt=1, default_val=0) {
        const ret = Vec.from(Array(dim).fill(default_val));
        ret[axis] = amt;
        return ret;
    }
    static circlePick() {
        const a = Math.random() * 2 * Math.PI,
              r = Math.sqrt(Math.random());
        return Vec.of(r * Math.cos(a), r * Math.sin(a));
    }
    static spherePick() {
        const theta = 2.0 * Math.PI * Math.random(),
            phi = Math.acos(2.0 * Math.random() - 1.0);
        const sin_phi = Math.sin(phi);
        return Vec.of(
            Math.cos(theta) *      sin_phi,
                              Math.cos(phi),
            Math.sin(theta) *      sin_phi);
    }
    static cartesianToSpherical(n) {
        return Vec.of(
            0.5 + Math.atan2(n[2], n[0]) / (2 * Math.PI),
            0.5 - Math.asin(n[1]) / Math.PI);
    }
    equals(b) {
        return (b && b.length) ? this.every((x, i) => x == b[i]) : this.every((x, i) => x == b);
    }
    plus(b) {
        return (b && b.length) ? this.map((x, i) => x + b[i]) : this.map((x, i) => x + b);
    }
    minus(b) {
        return (b && b.length) ? this.map((x, i) => x - b[i]) : this.map((x, i) => x - b);
    }
    mult_pairs(b) {
        return this.map((x, i) => x * b[i])
    }
    scale(s) {
        this.forEach((x, i, a) => a[i] *= s)
    }
    times(s) {
        return (s && s.length) ? this.map((x,i) => x * s[i]) : this.map(x => x * s);
    }
    divide(s) {
        return (s && s.length) ? this.map((x,i) => x / s[i]) : this.map(x => x / s);
    }
    inverse(nom = 1) {
        return Vec.from(this.map(x => nom / x));
    }
    static min(a,b) {
        return a.map((x, i) => Math.min(x, (b && b.length) ? b[i] : b));
    }
    static max(a,b) {
        return a.map((x, i) => Math.max(x, (b && b.length) ? b[i] : b));
    }
    abs() {
        return Vec.from(this.map(x => Math.abs(x)));
    }
    randomized(s) {
        return this.map(x => x + s * (Math.random() - .5))
    }
    static random(d, l=0, h=1) {
        return Vec.of(...Array(d).fill(0).map(x => l + (h - l) * Math.random()));
    }
    mix(b, s) {
        return this.map((x, i) => (1 - s) * x + s * b[i])
    }
    squarednorm() {
        return this.dot(this);
    }
    norm() {
        return Math.sqrt(this.dot(this))
    }
    normalized() {
        const norm = this.norm();
        return (norm > 0.00001) ? this.times(1 / norm) : this;
    }
    normalize() {
        const norm = this.norm();
        if (norm > 0.00001)
            this.scale(1 / this.norm())
    }
    // Optimized arithmetic unrolls loops for vectors of length <= 4.
    dot(b) {
        if (this.length == 3) return this[0] * b[0] + this[1] * b[1] + this[2] * b[2];
        if (this.length == 4) return this[0] * b[0] + this[1] * b[1] + this[2] * b[2] + this[3] * b[3];
        if (this.length > 4) return this.reduce((acc, x, i) => {
            return acc + x * b[i];
        }, 0);
        // Assume a minimum length of 2.
        return this[0] * b[0] + this[1] * b[1];
    }
    sum() {
        return this.reduce((acc, x, i) => { return acc + x }, 0);
    }
    average() {
        return this.length ? this.sum() / this.length : 0;
    }
    // For avoiding repeatedly typing Vec.of in lists.
    static cast(...args) {
        return args.map(x => Vec.from(x));
    }
    to3() {
        return Vec.of(this[0], this[1] || 0, this[2] || 0);
    }
    to4(isPoint=false) {
        return Vec.of(this[0], this[1] || 0, this[2] || 0, +isPoint);
    }
    cross(b) {
        return Vec.of(this[1] * b[2] - this[2] * b[1], this[2] * b[0] - this[0] * b[2], this[0] * b[1] - this[1] * b[0]);
    }
    to_string() {
        return "[vec " + this.join(", ") + "]"
    }
    toString() {
        return this.to_string();
    }
}


class Ray {
    constructor(origin, direction) {
        this.origin = origin;
        this.direction = direction;
    }
    getTransformed(m) {
        return new Ray(m.times(this.origin), m.times(this.direction));
    }
    getPoint(t) {
        return this.origin.plus(this.direction.times(t));
    }
}


class Mat extends Array {
    constructor(...args) {
        super(0);
        this.push(...args)
    }
    serialize() {
        return Array.from(this);
    }
    static deserialize(data) {
        return Mat.from_rows(...data);
    }
    static from_rows(...args) {
        return new Mat(...args.map(a => Array.from(a)))
    }
    static from_cols(...args) {
        const ret = new Mat();
        for (let i = 0; i < args[0].length; ++i)
            ret.push(new Array(args.length).fill(0));
        for (let i = 0; i < args.length; ++i)
            for (let j = 0; j < args[0].length; ++j)
                ret[j][i] = args[i][j];
        return ret;
    }
    set_identity(m, n) {
        this.length = 0;
        for (let i = 0; i < m; i++) {
            this.push(Array(n).fill(0));
            if (i < n) this[i][i] = 1;
        }
    }
    static identity(size) {
        let data = [];
        for (let i = 0; i < size; ++i) {
            let d = Array(size).fill(0);
            d[i] = 1;
            data.push(d);
        }
        return Mat.of.apply(Mat, data);
    }
    is_identity(epsilon=1E-6) {
        if ("_isIdentity" in this)
            return this._isIdentity;
        for (let i = 0; i < this.length; ++i) {
            for (let j = 0; j < this[i].length; ++j) {
                if (Math.abs(this[i][j] - (i == j ? 1 : 0)) > epsilon) {
                    this._isIdentity = false;
                    return false;
                }
            }
        }
        this._isIdentity = true;
        return true;
    }
    sub_block(start, end) {
        return Mat.from(this.slice(start[0], end[0]).map(r => r.slice(start[1], end[1])));
    }
    row(index) {
        return Vec.from(this[index]);
    }
    column(index) {
        return Vec.from(this.map((r) => r[index]));
    }
    set_col(index, vec) {
        delete this._isIdentity;
        for (let i = 0; i < this[index].length; ++i)
            this[i][index] = vec[i];
    }
    copy() {
        return Mat.from(this.map(r => Vec.of(...r)))
    }
    equals(b) {
        return this.every((r, i) => r.every((x, j) => x == b[i][j]))
    }
    plus(b) {
        return Mat.from(this.map((r, i) => r.map((x, j) => x + b[i][j])))
    }
    minus(b) {
        return Mat.from(this.map((r, i) => r.map((x, j) => x - b[i][j])))
    }
    transposed() {
        return Mat.from(this.map((r, i) => r.map((x, j) => this[j][i])))
    }
    times(b) {
        // Mat * scalar case.
        const len = b.length;
        if (typeof len === "undefined")
            return this.map(r => r.map(x => b * x));
        
        // Mat * Vec case.
        const len2 = b[0].length;
        if (typeof len2 === "undefined") {
            let result = new Vec(this.length);
            for (let r = 0; r < len; r++) result[r] = b.dot(this[r]);
            return result;
        }
        
        // Mat * Mat case.
        let result = Mat.from(new Array(this.length));
        for (let r = 0; r < this.length; r++) {
            result[r] = new Array(len2);
            for (let c = 0, sum = 0; c < len2; c++) {
                result[r][c] = 0;
                for (let r2 = 0; r2 < len; r2++)
                    result[r][c] += this[r][r2] * b[r2][c];
            }
        }
        return result;
    }
    pre_multiply(b) {
        delete this._isIdentity;
        const new_value = b.times(this);
        this.length = 0;
        this.push(...new_value);
        
        return this;
    }
    post_multiply(b) {
        delete this._isIdentity;
        const new_value = this.times(b);
        this.length = 0;
        this.push(...new_value);
        return this;
    }
    static flatten_2D_to_1D(M, transpose=false) {
        const rows = M.length,
              cols = rows && M[0].length,
              floats = new Float32Array(rows * cols);
        for (let i = 0; i < rows; i++)
            for (let j = 0; j < cols; j++) 
                floats[transpose ? (i + j * rows) : (i * cols + j)] = M[i][j];
        return floats;
    }
    static mat_flat(M, transpose=false) {
        return Mat.flatten_2D_to_1D(M, transpose);
    }
    static mats_flat(Ms, transpose=false) {
        let ret = [];
        for (let M of Ms)
            ret.push(... M.flat(transpose));
        return ret;
    }
    flat(transpose=false) {
        return Mat.mat_flat(this, transpose);
    }
    to_string() {
        return "[" + this.map((r, i) => "[" + r.join(", ") + "]").join(" ") + "]"
    }
}

class Mat2 extends Mat {
    static inverse(m) {
        const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];

        let ret = Mat.identity(2);
        ret[0][0] =  m[1][1] / det;
        ret[0][1] = -m[0][1] / det;
        ret[1][0] = -m[1][0] / det;
        ret[1][1] =  m[0][0] / det;
        return ret;
    }
}

class Mat3 extends Mat {
    static inverse(m) {
        const det = m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2]) -
             m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
             m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

        let ret = Mat.identity(3);
        ret[0][0] = (m[1][1] * m[2][2] - m[2][1] * m[1][2]) / det;
        ret[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det;
        ret[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det;
        ret[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det;
        ret[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det;
        ret[1][2] = (m[1][0] * m[0][2] - m[0][0] * m[1][2]) / det;
        ret[2][0] = (m[1][0] * m[2][1] - m[2][0] * m[1][1]) / det;
        ret[2][1] = (m[2][0] * m[0][1] - m[0][0] * m[2][1]) / det;
        ret[2][2] = (m[0][0] * m[1][1] - m[1][0] * m[0][1]) / det;

        return ret;
    }
}

// Generate special 4x4 matrices that are useful for graphics.
class Mat4 extends Mat {
    static identity() {
        return Mat.of([1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]);
    };
    // Requires a scalar (angle) and a 3x1 Vec (axis)
    static rotation(angle, axis) {
        let [x, y, z] = axis.normalized(), [c, s] = [Math.cos(angle), Math.sin(angle)], omc = 1.0 - c;
        return Mat.of(
            [x * x * omc + c,     x * y * omc - z * s, x * z * omc + y * s, 0],
            [x * y * omc + z * s, y * y * omc + c,     y * z * omc - x * s, 0],
            [x * z * omc - y * s, y * z * omc + x * s, z * z * omc + c,     0],
            [0, 0, 0, 1]);
    }
    static rotationX(angle) {
        const [c, s] = [Math.cos(angle), Math.sin(angle)];
        return Mat.of(
            [1, 0,  0, 0],
            [0, c, -s, 0],
            [0, s,  c, 0],
            [0, 0,  0, 1]);
    }
    static rotationY(angle) {
        const [c, s] = [Math.cos(angle), Math.sin(angle)];
        return Mat.of(
            [ c, 0, s, 0],
            [ 0, 1, 0, 0],
            [-s, 0, c, 0],
            [ 0, 0, 0, 1]);
    }
    static rotationZ(angle) {
        const [c, s] = [Math.cos(angle), Math.sin(angle)];
        return Mat.of(
            [c, -s, 0, 0],
            [s,  c, 0, 0],
            [0,  0, 1, 0],
            [0,  0, 0, 1]);
    }

    // Requires a 3x1 Vec or single scalar.
    static scale(s) {
        if (typeof s === "number")
            s = [s, s, s];
        return Mat.of([s[0], 0, 0, 0], [0, s[1], 0, 0], [0, 0, s[2], 0], [0, 0, 0, 1]);
    }
    // Requires a 3x1 Vec.
    static translation(t) {
        return Mat.of([1, 0, 0, t[0]], [0, 1, 0, t[1]], [0, 0, 1, t[2]], [0, 0, 0, 1]);
    }
    // Note:  look_at() assumes the result will be used for a camera and stores its result in inverse space.  You can also use
    // it to point the basis of any *object* towards anything but you must re-invert it first.  Each input must be 3x1 Vec.                         
    static look_at(eye, at, up) {
        let z = at.minus(eye).normalized(),
            x = z.cross(up).normalized(), // Compute vectors along the requested coordinate axes.
            y = x.cross(z).normalized(); // This is the "updated" and orthogonalized local y axis.
        if (!x.every(i => i == i)) // Check for NaN, indicating a degenerate cross product, which
            throw "Two parallel vectors were given"; // happens if eye == at, or if at minus eye is parallel to up.
        z.scale(-1); // Enforce right-handed coordinate system.                                   
        return Mat4.translation([-x.dot(eye), -y.dot(eye), -z.dot(eye)])
            .times(Mat.of(x.to4(0), y.to4(0), z.to4(0), Vec.of(0, 0, 0, 1)));
    }
    // Box-shaped view volume for projection.
    static orthographic(left, right, bottom, top, near, far) {
        return Mat4.scale(Vec.of(1 / (right - left), 1 / (top - bottom), 1 / (far - near)))
            .times(Mat4.translation(Vec.of(-left - right, -top - bottom, -near - far)))
            .times(Mat4.scale(Vec.of(2, 2, -2)));
    }
    // Frustum-shaped view volume for projection.
    static perspective(fov_y, aspect, near, far) {
        const f = 1 / Math.tan(fov_y / 2),
            d = far - near;
        return Mat.of([f / aspect, 0, 0, 0], [0, f, 0, 0], [0, 0, -(near + far) / d, -2 * near * far / d], [0, 0, -1, 0]);
    }
    // Computing a 4x4 inverse is slow because of the amount of steps; call fewer times when possible.
    static inverse(m) {
        const result = Mat4.identity(),
            m00 = m[0][0], m01 = m[0][1], m02 = m[0][2], m03 = m[0][3],
            m10 = m[1][0], m11 = m[1][1], m12 = m[1][2], m13 = m[1][3],
            m20 = m[2][0], m21 = m[2][1], m22 = m[2][2], m23 = m[2][3],
            m30 = m[3][0], m31 = m[3][1], m32 = m[3][2], m33 = m[3][3];
        result[0][0] = m12 * m23 * m31 - m13 * m22 * m31 + m13 * m21 * m32 - m11 * m23 * m32 - m12 * m21 * m33 + m11 * m22 * m33;
        result[0][1] = m03 * m22 * m31 - m02 * m23 * m31 - m03 * m21 * m32 + m01 * m23 * m32 + m02 * m21 * m33 - m01 * m22 * m33;
        result[0][2] = m02 * m13 * m31 - m03 * m12 * m31 + m03 * m11 * m32 - m01 * m13 * m32 - m02 * m11 * m33 + m01 * m12 * m33;
        result[0][3] = m03 * m12 * m21 - m02 * m13 * m21 - m03 * m11 * m22 + m01 * m13 * m22 + m02 * m11 * m23 - m01 * m12 * m23;
        result[1][0] = m13 * m22 * m30 - m12 * m23 * m30 - m13 * m20 * m32 + m10 * m23 * m32 + m12 * m20 * m33 - m10 * m22 * m33;
        result[1][1] = m02 * m23 * m30 - m03 * m22 * m30 + m03 * m20 * m32 - m00 * m23 * m32 - m02 * m20 * m33 + m00 * m22 * m33;
        result[1][2] = m03 * m12 * m30 - m02 * m13 * m30 - m03 * m10 * m32 + m00 * m13 * m32 + m02 * m10 * m33 - m00 * m12 * m33;
        result[1][3] = m02 * m13 * m20 - m03 * m12 * m20 + m03 * m10 * m22 - m00 * m13 * m22 - m02 * m10 * m23 + m00 * m12 * m23;
        result[2][0] = m11 * m23 * m30 - m13 * m21 * m30 + m13 * m20 * m31 - m10 * m23 * m31 - m11 * m20 * m33 + m10 * m21 * m33;
        result[2][1] = m03 * m21 * m30 - m01 * m23 * m30 - m03 * m20 * m31 + m00 * m23 * m31 + m01 * m20 * m33 - m00 * m21 * m33;
        result[2][2] = m01 * m13 * m30 - m03 * m11 * m30 + m03 * m10 * m31 - m00 * m13 * m31 - m01 * m10 * m33 + m00 * m11 * m33;
        result[2][3] = m03 * m11 * m20 - m01 * m13 * m20 - m03 * m10 * m21 + m00 * m13 * m21 + m01 * m10 * m23 - m00 * m11 * m23;
        result[3][0] = m12 * m21 * m30 - m11 * m22 * m30 - m12 * m20 * m31 + m10 * m22 * m31 + m11 * m20 * m32 - m10 * m21 * m32;
        result[3][1] = m01 * m22 * m30 - m02 * m21 * m30 + m02 * m20 * m31 - m00 * m22 * m31 - m01 * m20 * m32 + m00 * m21 * m32;
        result[3][2] = m02 * m11 * m30 - m01 * m12 * m30 - m02 * m10 * m31 + m00 * m12 * m31 + m01 * m10 * m32 - m00 * m11 * m32;
        result[3][3] = m01 * m12 * m20 - m02 * m11 * m20 + m02 * m10 * m21 - m00 * m12 * m21 - m01 * m10 * m22 + m00 * m11 * m22;
        // Divide by determinant and return.
        return result.times(1 / (m00 * result[0][0] + m10 * result[0][1] + m20 * result[0][2] + m30 * result[0][3]));
    }
    
    static eulerRotation([ax, ay, az], order="YXZ") {
        const mats = {
            X: ax ? Mat4.rotationX(ax) : null,
            Y: ay ? Mat4.rotationY(ay) : null,
            Z: az ? Mat4.rotationZ(az) : null
        };
        let ret = Mat4.identity();
        for (let k of order.split('').reverse())
            if (mats[k])
                ret = mats[k].times(ret);
        return ret;
    }
    
    static getEulerAngles(m, order="YXZ") {
        const EPSILON = 0.0000001;
        
        const m11 = m[0][0], m12 = m[0][1], m13 = m[0][2],
              m21 = m[1][0], m22 = m[1][1], m23 = m[1][2],
              m31 = m[2][0], m32 = m[2][1], m33 = m[2][2];

        const ret = [0, 0, 0];

        switch ( order ) {

            case 'XYZ':
                ret[1] = Math.asin( Math.clamp( m13, - 1, 1 ) );
                if ( Math.abs( m13 ) < 1-EPSILON ) {
                    ret[0] = Math.atan2( - m23, m33 );
                    ret[2] = Math.atan2( - m12, m11 );
                }
                else {
                    ret[0] = Math.atan2( m32, m22 );
                    ret[2] = 0;
                }
                break;

            case 'YXZ':
                ret[0] = Math.asin( - Math.clamp( m23, - 1, 1 ) );
                if ( Math.abs( m23 ) < 1-EPSILON ) {
                    ret[1] = Math.atan2( m13, m33 );
                    ret[2] = Math.atan2( m21, m22 );
                }
                else {
                    ret[1] = Math.atan2( - m31, m11 );
                    ret[2] = 0;
                }
                break;

            case 'ZXY':
                ret[0] = Math.asin( Math.clamp( m32, - 1, 1 ) );
                if ( Math.abs( m32 ) < 1-EPSILON ) {
                    ret[1] = Math.atan2( - m31, m33 );
                    ret[2] = Math.atan2( - m12, m22 );
                }
                else {
                    ret[1] = 0;
                    ret[2] = Math.atan2( m21, m11 );
                }
                break;

            case 'ZYX':
                ret[1] = Math.asin( - Math.clamp( m31, - 1, 1 ) );
                if ( Math.abs( m31 ) < 1-EPSILON ) {
                    ret[0] = Math.atan2( m32, m33 );
                    ret[2] = Math.atan2( m21, m11 );
                }
                else {
                    ret[0] = 0;
                    ret[2] = Math.atan2( - m12, m22 );
                }
                break;

            case 'YZX':
                ret[2] = Math.asin( Math.clamp( m21, - 1, 1 ) );
                if ( Math.abs( m21 ) < 1-EPSILON ) {
                    ret[0] = Math.atan2( - m23, m22 );
                    ret[1] = Math.atan2( - m31, m11 );
                }
                else {
                    ret[0] = 0;
                    ret[1] = Math.atan2( m13, m33 );
                }
                break;

            case 'XZY':
                ret[2] = Math.asin( - Math.clamp( m12, - 1, 1 ) );
                if ( Math.abs( m12 ) < 1-EPSILON ) {
                    ret[0] = Math.atan2( m32, m22 );
                    ret[1] = Math.atan2( m13, m11 );
                }
                else {
                    ret[0] = Math.atan2( - m23, m33 );
                    ret[1] = 0;
                }
                break;
            
            default:
                throw "Unsupported Euler angle order";
        }
        
        return ret;
    }
    
    static transformFromParts(position, rotation, scale) {
        return Mat4.translation(position).times(Mat4.eulerRotation(rotation)).times(Mat4.scale(scale));
    }
    static transformAndInverseFromParts(position, rotation, scale) {
        const r = Mat4.eulerRotation(rotation);
        return [
            Mat4.translation(position).times(r).times(Mat4.scale(scale)),
            Mat4.scale(scale.inverse()).times(r.transposed()).times(Mat4.translation(position.times(-1)))
        ];
    }
    static breakdownTransform(m) {
        const scale = Vec.of(m.column(0).norm(), m.column(1).norm(), m.column(2).norm());
        const rotation = Mat4.getEulerAngles(Mat4.scale([1/scale[0], 1/scale[1], 1/scale[2]]).times(m));
        const position = m.column(3);
        return [position, rotation, scale];
    }
}
