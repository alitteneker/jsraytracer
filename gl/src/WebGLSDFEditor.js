// Structural editing of an SDF object: adding, wrapping, replacing, unwrapping and deleting the nodes of its tree.
// Edits change the CPU scene (the SDF classes in src/sdf.js, through their structure API at the end of that file).
// The editor then rebuilds the renderer from the scene, which recompiles the shader, since an SDF's structure is
// compiled into it (see WebGLEditorInterface.editSDFStructure).
class WebGLSDFEditor {
    static PRIMITIVES = {
        sphere:      "Sphere",
        box:         "Box",
        plane:       "Plane",
        tetrahedron: "Tetrahedron"
    };
    static WRAPPERS = {
        union:                 "Union",
        intersection:          "Intersection",
        difference:            "Difference",
        "smooth-union":        "Smooth Union",
        "smooth-intersection": "Smooth Intersection",
        "smooth-difference":   "Smooth Difference",
        round:                 "Round",
        transform:             "Transform",
        repeat:                "Repeat"
    };

    static transformerLabel(t) {
        if (t instanceof SDFMatrixTransformer)             return "Matrix";
        if (t instanceof SDFReflectionTransformer)         return "Reflect";
        if (t instanceof SDFInfiniteRepetitionTransformer) return "Repeat";
        if (t instanceof SDFRecursiveTransformer)          return `${WebGLSDFEditor.transformerLabel(t.transformer)} x${t.iterations}`;
        if (t instanceof SDFTransformerSequence)           return t.transformers.map(WebGLSDFEditor.transformerLabel).join(", ");
        return t.constructor.name;
    }
    static label(node) {
        if (node instanceof UnionSDF)                   return `Union (${node.children.length})`;
        if (node instanceof IntersectionSDF)            return `Intersection (${node.children.length})`;
        if (node instanceof DifferenceSDF)              return "Difference";
        if (node instanceof SmoothUnionSDF)             return "Smooth Union";
        if (node instanceof SmoothIntersectionSDF)      return "Smooth Intersection";
        if (node instanceof SmoothDifferenceSDF)        return "Smooth Difference";
        if (node instanceof RoundSDF)                   return "Round";
        if (node instanceof TransformSDF)               return `Transform: ${WebGLSDFEditor.transformerLabel(node.transformer)}`;
        if (node instanceof RecursiveTransformUnionSDF) return `Recursive Union x${node.iterations}: ${WebGLSDFEditor.transformerLabel(node.transformer)}`;
        if (node instanceof SphereSDF)                  return "Sphere";
        if (node instanceof BoxSDF)                     return "Box";
        if (node instanceof PlaneSDF)                   return "Plane";
        if (node instanceof TetrahedronSDF)             return "Tetrahedron";
        return node.constructor.name;
    }
    // For a binary operation, which child is which.
    static childLabel(parent, child) {
        if (parent instanceof DifferenceSDF || parent instanceof SmoothDifferenceSDF)
            return child === parent.negative ? "minus " : "";
        return "";
    }
    // Data for a fancytree: one node per SDF node, keyed by the SDF's UID.
    static treeSource(node, parent=null) {
        return {
            title: WebGLSDFEditor.childLabel(parent, node) + WebGLSDFEditor.label(node),
            key: "sdf" + node.UID,
            _sdf: node,
            expanded: true,
            folder: node.getChildren().length > 0,
            children: node.getChildren().map(c => WebGLSDFEditor.treeSource(c, node))
        };
    }

    // Sizes for new nodes come from the node they're added next to: its center, and half of its largest finite extent.
    static extentOf(node) {
        const box = node.getBoundingBox(Mat4.identity(), Mat4.identity());
        const finite = [0, 1, 2].filter(i => isFinite(box.min[i]) && isFinite(box.max[i]));
        const size = finite.length ? Math.max(...finite.map(i => (box.max[i] - box.min[i]) / 2)) : 0.5;
        const center = Vec.from([0, 1, 2].map(i => finite.includes(i) ? (box.min[i] + box.max[i]) / 2 : 0));
        return { size: size > 0 ? size : 0.5, center: center };
    }
    static basecolorOf(node) {
        if (node.basecolor)
            return node.basecolor;
        const c = node.getChildren().find(c => WebGLSDFEditor.basecolorOf(c));
        return c ? WebGLSDFEditor.basecolorOf(c) : Vec.of(1, 1, 1);
    }
    static makePrimitive(kind, size, basecolor) {
        switch (kind) {
            case "sphere":      return new SphereSDF(size, basecolor);
            case "box":         return new BoxSDF(0.8 * size, basecolor);
            case "plane":       return new PlaneSDF(Vec.of(0, 1, 0, 0), size, basecolor);
            // The tetrahedron's vertices are at distance sqrt(3) from its center.
            case "tetrahedron": return new TransformSDF(new TetrahedronSDF(basecolor),
                                    new SDFMatrixTransformer(Mat4.scale(size / Math.sqrt(3))));
        }
        throw "Unknown SDF primitive " + kind;
    }
    // The second operand for a new binary operation: a sphere over one corner of the node, so the operation is visible.
    static makeOperand(node) {
        const { size, center } = WebGLSDFEditor.extentOf(node);
        const offset = center.plus(Vec.of(0.6, 0.6, 0.6).times(size));
        return new TransformSDF(new SphereSDF(0.6 * size, WebGLSDFEditor.basecolorOf(node)),
            new SDFMatrixTransformer(Mat4.translation(offset)));
    }

    static parentOf(geometry, node) {
        return SDF.findParent(geometry.root_sdf, node);
    }
    static replaceNode(geometry, node, replacement) {
        const parent = WebGLSDFEditor.parentOf(geometry, node);
        if (parent)
            parent.replaceChild(node, replacement);
        else
            geometry.root_sdf = replacement;
    }
    static finish(geometry) {
        geometry.aabb = geometry.root_sdf.getBoundingBox(Mat4.identity(), Mat4.identity());
    }

    // ---- The edits. Each returns the node to select afterwards. ----
    static canAddChild(geometry, node) {
        return node.hasChildList();
    }
    static addChild(geometry, node, kind) {
        const { size, center } = WebGLSDFEditor.extentOf(node);
        // Next to the node's other children, in a transform that can move it. A primitive that already comes in a
        // transform (the tetrahedron, for its size) gets the offset folded into that one.
        const offset = Mat4.translation(center.plus(Vec.of(size, 0, 0)));
        const primitive = WebGLSDFEditor.makePrimitive(kind, 0.5 * size, WebGLSDFEditor.basecolorOf(node));
        const child = (primitive instanceof TransformSDF && primitive.transformer instanceof SDFMatrixTransformer)
            ? new TransformSDF(primitive.child_sdf, new SDFMatrixTransformer(offset.times(primitive.transformer._transform)))
            : new TransformSDF(primitive, new SDFMatrixTransformer(offset));
        node.addChild(child);
        WebGLSDFEditor.finish(geometry);
        return child;
    }
    static wrap(geometry, node, kind) {
        const { size } = WebGLSDFEditor.extentOf(node);
        let wrapper = null;
        switch (kind) {
            case "union":               wrapper = new UnionSDF(node, WebGLSDFEditor.makeOperand(node));                          break;
            case "intersection":        wrapper = new IntersectionSDF(node, WebGLSDFEditor.makeOperand(node));                   break;
            case "difference":          wrapper = new DifferenceSDF(node, WebGLSDFEditor.makeOperand(node));                     break;
            case "smooth-union":        wrapper = new SmoothUnionSDF(node, WebGLSDFEditor.makeOperand(node), 0.3 * size);        break;
            case "smooth-intersection": wrapper = new SmoothIntersectionSDF(node, WebGLSDFEditor.makeOperand(node), 0.3 * size); break;
            case "smooth-difference":   wrapper = new SmoothDifferenceSDF(node, WebGLSDFEditor.makeOperand(node), 0.3 * size);   break;
            case "round":               wrapper = new RoundSDF(node, 0.1 * size);                                                break;
            case "transform":           wrapper = new TransformSDF(node, new SDFMatrixTransformer(Mat4.identity()));             break;
            case "repeat":              wrapper = new TransformSDF(node, new SDFInfiniteRepetitionTransformer(Vec.of(1, 1, 1).times(4 * size))); break;
            default: throw "Unknown SDF operation " + kind;
        }
        WebGLSDFEditor.replaceNode(geometry, node, wrapper);
        WebGLSDFEditor.finish(geometry);
        return wrapper;
    }
    static canReplace(geometry, node) {
        return node.getChildren().length == 0;
    }
    static replace(geometry, node, kind) {
        const { size } = WebGLSDFEditor.extentOf(node);
        const replacement = WebGLSDFEditor.makePrimitive(kind, size, WebGLSDFEditor.basecolorOf(node));
        WebGLSDFEditor.replaceNode(geometry, node, replacement);
        WebGLSDFEditor.finish(geometry);
        return replacement;
    }
    // Unwrapping replaces a node with its first child (a difference keeps what was being cut).
    static canUnwrap(geometry, node) {
        return node.getChildren().length > 0;
    }
    static unwrap(geometry, node) {
        const child = node.getChildren()[0];
        WebGLSDFEditor.replaceNode(geometry, node, child);
        WebGLSDFEditor.finish(geometry);
        return child;
    }
    // Deleting removes the node and everything under it. From a list (a union's children) it's just removed; from a
    // binary operation, the operation is replaced by the other operand; and if the node is the only child of its
    // parent (a transform, say), the parent goes too. The root can't be deleted: delete the object instead.
    static deletionTarget(geometry, node) {
        const parent = WebGLSDFEditor.parentOf(geometry, node);
        if (!parent)
            return null;
        const siblings = parent.getChildren().filter(c => c !== node);
        if (siblings.length >= 1)
            return { node: node, parent: parent, siblings: siblings };
        return WebGLSDFEditor.deletionTarget(geometry, parent);
    }
    static canDelete(geometry, node) {
        return !!WebGLSDFEditor.deletionTarget(geometry, node);
    }
    static remove(geometry, node) {
        const target = WebGLSDFEditor.deletionTarget(geometry, node);
        if (!target)
            return null;
        let select;
        if (target.parent.hasChildList() && target.parent.removeChild(target.node))
            select = target.parent;
        else {
            select = target.siblings[0];
            WebGLSDFEditor.replaceNode(geometry, target.parent, select);
        }
        WebGLSDFEditor.finish(geometry);
        return select;
    }
}
