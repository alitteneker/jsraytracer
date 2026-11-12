// Loads the dragon scene from tests/dragon/test.json, a serialized copy that isn't checked in (it's large). Generate
// it first with:  cd tests && node test_to_json.js dragon
export function configureTest(callback) {
    const path = "../tests/dragon/test.json";
    fetch(path).then(function(response) {
        if (!response.ok)
            throw new Error(`${path} was not found (HTTP ${response.status}). Generate it with: cd tests && node test_to_json.js dragon`);
        return response.text();
    }).then(text => {
        callback(Serializer.deserializeJSON(text));
    }).catch(e => {
        (globalThis.myconsole || console).error(String(e.message || e));
    });
}
