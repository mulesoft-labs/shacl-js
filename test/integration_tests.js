var SHACLValidator = require("../index");
var tracer = require("../src/trace");
var fs = require("fs");
// expected result
var rdflibgraph = require("../src/graphy-graph");
var RDFLibGraph = rdflibgraph.RDFLibGraph;


var ExpectedValidationResult = function(solution) {
    this._id = solution["report"].value;

    this._focusNode = solution["focusNode"].termType === "BlankNode" ? "_:" + solution["focusNode"].id : solution["focusNode"].value;
    this._severity = solution["severity"].value;
    this._constraint = solution["constraint"].value;
    this._shape = solution["shape"].value;
};

ExpectedValidationResult.prototype.id = function() {
    return this._id;
}

ExpectedValidationResult.prototype.focusNode = function() {
    return this._focusNode;
};

ExpectedValidationResult.prototype.severity = function() {
    if (this._severity != null) {
        return this._severity.split("#")[1];
    }
};

ExpectedValidationResult.prototype.sourceConstraintComponent = function() {
    return this._constraint;
};

ExpectedValidationResult.prototype.sourceShape = function() {
    return this._shape
};


var ExpectedValidationReport = function(graph) {
    this.graph = graph;
};

ExpectedValidationReport.prototype.conforms = function() {
    var conforms = this.graph.query()
        .match("?report", "rdf:type", "sh:ValidationReport")
        .match("?report", "sh:conforms", "?conforms")
        .getNode("?conforms");
    return conforms != null && conforms.value === "true"
};

ExpectedValidationReport.prototype.results = function() {
    var acc = [];
    var query = this.graph.query()
        .match("?report", "sh:result", "?result")
        .match("?result", "sh:focusNode", "?focusNode")
        .match("?result", "sh:resultSeverity", "?severity")
        .match("?result", "sh:sourceConstraintComponent", "?constraint")
        .match("?result", "sh:sourceShape", "?shape");
    var solution = query.nextSolution();
    while (solution != null) {
        acc.push(new ExpectedValidationResult(solution));
        solution = query.nextSolution();
    }
    return acc;
};

var expectedResult = function(data, mediaType, cb) {
    var graph = new RDFLibGraph();
    graph.loadGraph(data, "http://test.com/example", mediaType, function() {
        var expectedValidationReport = new ExpectedValidationReport(graph);
        expectedValidationReport.results();
        cb(expectedValidationReport, null);
    }, function(e) {
        cb(null, e);
    });
};

var isBlank = function(s) {
    return s != null && (s.indexOf("_:") === 0 || s.indexOf("_g_") > -1 || s.startsWith("b"));
}

var validateReports = function(test, input) {
    var data = fs.readFileSync(input).toString();
    expectedResult(data, "text/turtle", function(expectedReport, e) {
        if (e != null) {
            console.log(e);
            test.ok(e == null);
            test.done();
        } else {
            new SHACLValidator().validate(data, "text/turtle", data, "text/turtle", function (e, report) {
                // debug
                let framesTrace = tracer.renderFrames().join("\n")
                fs.writeFileSync(input + ".trace",framesTrace,{encoding:'utf8',flag:'w'})

                if (e != null) {
                    var testCase = new RDFLibGraph();
                    testCase.loadGraph(data, input, "text/turtle", function() {
                        var maybeFailure = testCase
                            .query()
                            .match("?s","dash:expectedResult", "dash:FailureResult")
                            .hasSolution();
                        console.log(e)
                        test.ok(maybeFailure);
                        test.done();
                    }, function(e) {
                        test.ok(e == null);
                        test.done()
                    })
                } else {
                    test.ok(report.conforms() === expectedReport.conforms());
                    if (report.results().length !== expectedReport.results().length) {
                        console.log(JSON.stringify(report.results()))
                        console.log("expected:")
                        console.log(JSON.stringify(expectedReport.results()))
                    }
                    test.ok(report.results().length === expectedReport.results().length);
                    var results = report.results() || [];
                    var expectedResults = expectedReport.results();
                    for (var i=0; i <results.length; i++) {
                        found = false;
                        for (var j=0; j<expectedResults.length; j++) {
                            if (//(results[i].focusNode() ===  expectedResults[j].focusNode() ) &&
                                results[i].severity() === expectedResults[j].severity() &&
                                ( (isBlank(results[i].sourceShape()) && isBlank(expectedResults[j].sourceShape())) ||
                                  results[i].sourceShape() === expectedResults[j].sourceShape()) &&
                                results[i].sourceConstraintComponent() === expectedResults[j].sourceConstraintComponent()) {
                                found = true;
                            }
                        }
                        test.ok(found === true);
                    }
                    test.done();
                }
            });
        }
    });
};


fs.readdirSync(__dirname + "/data/core").forEach(function(dir) {
    fs.readdirSync(__dirname + "/data/core/" + dir).forEach(function(file) {
        if (!file.endsWith(".trace")) {
            if (dir === "property") {
                //if (file.indexOf("qualifiedMinCountDisjoint-001.test.ttl") > -1) {
                    exports[dir + "-test-" + file] = function (test) {
                        tracer.withTracing(true);
                        validateReports(test, __dirname + "/data/core/" + dir + "/" + file);
                    };
                //}
            }
        }
    });
});