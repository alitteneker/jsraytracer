// The GLSL source files under gl/shaders/, and the small template step that turns them into shader source.
//
// The tracer's fragment shader is generated per scene (see WebGLRendererAdapter.buildShaders): each adapter
// contributes declarations and source, much of it fixed GLSL and some of it generated from the scene. The fixed
// parts live in .glsl files here; the adapters render them with the few values only the scene knows.
//
// A file can parametrize its text in two ways, whichever reads better where it's used:
//   - ${name} holes, filled from the values the adapter passes to render(). A name must be a plain identifier, and
//     render() throws if no value is given for it, so a typo can't silently leave a hole empty. Holes suit generated
//     code and sizes that appear inside declarations, such as an array length.
//   - Preprocessor macros, prepended by the adapter (see defines()), and used with #if in the file. These keep the
//     file valid GLSL, and the choice is still visible in the final shader.
//
// A file can hold several sections, each starting at a line of the form
//     //#section name
// and render() returns one of them by name. Text before the first marker is a comment for readers of the file and
// is never output. Files are fetched once, before the first shader is built (load()); after that, render() is
// synchronous, so building a shader stays synchronous too.
class ShaderLibrary {
    static FILES = [
        "util.glsl",
        "renderer.glsl",
        "camera.glsl",
        "lights.glsl",
        "materials.glsl",
        "bsdf.glsl",
        "geometries.glsl",
        "sdf.glsl",
        "world.glsl",
    ];
    static BASE = new URL("../shaders/", document.currentScript ? document.currentScript.src : window.location.href).href;
    static files = null;

    // Fetches every file in FILES. Resolves once all are loaded; rejects (naming the file) if any can't be.
    static load() {
        if (!ShaderLibrary.loading)
            ShaderLibrary.loading = Promise.all(ShaderLibrary.FILES.map(name =>
                fetch(ShaderLibrary.BASE + name, { cache: "no-cache" }).then(response => {
                    if (!response.ok)
                        throw new Error(`Could not load shader file ${name}: ${response.status} ${response.statusText}`);
                    return response.text();
                }).then(text => [name, ShaderLibrary.parse(name, text)])
            )).then(entries => { ShaderLibrary.files = Object.fromEntries(entries); });
        return ShaderLibrary.loading;
    }

    // Splits a file into its sections. Line endings are normalized, so a file checked out with CRLF renders the same.
    static parse(name, text) {
        const sections = {};
        let current = null;
        for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
            const marker = line.match(/^\s*\/\/#section\s+([\w.-]+)\s*$/);
            if (marker) {
                current = marker[1];
                if (current in sections)
                    throw new Error(`Shader file ${name} has two sections named ${current}`);
                sections[current] = [];
            }
            else if (current !== null)
                sections[current].push(line);
        }
        return Object.fromEntries(Object.entries(sections).map(([k, lines]) => [k, lines.join("\n")]));
    }

    // When true, render() wraps each section it returns in /*@begin file:section*/ ... /*@end*/ comments, so a built
    // shader can be traced back to the sections it came from (see ShaderGraph). Text a hole receives stays inside
    // the section around it; generated text outside any section is left unmarked.
    static trace = false;

    // The text of section `section` of file `name`, with each ${hole} replaced by String(values[hole]).
    static render(name, section, values={}) {
        const text = ShaderLibrary.renderText(name, section, values);
        return ShaderLibrary.trace ? `/*@begin ${name}:${section}*/\n${text}\n/*@end*/` : text;
    }
    static renderText(name, section, values) {
        if (!ShaderLibrary.files)
            throw new Error("ShaderLibrary.render called before ShaderLibrary.load finished");
        const file = ShaderLibrary.files[name];
        if (!file)
            throw new Error(`Unknown shader file ${name} (is it listed in ShaderLibrary.FILES?)`);
        if (!(section in file))
            throw new Error(`Shader file ${name} has no section ${section}`);
        return file[section].replace(/\$\{\s*([A-Za-z_]\w*)\s*\}/g, (_, hole) => {
            if (!(hole in values) || values[hole] === undefined)
                throw new Error(`${name} (${section}) needs a value for \${${hole}}`);
            return String(values[hole]);
        });
    }

    // Preprocessor lines for an object of macros. Booleans become 1 or 0, so files test them with #if. The label
    // names them when tracing (as "macros:<label>").
    static defines(macros, label="macros") {
        const text = Object.entries(macros).map(([k, v]) =>
            `#define ${k} ${typeof v === "boolean" ? Number(v) : v}\n`).join("");
        return ShaderLibrary.trace ? `/*@begin macros:${label}*/\n${text}/*@end*/\n` : text;
    }
}
