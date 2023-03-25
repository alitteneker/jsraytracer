export function configureTest(callback) {
    fetch("../tests/toledo/test.json_msp").then(response => {
        response.arrayBuffer().then(msg => {
            callback(Serializer.deserializeData(MessagePack.decode(msg)))
        });
    });
}