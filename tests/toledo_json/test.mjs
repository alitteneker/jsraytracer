// Loads the toledo scene from tests/toledo/test.json_msp, a MessagePack-serialized copy that isn't checked in (it's
// large). Generate it first with:  cd tests && node test_to_json.js toledo   (needs the @msgpack/msgpack package)
export function configureTest(callback) {
    const path = "../tests/toledo/test.json_msp";
    fetch(path).then(response => {
        if (!response.ok)
            throw new Error(`${path} was not found (HTTP ${response.status}). Generate it with: cd tests && node test_to_json.js toledo`);
        return response.arrayBuffer();
    }).then(msg => {
        callback(Serializer.deserializeData(MessagePack.decode(msg)));
    }).catch(e => {
        (globalThis.myconsole || console).error(String(e.message || e));
    });
}
