// The scene picker: a dialog showing every scene in tests/list.json as a card with its preview image
// (tests/<scene>/preview.jpg, a frame from ?renderAll=1), grouped as the manifest groups them and filtered as you type.
// A scene without a preview gets a plain card with its name.
//
// The manifest, tests/list.json, is { "groups": [ { "title", "scenes": [ { "name", "description"? } ] } ] }: the
// groups and scenes appear in the picker in the order listed. A scene that isn't listed can still be opened by URL
// (?test=<name>) but has no card.
class ScenePicker {
    static async fetchManifest(url) {
        const response = await fetch(url);
        if (!response.ok)
            throw `Could not load the scene list ${url}: ${response.status} ${response.statusText}`;
        return response.json();
    }
    // Every scene in the manifest, in the order listed.
    static sceneNames(manifest) {
        return manifest.groups.flatMap(g => g.scenes.map(s => s.name));
    }

    // dialog: the <dialog> element, with a .scene-picker-search input and a .scene-picker-groups container.
    // onSelect(test) runs when a scene is chosen. testsRoot is the tests folder relative to the page (the GPU page is
    // in gl/, the CPU page at the top level). Styles are in gl/scene-picker.css.
    constructor(dialog, manifest, onSelect, testsRoot="../tests") {
        this.dialog = dialog;
        this.testsRoot = testsRoot;
        this.onSelect = onSelect;
        this.current = null;
        this.search = dialog.querySelector(".scene-picker-search");
        this.groups = dialog.querySelector(".scene-picker-groups");

        this.descriptions = {};
        for (const group of manifest.groups)
            for (const scene of group.scenes)
                if (scene.description)
                    this.descriptions[scene.name] = scene.description;
        this.cards = [];
        for (const group of manifest.groups) {
            const section = document.createElement("section");
            const heading = document.createElement("h3");
            heading.textContent = group.title;
            const grid = document.createElement("div");
            grid.className = "scene-picker-grid";
            for (const test of group.scenes.map(s => s.name)) {
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
        if (this.descriptions[test]) {
            const description = document.createElement("span");
            description.className = "scene-card-description";
            description.textContent = this.descriptions[test];
            card.appendChild(description);
        }
        card.addEventListener("click", () => this.choose(test));
        return card;
    }
    filter(text) {
        const query = text.trim().toLowerCase();
        for (const c of this.cards)
            c.card.hidden = !!query && !c.test.toLowerCase().includes(query)
                && !(this.descriptions[c.test] || "").toLowerCase().includes(query);
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
