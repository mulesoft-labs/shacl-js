/**
 * Created by antoniogarrote on 08/05/2017.
 */

const JsonLdSerializer = require("jsonld-streaming-serializer").JsonLdSerializer;
var ValidationReport = require("./src/validation-report");
var debug = require("debug")("index");
var error = require("debug")("index::error");

var TermFactory = require("./src/rdfquery/term-factory");
var RDFQuery = require("./src/rdfquery");
var T = RDFQuery.T;
var ShapesGraph = require("./src/shapes-graph");
var ValidationEngine = require("./src/validation-engine");
var rdflibgraph = require("./src/n3-graph");
var RDFLibGraph = rdflibgraph.RDFLibGraph;
var $rdf = RDFLibGraph.$rdf;
var fs = require("fs");
var ValidationEngineConfiguration = require("./src/validation-engine-configuration");

/********************************/
/* Vocabularies                 */
/********************************/
var vocabs = require("./src/vocabularies");
var shapesGraphURI = "urn:x-shacl:shapesGraph";
var dataGraphURI = "urn:x-shacl:dataGraph";
var shaclFile = vocabs.shacl;
var dashFile = vocabs.dash;
/********************************/
/********************************/


// List utility

var createRDFListNode = function(store, items, index) {
    if (index >= items.length) {
        return T("rdf:nil");
    }
    else {
        var bnode = TermFactory.blankNode();
        store.add(bnode, T("rdf:first"), items[index]);
        store.add(bnode, T("rdf:rest"), createRDFListNode(store, items, index + 1));
        return bnode;
    }
};


// SHACL Interface
/**
 * SHACL Validator.
 * Main interface with the library
 */
var SHACLValidator = function() {
    this.$data = new RDFLibGraph();
    this.$shapes = new RDFLibGraph();
    this.depth = 0;
    this.results = null;
    this.validationEngine = null;
    this.validationError = null;
    this.sequence = null;
    this.shapesGraph = new ShapesGraph(this);
    this.configuration = new ValidationEngineConfiguration();
    this.functionsRegistry = require("./src/libraries");
};

SHACLValidator.prototype.compareNodes = function(node1, node2) {
    // TODO: Does not handle the case where nodes cannot be compared
    if (node1 && node2 && node1.isLiteral() && node2.isLiteral()) {
        if ((node1.datatype != null) !== (node2.datatype != null)) {
            return null;
        } else if (node1.datatype && node2.datatype && node1.datatype.value !== node2.datatype.value) {
            return null;
        }
    }
    return RDFQuery.compareTerms(node1, node2);
};

SHACLValidator.prototype.getConfiguration = function () {
    return this.configuration;
};

SHACLValidator.prototype.nodeConformsToShape = function(focusNode, shapeNode) {
    var shape = this.shapesGraph.getShape(shapeNode);
    try {
        this.depth++;
        return this.validationEngine.validateNodeAgainstShape(focusNode, shape, this.$data, false)
            .then((foundViolations) =>{
                return !foundViolations;
            })
            .catch((e) => {
                this.depth--;
            })
    }
    finally {
        this.depth--;
    }
}

// Data graph and Shapes graph logic


SHACLValidator.prototype.parseDataGraph = function(text, mediaType, andThen) {
    this.$data.clear();
    this.$data.loadGraph(text, dataGraphURI, mediaType, function () {
        andThen();
    }, function (ex) {
        error(ex);
    });
};

/**
 * Reloads the shapes graph.
 * It will load SHACL and DASH shapes constraints.
 */
SHACLValidator.prototype.loadDataGraph = function(rdfGraph, andThen) {
    this.$data.clear();
    this.$data.loadMemoryGraph(dataGraphURI, rdfGraph, function () {
        andThen();
    }, function(ex) {
        error(ex);
    });
};


/**
 * Validates the data graph against the shapes graph using the validation engine
 */
SHACLValidator.prototype.updateValidationEngine = function() {
    results = [];
    this.validationEngine = new ValidationEngine(this);
    this.validationEngine.setConfiguration(this.configuration);
    try {
        this.validationError = null;
        if (this.sequence) {
            this.sequence = [];
        }
        return this.validationEngine.validateAll(this.$data);
    }
    catch (ex) {
        this.validationError = ex;
        return new Promise((_, reject) => reject(ex));
    }
};

/**
 * Checks for a validation error or results in the validation
 * engine to build the RDF graph with the validation report.
 * It returns a ValidationReport object wrapping the RDF graph
 */
SHACLValidator.prototype.showValidationResults = function(cb) {
    if (this.validationError) {
        error("Validation Failure: " + this.validationError);
        throw (this.validationError);
    }
    else {

        var resultGraph = $rdf.graph();
        var reportNode = TermFactory.blankNode("report");
        resultGraph.add(reportNode, T("rdf:type"), T("sh:ValidationReport"));
        resultGraph.add(reportNode, T("sh:conforms"), T("" + (this.validationEngine.results.length == 0)));
        var nodes = {};

        for (var i = 0; i < this.validationEngine.results.length; i++) {
            var result = this.validationEngine.results[i];
            if (nodes[result[0].toString()] == null) {
                nodes[result[0].toString()] = true;
                resultGraph.add(reportNode, T("sh:result"), result[0]);
            }
            resultGraph.add(result[0], result[1], result[2]);
        }

        const mySerializer = new JsonLdSerializer({ space: '  ' });
        var acc = "";
        mySerializer
            .on('data', function(chunk) {
                acc = acc += chunk;
            })
            .on('error', cb)
            .on('end', function() {
                cb(null, new ValidationReport(JSON.parse(acc)));
            });
        const resultGraphDataSet = resultGraph.getQuads();
        for (let i=0; i< resultGraphDataSet.length; i++) {
            mySerializer.write(resultGraphDataSet[i]);
        }
        mySerializer.end();
    }
};

/**
 * Reloads the shapes graph.
 * It will load SHACL and DASH shapes constraints.
 */
SHACLValidator.prototype.parseShapesGraph = function(text, mediaType, andThen) {
    var handleError = function (ex) {
        error(ex);
    };
    var that = this;
    this.$shapes.clear();
    this.$shapes.loadGraph(text, shapesGraphURI, mediaType, function () {
        that.$shapes.loadGraph(shaclFile, "http://shacl.org", "text/turtle", function () {
            that.$shapes.loadGraph(dashFile, "http://datashapes.org/dash", "text/turtle", function () {
                andThen();
            });
        }, handleError);
    }, handleError);
};

/**
 * Reloads the shapes graph.
 * It will load SHACL and DASH shapes constraints.
 */
SHACLValidator.prototype.loadShapesGraph = function(rdfGraph, andThen) {
    var handleError = function (ex) {
        error(ex);
    };
    var that = this;
    this.$shapes.clear();
    this.$shapes.loadMemoryGraph(shapesGraphURI, rdfGraph, function () {
        that.$shapes.loadGraph(shaclFile, "http://shacl.org", "text/turtle", function () {
            that.$shapes.loadGraph(dashFile, "http://datashapes.org/dash", "text/turtle", function () {
                andThen();
            });
        }, handleError);
    }, handleError);
};


// Update validations

/**
 * Updates the data graph and validate it against the current data shapes
 */
SHACLValidator.prototype.updateDataGraph = function(text, mediaType, cb) {
    var startTime = new Date().getTime();
    this.parseDataGraph(text, mediaType, this.onDataGraphChange(startTime, cb));
};

/**
 * Updates the data graph and validate it against the current data shapes
 */
SHACLValidator.prototype.updateDataGraphRdfModel = function(dataRdfGraph, cb) {
    var startTime = new Date().getTime();
    this.loadDataGraph(dataRdfGraph, this.onDataGraphChange(startTime, cb));
};

SHACLValidator.prototype.onDataGraphChange = function(startTime, cb) {
    var that = this;
    return function() {
        var midTime = new Date().getTime();
        that.updateValidationEngine().then((_) => {
            var endTime = new Date().getTime();
            debug("Parsing took " + (midTime - startTime) + " ms. Validating the data took " + (endTime - midTime) + " ms.");
            try {
                that.showValidationResults(cb);
            } catch (e) {
                cb(e, null);
            }
        }).catch(cb);
    }
}

/**
 *  Updates the shapes graph and validates it against the current data graph
 */
SHACLValidator.prototype.updateShapesGraph = function(shapes, mediaType, cb) {
    var startTime = new Date().getTime();
    this.parseShapesGraph(shapes, mediaType, this.onShapesGraphChange(startTime, cb));
};

/**
 *  Updates the shapes graph from a memory model, and validates it against the current data graph
 */
SHACLValidator.prototype.updateShapesGraphRdfModel = function(shapesRdfGraph, cb) {
    var startTime = new Date().getTime();
    this.loadShapesGraph(shapesRdfGraph, this.onShapesGraphChange(startTime, cb));
};

SHACLValidator.prototype.onShapesGraphChange = function(startTime, cb) {
    var that = this;
    return function() {
        var midTime = new Date().getTime();
        that.shapesGraph = new ShapesGraph(that);
        var midTime2 = new Date().getTime();
        that.shapesGraph.loadJSLibraries(function (err) {
            if (err) {
                cb(err, null);
            } else {
                that.updateValidationEngine().then((e, results) => {
                    var endTime = new Date().getTime();
                    debug("Parsing took " + (midTime - startTime) + " ms. Preparing the shapes took " + (midTime2 - midTime)
                        + " ms. Validation the data took " + (endTime - midTime2) + " ms.");
                    try {

                        that.showValidationResults(cb);
                    } catch (e) {
                        cb(e, null);
                    }
                }).catch(cb);
            }
        });
    }
}

/**
 * Validates the provided data graph against the provided shapes graph
 */
SHACLValidator.prototype.validate = function (data, dataMediaType, shapes, shapesMediaType, cb) {
    var that = this;
    this.updateDataGraph(data, dataMediaType, function (e) {
        if (e != null) {
            cb(e, null);
        } else {
            that.updateShapesGraph(shapes, shapesMediaType, function (e, result) {
                if (e) {
                    cb(e, null);
                } else {
                    cb(null, result);
                }
            });
        }
    });
};


/**
* Validates the provided data graph against the provided shapes graph
*/
SHACLValidator.prototype.validateFromModels = function (dataRdfGraph, shapesRdfGraph, cb) {
    var that = this;
    this.updateDataGraphRdfModel(dataRdfGraph, function (e) {
        if (e != null) {
            cb(e, null);
        } else {
            that.updateShapesGraphRdfModel(shapesRdfGraph, function (e, result) {
                if (e) {
                    cb(e, null);
                } else {
                    cb(null, result);
                }
            });
        }
    });
};

/**
 * Saves a cached version of a remote JS file used during validation
 * @param url URL of the library to cache
 * @param localFile path to a local version of the file identified by url
 * @param cb invoked with an optional error when registration of the cached function has finished
 */
SHACLValidator.prototype.registerJSLibrary = function(url, localFile, cb){
    var that = this;
    fs.readFile(localFile, function(error, buffer) {
        if (error != null) {
            cb(error)
        } else {
            that.functionsRegistry[url]  = buffer.toString();
            cb(null)
        }
    });
};

/**
 * Saves a some JS library code using the provided URL that can be used during validation
 * @param url URL of the library to register
 * @param libraryCode JS code for the library being registered
  */
SHACLValidator.prototype.registerJSCode = function(url, jsCode){
    this.functionsRegistry[url] =  jsCode;
};

// Expose the RDF interface
SHACLValidator.$rdf = $rdf;

GlobalSHACLValidator = SHACLValidator;

module.exports = SHACLValidator;
