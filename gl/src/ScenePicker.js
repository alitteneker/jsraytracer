// The scene picker: a dialog showing every scene in tests/list.json as a card with its preview image
// (tests/<scene>/preview.jpg, a frame from ?renderAll=1), grouped by what the scenes show and filtered as you type.
// A scene without a preview gets a plain card with its name.
class ScenePicker {
    // Scenes not listed here go in a final "More scenes" group, so a new scene shows up without editing this file.
    static GROUPS = [
        { title: "Basics", tests: ["ASimpleScene", "Aggregates", "AHollowTetrahedron", "AMultipleBVH", "BoxBall",
            "BoxBall_DOF", "spheres010", "spheres050", "spheres100"] },
        { title: "Glass and refraction", tests: ["refraction_simple", "refraction", "refraction_path", "diamond", "bottle"] },
        { title: "Path tracing", tests: ["cornell_box_path", "cornell_box_emissive", "pbr_materials", "BoxBall_path",
            "bunny_path", "cornell_box"] },
        { title: "Meshes", tests: ["bunny", "dragon", "cat", "heart", "utah_teapot", "toledo", "dragon_json", "toledo_json"] },
        { title: "Star Wars", tests: ["starwars", "tie_fighter", "x-wing"] },
        { title: "Signed distance fields", tests: ["SDF_Simple", "SDF_BoxBall", "SDF_Combinations", "SDF_Menger",
            "SDF_Sierpinski", "SDF_SphereRepetition", "SDF_RecursiveUnionTest"] },
    ];
    static DESCRIPTIONS = {
        ASimpleScene:     "The basic geometry types under one light",
        BoxBall_DOF:      "Depth of field",
        cornell_box_path: "Global illumination from an area light",
        pbr_materials:    "Plastic, gold and glass, smooth to rough",
        dragon:           "A 100,000 triangle mesh in a BVH",
        starwars:         "Instanced meshes, laser bolts and depth of field",
        SDF_Menger:       "A Menger sponge fractal",
        SDF_Sierpinski:   "A Sierpinski tetrahedron fractal",
        dragon_json:      "Needs a generated file: see the README",
        toledo_json:      "Needs a generated file: see the README",
    };

    // dialog: the <dialog> element, with a .scene-picker-search input and a .scene-picker-groups container.
    // onSelect(test) runs when a scene is chosen. testsRoot is the tests folder relative to the page (the GPU page is
    // in gl/, the CPU page at the top level). Styles are in gl/scene-picker.css.
    constructor(dialog, tests, onSelect, testsRoot="../tests") {
        this.dialog = dialog;
        this.testsRoot = testsRoot;
        this.onSelect = onSelect;
        this.current = null;
        this.search = dialog.querySelector(".scene-picker-search");
        this.groups = dialog.querySelector(".scene-picker-groups");

        const listed = new Set(ScenePicker.GROUPS.flatMap(g => g.tests));
        const groups = ScenePicker.GROUPS
            .map(g => ({ title: g.title, tests: g.tests.filter(t => tests.includes(t)) }))
            .concat([{ title: "More scenes", tests: tests.filter(t => !listed.has(t)).sort() }])
            .filter(g => g.tests.length);
        this.cards = [];
        for (const group of groups) {
            const section = document.createElement("section");
            const heading = document.createElement("h3");
            heading.textContent = group.title;
            const grid = document.createElement("div");
            grid.className = "scene-picker-grid";
            for (const test of group.tests) {
                const card = this.makeCard(test);
                this.cards.push({ test: test, card: card, section: section });
                grid.appendChild(card);
            }
            section.append(heading, grid);
            this.groups.appendChild(section);
        }

        this.search.addEventListener("input", () => this.filter(this.search.value));
        // Enter in the search box picks the first scene still shown.
        this.search.addEventListener("keydown", e => {
            if (e.key != "Enter")
                return;
            const first = this.cards.find(c => !c.card.hidden);
            if (first)
                this.choose(first.test);
        });
        dialog.querySelector(".scene-picker-close").addEventListener("click", () => this.close());
        // A click on the backdrop (outside the dialog's box) closes it.
        dialog.addEventListener("click", e => {
            if (e.target !== dialog)
                return;
            const r = dialog.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
                this.close();
        });
    }
    makeCard(test) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "scene-card";
        card.title = test;

        const image = document.createElement("img");
        image.loading = "lazy";
        image.alt = "";
        image.src = `${this.testsRoot}/${encodeURIComponent(test)}/preview.jpg`;
        // No preview yet: show the name in its place.
        image.addEventListener("error", () => {
            const placeholder = document.createElement("div");
            placeholder.className = "scene-card-placeholder";
            placeholder.textContent = "No preview";
            image.replaceWith(placeholder);
        });

        const name = document.createElement("span");
        name.className = "scene-card-name";
        name.textContent = test;
        card.append(image, name);
        if (ScenePicker.DESCRIPTIONS[test]) {
            const description = document.createElement("span");
            description.className = "scene-card-description";
            description.textContent = ScenePicker.DESCRIPTIONS[test];
            card.appendChild(description);
        }
        card.addEventListener("click", () => this.choose(test));
        return card;
    }
    filter(text) {
        const query = text.trim().toLowerCase();
        for (const c of this.cards)
            c.card.hidden = !!query && !c.test.toLowerCase().includes(query)
                && !(ScenePicker.DESCRIPTIONS[c.test] || "").toLowerCase().includes(query);
        for (const section of this.groups.children)
            section.hidden = !this.cards.some(c => c.section === section && !c.card.hidden);
    }
    setCurrent(test) {
        this.current = test;
        for (const c of this.cards)
            c.card.classList.toggle("current", c.test === test);
    }
    choose(test) {
        this.close();
        this.onSelect(test);
    }
    open() {
        this.search.value = "";
        this.filter("");
        this.dialog.showModal();
        const current = this.cards.find(c => c.test === this.current);
        if (current)
            current.card.scrollIntoView({ block: "center" });
        this.search.focus();
    }
    close() {
        if (this.dialog.open)
            this.dialog.close();
    }
}
