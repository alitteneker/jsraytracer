class BSPWorld extends World {
    constructor(objects=[], lights=[], bg_color=Vec.of(0, 0, 0)) {
        super(objects, lights, bg_color);
        this.kdtree = new BSPWorldTreeNode(Array.from(objects));
    }
    cast(ray, minDist = 0, maxDist = Infinity, intersectTransparent=true) {
        let ret = { distance: Infinity, object: null };
        this.kdtree.cast(ray, ret, minDist, maxDist, intersectTransparent);
        return ret;
    }
}

class BSPWorldTreeNode {
    static build(objects, depth=0, min=Vec.of(-Infinity, -Infinity, -Infinity, -Infinity), max=Vec.of(Infinity, Infinity, Infinity, Infinity)) {
        const split = BSPWorldTreeNode.split_objects(objects, min, max);
        if (split) {
            return new BSPWorldTreeNode(depth, split.spanning_objs, split.sep_axis, split.sep_value,
                BSPWorldTreeNode.build(split.lesser_objs.concat( split.spanning_objs), depth+1,
                    min, Vec.min(max, Vec.axis(split.sep_axis, 4, split.sep_value,  Infinity))),
                BSPWorldTreeNode.build(split.greater_objs.concat(split.spanning_objs), depth+1,
                    Vec.max(min, Vec.axis(split.sep_axis, 4, split.sep_value, -Infinity)), max));
        }
        else
            return new BSPWorldTreeNode(depth, objects, -1, null, null, null);
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
            const axis_median = median(objects.map(o => [o.getBoundingBox().min[i], o.getBoundingBox().max[i]]).flat().map(x => Math.clamp(x, min[i], max[i])));
            
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
    
    constructor(depth, spanning_objs, sep_axis, sep_value, lesser_node, greater_node) {
        this.depth = depth;
        
        this.spanning_objects = spanning_objs;
        
        this.sep_axis = sep_axis;
        this.sep_value = sep_value;
        
        this.lesser_node  = lesser_node;
        this.greater_node = greater_node;
    }
    
    cast(ray, ret, minDist, maxDist, intersectTransparent=true, minBound=minDist, maxBound=maxDist) {
        if (minDist > maxDist)
            return;

        for (let o of this.spanning_objects) {
            const intersection = o.intersect(ray, minDist, maxDist, intersectTransparent);
            if (intersection.distance > minDist && intersection.distance < maxDist && intersection.distance < ret.distance) {
                ret.distance = intersection.distance;
                ret.object = intersection.object;
                ret.invTransform = intersection.invTransform;
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

class BVHWorld extends World {
    constructor(objects=[], lights=[], bg_color=Vec.of(0, 0, 0), maxDepth=Infinity, minNodeSize=1) {
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
        
        this.kdtree = BVHWorldTreeNode.build(objects, 0, maxDepth, minNodeSize);
    }
    cast(ray, minDist = 0, maxDist = Infinity, intersectTransparent=true) {
        let ret = { distance: Infinity, object: null, invTransform: null };
        for (let o of this.infinite_objects) {
            const intersection = o.intersect(ray, minDist, maxDist, intersectTransparent);
            if (intersection.distance > minDist && intersection.distance < maxDist && intersection.distance < ret.distance) {
                ret.distance = intersection.distance;
                ret.object = intersection.object;
                ret.invTransform = intersection.invTransform;
            }
        }
        this.kdtree.cast(ray, ret, minDist, maxDist, intersectTransparent);
        return ret;
    }
    maxDepth() {
        return this.kdtree.maxDepth();
    }
    nodeCount() {
        return this.kdtree.nodeCount();
    }
}

class BVHWorldTreeNode {
    static _NODE_UID_GEN=0;
    static build(objects, depth, maxDepth, minNodeSize) {
        if (depth >= maxDepth || objects.length <= minNodeSize) {
            const aabb = objects.length > 0
                ? AABB.hull(objects.map(o => o.getBoundingBox()))
                : AABB.empty();
            return new BVHWorldTreeNode(depth, true, objects, aabb, null, null);
        }
        else {
            const split = BVHWorldTreeNode.split_objects(objects);
            if (split) {
                return new BVHWorldTreeNode(depth, false, [], split.bounds, 
                    BVHWorldTreeNode.build(split.lesser_objs,  depth+1, maxDepth, minNodeSize),
                    BVHWorldTreeNode.build(split.greater_objs, depth+1, maxDepth, minNodeSize));
            }
            else {
                const aabb = objects.length > 0
                    ? AABB.hull(objects.map(o => o.getBoundingBox()))
                    : AABB.empty();
                return new BVHWorldTreeNode(depth, true, objects, aabb, null, null);
            }
        }
    }
    static split_objects(objects, binsPerAxis=8) {
        if (objects.length < 2)
            return null;

        const bounds = AABB.hull(objects.map(o => o.getBoundingBox()));

        let best_axis = -1,
            best_sep_value = Infinity,
            best_cost = Infinity;
        
        for (let axis = 0; axis < 3; ++axis) {
            if (bounds.half_size[axis] < 0.000001)
                continue;
            
            let bins = [];
            for (let i = 0; i < binsPerAxis; ++i)
                bins.push({
                    count:  0,
                    bounds: AABB.empty()
                });
            
            for (let object of objects) {
                let bin_index = Math.floor(binsPerAxis * ((object.getBoundingBox().center[axis] - bounds.min[axis]) / (2 * bounds.half_size[axis])));
                if (bin_index == binsPerAxis) bin_index = binsPerAxis-1;
                const bin = bins[bin_index];
                bin.count++;
                bin.bounds = AABB.hull([bin.bounds, object.getBoundingBox()]);
            }
            
            for (let i = 0; i < binsPerAxis-1; ++i) {
                let b0 = AABB.empty(), b1 = AABB.empty();
                let count0 = 0, count1 = 0;
                for (let j = 0; j <= i; ++j) {
                    if (bins[j].count > 0) {
                        b0 = AABB.hull([b0, bins[j].bounds]);
                        count0 += bins[j].count;
                    }
                }
                for (let j = i+1; j < binsPerAxis; ++j) {
                    if (bins[j].count > 0) {
                        b1 = AABB.hull([b1, bins[j].bounds]);
                        count1 += bins[j].count;
                    }
                }
                const cost = .125 + (count0 * b0.surfaceArea() +
                                     count1 * b1.surfaceArea()) / bounds.surfaceArea();
                
                if (cost < best_cost && count0 > 0 && count1 > 0) {
                    best_axis = axis;
                    best_sep_value = bounds.min[axis] + ((i+1) / binsPerAxis) * (2 * bounds.half_size[axis]);
                    best_cost = cost;
                }
            }
        }

        if (best_axis < 0)
            return null;

        return {
            bounds: bounds,
            sep_axis: best_axis,
            sep_value: best_sep_value,
            lesser_objs:  objects.filter(o => o.getBoundingBox().center[best_axis] <  best_sep_value),
            greater_objs: objects.filter(o => o.getBoundingBox().center[best_axis] >= best_sep_value)
        };
    }
    
    constructor(depth, isLeaf, objects, aabb, lesser_node, greater_node) {
        this.NODE_UID = BVHWorldTreeNode._NODE_UID_GEN++;
        
        this.depth = depth;
        this.isLeaf = isLeaf;
        
        this.objects = objects;
        this.aabb = aabb;
        
        this.lesser_node  = lesser_node;
        this.greater_node = greater_node;
        
        if (!this.aabb)
            throw("Empty aabb for BVH node");
    }
    
    cast(ray, ret, minDist, maxDist, intersectTransparent=true) {
        const aabb_ts = this.aabb.get_intersects(ray, minDist, maxDist);
        if (aabb_ts && aabb_ts.min <= maxDist && aabb_ts.max >= minDist && aabb_ts.min <= ret.distance) {
            if (this.isLeaf) {
                for (let o of this.objects) {
                    const intersection = o.intersect(ray, minDist, maxDist, intersectTransparent);
                    if (intersection.distance > minDist && intersection.distance < maxDist && intersection.distance < ret.distance) {
                        ret.distance = intersection.distance;
                        ret.object = intersection.object;
                        ret.invTransform = intersection.invTransform;
                    }
                }
            }
            else {
                this.greater_node.cast(ray, ret, minDist, maxDist, intersectTransparent);
                this.lesser_node. cast(ray, ret, minDist, maxDist, intersectTransparent);
            }
        }
    }
    maxDepth() {
        return (this.isLeaf) ? this.depth : Math.max(this.greater_node.maxDepth(), this.lesser_node.maxDepth());
    }
    nodeCount() {
        return 1 + (this.isLeaf ? 0 : (this.greater_node.nodeCount() + this.lesser_node.nodeCount()));
    }
}