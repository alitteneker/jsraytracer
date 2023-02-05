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

function swap(arr, i, j) {
    var tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
}

function defaultCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

function clamp(a, min, max) {
    return Math.min(Math.max(a, min), max);
}

class BSPScene extends Scene {
    constructor(objects=[], lights=[], bg_color=Vec.of(0, 0, 0)) {
        super(objects, lights, bg_color);
        this.kdtree = new BSPSceneTreeNode(Array.from(objects));
    }
    cast(ray, minDist = 0, maxDist = Infinity, intersectTransparent=true) {
        let ret = { distance: Infinity, object: null };
        this.kdtree.cast(ray, ret, minDist, maxDist, intersectTransparent);
        return ret;
    }
}

class BSPSceneTreeNode {
    constructor(objects, depth=0, min=Vec.of(-Infinity, -Infinity, -Infinity, -Infinity), max=Vec.of(Infinity, Infinity, Infinity, Infinity)) {
        this.depth = depth;
        
        const split = BSPSceneTreeNode.split_objects(objects, min, max);
        if (split) {
            this.sep_axis = split.sep_axis;
            this.sep_value = split.sep_value;
            this.spanning_objects = split.spanning_objs;
            this.lesser_node  = new BSPSceneTreeNode(split.lesser_objs.concat( split.spanning_objs), depth+1,
                min, Vec.min(max, Vec.axis(split.sep_axis, 4, split.sep_value,  Infinity)));
            this.greater_node = new BSPSceneTreeNode(split.greater_objs.concat(split.spanning_objs), depth+1,
                Vec.max(min, Vec.axis(split.sep_axis, 4, split.sep_value, -Infinity)), max);
        }
        else {
            this.sep_axis = -1;
            this.spanning_objects = objects;
        }
    }
    static split_objects(objects, min=Vec.of(-Infinity, -Infinity, -Infinity, -Infinity), max=Vec.of(Infinity, Infinity, Infinity, Infinity)) {
        if (objects.length < 2)
            return null;

        let best_axis = -1,
            best_sep_value = Infinity,
            best_lesser_objs = [],
            best_greater_objs = [],
            best_spanning_objects = new Array(objects.length + 1);
        for (let i = 0; i < 3; ++i) {
            const axis_median = median(objects.map(o => [o.getBoundingBox().min[i], o.getBoundingBox().max[i]]).flat().map(x => clamp(x, min[i], max[i])));
            
            let lesser_objs = [], greater_objs = [], spanning_objects = [];
            for (let o of objects) {
                const obb = o.getBoundingBox();
                if (obb.min[i] > axis_median)
                    greater_objs.push(o);
                else if (obb.max[i] < axis_median)
                    lesser_objs.push(o);
                else
                    spanning_objects.push(o);
            }
            if (spanning_objects.length < best_spanning_objects.length) {
                best_axis = i;
                best_sep_value = axis_median;
                best_lesser_objs = lesser_objs,
                best_greater_objs = greater_objs,
                best_spanning_objects = spanning_objects;
            }
        }

        if (best_spanning_objects.length + best_lesser_objs.length == objects.length
            || best_spanning_objects.length + best_greater_objs.length == objects.length)
                return null;

        return {
            sep_axis: best_axis,
            sep_value: best_sep_value,
            lesser_objs: best_lesser_objs,
            greater_objs: best_greater_objs,
            spanning_objs: best_spanning_objects
        };
    }
    cast(ray, ret, minDist, maxDist, intersectTransparent=true, minBound=minDist, maxBound=maxDist) {
        if (minDist > maxDist)
            return;

        for (let o of this.spanning_objects) {
            const distance = o.intersect(ray, minDist, maxDist, intersectTransparent);
            if (distance > minDist && distance < maxDist && distance < ret.distance) {
                ret.distance = distance;
                ret.object = o;
            }
        }

        if (this.sep_axis >= 0) {
            
            const ro = ray.origin[this.sep_axis],
                rd = ray.direction[this.sep_axis];

            if (ro == this.sep_value) {
                this.lesser_node .cast(ray, ret, minDist, maxDist, intersectTransparent, minBound, Math.min(maxBound, ret.distance));
                this.greater_node.cast(ray, ret, minDist, maxDist, intersectTransparent, minBound, Math.min(maxBound, ret.distance));
                return;
            }

            const lesser_cmp = ro < this.sep_value,
                nearNode = lesser_cmp ? this.lesser_node : this.greater_node,
                farNode = lesser_cmp ? this.greater_node : this.lesser_node;

            const sepDist = (rd != 0) ? (this.sep_value - ro) / rd : Infinity,
                towardsSeparator = sepDist > 0;
            
            if (!towardsSeparator || sepDist >= minBound && nearNode != null)
                nearNode.cast(ray, ret, minDist, maxDist, intersectTransparent,
                    minBound, Math.min(ret.distance, maxBound, towardsSeparator ? sepDist : Infinity));
            
            if (towardsSeparator && sepDist < ret.distance && sepDist <= maxBound && farNode != null)
                farNode.cast(ray, ret, minDist, maxDist, intersectTransparent,
                    sepDist, Math.min(maxBound, ret.distance));
        }
    }
    maxDepth() {
        return (this.sep_axis < 0) ? this.depth : Math.max(this.greater_node.maxDepth(), this.lesser_node.maxDepth());
    }
}

class BVHScene extends Scene {
    constructor(objects=[], lights=[], bg_color=Vec.of(0, 0, 0), maxDepth=Infinity, minNodeSize=0) {
        super(objects, lights, bg_color);
        objects = Array.from(objects);
        
        this.infinite_objects = [];
        for (let i = 0; i < objects.length; ++i) {
            const bb = objects[i].getBoundingBox();
            if (!bb.isFinite()) {
                this.infinite_objects.push(objects[i]);
                objects.splice(i, 1);
                --i;
            }
        }
        
        this.kdtree = new BVHSceneTreeNode(objects, 0, maxDepth, minNodeSize);
    }
    cast(ray, minDist = 0, maxDist = Infinity, intersectTransparent=true) {
        let ret = { distance: Infinity, object: null };
        for (let o of this.infinite_objects) {
            const distance = o.intersect(ray, minDist, maxDist, intersectTransparent);
            if (distance > minDist && distance < maxDist && distance < ret.distance) {
                ret.distance = distance;
                ret.object = o;
            }
        }
        this.kdtree.cast(ray, ret, minDist, maxDist, intersectTransparent);
        return ret;
    }
    maxDepth() {
        return this.kdtree.maxDepth();
    }
}
class BVHSceneTreeNode {
    static _NODE_UID_GEN=0;
    constructor(objects=[], depth, maxDepth, minNodeSize) {
        this.NODE_UID = BVHSceneTreeNode._NODE_UID_GEN++;
        this.depth = depth;
        
        if (depth >= maxDepth || objects.length < minNodeSize) {
            this.sep_axis = -1;
            this.spanning_objects = objects;
            this.aabb = this.spanning_objects.length > 0
                ? AABB.hull(this.spanning_objects.map(o => o.getBoundingBox()))
                : new AABB(Vec.of(0,0,0), Vec.of(0,0,0));
        }
        else {
            const split = BSPSceneTreeNode.split_objects(objects);
            if (split) {
                this.sep_axis = split.sep_axis;
                this.sep_value = split.sep_value;
                this.spanning_objects = split.spanning_objs;

                for (let o of this.spanning_objects) {
                    if (o.getBoundingBox().center[this.sep_axis] > this.sep_value)
                        split.greater_objs.push(o);
                    else
                        split.lesser_objs.push(o);
                }

                this.greater_node = new BVHSceneTreeNode(split.greater_objs, depth+1);
                this.lesser_node  = new BVHSceneTreeNode(split.lesser_objs,  depth+1);
                this.aabb = AABB.hull([this.greater_node.aabb, this.lesser_node.aabb]);
            }
            else {
                this.sep_axis = -1;
                this.spanning_objects = objects;
                this.aabb = this.spanning_objects.length > 0
                    ? AABB.hull(this.spanning_objects.map(o => o.getBoundingBox()))
                    : new AABB(Vec.of(0,0,0), Vec.of(0,0,0));
            }
        }
        if (!this.aabb)
            throw("Empty aabb for BVH node");
    }
    cast(ray, ret, minDist, maxDist, intersectTransparent=true) {
        const aabb_ts = this.aabb.get_intersects(ray, minDist, maxDist);
        if (aabb_ts && aabb_ts.min <= maxDist && aabb_ts.max >= minDist && aabb_ts.min <= ret.distance) {
            if (this.sep_axis < 0) {
                for (let o of this.spanning_objects) {
                    const distance = o.intersect(ray, minDist, maxDist, intersectTransparent);
                    if (distance > minDist && distance < maxDist && distance < ret.distance) {
                        ret.distance = distance;
                        ret.object = o;
                    }
                }
            }
            if (this.sep_axis >= 0) {
                this.greater_node.cast(ray, ret, minDist, maxDist, intersectTransparent);
                this.lesser_node. cast(ray, ret, minDist, maxDist, intersectTransparent);
            }
        }
    }
    maxDepth() {
        return (this.sep_axis < 0) ? this.depth : Math.max(this.greater_node.maxDepth(), this.lesser_node.maxDepth());
    }
}