const dataset = require('@graphy/memory.dataset.fast');
const SPARQLEngine = require('@comunica/actor-init-sparql-rdfjs').newEngine;
const jsonldParser = require("./jsonldparser");
const ttl_read = require('@graphy/content.ttl.read');
const ttl_write = require('@graphy/content.ttl.write');

var RDFQuery = require("./rdfquery");
var T = RDFQuery.T;
var errorHandler = function(e){
    require("debug")("graphy-graph::error")(e);
    throw(e);
};


var $rdf = require("@graphy/core.data.factory");

$rdf.addQuad = function(quad) {
    this.add(quad);
};

$rdf.parse = function(data, store, namedGraph, mediaType, cb) {
    if (mediaType === "application/ld+json") {
        jsonldParser(data, store, cb);
    } else {
        ttl_read(data, {
            error: function(error) {
                debugger;
                if (cb) {
                    cb(error)
                } else {
                    console.log(error)
                }
            },
            data: function(quad) {
                store.add(quad)
            },
            eof: function() {
                if (cb) {
                    cb(null, store);
                }
            }
        });
    }
};

$rdf.graph = function() {
    const store = dataset();

    store.toNT = function(cb) {
        const writer = new ttl_write();
        var result = "";
        writer.on('data', function(turtle) {
            result = result + turtle;
        });
        writer.on('eof', function() {
            cb(data);
        });
        [...store].forEach(function(quad) {
            writer.write(quad);
        });
    };

    store.toNTSync = function() {
        var result = "";
        const writer = new ttl_write();
        writer.on('data', function(turtle) {
            result = result + turtle;
        });
        [...store].forEach(function(quad) {
            writer.write(quad);
        });
        return result;
    };

    store.getQuads = function() {
        return [...store];
    }

    return store;
};

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
        this.store = dataset();
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
    handleError = handleError || errorHandler;
    const that = this;
    if (mimeType === "application/ld+json") {
        jsonldParser(str, that.store, function(error, result) {
            if (error) {
                handleError(error)
            } else {
                andThen(result)
            }
        });
    }
    else {
        try {

            ttl_read(str, {
                error: handleError,
                data: function(quad) {
                    that.store.add(quad)
                },
                eof: andThen
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
    this.ss = store.match(s, p, o)
    this.it = this.ss[Symbol.iterator]();
};

RDFLibGraphIterator.prototype.close = function () {
    this.queryCache = {};
    // Do nothing
};

RDFLibGraphIterator.prototype.next = function () {
    if (this.index >= this.ss.size) {
        return null;
    }
    else {
        this.index++
        return this.it.next().value;
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
//    store.addAll(newStore)
    let ss;
    if (newStore.getQuads) {
        ss = newStore.getQuads();
    } else {
        ss = [...newStore];
    }
    for (var i = 0; i < ss.length; i++) {
        var object = ss[i].object;
        ensureBlankId(ss[i].subject);
        ensureBlankId(ss[i].predicate);
        ensureBlankId(ss[i].object);
        if (T("xsd:boolean").equals(object.datatype)) {
            if ("0" === object.value || "false" === object.value) {
                store.add($rdf.quad(ss[i].subject, ss[i].predicate, T("false"), T(graphURI)));
            }
            else if ("1" === object.value || "true" === object.value) {
                store.add($rdf.quad(ss[i].subject, ss[i].predicate, T("true"), T(graphURI)));
            } else {
                store.add($rdf.quad(ss[i].subject, ss[i].predicate, object, T(graphURI)));
            }
        }
        else if (object.termType === 'collection') {
            var items = object.elements;
            store.add($rdf.quad(ss[i].subject, ss[i].predicate, createRDFListNode(store, items, 0)));
        }
        else {
            store.add($rdf.quad(ss[i].subject, ss[i].predicate, ss[i].object, T(graphURI)));
        }
    }

    for (var prefix in newStore.namespaces) {
        var ns = newStore.namespaces[prefix];
        store.namespaces[prefix] = ns;
    }
}

module.exports.RDFLibGraph = RDFLibGraph;
module.exports.RDFLibGraphIterator = RDFLibGraphIterator;
