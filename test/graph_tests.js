const graphy = require("../src/graphy-graph");

exports.n3graphTest = function(test) {
    const graph = new graphy.RDFLibGraph()
    const jsonld = "{\n" +
        "  \"@context\": {\n" +
        "    \"@vocab\": \"http://dbpedia.org/\"\n" +
        "  },\n" +
        "  \"@id\": \"http://dbpedia.org/resource/John_Lennon\",\n" +
        "  \"name\": \"John Lennon\",\n" +
        "  \"born\": \"1940-10-09\",\n" +
        "  \"spouse\": \"http://dbpedia.org/resource/Cynthia_Lennon\"\n" +
        "}";
    graph.loadGraph(jsonld, "http://dbpedia.org/resource/John_Lennon", "application/ld+json",
        function(res) {
            graph.sparqlQuery("SELECT ?o { ?s <http://dbpedia.org/born> ?o }", function(err, data) {
                test.ok(err == null);
                test.ok(data.length === 1)
                test.ok(data[0].get("?o").value === "1940-10-09");
                test.done();
            });
        },
        function(err) {
            test.fail(err);
            test.done();
        });
}