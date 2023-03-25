export function configureTest(callback) {
    fetch("../tests/dragon/test.json").then(function(response) {
        if (!response.ok)
            throw "Attempt to fetch test was not successful.";
        return response.text();
    }).then(text => {
        callback(Serializer.deserializeJSON(text));
    });
}