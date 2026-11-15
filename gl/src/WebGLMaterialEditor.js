// Managing a scene's materials: listing them with how many primitives use each, assigning one to primitives,
// giving primitives their own copy, adding and deleting. Like WebGLSDFEditor, edits change the CPU scene (src/), and
// the editor then rebuilds the renderer from it (WebGLRendererAdapter.worldModified).
//
// A material is shared by reference: every Primitive whose .material is the same object uses it (all the triangles
// of one OBJ newmtl, say), and an edit to it shows on all of them. "Make unique" gives some of them a copy.
//
// Materials nothing uses are kept in world.materialLibrary, so that a material doesn't vanish when its last user is
// reassigned, and so that a new material can exist before anything uses it. (It's not enumerable, so it isn't saved
// with the scene.) The renderer visits these too, so they can be edited like any other.
class WebGLMaterialEditor {
    static TYPES = {
        phong:      "Phong",
        principled: "Principled"
    };
    static create(type) {
        if (type == "principled")
            return new PrincipledMaterial();
        return WebGLEditorInterface.defaultMaterial();
    }
    static label(material) {
        return material.name || `${material.constructor.name.replace(/Material$/, "") || "Material"} ${material.MATERIAL_UID}`;
    }
    static library(world) {
        if (!world.materialLibrary)
            Object.defineProperty(world, "materialLibrary", { value: [], writable: true, enumerable: false, configurable: true });
        return world.materialLibrary;
    }

    // Every Primitive at or under root (a WorldObject, or an array of them), each once. Lights are skipped: the
    // primitives the renderer shows lights with (see WebGLWorldAdapter.makeLightEmitterProxy) aren't in the scene.
    static primitives(root, out=[], seen=new Set()) {
        if (Array.isArray(root)) {
            for (const o of root)
                WebGLMaterialEditor.primitives(o, out, seen);
            return out;
        }
        if (!root || seen.has(root))
            return out;
        seen.add(root);
        if (root instanceof Primitive)
            out.push(root);
        else if (root instanceof TransformedWorldObject)
            WebGLMaterialEditor.primitives(root.object, out, seen);
        else if (root instanceof Aggregate)
            WebGLMaterialEditor.primitives(root.objects, out, seen);
        return out;
    }

    // The scene's materials, in the order they're first used, then the unused ones: [{ material, users }].
    static list(world) {
        const counts = new Map();
        for (const p of WebGLMaterialEditor.primitives(world.objects))
            counts.set(p.material, (counts.get(p.material) || 0) + 1);
        const library = WebGLMaterialEditor.library(world);
        // Drop library entries that are in use again; they're listed with their users.
        world.materialLibrary = library.filter(m => !counts.has(m));
        return [...counts.entries()].map(([m, n]) => ({ material: m, users: n }))
            .concat(world.materialLibrary.map(m => ({ material: m, users: 0 })));
    }
    static users(world, material) {
        return WebGLMaterialEditor.primitives(world.objects).filter(p => p.material === material).length;
    }

    // Gives the primitives under scope that use `from` the material `to` instead. Returns how many changed. If `from`
    // is left unused, it goes into the library rather than disappearing.
    static assign(world, scope, from, to) {
        let n = 0;
        for (const p of WebGLMaterialEditor.primitives(scope))
            if (p.material === from) {
                p.material = to;
                ++n;
            }
        const library = WebGLMaterialEditor.library(world);
        if (WebGLMaterialEditor.users(world, from) == 0 && !library.includes(from))
            library.push(from);
        world.materialLibrary = WebGLMaterialEditor.library(world).filter(m => m !== to);
        return n;
    }
    // Gives the primitives under scope that use `material` a copy of it. Returns the copy.
    static makeUnique(world, scope, material) {
        const copy = material.copy();
        copy.name = WebGLMaterialEditor.label(material) + " copy";
        WebGLMaterialEditor.assign(world, scope, material, copy);
        return copy;
    }
    // Whether scope holds only some of material's users, so that making it unique there would change anything.
    static isShared(world, scope, material) {
        const inside = WebGLMaterialEditor.primitives(scope).filter(p => p.material === material).length;
        return inside > 0 && inside < WebGLMaterialEditor.users(world, material);
    }
    static add(world, type) {
        const material = WebGLMaterialEditor.create(type);
        WebGLMaterialEditor.library(world).push(material);
        return material;
    }
    // Deletes a material; anything using it gets one new default material. Returns how many primitives changed.
    static remove(world, material) {
        world.materialLibrary = WebGLMaterialEditor.library(world).filter(m => m !== material);
        const users = WebGLMaterialEditor.primitives(world.objects).filter(p => p.material === material);
        if (users.length) {
            const replacement = WebGLMaterialEditor.create("phong");
            for (const p of users)
                p.material = replacement;
        }
        return users.length;
    }
}
