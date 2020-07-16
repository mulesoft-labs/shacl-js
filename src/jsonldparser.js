const n3 = require("n3");
if (typeof (self) === "undefined" && typeof (window) === "undefined" && typeof (global) !== "undefined") {
    self = global;
}
const jsonld = require("./jsonld/api");
var $rdf = n3.DataFactory;


function jsonldObjectToTerm(kb, obj) {
    if (typeof obj === 'string') {
        return $rdf.literal(obj);
    }

    if (Object.prototype.hasOwnProperty.call(obj, '@list')) {
        return listToStatements(kb, obj);
    }

    if (Object.prototype.hasOwnProperty.call(obj, '@id')) {
        return $rdf.namedNode(obj['@id']);
    }

    if (Object.prototype.hasOwnProperty.call(obj, '@language')) {
        return $rdf.literal(obj['@value'], obj['@language']);
    }

    if (Object.prototype.hasOwnProperty.call(obj, '@type')) {
        return $rdf.literal(obj['@value'], $rdf.namedNode(obj['@type']));
    }

    if (Object.prototype.hasOwnProperty.call(obj, '@value')) {
        return $rdf.literal(obj['@value']);
    }

    return $rdf.literal(obj);
}

function arrayToStatements(subject, data) {
    var first = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
    var rest = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
    var nil = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';

    const statements = []
    data.reduce(function (id, _listObj, i, listData) {
        statements.push($rdf.quad(id, $rdf.namedNode(first), listData[i]))

        var nextNode
        if (i < listData.length - 1) {
            nextNode = $rdf.blankNode()
            statements.push($rdf.quad(id, $rdf.namedNode(rest), nextNode))
        } else {
            statements.push($rdf.quad(id, $rdf.namedNode(rest), $rdf.namedNode(nil)))
        }
        return nextNode
    }, subject)

    return statements
}


function listToStatements(kb, obj) {
    var listId = obj['@id'] ? $rdf.namedNode(obj['@id']) : $rdf.blankNode();
    var items = obj['@list'].map(function (listItem) {
        return jsonldObjectToTerm(kb, listItem);
    });
    var statements = arrayToStatements(listId, items);
    kb.addQuads(statements);
    return listId;
}


function parse(data, store, cb) {
    const flattened = jsonld.flatten(JSON.parse(data))
    try {
        for (var _i = 0; _i < flattened.length; _i++) {
            var flatResource = flattened[_i];
            var id = flatResource['@id'] ? $rdf.namedNode(flatResource['@id']) : $rdf.blankNode();

            for (var _j = 0, _Object$keys = Object.keys(flatResource); _j < _Object$keys.length; _j++) {
                var property = _Object$keys[_j];

                if (property === '@id') {
                    continue;
                }
                var value = flatResource[property];

                if (property === "@type") {
                    property = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
                    if (Array.isArray(value)) {
                        value = value.map(function (c) {
                            return {"@id": c}
                        });
                    } else {
                        value = {"@id": value};
                    }
                }
                if (Array.isArray(value)) {
                    for (var _k = 0; _k < value.length; _k++) {
                        store.add($rdf.quad(id, $rdf.namedNode(property), jsonldObjectToTerm(store, value[_k])));
                    }
                } else {
                    store.add($rdf.quad(id, $rdf.namedNode(property), jsonldObjectToTerm(store, value)));
                }
            }
        }
        if (cb) {
            cb(null, store);
        }
    } catch (e) {
        if (cb) {
            cb(e);
        } else {
            console.log(e);
        }
    }
}

module.exports = parse;