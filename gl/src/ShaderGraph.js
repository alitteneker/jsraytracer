// Derives the dependency graph of a built tracer shader: which sections of gl/shaders define which GLSL symbols
// (macros, structs, functions, globals and uniforms), and which sections use them. Nothing in the shader files is
// annotated; the graph comes from the GLSL itself, so it can't drift from the code.
//
// From the browser console, with a scene loaded:
//     ShaderGraph.report(jsrtEditor.renderer_adapter)        // prints the report, and returns the analysis
//     ShaderGraph.dot(jsrtEditor.renderer_adapter, "layer")  // Graphviz source, by "file", "layer" or "section"
// From Node, on a shader saved with tracing on (see trace()):
//     node gl/src/ShaderGraph.js shader.glsl [--dot file|layer|section [link|order]]
//
// Nodes come at three levels: sections; files; and layers, which split each file into its interface (declaration
// sections: types, prototypes, uniforms) and its code.
//
// Two graphs come out, because "A depends on B" means two different things in a shader:
//   - order: A uses a symbol that B declares first. B must come before A in the shader, or A won't compile. For a
//     function that has a prototype, this is the section with the prototype.
//   - link: A uses a symbol whose definition (a function's body) is in B. This is what A really needs from B: to
//     compile A on its own, B would have to come too. Prototypes are what let this graph have cycles (materials
//     cast shadow rays through the world, and the world shades its hits with the materials) while the order
//     graph, the one the compiler sees, has none.
// The analysis is lexical: it knows top-level declarations and identifiers, not GLSL's scoping rules, so a local
// variable that shares its name with a global symbol counts as a use of the global.
class ShaderGraph {
    // The current scene's tracer shader, built again with section markers (see ShaderLibrary.trace).
    static trace(renderer_adapter) {
        ShaderLibrary.trace = true;
        try {
            return "#version 300 es \n" + renderer_adapter.getShaderSourceDeclarations() + renderer_adapter.getShaderSource();
        }
        finally {
            ShaderLibrary.trace = false;
        }
    }

    static KEYWORDS = new Set(("attribute const uniform varying layout centroid flat smooth break continue do for while switch "
        + "case default if else in out inout float int void bool true false invariant discard return mat2 mat3 mat4 "
        + "mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 "
        + "bvec4 uint uvec2 uvec3 uvec4 lowp mediump highp precision sampler2D sampler3D samplerCube sampler2DShadow "
        + "isampler2D isampler3D usampler2D sampler2DArray isampler2DArray struct defined").split(" "));

    // Splits a traced shader into its code (markers removed) and, for each character, the section it came from.
    // Generated text outside any section gets a node of its own, named after the section before it.
    static attribute(source) {
        const code = [], owners = [], stack = [];
        let lastEnded = "start", unmarked = null;
        const marker = /\/\*@(begin ([^*]+)|end)\*\/\n?/g;
        let pos = 0, m;
        const take = (from, to) => {
            for (let i = from; i < to; ++i) {
                let owner = stack[stack.length - 1];
                if (owner === undefined) {
                    if (/\s/.test(source[i]) && !unmarked) { code.push(source[i]); owners.push(null); continue; }
                    owner = unmarked = unmarked || `(generated after ${lastEnded})`;
                }
                code.push(source[i]);
                owners.push(owner);
            }
        };
        while ((m = marker.exec(source))) {
            take(pos, m.index);
            pos = marker.lastIndex;
            // A newline the marker added would join two lines; keep the text's own line structure instead.
            if (m[0].endsWith("\n") && m[1] === "end")
                pos--;
            if (m[2]) {
                stack.push(m[2]);
                unmarked = null;
            }
            else {
                lastEnded = stack.pop();
                unmarked = null;
            }
        }
        take(pos, source.length);
        return { code: code.join(""), owners: owners };
    }

    // Comments become spaces, so positions still line up with the owners.
    static stripComments(code) {
        return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, c => c.replace(/[^\n]/g, " "));
    }

    static tokenize(code) {
        const tokens = [];
        const re = /([A-Za-z_]\w*)|(\d[\w.]*)|(\S)/g;
        let m, lineStart = true, line = 0;
        // Preprocessor lines are tokenized too, flagged with the directive they belong to.
        const lines = code.split("\n");
        let offset = 0;
        for (const text of lines) {
            const directive = text.match(/^\s*#\s*(\w+)/);
            re.lastIndex = 0;
            while ((m = re.exec(text)))
                tokens.push({ text: m[0], ident: !!m[1], pos: offset + m.index, line: line,
                    directive: directive ? directive[1] : null });
            offset += text.length + 1;
            ++line;
        }
        return tokens;
    }

    // Top-level definitions, and every identifier use. Returns { symbols: name -> [{owner, kind, body}], uses }.
    static scan(code, owners) {
        const tokens = ShaderGraph.tokenize(ShaderGraph.stripComments(code));
        const symbols = new Map(), uses = [];
        const define = (token, kind, body) => {
            if (!symbols.has(token.text))
                symbols.set(token.text, []);
            symbols.get(token.text).push({ owner: owners[token.pos], kind: kind, body: body, pos: token.pos });
            token.defines = true;
        };
        // Only names declared outside any braces or parentheses are global: a parameter in a prototype isn't.
        let depth = 0, parens = 0;
        for (let i = 0; i < tokens.length; ++i) {
            const t = tokens[i];
            if (t.directive) {
                if (t.directive === "define" && t.text === "define" && tokens[i + 1] && tokens[i + 1].directive)
                    define(tokens[i + 1], "macro", true);
                continue;
            }
            if (t.text === "{") ++depth;
            else if (t.text === "}") --depth;
            else if (t.text === "(") ++parens;
            else if (t.text === ")") --parens;
            if (depth != 0 || parens != 0 || !t.ident)
                continue;
            const next = tokens[i + 1], prev = tokens[i - 1];
            if (t.text === "struct" && next && next.ident) {
                define(next, "struct", true);
                continue;
            }
            if (ShaderGraph.KEYWORDS.has(t.text) || !prev || !prev.ident || (prev.directive))
                continue;
            // A name right after a type: a function if "(" follows, otherwise a global variable or uniform.
            if (next && next.text === "(") {
                let j = i + 1, parens = 0;
                for (; j < tokens.length; ++j) {
                    if (tokens[j].text === "(") ++parens;
                    else if (tokens[j].text === ")" && --parens == 0) break;
                }
                const after = tokens[j + 1];
                define(t, "function", !!after && after.text === "{");
            }
            else if (next && /^[;=\[,]$/.test(next.text) && prev.text !== "precision")
                define(t, "global", true);
        }
        for (let i = 0; i < tokens.length; ++i) {
            const t = tokens[i];
            if (!t.ident || t.defines || ShaderGraph.KEYWORDS.has(t.text))
                continue;
            const prev = tokens[i - 1];
            if (prev && prev.text === "." && !prev.directive)
                continue;
            uses.push({ name: t.text, owner: owners[t.pos], pos: t.pos });
        }
        return { symbols: symbols, uses: uses };
    }

    // The analysis: section and file nodes, order and link edges (each with the symbols behind it), and the cycles
    // of the link graph.
    static analyze(source) {
        const { code, owners } = ShaderGraph.attribute(source);
        const { symbols, uses } = ShaderGraph.scan(code, owners);
        const fileOf = owner => owner.startsWith("(") ? "(generated)" : owner.split(":")[0];
        // A file's interface (its declarations: types, prototypes, uniforms) and its code are separate layers.
        const layerOf = owner => owner.startsWith("(") || owner.startsWith("macros:") ? fileOf(owner)
            : fileOf(owner) + (/declarations|^parameters$/.test(owner.split(":")[1]) ? " (interface)" : " (code)");
        const edges = { order: new Map(), link: new Map() };
        const addEdge = (graph, from, to, name) => {
            if (!from || !to || from === to)
                return;
            const key = from + "\u0000" + to;
            if (!graph.has(key))
                graph.set(key, { from: from, to: to, symbols: new Set() });
            graph.get(key).symbols.add(name);
        };
        const nodes = new Map();
        for (const o of owners)
            if (o) nodes.set(o, (nodes.get(o) || 0) + 1);
        const unresolved = new Set();
        for (const use of uses) {
            const defs = symbols.get(use.name);
            if (!defs) { unresolved.add(use.name); continue; }
            const first = defs.reduce((a, b) => a.pos < b.pos ? a : b);
            addEdge(edges.order, use.owner, first.owner, use.name);
            for (const d of defs.filter(d => d.body))
                addEdge(edges.link, use.owner, d.owner, use.name);
        }
        const group = (graph, by) => {
            const out = new Map();
            for (const e of graph.values())
                for (const name of e.symbols)
                    addEdge(out, by(e.from), by(e.to), name);
            return [...out.values()];
        };
        // Nodes are the sections that take part in some edge (a run of generated text that's only a comment doesn't).
        const linked = new Set([...edges.order.values(), ...edges.link.values()].flatMap(e => [e.from, e.to]));
        const sections = [...nodes.keys()].filter(n => linked.has(n));
        const files = [...new Set(sections.map(fileOf))];
        const layers = [...new Set(sections.map(layerOf))];
        const fileLink = group(edges.link, fileOf), layerLink = group(edges.link, layerOf);
        return {
            sections: sections, files: files, layers: layers, symbols: symbols,
            nodes: { section: sections, layer: layers, file: files },
            section: { order: [...edges.order.values()], link: [...edges.link.values()] },
            layer: { order: group(edges.order, layerOf), link: layerLink },
            file: { order: group(edges.order, fileOf), link: fileLink },
            cycles: {
                section: ShaderGraph.cycles(sections, [...edges.link.values()]),
                layer: ShaderGraph.cycles(layers, layerLink),
                file: ShaderGraph.cycles(files, fileLink)
            },
            unmarkedCharacters: owners.filter(o => o && o.startsWith("(")).length,
            totalCharacters: owners.filter(o => o).length
        };
    }

    // Strongly connected components with more than one node (Tarjan).
    static cycles(nodes, edges) {
        const out = new Map(nodes.map(n => [n, []]));
        for (const e of edges) out.get(e.from).push(e.to);
        let index = 0;
        const idx = new Map(), low = new Map(), stack = [], onStack = new Set(), result = [];
        const visit = v => {
            idx.set(v, index); low.set(v, index); ++index;
            stack.push(v); onStack.add(v);
            for (const w of out.get(v)) {
                if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
                else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
            }
            if (low.get(v) === idx.get(v)) {
                const component = [];
                let w;
                do { w = stack.pop(); onStack.delete(w); component.push(w); } while (w !== v);
                if (component.length > 1) result.push(component.reverse());
            }
        };
        for (const n of nodes) if (!idx.has(n)) visit(n);
        return result;
    }

    static text(analysis) {
        const lines = [];
        const list = (edges, level) => {
            for (const e of [...edges].sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to))) {
                const names = [...e.symbols].sort();
                lines.push(`  ${e.from} -> ${e.to}: ${names.slice(0, 8).join(", ")}${names.length > 8 ? `, ... (${names.length})` : ""}`);
            }
        };
        const pct = (100 * analysis.unmarkedCharacters / Math.max(1, analysis.totalCharacters)).toFixed(1);
        lines.push(`${analysis.sections.length} sections in ${analysis.files.length} files; ${pct}% of the shader is generated outside any section.`);
        lines.push("", "Link graph by layer (uses -> defines, or holds the body of):");
        list(analysis.layer.link);
        // The order graph's edges between files should all point at an interface: if one points at another file's
        // code, that file's code must come early, and a fixed order of phases (interfaces, then code) isn't enough.
        const early = analysis.layer.order.filter(e => / \(code\)$/.test(e.to) && e.from.split(" ")[0] !== e.to.split(" ")[0]);
        lines.push("", "Symbols one file's code needs from another file's code before it (rather than from an interface):");
        list(early);
        if (!early.length) lines.push("  none: interfaces first, then code, is a valid order");
        lines.push("", "Cycles in the link graph (each is broken by prototypes):");
        for (const level of ["file", "layer", "section"])
            for (const c of analysis.cycles[level]) lines.push(`  ${level}s: ` + c.join(", "));
        if (!["file", "layer", "section"].some(level => analysis.cycles[level].length)) lines.push("  none");
        return lines.join("\n");
    }

    // Graphviz source for one graph: level "file", "layer" or "section", graph "link" or "order". Edges in a cycle are red.
    static dotSource(analysis, level="layer", graph="link") {
        const edges = analysis[level][graph];
        const nodes = analysis.nodes[level];
        const cyclic = new Map();
        analysis.cycles[level].forEach((c, i) => c.forEach(n => cyclic.set(n, i)));
        const id = n => JSON.stringify(n);
        const lines = [`digraph shader_${graph} {`, `  rankdir=LR; newrank=true; node [shape=box, fontname="Helvetica", fontsize=10];`,
            `  edge [fontname="Helvetica", fontsize=8, color="#666666"];`];
        // At the layer level, a file's interface and code sit together in a box.
        if (level === "layer") {
            const files = new Map();
            for (const n of nodes) {
                const file = n.split(" ")[0];
                if (!files.has(file)) files.set(file, []);
                files.get(file).push(n);
            }
            let i = 0;
            for (const [file, members] of files) {
                lines.push(`  subgraph cluster_${i++} { label=${id(file)}; fontname="Helvetica"; fontsize=11; color="#bbbbbb";`);
                for (const n of members) lines.push(`    ${id(n)} [label=${id(n.includes("(") && n !== file ? n.slice(n.indexOf("(") + 1, -1) : n)}];`);
                lines.push("  }");
            }
        }
        else
            for (const n of nodes) lines.push(`  ${id(n)};`);
        for (const e of edges) {
            const names = [...e.symbols].sort();
            const label = names.length > 3 ? `${names.slice(0, 3).join("\\n")}\\n+${names.length - 3}` : names.join("\\n");
            const red = cyclic.has(e.from) && cyclic.get(e.from) === cyclic.get(e.to) ? `, color="#c0392b", fontcolor="#c0392b"` : "";
            lines.push(`  ${id(e.from)} -> ${id(e.to)} [label=${JSON.stringify(label).replace(/\\\\n/g, "\\n")}${red}];`);
        }
        lines.push("}");
        return lines.join("\n");
    }

    static report(renderer_adapter) {
        const analysis = ShaderGraph.analyze(ShaderGraph.trace(renderer_adapter));
        console.log(ShaderGraph.text(analysis));
        return analysis;
    }
    static dot(renderer_adapter, level="layer", graph="link") {
        return ShaderGraph.dotSource(ShaderGraph.analyze(ShaderGraph.trace(renderer_adapter)), level, graph);
    }
}

if (typeof module !== "undefined" && typeof window === "undefined") {
    module.exports = ShaderGraph;
    if (require.main === module) {
        const args = process.argv.slice(2);
        const analysis = ShaderGraph.analyze(require("fs").readFileSync(args[0], "utf8"));
        const dot = args.indexOf("--dot");
        if (dot >= 0)
            console.log(ShaderGraph.dotSource(analysis, args[dot + 1] || "layer", args[dot + 2] || "link"));
        else
            console.log(ShaderGraph.text(analysis));
    }
}
