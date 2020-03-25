const n3 = require("n3");
const JsonLdParser = require("jsonld-streaming-parser").JsonLdParser;
const SPARQLEngine = require('@comunica/actor-init-sparql-rdfjs').newEngine;

var $rdf = n3.DataFactory;
$rdf.parse = function(data, store, namedGraph, mediaType, cb) {
    const parser = new n3.Parser({format: mediaType});
    parser.parse(data, function(error, quad, prefixes) {
        if (error) {
            cb(error)
        } else if (quad) {
            store.addQuad(quad.subject, quad.predicate, quad.object, $rdf.namedNode(namedGraph))
        } else {
            cb(null, store);
        }
    })
};
$rdf.graph = function() {
    const store = new n3.Store();

    store.add = function(s,p,o) {
        store.addQuad(s, p, o);
    };

    store.toNT = function(cb) {
        const writer = new n3.Writer({ format: 'application/n-quads' });
        store.forEach(function(quad) {
            writer.addQuad(quad.subject, quad.predicate, quad.object);
        });
        writer.end(cb)
    };


    return store;
};

var RDFQuery = require("./rdfquery");
var T = RDFQuery.T;

var errorHandler = function(e){
    require("debug")("n3-graph::error")(e);
    throw(e);
};

// Monkey Patching rdflib, Literals, BlankNodes and NamedNodes
var exLiteral = $rdf.literal("a", "de");
Object.defineProperty(Object.getPrototypeOf(exLiteral), "lex", { get: function () { return this.value } });
Object.getPrototypeOf(exLiteral).toString = function() { return this.value };
Object.getPrototypeOf(exLiteral).isBlankNode = function () { return false };
Object.getPrototypeOf(exLiteral).isLiteral = function () { return true };
Object.getPrototypeOf(exLiteral).isURI = function () { return false };

var exBlankNode = $rdf.blankNode();
Object.getPrototypeOf(exBlankNode).toString = function() { return this.id };
Object.getPrototypeOf(exBlankNode).isBlankNode = function () { return true };
Object.getPrototypeOf(exBlankNode).isLiteral = function () { return false };
Object.getPrototypeOf(exBlankNode).isURI = function () { return false };

var exNamedNode = $rdf.namedNode("urn:x-dummy");
Object.defineProperty(Object.getPrototypeOf(exNamedNode), "uri", {get: function() { return this.id }});
Object.getPrototypeOf(exNamedNode).toString = function() { return this.id };
Object.getPrototypeOf(exNamedNode).isBlankNode = function () { return false };
Object.getPrototypeOf(exNamedNode).isLiteral = function () { return false };
Object.getPrototypeOf(exNamedNode).isURI = function () { return true };


/**
 * Creates a ne RDFLibGraph wrapping a provided $rdf.graph or creating
 * a new one if no graph is provided
 * @param store rdflib graph object
 * @constructor
 */
const RDFLibGraph = function (store) {
    this.queryCache = {};

    if (store != null) {
        this.store = store;
    } else {
        this.store = $rdf.graph();
    }
};

RDFLibGraph.$rdf = $rdf;

RDFLibGraph.prototype.find = function (s, p, o) {
    return new RDFLibGraphIterator(this.store, s, p, o);
};

RDFLibGraph.prototype.query = function () {
    return RDFQuery(this);
};

RDFLibGraph.prototype.loadMemoryGraph = function(graphURI, rdfModel, andThen) {
    this.queryCache = {};
    postProcessGraph(this.store, graphURI, rdfModel)
    andThen();
};

RDFLibGraph.prototype.loadGraph = function(str, graphURI, mimeType, andThen, handleError) {
    this.queryCache = {};
    const newStore = $rdf.graph();
    handleError = handleError || errorHandler;
    const that = this;
    if (mimeType === "application/ld+json") {
        const myParser = new JsonLdParser({
            dataFactory: $rdf
        });
        myParser
            .on('data', that.store.addQuad)
            .on('error', handleError)
            .on('end', andThen);
    }
    else {
        try {
            const parser = new n3.Parser({format: 'text/turtle'});
            parser.parse(str, function(error, quad, prefixes) {
                if (error) {
                    handleError(error);
                } else if(quad) {
                    that.store.addQuad(quad)
                } else {
                    andThen()
                }
            });
        }
        catch (ex) {
            handleError(ex);
        }
    }
};

RDFLibGraph.prototype.sparqlQuery = function(sparql, cb) {
    try {
        if (this.queryCache[sparql] != null) {
            cb(null, this.queryCache[sparql]);
        } else {
            const engine = SPARQLEngine();
            let acc = [];
            const that = this;
            engine.query(sparql, {sources: [{type: 'rdfjsSource', value: this.store}]})
                .then(function (result) {
                    result.bindingsStream
                        .on('data', (data) => {
                            // Each data object contains a mapping from variables to RDFJS terms.
                            acc.push(data);
                        })
                        .on('end', () => {
                            that.queryCache[sparql] = acc;
                            cb(null, acc);
                        })
                        .on('error', cb)
                })
                .catch(cb)
        }
    } catch (e) {
        cb(e);
    }
};

RDFLibGraph.prototype.clear = function() {
    this.queryCache = {};
    this.store = $rdf.graph();
};



var RDFLibGraphIterator = function (store, s, p, o) {
    this.index = 0;
    this.ss = store.getQuads(s, p, o);
};

RDFLibGraphIterator.prototype.close = function () {
    this.queryCache = {};
    // Do nothing
};

RDFLibGraphIterator.prototype.next = function () {
    if (this.index >= this.ss.length) {
        return null;
    }
    else {
        return this.ss[this.index++];
    }
};

function ensureBlankId(component) {
    if (component.termType === "BlankNode") {
        if (typeof(component.value) !== "string") {
            component.value = "_:" + component.id;
        }
        return component;
    }

    return component
}

function postProcessGraph(store, graphURI, newStore) {

    var ss = newStore.getQuads();
    for (var i = 0; i < ss.length; i++) {
        var object = ss[i].object;
        ensureBlankId(ss[i].subject);
        ensureBlankId(ss[i].predicate);
        ensureBlankId(ss[i].object);
        if (T("xsd:boolean").equals(object.datatype)) {
            if ("0" === object.value || "false" === object.value) {
                store.add(ss[i].subject, ss[i].predicate, T("false"), graphURI);
            }
            else if ("1" === object.value || "true" === object.value) {
                store.add(ss[i].subject, ss[i].predicate, T("true"), graphURI);
            } else {
                store.add(ss[i].subject, ss[i].predicate, object, graphURI);
            }
        }
        else if (object.termType === 'collection') {
            var items = object.elements;
            store.add(ss[i].subject, ss[i].predicate, createRDFListNode(store, items, 0));
        }
        else {
            store.add(ss[i].subject, ss[i].predicate, ss[i].object, graphURI);
        }
    }

    for (var prefix in newStore.namespaces) {
        var ns = newStore.namespaces[prefix];
        store.namespaces[prefix] = ns;
    }
}

module.exports.RDFLibGraph = RDFLibGraph;
module.exports.RDFLibGraphIterator = RDFLibGraphIterator;