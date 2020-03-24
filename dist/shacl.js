(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
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
        var foundViolations = this.validationEngine.validateNodeAgainstShape(focusNode, shape, this.$data);
        return !foundViolations;
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
        this.validationEngine.validateAll(this.$data);
    }
    catch (ex) {
        this.validationError = ex;
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
        that.updateValidationEngine();
        var endTime = new Date().getTime();
        debug("Parsing took " + (midTime - startTime) + " ms. Validating the data took " + (endTime - midTime) + " ms.");
        try {
            that.showValidationResults(cb);
        } catch (e) {
            cb(e, null);
        }
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
                that.updateValidationEngine();
                var endTime = new Date().getTime();
                debug("Parsing took " + (midTime - startTime) + " ms. Preparing the shapes took " + (midTime2 - midTime)
                    + " ms. Validation the data took " + (endTime - midTime2) + " ms.");
                try {

                    that.showValidationResults(cb);
                } catch (e) {
                    cb(e, null);
                }
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

module.exports = SHACLValidator;

},{"./src/libraries":111,"./src/n3-graph":112,"./src/rdfquery":113,"./src/rdfquery/term-factory":114,"./src/shapes-graph":115,"./src/validation-engine":117,"./src/validation-engine-configuration":116,"./src/validation-report":119,"./src/vocabularies":120,"debug":17,"fs":12,"jsonld-streaming-serializer":47}],2:[function(require,module,exports){
var DataFactory = require('./lib/data-factory')

module.exports = DataFactory

},{"./lib/data-factory":4}],3:[function(require,module,exports){
function BlankNode (id) {
  this.value = id || ('b' + (++BlankNode.nextId))
}

BlankNode.prototype.equals = function (other) {
  return !!other && other.termType === this.termType && other.value === this.value
}

BlankNode.prototype.termType = 'BlankNode'

BlankNode.nextId = 0

module.exports = BlankNode

},{}],4:[function(require,module,exports){
var BlankNode = require('./blank-node')
var DefaultGraph = require('./default-graph')
var Literal = require('./literal')
var NamedNode = require('./named-node')
var Quad = require('./quad')
var Variable = require('./variable')

function DataFactory () {}

DataFactory.namedNode = function (value) {
  return new NamedNode(value)
}

DataFactory.blankNode = function (value) {
  return new BlankNode(value)
}

DataFactory.literal = function (value, languageOrDatatype) {
  if (typeof languageOrDatatype === 'string') {
    if (languageOrDatatype.indexOf(':') === -1) {
      return new Literal(value, languageOrDatatype)
    }

    return new Literal(value, null, DataFactory.namedNode(languageOrDatatype))
  }

  return new Literal(value, null, languageOrDatatype)
}

DataFactory.defaultGraph = function () {
  return DataFactory.defaultGraphInstance
}

DataFactory.variable = function (value) {
  return new Variable(value)
}

DataFactory.triple = function (subject, predicate, object) {
  return DataFactory.quad(subject, predicate, object)
}

DataFactory.quad = function (subject, predicate, object, graph) {
  return new Quad(subject, predicate, object, graph || DataFactory.defaultGraphInstance)
}

DataFactory.defaultGraphInstance = new DefaultGraph()

module.exports = DataFactory

},{"./blank-node":3,"./default-graph":5,"./literal":6,"./named-node":7,"./quad":8,"./variable":9}],5:[function(require,module,exports){
function DefaultGraph () {
  this.value = ''
}

DefaultGraph.prototype.equals = function (other) {
  return !!other && other.termType === this.termType
}

DefaultGraph.prototype.termType = 'DefaultGraph'

module.exports = DefaultGraph

},{}],6:[function(require,module,exports){
var NamedNode = require('./named-node')

function Literal (value, language, datatype) {
  this.value = value
  this.datatype = Literal.stringDatatype
  this.language = ''

  if (language) {
    this.language = language
    this.datatype = Literal.langStringDatatype
  } else if (datatype) {
    this.datatype = datatype
  }
}

Literal.prototype.equals = function (other) {
  return !!other && other.termType === this.termType && other.value === this.value &&
    other.language === this.language && other.datatype.equals(this.datatype)
}

Literal.prototype.termType = 'Literal'
Literal.langStringDatatype = new NamedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#langString')
Literal.stringDatatype = new NamedNode('http://www.w3.org/2001/XMLSchema#string')

module.exports = Literal

},{"./named-node":7}],7:[function(require,module,exports){
function NamedNode (iri) {
  this.value = iri
}

NamedNode.prototype.equals = function (other) {
  return !!other && other.termType === this.termType && other.value === this.value
}

NamedNode.prototype.termType = 'NamedNode'

module.exports = NamedNode

},{}],8:[function(require,module,exports){
var DefaultGraph = require('./default-graph')

function Quad (subject, predicate, object, graph) {
  this.subject = subject
  this.predicate = predicate
  this.object = object

  if (graph) {
    this.graph = graph
  } else {
    this.graph = new DefaultGraph()
  }
}

Quad.prototype.equals = function (other) {
  return !!other && other.subject.equals(this.subject) && other.predicate.equals(this.predicate) &&
    other.object.equals(this.object) && other.graph.equals(this.graph)
}

module.exports = Quad

},{"./default-graph":5}],9:[function(require,module,exports){
function Variable (name) {
  this.value = name
}

Variable.prototype.equals = function (other) {
  return !!other && other.termType === this.termType && other.value === this.value
}

Variable.prototype.termType = 'Variable'

module.exports = Variable

},{}],10:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

// Support decoding URL-safe base64 strings, as Node.js does.
// See: https://en.wikipedia.org/wiki/Base64#URL_applications
revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function getLens (b64) {
  var len = b64.length

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // Trim off extra bytes after placeholder bytes are found
  // See: https://github.com/beatgammit/base64-js/issues/42
  var validLen = b64.indexOf('=')
  if (validLen === -1) validLen = len

  var placeHoldersLen = validLen === len
    ? 0
    : 4 - (validLen % 4)

  return [validLen, placeHoldersLen]
}

// base64 is 4/3 + up to two characters of the original data
function byteLength (b64) {
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function _byteLength (b64, validLen, placeHoldersLen) {
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function toByteArray (b64) {
  var tmp
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]

  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen))

  var curByte = 0

  // if there are placeholders, only get up to the last complete 4 chars
  var len = placeHoldersLen > 0
    ? validLen - 4
    : validLen

  var i
  for (i = 0; i < len; i += 4) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 18) |
      (revLookup[b64.charCodeAt(i + 1)] << 12) |
      (revLookup[b64.charCodeAt(i + 2)] << 6) |
      revLookup[b64.charCodeAt(i + 3)]
    arr[curByte++] = (tmp >> 16) & 0xFF
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 2) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 2) |
      (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 1) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 10) |
      (revLookup[b64.charCodeAt(i + 1)] << 4) |
      (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] +
    lookup[num >> 12 & 0x3F] +
    lookup[num >> 6 & 0x3F] +
    lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp =
      ((uint8[i] << 16) & 0xFF0000) +
      ((uint8[i + 1] << 8) & 0xFF00) +
      (uint8[i + 2] & 0xFF)
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(
      uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)
    ))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    parts.push(
      lookup[tmp >> 2] +
      lookup[(tmp << 4) & 0x3F] +
      '=='
    )
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1]
    parts.push(
      lookup[tmp >> 10] +
      lookup[(tmp >> 4) & 0x3F] +
      lookup[(tmp << 2) & 0x3F] +
      '='
    )
  }

  return parts.join('')
}

},{}],11:[function(require,module,exports){

},{}],12:[function(require,module,exports){
arguments[4][11][0].apply(exports,arguments)
},{"dup":11}],13:[function(require,module,exports){
(function (global){
/*! https://mths.be/punycode v1.4.1 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports &&
		!exports.nodeType && exports;
	var freeModule = typeof module == 'object' && module &&
		!module.nodeType && module;
	var freeGlobal = typeof global == 'object' && global;
	if (
		freeGlobal.global === freeGlobal ||
		freeGlobal.window === freeGlobal ||
		freeGlobal.self === freeGlobal
	) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^\x20-\x7E]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw new RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		var result = [];
		while (length--) {
			result[length] = fn(array[length]);
		}
		return result;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings or email
	 * addresses.
	 * @private
	 * @param {String} domain The domain name or email address.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		var parts = string.split('@');
		var result = '';
		if (parts.length > 1) {
			// In email addresses, only the domain name should be punycoded. Leave
			// the local part (i.e. everything up to `@`) intact.
			result = parts[0] + '@';
			string = parts[1];
		}
		// Avoid `split(regex)` for IE8 compatibility. See #17.
		string = string.replace(regexSeparators, '\x2E');
		var labels = string.split('.');
		var encoded = map(labels, fn).join('.');
		return result + encoded;
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <https://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * https://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols (e.g. a domain name label) to a
	 * Punycode string of ASCII-only symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name or an email address
	 * to Unicode. Only the Punycoded parts of the input will be converted, i.e.
	 * it doesn't matter if you call it on a string that has already been
	 * converted to Unicode.
	 * @memberOf punycode
	 * @param {String} input The Punycoded domain name or email address to
	 * convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(input) {
		return mapDomain(input, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name or an email address to
	 * Punycode. Only the non-ASCII parts of the domain name will be converted,
	 * i.e. it doesn't matter if you call it with a domain that's already in
	 * ASCII.
	 * @memberOf punycode
	 * @param {String} input The domain name or email address to convert, as a
	 * Unicode string.
	 * @returns {String} The Punycode representation of the given domain name or
	 * email address.
	 */
	function toASCII(input) {
		return mapDomain(input, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.4.1',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <https://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && freeModule) {
		if (module.exports == freeExports) {
			// in Node.js, io.js, or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else {
			// in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else {
		// in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],14:[function(require,module,exports){
(function (Buffer){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')
var customInspectSymbol =
  (typeof Symbol === 'function' && typeof Symbol.for === 'function')
    ? Symbol.for('nodejs.util.inspect.custom')
    : null

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    var proto = { foo: function () { return 42 } }
    Object.setPrototypeOf(proto, Uint8Array.prototype)
    Object.setPrototypeOf(arr, proto)
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

Object.defineProperty(Buffer.prototype, 'parent', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.buffer
  }
})

Object.defineProperty(Buffer.prototype, 'offset', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.byteOffset
  }
})

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('The value "' + length + '" is invalid for option "size"')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  Object.setPrototypeOf(buf, Buffer.prototype)
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new TypeError(
        'The "string" argument must be of type string. Received type number'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species != null &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  if (ArrayBuffer.isView(value)) {
    return fromArrayLike(value)
  }

  if (value == null) {
    throw new TypeError(
      'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
      'or Array-like Object. Received type ' + (typeof value)
    )
  }

  if (isInstance(value, ArrayBuffer) ||
      (value && isInstance(value.buffer, ArrayBuffer))) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof SharedArrayBuffer !== 'undefined' &&
      (isInstance(value, SharedArrayBuffer) ||
      (value && isInstance(value.buffer, SharedArrayBuffer)))) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'number') {
    throw new TypeError(
      'The "value" argument must not be of type number. Received type number'
    )
  }

  var valueOf = value.valueOf && value.valueOf()
  if (valueOf != null && valueOf !== value) {
    return Buffer.from(valueOf, encodingOrOffset, length)
  }

  var b = fromObject(value)
  if (b) return b

  if (typeof Symbol !== 'undefined' && Symbol.toPrimitive != null &&
      typeof value[Symbol.toPrimitive] === 'function') {
    return Buffer.from(
      value[Symbol.toPrimitive]('string'), encodingOrOffset, length
    )
  }

  throw new TypeError(
    'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
    'or Array-like Object. Received type ' + (typeof value)
  )
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Object.setPrototypeOf(Buffer.prototype, Uint8Array.prototype)
Object.setPrototypeOf(Buffer, Uint8Array)

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be of type number')
  } else if (size < 0) {
    throw new RangeError('The value "' + size + '" is invalid for option "size"')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('Unknown encoding: ' + encoding)
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('"offset" is outside of buffer bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('"length" is outside of buffer bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  Object.setPrototypeOf(buf, Buffer.prototype)

  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj.length !== undefined) {
    if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
      return createBuffer(0)
    }
    return fromArrayLike(obj)
  }

  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return fromArrayLike(obj.data)
  }
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true &&
    b !== Buffer.prototype // so Buffer.isBuffer(Buffer.prototype) will be false
}

Buffer.compare = function compare (a, b) {
  if (isInstance(a, Uint8Array)) a = Buffer.from(a, a.offset, a.byteLength)
  if (isInstance(b, Uint8Array)) b = Buffer.from(b, b.offset, b.byteLength)
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError(
      'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
    )
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (isInstance(buf, Uint8Array)) {
      buf = Buffer.from(buf)
    }
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    throw new TypeError(
      'The "string" argument must be one of type string, Buffer, or ArrayBuffer. ' +
      'Received type ' + typeof string
    )
  }

  var len = string.length
  var mustMatch = (arguments.length > 2 && arguments[2] === true)
  if (!mustMatch && len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) {
          return mustMatch ? -1 : utf8ToBytes(string).length // assume utf8
        }
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  str = this.toString('hex', 0, max).replace(/(.{2})/g, '$1 ').trim()
  if (this.length > max) str += ' ... '
  return '<Buffer ' + str + '>'
}
if (customInspectSymbol) {
  Buffer.prototype[customInspectSymbol] = Buffer.prototype.inspect
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (isInstance(target, Uint8Array)) {
    target = Buffer.from(target, target.offset, target.byteLength)
  }
  if (!Buffer.isBuffer(target)) {
    throw new TypeError(
      'The "target" argument must be one of type Buffer or Uint8Array. ' +
      'Received type ' + (typeof target)
    )
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset // Coerce to Number.
  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [val], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  var strLen = string.length

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (numberIsNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
        : (firstByte > 0xBF) ? 2
          : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += hexSliceLookupTable[buf[i]]
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  Object.setPrototypeOf(newBuf, Buffer.prototype)

  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!Buffer.isBuffer(target)) throw new TypeError('argument should be a Buffer')
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('Index out of range')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start

  if (this === target && typeof Uint8Array.prototype.copyWithin === 'function') {
    // Use built-in when available, missing from IE11
    this.copyWithin(targetStart, start, end)
  } else if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (var i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, end),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if ((encoding === 'utf8' && code < 128) ||
          encoding === 'latin1') {
        // Fast path: If `val` fits into a single byte, use that numeric value.
        val = code
      }
    }
  } else if (typeof val === 'number') {
    val = val & 255
  } else if (typeof val === 'boolean') {
    val = Number(val)
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : Buffer.from(val, encoding)
    var len = bytes.length
    if (len === 0) {
      throw new TypeError('The value "' + val +
        '" is invalid for argument "value"')
    }
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split('=')[0]
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

// ArrayBuffer or Uint8Array objects from other contexts (i.e. iframes) do not pass
// the `instanceof` check but they should be treated as of that type.
// See: https://github.com/feross/buffer/issues/166
function isInstance (obj, type) {
  return obj instanceof type ||
    (obj != null && obj.constructor != null && obj.constructor.name != null &&
      obj.constructor.name === type.name)
}
function numberIsNaN (obj) {
  // For IE11 support
  return obj !== obj // eslint-disable-line no-self-compare
}

// Create lookup table for `toString('hex')`
// See: https://github.com/feross/buffer/issues/219
var hexSliceLookupTable = (function () {
  var alphabet = '0123456789abcdef'
  var table = new Array(256)
  for (var i = 0; i < 16; ++i) {
    var i16 = i * 16
    for (var j = 0; j < 16; ++j) {
      table[i16 + j] = alphabet[i] + alphabet[j]
    }
  }
  return table
})()

}).call(this,require("buffer").Buffer)
},{"base64-js":10,"buffer":14,"ieee754":20}],15:[function(require,module,exports){
module.exports = {
  "100": "Continue",
  "101": "Switching Protocols",
  "102": "Processing",
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "203": "Non-Authoritative Information",
  "204": "No Content",
  "205": "Reset Content",
  "206": "Partial Content",
  "207": "Multi-Status",
  "208": "Already Reported",
  "226": "IM Used",
  "300": "Multiple Choices",
  "301": "Moved Permanently",
  "302": "Found",
  "303": "See Other",
  "304": "Not Modified",
  "305": "Use Proxy",
  "307": "Temporary Redirect",
  "308": "Permanent Redirect",
  "400": "Bad Request",
  "401": "Unauthorized",
  "402": "Payment Required",
  "403": "Forbidden",
  "404": "Not Found",
  "405": "Method Not Allowed",
  "406": "Not Acceptable",
  "407": "Proxy Authentication Required",
  "408": "Request Timeout",
  "409": "Conflict",
  "410": "Gone",
  "411": "Length Required",
  "412": "Precondition Failed",
  "413": "Payload Too Large",
  "414": "URI Too Long",
  "415": "Unsupported Media Type",
  "416": "Range Not Satisfiable",
  "417": "Expectation Failed",
  "418": "I'm a teapot",
  "421": "Misdirected Request",
  "422": "Unprocessable Entity",
  "423": "Locked",
  "424": "Failed Dependency",
  "425": "Unordered Collection",
  "426": "Upgrade Required",
  "428": "Precondition Required",
  "429": "Too Many Requests",
  "431": "Request Header Fields Too Large",
  "451": "Unavailable For Legal Reasons",
  "500": "Internal Server Error",
  "501": "Not Implemented",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
  "504": "Gateway Timeout",
  "505": "HTTP Version Not Supported",
  "506": "Variant Also Negotiates",
  "507": "Insufficient Storage",
  "508": "Loop Detected",
  "509": "Bandwidth Limit Exceeded",
  "510": "Not Extended",
  "511": "Network Authentication Required"
}

},{}],16:[function(require,module,exports){
(function (Buffer){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.

function isArray(arg) {
  if (Array.isArray) {
    return Array.isArray(arg);
  }
  return objectToString(arg) === '[object Array]';
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = Buffer.isBuffer;

function objectToString(o) {
  return Object.prototype.toString.call(o);
}

}).call(this,{"isBuffer":require("../../is-buffer/index.js")})
},{"../../is-buffer/index.js":22}],17:[function(require,module,exports){
(function (process){
/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = require('./debug');
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = 'undefined' != typeof chrome
               && 'undefined' != typeof chrome.storage
                  ? chrome.storage.local
                  : localstorage();

/**
 * Colors.
 */

exports.colors = [
  'lightseagreen',
  'forestgreen',
  'goldenrod',
  'dodgerblue',
  'darkorchid',
  'crimson'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // NB: In an Electron preload script, document will be defined but not fully
  // initialized. Since we know we're in Chrome, we'll just detect this case
  // explicitly
  if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
    return true;
  }

  // is webkit? http://stackoverflow.com/a/16459606/376773
  // document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
  return (typeof document !== 'undefined' && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (typeof window !== 'undefined' && window.console && (window.console.firebug || (window.console.exception && window.console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
    // double check webkit in userAgent just in case we are in a worker
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  try {
    return JSON.stringify(v);
  } catch (err) {
    return '[UnexpectedJSONParseError]: ' + err.message;
  }
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs(args) {
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return;

  var c = 'color: ' + this.color;
  args.splice(1, 0, c, 'color: inherit')

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-zA-Z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      exports.storage.removeItem('debug');
    } else {
      exports.storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  var r;
  try {
    r = exports.storage.debug;
  } catch(e) {}

  // If debug isn't set in LS, and we're in Electron, try to load $DEBUG
  if (!r && typeof process !== 'undefined' && 'env' in process) {
    r = process.env.DEBUG;
  }

  return r;
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage() {
  try {
    return window.localStorage;
  } catch (e) {}
}

}).call(this,require('_process'))
},{"./debug":18,"_process":63}],18:[function(require,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = createDebug.debug = createDebug['default'] = createDebug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = require('ms');

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lower or upper-case letter, i.e. "n" and "N".
 */

exports.formatters = {};

/**
 * Previous log timestamp.
 */

var prevTime;

/**
 * Select a color.
 * @param {String} namespace
 * @return {Number}
 * @api private
 */

function selectColor(namespace) {
  var hash = 0, i;

  for (i in namespace) {
    hash  = ((hash << 5) - hash) + namespace.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  return exports.colors[Math.abs(hash) % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function createDebug(namespace) {

  function debug() {
    // disabled?
    if (!debug.enabled) return;

    var self = debug;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // turn the `arguments` into a proper Array
    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %O
      args.unshift('%O');
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-zA-Z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    // apply env-specific formatting (colors, etc.)
    exports.formatArgs.call(self, args);

    var logFn = debug.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }

  debug.namespace = namespace;
  debug.enabled = exports.enabled(namespace);
  debug.useColors = exports.useColors();
  debug.color = selectColor(namespace);

  // env-specific initialization logic for debug instances
  if ('function' === typeof exports.init) {
    exports.init(debug);
  }

  return debug;
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  exports.names = [];
  exports.skips = [];

  var split = (typeof namespaces === 'string' ? namespaces : '').split(/[\s,]+/);
  var len = split.length;

  for (var i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

},{"ms":51}],19:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var objectCreate = Object.create || objectCreatePolyfill
var objectKeys = Object.keys || objectKeysPolyfill
var bind = Function.prototype.bind || functionBindPolyfill

function EventEmitter() {
  if (!this._events || !Object.prototype.hasOwnProperty.call(this, '_events')) {
    this._events = objectCreate(null);
    this._eventsCount = 0;
  }

  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
var defaultMaxListeners = 10;

var hasDefineProperty;
try {
  var o = {};
  if (Object.defineProperty) Object.defineProperty(o, 'x', { value: 0 });
  hasDefineProperty = o.x === 0;
} catch (err) { hasDefineProperty = false }
if (hasDefineProperty) {
  Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
    enumerable: true,
    get: function() {
      return defaultMaxListeners;
    },
    set: function(arg) {
      // check whether the input is a positive number (whose value is zero or
      // greater and not a NaN).
      if (typeof arg !== 'number' || arg < 0 || arg !== arg)
        throw new TypeError('"defaultMaxListeners" must be a positive number');
      defaultMaxListeners = arg;
    }
  });
} else {
  EventEmitter.defaultMaxListeners = defaultMaxListeners;
}

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
  if (typeof n !== 'number' || n < 0 || isNaN(n))
    throw new TypeError('"n" argument must be a positive number');
  this._maxListeners = n;
  return this;
};

function $getMaxListeners(that) {
  if (that._maxListeners === undefined)
    return EventEmitter.defaultMaxListeners;
  return that._maxListeners;
}

EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  return $getMaxListeners(this);
};

// These standalone emit* functions are used to optimize calling of event
// handlers for fast cases because emit() itself often has a variable number of
// arguments and can be deoptimized because of that. These functions always have
// the same number of arguments and thus do not get deoptimized, so the code
// inside them can execute faster.
function emitNone(handler, isFn, self) {
  if (isFn)
    handler.call(self);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self);
  }
}
function emitOne(handler, isFn, self, arg1) {
  if (isFn)
    handler.call(self, arg1);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1);
  }
}
function emitTwo(handler, isFn, self, arg1, arg2) {
  if (isFn)
    handler.call(self, arg1, arg2);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1, arg2);
  }
}
function emitThree(handler, isFn, self, arg1, arg2, arg3) {
  if (isFn)
    handler.call(self, arg1, arg2, arg3);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1, arg2, arg3);
  }
}

function emitMany(handler, isFn, self, args) {
  if (isFn)
    handler.apply(self, args);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].apply(self, args);
  }
}

EventEmitter.prototype.emit = function emit(type) {
  var er, handler, len, args, i, events;
  var doError = (type === 'error');

  events = this._events;
  if (events)
    doError = (doError && events.error == null);
  else if (!doError)
    return false;

  // If there is no 'error' event listener then throw.
  if (doError) {
    if (arguments.length > 1)
      er = arguments[1];
    if (er instanceof Error) {
      throw er; // Unhandled 'error' event
    } else {
      // At least give some kind of context to the user
      var err = new Error('Unhandled "error" event. (' + er + ')');
      err.context = er;
      throw err;
    }
    return false;
  }

  handler = events[type];

  if (!handler)
    return false;

  var isFn = typeof handler === 'function';
  len = arguments.length;
  switch (len) {
      // fast cases
    case 1:
      emitNone(handler, isFn, this);
      break;
    case 2:
      emitOne(handler, isFn, this, arguments[1]);
      break;
    case 3:
      emitTwo(handler, isFn, this, arguments[1], arguments[2]);
      break;
    case 4:
      emitThree(handler, isFn, this, arguments[1], arguments[2], arguments[3]);
      break;
      // slower
    default:
      args = new Array(len - 1);
      for (i = 1; i < len; i++)
        args[i - 1] = arguments[i];
      emitMany(handler, isFn, this, args);
  }

  return true;
};

function _addListener(target, type, listener, prepend) {
  var m;
  var events;
  var existing;

  if (typeof listener !== 'function')
    throw new TypeError('"listener" argument must be a function');

  events = target._events;
  if (!events) {
    events = target._events = objectCreate(null);
    target._eventsCount = 0;
  } else {
    // To avoid recursion in the case that type === "newListener"! Before
    // adding it to the listeners, first emit "newListener".
    if (events.newListener) {
      target.emit('newListener', type,
          listener.listener ? listener.listener : listener);

      // Re-assign `events` because a newListener handler could have caused the
      // this._events to be assigned to a new object
      events = target._events;
    }
    existing = events[type];
  }

  if (!existing) {
    // Optimize the case of one listener. Don't need the extra array object.
    existing = events[type] = listener;
    ++target._eventsCount;
  } else {
    if (typeof existing === 'function') {
      // Adding the second element, need to change to array.
      existing = events[type] =
          prepend ? [listener, existing] : [existing, listener];
    } else {
      // If we've already got an array, just append.
      if (prepend) {
        existing.unshift(listener);
      } else {
        existing.push(listener);
      }
    }

    // Check for listener leak
    if (!existing.warned) {
      m = $getMaxListeners(target);
      if (m && m > 0 && existing.length > m) {
        existing.warned = true;
        var w = new Error('Possible EventEmitter memory leak detected. ' +
            existing.length + ' "' + String(type) + '" listeners ' +
            'added. Use emitter.setMaxListeners() to ' +
            'increase limit.');
        w.name = 'MaxListenersExceededWarning';
        w.emitter = target;
        w.type = type;
        w.count = existing.length;
        if (typeof console === 'object' && console.warn) {
          console.warn('%s: %s', w.name, w.message);
        }
      }
    }
  }

  return target;
}

EventEmitter.prototype.addListener = function addListener(type, listener) {
  return _addListener(this, type, listener, false);
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.prependListener =
    function prependListener(type, listener) {
      return _addListener(this, type, listener, true);
    };

function onceWrapper() {
  if (!this.fired) {
    this.target.removeListener(this.type, this.wrapFn);
    this.fired = true;
    switch (arguments.length) {
      case 0:
        return this.listener.call(this.target);
      case 1:
        return this.listener.call(this.target, arguments[0]);
      case 2:
        return this.listener.call(this.target, arguments[0], arguments[1]);
      case 3:
        return this.listener.call(this.target, arguments[0], arguments[1],
            arguments[2]);
      default:
        var args = new Array(arguments.length);
        for (var i = 0; i < args.length; ++i)
          args[i] = arguments[i];
        this.listener.apply(this.target, args);
    }
  }
}

function _onceWrap(target, type, listener) {
  var state = { fired: false, wrapFn: undefined, target: target, type: type, listener: listener };
  var wrapped = bind.call(onceWrapper, state);
  wrapped.listener = listener;
  state.wrapFn = wrapped;
  return wrapped;
}

EventEmitter.prototype.once = function once(type, listener) {
  if (typeof listener !== 'function')
    throw new TypeError('"listener" argument must be a function');
  this.on(type, _onceWrap(this, type, listener));
  return this;
};

EventEmitter.prototype.prependOnceListener =
    function prependOnceListener(type, listener) {
      if (typeof listener !== 'function')
        throw new TypeError('"listener" argument must be a function');
      this.prependListener(type, _onceWrap(this, type, listener));
      return this;
    };

// Emits a 'removeListener' event if and only if the listener was removed.
EventEmitter.prototype.removeListener =
    function removeListener(type, listener) {
      var list, events, position, i, originalListener;

      if (typeof listener !== 'function')
        throw new TypeError('"listener" argument must be a function');

      events = this._events;
      if (!events)
        return this;

      list = events[type];
      if (!list)
        return this;

      if (list === listener || list.listener === listener) {
        if (--this._eventsCount === 0)
          this._events = objectCreate(null);
        else {
          delete events[type];
          if (events.removeListener)
            this.emit('removeListener', type, list.listener || listener);
        }
      } else if (typeof list !== 'function') {
        position = -1;

        for (i = list.length - 1; i >= 0; i--) {
          if (list[i] === listener || list[i].listener === listener) {
            originalListener = list[i].listener;
            position = i;
            break;
          }
        }

        if (position < 0)
          return this;

        if (position === 0)
          list.shift();
        else
          spliceOne(list, position);

        if (list.length === 1)
          events[type] = list[0];

        if (events.removeListener)
          this.emit('removeListener', type, originalListener || listener);
      }

      return this;
    };

EventEmitter.prototype.removeAllListeners =
    function removeAllListeners(type) {
      var listeners, events, i;

      events = this._events;
      if (!events)
        return this;

      // not listening for removeListener, no need to emit
      if (!events.removeListener) {
        if (arguments.length === 0) {
          this._events = objectCreate(null);
          this._eventsCount = 0;
        } else if (events[type]) {
          if (--this._eventsCount === 0)
            this._events = objectCreate(null);
          else
            delete events[type];
        }
        return this;
      }

      // emit removeListener for all listeners on all events
      if (arguments.length === 0) {
        var keys = objectKeys(events);
        var key;
        for (i = 0; i < keys.length; ++i) {
          key = keys[i];
          if (key === 'removeListener') continue;
          this.removeAllListeners(key);
        }
        this.removeAllListeners('removeListener');
        this._events = objectCreate(null);
        this._eventsCount = 0;
        return this;
      }

      listeners = events[type];

      if (typeof listeners === 'function') {
        this.removeListener(type, listeners);
      } else if (listeners) {
        // LIFO order
        for (i = listeners.length - 1; i >= 0; i--) {
          this.removeListener(type, listeners[i]);
        }
      }

      return this;
    };

function _listeners(target, type, unwrap) {
  var events = target._events;

  if (!events)
    return [];

  var evlistener = events[type];
  if (!evlistener)
    return [];

  if (typeof evlistener === 'function')
    return unwrap ? [evlistener.listener || evlistener] : [evlistener];

  return unwrap ? unwrapListeners(evlistener) : arrayClone(evlistener, evlistener.length);
}

EventEmitter.prototype.listeners = function listeners(type) {
  return _listeners(this, type, true);
};

EventEmitter.prototype.rawListeners = function rawListeners(type) {
  return _listeners(this, type, false);
};

EventEmitter.listenerCount = function(emitter, type) {
  if (typeof emitter.listenerCount === 'function') {
    return emitter.listenerCount(type);
  } else {
    return listenerCount.call(emitter, type);
  }
};

EventEmitter.prototype.listenerCount = listenerCount;
function listenerCount(type) {
  var events = this._events;

  if (events) {
    var evlistener = events[type];

    if (typeof evlistener === 'function') {
      return 1;
    } else if (evlistener) {
      return evlistener.length;
    }
  }

  return 0;
}

EventEmitter.prototype.eventNames = function eventNames() {
  return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
};

// About 1.5x faster than the two-arg version of Array#splice().
function spliceOne(list, index) {
  for (var i = index, k = i + 1, n = list.length; k < n; i += 1, k += 1)
    list[i] = list[k];
  list.pop();
}

function arrayClone(arr, n) {
  var copy = new Array(n);
  for (var i = 0; i < n; ++i)
    copy[i] = arr[i];
  return copy;
}

function unwrapListeners(arr) {
  var ret = new Array(arr.length);
  for (var i = 0; i < ret.length; ++i) {
    ret[i] = arr[i].listener || arr[i];
  }
  return ret;
}

function objectCreatePolyfill(proto) {
  var F = function() {};
  F.prototype = proto;
  return new F;
}
function objectKeysPolyfill(obj) {
  var keys = [];
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
    keys.push(k);
  }
  return k;
}
function functionBindPolyfill(context) {
  var fn = this;
  return function () {
    return fn.apply(context, arguments);
  };
}

},{}],20:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = (e * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = (m * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = ((value * c) - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],21:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    if (superCtor) {
      ctor.super_ = superCtor
      ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
          value: ctor,
          enumerable: false,
          writable: true,
          configurable: true
        }
      })
    }
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    if (superCtor) {
      ctor.super_ = superCtor
      var TempCtor = function () {}
      TempCtor.prototype = superCtor.prototype
      ctor.prototype = new TempCtor()
      ctor.prototype.constructor = ctor
    }
  }
}

},{}],22:[function(require,module,exports){
/*!
 * Determine if an object is a Buffer
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */

// The _isBuffer check is for Safari 5-7 support, because it's missing
// Object.prototype.constructor. Remove this eventually
module.exports = function (obj) {
  return obj != null && (isBuffer(obj) || isSlowBuffer(obj) || !!obj._isBuffer)
}

function isBuffer (obj) {
  return !!obj.constructor && typeof obj.constructor.isBuffer === 'function' && obj.constructor.isBuffer(obj)
}

// For Node v0.10 support. Remove this eventually.
function isSlowBuffer (obj) {
  return typeof obj.readFloatLE === 'function' && typeof obj.slice === 'function' && isBuffer(obj.slice(0, 0))
}

},{}],23:[function(require,module,exports){
var toString = {}.toString;

module.exports = Array.isArray || function (arr) {
  return toString.call(arr) == '[object Array]';
};

},{}],24:[function(require,module,exports){
// the whatwg-fetch polyfill installs the fetch() function
// on the global object (window or self)
//
// Return that as the export for use in Webpack, Browserify etc.
require('whatwg-fetch');
module.exports = self.fetch.bind(self);

},{"whatwg-fetch":109}],25:[function(require,module,exports){
"use strict";
function __export(m) {
    for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
}
Object.defineProperty(exports, "__esModule", { value: true });
__export(require("./lib/ContextParser"));
__export(require("./lib/FetchDocumentLoader"));

},{"./lib/ContextParser":26,"./lib/FetchDocumentLoader":27}],26:[function(require,module,exports){
"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
require("isomorphic-fetch");
const relative_to_absolute_iri_1 = require("relative-to-absolute-iri");
const FetchDocumentLoader_1 = require("./FetchDocumentLoader");
/**
 * Parses JSON-LD contexts.
 */
class ContextParser {
    constructor(options) {
        options = options || {};
        this.documentLoader = options.documentLoader || new FetchDocumentLoader_1.FetchDocumentLoader();
        this.documentCache = {};
        this.validate = !options.skipValidation;
        this.expandContentTypeToBase = options.expandContentTypeToBase;
    }
    /**
     * Check if the given term is a valid compact IRI.
     * Otherwise, it may be an IRI.
     * @param {string} term A term.
     * @return {boolean} If it is a compact IRI.
     */
    static isCompactIri(term) {
        return term.indexOf(':') >= 0 && !(term && term[0] === '#');
    }
    /**
     * Get the prefix from the given term.
     * @see https://json-ld.org/spec/latest/json-ld/#compact-iris
     * @param {string} term A term that is an URL or a prefixed URL.
     * @param {IJsonLdContextNormalized} context A context.
     * @return {string} The prefix or null.
     */
    static getPrefix(term, context) {
        // Do not consider relative IRIs starting with a hash as compact IRIs
        if (term && term[0] === '#') {
            return null;
        }
        const separatorPos = term.indexOf(':');
        if (separatorPos >= 0) {
            // Suffix can not begin with two slashes
            if (term.length > separatorPos + 1
                && term.charAt(separatorPos + 1) === '/'
                && term.charAt(separatorPos + 2) === '/') {
                return null;
            }
            const prefix = term.substr(0, separatorPos);
            // Prefix can not be an underscore (this is a blank node)
            if (prefix === '_') {
                return null;
            }
            // Prefix must match a term in the active context
            if (context[prefix]) {
                return prefix;
            }
        }
        return null;
    }
    /**
     * From a given context entry value, get the string value, or the @id field.
     * @param contextValue A value for a term in a context.
     * @return {string} The id value, or null.
     */
    static getContextValueId(contextValue) {
        if (contextValue === null || typeof contextValue === 'string') {
            return contextValue;
        }
        const id = contextValue['@id'];
        return id ? id : null;
    }
    /**
     * Expand the term or prefix of the given term if it has one,
     * otherwise return the term as-is.
     *
     * This will try to expand the IRI as much as possible.
     *
     * Iff in vocab-mode, then other references to other terms in the context can be used,
     * such as to `myTerm`:
     * ```
     * {
     *   "myTerm": "http://example.org/myLongTerm"
     * }
     * ```
     *
     * @param {string} term A term that is an URL or a prefixed URL.
     * @param {IJsonLdContextNormalized} context A context.
     * @param {boolean} vocab If the term is a predicate or type and should be expanded based on @vocab,
     *                        otherwise it is considered a regular term that is expanded based on @base.
     * @return {string} The expanded term, the term as-is, or null if it was explicitly disabled in the context.
     */
    static expandTerm(term, context, vocab) {
        ContextParser.assertNormalized(context);
        const contextValue = context[term];
        // Immediately return if the term was disabled in the context
        if (contextValue === null || (contextValue && contextValue['@id'] === null)) {
            return null;
        }
        // Check the @id
        if (contextValue && vocab) {
            const value = this.getContextValueId(contextValue);
            if (value && value !== term) {
                return value;
            }
        }
        // Check if the term is prefixed
        const prefix = ContextParser.getPrefix(term, context);
        if (prefix) {
            const value = this.getContextValueId(context[prefix]);
            if (value) {
                return value + term.substr(prefix.length + 1);
            }
        }
        else if (vocab && context['@vocab'] && term.charAt(0) !== '@' && !ContextParser.isCompactIri(term)) {
            return context['@vocab'] + term;
        }
        else if (!vocab && context['@base'] && term.charAt(0) !== '@' && !ContextParser.isCompactIri(term)) {
            return relative_to_absolute_iri_1.resolve(term, context['@base']);
        }
        return term;
    }
    /**
     * Compact the given term using @base, @vocab, an aliased term, or a prefixed term.
     *
     * This will try to compact the IRI as much as possible.
     *
     * @param {string} iri An IRI to compact.
     * @param {IJsonLdContextNormalized} context The context to compact with.
     * @param {boolean} vocab If the term is a predicate or type and should be compacted based on @vocab,
     *                        otherwise it is considered a regular term that is compacted based on @base.
     * @return {string} The compacted term or the IRI as-is.
     */
    static compactIri(iri, context, vocab) {
        ContextParser.assertNormalized(context);
        // Try @vocab compacting
        if (vocab && context['@vocab'] && iri.startsWith(context['@vocab'])) {
            return iri.substr(context['@vocab'].length);
        }
        // Try @base compacting
        if (!vocab && context['@base'] && iri.startsWith(context['@base'])) {
            return iri.substr(context['@base'].length);
        }
        // Loop over all terms in the context
        // This will try to prefix as short as possible.
        // Once a fully compacted alias is found, return immediately, as we can not go any shorter.
        const shortestPrefixing = { prefix: '', suffix: iri };
        for (const key in context) {
            const value = context[key];
            if (value && !key.startsWith('@')) {
                const contextIri = this.getContextValueId(value);
                if (iri.startsWith(contextIri)) {
                    const suffix = iri.substr(contextIri.length);
                    if (!suffix) {
                        if (vocab) {
                            // Immediately return on compacted alias
                            return key;
                        }
                    }
                    else if (suffix.length < shortestPrefixing.suffix.length) {
                        // Overwrite the shortest prefix
                        shortestPrefixing.prefix = key;
                        shortestPrefixing.suffix = suffix;
                    }
                }
            }
        }
        // Return the shortest prefix
        if (shortestPrefixing.prefix) {
            return shortestPrefixing.prefix + ':' + shortestPrefixing.suffix;
        }
        return iri;
    }
    /**
     * An an assert to check if the given context has been normalized.
     * An error will be thrown otherwise.
     * @param {JsonLdContext} context A context.
     */
    static assertNormalized(context) {
        if (typeof context === 'string' || Array.isArray(context) || context['@context']) {
            throw new Error('The given context is not normalized. Make sure to call ContextParser.parse() first.');
        }
    }
    /**
     * Check if the given context value can be a prefix value.
     * @param value A context value.
     * @return {boolean} If it can be a prefix value.
     */
    static isPrefixValue(value) {
        return value && (typeof value === 'string' || value['@id'] || value['@type']);
    }
    /**
     * Check if the given IRI is valid.
     * @param {string} iri A potential IRI.
     * @return {boolean} If the given IRI is valid.
     */
    static isValidIri(iri) {
        return ContextParser.IRI_REGEX.test(iri);
    }
    /**
     * Add an @id term for all @reverse terms.
     * @param {IJsonLdContextNormalized} context A context.
     * @return {IJsonLdContextNormalized} The mutated input context.
     */
    static idifyReverseTerms(context) {
        for (const key of Object.keys(context)) {
            const value = context[key];
            if (value && typeof value === 'object') {
                if (value['@reverse'] && !value['@id']) {
                    if (typeof value['@reverse'] !== 'string') {
                        throw new Error(`Invalid @reverse value: '${value['@reverse']}'`);
                    }
                    value['@id'] = value['@reverse'];
                    value['@reverse'] = true;
                }
            }
        }
        return context;
    }
    /**
     * Expand all prefixed terms in the given context.
     * @param {IJsonLdContextNormalized} context A context.
     * @param {boolean} expandContentTypeToBase If @type inside the context may be expanded
     *                                          via @base if @vocab is set to null.
     * @return {IJsonLdContextNormalized} The mutated input context.
     */
    static expandPrefixedTerms(context, expandContentTypeToBase) {
        for (const key of Object.keys(context)) {
            // Only expand allowed keys
            if (ContextParser.EXPAND_KEYS_BLACKLIST.indexOf(key) < 0) {
                // Error if we try to alias a keyword to something else.
                if (key[0] === '@' && ContextParser.ALIAS_KEYS_BLACKLIST.indexOf(key) >= 0) {
                    throw new Error(`Keywords can not be aliased to something else.
Tried mapping ${key} to ${context[key]}`);
                }
                // Loop because prefixes might be nested
                while (ContextParser.isPrefixValue(context[key])) {
                    const value = context[key];
                    let changed = false;
                    if (typeof value === 'string') {
                        context[key] = ContextParser.expandTerm(value, context, true);
                        changed = changed || value !== context[key];
                    }
                    else {
                        const id = value['@id'];
                        const type = value['@type'];
                        if (id) {
                            context[key]['@id'] = ContextParser.expandTerm(id, context, true);
                            changed = changed || id !== context[key]['@id'];
                        }
                        if (type && type !== '@vocab') {
                            // First check @vocab, then fallback to @base
                            context[key]['@type'] = ContextParser.expandTerm(type, context, true);
                            if (expandContentTypeToBase && type === context[key]['@type']) {
                                context[key]['@type'] = ContextParser.expandTerm(type, context, false);
                            }
                            changed = changed || type !== context[key]['@type'];
                        }
                    }
                    if (!changed) {
                        break;
                    }
                }
            }
        }
        return context;
    }
    /**
     * Normalize the @language entries in the given context to lowercase.
     * @param {IJsonLdContextNormalized} context A context.
     * @return {IJsonLdContextNormalized} The mutated input context.
     */
    static normalize(context) {
        for (const key of Object.keys(context)) {
            if (key === '@language' && typeof context[key] === 'string') {
                context[key] = context[key].toLowerCase();
            }
            else {
                const value = context[key];
                if (value && typeof value === 'object') {
                    if (typeof value['@language'] === 'string') {
                        value['@language'] = value['@language'].toLowerCase();
                    }
                }
            }
        }
        return context;
    }
    /**
     * Validate the entries of the given context.
     * @param {IJsonLdContextNormalized} context A context.
     */
    static validate(context) {
        for (const key of Object.keys(context)) {
            const value = context[key];
            const valueType = typeof value;
            // First check if the key is a keyword
            if (key[0] === '@') {
                switch (key.substr(1)) {
                    case 'vocab':
                        if (value !== null && valueType !== 'string') {
                            throw new Error(`Found an invalid @vocab IRI: ${value}`);
                        }
                        break;
                    case 'base':
                        if (value !== null && valueType !== 'string') {
                            throw new Error(`Found an invalid @base IRI: ${context[key]}`);
                        }
                        break;
                    case 'language':
                        if (value !== null && valueType !== 'string') {
                            throw new Error(`Found an invalid @language string: ${value}`);
                        }
                        break;
                }
            }
            // Otherwise, consider the key a term
            if (value !== null) {
                switch (valueType) {
                    case 'string':
                        // Always valid
                        break;
                    case 'object':
                        if (!ContextParser.isCompactIri(key) && !('@id' in value)
                            && (value['@type'] === '@id' ? !context['@base'] : !context['@vocab'])) {
                            throw new Error(`Missing @id in context entry: '${key}': '${JSON.stringify(value)}'`);
                        }
                        for (const objectKey of Object.keys(value)) {
                            const objectValue = value[objectKey];
                            if (!objectValue) {
                                continue;
                            }
                            switch (objectKey) {
                                case '@id':
                                    if (objectValue[0] === '@' && objectValue !== '@type' && objectValue !== '@id') {
                                        throw new Error(`Illegal keyword alias in term value, found: '${key}': '${JSON.stringify(value)}'`);
                                    }
                                    break;
                                case '@type':
                                    if (objectValue !== '@id' && objectValue !== '@vocab'
                                        && (objectValue[0] === '_' || !ContextParser.isValidIri(objectValue))) {
                                        throw new Error(`A context @type must be an absolute IRI, found: '${key}': '${objectValue}'`);
                                    }
                                    break;
                                case '@reverse':
                                    if (typeof objectValue === 'string' && value['@id'] && value['@id'] !== objectValue) {
                                        throw new Error(`Found non-matching @id and @reverse term values in '${key}':\
'${objectValue}' and '${value['@id']}'`);
                                    }
                                    break;
                                case '@container':
                                    if (objectValue === '@list' && value['@reverse']) {
                                        throw new Error(`Term value can not be @container: @list and @reverse at the same time on '${key}'`);
                                    }
                                    if (ContextParser.CONTAINERS.indexOf(objectValue) < 0) {
                                        throw new Error(`Invalid term @container for '${key}' ('${objectValue}'), \
must be one of ${ContextParser.CONTAINERS.join(', ')}`);
                                    }
                                    break;
                                case '@language':
                                    if (objectValue !== null && typeof objectValue !== 'string') {
                                        throw new Error(`Found an invalid term @language string in: '${key}': '${JSON.stringify(value)}'`);
                                    }
                                    break;
                            }
                        }
                        break;
                    default:
                        throw new Error(`Found an invalid term value: '${key}': '${value}'`);
                }
            }
        }
    }
    /**
     * Resolve relative context IRIs, or return full IRIs as-is.
     * @param {string} contextIri A context IRI.
     * @param {string} baseIri A base IRI.
     * @return {string} The normalized context IRI.
     */
    static normalizeContextIri(contextIri, baseIri) {
        if (!ContextParser.isValidIri(contextIri)) {
            contextIri = relative_to_absolute_iri_1.resolve(contextIri, baseIri);
            if (!ContextParser.isValidIri(contextIri)) {
                throw new Error(`Invalid context IRI: ${contextIri}`);
            }
        }
        return contextIri;
    }
    /**
     * Parse a JSON-LD context in any form.
     * @param {JsonLdContext} context A context, URL to a context, or an array of contexts/URLs.
     * @param {IParseOptions} options Optional parsing options.
     * @return {Promise<IJsonLdContextNormalized>} A promise resolving to the context.
     */
    parse(context, { baseIri, parentContext, external } = {}) {
        return __awaiter(this, void 0, void 0, function* () {
            if (context === null || context === undefined) {
                // Context that are explicitly set to null are empty.
                return baseIri ? { '@base': baseIri } : {};
            }
            else if (typeof context === 'string') {
                return this.parse(yield this.load(ContextParser.normalizeContextIri(context, baseIri)), { baseIri, parentContext, external: true });
            }
            else if (Array.isArray(context)) {
                // As a performance consideration, first load all external contexts in parallel.
                const contexts = yield Promise.all(context.map((subContext) => {
                    if (typeof subContext === 'string') {
                        return this.load(ContextParser.normalizeContextIri(subContext, baseIri));
                    }
                    else {
                        return subContext;
                    }
                }));
                return contexts.reduce((accContextPromise, contextEntry) => accContextPromise
                    .then((accContext) => this.parse(contextEntry, {
                    baseIri: accContext && accContext['@base'] || baseIri,
                    external,
                    parentContext: accContext,
                })), Promise.resolve(parentContext));
            }
            else if (typeof context === 'object') {
                if (context['@context']) {
                    return yield this.parse(context['@context'], { baseIri, parentContext, external });
                }
                // Make a deep clone of the given context, to avoid modifying it.
                context = JSON.parse(JSON.stringify(context)); // No better way in JS at the moment...
                // We have an actual context object.
                let newContext = {};
                // According to the JSON-LD spec, @base must be ignored from external contexts.
                if (external) {
                    delete context['@base'];
                }
                // Override the base IRI if provided.
                if (baseIri) {
                    if (!('@base' in context)) {
                        // The context base is the document base
                        context['@base'] = baseIri;
                    }
                    else if (context['@base'] !== null && !ContextParser.isValidIri(context['@base'])) {
                        // The context base is relative to the document base
                        context['@base'] = relative_to_absolute_iri_1.resolve(context['@base'], baseIri);
                    }
                }
                newContext = Object.assign({}, newContext, parentContext, context);
                ContextParser.idifyReverseTerms(newContext);
                ContextParser.expandPrefixedTerms(newContext, this.expandContentTypeToBase);
                ContextParser.normalize(newContext);
                if (this.validate) {
                    ContextParser.validate(newContext);
                }
                return newContext;
            }
            else {
                throw new Error(`Tried parsing a context that is not a string, array or object, but got ${context}`);
            }
        });
    }
    load(url) {
        return __awaiter(this, void 0, void 0, function* () {
            const cached = this.documentCache[url];
            if (cached) {
                return Array.isArray(cached) ? cached.slice() : Object.assign({}, cached);
            }
            return this.documentCache[url] = (yield this.documentLoader.load(url))['@context'];
        });
    }
}
// Regex for valid IRIs
ContextParser.IRI_REGEX = /^([A-Za-z][A-Za-z0-9+-.]*|_):[^ "<>{}|\\\[\]`]*$/;
// Keys in the contexts that will not be expanded based on the base IRI
ContextParser.EXPAND_KEYS_BLACKLIST = [
    '@base',
    '@vocab',
    '@language',
];
// Keys in the contexts that may not be aliased
ContextParser.ALIAS_KEYS_BLACKLIST = [
    '@container',
    '@graph',
    '@id',
    '@index',
    '@list',
    '@nest',
    '@none',
    '@prefix',
    '@reverse',
    '@set',
    '@type',
    '@value',
];
// All valid @container values
ContextParser.CONTAINERS = [
    '@list',
    '@set',
    '@index',
    '@language',
];
exports.ContextParser = ContextParser;

},{"./FetchDocumentLoader":27,"isomorphic-fetch":24,"relative-to-absolute-iri":81}],27:[function(require,module,exports){
"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
require("isomorphic-fetch");
/**
 * Loads documents via the fetch API.
 */
class FetchDocumentLoader {
    load(url) {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield fetch(url, { headers: { accept: 'application/ld+json' } });
            if (response.ok) {
                return (yield response.json());
            }
            else {
                throw new Error(`No valid context was found at ${url}: ${response.statusText}`);
            }
        });
    }
}
exports.FetchDocumentLoader = FetchDocumentLoader;

},{"isomorphic-fetch":24}],28:[function(require,module,exports){
"use strict";
function __export(m) {
    for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
}
Object.defineProperty(exports, "__esModule", { value: true });
__export(require("./lib/JsonLdParser"));

},{"./lib/JsonLdParser":30}],29:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * A tree structure that holds all contexts,
 * based on their position in the JSON object.
 *
 * Positions are identified by a path of keys.
 */
class ContextTree {
    constructor() {
        this.subTrees = {};
    }
    getContext([head, ...tail]) {
        if (!head && !tail.length) {
            return this.context;
        }
        else {
            const subTree = this.subTrees[head];
            return (subTree && subTree.getContext(tail)) || this.context;
        }
    }
    setContext([head, ...tail], context) {
        if (!head && !tail.length) {
            this.context = context;
        }
        else {
            let subTree = this.subTrees[head];
            if (!subTree) {
                subTree = this.subTrees[head] = new ContextTree();
            }
            subTree.setContext(tail, context);
        }
    }
    removeContext(path) {
        this.setContext(path, null);
    }
}
exports.ContextTree = ContextTree;

},{}],30:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// tslint:disable-next-line:no-var-requires
const Parser = require('jsonparse');
const stream_1 = require("stream");
const EntryHandlerArrayValue_1 = require("./entryhandler/EntryHandlerArrayValue");
const EntryHandlerContainer_1 = require("./entryhandler/EntryHandlerContainer");
const EntryHandlerInvalidFallback_1 = require("./entryhandler/EntryHandlerInvalidFallback");
const EntryHandlerPredicate_1 = require("./entryhandler/EntryHandlerPredicate");
const EntryHandlerKeywordContext_1 = require("./entryhandler/keyword/EntryHandlerKeywordContext");
const EntryHandlerKeywordGraph_1 = require("./entryhandler/keyword/EntryHandlerKeywordGraph");
const EntryHandlerKeywordId_1 = require("./entryhandler/keyword/EntryHandlerKeywordId");
const EntryHandlerKeywordType_1 = require("./entryhandler/keyword/EntryHandlerKeywordType");
const EntryHandlerKeywordUnknownFallback_1 = require("./entryhandler/keyword/EntryHandlerKeywordUnknownFallback");
const EntryHandlerKeywordValue_1 = require("./entryhandler/keyword/EntryHandlerKeywordValue");
const ParsingContext_1 = require("./ParsingContext");
const Util_1 = require("./Util");
/**
 * A stream transformer that parses JSON-LD (text) streams to an {@link RDF.Stream}.
 */
class JsonLdParser extends stream_1.Transform {
    constructor(options) {
        super({ objectMode: true });
        options = options || {};
        this.options = options;
        this.parsingContext = new ParsingContext_1.ParsingContext(Object.assign({ parser: this }, options));
        this.util = new Util_1.Util({ dataFactory: options.dataFactory, parsingContext: this.parsingContext });
        this.jsonParser = new Parser();
        this.contextAwaitingJobs = [];
        this.contextJobs = [];
        this.lastDepth = 0;
        this.lastOnValueJob = Promise.resolve();
        this.attachJsonParserListeners();
    }
    /**
     * Parses the given text stream into a quad stream.
     * @param {NodeJS.EventEmitter} stream A text stream.
     * @return {NodeJS.EventEmitter} A quad stream.
     */
    import(stream) {
        const output = new stream_1.PassThrough({ objectMode: true });
        stream.on('error', (error) => parsed.emit('error', error));
        stream.on('data', (data) => output.write(data));
        stream.on('end', () => output.emit('end'));
        const parsed = output.pipe(new JsonLdParser(this.options));
        return parsed;
    }
    _transform(chunk, encoding, callback) {
        this.jsonParser.write(chunk);
        this.lastOnValueJob
            .then(() => callback(), (error) => callback(error));
    }
    /**
     * Start a new job for parsing the given value.
     *
     * This will let the first valid {@link IEntryHandler} handle the entry.
     *
     * @param {any[]} keys The stack of keys.
     * @param value The value to parse.
     * @param {number} depth The depth to parse at.
     * @return {Promise<void>} A promise resolving when the job is done.
     */
    async newOnValueJob(keys, value, depth) {
        // When we go up the stack, emit all unidentified values
        // We need to do this before the new job, because the new job may require determined values from the flushed jobs.
        if (depth < this.lastDepth) {
            // Check if we had any RDF lists that need to be terminated with an rdf:nil
            const listPointer = this.parsingContext.listPointerStack[this.lastDepth];
            if (listPointer) {
                if (listPointer.term) {
                    this.emit('data', this.util.dataFactory.quad(listPointer.term, this.util.rdfRest, this.util.rdfNil, this.util.getDefaultGraph()));
                }
                else {
                    this.parsingContext.getUnidentifiedValueBufferSafe(listPointer.listRootDepth)
                        .push({ predicate: listPointer.initialPredicate, object: this.util.rdfNil, reverse: false });
                }
                this.parsingContext.listPointerStack.splice(this.lastDepth, 1);
            }
            // Flush the buffer for lastDepth
            await this.flushBuffer(this.lastDepth, keys);
        }
        const key = await this.util.unaliasKeyword(keys[depth], keys, depth);
        const parentKey = await this.util.unaliasKeywordParent(keys, depth);
        this.parsingContext.emittedStack[depth] = true;
        let handleKey = true;
        // Keywords inside @reverse is not allowed
        if (Util_1.Util.isKeyword(key) && parentKey === '@reverse') {
            this.emit('error', new Error(`Found the @id '${value}' inside an @reverse property`));
        }
        // Skip further processing if one of the parent nodes are invalid.
        // We use the validationStack to reuse validation results that were produced before with common key stacks.
        let inProperty = false;
        if (this.parsingContext.validationStack.length > 1) {
            inProperty = this.parsingContext.validationStack[this.parsingContext.validationStack.length - 1].property;
        }
        for (let i = Math.max(1, this.parsingContext.validationStack.length - 1); i < keys.length - 1; i++) {
            const validationResult = this.parsingContext.validationStack[i]
                || (this.parsingContext.validationStack[i] = await this.validateKey(keys.slice(0, i + 1), i, inProperty));
            if (!validationResult.valid) {
                this.parsingContext.emittedStack[depth] = false;
                handleKey = false;
                break;
            }
            else if (!inProperty && validationResult.property) {
                inProperty = true;
            }
        }
        // Skip further processing if this node is part of a literal
        if (this.util.isLiteral(depth)) {
            handleKey = false;
        }
        // Get handler
        if (handleKey) {
            for (const entryHandler of JsonLdParser.ENTRY_HANDLERS) {
                const testResult = await entryHandler.test(this.parsingContext, this.util, key, keys, depth);
                if (testResult) {
                    // Pass processing over to the handler
                    await entryHandler.handle(this.parsingContext, this.util, key, keys, value, depth, testResult);
                    break;
                }
            }
            // Flag that this depth is processed
            this.parsingContext.processingStack[depth] = true;
        }
        // Validate value indexes on the root.
        if (depth === 0 && Array.isArray(value)) {
            await this.util.validateValueIndexes(value);
        }
        // When we go up the stack, flush the old stack
        if (depth < this.lastDepth) {
            // Reset our stack
            this.parsingContext.processingStack.splice(this.lastDepth, 1);
            this.parsingContext.emittedStack.splice(this.lastDepth, 1);
            this.parsingContext.idStack.splice(this.lastDepth, 1);
            this.parsingContext.graphStack.splice(this.lastDepth + 1, 1);
            this.parsingContext.literalStack.splice(this.lastDepth, 1);
            this.parsingContext.validationStack.splice(this.lastDepth - 1, 2);
        }
        this.lastDepth = depth;
        // Clear the keyword cache at this depth, and everything underneath.
        this.parsingContext.unaliasedKeywordCacheStack.splice(depth - 1);
    }
    /**
     * Check if at least one {@link IEntryHandler} validates the entry to true.
     * @param {any[]} keys A stack of keys.
     * @param {number} depth A depth.
     * @param {boolean} inProperty If the current depth is part of a valid property node.
     * @return {Promise<{ valid: boolean, property: boolean }>} A promise resolving to true or false.
     */
    async validateKey(keys, depth, inProperty) {
        for (const entryHandler of JsonLdParser.ENTRY_HANDLERS) {
            if (await entryHandler.validate(this.parsingContext, this.util, keys, depth, inProperty)) {
                return { valid: true, property: inProperty || entryHandler.isPropertyHandler() };
            }
        }
        return { valid: false, property: false };
    }
    /**
     * Attach all required listeners to the JSON parser.
     *
     * This should only be called once.
     */
    attachJsonParserListeners() {
        // Listen to json parser events
        this.jsonParser.onValue = (value) => {
            const depth = this.jsonParser.stack.length;
            const keys = (new Array(depth + 1).fill(0)).map((v, i) => {
                return i === depth ? this.jsonParser.key : this.jsonParser.stack[i].key;
            });
            if (!this.isParsingContextInner(depth)) { // Don't parse inner nodes inside @context
                const valueJobCb = () => this.newOnValueJob(keys, value, depth);
                if (this.parsingContext.allowOutOfOrderContext
                    && !this.parsingContext.contextTree.getContext(keys.slice(0, -1))) {
                    // If an out-of-order context is allowed,
                    // we have to buffer everything.
                    // We store jobs for @context's separately,
                    // because at the end, we have to process them first.
                    if (keys[depth] === '@context') {
                        let jobs = this.contextJobs[depth];
                        if (!jobs) {
                            jobs = this.contextJobs[depth] = [];
                        }
                        jobs.push(valueJobCb);
                    }
                    else {
                        this.contextAwaitingJobs.push(valueJobCb);
                    }
                }
                else {
                    // Make sure that our value jobs are chained synchronously
                    this.lastOnValueJob = this.lastOnValueJob.then(valueJobCb);
                }
                // Execute all buffered jobs on deeper levels
                if (this.parsingContext.allowOutOfOrderContext && depth === 0) {
                    this.lastOnValueJob = this.lastOnValueJob
                        .then(() => this.executeBufferedJobs());
                }
            }
        };
        this.jsonParser.onError = (error) => {
            this.emit('error', error);
        };
    }
    /**
     * Check if the parser is currently parsing an element that is part of an @context entry.
     * @param {number} depth A depth.
     * @return {boolean} A boolean.
     */
    isParsingContextInner(depth) {
        for (let i = depth; i > 0; i--) {
            if (this.jsonParser.stack[i - 1].key === '@context') {
                return true;
            }
        }
        return false;
    }
    /**
     * Execute all buffered jobs.
     * @return {Promise<void>} A promise resolving if all jobs are finished.
     */
    async executeBufferedJobs() {
        // Handle context jobs
        for (const jobs of this.contextJobs) {
            if (jobs) {
                for (const job of jobs) {
                    await job();
                }
            }
        }
        // Clear the keyword cache.
        this.parsingContext.unaliasedKeywordCacheStack.splice(0);
        // Handle non-context jobs
        for (const job of this.contextAwaitingJobs) {
            await job();
        }
    }
    /**
     * Flush buffers for the given depth.
     *
     * This should be called after the last entry at a given depth was processed.
     *
     * @param {number} depth A depth.
     * @param {any[]} keys A stack of keys.
     * @return {Promise<void>} A promise resolving if flushing is done.
     */
    async flushBuffer(depth, keys) {
        let subject = this.parsingContext.idStack[depth];
        if (subject === undefined) {
            subject = this.parsingContext.idStack[depth] = this.util.dataFactory.blankNode();
        }
        // Flush values at this level
        const valueBuffer = this.parsingContext.unidentifiedValuesBuffer[depth];
        if (valueBuffer) {
            if (subject) {
                const depthOffsetGraph = await this.util.getDepthOffsetGraph(depth, keys);
                const graph = this.parsingContext.graphStack[depth] || depthOffsetGraph >= 0
                    ? this.parsingContext.idStack[depth - depthOffsetGraph - 1] : this.util.getDefaultGraph();
                if (graph) {
                    // Flush values to stream if the graph @id is known
                    this.parsingContext.emittedStack[depth] = true;
                    for (const bufferedValue of valueBuffer) {
                        if (bufferedValue.reverse) {
                            this.parsingContext.emitQuad(depth, this.util.dataFactory.quad(bufferedValue.object, bufferedValue.predicate, subject, graph));
                        }
                        else {
                            this.parsingContext.emitQuad(depth, this.util.dataFactory.quad(subject, bufferedValue.predicate, bufferedValue.object, graph));
                        }
                    }
                }
                else {
                    // Place the values in the graphs buffer if the graph @id is not yet known
                    const subGraphBuffer = this.parsingContext.getUnidentifiedGraphBufferSafe(depth - await this.util.getDepthOffsetGraph(depth, keys) - 1);
                    for (const bufferedValue of valueBuffer) {
                        if (bufferedValue.reverse) {
                            subGraphBuffer.push({
                                object: subject,
                                predicate: bufferedValue.predicate,
                                subject: bufferedValue.object,
                            });
                        }
                        else {
                            subGraphBuffer.push({
                                object: bufferedValue.object,
                                predicate: bufferedValue.predicate,
                                subject,
                            });
                        }
                    }
                }
            }
            this.parsingContext.unidentifiedValuesBuffer.splice(depth, 1);
            this.parsingContext.literalStack.splice(depth, 1);
        }
        // Flush graphs at this level
        const graphBuffer = this.parsingContext.unidentifiedGraphsBuffer[depth];
        if (graphBuffer) {
            if (subject) {
                // A @graph statement at the root without @id relates to the default graph,
                // unless there are top-level properties,
                // others relate to blank nodes.
                const graph = depth === 1 && subject.termType === 'BlankNode'
                    && !this.parsingContext.topLevelProperties ? this.util.getDefaultGraph() : subject;
                this.parsingContext.emittedStack[depth] = true;
                for (const bufferedValue of graphBuffer) {
                    this.parsingContext.emitQuad(depth, this.util.dataFactory.quad(bufferedValue.subject, bufferedValue.predicate, bufferedValue.object, graph));
                }
            }
            this.parsingContext.unidentifiedGraphsBuffer.splice(depth, 1);
        }
    }
}
JsonLdParser.DEFAULT_PROCESSING_MODE = '1.0';
JsonLdParser.ENTRY_HANDLERS = [
    new EntryHandlerArrayValue_1.EntryHandlerArrayValue(),
    new EntryHandlerKeywordContext_1.EntryHandlerKeywordContext(),
    new EntryHandlerKeywordId_1.EntryHandlerKeywordId(),
    new EntryHandlerKeywordGraph_1.EntryHandlerKeywordGraph(),
    new EntryHandlerKeywordType_1.EntryHandlerKeywordType(),
    new EntryHandlerKeywordValue_1.EntryHandlerKeywordValue(),
    new EntryHandlerKeywordUnknownFallback_1.EntryHandlerKeywordUnknownFallback(),
    new EntryHandlerContainer_1.EntryHandlerContainer(),
    new EntryHandlerPredicate_1.EntryHandlerPredicate(),
    new EntryHandlerInvalidFallback_1.EntryHandlerInvalidFallback(),
];
exports.JsonLdParser = JsonLdParser;

},{"./ParsingContext":31,"./Util":32,"./entryhandler/EntryHandlerArrayValue":35,"./entryhandler/EntryHandlerContainer":36,"./entryhandler/EntryHandlerInvalidFallback":37,"./entryhandler/EntryHandlerPredicate":38,"./entryhandler/keyword/EntryHandlerKeywordContext":40,"./entryhandler/keyword/EntryHandlerKeywordGraph":41,"./entryhandler/keyword/EntryHandlerKeywordId":42,"./entryhandler/keyword/EntryHandlerKeywordType":43,"./entryhandler/keyword/EntryHandlerKeywordUnknownFallback":44,"./entryhandler/keyword/EntryHandlerKeywordValue":45,"jsonparse":46,"stream":83}],31:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const jsonld_context_parser_1 = require("jsonld-context-parser");
const ContextTree_1 = require("./ContextTree");
const JsonLdParser_1 = require("./JsonLdParser");
/**
 * Data holder for parsing information.
 */
class ParsingContext {
    constructor(options) {
        // Initialize settings
        this.contextParser = new jsonld_context_parser_1.ContextParser({ documentLoader: options.documentLoader });
        this.allowOutOfOrderContext = options.allowOutOfOrderContext;
        this.baseIRI = options.baseIRI;
        this.produceGeneralizedRdf = options.produceGeneralizedRdf;
        this.allowSubjectList = options.allowSubjectList;
        this.processingMode = options.processingMode || JsonLdParser_1.JsonLdParser.DEFAULT_PROCESSING_MODE;
        this.errorOnInvalidProperties = options.errorOnInvalidIris;
        this.validateValueIndexes = options.validateValueIndexes;
        this.defaultGraph = options.defaultGraph;
        // Initialize stacks
        this.processingStack = [];
        this.emittedStack = [];
        this.idStack = [];
        this.graphStack = [];
        this.listPointerStack = [];
        this.contextTree = new ContextTree_1.ContextTree();
        this.literalStack = [];
        this.validationStack = [];
        this.unaliasedKeywordCacheStack = [];
        this.unidentifiedValuesBuffer = [];
        this.unidentifiedGraphsBuffer = [];
        this.parser = options.parser;
        if (options.context) {
            this.rootContext = this.contextParser.parse(options.context, { baseIri: options.baseIRI });
            this.rootContext.then((context) => this.validateContext(context));
        }
        else {
            this.rootContext = Promise.resolve(this.baseIRI ? { '@base': this.baseIRI } : {});
        }
        this.topLevelProperties = false;
    }
    /**
     * Check if the given context is valid.
     * If not, an error will be thrown.
     * @param {IJsonLdContextNormalized} context A context.
     */
    validateContext(context) {
        const activeVersion = context['@version'];
        if (activeVersion && parseFloat(activeVersion) > parseFloat(this.processingMode)) {
            throw new Error(`Unsupported JSON-LD processing mode: ${activeVersion}`);
        }
    }
    /**
     * Get the context at the given path.
     * @param {keys} keys The path of keys to get the context at.
     * @param {number} offset The path offset, defaults to 1.
     * @return {Promise<IJsonLdContextNormalized>} A promise resolving to a context.
     */
    getContext(keys, offset = 1) {
        if (offset) {
            keys = keys.slice(0, -offset);
        }
        return this.contextTree.getContext(keys) || this.rootContext;
    }
    /**
     * Start a new job for parsing the given value.
     * @param {any[]} keys The stack of keys.
     * @param value The value to parse.
     * @param {number} depth The depth to parse at.
     * @return {Promise<void>} A promise resolving when the job is done.
     */
    async newOnValueJob(keys, value, depth) {
        await this.parser.newOnValueJob(keys, value, depth);
    }
    /**
     * Emit the given quad into the output stream.
     * @param {number} depth The depth the quad was generated at.
     * @param {Quad} quad A quad to emit.
     */
    emitQuad(depth, quad) {
        if (depth === 1) {
            this.topLevelProperties = true;
        }
        this.parser.push(quad);
    }
    /**
     * Emit the given error into the output stream.
     * @param {Error} error An error to emit.
     */
    emitError(error) {
        this.parser.emit('error', error);
    }
    /**
     * Emit the given context into the output stream under the 'context' event.
     * @param {JsonLdContext} context A context to emit.
     */
    emitContext(context) {
        this.parser.emit('context', context);
    }
    /**
     * Safely get or create the depth value of {@link ParsingContext.unidentifiedValuesBuffer}.
     * @param {number} depth A depth.
     * @return {{predicate: Term; object: Term; reverse: boolean}[]} An element of
     *                                                               {@link ParsingContext.unidentifiedValuesBuffer}.
     */
    getUnidentifiedValueBufferSafe(depth) {
        let buffer = this.unidentifiedValuesBuffer[depth];
        if (!buffer) {
            buffer = [];
            this.unidentifiedValuesBuffer[depth] = buffer;
        }
        return buffer;
    }
    /**
     * Safely get or create the depth value of {@link ParsingContext.unidentifiedGraphsBuffer}.
     * @param {number} depth A depth.
     * @return {{predicate: Term; object: Term; reverse: boolean}[]} An element of
     *                                                               {@link ParsingContext.unidentifiedGraphsBuffer}.
     */
    getUnidentifiedGraphBufferSafe(depth) {
        let buffer = this.unidentifiedGraphsBuffer[depth];
        if (!buffer) {
            buffer = [];
            this.unidentifiedGraphsBuffer[depth] = buffer;
        }
        return buffer;
    }
}
exports.ParsingContext = ParsingContext;

},{"./ContextTree":29,"./JsonLdParser":30,"jsonld-context-parser":25}],32:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const jsonld_context_parser_1 = require("jsonld-context-parser");
/**
 * Utility functions and methods.
 */
class Util {
    constructor(options) {
        this.parsingContext = options.parsingContext;
        this.dataFactory = options.dataFactory || require('@rdfjs/data-model');
        this.rdfFirst = this.dataFactory.namedNode(Util.RDF + 'first');
        this.rdfRest = this.dataFactory.namedNode(Util.RDF + 'rest');
        this.rdfNil = this.dataFactory.namedNode(Util.RDF + 'nil');
        this.rdfType = this.dataFactory.namedNode(Util.RDF + 'type');
    }
    /**
     * Helper function to get the value of a context entry,
     * or fallback to a certain value.
     * @param {IJsonLdContextNormalized} context A JSON-LD context.
     * @param {string} contextKey A pre-defined JSON-LD key in context entries.
     * @param {string} key A context entry key.
     * @param {string} fallback A fallback value for when the given contextKey
     *                          could not be found in the value with the given key.
     * @return {string} The value of the given contextKey in the entry behind key in the given context,
     *                  or the given fallback value.
     */
    static getContextValue(context, contextKey, key, fallback) {
        const entry = context[key];
        if (!entry) {
            return fallback;
        }
        const type = entry[contextKey];
        return type === undefined ? fallback : type;
    }
    /**
     * Get the container type of the given key in the context.
     * @param {IJsonLdContextNormalized} context A JSON-LD context.
     * @param {string} key A context entry key.
     * @return {string} The container type.
     */
    static getContextValueContainer(context, key) {
        return Util.getContextValue(context, '@container', key, '@set');
    }
    /**
     * Get the node type of the given key in the context.
     * @param {IJsonLdContextNormalized} context A JSON-LD context.
     * @param {string} key A context entry key.
     * @return {string} The node type.
     */
    static getContextValueType(context, key) {
        return Util.getContextValue(context, '@type', key, null);
    }
    /**
     * Get the node type of the given key in the context.
     * @param {IJsonLdContextNormalized} context A JSON-LD context.
     * @param {string} key A context entry key.
     * @return {string} The node type.
     */
    static getContextValueLanguage(context, key) {
        return Util.getContextValue(context, '@language', key, context['@language'] || null);
    }
    /**
     * Check if the given key in the context is a reversed property.
     * @param {IJsonLdContextNormalized} context A JSON-LD context.
     * @param {string} key A context entry key.
     * @return {boolean} If the context value has a @reverse key.
     */
    static isContextValueReverse(context, key) {
        return !!Util.getContextValue(context, '@reverse', key, null);
    }
    /**
     * Check if the given key refers to a reversed property.
     * @param {IJsonLdContextNormalized} context A JSON-LD context.
     * @param {string} key The property key.
     * @param {string} parentKey The parent key.
     * @return {boolean} If the property must be reversed.
     */
    static isPropertyReverse(context, key, parentKey) {
        // '!==' is needed because reversed properties in a @reverse container should cancel each other out.
        return parentKey === '@reverse' !== Util.isContextValueReverse(context, key);
    }
    /**
     * Check if the given key is a keyword.
     * @param {string} key A key, can be falsy.
     * @return {boolean} If the given key starts with an @.
     */
    static isKeyword(key) {
        return typeof key === 'string' && key[0] === '@';
    }
    /**
     * Check if the given IRI is valid.
     * @param {string} iri A potential IRI.
     * @return {boolean} If the given IRI is valid.
     */
    static isValidIri(iri) {
        return jsonld_context_parser_1.ContextParser.isValidIri(iri);
    }
    /**
     * Make sure that @id-@index pairs are equal over all array values.
     * Reject otherwise.
     * @param {any[]} value An array value.
     * @return {Promise<void>} A promise rejecting if conflicts are present.
     */
    async validateValueIndexes(value) {
        if (this.parsingContext.validateValueIndexes) {
            const indexHashes = {};
            for (const entry of value) {
                if (entry && typeof entry === 'object') {
                    const id = entry['@id'];
                    const index = entry['@index'];
                    if (id && index) {
                        const existingIndexValue = indexHashes[id];
                        if (existingIndexValue && existingIndexValue !== index) {
                            throw new Error(`Conflicting @index value for ${id}`);
                        }
                        indexHashes[id] = index;
                    }
                }
            }
        }
    }
    /**
     * Convert a given JSON value to an RDF term.
     * @param {IJsonLdContextNormalized} context A JSON-LD context.
     * @param {string} key The current JSON key.
     * @param value A JSON value.
     * @param {number} depth The depth the value is at.
     * @param {string[]} keys The path of keys.
     * @return {RDF.Term} An RDF term.
     */
    async valueToTerm(context, key, value, depth, keys) {
        const type = typeof value;
        switch (type) {
            case 'object':
                // Skip if we have a null or undefined object
                if (value === null || value === undefined) {
                    return null;
                }
                // Special case for arrays
                if (Array.isArray(value)) {
                    // We handle arrays at value level so we can emit earlier, so this is handled already when we get here.
                    // Empty context-based lists are emitted at this place, because our streaming algorithm doesn't detect those.
                    if (Util.getContextValueContainer(context, key) === '@list' && value.length === 0) {
                        return this.rdfNil;
                    }
                    await this.validateValueIndexes(value);
                    return null;
                }
                // Handle local context in the value
                if ('@context' in value) {
                    context = await this.parsingContext.contextParser.parse(value['@context'], { baseIri: this.parsingContext.baseIRI, parentContext: context });
                }
                // In all other cases, we have a hash
                value = await this.unaliasKeywords(value, keys, depth); // Un-alias potential keywords in this hash
                if ('@value' in value) {
                    let val;
                    let valueLanguage;
                    let valueType;
                    let valueIndex; // We don't use the index, but we need to check its type for spec-compliance
                    for (key in value) {
                        const subValue = value[key];
                        switch (key) {
                            case '@value':
                                val = subValue;
                                break;
                            case '@language':
                                valueLanguage = subValue;
                                break;
                            case '@type':
                                valueType = subValue;
                                break;
                            case '@index':
                                valueIndex = subValue;
                                break;
                            default:
                                throw new Error(`Unknown value entry '${key}' in @value: ${JSON.stringify(value)}`);
                        }
                    }
                    // Validate @value
                    if (val === null) {
                        return null;
                    }
                    if (typeof val === 'object') {
                        throw new Error(`The value of an '@value' can not be an object, got '${JSON.stringify(val)}'`);
                    }
                    // Validate @index
                    if (this.parsingContext.validateValueIndexes && valueIndex && typeof valueIndex !== 'string') {
                        throw new Error(`The value of an '@index' must be a string, got '${JSON.stringify(valueIndex)}'`);
                    }
                    // Validate @language
                    if (valueLanguage) {
                        if (valueType) {
                            throw new Error(`Can not have both '@language' and '@type' in a value: '${JSON.stringify(value)}'`);
                        }
                        if (typeof valueLanguage !== 'string') {
                            throw new Error(`The value of an '@language' must be a string, got '${JSON.stringify(valueLanguage)}'`);
                        }
                        if (typeof val !== 'string') {
                            throw new Error(`When an '@language' is set, the value of '@value' must be a string, got '${JSON.stringify(val)}'`);
                        }
                        // Language tags are always normalized to lowercase.
                        valueLanguage = valueLanguage.toLowerCase();
                        return this.dataFactory.literal(val, valueLanguage);
                    }
                    else if (valueType) { // Validate @type
                        if (typeof valueType !== 'string') {
                            throw new Error(`The value of an '@type' must be a string, got '${JSON.stringify(valueType)}'`);
                        }
                        const typeTerm = this.createVocabOrBaseTerm(context, valueType);
                        if (!typeTerm) {
                            return null;
                        }
                        if (typeTerm.termType !== 'NamedNode') {
                            throw new Error(`Illegal value type (${typeTerm.termType}): ${valueType}`);
                        }
                        return this.dataFactory.literal(val, typeTerm);
                    }
                    // We don't pass the context, because context-based things like @language should be ignored
                    return await this.valueToTerm({}, key, val, depth, keys);
                }
                else if ('@set' in value) {
                    // No other entries are allow in this value
                    if (Object.keys(value).length > 1) {
                        throw new Error(`Found illegal neighbouring entries next to @set in value: ${JSON.stringify(value)}`);
                    }
                    // No need to do anything here, this is handled at the deeper level.
                    return null;
                }
                else if ('@list' in value) {
                    // No other entries are allow in this value
                    if (Object.keys(value).length > 1) {
                        throw new Error(`Found illegal neighbouring entries next to @set in value: ${JSON.stringify(value)}`);
                    }
                    const listValue = value["@list"];
                    // We handle lists at value level so we can emit earlier, so this is handled already when we get here.
                    // Empty anonymous lists are emitted at this place, because our streaming algorithm doesn't detect those.
                    if (Array.isArray(listValue)) {
                        if (listValue.length === 0) {
                            return this.rdfNil;
                        }
                        else {
                            return null;
                        }
                    }
                    else {
                        // We only have a single list element here, so emit this directly as single element
                        return this.valueToTerm(await this.parsingContext.getContext(keys), key, listValue, depth - 1, keys.slice(0, -1));
                    }
                }
                else if ('@reverse' in value) {
                    // We handle reverse properties at value level so we can emit earlier,
                    // so this is handled already when we get here.
                    return null;
                }
                else if ("@id" in value) {
                    if (value["@type"] === '@vocab') {
                        return this.createVocabOrBaseTerm(context, value["@id"]);
                    }
                    else {
                        return this.resourceToTerm(context, value["@id"]);
                    }
                }
                else {
                    // Only make a blank node if at least one triple was emitted at the value's level.
                    if (this.parsingContext.emittedStack[depth + 1]) {
                        return this.parsingContext.idStack[depth + 1]
                            || (this.parsingContext.idStack[depth + 1] = this.dataFactory.blankNode());
                    }
                    else {
                        return null;
                    }
                }
            case 'string':
                return this.stringValueToTerm(context, key, value, null);
            case 'boolean':
                return this.stringValueToTerm(context, key, Boolean(value).toString(), this.dataFactory.namedNode(Util.XSD_BOOLEAN));
            case 'number':
                return this.stringValueToTerm(context, key, value, this.dataFactory.namedNode(value % 1 === 0 ? Util.XSD_INTEGER : Util.XSD_DOUBLE));
            default:
                this.parsingContext.emitError(new Error(`Could not determine the RDF type of a ${type}`));
        }
    }
    /**
     * Convert a given JSON key to an RDF predicate term,
     * based on @vocab.
     * @param {IJsonLdContextNormalized} context A JSON-LD context.
     * @param key A JSON key.
     * @return {RDF.NamedNode} An RDF named node.
     */
    predicateToTerm(context, key) {
        const expanded = jsonld_context_parser_1.ContextParser.expandTerm(key, context, true);
        // Immediately return if the predicate was disabled in the context
        if (!expanded) {
            return null;
        }
        // Check if the predicate is a blank node
        if (expanded[0] === '_' && expanded[1] === ':') {
            if (this.parsingContext.produceGeneralizedRdf) {
                return this.dataFactory.blankNode(expanded.substr(2));
            }
            else {
                return null;
            }
        }
        // Check if the predicate is a valid IRI
        if (Util.isValidIri(expanded)) {
            return this.dataFactory.namedNode(expanded);
        }
        else {
            if (expanded && this.parsingContext.errorOnInvalidProperties) {
                this.parsingContext.emitError(new Error(`Invalid predicate IRI: ${expanded}`));
            }
            else {
                return null;
            }
        }
    }
    /**
     * Convert a given JSON key to an RDF resource term or blank node,
     * based on @base.
     * @param {IJsonLdContextNormalized} context A JSON-LD context.
     * @param key A JSON key.
     * @return {RDF.NamedNode} An RDF named node or null.
     */
    resourceToTerm(context, key) {
        if (key.startsWith('_:')) {
            return this.dataFactory.blankNode(key.substr(2));
        }
        const iri = jsonld_context_parser_1.ContextParser.expandTerm(key, context, false);
        if (!Util.isValidIri(iri)) {
            if (iri && this.parsingContext.errorOnInvalidProperties) {
                this.parsingContext.emitError(new Error(`Invalid resource IRI: ${iri}`));
            }
            else {
                return null;
            }
        }
        return this.dataFactory.namedNode(iri);
    }
    /**
     * Convert a given JSON key to an RDF resource term.
     * It will do this based on the @vocab,
     * and fallback to @base.
     * @param {IJsonLdContextNormalized} context A JSON-LD context.
     * @param key A JSON key.
     * @return {RDF.NamedNode} An RDF named node or null.
     */
    createVocabOrBaseTerm(context, key) {
        if (key.startsWith('_:')) {
            return this.dataFactory.blankNode(key.substr(2));
        }
        let expanded = jsonld_context_parser_1.ContextParser.expandTerm(key, context, true);
        if (expanded === key) {
            expanded = jsonld_context_parser_1.ContextParser.expandTerm(key, context, false);
        }
        if (!Util.isValidIri(expanded)) {
            if (expanded && this.parsingContext.errorOnInvalidProperties) {
                this.parsingContext.emitError(new Error(`Invalid term IRI: ${expanded}`));
            }
            else {
                return null;
            }
        }
        return this.dataFactory.namedNode(expanded);
    }
    /**
     * Ensure that the given value becomes a string.
     * @param {string | number} value A string or number.
     * @param {NamedNode} datatype The intended datatype.
     * @return {string} The returned string.
     */
    intToString(value, datatype) {
        if (typeof value === 'number') {
            if (Number.isFinite(value)) {
                const isInteger = value % 1 === 0;
                if (isInteger && datatype.value !== Util.XSD_DOUBLE) {
                    return Number(value).toString();
                }
                else {
                    return value.toExponential(15).replace(/(\d)0*e\+?/, '$1E');
                }
            }
            else {
                return value > 0 ? 'INF' : '-INF';
            }
        }
        else {
            return value;
        }
    }
    /**
     * Convert a given JSON string value to an RDF term.
     * @param {IJsonLdContextNormalized} context A JSON-LD context.
     * @param {string} key The current JSON key.
     * @param {string} value A JSON value.
     * @param {NamedNode} defaultDatatype The default datatype for the given value.
     * @return {RDF.Term} An RDF term or null.
     */
    stringValueToTerm(context, key, value, defaultDatatype) {
        // Check the datatype from the context
        const contextType = Util.getContextValueType(context, key);
        if (contextType) {
            if (contextType === '@id') {
                if (!defaultDatatype) {
                    return this.resourceToTerm(context, this.intToString(value, defaultDatatype));
                }
            }
            else if (contextType === '@vocab') {
                if (!defaultDatatype) {
                    return this.createVocabOrBaseTerm(context, this.intToString(value, defaultDatatype));
                }
            }
            else {
                defaultDatatype = this.dataFactory.namedNode(contextType);
            }
        }
        // If we don't find such a datatype, check the language from the context
        if (!defaultDatatype) {
            const contextLanguage = Util.getContextValueLanguage(context, key);
            if (contextLanguage) {
                return this.dataFactory.literal(this.intToString(value, defaultDatatype), contextLanguage);
            }
        }
        // If all else fails, make a literal based on the default content type
        return this.dataFactory.literal(this.intToString(value, defaultDatatype), defaultDatatype);
    }
    /**
     * If the key is not a keyword, try to check if it is an alias for a keyword,
     * and if so, un-alias it.
     * @param {string} key A key, can be falsy.
     * @param {string[]} keys The path of keys.
     * @param {number} depth The depth to
     * @param {boolean} disableCache If the cache should be disabled
     * @return {Promise<string>} A promise resolving to the key itself, or another key.
     */
    async unaliasKeyword(key, keys, depth, disableCache) {
        // Numbers can not be an alias
        if (Number.isInteger(key)) {
            return key;
        }
        // Try to grab from cache if it was already un-aliased before.
        if (!disableCache) {
            const cachedUnaliasedKeyword = this.parsingContext.unaliasedKeywordCacheStack[depth];
            if (cachedUnaliasedKeyword) {
                return cachedUnaliasedKeyword;
            }
        }
        if (!Util.isKeyword(key)) {
            const context = await this.parsingContext.getContext(keys);
            let unliased = context[key];
            if (unliased && typeof unliased === 'object') {
                unliased = unliased['@id'];
            }
            if (Util.isKeyword(unliased)) {
                key = unliased;
            }
        }
        return disableCache ? key : (this.parsingContext.unaliasedKeywordCacheStack[depth] = key);
    }
    /**
     * Unalias the keyword of the parent.
     * This adds a safety check if no parent exist.
     * @param {any[]} keys A stack of keys.
     * @param {number} depth The current depth.
     * @return {Promise<any>} A promise resolving to the parent key, or another key.
     */
    async unaliasKeywordParent(keys, depth) {
        return await this.unaliasKeyword(depth > 0 && keys[depth - 1], keys, depth - 1);
    }
    /**
     * Un-alias all keywords in the given hash.
     * @param {{[p: string]: any}} hash A hash object.
     * @param {string[]} keys The path of keys.
     * @param {number} depth The depth.
     * @return {Promise<{[p: string]: any}>} A promise resolving to the new hash.
     */
    async unaliasKeywords(hash, keys, depth) {
        const newHash = {};
        for (const key in hash) {
            newHash[await this.unaliasKeyword(key, keys, depth + 1, true)] = hash[key];
        }
        return newHash;
    }
    /**
     * Check if we are processing a literal at the given depth.
     * This will also check higher levels,
     * because if a parent is a literal,
     * then the deeper levels are definitely a literal as well.
     * @param {number} depth The depth.
     * @return {boolean} If we are processing a literal.
     */
    isLiteral(depth) {
        for (let i = depth; i >= 0; i--) {
            if (this.parsingContext.literalStack[i]) {
                return true;
            }
        }
        return false;
    }
    /**
     * Check how many parents should be skipped for checking the @graph for the given node.
     *
     * @param {number} depth The depth of the node.
     * @param {any[]} keys An array of keys.
     * @return {number} The graph depth offset.
     */
    async getDepthOffsetGraph(depth, keys) {
        for (let i = depth - 1; i > 0; i--) {
            if (await this.unaliasKeyword(keys[i], keys, i) === '@graph') {
                return depth - i - 1;
            }
        }
        return -1;
    }
    /**
     * Check if the given subject is of a valid type.
     * This should be called when applying @reverse'd properties.
     * @param {Term} subject A subject.
     */
    validateReverseSubject(subject) {
        if (subject.termType === 'Literal') {
            throw new Error(`Found illegal literal in subject position: ${subject.value}`);
        }
    }
    /**
     * Get the default graph.
     * @return {Term} An RDF term.
     */
    getDefaultGraph() {
        return this.parsingContext.defaultGraph || this.dataFactory.defaultGraph();
    }
}
Util.XSD = 'http://www.w3.org/2001/XMLSchema#';
Util.XSD_BOOLEAN = Util.XSD + 'boolean';
Util.XSD_INTEGER = Util.XSD + 'integer';
Util.XSD_DOUBLE = Util.XSD + 'double';
Util.RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
exports.Util = Util;

},{"@rdfjs/data-model":2,"jsonld-context-parser":25}],33:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Container handler for @index.
 *
 * This will ignore the current key and add this entry to the parent node.
 */
class ContainerHandlerIndex {
    async handle(parsingContext, keys, value, depth) {
        await parsingContext.newOnValueJob(keys, value, depth - 1);
    }
}
exports.ContainerHandlerIndex = ContainerHandlerIndex;

},{}],34:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Container handler for @language.
 *
 * It assumes that the current key is the language of the current value.
 * This will add this value to the parent node.
 */
class ContainerHandlerLanguage {
    async handle(parsingContext, keys, value, depth) {
        if (Array.isArray(value)) {
            value = value.map((subValue) => ({ '@value': subValue, '@language': keys[depth] }));
        }
        else {
            value = { '@value': value, '@language': keys[depth] };
        }
        await parsingContext.newOnValueJob(keys, value, depth - 1);
    }
}
exports.ContainerHandlerLanguage = ContainerHandlerLanguage;

},{}],35:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Util_1 = require("../Util");
/**
 * Handles values that are part of an array.
 */
class EntryHandlerArrayValue {
    isPropertyHandler() {
        return false;
    }
    async validate(parsingContext, util, keys, depth, inProperty) {
        return this.test(parsingContext, util, null, keys, depth);
    }
    async test(parsingContext, util, key, keys, depth) {
        return typeof keys[depth] === 'number';
    }
    async handle(parsingContext, util, key, keys, value, depth) {
        const parentKey = await util.unaliasKeywordParent(keys, depth);
        // Check if we have an anonymous list
        if (parentKey === '@list') {
            // Our value is part of an array
            // Determine the list root key
            let listRootKey = null;
            let listRootDepth;
            for (let i = depth - 2; i > 0; i--) {
                const keyOption = keys[i];
                if (typeof keyOption === 'string') {
                    listRootDepth = i;
                    listRootKey = keyOption;
                    break;
                }
            }
            // Throw an error if we encounter a nested list
            if (listRootKey === '@list' ||
                (listRootDepth !== depth - 2 && typeof keys[depth - 2] === 'number'
                    && Util_1.Util.getContextValueContainer(await parsingContext
                        .getContext(keys, listRootDepth - depth), listRootKey) === '@list')) {
                throw new Error(`Lists of lists are not supported: '${listRootKey}'`);
            }
            const object = await util.valueToTerm(await parsingContext.getContext(keys), listRootKey, value, depth, keys);
            if (listRootKey !== null) {
                await this.handleListElement(parsingContext, util, object, depth, keys.slice(0, listRootDepth), listRootDepth, listRootKey, keys);
            }
        }
        else if (parentKey === '@set') {
            // Our value is part of a set, so we just add it to the parent-parent
            await parsingContext.newOnValueJob(keys.slice(0, -2), value, depth - 2);
        }
        else if (parentKey !== undefined && parentKey !== '@type') {
            // Buffer our value using the parent key as predicate
            // Check if the predicate is marked as an @list in the context
            const parentContext = await parsingContext.getContext(keys.slice(0, -1));
            if (Util_1.Util.getContextValueContainer(parentContext, parentKey) === '@list') {
                // Our value is part of an array
                const object = await util.valueToTerm(await parsingContext.getContext(keys), parentKey, value, depth, keys);
                await this.handleListElement(parsingContext, util, object, depth, keys.slice(0, -1), depth - 1, parentKey, keys);
            }
            else {
                // Copy the id stack value up one level so that the next job can access the id.
                if (parsingContext.idStack[depth + 1]) {
                    parsingContext.idStack[depth] = parsingContext.idStack[depth + 1];
                    parsingContext.emittedStack[depth] = true;
                }
                // Execute the job one level higher
                await parsingContext.newOnValueJob(keys.slice(0, -1), value, depth - 1);
                // Remove any defined contexts at this level to avoid it to propagate to the next array element.
                parsingContext.contextTree.removeContext(keys.slice(0, -1));
            }
        }
    }
    async handleListElement(parsingContext, util, value, depth, listRootKeys, listRootDepth, listRootKey, keys) {
        // Buffer our value as an RDF list using the listRootKey as predicate
        let listPointer = parsingContext.listPointerStack[depth];
        if (value) {
            if (!listPointer || !listPointer.term) {
                const linkTerm = util.dataFactory.blankNode();
                const listRootContext = await parsingContext.getContext(listRootKeys);
                const predicate = await util.predicateToTerm(listRootContext, listRootKey);
                const reverse = Util_1.Util.isPropertyReverse(listRootContext, listRootKey, keys[listRootDepth - 1]);
                // Lists are not allowed in @reverse'd properties
                if (reverse && !parsingContext.allowSubjectList) {
                    throw new Error(`Found illegal list value in subject position at ${listRootKey}`);
                }
                parsingContext.getUnidentifiedValueBufferSafe(listRootDepth)
                    .push({ predicate, object: linkTerm, reverse });
                listPointer = { term: linkTerm, initialPredicate: null, listRootDepth };
            }
            else {
                // rdf:rest links are always emitted before the next element,
                // as the blank node identifier is only created at that point.
                // Because of this reason, the final rdf:nil is emitted when the stack depth is decreased.
                const newLinkTerm = util.dataFactory.blankNode();
                parsingContext.emitQuad(depth, util.dataFactory.quad(listPointer.term, util.rdfRest, newLinkTerm, util.getDefaultGraph()));
                // Update the list pointer for the next element
                listPointer.term = newLinkTerm;
            }
            // Emit a list element for the current value
            parsingContext.emitQuad(depth, util.dataFactory.quad(listPointer.term, util.rdfFirst, value, util.getDefaultGraph()));
        }
        else {
            // A falsy list element if found.
            // Just enable the list flag for this depth if it has not been set before.
            if (!listPointer) {
                const predicate = await util.predicateToTerm(await parsingContext.getContext(listRootKeys), listRootKey);
                listPointer = { term: null, initialPredicate: predicate, listRootDepth };
            }
        }
        parsingContext.listPointerStack[depth] = listPointer;
    }
}
exports.EntryHandlerArrayValue = EntryHandlerArrayValue;

},{"../Util":32}],36:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ContainerHandlerIndex_1 = require("../containerhandler/ContainerHandlerIndex");
const ContainerHandlerLanguage_1 = require("../containerhandler/ContainerHandlerLanguage");
const Util_1 = require("../Util");
/**
 * Handles values that are part of a container type (like @index),
 * as specified by {@link IContainerHandler}.
 */
class EntryHandlerContainer {
    isPropertyHandler() {
        return false;
    }
    async validate(parsingContext, util, keys, depth, inProperty) {
        return !!await this.test(parsingContext, util, null, keys, depth);
    }
    async test(parsingContext, util, key, keys, depth) {
        return EntryHandlerContainer.CONTAINER_HANDLERS[Util_1.Util.getContextValueContainer(await parsingContext.getContext(keys), keys[depth - 1])];
    }
    async handle(parsingContext, util, key, keys, value, depth, testResult) {
        parsingContext.emittedStack[depth] = false; // We will emit a level higher
        return testResult.handle(parsingContext, keys, value, depth);
    }
}
EntryHandlerContainer.CONTAINER_HANDLERS = {
    '@index': new ContainerHandlerIndex_1.ContainerHandlerIndex(),
    '@language': new ContainerHandlerLanguage_1.ContainerHandlerLanguage(),
};
exports.EntryHandlerContainer = EntryHandlerContainer;

},{"../Util":32,"../containerhandler/ContainerHandlerIndex":33,"../containerhandler/ContainerHandlerLanguage":34}],37:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * A catch-all for properties, that will either emit an error or ignore,
 * depending on whether or not the `errorOnInvalidIris` property is set.
 */
class EntryHandlerInvalidFallback {
    isPropertyHandler() {
        return false;
    }
    async validate(parsingContext, util, keys, depth, inProperty) {
        return false;
    }
    async test(parsingContext, util, key, keys, depth) {
        return true;
    }
    async handle(parsingContext, util, key, keys, value, depth) {
        parsingContext.emittedStack[depth] = false;
    }
}
exports.EntryHandlerInvalidFallback = EntryHandlerInvalidFallback;

},{}],38:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Util_1 = require("../Util");
/**
 * Interprets keys as predicates.
 * The most common case in JSON-LD processing.
 */
class EntryHandlerPredicate {
    /**
     * Handle the given predicate-object by either emitting it,
     * or by placing it in the appropriate stack for later emission when no @graph and/or @id has been defined.
     * @param {ParsingContext} parsingContext A parsing context.
     * @param {Util} util A utility instance.
     * @param {any[]} keys A stack of keys.
     * @param {number} depth The current depth.
     * @param parentKey The parent key.
     * @param {Term} predicate The predicate.
     * @param {Term} object The object.
     * @param {boolean} reverse If the property is reversed.
     * @return {Promise<void>} A promise resolving when handling is done.
     */
    static async handlePredicateObject(parsingContext, util, keys, depth, parentKey, predicate, object, reverse) {
        const depthProperties = depth - (parentKey === '@reverse' ? 1 : 0);
        const depthOffsetGraph = await util.getDepthOffsetGraph(depth, keys);
        const depthPropertiesGraph = depth - depthOffsetGraph;
        if (parsingContext.idStack[depthProperties]) {
            // Emit directly if the @id was already defined
            const subject = parsingContext.idStack[depthProperties];
            // Check if we're in a @graph context
            const atGraph = depthOffsetGraph >= 0;
            if (atGraph) {
                const graph = parsingContext.idStack[depthPropertiesGraph - 1];
                if (graph) {
                    // Emit our quad if graph @id is known
                    if (reverse) {
                        util.validateReverseSubject(object);
                        parsingContext.emitQuad(depth, util.dataFactory.quad(object, predicate, subject, graph));
                    }
                    else {
                        parsingContext.emitQuad(depth, util.dataFactory.quad(subject, predicate, object, graph));
                    }
                }
                else {
                    // Buffer our triple if graph @id is not known yet.
                    if (reverse) {
                        util.validateReverseSubject(object);
                        parsingContext.getUnidentifiedGraphBufferSafe(depthPropertiesGraph - 1).push({ subject: object, predicate, object: subject });
                    }
                    else {
                        parsingContext.getUnidentifiedGraphBufferSafe(depthPropertiesGraph - 1)
                            .push({ subject, predicate, object });
                    }
                }
            }
            else {
                // Emit if no @graph was applicable
                if (reverse) {
                    util.validateReverseSubject(object);
                    parsingContext.emitQuad(depth, util.dataFactory.quad(object, predicate, subject, util.getDefaultGraph()));
                }
                else {
                    parsingContext.emitQuad(depth, util.dataFactory.quad(subject, predicate, object, util.getDefaultGraph()));
                }
            }
        }
        else {
            // Buffer until our @id becomes known, or we go up the stack
            if (reverse) {
                util.validateReverseSubject(object);
            }
            parsingContext.getUnidentifiedValueBufferSafe(depthProperties).push({ predicate, object, reverse });
        }
    }
    isPropertyHandler() {
        return true;
    }
    async validate(parsingContext, util, keys, depth, inProperty) {
        return keys[depth] && !!await util.predicateToTerm(await parsingContext.getContext(keys), keys[depth]);
    }
    async test(parsingContext, util, key, keys, depth) {
        return keys[depth];
    }
    async handle(parsingContext, util, key, keys, value, depth, testResult) {
        const keyOriginal = keys[depth];
        const parentKey = await util.unaliasKeywordParent(keys, depth);
        const context = await parsingContext.getContext(keys);
        const predicate = await util.predicateToTerm(context, key);
        if (predicate) {
            const objectContext = await parsingContext.getContext(keys, 0);
            let object = await util.valueToTerm(objectContext, key, value, depth, keys);
            if (object) {
                const reverse = Util_1.Util.isPropertyReverse(context, keyOriginal, parentKey);
                // Special case if our term was defined as an @list, but does not occur in an array,
                // In that case we just emit it as an RDF list with a single element.
                const listValueContainer = Util_1.Util.getContextValueContainer(context, key) === '@list';
                if (listValueContainer || value['@list']) {
                    if ((listValueContainer || (value['@list'] && !Array.isArray(value['@list']))) && object !== util.rdfNil) {
                        const listPointer = util.dataFactory.blankNode();
                        parsingContext.emitQuad(depth, util.dataFactory.quad(listPointer, util.rdfRest, util.rdfNil, util.getDefaultGraph()));
                        parsingContext.emitQuad(depth, util.dataFactory.quad(listPointer, util.rdfFirst, object, util.getDefaultGraph()));
                        object = listPointer;
                    }
                    // Lists are not allowed in @reverse'd properties
                    if (reverse && !parsingContext.allowSubjectList) {
                        throw new Error(`Found illegal list value in subject position at ${key}`);
                    }
                }
                await EntryHandlerPredicate.handlePredicateObject(parsingContext, util, keys, depth, parentKey, predicate, object, reverse);
            }
            else {
                // An invalid value was encountered, so we ignore it higher in the stack.
                parsingContext.emittedStack[depth] = false;
            }
        }
    }
}
exports.EntryHandlerPredicate = EntryHandlerPredicate;

},{"../Util":32}],39:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * An abstract keyword entry handler.
 */
class EntryHandlerKeyword {
    constructor(keyword) {
        this.keyword = keyword;
    }
    isPropertyHandler() {
        return false;
    }
    async validate(parsingContext, util, keys, depth, inProperty) {
        return false;
    }
    async test(parsingContext, util, key, keys, depth) {
        return key === this.keyword;
    }
}
exports.EntryHandlerKeyword = EntryHandlerKeyword;

},{}],40:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const EntryHandlerKeyword_1 = require("./EntryHandlerKeyword");
/**
 * Handles @context entries.
 */
class EntryHandlerKeywordContext extends EntryHandlerKeyword_1.EntryHandlerKeyword {
    constructor() {
        super('@context');
    }
    async handle(parsingContext, util, key, keys, value, depth) {
        // Error if an out-of-order context was found when support is not enabled.
        if (!parsingContext.allowOutOfOrderContext && parsingContext.processingStack[depth]) {
            parsingContext.emitError(new Error('Found an out-of-order context, while support is not enabled.' +
                '(enable with `allowOutOfOrderContext`)'));
        }
        // Find the parent context to inherit from
        const parentContext = parsingContext.getContext(keys.slice(0, -1));
        // Set the context for this scope
        const context = parsingContext.contextParser.parse(value, { baseIri: parsingContext.baseIRI, parentContext: await parentContext });
        parsingContext.contextTree.setContext(keys.slice(0, -1), context);
        parsingContext.emitContext(value);
        await parsingContext.validateContext(await context);
    }
}
exports.EntryHandlerKeywordContext = EntryHandlerKeywordContext;

},{"./EntryHandlerKeyword":39}],41:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const EntryHandlerKeyword_1 = require("./EntryHandlerKeyword");
/**
 * Handles @graph entries.
 */
class EntryHandlerKeywordGraph extends EntryHandlerKeyword_1.EntryHandlerKeyword {
    constructor() {
        super('@graph');
    }
    async handle(parsingContext, util, key, keys, value, depth) {
        // The current identifier identifies a graph for the deeper level.
        parsingContext.graphStack[depth + 1] = true;
    }
}
exports.EntryHandlerKeywordGraph = EntryHandlerKeywordGraph;

},{"./EntryHandlerKeyword":39}],42:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const EntryHandlerKeyword_1 = require("./EntryHandlerKeyword");
/**
 * Handles @id entries.
 */
class EntryHandlerKeywordId extends EntryHandlerKeyword_1.EntryHandlerKeyword {
    constructor() {
        super('@id');
    }
    async handle(parsingContext, util, key, keys, value, depth) {
        // Error if an @id for this node already existed.
        if (parsingContext.idStack[depth] !== undefined) {
            parsingContext.emitError(new Error(`Found duplicate @ids '${parsingContext
                .idStack[depth].value}' and '${value}'`));
        }
        // Save our @id on the stack
        parsingContext.idStack[depth] = await util.resourceToTerm(await parsingContext.getContext(keys), value);
    }
}
exports.EntryHandlerKeywordId = EntryHandlerKeywordId;

},{"./EntryHandlerKeyword":39}],43:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Util_1 = require("../../Util");
const EntryHandlerKeyword_1 = require("./EntryHandlerKeyword");
const EntryHandlerPredicate_1 = require("../EntryHandlerPredicate");
/**
 * Handles @graph entries.
 */
class EntryHandlerKeywordType extends EntryHandlerKeyword_1.EntryHandlerKeyword {
    constructor() {
        super('@type');
    }
    async handle(parsingContext, util, key, keys, value, depth) {
        const keyOriginal = keys[depth];
        const parentKey = await util.unaliasKeywordParent(keys, depth);
        // The current identifier identifies an rdf:type predicate.
        // But we only emit it once the node closes,
        // as it's possible that the @type is used to identify the datatype of a literal, which we ignore here.
        const context = await parsingContext.getContext(keys);
        const predicate = util.rdfType;
        const reverse = Util_1.Util.isPropertyReverse(context, keyOriginal, parentKey);
        // Handle multiple values if the value is an array
        if (Array.isArray(value)) {
            for (const element of value) {
                const type = util.createVocabOrBaseTerm(context, element);
                if (type) {
                    await EntryHandlerPredicate_1.EntryHandlerPredicate.handlePredicateObject(parsingContext, util, keys, depth, parentKey, predicate, type, reverse);
                }
            }
        }
        else {
            const type = util.createVocabOrBaseTerm(context, value);
            if (type) {
                await EntryHandlerPredicate_1.EntryHandlerPredicate.handlePredicateObject(parsingContext, util, keys, depth, parentKey, predicate, type, reverse);
            }
        }
    }
}
exports.EntryHandlerKeywordType = EntryHandlerKeywordType;

},{"../../Util":32,"../EntryHandlerPredicate":38,"./EntryHandlerKeyword":39}],44:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Util_1 = require("../../Util");
/**
 * A catch-all for keywords, that will either emit an error or ignore,
 * depending on whether or not the `errorOnInvalidIris` property is set.
 */
class EntryHandlerKeywordUnknownFallback {
    isPropertyHandler() {
        return false;
    }
    async validate(parsingContext, util, keys, depth, inProperty) {
        const key = await util.unaliasKeyword(keys[depth], keys, depth);
        if (Util_1.Util.isKeyword(key)) {
            // Don't emit anything inside free-floating lists
            if (!inProperty) {
                if (key === '@list') {
                    return false;
                }
            }
            return true;
        }
        return false;
    }
    async test(parsingContext, util, key, keys, depth) {
        return Util_1.Util.isKeyword(key);
    }
    async handle(parsingContext, util, key, keys, value, depth) {
        const keywordType = EntryHandlerKeywordUnknownFallback.VALID_KEYWORDS_TYPES[key];
        if (keywordType !== undefined) {
            if (keywordType && typeof value !== keywordType) {
                parsingContext.emitError(new Error(`Invalid value type for '${key}' with value '${value}'`));
            }
        }
        else if (parsingContext.errorOnInvalidProperties) {
            parsingContext.emitError(new Error(`Unknown keyword '${key}' with value '${value}'`));
        }
        parsingContext.emittedStack[depth] = false;
    }
}
EntryHandlerKeywordUnknownFallback.VALID_KEYWORDS_TYPES = {
    '@index': 'string',
    '@list': null,
    '@reverse': 'object',
    '@set': null,
    '@value': null,
};
exports.EntryHandlerKeywordUnknownFallback = EntryHandlerKeywordUnknownFallback;

},{"../../Util":32}],45:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const EntryHandlerKeyword_1 = require("./EntryHandlerKeyword");
/**
 * Handles @value entries.
 */
class EntryHandlerKeywordValue extends EntryHandlerKeyword_1.EntryHandlerKeyword {
    constructor() {
        super('@value');
    }
    async handle(parsingContext, util, key, keys, value, depth) {
        // If the value is valid, indicate that we are processing a literal.
        // The actual value will be determined at the parent level when the @value is part of an object,
        // because we may want to take into account additional entries such as @language.
        // See {@link Util.valueToTerm}
        // Indicate that we are processing a literal, and that no later predicates should be parsed at this depth.
        parsingContext.literalStack[depth] = true;
        // Void any buffers that we may have accumulated up until now
        delete parsingContext.unidentifiedValuesBuffer[depth];
        delete parsingContext.unidentifiedGraphsBuffer[depth];
        // Indicate that we have not emitted at this depth
        parsingContext.emittedStack[depth] = false;
    }
}
exports.EntryHandlerKeywordValue = EntryHandlerKeywordValue;

},{"./EntryHandlerKeyword":39}],46:[function(require,module,exports){
(function (Buffer){
/*global Buffer*/
// Named constants with unique integer values
var C = {};
// Tokens
var LEFT_BRACE    = C.LEFT_BRACE    = 0x1;
var RIGHT_BRACE   = C.RIGHT_BRACE   = 0x2;
var LEFT_BRACKET  = C.LEFT_BRACKET  = 0x3;
var RIGHT_BRACKET = C.RIGHT_BRACKET = 0x4;
var COLON         = C.COLON         = 0x5;
var COMMA         = C.COMMA         = 0x6;
var TRUE          = C.TRUE          = 0x7;
var FALSE         = C.FALSE         = 0x8;
var NULL          = C.NULL          = 0x9;
var STRING        = C.STRING        = 0xa;
var NUMBER        = C.NUMBER        = 0xb;
// Tokenizer States
var START   = C.START   = 0x11;
var STOP    = C.STOP    = 0x12;
var TRUE1   = C.TRUE1   = 0x21;
var TRUE2   = C.TRUE2   = 0x22;
var TRUE3   = C.TRUE3   = 0x23;
var FALSE1  = C.FALSE1  = 0x31;
var FALSE2  = C.FALSE2  = 0x32;
var FALSE3  = C.FALSE3  = 0x33;
var FALSE4  = C.FALSE4  = 0x34;
var NULL1   = C.NULL1   = 0x41;
var NULL2   = C.NULL2   = 0x42;
var NULL3   = C.NULL3   = 0x43;
var NUMBER1 = C.NUMBER1 = 0x51;
var NUMBER3 = C.NUMBER3 = 0x53;
var STRING1 = C.STRING1 = 0x61;
var STRING2 = C.STRING2 = 0x62;
var STRING3 = C.STRING3 = 0x63;
var STRING4 = C.STRING4 = 0x64;
var STRING5 = C.STRING5 = 0x65;
var STRING6 = C.STRING6 = 0x66;
// Parser States
var VALUE   = C.VALUE   = 0x71;
var KEY     = C.KEY     = 0x72;
// Parser Modes
var OBJECT  = C.OBJECT  = 0x81;
var ARRAY   = C.ARRAY   = 0x82;
// Character constants
var BACK_SLASH =      "\\".charCodeAt(0);
var FORWARD_SLASH =   "\/".charCodeAt(0);
var BACKSPACE =       "\b".charCodeAt(0);
var FORM_FEED =       "\f".charCodeAt(0);
var NEWLINE =         "\n".charCodeAt(0);
var CARRIAGE_RETURN = "\r".charCodeAt(0);
var TAB =             "\t".charCodeAt(0);

var STRING_BUFFER_SIZE = 64 * 1024;

function Parser() {
  this.tState = START;
  this.value = undefined;

  this.string = undefined; // string data
  this.stringBuffer = Buffer.alloc ? Buffer.alloc(STRING_BUFFER_SIZE) : new Buffer(STRING_BUFFER_SIZE);
  this.stringBufferOffset = 0;
  this.unicode = undefined; // unicode escapes
  this.highSurrogate = undefined;

  this.key = undefined;
  this.mode = undefined;
  this.stack = [];
  this.state = VALUE;
  this.bytes_remaining = 0; // number of bytes remaining in multi byte utf8 char to read after split boundary
  this.bytes_in_sequence = 0; // bytes in multi byte utf8 char to read
  this.temp_buffs = { "2": new Buffer(2), "3": new Buffer(3), "4": new Buffer(4) }; // for rebuilding chars split before boundary is reached

  // Stream offset
  this.offset = -1;
}

// Slow code to string converter (only used when throwing syntax errors)
Parser.toknam = function (code) {
  var keys = Object.keys(C);
  for (var i = 0, l = keys.length; i < l; i++) {
    var key = keys[i];
    if (C[key] === code) { return key; }
  }
  return code && ("0x" + code.toString(16));
};

var proto = Parser.prototype;
proto.onError = function (err) { throw err; };
proto.charError = function (buffer, i) {
  this.tState = STOP;
  this.onError(new Error("Unexpected " + JSON.stringify(String.fromCharCode(buffer[i])) + " at position " + i + " in state " + Parser.toknam(this.tState)));
};
proto.appendStringChar = function (char) {
  if (this.stringBufferOffset >= STRING_BUFFER_SIZE) {
    this.string += this.stringBuffer.toString('utf8');
    this.stringBufferOffset = 0;
  }

  this.stringBuffer[this.stringBufferOffset++] = char;
};
proto.appendStringBuf = function (buf, start, end) {
  var size = buf.length;
  if (typeof start === 'number') {
    if (typeof end === 'number') {
      if (end < 0) {
        // adding a negative end decreeses the size
        size = buf.length - start + end;
      } else {
        size = end - start;
      }
    } else {
      size = buf.length - start;
    }
  }

  if (size < 0) {
    size = 0;
  }

  if (this.stringBufferOffset + size > STRING_BUFFER_SIZE) {
    this.string += this.stringBuffer.toString('utf8', 0, this.stringBufferOffset);
    this.stringBufferOffset = 0;
  }

  buf.copy(this.stringBuffer, this.stringBufferOffset, start, end);
  this.stringBufferOffset += size;
};
proto.write = function (buffer) {
  if (typeof buffer === "string") buffer = new Buffer(buffer);
  var n;
  for (var i = 0, l = buffer.length; i < l; i++) {
    if (this.tState === START){
      n = buffer[i];
      this.offset++;
      if(n === 0x7b){ this.onToken(LEFT_BRACE, "{"); // {
      }else if(n === 0x7d){ this.onToken(RIGHT_BRACE, "}"); // }
      }else if(n === 0x5b){ this.onToken(LEFT_BRACKET, "["); // [
      }else if(n === 0x5d){ this.onToken(RIGHT_BRACKET, "]"); // ]
      }else if(n === 0x3a){ this.onToken(COLON, ":");  // :
      }else if(n === 0x2c){ this.onToken(COMMA, ","); // ,
      }else if(n === 0x74){ this.tState = TRUE1;  // t
      }else if(n === 0x66){ this.tState = FALSE1;  // f
      }else if(n === 0x6e){ this.tState = NULL1; // n
      }else if(n === 0x22){ // "
        this.string = "";
        this.stringBufferOffset = 0;
        this.tState = STRING1;
      }else if(n === 0x2d){ this.string = "-"; this.tState = NUMBER1; // -
      }else{
        if (n >= 0x30 && n < 0x40) { // 1-9
          this.string = String.fromCharCode(n); this.tState = NUMBER3;
        } else if (n === 0x20 || n === 0x09 || n === 0x0a || n === 0x0d) {
          // whitespace
        } else {
          return this.charError(buffer, i);
        }
      }
    }else if (this.tState === STRING1){ // After open quote
      n = buffer[i]; // get current byte from buffer
      // check for carry over of a multi byte char split between data chunks
      // & fill temp buffer it with start of this data chunk up to the boundary limit set in the last iteration
      if (this.bytes_remaining > 0) {
        for (var j = 0; j < this.bytes_remaining; j++) {
          this.temp_buffs[this.bytes_in_sequence][this.bytes_in_sequence - this.bytes_remaining + j] = buffer[j];
        }

        this.appendStringBuf(this.temp_buffs[this.bytes_in_sequence]);
        this.bytes_in_sequence = this.bytes_remaining = 0;
        i = i + j - 1;
      } else if (this.bytes_remaining === 0 && n >= 128) { // else if no remainder bytes carried over, parse multi byte (>=128) chars one at a time
        if (n <= 193 || n > 244) {
          return this.onError(new Error("Invalid UTF-8 character at position " + i + " in state " + Parser.toknam(this.tState)));
        }
        if ((n >= 194) && (n <= 223)) this.bytes_in_sequence = 2;
        if ((n >= 224) && (n <= 239)) this.bytes_in_sequence = 3;
        if ((n >= 240) && (n <= 244)) this.bytes_in_sequence = 4;
        if ((this.bytes_in_sequence + i) > buffer.length) { // if bytes needed to complete char fall outside buffer length, we have a boundary split
          for (var k = 0; k <= (buffer.length - 1 - i); k++) {
            this.temp_buffs[this.bytes_in_sequence][k] = buffer[i + k]; // fill temp buffer of correct size with bytes available in this chunk
          }
          this.bytes_remaining = (i + this.bytes_in_sequence) - buffer.length;
          i = buffer.length - 1;
        } else {
          this.appendStringBuf(buffer, i, i + this.bytes_in_sequence);
          i = i + this.bytes_in_sequence - 1;
        }
      } else if (n === 0x22) {
        this.tState = START;
        this.string += this.stringBuffer.toString('utf8', 0, this.stringBufferOffset);
        this.stringBufferOffset = 0;
        this.onToken(STRING, this.string);
        this.offset += Buffer.byteLength(this.string, 'utf8') + 1;
        this.string = undefined;
      }
      else if (n === 0x5c) {
        this.tState = STRING2;
      }
      else if (n >= 0x20) { this.appendStringChar(n); }
      else {
          return this.charError(buffer, i);
      }
    }else if (this.tState === STRING2){ // After backslash
      n = buffer[i];
      if(n === 0x22){ this.appendStringChar(n); this.tState = STRING1;
      }else if(n === 0x5c){ this.appendStringChar(BACK_SLASH); this.tState = STRING1;
      }else if(n === 0x2f){ this.appendStringChar(FORWARD_SLASH); this.tState = STRING1;
      }else if(n === 0x62){ this.appendStringChar(BACKSPACE); this.tState = STRING1;
      }else if(n === 0x66){ this.appendStringChar(FORM_FEED); this.tState = STRING1;
      }else if(n === 0x6e){ this.appendStringChar(NEWLINE); this.tState = STRING1;
      }else if(n === 0x72){ this.appendStringChar(CARRIAGE_RETURN); this.tState = STRING1;
      }else if(n === 0x74){ this.appendStringChar(TAB); this.tState = STRING1;
      }else if(n === 0x75){ this.unicode = ""; this.tState = STRING3;
      }else{
        return this.charError(buffer, i);
      }
    }else if (this.tState === STRING3 || this.tState === STRING4 || this.tState === STRING5 || this.tState === STRING6){ // unicode hex codes
      n = buffer[i];
      // 0-9 A-F a-f
      if ((n >= 0x30 && n < 0x40) || (n > 0x40 && n <= 0x46) || (n > 0x60 && n <= 0x66)) {
        this.unicode += String.fromCharCode(n);
        if (this.tState++ === STRING6) {
          var intVal = parseInt(this.unicode, 16);
          this.unicode = undefined;
          if (this.highSurrogate !== undefined && intVal >= 0xDC00 && intVal < (0xDFFF + 1)) { //<56320,57343> - lowSurrogate
            this.appendStringBuf(new Buffer(String.fromCharCode(this.highSurrogate, intVal)));
            this.highSurrogate = undefined;
          } else if (this.highSurrogate === undefined && intVal >= 0xD800 && intVal < (0xDBFF + 1)) { //<55296,56319> - highSurrogate
            this.highSurrogate = intVal;
          } else {
            if (this.highSurrogate !== undefined) {
              this.appendStringBuf(new Buffer(String.fromCharCode(this.highSurrogate)));
              this.highSurrogate = undefined;
            }
            this.appendStringBuf(new Buffer(String.fromCharCode(intVal)));
          }
          this.tState = STRING1;
        }
      } else {
        return this.charError(buffer, i);
      }
    } else if (this.tState === NUMBER1 || this.tState === NUMBER3) {
        n = buffer[i];

        switch (n) {
          case 0x30: // 0
          case 0x31: // 1
          case 0x32: // 2
          case 0x33: // 3
          case 0x34: // 4
          case 0x35: // 5
          case 0x36: // 6
          case 0x37: // 7
          case 0x38: // 8
          case 0x39: // 9
          case 0x2e: // .
          case 0x65: // e
          case 0x45: // E
          case 0x2b: // +
          case 0x2d: // -
            this.string += String.fromCharCode(n);
            this.tState = NUMBER3;
            break;
          default:
            this.tState = START;
            var result = Number(this.string);

            if (isNaN(result)){
              return this.charError(buffer, i);
            }

            if ((this.string.match(/[0-9]+/) == this.string) && (result.toString() != this.string)) {
              // Long string of digits which is an ID string and not valid and/or safe JavaScript integer Number
              this.onToken(STRING, this.string);
            } else {
              this.onToken(NUMBER, result);
            }

            this.offset += this.string.length - 1;
            this.string = undefined;
            i--;
            break;
        }
    }else if (this.tState === TRUE1){ // r
      if (buffer[i] === 0x72) { this.tState = TRUE2; }
      else { return this.charError(buffer, i); }
    }else if (this.tState === TRUE2){ // u
      if (buffer[i] === 0x75) { this.tState = TRUE3; }
      else { return this.charError(buffer, i); }
    }else if (this.tState === TRUE3){ // e
      if (buffer[i] === 0x65) { this.tState = START; this.onToken(TRUE, true); this.offset+= 3; }
      else { return this.charError(buffer, i); }
    }else if (this.tState === FALSE1){ // a
      if (buffer[i] === 0x61) { this.tState = FALSE2; }
      else { return this.charError(buffer, i); }
    }else if (this.tState === FALSE2){ // l
      if (buffer[i] === 0x6c) { this.tState = FALSE3; }
      else { return this.charError(buffer, i); }
    }else if (this.tState === FALSE3){ // s
      if (buffer[i] === 0x73) { this.tState = FALSE4; }
      else { return this.charError(buffer, i); }
    }else if (this.tState === FALSE4){ // e
      if (buffer[i] === 0x65) { this.tState = START; this.onToken(FALSE, false); this.offset+= 4; }
      else { return this.charError(buffer, i); }
    }else if (this.tState === NULL1){ // u
      if (buffer[i] === 0x75) { this.tState = NULL2; }
      else { return this.charError(buffer, i); }
    }else if (this.tState === NULL2){ // l
      if (buffer[i] === 0x6c) { this.tState = NULL3; }
      else { return this.charError(buffer, i); }
    }else if (this.tState === NULL3){ // l
      if (buffer[i] === 0x6c) { this.tState = START; this.onToken(NULL, null); this.offset += 3; }
      else { return this.charError(buffer, i); }
    }
  }
};
proto.onToken = function (token, value) {
  // Override this to get events
};

proto.parseError = function (token, value) {
  this.tState = STOP;
  this.onError(new Error("Unexpected " + Parser.toknam(token) + (value ? ("(" + JSON.stringify(value) + ")") : "") + " in state " + Parser.toknam(this.state)));
};
proto.push = function () {
  this.stack.push({value: this.value, key: this.key, mode: this.mode});
};
proto.pop = function () {
  var value = this.value;
  var parent = this.stack.pop();
  this.value = parent.value;
  this.key = parent.key;
  this.mode = parent.mode;
  this.emit(value);
  if (!this.mode) { this.state = VALUE; }
};
proto.emit = function (value) {
  if (this.mode) { this.state = COMMA; }
  this.onValue(value);
};
proto.onValue = function (value) {
  // Override me
};
proto.onToken = function (token, value) {
  if(this.state === VALUE){
    if(token === STRING || token === NUMBER || token === TRUE || token === FALSE || token === NULL){
      if (this.value) {
        this.value[this.key] = value;
      }
      this.emit(value);
    }else if(token === LEFT_BRACE){
      this.push();
      if (this.value) {
        this.value = this.value[this.key] = {};
      } else {
        this.value = {};
      }
      this.key = undefined;
      this.state = KEY;
      this.mode = OBJECT;
    }else if(token === LEFT_BRACKET){
      this.push();
      if (this.value) {
        this.value = this.value[this.key] = [];
      } else {
        this.value = [];
      }
      this.key = 0;
      this.mode = ARRAY;
      this.state = VALUE;
    }else if(token === RIGHT_BRACE){
      if (this.mode === OBJECT) {
        this.pop();
      } else {
        return this.parseError(token, value);
      }
    }else if(token === RIGHT_BRACKET){
      if (this.mode === ARRAY) {
        this.pop();
      } else {
        return this.parseError(token, value);
      }
    }else{
      return this.parseError(token, value);
    }
  }else if(this.state === KEY){
    if (token === STRING) {
      this.key = value;
      this.state = COLON;
    } else if (token === RIGHT_BRACE) {
      this.pop();
    } else {
      return this.parseError(token, value);
    }
  }else if(this.state === COLON){
    if (token === COLON) { this.state = VALUE; }
    else { return this.parseError(token, value); }
  }else if(this.state === COMMA){
    if (token === COMMA) {
      if (this.mode === ARRAY) { this.key++; this.state = VALUE; }
      else if (this.mode === OBJECT) { this.state = KEY; }

    } else if (token === RIGHT_BRACKET && this.mode === ARRAY || token === RIGHT_BRACE && this.mode === OBJECT) {
      this.pop();
    } else {
      return this.parseError(token, value);
    }
  }else{
    return this.parseError(token, value);
  }
};

Parser.C = C;

module.exports = Parser;

}).call(this,require("buffer").Buffer)
},{"buffer":14}],47:[function(require,module,exports){
"use strict";
function __export(m) {
    for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
}
Object.defineProperty(exports, "__esModule", { value: true });
__export(require("./lib/JsonLdSerializer"));
__export(require("./lib/Util"));

},{"./lib/JsonLdSerializer":48,"./lib/Util":50}],48:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const jsonld_context_parser_1 = require("jsonld-context-parser");
const stream_1 = require("stream");
const SeparatorType_1 = require("./SeparatorType");
const Util_1 = require("./Util");
/**
 * A stream transformer that transforms an {@link RDF.Stream} into a JSON-LD (text) stream.
 */
class JsonLdSerializer extends stream_1.Transform {
    constructor(options = {}) {
        super({ objectMode: true });
        this.indentation = 0;
        this.options = options;
        // Parse the context
        if (this.options.baseIRI && !this.options.context) {
            this.options.context = { '@base': this.options.baseIRI };
        }
        if (this.options.context) {
            this.originalContext = this.options.context;
            this.context = new jsonld_context_parser_1.ContextParser().parse(this.options.context, { baseIri: this.options.baseIRI });
        }
        else {
            this.context = Promise.resolve({});
        }
    }
    /**
     * Parses the given text stream into a quad stream.
     * @param {NodeJS.EventEmitter} stream A text stream.
     * @return {NodeJS.EventEmitter} A quad stream.
     */
    import(stream) {
        const output = new stream_1.PassThrough({ objectMode: true });
        stream.on('error', (error) => parsed.emit('error', error));
        stream.on('data', (data) => output.write(data));
        stream.on('end', () => output.emit('end'));
        const parsed = output.pipe(new JsonLdSerializer(this.options));
        return parsed;
    }
    /**
     * Transforms a quad into the text stream.
     * @param {Quad} quad An RDF quad.
     * @param {string} encoding An (ignored) encoding.
     * @param {module:stream.internal.TransformCallback} callback Callback that is invoked when the transformation is done
     * @private
     */
    _transform(quad, encoding, callback) {
        this.context.then((context) => {
            this.transformQuad(quad, context);
            callback();
        }).catch(callback);
    }
    /**
     * Construct a list in an RDF.Term object that can be used
     * inside a quad's object to write into the serializer
     * as a list using the @list keyword.
     * @param {Term[]} values A list of values, can be empty.
     * @return {Term} A term that should be used in the object position of the quad that is written to the serializer.
     */
    list(values) {
        return {
            '@list': values.map((value) => Util_1.Util.termToValue(value, this.options)),
        };
    }
    /**
     * Claled when the incoming stream is closed.
     * @param {module:stream.internal.TransformCallback} callback Callback that is invoked when the flushing is done.
     * @private
     */
    _flush(callback) {
        // If the stream was empty, ensure that we push the opening array
        if (!this.opened) {
            this.pushDocumentStart();
        }
        if (this.lastPredicate) {
            this.endPredicate();
        }
        if (this.lastSubject) {
            this.endSubject();
        }
        if (this.lastGraph && this.lastGraph.termType !== 'DefaultGraph') {
            this.endGraph();
        }
        this.endDocument();
        return callback(null, null);
    }
    /**
     * Transforms a quad into the text stream.
     * @param {Quad} quad An RDF quad.
     * @param {IJsonLdContextNormalized} context A context for compacting.
     */
    transformQuad(quad, context) {
        // Open the array before the first quad
        if (!this.opened) {
            this.pushDocumentStart();
        }
        // Check if the subject equals the last named graph
        // In that case, we can reuse the already-existing @id node
        const lastGraphMatchesSubject = this.lastGraph && this.lastGraph.termType !== 'DefaultGraph'
            && this.lastGraph.equals(quad.subject);
        // Write graph
        if (!lastGraphMatchesSubject && (!this.lastGraph || !quad.graph.equals(this.lastGraph))) {
            // Check if the named graph equals the last subject
            // In that case, we can reuse the already-existing @id node
            let lastSubjectMatchesGraph = quad.graph.termType !== 'DefaultGraph'
                && this.lastSubject && this.lastSubject.equals(quad.graph);
            if (this.lastGraph) {
                if (this.lastGraph.termType !== 'DefaultGraph') {
                    // The last graph was named
                    this.endPredicate();
                    this.endSubject();
                    this.endGraph(true);
                    lastSubjectMatchesGraph = false; // Special-case to avoid deeper nesting
                }
                else {
                    // The last graph was default
                    if (!lastSubjectMatchesGraph) {
                        this.endPredicate();
                        this.endSubject(true);
                    }
                    else {
                        this.endPredicate(true);
                        this.lastSubject = null;
                    }
                }
            }
            // Push the graph
            if (quad.graph.termType !== 'DefaultGraph') {
                if (!lastSubjectMatchesGraph) {
                    this.pushId(quad.graph, context);
                }
                this.pushSeparator(this.options.space
                    ? SeparatorType_1.SeparatorType.GRAPH_FIELD_NONCOMPACT : SeparatorType_1.SeparatorType.GRAPH_FIELD_COMPACT);
                this.indentation++;
            }
            this.lastGraph = quad.graph;
        }
        // Write subject
        if (!this.lastSubject || !quad.subject.equals(this.lastSubject)) {
            if (lastGraphMatchesSubject) {
                this.endPredicate();
                this.endSubject();
                this.indentation--;
                this.pushSeparator(SeparatorType_1.SeparatorType.ARRAY_END_COMMA);
                this.lastGraph = quad.graph;
            }
            else {
                if (this.lastSubject) {
                    this.endPredicate();
                    this.endSubject(true);
                }
                // Open a new node for the new subject
                this.pushId(quad.subject, context);
            }
            this.lastSubject = quad.subject;
        }
        // Write predicate
        if (!this.lastPredicate || !quad.predicate.equals(this.lastPredicate)) {
            if (this.lastPredicate) {
                this.endPredicate(true);
            }
            // Open a new array for the new predicate
            this.pushPredicate(quad.predicate, context);
        }
        // Write the object value
        this.pushObject(quad.object, context);
    }
    pushDocumentStart() {
        this.opened = true;
        if (this.originalContext && !this.options.excludeContext) {
            this.pushSeparator(SeparatorType_1.SeparatorType.OBJECT_START);
            this.indentation++;
            this.pushSeparator(SeparatorType_1.SeparatorType.CONTEXT_FIELD);
            this.pushIndented(JSON.stringify(this.originalContext, null, this.options.space) + ',');
            this.pushSeparator(this.options.space
                ? SeparatorType_1.SeparatorType.GRAPH_FIELD_NONCOMPACT : SeparatorType_1.SeparatorType.GRAPH_FIELD_COMPACT);
            this.indentation++;
        }
        else {
            this.pushSeparator(SeparatorType_1.SeparatorType.ARRAY_START);
            this.indentation++;
        }
    }
    /**
     * Push the given term as an @id field.
     * @param {Term} term An RDF term.
     * @param {IJsonLdContextNormalized} context The context.
     */
    pushId(term, context) {
        const subjectValue = term.termType === 'BlankNode'
            ? '_:' + term.value : jsonld_context_parser_1.ContextParser.compactIri(term.value, context, false);
        this.pushSeparator(SeparatorType_1.SeparatorType.OBJECT_START);
        this.indentation++;
        this.pushIndented(this.options.space ? `"@id": "${subjectValue}",` : `"@id":"${subjectValue}",`);
    }
    /**
     * Push the given predicate field.
     * @param {Term} predicate An RDF term.
     * @param {IJsonLdContextNormalized} context The context.
     */
    pushPredicate(predicate, context) {
        let property = predicate.value;
        // Convert rdf:type into @type if not disabled.
        if (!this.options.useRdfType && property === Util_1.Util.RDF_TYPE) {
            property = '@type';
            this.objectOptions = Object.assign({}, this.options, { compactIds: true, vocab: true });
        }
        // Open array for following objects
        const compactedProperty = jsonld_context_parser_1.ContextParser.compactIri(property, context, true);
        this.pushIndented(this.options.space ? `"${compactedProperty}": [` : `"${compactedProperty}":[`);
        this.indentation++;
        this.lastPredicate = predicate;
    }
    /**
     * Push the given object value.
     * @param {Term} object An RDF term.
     * @param {IJsonLdContextNormalized} context The context.
     */
    pushObject(object, context) {
        // Add a comma if we already had an object for this predicate
        if (!this.hadObjectForPredicate) {
            this.hadObjectForPredicate = true;
        }
        else {
            this.pushSeparator(SeparatorType_1.SeparatorType.COMMA);
        }
        // Convert the object into a value and push it
        let value;
        try {
            if (object['@list']) {
                value = object;
            }
            else {
                value = Util_1.Util.termToValue(object, context, this.objectOptions || this.options);
            }
        }
        catch (e) {
            return this.emit('error', e);
        }
        this.pushIndented(JSON.stringify(value, null, this.options.space));
    }
    endDocument() {
        this.opened = false;
        if (this.originalContext && !this.options.excludeContext) {
            this.indentation--;
            this.pushSeparator(SeparatorType_1.SeparatorType.ARRAY_END);
            this.indentation--;
            this.pushSeparator(SeparatorType_1.SeparatorType.OBJECT_END);
        }
        else {
            this.indentation--;
            this.pushSeparator(SeparatorType_1.SeparatorType.ARRAY_END);
        }
    }
    /**
     * Push the end of a predicate and reset the buffers.
     * @param {boolean} comma If a comma should be appended.
     */
    endPredicate(comma) {
        // Close the predicate array
        this.indentation--;
        this.pushSeparator(comma ? SeparatorType_1.SeparatorType.ARRAY_END_COMMA : SeparatorType_1.SeparatorType.ARRAY_END);
        // Reset object buffer
        this.hadObjectForPredicate = false;
        this.objectOptions = null;
        // Reset predicate buffer
        this.lastPredicate = null;
    }
    /**
     * Push the end of a subject and reset the buffers.
     * @param {boolean} comma If a comma should be appended.
     */
    endSubject(comma) {
        // Close the last subject's node;
        this.indentation--;
        this.pushSeparator(comma ? SeparatorType_1.SeparatorType.OBJECT_END_COMMA : SeparatorType_1.SeparatorType.OBJECT_END);
        // Reset subject buffer
        this.lastSubject = null;
    }
    /**
     * Push the end of a graph and reset the buffers.
     * @param {boolean} comma If a comma should be appended.
     */
    endGraph(comma) {
        // Close the graph array
        this.indentation--;
        this.pushSeparator(SeparatorType_1.SeparatorType.ARRAY_END);
        // Close the graph id node
        this.indentation--;
        this.pushSeparator(comma ? SeparatorType_1.SeparatorType.OBJECT_END_COMMA : SeparatorType_1.SeparatorType.OBJECT_END);
        // Reset graph buffer
        this.lastGraph = null;
    }
    /**
     * Puh the given separator.
     * @param {SeparatorType} type A type of separator.
     */
    pushSeparator(type) {
        this.pushIndented(type.label);
    }
    /**
     * An indentation-aware variant of {@link #push}.
     * All strings that are pushed here will be prefixed by {@link #indentation} amount of spaces.
     * @param {string} data A string.
     */
    pushIndented(data) {
        const prefix = this.getIndentPrefix();
        const lines = data.split('\n').map((line) => prefix + line).join('\n');
        this.push(lines);
        if (this.options.space) {
            this.push('\n');
        }
    }
    /**
     * @return {string} Get the current indentation prefix based on {@link #indentation}.
     */
    getIndentPrefix() {
        return this.options.space ? this.options.space.repeat(this.indentation) : '';
    }
}
exports.JsonLdSerializer = JsonLdSerializer;

},{"./SeparatorType":49,"./Util":50,"jsonld-context-parser":25,"stream":83}],49:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * A type of JSON separator.
 */
class SeparatorType {
    constructor(label) {
        this.label = label;
    }
}
SeparatorType.COMMA = new SeparatorType(',');
SeparatorType.OBJECT_START = new SeparatorType('{');
SeparatorType.OBJECT_END = new SeparatorType('}');
SeparatorType.OBJECT_END_COMMA = new SeparatorType('},');
SeparatorType.ARRAY_START = new SeparatorType('[');
SeparatorType.ARRAY_END = new SeparatorType(']');
SeparatorType.ARRAY_END_COMMA = new SeparatorType('],');
SeparatorType.GRAPH_FIELD_NONCOMPACT = new SeparatorType('"@graph": [');
SeparatorType.GRAPH_FIELD_COMPACT = new SeparatorType('"@graph":[');
SeparatorType.CONTEXT_FIELD = new SeparatorType('"@context":');
exports.SeparatorType = SeparatorType;

},{}],50:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const jsonld_context_parser_1 = require("jsonld-context-parser");
/**
 * Utility functions and methods.
 */
class Util {
    /**
     * Convert an RDF term to a JSON value.
     * @param {Term} term An RDF term.
     * @param {IJsonLdContextNormalized} context The context.
     * @param {ITermToValueOptions} options Conversion options.
     * @return {any} A JSON value.
     */
    static termToValue(term, context, options = {
        compactIds: false,
        useNativeTypes: false,
    }) {
        switch (term.termType) {
            case 'NamedNode':
                const compacted = jsonld_context_parser_1.ContextParser.compactIri(term.value, context, options.vocab);
                return options.compactIds ? compacted : { '@id': compacted };
            case 'DefaultGraph':
                return options.compactIds ? term.value : { '@id': term.value };
            case 'BlankNode':
                const id = `_:${term.value}`;
                return options.compactIds ? id : { '@id': id };
            case 'Literal':
                const stringType = term.datatype.value === Util.XSD_STRING;
                const rawValue = {
                    '@value': !stringType && options.useNativeTypes
                        ? Util.stringToNativeType(term.value, term.datatype.value) : term.value,
                };
                if (term.language) {
                    return Object.assign({}, rawValue, { '@language': term.language });
                }
                else if (!stringType && typeof rawValue['@value'] === 'string') {
                    return Object.assign({}, rawValue, { '@type': term.datatype.value });
                }
                else {
                    return rawValue;
                }
        }
    }
    /**
     * Convert a string term to a native type.
     * If no conversion is possible, the original string will be returned.
     * @param {string} value An RDF term's string value.
     * @param {string} type
     * @return {any}
     */
    static stringToNativeType(value, type) {
        if (type.startsWith(Util.XSD)) {
            const xsdType = type.substr(Util.XSD.length);
            switch (xsdType) {
                case 'boolean':
                    if (value === 'true') {
                        return true;
                    }
                    else if (value === 'false') {
                        return false;
                    }
                    throw new Error(`Invalid xsd:boolean value '${value}'`);
                case 'integer':
                case 'number':
                case 'int':
                case 'byte':
                case 'long':
                    const parsedInt = parseInt(value, 10);
                    if (isNaN(parsedInt)) {
                        throw new Error(`Invalid xsd:integer value '${value}'`);
                    }
                    return parsedInt;
                case 'float':
                case 'decimal':
                case 'double':
                    const parsedFloat = parseFloat(value);
                    if (isNaN(parsedFloat)) {
                        throw new Error(`Invalid xsd:float value '${value}'`);
                    }
                    return parsedFloat;
            }
        }
        return value;
    }
}
Util.XSD = 'http://www.w3.org/2001/XMLSchema#';
Util.XSD_STRING = Util.XSD + 'string';
Util.RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
Util.RDF_TYPE = Util.RDF + 'type';
exports.Util = Util;

},{"jsonld-context-parser":25}],51:[function(require,module,exports){
/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} [options]
 * @throws {Error} throw an error if val is not a non-empty string or a number
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options) {
  options = options || {};
  var type = typeof val;
  if (type === 'string' && val.length > 0) {
    return parse(val);
  } else if (type === 'number' && isNaN(val) === false) {
    return options.long ? fmtLong(val) : fmtShort(val);
  }
  throw new Error(
    'val is not a non-empty string or a valid number. val=' +
      JSON.stringify(val)
  );
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str);
  if (str.length > 100) {
    return;
  }
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(
    str
  );
  if (!match) {
    return;
  }
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
    default:
      return undefined;
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtShort(ms) {
  if (ms >= d) {
    return Math.round(ms / d) + 'd';
  }
  if (ms >= h) {
    return Math.round(ms / h) + 'h';
  }
  if (ms >= m) {
    return Math.round(ms / m) + 'm';
  }
  if (ms >= s) {
    return Math.round(ms / s) + 's';
  }
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtLong(ms) {
  return plural(ms, d, 'day') ||
    plural(ms, h, 'hour') ||
    plural(ms, m, 'minute') ||
    plural(ms, s, 'second') ||
    ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) {
    return;
  }
  if (ms < n * 1.5) {
    return Math.floor(ms / n) + ' ' + name;
  }
  return Math.ceil(ms / n) + ' ' + name + 's';
}

},{}],52:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    XSD = 'http://www.w3.org/2001/XMLSchema#',
    SWAP = 'http://www.w3.org/2000/10/swap/';
var _default = {
  xsd: {
    decimal: XSD + 'decimal',
    boolean: XSD + 'boolean',
    double: XSD + 'double',
    integer: XSD + 'integer',
    string: XSD + 'string'
  },
  rdf: {
    type: RDF + 'type',
    nil: RDF + 'nil',
    first: RDF + 'first',
    rest: RDF + 'rest',
    langString: RDF + 'langString'
  },
  owl: {
    sameAs: 'http://www.w3.org/2002/07/owl#sameAs'
  },
  r: {
    forSome: SWAP + 'reify#forSome',
    forAll: SWAP + 'reify#forAll'
  },
  log: {
    implies: SWAP + 'log#implies'
  }
};
exports.default = _default;
},{}],53:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _IRIs = _interopRequireDefault(require("./IRIs"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// N3.js implementations of the RDF/JS core data types
// See https://github.com/rdfjs/representation-task-force/blob/master/interface-spec.md
const {
  rdf,
  xsd
} = _IRIs.default;
var DataFactory, DEFAULTGRAPH;
var _blankNodeCounter = 0; // ## Term constructor

class Term {
  constructor(id) {
    this.id = id;
  } // ### The value of this term


  get value() {
    return this.id;
  } // ### Returns whether this object represents the same term as the other


  equals(other) {
    // If both terms were created by this library,
    // equality can be computed through ids
    if (other instanceof Term) return this.id === other.id; // Otherwise, compare term type and value

    return !!other && this.termType === other.termType && this.value === other.value;
  } // ### Returns a plain object representation of this term


  toJSON() {
    return {
      termType: this.termType,
      value: this.value
    };
  }

} // ## NamedNode constructor


class NamedNode extends Term {
  // ### The term type of this term
  get termType() {
    return 'NamedNode';
  }

} // ## Literal constructor


class Literal extends Term {
  // ### The term type of this term
  get termType() {
    return 'Literal';
  } // ### The text value of this literal


  get value() {
    return this.id.substring(1, this.id.lastIndexOf('"'));
  } // ### The language of this literal


  get language() {
    // Find the last quotation mark (e.g., '"abc"@en-us')
    var id = this.id,
        atPos = id.lastIndexOf('"') + 1; // If "@" it follows, return the remaining substring; empty otherwise

    return atPos < id.length && id[atPos++] === '@' ? id.substr(atPos).toLowerCase() : '';
  } // ### The datatype IRI of this literal


  get datatype() {
    return new NamedNode(this.datatypeString);
  } // ### The datatype string of this literal


  get datatypeString() {
    // Find the last quotation mark (e.g., '"abc"^^http://ex.org/types#t')
    var id = this.id,
        dtPos = id.lastIndexOf('"') + 1,
        ch; // If "^" it follows, return the remaining substring

    return dtPos < id.length && (ch = id[dtPos]) === '^' ? id.substr(dtPos + 2) : // If "@" follows, return rdf:langString; xsd:string otherwise
    ch !== '@' ? xsd.string : rdf.langString;
  } // ### Returns whether this object represents the same term as the other


  equals(other) {
    // If both literals were created by this library,
    // equality can be computed through ids
    if (other instanceof Literal) return this.id === other.id; // Otherwise, compare term type, value, language, and datatype

    return !!other && !!other.datatype && this.termType === other.termType && this.value === other.value && this.language === other.language && this.datatype.value === other.datatype.value;
  }

  toJSON() {
    return {
      termType: this.termType,
      value: this.value,
      language: this.language,
      datatype: {
        termType: 'NamedNode',
        value: this.datatypeString
      }
    };
  }

} // ## BlankNode constructor


class BlankNode extends Term {
  constructor(name) {
    super('_:' + name);
  } // ### The term type of this term


  get termType() {
    return 'BlankNode';
  } // ### The name of this blank node


  get value() {
    return this.id.substr(2);
  }

}

class Variable extends Term {
  constructor(name) {
    super('?' + name);
  } // ### The term type of this term


  get termType() {
    return 'Variable';
  } // ### The name of this variable


  get value() {
    return this.id.substr(1);
  }

} // ## DefaultGraph constructor


class DefaultGraph extends Term {
  constructor() {
    super('');
    return DEFAULTGRAPH || this;
  } // ### The term type of this term


  get termType() {
    return 'DefaultGraph';
  } // ### Returns whether this object represents the same term as the other


  equals(other) {
    // If both terms were created by this library,
    // equality can be computed through strict equality;
    // otherwise, compare term types.
    return this === other || !!other && this.termType === other.termType;
  }

} // ## DefaultGraph singleton


DEFAULTGRAPH = new DefaultGraph(); // ### Constructs a term from the given internal string ID

function fromId(id, factory) {
  factory = factory || DataFactory; // Falsy value or empty string indicate the default graph

  if (!id) return factory.defaultGraph(); // Identify the term type based on the first character

  switch (id[0]) {
    case '_':
      return factory.blankNode(id.substr(2));

    case '?':
      return factory.variable(id.substr(1));

    case '"':
      // Shortcut for internal literals
      if (factory === DataFactory) return new Literal(id); // Literal without datatype or language

      if (id[id.length - 1] === '"') return factory.literal(id.substr(1, id.length - 2)); // Literal with datatype or language

      var endPos = id.lastIndexOf('"', id.length - 1);
      return factory.literal(id.substr(1, endPos - 1), id[endPos + 1] === '@' ? id.substr(endPos + 2) : factory.namedNode(id.substr(endPos + 3)));

    default:
      return factory.namedNode(id);
  }
} // ### Constructs an internal string ID from the given term or ID string


function toId(term) {
  if (typeof term === 'string') return term;
  if (term instanceof Term) return term.id;
  if (!term) return DEFAULTGRAPH.id; // Term instantiated with another library

  switch (term.termType) {
    case 'NamedNode':
      return term.value;

    case 'BlankNode':
      return '_:' + term.value;

    case 'Variable':
      return '?' + term.value;

    case 'DefaultGraph':
      return '';

    case 'Literal':
      return '"' + term.value + '"' + (term.language ? '@' + term.language : term.datatype && term.datatype.value !== xsd.string ? '^^' + term.datatype.value : '');

    default:
      throw new Error('Unexpected termType: ' + term.termType);
  }
} // ## Quad constructor


class Quad {
  constructor(subject, predicate, object, graph) {
    this.subject = subject;
    this.predicate = predicate;
    this.object = object;
    this.graph = graph || DEFAULTGRAPH;
  } // ### Returns a plain object representation of this quad


  toJSON() {
    return {
      subject: this.subject.toJSON(),
      predicate: this.predicate.toJSON(),
      object: this.object.toJSON(),
      graph: this.graph.toJSON()
    };
  } // ### Returns whether this object represents the same quad as the other


  equals(other) {
    return !!other && this.subject.equals(other.subject) && this.predicate.equals(other.predicate) && this.object.equals(other.object) && this.graph.equals(other.graph);
  }

} // ## DataFactory singleton


DataFactory = {
  // ### Public factory functions
  namedNode,
  blankNode,
  variable,
  literal,
  defaultGraph,
  quad,
  triple: quad,
  // ### Internal datatype constructors
  internal: {
    Term,
    NamedNode,
    BlankNode,
    Variable,
    Literal,
    DefaultGraph,
    Quad,
    Triple: Quad,
    fromId,
    toId
  }
};
var _default = DataFactory; // ### Creates an IRI

exports.default = _default;

function namedNode(iri) {
  return new NamedNode(iri);
} // ### Creates a blank node


function blankNode(name) {
  if (!name) name = 'n3-' + _blankNodeCounter++;
  return new BlankNode(name);
} // ### Creates a literal


function literal(value, languageOrDataType) {
  // Create a language-tagged string
  if (typeof languageOrDataType === 'string') return new Literal('"' + value + '"@' + languageOrDataType.toLowerCase()); // Automatically determine datatype for booleans and numbers

  let datatype = languageOrDataType ? languageOrDataType.value : '';

  if (datatype === '') {
    // Convert a boolean
    if (typeof value === 'boolean') datatype = xsd.boolean; // Convert an integer or double
    else if (typeof value === 'number') {
        if (Number.isFinite(value)) datatype = Number.isInteger(value) ? xsd.integer : xsd.double;else {
          datatype = xsd.double;
          if (!Number.isNaN(value)) value = value > 0 ? 'INF' : '-INF';
        }
      }
  } // Create a datatyped literal


  return datatype === '' || datatype === xsd.string ? new Literal('"' + value + '"') : new Literal('"' + value + '"^^' + datatype);
} // ### Creates a variable


function variable(name) {
  return new Variable(name);
} // ### Returns the default graph


function defaultGraph() {
  return DEFAULTGRAPH;
} // ### Creates a quad


function quad(subject, predicate, object, graph) {
  return new Quad(subject, predicate, object, graph);
}
},{"./IRIs":52}],54:[function(require,module,exports){
(function (Buffer,setImmediate){
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _IRIs = _interopRequireDefault(require("./IRIs"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// **N3Lexer** tokenizes N3 documents.
const {
  xsd
} = _IRIs.default;
const {
  fromCharCode
} = String; // Regular expression and replacement string to escape N3 strings.
// Note how we catch invalid unicode sequences separately (they will trigger an error).

var escapeSequence = /\\u([a-fA-F0-9]{4})|\\U([a-fA-F0-9]{8})|\\[uU]|\\(.)/g;
var escapeReplacements = {
  '\\': '\\',
  "'": "'",
  '"': '"',
  'n': '\n',
  'r': '\r',
  't': '\t',
  'f': '\f',
  'b': '\b',
  '_': '_',
  '~': '~',
  '.': '.',
  '-': '-',
  '!': '!',
  '$': '$',
  '&': '&',
  '(': '(',
  ')': ')',
  '*': '*',
  '+': '+',
  ',': ',',
  ';': ';',
  '=': '=',
  '/': '/',
  '?': '?',
  '#': '#',
  '@': '@',
  '%': '%'
};
var illegalIriChars = /[\x00-\x20<>\\"\{\}\|\^\`]/;
var lineModeRegExps = {
  _iri: true,
  _unescapedIri: true,
  _simpleQuotedString: true,
  _langcode: true,
  _blank: true,
  _newline: true,
  _comment: true,
  _whitespace: true,
  _endOfFile: true
};
var invalidRegExp = /$0^/; // ## Constructor

class N3Lexer {
  constructor(options) {
    // ## Regular expressions
    // It's slightly faster to have these as properties than as in-scope variables
    this._iri = /^<((?:[^ <>{}\\]|\\[uU])+)>[ \t]*/; // IRI with escape sequences; needs sanity check after unescaping

    this._unescapedIri = /^<([^\x00-\x20<>\\"\{\}\|\^\`]*)>[ \t]*/; // IRI without escape sequences; no unescaping

    this._simpleQuotedString = /^"([^"\\\r\n]*)"(?=[^"])/; // string without escape sequences

    this._simpleApostropheString = /^'([^'\\\r\n]*)'(?=[^'])/;
    this._langcode = /^@([a-z]+(?:-[a-z0-9]+)*)(?=[^a-z0-9\-])/i;
    this._prefix = /^((?:[A-Za-z\xc0-\xd6\xd8-\xf6\xf8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]|[\ud800-\udb7f][\udc00-\udfff])(?:\.?[\-0-9A-Z_a-z\xb7\xc0-\xd6\xd8-\xf6\xf8-\u037d\u037f-\u1fff\u200c\u200d\u203f\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]|[\ud800-\udb7f][\udc00-\udfff])*)?:(?=[#\s<])/;
    this._prefixed = /^((?:[A-Za-z\xc0-\xd6\xd8-\xf6\xf8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]|[\ud800-\udb7f][\udc00-\udfff])(?:\.?[\-0-9A-Z_a-z\xb7\xc0-\xd6\xd8-\xf6\xf8-\u037d\u037f-\u1fff\u200c\u200d\u203f\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]|[\ud800-\udb7f][\udc00-\udfff])*)?:((?:(?:[0-:A-Z_a-z\xc0-\xd6\xd8-\xf6\xf8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]|[\ud800-\udb7f][\udc00-\udfff]|%[0-9a-fA-F]{2}|\\[!#-\/;=?\-@_~])(?:(?:[\.\-0-:A-Z_a-z\xb7\xc0-\xd6\xd8-\xf6\xf8-\u037d\u037f-\u1fff\u200c\u200d\u203f\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]|[\ud800-\udb7f][\udc00-\udfff]|%[0-9a-fA-F]{2}|\\[!#-\/;=?\-@_~])*(?:[\-0-:A-Z_a-z\xb7\xc0-\xd6\xd8-\xf6\xf8-\u037d\u037f-\u1fff\u200c\u200d\u203f\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]|[\ud800-\udb7f][\udc00-\udfff]|%[0-9a-fA-F]{2}|\\[!#-\/;=?\-@_~]))?)?)(?:[ \t]+|(?=\.?[,;!\^\s#()\[\]\{\}"'<]))/;
    this._variable = /^\?(?:(?:[A-Z_a-z\xc0-\xd6\xd8-\xf6\xf8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]|[\ud800-\udb7f][\udc00-\udfff])(?:[\-0-:A-Z_a-z\xb7\xc0-\xd6\xd8-\xf6\xf8-\u037d\u037f-\u1fff\u200c\u200d\u203f\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]|[\ud800-\udb7f][\udc00-\udfff])*)(?=[.,;!\^\s#()\[\]\{\}"'<])/;
    this._blank = /^_:((?:[0-9A-Z_a-z\xc0-\xd6\xd8-\xf6\xf8-\u02ff\u0370-\u037d\u037f-\u1fff\u200c\u200d\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]|[\ud800-\udb7f][\udc00-\udfff])(?:\.?[\-0-9A-Z_a-z\xb7\xc0-\xd6\xd8-\xf6\xf8-\u037d\u037f-\u1fff\u200c\u200d\u203f\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]|[\ud800-\udb7f][\udc00-\udfff])*)(?:[ \t]+|(?=\.?[,;:\s#()\[\]\{\}"'<]))/;
    this._number = /^[\-+]?(?:\d+\.?\d*([eE](?:[\-\+])?\d+)|\d*\.?\d+)(?=\.?[,;:\s#()\[\]\{\}"'<])/;
    this._boolean = /^(?:true|false)(?=[.,;\s#()\[\]\{\}"'<])/;
    this._keyword = /^@[a-z]+(?=[\s#<:])/i;
    this._sparqlKeyword = /^(?:PREFIX|BASE|GRAPH)(?=[\s#<])/i;
    this._shortPredicates = /^a(?=[\s()\[\]\{\}"'<])/;
    this._newline = /^[ \t]*(?:#[^\n\r]*)?(?:\r\n|\n|\r)[ \t]*/;
    this._comment = /#([^\n\r]*)/;
    this._whitespace = /^[ \t]+/;
    this._endOfFile = /^(?:#[^\n\r]*)?$/;
    options = options || {}; // In line mode (N-Triples or N-Quads), only simple features may be parsed

    if (this._lineMode = !!options.lineMode) {
      this._n3Mode = false; // Don't tokenize special literals

      for (var key in this) {
        if (!(key in lineModeRegExps) && this[key] instanceof RegExp) this[key] = invalidRegExp;
      }
    } // When not in line mode, enable N3 functionality by default
    else {
        this._n3Mode = options.n3 !== false;
      } // Don't output comment tokens by default


    this._comments = !!options.comments; // Cache the last tested closing position of long literals

    this._literalClosingPos = 0;
  } // ## Private methods
  // ### `_tokenizeToEnd` tokenizes as for as possible, emitting tokens through the callback


  _tokenizeToEnd(callback, inputFinished) {
    // Continue parsing as far as possible; the loop will return eventually
    var input = this._input,
        outputComments = this._comments;

    while (true) {
      // Count and skip whitespace lines
      var whiteSpaceMatch, comment;

      while (whiteSpaceMatch = this._newline.exec(input)) {
        // Try to find a comment
        if (outputComments && (comment = this._comment.exec(whiteSpaceMatch[0]))) callback(null, {
          line: this._line,
          type: 'comment',
          value: comment[1],
          prefix: ''
        }); // Advance the input

        input = input.substr(whiteSpaceMatch[0].length, input.length);
        this._line++;
      } // Skip whitespace on current line


      if (!whiteSpaceMatch && (whiteSpaceMatch = this._whitespace.exec(input))) input = input.substr(whiteSpaceMatch[0].length, input.length); // Stop for now if we're at the end

      if (this._endOfFile.test(input)) {
        // If the input is finished, emit EOF
        if (inputFinished) {
          // Try to find a final comment
          if (outputComments && (comment = this._comment.exec(input))) callback(null, {
            line: this._line,
            type: 'comment',
            value: comment[1],
            prefix: ''
          });
          callback(input = null, {
            line: this._line,
            type: 'eof',
            value: '',
            prefix: ''
          });
        }

        return this._input = input;
      } // Look for specific token types based on the first character


      var line = this._line,
          type = '',
          value = '',
          prefix = '',
          firstChar = input[0],
          match = null,
          matchLength = 0,
          inconclusive = false;

      switch (firstChar) {
        case '^':
          // We need at least 3 tokens lookahead to distinguish ^^<IRI> and ^^pre:fixed
          if (input.length < 3) break; // Try to match a type
          else if (input[1] === '^') {
              this._previousMarker = '^^'; // Move to type IRI or prefixed name

              input = input.substr(2);

              if (input[0] !== '<') {
                inconclusive = true;
                break;
              }
            } // If no type, it must be a path expression
            else {
                if (this._n3Mode) {
                  matchLength = 1;
                  type = '^';
                }

                break;
              }
        // Fall through in case the type is an IRI

        case '<':
          // Try to find a full IRI without escape sequences
          if (match = this._unescapedIri.exec(input)) type = 'IRI', value = match[1]; // Try to find a full IRI with escape sequences
          else if (match = this._iri.exec(input)) {
              value = this._unescape(match[1]);
              if (value === null || illegalIriChars.test(value)) return reportSyntaxError(this);
              type = 'IRI';
            } // Try to find a backwards implication arrow
            else if (this._n3Mode && input.length > 1 && input[1] === '=') type = 'inverse', matchLength = 2, value = '>';
          break;

        case '_':
          // Try to find a blank node. Since it can contain (but not end with) a dot,
          // we always need a non-dot character before deciding it is a blank node.
          // Therefore, try inserting a space if we're at the end of the input.
          if ((match = this._blank.exec(input)) || inputFinished && (match = this._blank.exec(input + ' '))) type = 'blank', prefix = '_', value = match[1];
          break;

        case '"':
          // Try to find a literal without escape sequences
          if (match = this._simpleQuotedString.exec(input)) value = match[1]; // Try to find a literal wrapped in three pairs of quotes
          else {
              ({
                value,
                matchLength
              } = this._parseLiteral(input));
              if (value === null) return reportSyntaxError(this);
            }

          if (match !== null || matchLength !== 0) {
            type = 'literal';
            this._literalClosingPos = 0;
          }

          break;

        case "'":
          if (!this._lineMode) {
            // Try to find a literal without escape sequences
            if (match = this._simpleApostropheString.exec(input)) value = match[1]; // Try to find a literal wrapped in three pairs of quotes
            else {
                ({
                  value,
                  matchLength
                } = this._parseLiteral(input));
                if (value === null) return reportSyntaxError(this);
              }

            if (match !== null || matchLength !== 0) {
              type = 'literal';
              this._literalClosingPos = 0;
            }
          }

          break;

        case '?':
          // Try to find a variable
          if (this._n3Mode && (match = this._variable.exec(input))) type = 'var', value = match[0];
          break;

        case '@':
          // Try to find a language code
          if (this._previousMarker === 'literal' && (match = this._langcode.exec(input))) type = 'langcode', value = match[1]; // Try to find a keyword
          else if (match = this._keyword.exec(input)) type = match[0];
          break;

        case '.':
          // Try to find a dot as punctuation
          if (input.length === 1 ? inputFinished : input[1] < '0' || input[1] > '9') {
            type = '.';
            matchLength = 1;
            break;
          }

        // Fall through to numerical case (could be a decimal dot)

        case '0':
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
        case '+':
        case '-':
          // Try to find a number. Since it can contain (but not end with) a dot,
          // we always need a non-dot character before deciding it is a number.
          // Therefore, try inserting a space if we're at the end of the input.
          if (match = this._number.exec(input) || inputFinished && (match = this._number.exec(input + ' '))) {
            type = 'literal', value = match[0];
            prefix = match[1] ? xsd.double : /^[+\-]?\d+$/.test(match[0]) ? xsd.integer : xsd.decimal;
          }

          break;

        case 'B':
        case 'b':
        case 'p':
        case 'P':
        case 'G':
        case 'g':
          // Try to find a SPARQL-style keyword
          if (match = this._sparqlKeyword.exec(input)) type = match[0].toUpperCase();else inconclusive = true;
          break;

        case 'f':
        case 't':
          // Try to match a boolean
          if (match = this._boolean.exec(input)) type = 'literal', value = match[0], prefix = xsd.boolean;else inconclusive = true;
          break;

        case 'a':
          // Try to find an abbreviated predicate
          if (match = this._shortPredicates.exec(input)) type = 'abbreviation', value = 'a';else inconclusive = true;
          break;

        case '=':
          // Try to find an implication arrow or equals sign
          if (this._n3Mode && input.length > 1) {
            type = 'abbreviation';
            if (input[1] !== '>') matchLength = 1, value = '=';else matchLength = 2, value = '>';
          }

          break;

        case '!':
          if (!this._n3Mode) break;

        case ',':
        case ';':
        case '[':
        case ']':
        case '(':
        case ')':
        case '{':
        case '}':
          if (!this._lineMode) {
            matchLength = 1;
            type = firstChar;
          }

          break;

        default:
          inconclusive = true;
      } // Some first characters do not allow an immediate decision, so inspect more


      if (inconclusive) {
        // Try to find a prefix
        if ((this._previousMarker === '@prefix' || this._previousMarker === 'PREFIX') && (match = this._prefix.exec(input))) type = 'prefix', value = match[1] || ''; // Try to find a prefixed name. Since it can contain (but not end with) a dot,
        // we always need a non-dot character before deciding it is a prefixed name.
        // Therefore, try inserting a space if we're at the end of the input.
        else if ((match = this._prefixed.exec(input)) || inputFinished && (match = this._prefixed.exec(input + ' '))) type = 'prefixed', prefix = match[1] || '', value = this._unescape(match[2]);
      } // A type token is special: it can only be emitted after an IRI or prefixed name is read


      if (this._previousMarker === '^^') {
        switch (type) {
          case 'prefixed':
            type = 'type';
            break;

          case 'IRI':
            type = 'typeIRI';
            break;

          default:
            type = '';
        }
      } // What if nothing of the above was found?


      if (!type) {
        // We could be in streaming mode, and then we just wait for more input to arrive.
        // Otherwise, a syntax error has occurred in the input.
        // One exception: error on an unaccounted linebreak (= not inside a triple-quoted literal).
        if (inputFinished || !/^'''|^"""/.test(input) && /\n|\r/.test(input)) return reportSyntaxError(this);else return this._input = input;
      } // Emit the parsed token


      var token = {
        line: line,
        type: type,
        value: value,
        prefix: prefix
      };
      callback(null, token);
      this.previousToken = token;
      this._previousMarker = type; // Advance to next part to tokenize

      input = input.substr(matchLength || match[0].length, input.length);
    } // Signals the syntax error through the callback


    function reportSyntaxError(self) {
      callback(self._syntaxError(/^\S*/.exec(input)[0]));
    }
  } // ### `_unescape` replaces N3 escape codes by their corresponding characters


  _unescape(item) {
    try {
      return item.replace(escapeSequence, function (sequence, unicode4, unicode8, escapedChar) {
        var charCode;

        if (unicode4) {
          charCode = parseInt(unicode4, 16);
          if (isNaN(charCode)) throw new Error(); // can never happen (regex), but helps performance

          return fromCharCode(charCode);
        } else if (unicode8) {
          charCode = parseInt(unicode8, 16);
          if (isNaN(charCode)) throw new Error(); // can never happen (regex), but helps performance

          if (charCode <= 0xFFFF) return fromCharCode(charCode);
          return fromCharCode(0xD800 + (charCode -= 0x10000) / 0x400, 0xDC00 + (charCode & 0x3FF));
        } else {
          var replacement = escapeReplacements[escapedChar];
          if (!replacement) throw new Error();
          return replacement;
        }
      });
    } catch (error) {
      return null;
    }
  } // ### `_parseLiteral` parses a literal into an unescaped value


  _parseLiteral(input) {
    // Ensure we have enough lookahead to identify triple-quoted strings
    if (input.length >= 3) {
      // Identify the opening quote(s)
      const opening = input.match(/^(?:"""|"|'''|'|)/)[0];
      const openingLength = opening.length; // Find the next candidate closing quotes

      let closingPos = Math.max(this._literalClosingPos, openingLength);

      while ((closingPos = input.indexOf(opening, closingPos)) > 0) {
        // Count backslashes right before the closing quotes
        let backslashCount = 0;

        while (input[closingPos - backslashCount - 1] === '\\') backslashCount++; // An even number of backslashes (in particular 0)
        // means these are actual, non-escaped closing quotes


        if (backslashCount % 2 === 0) {
          // Extract and unescape the value
          const raw = input.substring(openingLength, closingPos);
          const lines = raw.split(/\r\n|\r|\n/).length - 1;
          const matchLength = closingPos + openingLength; // Only triple-quoted strings can be multi-line

          if (openingLength === 1 && lines !== 0 || openingLength === 3 && this._lineMode) break;
          this._line += lines;
          return {
            value: this._unescape(raw),
            matchLength
          };
        }

        closingPos++;
      }

      this._literalClosingPos = input.length - openingLength + 1;
    }

    return {
      value: '',
      matchLength: 0
    };
  } // ### `_syntaxError` creates a syntax error for the given issue


  _syntaxError(issue) {
    this._input = null;
    var err = new Error('Unexpected "' + issue + '" on line ' + this._line + '.');
    err.context = {
      token: undefined,
      line: this._line,
      previousToken: this.previousToken
    };
    return err;
  } // ## Public methods
  // ### `tokenize` starts the transformation of an N3 document into an array of tokens.
  // The input can be a string or a stream.


  tokenize(input, callback) {
    var self = this;
    this._line = 1; // If the input is a string, continuously emit tokens through the callback until the end

    if (typeof input === 'string') {
      this._input = input; // If a callback was passed, asynchronously call it

      if (typeof callback === 'function') setImmediate(function () {
        self._tokenizeToEnd(callback, true);
      }); // If no callback was passed, tokenize synchronously and return
      else {
          var tokens = [],
              error;

          this._tokenizeToEnd(function (e, t) {
            e ? error = e : tokens.push(t);
          }, true);

          if (error) throw error;
          return tokens;
        }
    } // Otherwise, the input must be a stream
    else {
        this._input = '';
        this._pendingBuffer = null;
        if (typeof input.setEncoding === 'function') input.setEncoding('utf8'); // Adds the data chunk to the buffer and parses as far as possible

        input.on('data', function (data) {
          if (self._input !== null && data.length !== 0) {
            // Prepend any previous pending writes
            if (self._pendingBuffer) {
              data = Buffer.concat([self._pendingBuffer, data]);
              self._pendingBuffer = null;
            } // Hold if the buffer ends in an incomplete unicode sequence


            if (data[data.length - 1] & 0x80) {
              self._pendingBuffer = data;
            } // Otherwise, tokenize as far as possible
            else {
                self._input += data;

                self._tokenizeToEnd(callback, false);
              }
          }
        }); // Parses until the end

        input.on('end', function () {
          if (self._input !== null) self._tokenizeToEnd(callback, true);
        });
        input.on('error', callback);
      }
  }

}

exports.default = N3Lexer;
}).call(this,require("buffer").Buffer,require("timers").setImmediate)
},{"./IRIs":52,"buffer":14,"timers":105}],55:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _N3Lexer = _interopRequireDefault(require("./N3Lexer"));

var _N3DataFactory = _interopRequireDefault(require("./N3DataFactory"));

var _IRIs = _interopRequireDefault(require("./IRIs"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// **N3Parser** parses N3 documents.
// The next ID for new blank nodes
var blankNodePrefix = 0,
    blankNodeCount = 0; // ## Constructor

class N3Parser {
  constructor(options) {
    this._contextStack = [];
    this._graph = null; // Set the document IRI

    options = options || {};

    this._setBase(options.baseIRI);

    options.factory && initDataFactory(this, options.factory); // Set supported features depending on the format

    var format = typeof options.format === 'string' ? options.format.match(/\w*$/)[0].toLowerCase() : '',
        isTurtle = format === 'turtle',
        isTriG = format === 'trig',
        isNTriples = /triple/.test(format),
        isNQuads = /quad/.test(format),
        isN3 = this._n3Mode = /n3/.test(format),
        isLineMode = isNTriples || isNQuads;
    if (!(this._supportsNamedGraphs = !(isTurtle || isN3))) this._readPredicateOrNamedGraph = this._readPredicate;
    this._supportsQuads = !(isTurtle || isTriG || isNTriples || isN3); // Disable relative IRIs in N-Triples or N-Quads mode

    if (isLineMode) this._resolveRelativeIRI = function (iri) {
      return null;
    };
    this._blankNodePrefix = typeof options.blankNodePrefix !== 'string' ? '' : options.blankNodePrefix.replace(/^(?!_:)/, '_:');
    this._lexer = options.lexer || new _N3Lexer.default({
      lineMode: isLineMode,
      n3: isN3
    }); // Disable explicit quantifiers by default

    this._explicitQuantifiers = !!options.explicitQuantifiers;
  } // ## Static class methods
  // ### `_resetBlankNodeIds` restarts blank node identification


  static _resetBlankNodeIds() {
    blankNodePrefix = blankNodeCount = 0;
  } // ## Private methods
  // ### `_blank` creates a new blank node


  _blank() {
    return this._blankNode('b' + blankNodeCount++);
  } // ### `_setBase` sets the base IRI to resolve relative IRIs


  _setBase(baseIRI) {
    if (!baseIRI) {
      this._base = '';
      this._basePath = '';
    } else {
      // Remove fragment if present
      var fragmentPos = baseIRI.indexOf('#');
      if (fragmentPos >= 0) baseIRI = baseIRI.substr(0, fragmentPos); // Set base IRI and its components

      this._base = baseIRI;
      this._basePath = baseIRI.indexOf('/') < 0 ? baseIRI : baseIRI.replace(/[^\/?]*(?:\?.*)?$/, '');
      baseIRI = baseIRI.match(/^(?:([a-z][a-z0-9+.-]*:))?(?:\/\/[^\/]*)?/i);
      this._baseRoot = baseIRI[0];
      this._baseScheme = baseIRI[1];
    }
  } // ### `_saveContext` stores the current parsing context
  // when entering a new scope (list, blank node, formula)


  _saveContext(type, graph, subject, predicate, object) {
    var n3Mode = this._n3Mode;

    this._contextStack.push({
      subject: subject,
      predicate: predicate,
      object: object,
      graph: graph,
      type: type,
      inverse: n3Mode ? this._inversePredicate : false,
      blankPrefix: n3Mode ? this._prefixes._ : '',
      quantified: n3Mode ? this._quantified : null
    }); // The settings below only apply to N3 streams


    if (n3Mode) {
      // Every new scope resets the predicate direction
      this._inversePredicate = false; // In N3, blank nodes are scoped to a formula
      // (using a dot as separator, as a blank node label cannot start with it)

      this._prefixes._ = this._graph ? this._graph.id.substr(2) + '.' : '.'; // Quantifiers are scoped to a formula

      this._quantified = Object.create(this._quantified);
    }
  } // ### `_restoreContext` restores the parent context
  // when leaving a scope (list, blank node, formula)


  _restoreContext() {
    var context = this._contextStack.pop(),
        n3Mode = this._n3Mode;

    this._subject = context.subject;
    this._predicate = context.predicate;
    this._object = context.object;
    this._graph = context.graph; // The settings below only apply to N3 streams

    if (n3Mode) {
      this._inversePredicate = context.inverse;
      this._prefixes._ = context.blankPrefix;
      this._quantified = context.quantified;
    }
  } // ### `_readInTopContext` reads a token when in the top context


  _readInTopContext(token) {
    switch (token.type) {
      // If an EOF token arrives in the top context, signal that we're done
      case 'eof':
        if (this._graph !== null) return this._error('Unclosed graph', token);
        delete this._prefixes._;
        return this._callback(null, null, this._prefixes);
      // It could be a prefix declaration

      case 'PREFIX':
        this._sparqlStyle = true;

      case '@prefix':
        return this._readPrefix;
      // It could be a base declaration

      case 'BASE':
        this._sparqlStyle = true;

      case '@base':
        return this._readBaseIRI;
      // It could be a graph

      case '{':
        if (this._supportsNamedGraphs) {
          this._graph = '';
          this._subject = null;
          return this._readSubject;
        }

      case 'GRAPH':
        if (this._supportsNamedGraphs) return this._readNamedGraphLabel;
      // Otherwise, the next token must be a subject

      default:
        return this._readSubject(token);
    }
  } // ### `_readEntity` reads an IRI, prefixed name, blank node, or variable


  _readEntity(token, quantifier) {
    var value;

    switch (token.type) {
      // Read a relative or absolute IRI
      case 'IRI':
      case 'typeIRI':
        var iri = this._resolveIRI(token.value);

        if (iri === null) return this._error('Invalid IRI', token);
        value = this._namedNode(iri);
        break;
      // Read a prefixed name

      case 'type':
      case 'prefixed':
        var prefix = this._prefixes[token.prefix];
        if (prefix === undefined) return this._error('Undefined prefix "' + token.prefix + ':"', token);
        value = this._namedNode(prefix + token.value);
        break;
      // Read a blank node

      case 'blank':
        value = this._blankNode(this._prefixes[token.prefix] + token.value);
        break;
      // Read a variable

      case 'var':
        value = this._variable(token.value.substr(1));
        break;
      // Everything else is not an entity

      default:
        return this._error('Expected entity but got ' + token.type, token);
    } // In N3 mode, replace the entity if it is quantified


    if (!quantifier && this._n3Mode && value.id in this._quantified) value = this._quantified[value.id];
    return value;
  } // ### `_readSubject` reads a quad's subject


  _readSubject(token) {
    this._predicate = null;

    switch (token.type) {
      case '[':
        // Start a new quad with a new blank node as subject
        this._saveContext('blank', this._graph, this._subject = this._blank(), null, null);

        return this._readBlankNodeHead;

      case '(':
        // Start a new list
        this._saveContext('list', this._graph, this.RDF_NIL, null, null);

        this._subject = null;
        return this._readListItem;

      case '{':
        // Start a new formula
        if (!this._n3Mode) return this._error('Unexpected graph', token);

        this._saveContext('formula', this._graph, this._graph = this._blank(), null, null);

        return this._readSubject;

      case '}':
        // No subject; the graph in which we are reading is closed instead
        return this._readPunctuation(token);

      case '@forSome':
        if (!this._n3Mode) return this._error('Unexpected "@forSome"', token);
        this._subject = null;
        this._predicate = this.N3_FORSOME;
        this._quantifier = this._blankNode;
        return this._readQuantifierList;

      case '@forAll':
        if (!this._n3Mode) return this._error('Unexpected "@forAll"', token);
        this._subject = null;
        this._predicate = this.N3_FORALL;
        this._quantifier = this._variable;
        return this._readQuantifierList;

      default:
        // Read the subject entity
        if ((this._subject = this._readEntity(token)) === undefined) return; // In N3 mode, the subject might be a path

        if (this._n3Mode) return this._getPathReader(this._readPredicateOrNamedGraph);
    } // The next token must be a predicate,
    // or, if the subject was actually a graph IRI, a named graph


    return this._readPredicateOrNamedGraph;
  } // ### `_readPredicate` reads a quad's predicate


  _readPredicate(token) {
    var type = token.type;

    switch (type) {
      case 'inverse':
        this._inversePredicate = true;

      case 'abbreviation':
        this._predicate = this.ABBREVIATIONS[token.value];
        break;

      case '.':
      case ']':
      case '}':
        // Expected predicate didn't come, must have been trailing semicolon
        if (this._predicate === null) return this._error('Unexpected ' + type, token);
        this._subject = null;
        return type === ']' ? this._readBlankNodeTail(token) : this._readPunctuation(token);

      case ';':
        // Additional semicolons can be safely ignored
        return this._predicate !== null ? this._readPredicate : this._error('Expected predicate but got ;', token);

      case 'blank':
        if (!this._n3Mode) return this._error('Disallowed blank node as predicate', token);

      default:
        if ((this._predicate = this._readEntity(token)) === undefined) return;
    } // The next token must be an object


    return this._readObject;
  } // ### `_readObject` reads a quad's object


  _readObject(token) {
    switch (token.type) {
      case 'literal':
        // Regular literal, can still get a datatype or language
        if (token.prefix.length === 0) {
          this._literalValue = token.value;
          return this._readDataTypeOrLang;
        } // Pre-datatyped string literal (prefix stores the datatype)
        else this._object = this._literal(token.value, this._namedNode(token.prefix));

        break;

      case '[':
        // Start a new quad with a new blank node as subject
        this._saveContext('blank', this._graph, this._subject, this._predicate, this._subject = this._blank());

        return this._readBlankNodeHead;

      case '(':
        // Start a new list
        this._saveContext('list', this._graph, this._subject, this._predicate, this.RDF_NIL);

        this._subject = null;
        return this._readListItem;

      case '{':
        // Start a new formula
        if (!this._n3Mode) return this._error('Unexpected graph', token);

        this._saveContext('formula', this._graph, this._subject, this._predicate, this._graph = this._blank());

        return this._readSubject;

      default:
        // Read the object entity
        if ((this._object = this._readEntity(token)) === undefined) return; // In N3 mode, the object might be a path

        if (this._n3Mode) return this._getPathReader(this._getContextEndReader());
    }

    return this._getContextEndReader();
  } // ### `_readPredicateOrNamedGraph` reads a quad's predicate, or a named graph


  _readPredicateOrNamedGraph(token) {
    return token.type === '{' ? this._readGraph(token) : this._readPredicate(token);
  } // ### `_readGraph` reads a graph


  _readGraph(token) {
    if (token.type !== '{') return this._error('Expected graph but got ' + token.type, token); // The "subject" we read is actually the GRAPH's label

    this._graph = this._subject, this._subject = null;
    return this._readSubject;
  } // ### `_readBlankNodeHead` reads the head of a blank node


  _readBlankNodeHead(token) {
    if (token.type === ']') {
      this._subject = null;
      return this._readBlankNodeTail(token);
    } else {
      this._predicate = null;
      return this._readPredicate(token);
    }
  } // ### `_readBlankNodeTail` reads the end of a blank node


  _readBlankNodeTail(token) {
    if (token.type !== ']') return this._readBlankNodePunctuation(token); // Store blank node quad

    if (this._subject !== null) this._emit(this._subject, this._predicate, this._object, this._graph); // Restore the parent context containing this blank node

    var empty = this._predicate === null;

    this._restoreContext(); // If the blank node was the subject, continue reading the predicate


    if (this._object === null) // If the blank node was empty, it could be a named graph label
      return empty ? this._readPredicateOrNamedGraph : this._readPredicateAfterBlank; // If the blank node was the object, restore previous context and read punctuation
    else return this._getContextEndReader();
  } // ### `_readPredicateAfterBlank` reads a predicate after an anonymous blank node


  _readPredicateAfterBlank(token) {
    switch (token.type) {
      case '.':
      case '}':
        // No predicate is coming if the triple is terminated here
        this._subject = null;
        return this._readPunctuation(token);

      default:
        return this._readPredicate(token);
    }
  } // ### `_readListItem` reads items from a list


  _readListItem(token) {
    var item = null,
        // The item of the list
    list = null,
        // The list itself
    previousList = this._subject,
        // The previous list that contains this list
    stack = this._contextStack,
        // The stack of parent contexts
    parent = stack[stack.length - 1],
        // The parent containing the current list
    next = this._readListItem; // The next function to execute

    switch (token.type) {
      case '[':
        // Stack the current list quad and start a new quad with a blank node as subject
        this._saveContext('blank', this._graph, list = this._blank(), this.RDF_FIRST, this._subject = item = this._blank());

        next = this._readBlankNodeHead;
        break;

      case '(':
        // Stack the current list quad and start a new list
        this._saveContext('list', this._graph, list = this._blank(), this.RDF_FIRST, this.RDF_NIL);

        this._subject = null;
        break;

      case ')':
        // Closing the list; restore the parent context
        this._restoreContext(); // If this list is contained within a parent list, return the membership quad here.
        // This will be `<parent list element> rdf:first <this list>.`.


        if (stack.length !== 0 && stack[stack.length - 1].type === 'list') this._emit(this._subject, this._predicate, this._object, this._graph); // Was this list the parent's subject?

        if (this._predicate === null) {
          // The next token is the predicate
          next = this._readPredicate; // No list tail if this was an empty list

          if (this._subject === this.RDF_NIL) return next;
        } // The list was in the parent context's object
        else {
            next = this._getContextEndReader(); // No list tail if this was an empty list

            if (this._object === this.RDF_NIL) return next;
          } // Close the list by making the head nil


        list = this.RDF_NIL;
        break;

      case 'literal':
        // Regular literal, can still get a datatype or language
        if (token.prefix.length === 0) {
          this._literalValue = token.value;
          next = this._readListItemDataTypeOrLang;
        } // Pre-datatyped string literal (prefix stores the datatype)
        else {
            item = this._literal(token.value, this._namedNode(token.prefix));
            next = this._getContextEndReader();
          }

        break;

      default:
        if ((item = this._readEntity(token)) === undefined) return;
    } // Create a new blank node if no item head was assigned yet


    if (list === null) this._subject = list = this._blank(); // Is this the first element of the list?

    if (previousList === null) {
      // This list is either the subject or the object of its parent
      if (parent.predicate === null) parent.subject = list;else parent.object = list;
    } else {
      // Continue the previous list with the current list
      this._emit(previousList, this.RDF_REST, list, this._graph);
    } // If an item was read, add it to the list


    if (item !== null) {
      // In N3 mode, the item might be a path
      if (this._n3Mode && (token.type === 'IRI' || token.type === 'prefixed')) {
        // Create a new context to add the item's path
        this._saveContext('item', this._graph, list, this.RDF_FIRST, item);

        this._subject = item, this._predicate = null; // _readPath will restore the context and output the item

        return this._getPathReader(this._readListItem);
      } // Output the item


      this._emit(list, this.RDF_FIRST, item, this._graph);
    }

    return next;
  } // ### `_readDataTypeOrLang` reads an _optional_ datatype or language


  _readDataTypeOrLang(token) {
    return this._completeLiteral(token, false);
  } // ### `_readListItemDataTypeOrLang` reads an _optional_ datatype or language in a list


  _readListItemDataTypeOrLang(token) {
    return this._completeLiteral(token, true);
  } // ### `_completeLiteral` completes a literal with an optional datatype or language


  _completeLiteral(token, listItem) {
    switch (token.type) {
      // Create a datatyped literal
      case 'type':
      case 'typeIRI':
        var datatype = this._readEntity(token);

        if (datatype === undefined) return; // No datatype means an error occurred

        this._object = this._literal(this._literalValue, datatype);
        token = null;
        break;
      // Create a language-tagged string

      case 'langcode':
        this._object = this._literal(this._literalValue, token.value);
        token = null;
        break;
      // Create a simple string literal

      default:
        this._object = this._literal(this._literalValue);
    } // If this literal was part of a list, write the item
    // (we could also check the context stack, but passing in a flag is faster)


    if (listItem) this._emit(this._subject, this.RDF_FIRST, this._object, this._graph); // If the token was consumed, continue with the rest of the input

    if (token === null) return this._getContextEndReader(); // Otherwise, consume the token now
    else {
        this._readCallback = this._getContextEndReader();
        return this._readCallback(token);
      }
  } // ### `_readFormulaTail` reads the end of a formula


  _readFormulaTail(token) {
    if (token.type !== '}') return this._readPunctuation(token); // Store the last quad of the formula

    if (this._subject !== null) this._emit(this._subject, this._predicate, this._object, this._graph); // Restore the parent context containing this formula

    this._restoreContext(); // If the formula was the subject, continue reading the predicate.
    // If the formula was the object, read punctuation.


    return this._object === null ? this._readPredicate : this._getContextEndReader();
  } // ### `_readPunctuation` reads punctuation between quads or quad parts


  _readPunctuation(token) {
    var next,
        subject = this._subject,
        graph = this._graph,
        inversePredicate = this._inversePredicate;

    switch (token.type) {
      // A closing brace ends a graph
      case '}':
        if (this._graph === null) return this._error('Unexpected graph closing', token);
        if (this._n3Mode) return this._readFormulaTail(token);
        this._graph = null;
      // A dot just ends the statement, without sharing anything with the next

      case '.':
        this._subject = null;
        next = this._contextStack.length ? this._readSubject : this._readInTopContext;
        if (inversePredicate) this._inversePredicate = false;
        break;
      // Semicolon means the subject is shared; predicate and object are different

      case ';':
        next = this._readPredicate;
        break;
      // Comma means both the subject and predicate are shared; the object is different

      case ',':
        next = this._readObject;
        break;

      default:
        // An entity means this is a quad (only allowed if not already inside a graph)
        if (this._supportsQuads && this._graph === null && (graph = this._readEntity(token)) !== undefined) {
          next = this._readQuadPunctuation;
          break;
        }

        return this._error('Expected punctuation to follow "' + this._object.id + '"', token);
    } // A quad has been completed now, so return it


    if (subject !== null) {
      var predicate = this._predicate,
          object = this._object;
      if (!inversePredicate) this._emit(subject, predicate, object, graph);else this._emit(object, predicate, subject, graph);
    }

    return next;
  } // ### `_readBlankNodePunctuation` reads punctuation in a blank node


  _readBlankNodePunctuation(token) {
    var next;

    switch (token.type) {
      // Semicolon means the subject is shared; predicate and object are different
      case ';':
        next = this._readPredicate;
        break;
      // Comma means both the subject and predicate are shared; the object is different

      case ',':
        next = this._readObject;
        break;

      default:
        return this._error('Expected punctuation to follow "' + this._object.id + '"', token);
    } // A quad has been completed now, so return it


    this._emit(this._subject, this._predicate, this._object, this._graph);

    return next;
  } // ### `_readQuadPunctuation` reads punctuation after a quad


  _readQuadPunctuation(token) {
    if (token.type !== '.') return this._error('Expected dot to follow quad', token);
    return this._readInTopContext;
  } // ### `_readPrefix` reads the prefix of a prefix declaration


  _readPrefix(token) {
    if (token.type !== 'prefix') return this._error('Expected prefix to follow @prefix', token);
    this._prefix = token.value;
    return this._readPrefixIRI;
  } // ### `_readPrefixIRI` reads the IRI of a prefix declaration


  _readPrefixIRI(token) {
    if (token.type !== 'IRI') return this._error('Expected IRI to follow prefix "' + this._prefix + ':"', token);

    var prefixNode = this._readEntity(token);

    this._prefixes[this._prefix] = prefixNode.value;

    this._prefixCallback(this._prefix, prefixNode);

    return this._readDeclarationPunctuation;
  } // ### `_readBaseIRI` reads the IRI of a base declaration


  _readBaseIRI(token) {
    var iri = token.type === 'IRI' && this._resolveIRI(token.value);

    if (!iri) return this._error('Expected valid IRI to follow base declaration', token);

    this._setBase(iri);

    return this._readDeclarationPunctuation;
  } // ### `_readNamedGraphLabel` reads the label of a named graph


  _readNamedGraphLabel(token) {
    switch (token.type) {
      case 'IRI':
      case 'blank':
      case 'prefixed':
        return this._readSubject(token), this._readGraph;

      case '[':
        return this._readNamedGraphBlankLabel;

      default:
        return this._error('Invalid graph label', token);
    }
  } // ### `_readNamedGraphLabel` reads a blank node label of a named graph


  _readNamedGraphBlankLabel(token) {
    if (token.type !== ']') return this._error('Invalid graph label', token);
    this._subject = this._blank();
    return this._readGraph;
  } // ### `_readDeclarationPunctuation` reads the punctuation of a declaration


  _readDeclarationPunctuation(token) {
    // SPARQL-style declarations don't have punctuation
    if (this._sparqlStyle) {
      this._sparqlStyle = false;
      return this._readInTopContext(token);
    }

    if (token.type !== '.') return this._error('Expected declaration to end with a dot', token);
    return this._readInTopContext;
  } // Reads a list of quantified symbols from a @forSome or @forAll statement


  _readQuantifierList(token) {
    var entity;

    switch (token.type) {
      case 'IRI':
      case 'prefixed':
        if ((entity = this._readEntity(token, true)) !== undefined) break;

      default:
        return this._error('Unexpected ' + token.type, token);
    } // Without explicit quantifiers, map entities to a quantified entity


    if (!this._explicitQuantifiers) this._quantified[entity.id] = this._quantifier('b' + blankNodeCount++); // With explicit quantifiers, output the reified quantifier
    else {
        // If this is the first item, start a new quantifier list
        if (this._subject === null) this._emit(this._graph || this.DEFAULTGRAPH, this._predicate, this._subject = this._blank(), this.QUANTIFIERS_GRAPH); // Otherwise, continue the previous list
        else this._emit(this._subject, this.RDF_REST, this._subject = this._blank(), this.QUANTIFIERS_GRAPH); // Output the list item

        this._emit(this._subject, this.RDF_FIRST, entity, this.QUANTIFIERS_GRAPH);
      }
    return this._readQuantifierPunctuation;
  } // Reads punctuation from a @forSome or @forAll statement


  _readQuantifierPunctuation(token) {
    // Read more quantifiers
    if (token.type === ',') return this._readQuantifierList; // End of the quantifier list
    else {
        // With explicit quantifiers, close the quantifier list
        if (this._explicitQuantifiers) {
          this._emit(this._subject, this.RDF_REST, this.RDF_NIL, this.QUANTIFIERS_GRAPH);

          this._subject = null;
        } // Read a dot


        this._readCallback = this._getContextEndReader();
        return this._readCallback(token);
      }
  } // ### `_getPathReader` reads a potential path and then resumes with the given function


  _getPathReader(afterPath) {
    this._afterPath = afterPath;
    return this._readPath;
  } // ### `_readPath` reads a potential path


  _readPath(token) {
    switch (token.type) {
      // Forward path
      case '!':
        return this._readForwardPath;
      // Backward path

      case '^':
        return this._readBackwardPath;
      // Not a path; resume reading where we left off

      default:
        var stack = this._contextStack,
            parent = stack.length && stack[stack.length - 1]; // If we were reading a list item, we still need to output it

        if (parent && parent.type === 'item') {
          // The list item is the remaining subejct after reading the path
          var item = this._subject; // Switch back to the context of the list

          this._restoreContext(); // Output the list item


          this._emit(this._subject, this.RDF_FIRST, item, this._graph);
        }

        return this._afterPath(token);
    }
  } // ### `_readForwardPath` reads a '!' path


  _readForwardPath(token) {
    var subject,
        predicate,
        object = this._blank(); // The next token is the predicate


    if ((predicate = this._readEntity(token)) === undefined) return; // If we were reading a subject, replace the subject by the path's object

    if (this._predicate === null) subject = this._subject, this._subject = object; // If we were reading an object, replace the subject by the path's object
    else subject = this._object, this._object = object; // Emit the path's current quad and read its next section

    this._emit(subject, predicate, object, this._graph);

    return this._readPath;
  } // ### `_readBackwardPath` reads a '^' path


  _readBackwardPath(token) {
    var subject = this._blank(),
        predicate,
        object; // The next token is the predicate


    if ((predicate = this._readEntity(token)) === undefined) return; // If we were reading a subject, replace the subject by the path's subject

    if (this._predicate === null) object = this._subject, this._subject = subject; // If we were reading an object, replace the subject by the path's subject
    else object = this._object, this._object = subject; // Emit the path's current quad and read its next section

    this._emit(subject, predicate, object, this._graph);

    return this._readPath;
  } // ### `_getContextEndReader` gets the next reader function at the end of a context


  _getContextEndReader() {
    var contextStack = this._contextStack;
    if (!contextStack.length) return this._readPunctuation;

    switch (contextStack[contextStack.length - 1].type) {
      case 'blank':
        return this._readBlankNodeTail;

      case 'list':
        return this._readListItem;

      case 'formula':
        return this._readFormulaTail;
    }
  } // ### `_emit` sends a quad through the callback


  _emit(subject, predicate, object, graph) {
    this._callback(null, this._quad(subject, predicate, object, graph || this.DEFAULTGRAPH));
  } // ### `_error` emits an error message through the callback


  _error(message, token) {
    var err = new Error(message + ' on line ' + token.line + '.');
    err.context = {
      token: token,
      line: token.line,
      previousToken: this._lexer.previousToken
    };

    this._callback(err);

    this._callback = noop;
  } // ### `_resolveIRI` resolves an IRI against the base path


  _resolveIRI(iri) {
    return /^[a-z][a-z0-9+.-]*:/i.test(iri) ? iri : this._resolveRelativeIRI(iri);
  } // ### `_resolveRelativeIRI` resolves an IRI against the base path,
  // assuming that a base path has been set and that the IRI is indeed relative


  _resolveRelativeIRI(iri) {
    // An empty relative IRI indicates the base IRI
    if (!iri.length) return this._base; // Decide resolving strategy based in the first character

    switch (iri[0]) {
      // Resolve relative fragment IRIs against the base IRI
      case '#':
        return this._base + iri;
      // Resolve relative query string IRIs by replacing the query string

      case '?':
        return this._base.replace(/(?:\?.*)?$/, iri);
      // Resolve root-relative IRIs at the root of the base IRI

      case '/':
        // Resolve scheme-relative IRIs to the scheme
        return (iri[1] === '/' ? this._baseScheme : this._baseRoot) + this._removeDotSegments(iri);
      // Resolve all other IRIs at the base IRI's path

      default:
        // Relative IRIs cannot contain a colon in the first path segment
        return /^[^/:]*:/.test(iri) ? null : this._removeDotSegments(this._basePath + iri);
    }
  } // ### `_removeDotSegments` resolves './' and '../' path segments in an IRI as per RFC3986


  _removeDotSegments(iri) {
    // Don't modify the IRI if it does not contain any dot segments
    if (!/(^|\/)\.\.?($|[/#?])/.test(iri)) return iri; // Start with an imaginary slash before the IRI in order to resolve trailing './' and '../'

    var result = '',
        length = iri.length,
        i = -1,
        pathStart = -1,
        segmentStart = 0,
        next = '/';

    while (i < length) {
      switch (next) {
        // The path starts with the first slash after the authority
        case ':':
          if (pathStart < 0) {
            // Skip two slashes before the authority
            if (iri[++i] === '/' && iri[++i] === '/') // Skip to slash after the authority
              while ((pathStart = i + 1) < length && iri[pathStart] !== '/') i = pathStart;
          }

          break;
        // Don't modify a query string or fragment

        case '?':
        case '#':
          i = length;
          break;
        // Handle '/.' or '/..' path segments

        case '/':
          if (iri[i + 1] === '.') {
            next = iri[++i + 1];

            switch (next) {
              // Remove a '/.' segment
              case '/':
                result += iri.substring(segmentStart, i - 1);
                segmentStart = i + 1;
                break;
              // Remove a trailing '/.' segment

              case undefined:
              case '?':
              case '#':
                return result + iri.substring(segmentStart, i) + iri.substr(i + 1);
              // Remove a '/..' segment

              case '.':
                next = iri[++i + 1];

                if (next === undefined || next === '/' || next === '?' || next === '#') {
                  result += iri.substring(segmentStart, i - 2); // Try to remove the parent path from result

                  if ((segmentStart = result.lastIndexOf('/')) >= pathStart) result = result.substr(0, segmentStart); // Remove a trailing '/..' segment

                  if (next !== '/') return result + '/' + iri.substr(i + 1);
                  segmentStart = i + 1;
                }

            }
          }

      }

      next = iri[++i];
    }

    return result + iri.substring(segmentStart);
  } // ## Public methods
  // ### `parse` parses the N3 input and emits each parsed quad through the callback


  parse(input, quadCallback, prefixCallback) {
    var self = this; // The read callback is the next function to be executed when a token arrives.
    // We start reading in the top context.

    this._readCallback = this._readInTopContext;
    this._sparqlStyle = false;
    this._prefixes = Object.create(null);
    this._prefixes._ = this._blankNodePrefix ? this._blankNodePrefix.substr(2) : 'b' + blankNodePrefix++ + '_';
    this._prefixCallback = prefixCallback || noop;
    this._inversePredicate = false;
    this._quantified = Object.create(null); // Parse synchronously if no quad callback is given

    if (!quadCallback) {
      var quads = [],
          error;

      this._callback = function (e, t) {
        e ? error = e : t && quads.push(t);
      };

      this._lexer.tokenize(input).every(function (token) {
        return self._readCallback = self._readCallback(token);
      });

      if (error) throw error;
      return quads;
    } // Parse asynchronously otherwise, executing the read callback when a token arrives


    this._callback = quadCallback;

    this._lexer.tokenize(input, function (error, token) {
      if (error !== null) self._callback(error), self._callback = noop;else if (self._readCallback) self._readCallback = self._readCallback(token);
    });
  }

} // The empty function


exports.default = N3Parser;

function noop() {} // Initializes the parser with the given data factory


function initDataFactory(parser, factory) {
  // Set factory methods
  var namedNode = factory.namedNode;
  parser._namedNode = namedNode;
  parser._blankNode = factory.blankNode;
  parser._literal = factory.literal;
  parser._variable = factory.variable;
  parser._quad = factory.quad;
  parser.DEFAULTGRAPH = factory.defaultGraph(); // Set common named nodes

  parser.RDF_FIRST = namedNode(_IRIs.default.rdf.first);
  parser.RDF_REST = namedNode(_IRIs.default.rdf.rest);
  parser.RDF_NIL = namedNode(_IRIs.default.rdf.nil);
  parser.N3_FORALL = namedNode(_IRIs.default.r.forAll);
  parser.N3_FORSOME = namedNode(_IRIs.default.r.forSome);
  parser.ABBREVIATIONS = {
    'a': namedNode(_IRIs.default.rdf.type),
    '=': namedNode(_IRIs.default.owl.sameAs),
    '>': namedNode(_IRIs.default.log.implies)
  };
  parser.QUANTIFIERS_GRAPH = namedNode('urn:n3:quantifiers');
}

initDataFactory(N3Parser.prototype, _N3DataFactory.default);
},{"./IRIs":52,"./N3DataFactory":53,"./N3Lexer":54}],56:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _N3DataFactory = _interopRequireDefault(require("./N3DataFactory"));

var _stream = require("stream");

var _IRIs = _interopRequireDefault(require("./IRIs"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// **N3Store** objects store N3 quads by graph in memory.
const {
  toId,
  fromId
} = _N3DataFactory.default.internal; // ## Constructor

class N3Store {
  constructor(quads, options) {
    // The number of quads is initially zero
    this._size = 0; // `_graphs` contains subject, predicate, and object indexes per graph

    this._graphs = Object.create(null); // `_ids` maps entities such as `http://xmlns.com/foaf/0.1/name` to numbers,
    // saving memory by using only numbers as keys in `_graphs`

    this._id = 0;
    this._ids = Object.create(null);
    this._ids['><'] = 0; // dummy entry, so the first actual key is non-zero

    this._entities = Object.create(null); // inverse of `_ids`
    // `_blankNodeIndex` is the index of the last automatically named blank node

    this._blankNodeIndex = 0; // Shift parameters if `quads` is not given

    if (!options && quads && !quads[0]) options = quads, quads = null;
    options = options || {};
    this._factory = options.factory || _N3DataFactory.default; // Add quads if passed

    if (quads) this.addQuads(quads);
  } // ## Public properties
  // ### `size` returns the number of quads in the store


  get size() {
    // Return the quad count if if was cached
    var size = this._size;
    if (size !== null) return size; // Calculate the number of quads by counting to the deepest level

    size = 0;
    var graphs = this._graphs,
        subjects,
        subject;

    for (var graphKey in graphs) for (var subjectKey in subjects = graphs[graphKey].subjects) for (var predicateKey in subject = subjects[subjectKey]) size += Object.keys(subject[predicateKey]).length;

    return this._size = size;
  } // ## Private methods
  // ### `_addToIndex` adds a quad to a three-layered index.
  // Returns if the index has changed, if the entry did not already exist.


  _addToIndex(index0, key0, key1, key2) {
    // Create layers as necessary
    var index1 = index0[key0] || (index0[key0] = {});
    var index2 = index1[key1] || (index1[key1] = {}); // Setting the key to _any_ value signals the presence of the quad

    var existed = key2 in index2;
    if (!existed) index2[key2] = null;
    return !existed;
  } // ### `_removeFromIndex` removes a quad from a three-layered index


  _removeFromIndex(index0, key0, key1, key2) {
    // Remove the quad from the index
    var index1 = index0[key0],
        index2 = index1[key1],
        key;
    delete index2[key2]; // Remove intermediary index layers if they are empty

    for (key in index2) return;

    delete index1[key1];

    for (key in index1) return;

    delete index0[key0];
  } // ### `_findInIndex` finds a set of quads in a three-layered index.
  // The index base is `index0` and the keys at each level are `key0`, `key1`, and `key2`.
  // Any of these keys can be undefined, which is interpreted as a wildcard.
  // `name0`, `name1`, and `name2` are the names of the keys at each level,
  // used when reconstructing the resulting quad
  // (for instance: _subject_, _predicate_, and _object_).
  // Finally, `graph` will be the graph of the created quads.
  // If `callback` is given, each result is passed through it
  // and iteration halts when it returns truthy for any quad.
  // If instead `array` is given, each result is added to the array.


  _findInIndex(index0, key0, key1, key2, name0, name1, name2, graph, callback, array) {
    var tmp,
        index1,
        index2,
        varCount = !key0 + !key1 + !key2,
        // depending on the number of variables, keys or reverse index are faster
    entityKeys = varCount > 1 ? Object.keys(this._ids) : this._entities; // If a key is specified, use only that part of index 0.

    if (key0) (tmp = index0, index0 = {})[key0] = tmp[key0];

    for (var value0 in index0) {
      var entity0 = entityKeys[value0];

      if (index1 = index0[value0]) {
        // If a key is specified, use only that part of index 1.
        if (key1) (tmp = index1, index1 = {})[key1] = tmp[key1];

        for (var value1 in index1) {
          var entity1 = entityKeys[value1];

          if (index2 = index1[value1]) {
            // If a key is specified, use only that part of index 2, if it exists.
            var values = key2 ? key2 in index2 ? [key2] : [] : Object.keys(index2); // Create quads for all items found in index 2.

            for (var l = 0; l < values.length; l++) {
              var parts = {
                subject: null,
                predicate: null,
                object: null
              };
              parts[name0] = fromId(entity0, this._factory);
              parts[name1] = fromId(entity1, this._factory);
              parts[name2] = fromId(entityKeys[values[l]], this._factory);

              var quad = this._factory.quad(parts.subject, parts.predicate, parts.object, fromId(graph, this._factory));

              if (array) array.push(quad);else if (callback(quad)) return true;
            }
          }
        }
      }
    }

    return array;
  } // ### `_loop` executes the callback on all keys of index 0


  _loop(index0, callback) {
    for (var key0 in index0) callback(key0);
  } // ### `_loopByKey0` executes the callback on all keys of a certain entry in index 0


  _loopByKey0(index0, key0, callback) {
    var index1, key1;

    if (index1 = index0[key0]) {
      for (key1 in index1) callback(key1);
    }
  } // ### `_loopByKey1` executes the callback on given keys of all entries in index 0


  _loopByKey1(index0, key1, callback) {
    var key0, index1;

    for (key0 in index0) {
      index1 = index0[key0];
      if (index1[key1]) callback(key0);
    }
  } // ### `_loopBy2Keys` executes the callback on given keys of certain entries in index 2


  _loopBy2Keys(index0, key0, key1, callback) {
    var index1, index2, key2;

    if ((index1 = index0[key0]) && (index2 = index1[key1])) {
      for (key2 in index2) callback(key2);
    }
  } // ### `_countInIndex` counts matching quads in a three-layered index.
  // The index base is `index0` and the keys at each level are `key0`, `key1`, and `key2`.
  // Any of these keys can be undefined, which is interpreted as a wildcard.


  _countInIndex(index0, key0, key1, key2) {
    var count = 0,
        tmp,
        index1,
        index2; // If a key is specified, count only that part of index 0

    if (key0) (tmp = index0, index0 = {})[key0] = tmp[key0];

    for (var value0 in index0) {
      if (index1 = index0[value0]) {
        // If a key is specified, count only that part of index 1
        if (key1) (tmp = index1, index1 = {})[key1] = tmp[key1];

        for (var value1 in index1) {
          if (index2 = index1[value1]) {
            // If a key is specified, count the quad if it exists
            if (key2) key2 in index2 && count++; // Otherwise, count all quads
            else count += Object.keys(index2).length;
          }
        }
      }
    }

    return count;
  } // ### `_getGraphs` returns an array with the given graph,
  // or all graphs if the argument is null or undefined.


  _getGraphs(graph) {
    if (!isString(graph)) return this._graphs;
    var graphs = {};
    graphs[graph] = this._graphs[graph];
    return graphs;
  } // ### `_uniqueEntities` returns a function that accepts an entity ID
  // and passes the corresponding entity to callback if it hasn't occurred before.


  _uniqueEntities(callback) {
    var uniqueIds = Object.create(null),
        entities = this._entities;
    return function (id) {
      if (!(id in uniqueIds)) {
        uniqueIds[id] = true;
        callback(fromId(entities[id]));
      }
    };
  } // ## Public methods
  // ### `addQuad` adds a new quad to the store.
  // Returns if the quad index has changed, if the quad did not already exist.


  addQuad(subject, predicate, object, graph) {
    // Shift arguments if a quad object is given instead of components
    if (!predicate) graph = subject.graph, object = subject.object, predicate = subject.predicate, subject = subject.subject; // Convert terms to internal string representation

    subject = toId(subject);
    predicate = toId(predicate);
    object = toId(object);
    graph = toId(graph); // Find the graph that will contain the triple

    var graphItem = this._graphs[graph]; // Create the graph if it doesn't exist yet

    if (!graphItem) {
      graphItem = this._graphs[graph] = {
        subjects: {},
        predicates: {},
        objects: {}
      }; // Freezing a graph helps subsequent `add` performance,
      // and properties will never be modified anyway

      Object.freeze(graphItem);
    } // Since entities can often be long IRIs, we avoid storing them in every index.
    // Instead, we have a separate index that maps entities to numbers,
    // which are then used as keys in the other indexes.


    var ids = this._ids;
    var entities = this._entities;
    subject = ids[subject] || (ids[entities[++this._id] = subject] = this._id);
    predicate = ids[predicate] || (ids[entities[++this._id] = predicate] = this._id);
    object = ids[object] || (ids[entities[++this._id] = object] = this._id);

    var changed = this._addToIndex(graphItem.subjects, subject, predicate, object);

    this._addToIndex(graphItem.predicates, predicate, object, subject);

    this._addToIndex(graphItem.objects, object, subject, predicate); // The cached quad count is now invalid


    this._size = null;
    return changed;
  } // ### `addQuads` adds multiple quads to the store


  addQuads(quads) {
    for (var i = 0; i < quads.length; i++) this.addQuad(quads[i]);
  } // ### `import` adds a stream of quads to the store


  import(stream) {
    var self = this;
    stream.on('data', function (quad) {
      self.addQuad(quad);
    });
    return stream;
  } // ### `removeQuad` removes a quad from the store if it exists


  removeQuad(subject, predicate, object, graph) {
    // Shift arguments if a quad object is given instead of components
    if (!predicate) graph = subject.graph, object = subject.object, predicate = subject.predicate, subject = subject.subject; // Convert terms to internal string representation

    subject = toId(subject);
    predicate = toId(predicate);
    object = toId(object);
    graph = toId(graph); // Find internal identifiers for all components
    // and verify the quad exists.

    var graphItem,
        ids = this._ids,
        graphs = this._graphs,
        subjects,
        predicates;
    if (!(subject = ids[subject]) || !(predicate = ids[predicate]) || !(object = ids[object]) || !(graphItem = graphs[graph]) || !(subjects = graphItem.subjects[subject]) || !(predicates = subjects[predicate]) || !(object in predicates)) return false; // Remove it from all indexes

    this._removeFromIndex(graphItem.subjects, subject, predicate, object);

    this._removeFromIndex(graphItem.predicates, predicate, object, subject);

    this._removeFromIndex(graphItem.objects, object, subject, predicate);

    if (this._size !== null) this._size--; // Remove the graph if it is empty

    for (subject in graphItem.subjects) return true;

    delete graphs[graph];
    return true;
  } // ### `removeQuads` removes multiple quads from the store


  removeQuads(quads) {
    for (var i = 0; i < quads.length; i++) this.removeQuad(quads[i]);
  } // ### `remove` removes a stream of quads from the store


  remove(stream) {
    var self = this;
    stream.on('data', function (quad) {
      self.removeQuad(quad);
    });
    return stream;
  } // ### `removeMatches` removes all matching quads from the store
  // Setting any field to `undefined` or `null` indicates a wildcard.


  removeMatches(subject, predicate, object, graph) {
    return this.remove(this.match(subject, predicate, object, graph));
  } // ### `deleteGraph` removes all triples with the given graph from the store


  deleteGraph(graph) {
    return this.removeMatches(null, null, null, graph);
  } // ### `getQuads` returns an array of quads matching a pattern.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  getQuads(subject, predicate, object, graph) {
    // Convert terms to internal string representation
    subject = subject && toId(subject);
    predicate = predicate && toId(predicate);
    object = object && toId(object);
    graph = graph && toId(graph);

    var quads = [],
        graphs = this._getGraphs(graph),
        content,
        ids = this._ids,
        subjectId,
        predicateId,
        objectId; // Translate IRIs to internal index keys.


    if (isString(subject) && !(subjectId = ids[subject]) || isString(predicate) && !(predicateId = ids[predicate]) || isString(object) && !(objectId = ids[object])) return quads;

    for (var graphId in graphs) {
      // Only if the specified graph contains triples, there can be results
      if (content = graphs[graphId]) {
        // Choose the optimal index, based on what fields are present
        if (subjectId) {
          if (objectId) // If subject and object are given, the object index will be the fastest
            this._findInIndex(content.objects, objectId, subjectId, predicateId, 'object', 'subject', 'predicate', graphId, null, quads);else // If only subject and possibly predicate are given, the subject index will be the fastest
            this._findInIndex(content.subjects, subjectId, predicateId, null, 'subject', 'predicate', 'object', graphId, null, quads);
        } else if (predicateId) // If only predicate and possibly object are given, the predicate index will be the fastest
          this._findInIndex(content.predicates, predicateId, objectId, null, 'predicate', 'object', 'subject', graphId, null, quads);else if (objectId) // If only object is given, the object index will be the fastest
          this._findInIndex(content.objects, objectId, null, null, 'object', 'subject', 'predicate', graphId, null, quads);else // If nothing is given, iterate subjects and predicates first
          this._findInIndex(content.subjects, null, null, null, 'subject', 'predicate', 'object', graphId, null, quads);
      }
    }

    return quads;
  } // ### `match` returns a stream of quads matching a pattern.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  match(subject, predicate, object, graph) {
    var stream = new _stream.Readable({
      objectMode: true
    }); // Initialize stream once it is being read

    stream._read = () => {
      for (var quad of this.getQuads(subject, predicate, object, graph)) stream.push(quad);

      stream.push(null);
    };

    return stream;
  } // ### `countQuads` returns the number of quads matching a pattern.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  countQuads(subject, predicate, object, graph) {
    // Convert terms to internal string representation
    subject = subject && toId(subject);
    predicate = predicate && toId(predicate);
    object = object && toId(object);
    graph = graph && toId(graph);

    var count = 0,
        graphs = this._getGraphs(graph),
        content,
        ids = this._ids,
        subjectId,
        predicateId,
        objectId; // Translate IRIs to internal index keys.


    if (isString(subject) && !(subjectId = ids[subject]) || isString(predicate) && !(predicateId = ids[predicate]) || isString(object) && !(objectId = ids[object])) return 0;

    for (var graphId in graphs) {
      // Only if the specified graph contains triples, there can be results
      if (content = graphs[graphId]) {
        // Choose the optimal index, based on what fields are present
        if (subject) {
          if (object) // If subject and object are given, the object index will be the fastest
            count += this._countInIndex(content.objects, objectId, subjectId, predicateId);else // If only subject and possibly predicate are given, the subject index will be the fastest
            count += this._countInIndex(content.subjects, subjectId, predicateId, objectId);
        } else if (predicate) {
          // If only predicate and possibly object are given, the predicate index will be the fastest
          count += this._countInIndex(content.predicates, predicateId, objectId, subjectId);
        } else {
          // If only object is possibly given, the object index will be the fastest
          count += this._countInIndex(content.objects, objectId, subjectId, predicateId);
        }
      }
    }

    return count;
  } // ### `forEach` executes the callback on all quads.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  forEach(callback, subject, predicate, object, graph) {
    this.some(function (quad) {
      callback(quad);
      return false;
    }, subject, predicate, object, graph);
  } // ### `every` executes the callback on all quads,
  // and returns `true` if it returns truthy for all them.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  every(callback, subject, predicate, object, graph) {
    var some = false;
    var every = !this.some(function (quad) {
      some = true;
      return !callback(quad);
    }, subject, predicate, object, graph);
    return some && every;
  } // ### `some` executes the callback on all quads,
  // and returns `true` if it returns truthy for any of them.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  some(callback, subject, predicate, object, graph) {
    // Convert terms to internal string representation
    subject = subject && toId(subject);
    predicate = predicate && toId(predicate);
    object = object && toId(object);
    graph = graph && toId(graph);

    var graphs = this._getGraphs(graph),
        content,
        ids = this._ids,
        subjectId,
        predicateId,
        objectId; // Translate IRIs to internal index keys.


    if (isString(subject) && !(subjectId = ids[subject]) || isString(predicate) && !(predicateId = ids[predicate]) || isString(object) && !(objectId = ids[object])) return false;

    for (var graphId in graphs) {
      // Only if the specified graph contains triples, there can be results
      if (content = graphs[graphId]) {
        // Choose the optimal index, based on what fields are present
        if (subjectId) {
          if (objectId) {
            // If subject and object are given, the object index will be the fastest
            if (this._findInIndex(content.objects, objectId, subjectId, predicateId, 'object', 'subject', 'predicate', graphId, callback, null)) return true;
          } else // If only subject and possibly predicate are given, the subject index will be the fastest
            if (this._findInIndex(content.subjects, subjectId, predicateId, null, 'subject', 'predicate', 'object', graphId, callback, null)) return true;
        } else if (predicateId) {
          // If only predicate and possibly object are given, the predicate index will be the fastest
          if (this._findInIndex(content.predicates, predicateId, objectId, null, 'predicate', 'object', 'subject', graphId, callback, null)) {
            return true;
          }
        } else if (objectId) {
          // If only object is given, the object index will be the fastest
          if (this._findInIndex(content.objects, objectId, null, null, 'object', 'subject', 'predicate', graphId, callback, null)) {
            return true;
          }
        } else // If nothing is given, iterate subjects and predicates first
          if (this._findInIndex(content.subjects, null, null, null, 'subject', 'predicate', 'object', graphId, callback, null)) {
            return true;
          }
      }
    }

    return false;
  } // ### `getSubjects` returns all subjects that match the pattern.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  getSubjects(predicate, object, graph) {
    var results = [];
    this.forSubjects(function (s) {
      results.push(s);
    }, predicate, object, graph);
    return results;
  } // ### `forSubjects` executes the callback on all subjects that match the pattern.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  forSubjects(callback, predicate, object, graph) {
    // Convert terms to internal string representation
    predicate = predicate && toId(predicate);
    object = object && toId(object);
    graph = graph && toId(graph);

    var ids = this._ids,
        graphs = this._getGraphs(graph),
        content,
        predicateId,
        objectId;

    callback = this._uniqueEntities(callback); // Translate IRIs to internal index keys.

    if (isString(predicate) && !(predicateId = ids[predicate]) || isString(object) && !(objectId = ids[object])) return;

    for (graph in graphs) {
      // Only if the specified graph contains triples, there can be results
      if (content = graphs[graph]) {
        // Choose optimal index based on which fields are wildcards
        if (predicateId) {
          if (objectId) // If predicate and object are given, the POS index is best.
            this._loopBy2Keys(content.predicates, predicateId, objectId, callback);else // If only predicate is given, the SPO index is best.
            this._loopByKey1(content.subjects, predicateId, callback);
        } else if (objectId) // If only object is given, the OSP index is best.
          this._loopByKey0(content.objects, objectId, callback);else // If no params given, iterate all the subjects
          this._loop(content.subjects, callback);
      }
    }
  } // ### `getPredicates` returns all predicates that match the pattern.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  getPredicates(subject, object, graph) {
    var results = [];
    this.forPredicates(function (p) {
      results.push(p);
    }, subject, object, graph);
    return results;
  } // ### `forPredicates` executes the callback on all predicates that match the pattern.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  forPredicates(callback, subject, object, graph) {
    // Convert terms to internal string representation
    subject = subject && toId(subject);
    object = object && toId(object);
    graph = graph && toId(graph);

    var ids = this._ids,
        graphs = this._getGraphs(graph),
        content,
        subjectId,
        objectId;

    callback = this._uniqueEntities(callback); // Translate IRIs to internal index keys.

    if (isString(subject) && !(subjectId = ids[subject]) || isString(object) && !(objectId = ids[object])) return;

    for (graph in graphs) {
      // Only if the specified graph contains triples, there can be results
      if (content = graphs[graph]) {
        // Choose optimal index based on which fields are wildcards
        if (subjectId) {
          if (objectId) // If subject and object are given, the OSP index is best.
            this._loopBy2Keys(content.objects, objectId, subjectId, callback);else // If only subject is given, the SPO index is best.
            this._loopByKey0(content.subjects, subjectId, callback);
        } else if (objectId) // If only object is given, the POS index is best.
          this._loopByKey1(content.predicates, objectId, callback);else // If no params given, iterate all the predicates.
          this._loop(content.predicates, callback);
      }
    }
  } // ### `getObjects` returns all objects that match the pattern.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  getObjects(subject, predicate, graph) {
    var results = [];
    this.forObjects(function (o) {
      results.push(o);
    }, subject, predicate, graph);
    return results;
  } // ### `forObjects` executes the callback on all objects that match the pattern.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  forObjects(callback, subject, predicate, graph) {
    // Convert terms to internal string representation
    subject = subject && toId(subject);
    predicate = predicate && toId(predicate);
    graph = graph && toId(graph);

    var ids = this._ids,
        graphs = this._getGraphs(graph),
        content,
        subjectId,
        predicateId;

    callback = this._uniqueEntities(callback); // Translate IRIs to internal index keys.

    if (isString(subject) && !(subjectId = ids[subject]) || isString(predicate) && !(predicateId = ids[predicate])) return;

    for (graph in graphs) {
      // Only if the specified graph contains triples, there can be results
      if (content = graphs[graph]) {
        // Choose optimal index based on which fields are wildcards
        if (subjectId) {
          if (predicateId) // If subject and predicate are given, the SPO index is best.
            this._loopBy2Keys(content.subjects, subjectId, predicateId, callback);else // If only subject is given, the OSP index is best.
            this._loopByKey1(content.objects, subjectId, callback);
        } else if (predicateId) // If only predicate is given, the POS index is best.
          this._loopByKey0(content.predicates, predicateId, callback);else // If no params given, iterate all the objects.
          this._loop(content.objects, callback);
      }
    }
  } // ### `getGraphs` returns all graphs that match the pattern.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  getGraphs(subject, predicate, object) {
    var results = [];
    this.forGraphs(function (g) {
      results.push(g);
    }, subject, predicate, object);
    return results;
  } // ### `forGraphs` executes the callback on all graphs that match the pattern.
  // Setting any field to `undefined` or `null` indicates a wildcard.


  forGraphs(callback, subject, predicate, object) {
    for (var graph in this._graphs) {
      this.some(function (quad) {
        callback(quad.graph);
        return true; // Halt iteration of some()
      }, subject, predicate, object, graph);
    }
  } // ### `createBlankNode` creates a new blank node, returning its name


  createBlankNode(suggestedName) {
    var name, index; // Generate a name based on the suggested name

    if (suggestedName) {
      name = suggestedName = '_:' + suggestedName, index = 1;

      while (this._ids[name]) name = suggestedName + index++;
    } // Generate a generic blank node name
    else {
        do {
          name = '_:b' + this._blankNodeIndex++;
        } while (this._ids[name]);
      } // Add the blank node to the entities, avoiding the generation of duplicates


    this._ids[name] = ++this._id;
    this._entities[this._id] = name;
    return this._factory.blankNode(name.substr(2));
  } // ### `extractLists` finds and removes all list triples
  // and returns the items per list.


  extractLists({
    remove = false,
    ignoreErrors = false
  } = {}) {
    var lists = {}; // has scalar keys so could be a simple Object

    var onError = ignoreErrors ? () => true : (node, message) => {
      throw new Error(`${node.value} ${message}`);
    }; // Traverse each list from its tail

    var tails = this.getQuads(null, _IRIs.default.rdf.rest, _IRIs.default.rdf.nil, null);
    var toRemove = remove ? [...tails] : [];
    tails.forEach(tailQuad => {
      var items = []; // the members found as objects of rdf:first quads

      var malformed = false; // signals whether the current list is malformed

      var head; // the head of the list (_:b1 in above example)

      var headPos; // set to subject or object when head is set

      var graph = tailQuad.graph; // make sure list is in exactly one graph
      // Traverse the list from tail to end

      var current = tailQuad.subject;

      while (current && !malformed) {
        var objectQuads = this.getQuads(null, null, current, null);
        var subjectQuads = this.getQuads(current, null, null, null);
        var i,
            quad,
            first = null,
            rest = null,
            parent = null; // Find the first and rest of this list node

        for (i = 0; i < subjectQuads.length && !malformed; i++) {
          quad = subjectQuads[i];
          if (!quad.graph.equals(graph)) malformed = onError(current, 'not confined to single graph');else if (head) malformed = onError(current, 'has non-list arcs out'); // one rdf:first
          else if (quad.predicate.value === _IRIs.default.rdf.first) {
              if (first) malformed = onError(current, 'has multiple rdf:first arcs');else toRemove.push(first = quad);
            } // one rdf:rest
            else if (quad.predicate.value === _IRIs.default.rdf.rest) {
                if (rest) malformed = onError(current, 'has multiple rdf:rest arcs');else toRemove.push(rest = quad);
              } // alien triple
              else if (objectQuads.length) malformed = onError(current, 'can\'t be subject and object');else {
                  head = quad; // e.g. { (1 2 3) :p :o }

                  headPos = 'subject';
                }
        } // { :s :p (1 2) } arrives here with no head
        // { (1 2) :p :o } arrives here with head set to the list.


        for (i = 0; i < objectQuads.length && !malformed; ++i) {
          quad = objectQuads[i];
          if (head) malformed = onError(current, 'can\'t have coreferences'); // one rdf:rest
          else if (quad.predicate.value === _IRIs.default.rdf.rest) {
              if (parent) malformed = onError(current, 'has incoming rdf:rest arcs');else parent = quad;
            } else {
              head = quad; // e.g. { :s :p (1 2) }

              headPos = 'object';
            }
        } // Store the list item and continue with parent


        if (!first) malformed = onError(current, 'has no list head');else items.unshift(first.object);
        current = parent && parent.subject;
      } // Don't remove any quads if the list is malformed


      if (malformed) remove = false; // Store the list under the value of its head
      else if (head) lists[head[headPos].value] = items;
    }); // Remove list quads if requested

    if (remove) this.removeQuads(toRemove);
    return lists;
  }

} // Determines whether the argument is a string


exports.default = N3Store;

function isString(s) {
  return typeof s === 'string' || s instanceof String;
}
},{"./IRIs":52,"./N3DataFactory":53,"stream":83}],57:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _N3Parser = _interopRequireDefault(require("./N3Parser"));

var _stream = require("stream");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// **N3StreamParser** parses a text stream into a quad stream.
// ## Constructor
class N3StreamParser extends _stream.Transform {
  constructor(options) {
    super({
      decodeStrings: true
    });
    this._readableState.objectMode = true; // Set up parser with dummy stream to obtain `data` and `end` callbacks

    var self = this,
        parser = new _N3Parser.default(options),
        onData,
        onEnd;
    parser.parse({
      on: function (event, callback) {
        switch (event) {
          case 'data':
            onData = callback;
            break;

          case 'end':
            onEnd = callback;
            break;
        }
      }
    }, // Handle quads by pushing them down the pipeline
    function (error, quad) {
      error && self.emit('error', error) || quad && self.push(quad);
    }, // Emit prefixes through the `prefix` event
    function (prefix, uri) {
      self.emit('prefix', prefix, uri);
    }); // Implement Transform methods through parser callbacks

    this._transform = function (chunk, encoding, done) {
      onData(chunk);
      done();
    };

    this._flush = function (done) {
      onEnd();
      done();
    };
  } // ### Parses a stream of strings


  import(stream) {
    var self = this;
    stream.on('data', function (chunk) {
      self.write(chunk);
    });
    stream.on('end', function () {
      self.end();
    });
    stream.on('error', function (error) {
      self.emit('error', error);
    });
    return this;
  }

}

exports.default = N3StreamParser;
},{"./N3Parser":55,"stream":83}],58:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _stream = require("stream");

var _N3Writer = _interopRequireDefault(require("./N3Writer"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// **N3StreamWriter** serializes a quad stream into a text stream.
// ## Constructor
class N3StreamWriter extends _stream.Transform {
  constructor(options) {
    super({
      encoding: 'utf8'
    });
    this._writableState.objectMode = true; // Set up writer with a dummy stream object

    var self = this;
    var writer = this._writer = new _N3Writer.default({
      write: function (quad, encoding, callback) {
        self.push(quad);
        callback && callback();
      },
      end: function (callback) {
        self.push(null);
        callback && callback();
      }
    }, options); // Implement Transform methods on top of writer

    this._transform = function (quad, encoding, done) {
      writer.addQuad(quad, done);
    };

    this._flush = function (done) {
      writer.end(done);
    };
  } // ### Serializes a stream of quads


  import(stream) {
    var self = this;
    stream.on('data', function (quad) {
      self.write(quad);
    });
    stream.on('end', function () {
      self.end();
    });
    stream.on('error', function (error) {
      self.emit('error', error);
    });
    stream.on('prefix', function (prefix, iri) {
      self._writer.addPrefix(prefix, iri);
    });
    return this;
  }

}

exports.default = N3StreamWriter;
},{"./N3Writer":60,"stream":83}],59:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.isNamedNode = isNamedNode;
exports.isBlankNode = isBlankNode;
exports.isLiteral = isLiteral;
exports.isVariable = isVariable;
exports.isDefaultGraph = isDefaultGraph;
exports.inDefaultGraph = inDefaultGraph;
exports.prefix = prefix;
exports.prefixes = prefixes;

var _N3DataFactory = _interopRequireDefault(require("./N3DataFactory"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// **N3Util** provides N3 utility functions.
// Tests whether the given term represents an IRI
function isNamedNode(term) {
  return !!term && term.termType === 'NamedNode';
} // Tests whether the given term represents a blank node


function isBlankNode(term) {
  return !!term && term.termType === 'BlankNode';
} // Tests whether the given term represents a literal


function isLiteral(term) {
  return !!term && term.termType === 'Literal';
} // Tests whether the given term represents a variable


function isVariable(term) {
  return !!term && term.termType === 'Variable';
} // Tests whether the given term represents the default graph


function isDefaultGraph(term) {
  return !!term && term.termType === 'DefaultGraph';
} // Tests whether the given quad is in the default graph


function inDefaultGraph(quad) {
  return isDefaultGraph(quad.graph);
} // Creates a function that prepends the given IRI to a local name


function prefix(iri, factory) {
  return prefixes({
    '': iri
  }, factory)('');
} // Creates a function that allows registering and expanding prefixes


function prefixes(defaultPrefixes, factory) {
  // Add all of the default prefixes
  var prefixes = Object.create(null);

  for (var prefix in defaultPrefixes) processPrefix(prefix, defaultPrefixes[prefix]); // Set the default factory if none was specified


  factory = factory || _N3DataFactory.default; // Registers a new prefix (if an IRI was specified)
  // or retrieves a function that expands an existing prefix (if no IRI was specified)

  function processPrefix(prefix, iri) {
    // Create a new prefix if an IRI is specified or the prefix doesn't exist
    if (typeof iri === 'string') {
      // Create a function that expands the prefix
      var cache = Object.create(null);

      prefixes[prefix] = function (local) {
        return cache[local] || (cache[local] = factory.namedNode(iri + local));
      };
    } else if (!(prefix in prefixes)) {
      throw new Error('Unknown prefix: ' + prefix);
    }

    return prefixes[prefix];
  }

  return processPrefix;
}
},{"./N3DataFactory":53}],60:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _IRIs = _interopRequireDefault(require("./IRIs"));

var _N3DataFactory = _interopRequireDefault(require("./N3DataFactory"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// **N3Writer** writes N3 documents.
const DEFAULTGRAPH = _N3DataFactory.default.defaultGraph();

const {
  rdf,
  xsd
} = _IRIs.default; // Characters in literals that require escaping

var escape = /["\\\t\n\r\b\f\u0000-\u0019\ud800-\udbff]/,
    escapeAll = /["\\\t\n\r\b\f\u0000-\u0019]|[\ud800-\udbff][\udc00-\udfff]/g,
    escapedCharacters = {
  '\\': '\\\\',
  '"': '\\"',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
  '\b': '\\b',
  '\f': '\\f'
}; // ## Placeholder class to represent already pretty-printed terms

class SerializedTerm extends _N3DataFactory.default.internal.Term {
  // Pretty-printed nodes are not equal to any other node
  // (e.g., [] does not equal [])
  equals() {
    return false;
  }

} // ## Constructor


class N3Writer {
  constructor(outputStream, options) {
    // ### `_prefixRegex` matches a prefixed name or IRI that begins with one of the added prefixes
    this._prefixRegex = /$0^/; // Shift arguments if the first argument is not a stream

    if (outputStream && typeof outputStream.write !== 'function') options = outputStream, outputStream = null;
    options = options || {};
    this._lists = options.lists; // If no output stream given, send the output as string through the end callback

    if (!outputStream) {
      var output = '';
      this._outputStream = {
        write(chunk, encoding, done) {
          output += chunk;
          done && done();
        },

        end: function (done) {
          done && done(null, output);
        }
      };
      this._endStream = true;
    } else {
      this._outputStream = outputStream;
      this._endStream = options.end === undefined ? true : !!options.end;
    } // Initialize writer, depending on the format


    this._subject = null;

    if (!/triple|quad/i.test(options.format)) {
      this._graph = DEFAULTGRAPH;
      this._prefixIRIs = Object.create(null);
      options.prefixes && this.addPrefixes(options.prefixes);
    } else {
      this._writeQuad = this._writeQuadLine;
    }
  } // ## Private methods
  // ### Whether the current graph is the default graph


  get _inDefaultGraph() {
    return DEFAULTGRAPH.equals(this._graph);
  } // ### `_write` writes the argument to the output stream


  _write(string, callback) {
    this._outputStream.write(string, 'utf8', callback);
  } // ### `_writeQuad` writes the quad to the output stream


  _writeQuad(subject, predicate, object, graph, done) {
    try {
      // Write the graph's label if it has changed
      if (!graph.equals(this._graph)) {
        // Close the previous graph and start the new one
        this._write((this._subject === null ? '' : this._inDefaultGraph ? '.\n' : '\n}\n') + (DEFAULTGRAPH.equals(graph) ? '' : this._encodeIriOrBlank(graph) + ' {\n'));

        this._graph = graph;
        this._subject = null;
      } // Don't repeat the subject if it's the same


      if (subject.equals(this._subject)) {
        // Don't repeat the predicate if it's the same
        if (predicate.equals(this._predicate)) this._write(', ' + this._encodeObject(object), done); // Same subject, different predicate
        else this._write(';\n    ' + this._encodePredicate(this._predicate = predicate) + ' ' + this._encodeObject(object), done);
      } // Different subject; write the whole quad
      else this._write((this._subject === null ? '' : '.\n') + this._encodeIriOrBlank(this._subject = subject) + ' ' + this._encodePredicate(this._predicate = predicate) + ' ' + this._encodeObject(object), done);
    } catch (error) {
      done && done(error);
    }
  } // ### `_writeQuadLine` writes the quad to the output stream as a single line


  _writeQuadLine(subject, predicate, object, graph, done) {
    // Write the quad without prefixes
    delete this._prefixMatch;

    this._write(this.quadToString(subject, predicate, object, graph), done);
  } // ### `quadToString` serializes a quad as a string


  quadToString(subject, predicate, object, graph) {
    return this._encodeIriOrBlank(subject) + ' ' + this._encodeIriOrBlank(predicate) + ' ' + this._encodeObject(object) + (graph && graph.value ? ' ' + this._encodeIriOrBlank(graph) + ' .\n' : ' .\n');
  } // ### `quadsToString` serializes an array of quads as a string


  quadsToString(quads) {
    return quads.map(function (t) {
      return this.quadToString(t.subject, t.predicate, t.object, t.graph);
    }, this).join('');
  } // ### `_encodeIriOrBlank` represents an IRI or blank node


  _encodeIriOrBlank(entity) {
    // A blank node or list is represented as-is
    if (entity.termType !== 'NamedNode') {
      // If it is a list head, pretty-print it
      if (this._lists && entity.value in this._lists) entity = this.list(this._lists[entity.value]);
      return 'id' in entity ? entity.id : '_:' + entity.value;
    } // Escape special characters


    var iri = entity.value;
    if (escape.test(iri)) iri = iri.replace(escapeAll, characterReplacer); // Try to represent the IRI as prefixed name

    var prefixMatch = this._prefixRegex.exec(iri);

    return !prefixMatch ? '<' + iri + '>' : !prefixMatch[1] ? iri : this._prefixIRIs[prefixMatch[1]] + prefixMatch[2];
  } // ### `_encodeLiteral` represents a literal


  _encodeLiteral(literal) {
    // Escape special characters
    var value = literal.value;
    if (escape.test(value)) value = value.replace(escapeAll, characterReplacer); // Write the literal, possibly with type or language

    if (literal.language) return '"' + value + '"@' + literal.language;else if (literal.datatype.value !== xsd.string) return '"' + value + '"^^' + this._encodeIriOrBlank(literal.datatype);else return '"' + value + '"';
  } // ### `_encodePredicate` represents a predicate


  _encodePredicate(predicate) {
    return predicate.value === rdf.type ? 'a' : this._encodeIriOrBlank(predicate);
  } // ### `_encodeObject` represents an object


  _encodeObject(object) {
    return object.termType === 'Literal' ? this._encodeLiteral(object) : this._encodeIriOrBlank(object);
  } // ### `_blockedWrite` replaces `_write` after the writer has been closed


  _blockedWrite() {
    throw new Error('Cannot write because the writer has been closed.');
  } // ### `addQuad` adds the quad to the output stream


  addQuad(subject, predicate, object, graph, done) {
    // The quad was given as an object, so shift parameters
    if (object === undefined) this._writeQuad(subject.subject, subject.predicate, subject.object, subject.graph, predicate); // The optional `graph` parameter was not provided
    else if (typeof graph === 'function') this._writeQuad(subject, predicate, object, DEFAULTGRAPH, graph); // The `graph` parameter was provided
      else this._writeQuad(subject, predicate, object, graph || DEFAULTGRAPH, done);
  } // ### `addQuads` adds the quads to the output stream


  addQuads(quads) {
    for (var i = 0; i < quads.length; i++) this.addQuad(quads[i]);
  } // ### `addPrefix` adds the prefix to the output stream


  addPrefix(prefix, iri, done) {
    var prefixes = {};
    prefixes[prefix] = iri;
    this.addPrefixes(prefixes, done);
  } // ### `addPrefixes` adds the prefixes to the output stream


  addPrefixes(prefixes, done) {
    var prefixIRIs = this._prefixIRIs,
        hasPrefixes = false;

    for (var prefix in prefixes) {
      var iri = prefixes[prefix];
      if (typeof iri !== 'string') iri = iri.value;
      hasPrefixes = true; // Finish a possible pending quad

      if (this._subject !== null) {
        this._write(this._inDefaultGraph ? '.\n' : '\n}\n');

        this._subject = null, this._graph = '';
      } // Store and write the prefix


      prefixIRIs[iri] = prefix += ':';

      this._write('@prefix ' + prefix + ' <' + iri + '>.\n');
    } // Recreate the prefix matcher


    if (hasPrefixes) {
      var IRIlist = '',
          prefixList = '';

      for (var prefixIRI in prefixIRIs) {
        IRIlist += IRIlist ? '|' + prefixIRI : prefixIRI;
        prefixList += (prefixList ? '|' : '') + prefixIRIs[prefixIRI];
      }

      IRIlist = IRIlist.replace(/[\]\/\(\)\*\+\?\.\\\$]/g, '\\$&');
      this._prefixRegex = new RegExp('^(?:' + prefixList + ')[^\/]*$|' + '^(' + IRIlist + ')([a-zA-Z][\\-_a-zA-Z0-9]*)$');
    } // End a prefix block with a newline


    this._write(hasPrefixes ? '\n' : '', done);
  } // ### `blank` creates a blank node with the given content


  blank(predicate, object) {
    var children = predicate,
        child,
        length; // Empty blank node

    if (predicate === undefined) children = []; // Blank node passed as blank(Term("predicate"), Term("object"))
    else if (predicate.termType) children = [{
        predicate: predicate,
        object: object
      }]; // Blank node passed as blank({ predicate: predicate, object: object })
      else if (!('length' in predicate)) children = [predicate];

    switch (length = children.length) {
      // Generate an empty blank node
      case 0:
        return new SerializedTerm('[]');
      // Generate a non-nested one-triple blank node

      case 1:
        child = children[0];
        if (!(child.object instanceof SerializedTerm)) return new SerializedTerm('[ ' + this._encodePredicate(child.predicate) + ' ' + this._encodeObject(child.object) + ' ]');
      // Generate a multi-triple or nested blank node

      default:
        var contents = '['; // Write all triples in order

        for (var i = 0; i < length; i++) {
          child = children[i]; // Write only the object is the predicate is the same as the previous

          if (child.predicate.equals(predicate)) contents += ', ' + this._encodeObject(child.object); // Otherwise, write the predicate and the object
          else {
              contents += (i ? ';\n  ' : '\n  ') + this._encodePredicate(child.predicate) + ' ' + this._encodeObject(child.object);
              predicate = child.predicate;
            }
        }

        return new SerializedTerm(contents + '\n]');
    }
  } // ### `list` creates a list node with the given content


  list(elements) {
    var length = elements && elements.length || 0,
        contents = new Array(length);

    for (var i = 0; i < length; i++) contents[i] = this._encodeObject(elements[i]);

    return new SerializedTerm('(' + contents.join(' ') + ')');
  } // ### `end` signals the end of the output stream


  end(done) {
    // Finish a possible pending quad
    if (this._subject !== null) {
      this._write(this._inDefaultGraph ? '.\n' : '\n}\n');

      this._subject = null;
    } // Disallow further writing


    this._write = this._blockedWrite; // Try to end the underlying stream, ensuring done is called exactly one time

    var singleDone = done && function (error, result) {
      singleDone = null, done(error, result);
    };

    if (this._endStream) {
      try {
        return this._outputStream.end(singleDone);
      } catch (error) {
        /* error closing stream */
      }
    }

    singleDone && singleDone();
  }

} // Replaces a character by its escaped version


exports.default = N3Writer;

function characterReplacer(character) {
  // Replace a single character by its escaped version
  var result = escapedCharacters[character];

  if (result === undefined) {
    // Replace a single character with its 4-bit unicode escape sequence
    if (character.length === 1) {
      result = character.charCodeAt(0).toString(16);
      result = '\\u0000'.substr(0, 6 - result.length) + result;
    } // Replace a surrogate pair with its 8-bit unicode escape sequence
    else {
        result = ((character.charCodeAt(0) - 0xD800) * 0x400 + character.charCodeAt(1) + 0x2400).toString(16);
        result = '\\U00000000'.substr(0, 10 - result.length) + result;
      }
  }

  return result;
}
},{"./IRIs":52,"./N3DataFactory":53}],61:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "DataFactory", {
  enumerable: true,
  get: function () {
    return _N3DataFactory.default;
  }
});
Object.defineProperty(exports, "Lexer", {
  enumerable: true,
  get: function () {
    return _N3Lexer.default;
  }
});
Object.defineProperty(exports, "Parser", {
  enumerable: true,
  get: function () {
    return _N3Parser.default;
  }
});
Object.defineProperty(exports, "Writer", {
  enumerable: true,
  get: function () {
    return _N3Writer.default;
  }
});
Object.defineProperty(exports, "Store", {
  enumerable: true,
  get: function () {
    return _N3Store.default;
  }
});
Object.defineProperty(exports, "StreamParser", {
  enumerable: true,
  get: function () {
    return _N3StreamParser.default;
  }
});
Object.defineProperty(exports, "StreamWriter", {
  enumerable: true,
  get: function () {
    return _N3StreamWriter.default;
  }
});
exports.Util = void 0;

var _N3DataFactory = _interopRequireDefault(require("./N3DataFactory"));

var _N3Lexer = _interopRequireDefault(require("./N3Lexer"));

var _N3Parser = _interopRequireDefault(require("./N3Parser"));

var _N3Writer = _interopRequireDefault(require("./N3Writer"));

var _N3Store = _interopRequireDefault(require("./N3Store"));

var _N3StreamParser = _interopRequireDefault(require("./N3StreamParser"));

var _N3StreamWriter = _interopRequireDefault(require("./N3StreamWriter"));

var Util = _interopRequireWildcard(require("./N3Util"));

exports.Util = Util;

function _getRequireWildcardCache() { if (typeof WeakMap !== "function") return null; var cache = new WeakMap(); _getRequireWildcardCache = function () { return cache; }; return cache; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
},{"./N3DataFactory":53,"./N3Lexer":54,"./N3Parser":55,"./N3Store":56,"./N3StreamParser":57,"./N3StreamWriter":58,"./N3Util":59,"./N3Writer":60}],62:[function(require,module,exports){
(function (process){
'use strict';

if (typeof process === 'undefined' ||
    !process.version ||
    process.version.indexOf('v0.') === 0 ||
    process.version.indexOf('v1.') === 0 && process.version.indexOf('v1.8.') !== 0) {
  module.exports = { nextTick: nextTick };
} else {
  module.exports = process
}

function nextTick(fn, arg1, arg2, arg3) {
  if (typeof fn !== 'function') {
    throw new TypeError('"callback" argument must be a function');
  }
  var len = arguments.length;
  var args, i;
  switch (len) {
  case 0:
  case 1:
    return process.nextTick(fn);
  case 2:
    return process.nextTick(function afterTickOne() {
      fn.call(null, arg1);
    });
  case 3:
    return process.nextTick(function afterTickTwo() {
      fn.call(null, arg1, arg2);
    });
  case 4:
    return process.nextTick(function afterTickThree() {
      fn.call(null, arg1, arg2, arg3);
    });
  default:
    args = new Array(len - 1);
    i = 0;
    while (i < args.length) {
      args[i++] = arguments[i];
    }
    return process.nextTick(function afterTick() {
      fn.apply(null, args);
    });
  }
}


}).call(this,require('_process'))
},{"_process":63}],63:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],64:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = function(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  var obj = {};

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  var regexp = /\+/g;
  qs = qs.split(sep);

  var maxKeys = 1000;
  if (options && typeof options.maxKeys === 'number') {
    maxKeys = options.maxKeys;
  }

  var len = qs.length;
  // maxKeys <= 0 means that we should not limit keys count
  if (maxKeys > 0 && len > maxKeys) {
    len = maxKeys;
  }

  for (var i = 0; i < len; ++i) {
    var x = qs[i].replace(regexp, '%20'),
        idx = x.indexOf(eq),
        kstr, vstr, k, v;

    if (idx >= 0) {
      kstr = x.substr(0, idx);
      vstr = x.substr(idx + 1);
    } else {
      kstr = x;
      vstr = '';
    }

    k = decodeURIComponent(kstr);
    v = decodeURIComponent(vstr);

    if (!hasOwnProperty(obj, k)) {
      obj[k] = v;
    } else if (isArray(obj[k])) {
      obj[k].push(v);
    } else {
      obj[k] = [obj[k], v];
    }
  }

  return obj;
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

},{}],65:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var stringifyPrimitive = function(v) {
  switch (typeof v) {
    case 'string':
      return v;

    case 'boolean':
      return v ? 'true' : 'false';

    case 'number':
      return isFinite(v) ? v : '';

    default:
      return '';
  }
};

module.exports = function(obj, sep, eq, name) {
  sep = sep || '&';
  eq = eq || '=';
  if (obj === null) {
    obj = undefined;
  }

  if (typeof obj === 'object') {
    return map(objectKeys(obj), function(k) {
      var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
      if (isArray(obj[k])) {
        return map(obj[k], function(v) {
          return ks + encodeURIComponent(stringifyPrimitive(v));
        }).join(sep);
      } else {
        return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
      }
    }).join(sep);

  }

  if (!name) return '';
  return encodeURIComponent(stringifyPrimitive(name)) + eq +
         encodeURIComponent(stringifyPrimitive(obj));
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

function map (xs, f) {
  if (xs.map) return xs.map(f);
  var res = [];
  for (var i = 0; i < xs.length; i++) {
    res.push(f(xs[i], i));
  }
  return res;
}

var objectKeys = Object.keys || function (obj) {
  var res = [];
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) res.push(key);
  }
  return res;
};

},{}],66:[function(require,module,exports){
'use strict';

exports.decode = exports.parse = require('./decode');
exports.encode = exports.stringify = require('./encode');

},{"./decode":64,"./encode":65}],67:[function(require,module,exports){
module.exports = require('./lib/_stream_duplex.js');

},{"./lib/_stream_duplex.js":68}],68:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a duplex stream is just a stream that is both readable and writable.
// Since JS doesn't have multiple prototypal inheritance, this class
// prototypally inherits from Readable, and then parasitically from
// Writable.

'use strict';

/*<replacement>*/

var pna = require('process-nextick-args');
/*</replacement>*/

/*<replacement>*/
var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) {
    keys.push(key);
  }return keys;
};
/*</replacement>*/

module.exports = Duplex;

/*<replacement>*/
var util = Object.create(require('core-util-is'));
util.inherits = require('inherits');
/*</replacement>*/

var Readable = require('./_stream_readable');
var Writable = require('./_stream_writable');

util.inherits(Duplex, Readable);

{
  // avoid scope creep, the keys array can then be collected
  var keys = objectKeys(Writable.prototype);
  for (var v = 0; v < keys.length; v++) {
    var method = keys[v];
    if (!Duplex.prototype[method]) Duplex.prototype[method] = Writable.prototype[method];
  }
}

function Duplex(options) {
  if (!(this instanceof Duplex)) return new Duplex(options);

  Readable.call(this, options);
  Writable.call(this, options);

  if (options && options.readable === false) this.readable = false;

  if (options && options.writable === false) this.writable = false;

  this.allowHalfOpen = true;
  if (options && options.allowHalfOpen === false) this.allowHalfOpen = false;

  this.once('end', onend);
}

Object.defineProperty(Duplex.prototype, 'writableHighWaterMark', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function () {
    return this._writableState.highWaterMark;
  }
});

// the no-half-open enforcer
function onend() {
  // if we allow half-open state, or if the writable side ended,
  // then we're ok.
  if (this.allowHalfOpen || this._writableState.ended) return;

  // no more data can be written.
  // But allow more writes to happen in this tick.
  pna.nextTick(onEndNT, this);
}

function onEndNT(self) {
  self.end();
}

Object.defineProperty(Duplex.prototype, 'destroyed', {
  get: function () {
    if (this._readableState === undefined || this._writableState === undefined) {
      return false;
    }
    return this._readableState.destroyed && this._writableState.destroyed;
  },
  set: function (value) {
    // we ignore the value if the stream
    // has not been initialized yet
    if (this._readableState === undefined || this._writableState === undefined) {
      return;
    }

    // backward compatibility, the user is explicitly
    // managing destroyed
    this._readableState.destroyed = value;
    this._writableState.destroyed = value;
  }
});

Duplex.prototype._destroy = function (err, cb) {
  this.push(null);
  this.end();

  pna.nextTick(cb, err);
};
},{"./_stream_readable":70,"./_stream_writable":72,"core-util-is":16,"inherits":21,"process-nextick-args":62}],69:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a passthrough stream.
// basically just the most minimal sort of Transform stream.
// Every written chunk gets output as-is.

'use strict';

module.exports = PassThrough;

var Transform = require('./_stream_transform');

/*<replacement>*/
var util = Object.create(require('core-util-is'));
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(PassThrough, Transform);

function PassThrough(options) {
  if (!(this instanceof PassThrough)) return new PassThrough(options);

  Transform.call(this, options);
}

PassThrough.prototype._transform = function (chunk, encoding, cb) {
  cb(null, chunk);
};
},{"./_stream_transform":71,"core-util-is":16,"inherits":21}],70:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

/*<replacement>*/

var pna = require('process-nextick-args');
/*</replacement>*/

module.exports = Readable;

/*<replacement>*/
var isArray = require('isarray');
/*</replacement>*/

/*<replacement>*/
var Duplex;
/*</replacement>*/

Readable.ReadableState = ReadableState;

/*<replacement>*/
var EE = require('events').EventEmitter;

var EElistenerCount = function (emitter, type) {
  return emitter.listeners(type).length;
};
/*</replacement>*/

/*<replacement>*/
var Stream = require('./internal/streams/stream');
/*</replacement>*/

/*<replacement>*/

var Buffer = require('safe-buffer').Buffer;
var OurUint8Array = global.Uint8Array || function () {};
function _uint8ArrayToBuffer(chunk) {
  return Buffer.from(chunk);
}
function _isUint8Array(obj) {
  return Buffer.isBuffer(obj) || obj instanceof OurUint8Array;
}

/*</replacement>*/

/*<replacement>*/
var util = Object.create(require('core-util-is'));
util.inherits = require('inherits');
/*</replacement>*/

/*<replacement>*/
var debugUtil = require('util');
var debug = void 0;
if (debugUtil && debugUtil.debuglog) {
  debug = debugUtil.debuglog('stream');
} else {
  debug = function () {};
}
/*</replacement>*/

var BufferList = require('./internal/streams/BufferList');
var destroyImpl = require('./internal/streams/destroy');
var StringDecoder;

util.inherits(Readable, Stream);

var kProxyEvents = ['error', 'close', 'destroy', 'pause', 'resume'];

function prependListener(emitter, event, fn) {
  // Sadly this is not cacheable as some libraries bundle their own
  // event emitter implementation with them.
  if (typeof emitter.prependListener === 'function') return emitter.prependListener(event, fn);

  // This is a hack to make sure that our error handler is attached before any
  // userland ones.  NEVER DO THIS. This is here only because this code needs
  // to continue to work with older versions of Node.js that do not include
  // the prependListener() method. The goal is to eventually remove this hack.
  if (!emitter._events || !emitter._events[event]) emitter.on(event, fn);else if (isArray(emitter._events[event])) emitter._events[event].unshift(fn);else emitter._events[event] = [fn, emitter._events[event]];
}

function ReadableState(options, stream) {
  Duplex = Duplex || require('./_stream_duplex');

  options = options || {};

  // Duplex streams are both readable and writable, but share
  // the same options object.
  // However, some cases require setting options to different
  // values for the readable and the writable sides of the duplex stream.
  // These options can be provided separately as readableXXX and writableXXX.
  var isDuplex = stream instanceof Duplex;

  // object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away
  this.objectMode = !!options.objectMode;

  if (isDuplex) this.objectMode = this.objectMode || !!options.readableObjectMode;

  // the point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  var hwm = options.highWaterMark;
  var readableHwm = options.readableHighWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;

  if (hwm || hwm === 0) this.highWaterMark = hwm;else if (isDuplex && (readableHwm || readableHwm === 0)) this.highWaterMark = readableHwm;else this.highWaterMark = defaultHwm;

  // cast to ints.
  this.highWaterMark = Math.floor(this.highWaterMark);

  // A linked list is used to store data chunks instead of an array because the
  // linked list can remove elements from the beginning faster than
  // array.shift()
  this.buffer = new BufferList();
  this.length = 0;
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;

  // a flag to be able to tell if the event 'readable'/'data' is emitted
  // immediately, or on a later tick.  We set this to true at first, because
  // any actions that shouldn't happen until "later" should generally also
  // not happen before the first read call.
  this.sync = true;

  // whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;
  this.resumeScheduled = false;

  // has it been destroyed
  this.destroyed = false;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // the number of writers that are awaiting a drain event in .pipe()s
  this.awaitDrain = 0;

  // if true, a maybeReadMore has been scheduled
  this.readingMore = false;

  this.decoder = null;
  this.encoding = null;
  if (options.encoding) {
    if (!StringDecoder) StringDecoder = require('string_decoder/').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

function Readable(options) {
  Duplex = Duplex || require('./_stream_duplex');

  if (!(this instanceof Readable)) return new Readable(options);

  this._readableState = new ReadableState(options, this);

  // legacy
  this.readable = true;

  if (options) {
    if (typeof options.read === 'function') this._read = options.read;

    if (typeof options.destroy === 'function') this._destroy = options.destroy;
  }

  Stream.call(this);
}

Object.defineProperty(Readable.prototype, 'destroyed', {
  get: function () {
    if (this._readableState === undefined) {
      return false;
    }
    return this._readableState.destroyed;
  },
  set: function (value) {
    // we ignore the value if the stream
    // has not been initialized yet
    if (!this._readableState) {
      return;
    }

    // backward compatibility, the user is explicitly
    // managing destroyed
    this._readableState.destroyed = value;
  }
});

Readable.prototype.destroy = destroyImpl.destroy;
Readable.prototype._undestroy = destroyImpl.undestroy;
Readable.prototype._destroy = function (err, cb) {
  this.push(null);
  cb(err);
};

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function (chunk, encoding) {
  var state = this._readableState;
  var skipChunkCheck;

  if (!state.objectMode) {
    if (typeof chunk === 'string') {
      encoding = encoding || state.defaultEncoding;
      if (encoding !== state.encoding) {
        chunk = Buffer.from(chunk, encoding);
        encoding = '';
      }
      skipChunkCheck = true;
    }
  } else {
    skipChunkCheck = true;
  }

  return readableAddChunk(this, chunk, encoding, false, skipChunkCheck);
};

// Unshift should *always* be something directly out of read()
Readable.prototype.unshift = function (chunk) {
  return readableAddChunk(this, chunk, null, true, false);
};

function readableAddChunk(stream, chunk, encoding, addToFront, skipChunkCheck) {
  var state = stream._readableState;
  if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
  } else {
    var er;
    if (!skipChunkCheck) er = chunkInvalid(state, chunk);
    if (er) {
      stream.emit('error', er);
    } else if (state.objectMode || chunk && chunk.length > 0) {
      if (typeof chunk !== 'string' && !state.objectMode && Object.getPrototypeOf(chunk) !== Buffer.prototype) {
        chunk = _uint8ArrayToBuffer(chunk);
      }

      if (addToFront) {
        if (state.endEmitted) stream.emit('error', new Error('stream.unshift() after end event'));else addChunk(stream, state, chunk, true);
      } else if (state.ended) {
        stream.emit('error', new Error('stream.push() after EOF'));
      } else {
        state.reading = false;
        if (state.decoder && !encoding) {
          chunk = state.decoder.write(chunk);
          if (state.objectMode || chunk.length !== 0) addChunk(stream, state, chunk, false);else maybeReadMore(stream, state);
        } else {
          addChunk(stream, state, chunk, false);
        }
      }
    } else if (!addToFront) {
      state.reading = false;
    }
  }

  return needMoreData(state);
}

function addChunk(stream, state, chunk, addToFront) {
  if (state.flowing && state.length === 0 && !state.sync) {
    stream.emit('data', chunk);
    stream.read(0);
  } else {
    // update the buffer info.
    state.length += state.objectMode ? 1 : chunk.length;
    if (addToFront) state.buffer.unshift(chunk);else state.buffer.push(chunk);

    if (state.needReadable) emitReadable(stream);
  }
  maybeReadMore(stream, state);
}

function chunkInvalid(state, chunk) {
  var er;
  if (!_isUint8Array(chunk) && typeof chunk !== 'string' && chunk !== undefined && !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  return er;
}

// if it's past the high water mark, we can push in some more.
// Also, if we have no data yet, we can stand some
// more bytes.  This is to work around cases where hwm=0,
// such as the repl.  Also, if the push() triggered a
// readable event, and the user called read(largeNumber) such that
// needReadable was set, then we ought to push more, so that another
// 'readable' event will be triggered.
function needMoreData(state) {
  return !state.ended && (state.needReadable || state.length < state.highWaterMark || state.length === 0);
}

Readable.prototype.isPaused = function () {
  return this._readableState.flowing === false;
};

// backwards compatibility.
Readable.prototype.setEncoding = function (enc) {
  if (!StringDecoder) StringDecoder = require('string_decoder/').StringDecoder;
  this._readableState.decoder = new StringDecoder(enc);
  this._readableState.encoding = enc;
  return this;
};

// Don't raise the hwm > 8MB
var MAX_HWM = 0x800000;
function computeNewHighWaterMark(n) {
  if (n >= MAX_HWM) {
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2 to prevent increasing hwm excessively in
    // tiny amounts
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    n++;
  }
  return n;
}

// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function howMuchToRead(n, state) {
  if (n <= 0 || state.length === 0 && state.ended) return 0;
  if (state.objectMode) return 1;
  if (n !== n) {
    // Only flow one buffer at a time
    if (state.flowing && state.length) return state.buffer.head.data.length;else return state.length;
  }
  // If we're asking for more than the current hwm, then raise the hwm.
  if (n > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(n);
  if (n <= state.length) return n;
  // Don't have enough
  if (!state.ended) {
    state.needReadable = true;
    return 0;
  }
  return state.length;
}

// you can override either this method, or the async _read(n) below.
Readable.prototype.read = function (n) {
  debug('read', n);
  n = parseInt(n, 10);
  var state = this._readableState;
  var nOrig = n;

  if (n !== 0) state.emittedReadable = false;

  // if we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (n === 0 && state.needReadable && (state.length >= state.highWaterMark || state.ended)) {
    debug('read: emitReadable', state.length, state.ended);
    if (state.length === 0 && state.ended) endReadable(this);else emitReadable(this);
    return null;
  }

  n = howMuchToRead(n, state);

  // if we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    if (state.length === 0) endReadable(this);
    return null;
  }

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // if we need a readable event, then we need to do some reading.
  var doRead = state.needReadable;
  debug('need readable', doRead);

  // if we currently have less than the highWaterMark, then also read some
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  }

  // however, if we've ended, then there's no point, and if we're already
  // reading, then it's unnecessary.
  if (state.ended || state.reading) {
    doRead = false;
    debug('reading or ended', doRead);
  } else if (doRead) {
    debug('do read');
    state.reading = true;
    state.sync = true;
    // if the length is currently zero, then we *need* a readable event.
    if (state.length === 0) state.needReadable = true;
    // call internal read method
    this._read(state.highWaterMark);
    state.sync = false;
    // If _read pushed data synchronously, then `reading` will be false,
    // and we need to re-evaluate how much data we can return to the user.
    if (!state.reading) n = howMuchToRead(nOrig, state);
  }

  var ret;
  if (n > 0) ret = fromList(n, state);else ret = null;

  if (ret === null) {
    state.needReadable = true;
    n = 0;
  } else {
    state.length -= n;
  }

  if (state.length === 0) {
    // If we have nothing in the buffer, then we want to know
    // as soon as we *do* get something into the buffer.
    if (!state.ended) state.needReadable = true;

    // If we tried to read() past the EOF, then emit end on the next tick.
    if (nOrig !== n && state.ended) endReadable(this);
  }

  if (ret !== null) this.emit('data', ret);

  return ret;
};

function onEofChunk(stream, state) {
  if (state.ended) return;
  if (state.decoder) {
    var chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  // emit 'readable' now to make sure it gets picked up.
  emitReadable(stream);
}

// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  var state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    debug('emitReadable', state.flowing);
    state.emittedReadable = true;
    if (state.sync) pna.nextTick(emitReadable_, stream);else emitReadable_(stream);
  }
}

function emitReadable_(stream) {
  debug('emit readable');
  stream.emit('readable');
  flow(stream);
}

// at this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore) {
    state.readingMore = true;
    pna.nextTick(maybeReadMore_, stream, state);
  }
}

function maybeReadMore_(stream, state) {
  var len = state.length;
  while (!state.reading && !state.flowing && !state.ended && state.length < state.highWaterMark) {
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length)
      // didn't get any data, stop spinning.
      break;else len = state.length;
  }
  state.readingMore = false;
}

// abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function (n) {
  this.emit('error', new Error('_read() is not implemented'));
};

Readable.prototype.pipe = function (dest, pipeOpts) {
  var src = this;
  var state = this._readableState;

  switch (state.pipesCount) {
    case 0:
      state.pipes = dest;
      break;
    case 1:
      state.pipes = [state.pipes, dest];
      break;
    default:
      state.pipes.push(dest);
      break;
  }
  state.pipesCount += 1;
  debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);

  var doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;

  var endFn = doEnd ? onend : unpipe;
  if (state.endEmitted) pna.nextTick(endFn);else src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable, unpipeInfo) {
    debug('onunpipe');
    if (readable === src) {
      if (unpipeInfo && unpipeInfo.hasUnpiped === false) {
        unpipeInfo.hasUnpiped = true;
        cleanup();
      }
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  }

  // when the dest drains, it reduces the awaitDrain counter
  // on the source.  This would be more elegant with a .once()
  // handler in flow(), but adding and removing repeatedly is
  // too slow.
  var ondrain = pipeOnDrain(src);
  dest.on('drain', ondrain);

  var cleanedUp = false;
  function cleanup() {
    debug('cleanup');
    // cleanup event handlers once the pipe is broken
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    dest.removeListener('drain', ondrain);
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', unpipe);
    src.removeListener('data', ondata);

    cleanedUp = true;

    // if the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (state.awaitDrain && (!dest._writableState || dest._writableState.needDrain)) ondrain();
  }

  // If the user pushes more data while we're writing to dest then we'll end up
  // in ondata again. However, we only want to increase awaitDrain once because
  // dest will only emit one 'drain' event for the multiple writes.
  // => Introduce a guard on increasing awaitDrain.
  var increasedAwaitDrain = false;
  src.on('data', ondata);
  function ondata(chunk) {
    debug('ondata');
    increasedAwaitDrain = false;
    var ret = dest.write(chunk);
    if (false === ret && !increasedAwaitDrain) {
      // If the user unpiped during `dest.write()`, it is possible
      // to get stuck in a permanently paused state if that write
      // also returned false.
      // => Check whether `dest` is still a piping destination.
      if ((state.pipesCount === 1 && state.pipes === dest || state.pipesCount > 1 && indexOf(state.pipes, dest) !== -1) && !cleanedUp) {
        debug('false write response, pause', src._readableState.awaitDrain);
        src._readableState.awaitDrain++;
        increasedAwaitDrain = true;
      }
      src.pause();
    }
  }

  // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EElistenerCount(dest, 'error') === 0) dest.emit('error', er);
  }

  // Make sure our error handler is attached before userland ones.
  prependListener(dest, 'error', onerror);

  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  }

  // tell the dest that it's being piped to
  dest.emit('pipe', src);

  // start the flow if it hasn't been started already.
  if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src) {
  return function () {
    var state = src._readableState;
    debug('pipeOnDrain', state.awaitDrain);
    if (state.awaitDrain) state.awaitDrain--;
    if (state.awaitDrain === 0 && EElistenerCount(src, 'data')) {
      state.flowing = true;
      flow(src);
    }
  };
}

Readable.prototype.unpipe = function (dest) {
  var state = this._readableState;
  var unpipeInfo = { hasUnpiped: false };

  // if we're not piping anywhere, then do nothing.
  if (state.pipesCount === 0) return this;

  // just one destination.  most common case.
  if (state.pipesCount === 1) {
    // passed in one, but it's not the right one.
    if (dest && dest !== state.pipes) return this;

    if (!dest) dest = state.pipes;

    // got a match.
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;
    if (dest) dest.emit('unpipe', this, unpipeInfo);
    return this;
  }

  // slow case. multiple pipe destinations.

  if (!dest) {
    // remove all.
    var dests = state.pipes;
    var len = state.pipesCount;
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;

    for (var i = 0; i < len; i++) {
      dests[i].emit('unpipe', this, unpipeInfo);
    }return this;
  }

  // try to find the right one.
  var index = indexOf(state.pipes, dest);
  if (index === -1) return this;

  state.pipes.splice(index, 1);
  state.pipesCount -= 1;
  if (state.pipesCount === 1) state.pipes = state.pipes[0];

  dest.emit('unpipe', this, unpipeInfo);

  return this;
};

// set up data events if they are asked for
// Ensure readable listeners eventually get something
Readable.prototype.on = function (ev, fn) {
  var res = Stream.prototype.on.call(this, ev, fn);

  if (ev === 'data') {
    // Start flowing on next tick if stream isn't explicitly paused
    if (this._readableState.flowing !== false) this.resume();
  } else if (ev === 'readable') {
    var state = this._readableState;
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = state.needReadable = true;
      state.emittedReadable = false;
      if (!state.reading) {
        pna.nextTick(nReadingNextTick, this);
      } else if (state.length) {
        emitReadable(this);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

function nReadingNextTick(self) {
  debug('readable nexttick read 0');
  self.read(0);
}

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function () {
  var state = this._readableState;
  if (!state.flowing) {
    debug('resume');
    state.flowing = true;
    resume(this, state);
  }
  return this;
};

function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    pna.nextTick(resume_, stream, state);
  }
}

function resume_(stream, state) {
  if (!state.reading) {
    debug('resume read 0');
    stream.read(0);
  }

  state.resumeScheduled = false;
  state.awaitDrain = 0;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading) stream.read(0);
}

Readable.prototype.pause = function () {
  debug('call pause flowing=%j', this._readableState.flowing);
  if (false !== this._readableState.flowing) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }
  return this;
};

function flow(stream) {
  var state = stream._readableState;
  debug('flow', state.flowing);
  while (state.flowing && stream.read() !== null) {}
}

// wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function (stream) {
  var _this = this;

  var state = this._readableState;
  var paused = false;

  stream.on('end', function () {
    debug('wrapped end');
    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length) _this.push(chunk);
    }

    _this.push(null);
  });

  stream.on('data', function (chunk) {
    debug('wrapped data');
    if (state.decoder) chunk = state.decoder.write(chunk);

    // don't skip over falsy values in objectMode
    if (state.objectMode && (chunk === null || chunk === undefined)) return;else if (!state.objectMode && (!chunk || !chunk.length)) return;

    var ret = _this.push(chunk);
    if (!ret) {
      paused = true;
      stream.pause();
    }
  });

  // proxy all the other methods.
  // important when wrapping filters and duplexes.
  for (var i in stream) {
    if (this[i] === undefined && typeof stream[i] === 'function') {
      this[i] = function (method) {
        return function () {
          return stream[method].apply(stream, arguments);
        };
      }(i);
    }
  }

  // proxy certain important events.
  for (var n = 0; n < kProxyEvents.length; n++) {
    stream.on(kProxyEvents[n], this.emit.bind(this, kProxyEvents[n]));
  }

  // when we try to consume some more bytes, simply unpause the
  // underlying stream.
  this._read = function (n) {
    debug('wrapped _read', n);
    if (paused) {
      paused = false;
      stream.resume();
    }
  };

  return this;
};

Object.defineProperty(Readable.prototype, 'readableHighWaterMark', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function () {
    return this._readableState.highWaterMark;
  }
});

// exposed for testing purposes only.
Readable._fromList = fromList;

// Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromList(n, state) {
  // nothing buffered
  if (state.length === 0) return null;

  var ret;
  if (state.objectMode) ret = state.buffer.shift();else if (!n || n >= state.length) {
    // read it all, truncate the list
    if (state.decoder) ret = state.buffer.join('');else if (state.buffer.length === 1) ret = state.buffer.head.data;else ret = state.buffer.concat(state.length);
    state.buffer.clear();
  } else {
    // read part of list
    ret = fromListPartial(n, state.buffer, state.decoder);
  }

  return ret;
}

// Extracts only enough buffered data to satisfy the amount requested.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromListPartial(n, list, hasStrings) {
  var ret;
  if (n < list.head.data.length) {
    // slice is the same for buffers and strings
    ret = list.head.data.slice(0, n);
    list.head.data = list.head.data.slice(n);
  } else if (n === list.head.data.length) {
    // first chunk is a perfect match
    ret = list.shift();
  } else {
    // result spans more than one buffer
    ret = hasStrings ? copyFromBufferString(n, list) : copyFromBuffer(n, list);
  }
  return ret;
}

// Copies a specified amount of characters from the list of buffered data
// chunks.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function copyFromBufferString(n, list) {
  var p = list.head;
  var c = 1;
  var ret = p.data;
  n -= ret.length;
  while (p = p.next) {
    var str = p.data;
    var nb = n > str.length ? str.length : n;
    if (nb === str.length) ret += str;else ret += str.slice(0, n);
    n -= nb;
    if (n === 0) {
      if (nb === str.length) {
        ++c;
        if (p.next) list.head = p.next;else list.head = list.tail = null;
      } else {
        list.head = p;
        p.data = str.slice(nb);
      }
      break;
    }
    ++c;
  }
  list.length -= c;
  return ret;
}

// Copies a specified amount of bytes from the list of buffered data chunks.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function copyFromBuffer(n, list) {
  var ret = Buffer.allocUnsafe(n);
  var p = list.head;
  var c = 1;
  p.data.copy(ret);
  n -= p.data.length;
  while (p = p.next) {
    var buf = p.data;
    var nb = n > buf.length ? buf.length : n;
    buf.copy(ret, ret.length - n, 0, nb);
    n -= nb;
    if (n === 0) {
      if (nb === buf.length) {
        ++c;
        if (p.next) list.head = p.next;else list.head = list.tail = null;
      } else {
        list.head = p;
        p.data = buf.slice(nb);
      }
      break;
    }
    ++c;
  }
  list.length -= c;
  return ret;
}

function endReadable(stream) {
  var state = stream._readableState;

  // If we get here before consuming all the bytes, then that is a
  // bug in node.  Should never happen.
  if (state.length > 0) throw new Error('"endReadable()" called on non-empty stream');

  if (!state.endEmitted) {
    state.ended = true;
    pna.nextTick(endReadableNT, state, stream);
  }
}

function endReadableNT(state, stream) {
  // Check that we didn't get one last unshift.
  if (!state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.readable = false;
    stream.emit('end');
  }
}

function indexOf(xs, x) {
  for (var i = 0, l = xs.length; i < l; i++) {
    if (xs[i] === x) return i;
  }
  return -1;
}
}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./_stream_duplex":68,"./internal/streams/BufferList":73,"./internal/streams/destroy":74,"./internal/streams/stream":75,"_process":63,"core-util-is":16,"events":19,"inherits":21,"isarray":23,"process-nextick-args":62,"safe-buffer":76,"string_decoder/":103,"util":11}],71:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a transform stream is a readable/writable stream where you do
// something with the data.  Sometimes it's called a "filter",
// but that's not a great name for it, since that implies a thing where
// some bits pass through, and others are simply ignored.  (That would
// be a valid example of a transform, of course.)
//
// While the output is causally related to the input, it's not a
// necessarily symmetric or synchronous transformation.  For example,
// a zlib stream might take multiple plain-text writes(), and then
// emit a single compressed chunk some time in the future.
//
// Here's how this works:
//
// The Transform stream has all the aspects of the readable and writable
// stream classes.  When you write(chunk), that calls _write(chunk,cb)
// internally, and returns false if there's a lot of pending writes
// buffered up.  When you call read(), that calls _read(n) until
// there's enough pending readable data buffered up.
//
// In a transform stream, the written data is placed in a buffer.  When
// _read(n) is called, it transforms the queued up data, calling the
// buffered _write cb's as it consumes chunks.  If consuming a single
// written chunk would result in multiple output chunks, then the first
// outputted bit calls the readcb, and subsequent chunks just go into
// the read buffer, and will cause it to emit 'readable' if necessary.
//
// This way, back-pressure is actually determined by the reading side,
// since _read has to be called to start processing a new chunk.  However,
// a pathological inflate type of transform can cause excessive buffering
// here.  For example, imagine a stream where every byte of input is
// interpreted as an integer from 0-255, and then results in that many
// bytes of output.  Writing the 4 bytes {ff,ff,ff,ff} would result in
// 1kb of data being output.  In this case, you could write a very small
// amount of input, and end up with a very large amount of output.  In
// such a pathological inflating mechanism, there'd be no way to tell
// the system to stop doing the transform.  A single 4MB write could
// cause the system to run out of memory.
//
// However, even in such a pathological case, only a single written chunk
// would be consumed, and then the rest would wait (un-transformed) until
// the results of the previous transformed chunk were consumed.

'use strict';

module.exports = Transform;

var Duplex = require('./_stream_duplex');

/*<replacement>*/
var util = Object.create(require('core-util-is'));
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(Transform, Duplex);

function afterTransform(er, data) {
  var ts = this._transformState;
  ts.transforming = false;

  var cb = ts.writecb;

  if (!cb) {
    return this.emit('error', new Error('write callback called multiple times'));
  }

  ts.writechunk = null;
  ts.writecb = null;

  if (data != null) // single equals check for both `null` and `undefined`
    this.push(data);

  cb(er);

  var rs = this._readableState;
  rs.reading = false;
  if (rs.needReadable || rs.length < rs.highWaterMark) {
    this._read(rs.highWaterMark);
  }
}

function Transform(options) {
  if (!(this instanceof Transform)) return new Transform(options);

  Duplex.call(this, options);

  this._transformState = {
    afterTransform: afterTransform.bind(this),
    needTransform: false,
    transforming: false,
    writecb: null,
    writechunk: null,
    writeencoding: null
  };

  // start out asking for a readable event once data is transformed.
  this._readableState.needReadable = true;

  // we have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.
  this._readableState.sync = false;

  if (options) {
    if (typeof options.transform === 'function') this._transform = options.transform;

    if (typeof options.flush === 'function') this._flush = options.flush;
  }

  // When the writable side finishes, then flush out anything remaining.
  this.on('prefinish', prefinish);
}

function prefinish() {
  var _this = this;

  if (typeof this._flush === 'function') {
    this._flush(function (er, data) {
      done(_this, er, data);
    });
  } else {
    done(this, null, null);
  }
}

Transform.prototype.push = function (chunk, encoding) {
  this._transformState.needTransform = false;
  return Duplex.prototype.push.call(this, chunk, encoding);
};

// This is the part where you do stuff!
// override this function in implementation classes.
// 'chunk' is an input chunk.
//
// Call `push(newChunk)` to pass along transformed output
// to the readable side.  You may call 'push' zero or more times.
//
// Call `cb(err)` when you are done with this chunk.  If you pass
// an error, then that'll put the hurt on the whole operation.  If you
// never call cb(), then you'll never get another chunk.
Transform.prototype._transform = function (chunk, encoding, cb) {
  throw new Error('_transform() is not implemented');
};

Transform.prototype._write = function (chunk, encoding, cb) {
  var ts = this._transformState;
  ts.writecb = cb;
  ts.writechunk = chunk;
  ts.writeencoding = encoding;
  if (!ts.transforming) {
    var rs = this._readableState;
    if (ts.needTransform || rs.needReadable || rs.length < rs.highWaterMark) this._read(rs.highWaterMark);
  }
};

// Doesn't matter what the args are here.
// _transform does all the work.
// That we got here means that the readable side wants more data.
Transform.prototype._read = function (n) {
  var ts = this._transformState;

  if (ts.writechunk !== null && ts.writecb && !ts.transforming) {
    ts.transforming = true;
    this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
  } else {
    // mark that we need a transform, so that any data that comes in
    // will get processed, now that we've asked for it.
    ts.needTransform = true;
  }
};

Transform.prototype._destroy = function (err, cb) {
  var _this2 = this;

  Duplex.prototype._destroy.call(this, err, function (err2) {
    cb(err2);
    _this2.emit('close');
  });
};

function done(stream, er, data) {
  if (er) return stream.emit('error', er);

  if (data != null) // single equals check for both `null` and `undefined`
    stream.push(data);

  // if there's nothing in the write buffer, then that means
  // that nothing more will ever be provided
  if (stream._writableState.length) throw new Error('Calling transform done when ws.length != 0');

  if (stream._transformState.transforming) throw new Error('Calling transform done when still transforming');

  return stream.push(null);
}
},{"./_stream_duplex":68,"core-util-is":16,"inherits":21}],72:[function(require,module,exports){
(function (process,global,setImmediate){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// A bit simpler than readable streams.
// Implement an async ._write(chunk, encoding, cb), and it'll handle all
// the drain event emission and buffering.

'use strict';

/*<replacement>*/

var pna = require('process-nextick-args');
/*</replacement>*/

module.exports = Writable;

/* <replacement> */
function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
  this.next = null;
}

// It seems a linked list but it is not
// there will be only 2 of these for each stream
function CorkedRequest(state) {
  var _this = this;

  this.next = null;
  this.entry = null;
  this.finish = function () {
    onCorkedFinish(_this, state);
  };
}
/* </replacement> */

/*<replacement>*/
var asyncWrite = !process.browser && ['v0.10', 'v0.9.'].indexOf(process.version.slice(0, 5)) > -1 ? setImmediate : pna.nextTick;
/*</replacement>*/

/*<replacement>*/
var Duplex;
/*</replacement>*/

Writable.WritableState = WritableState;

/*<replacement>*/
var util = Object.create(require('core-util-is'));
util.inherits = require('inherits');
/*</replacement>*/

/*<replacement>*/
var internalUtil = {
  deprecate: require('util-deprecate')
};
/*</replacement>*/

/*<replacement>*/
var Stream = require('./internal/streams/stream');
/*</replacement>*/

/*<replacement>*/

var Buffer = require('safe-buffer').Buffer;
var OurUint8Array = global.Uint8Array || function () {};
function _uint8ArrayToBuffer(chunk) {
  return Buffer.from(chunk);
}
function _isUint8Array(obj) {
  return Buffer.isBuffer(obj) || obj instanceof OurUint8Array;
}

/*</replacement>*/

var destroyImpl = require('./internal/streams/destroy');

util.inherits(Writable, Stream);

function nop() {}

function WritableState(options, stream) {
  Duplex = Duplex || require('./_stream_duplex');

  options = options || {};

  // Duplex streams are both readable and writable, but share
  // the same options object.
  // However, some cases require setting options to different
  // values for the readable and the writable sides of the duplex stream.
  // These options can be provided separately as readableXXX and writableXXX.
  var isDuplex = stream instanceof Duplex;

  // object stream flag to indicate whether or not this stream
  // contains buffers or objects.
  this.objectMode = !!options.objectMode;

  if (isDuplex) this.objectMode = this.objectMode || !!options.writableObjectMode;

  // the point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write()
  var hwm = options.highWaterMark;
  var writableHwm = options.writableHighWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;

  if (hwm || hwm === 0) this.highWaterMark = hwm;else if (isDuplex && (writableHwm || writableHwm === 0)) this.highWaterMark = writableHwm;else this.highWaterMark = defaultHwm;

  // cast to ints.
  this.highWaterMark = Math.floor(this.highWaterMark);

  // if _final has been called
  this.finalCalled = false;

  // drain event flag.
  this.needDrain = false;
  // at the start of calling end()
  this.ending = false;
  // when end() has been called, and returned
  this.ended = false;
  // when 'finish' is emitted
  this.finished = false;

  // has it been destroyed
  this.destroyed = false;

  // should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.
  var noDecode = options.decodeStrings === false;
  this.decodeStrings = !noDecode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.
  this.length = 0;

  // a flag to see when we're in the middle of a write.
  this.writing = false;

  // when true all writes will be buffered until .uncork() call
  this.corked = 0;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // a flag to know if we're processing previously buffered items, which
  // may call the _write() callback in the same tick, so that we don't
  // end up in an overlapped onwrite situation.
  this.bufferProcessing = false;

  // the callback that's passed to _write(chunk,cb)
  this.onwrite = function (er) {
    onwrite(stream, er);
  };

  // the callback that the user supplies to write(chunk,encoding,cb)
  this.writecb = null;

  // the amount that is being written when _write is called.
  this.writelen = 0;

  this.bufferedRequest = null;
  this.lastBufferedRequest = null;

  // number of pending user-supplied write callbacks
  // this must be 0 before 'finish' can be emitted
  this.pendingcb = 0;

  // emit prefinish if the only thing we're waiting for is _write cbs
  // This is relevant for synchronous Transform streams
  this.prefinished = false;

  // True if the error was already emitted and should not be thrown again
  this.errorEmitted = false;

  // count buffered requests
  this.bufferedRequestCount = 0;

  // allocate the first CorkedRequest, there is always
  // one allocated and free to use, and we maintain at most two
  this.corkedRequestsFree = new CorkedRequest(this);
}

WritableState.prototype.getBuffer = function getBuffer() {
  var current = this.bufferedRequest;
  var out = [];
  while (current) {
    out.push(current);
    current = current.next;
  }
  return out;
};

(function () {
  try {
    Object.defineProperty(WritableState.prototype, 'buffer', {
      get: internalUtil.deprecate(function () {
        return this.getBuffer();
      }, '_writableState.buffer is deprecated. Use _writableState.getBuffer ' + 'instead.', 'DEP0003')
    });
  } catch (_) {}
})();

// Test _writableState for inheritance to account for Duplex streams,
// whose prototype chain only points to Readable.
var realHasInstance;
if (typeof Symbol === 'function' && Symbol.hasInstance && typeof Function.prototype[Symbol.hasInstance] === 'function') {
  realHasInstance = Function.prototype[Symbol.hasInstance];
  Object.defineProperty(Writable, Symbol.hasInstance, {
    value: function (object) {
      if (realHasInstance.call(this, object)) return true;
      if (this !== Writable) return false;

      return object && object._writableState instanceof WritableState;
    }
  });
} else {
  realHasInstance = function (object) {
    return object instanceof this;
  };
}

function Writable(options) {
  Duplex = Duplex || require('./_stream_duplex');

  // Writable ctor is applied to Duplexes, too.
  // `realHasInstance` is necessary because using plain `instanceof`
  // would return false, as no `_writableState` property is attached.

  // Trying to use the custom `instanceof` for Writable here will also break the
  // Node.js LazyTransform implementation, which has a non-trivial getter for
  // `_writableState` that would lead to infinite recursion.
  if (!realHasInstance.call(Writable, this) && !(this instanceof Duplex)) {
    return new Writable(options);
  }

  this._writableState = new WritableState(options, this);

  // legacy.
  this.writable = true;

  if (options) {
    if (typeof options.write === 'function') this._write = options.write;

    if (typeof options.writev === 'function') this._writev = options.writev;

    if (typeof options.destroy === 'function') this._destroy = options.destroy;

    if (typeof options.final === 'function') this._final = options.final;
  }

  Stream.call(this);
}

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function () {
  this.emit('error', new Error('Cannot pipe, not readable'));
};

function writeAfterEnd(stream, cb) {
  var er = new Error('write after end');
  // TODO: defer error events consistently everywhere, not just the cb
  stream.emit('error', er);
  pna.nextTick(cb, er);
}

// Checks that a user-supplied chunk is valid, especially for the particular
// mode the stream is in. Currently this means that `null` is never accepted
// and undefined/non-string values are only allowed in object mode.
function validChunk(stream, state, chunk, cb) {
  var valid = true;
  var er = false;

  if (chunk === null) {
    er = new TypeError('May not write null values to stream');
  } else if (typeof chunk !== 'string' && chunk !== undefined && !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  if (er) {
    stream.emit('error', er);
    pna.nextTick(cb, er);
    valid = false;
  }
  return valid;
}

Writable.prototype.write = function (chunk, encoding, cb) {
  var state = this._writableState;
  var ret = false;
  var isBuf = !state.objectMode && _isUint8Array(chunk);

  if (isBuf && !Buffer.isBuffer(chunk)) {
    chunk = _uint8ArrayToBuffer(chunk);
  }

  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (isBuf) encoding = 'buffer';else if (!encoding) encoding = state.defaultEncoding;

  if (typeof cb !== 'function') cb = nop;

  if (state.ended) writeAfterEnd(this, cb);else if (isBuf || validChunk(this, state, chunk, cb)) {
    state.pendingcb++;
    ret = writeOrBuffer(this, state, isBuf, chunk, encoding, cb);
  }

  return ret;
};

Writable.prototype.cork = function () {
  var state = this._writableState;

  state.corked++;
};

Writable.prototype.uncork = function () {
  var state = this._writableState;

  if (state.corked) {
    state.corked--;

    if (!state.writing && !state.corked && !state.finished && !state.bufferProcessing && state.bufferedRequest) clearBuffer(this, state);
  }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
  // node::ParseEncoding() requires lower case.
  if (typeof encoding === 'string') encoding = encoding.toLowerCase();
  if (!(['hex', 'utf8', 'utf-8', 'ascii', 'binary', 'base64', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'raw'].indexOf((encoding + '').toLowerCase()) > -1)) throw new TypeError('Unknown encoding: ' + encoding);
  this._writableState.defaultEncoding = encoding;
  return this;
};

function decodeChunk(state, chunk, encoding) {
  if (!state.objectMode && state.decodeStrings !== false && typeof chunk === 'string') {
    chunk = Buffer.from(chunk, encoding);
  }
  return chunk;
}

Object.defineProperty(Writable.prototype, 'writableHighWaterMark', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function () {
    return this._writableState.highWaterMark;
  }
});

// if we're already writing something, then just put this
// in the queue, and wait our turn.  Otherwise, call _write
// If we return false, then we need a drain event, so set that flag.
function writeOrBuffer(stream, state, isBuf, chunk, encoding, cb) {
  if (!isBuf) {
    var newChunk = decodeChunk(state, chunk, encoding);
    if (chunk !== newChunk) {
      isBuf = true;
      encoding = 'buffer';
      chunk = newChunk;
    }
  }
  var len = state.objectMode ? 1 : chunk.length;

  state.length += len;

  var ret = state.length < state.highWaterMark;
  // we must ensure that previous needDrain will not be reset to false.
  if (!ret) state.needDrain = true;

  if (state.writing || state.corked) {
    var last = state.lastBufferedRequest;
    state.lastBufferedRequest = {
      chunk: chunk,
      encoding: encoding,
      isBuf: isBuf,
      callback: cb,
      next: null
    };
    if (last) {
      last.next = state.lastBufferedRequest;
    } else {
      state.bufferedRequest = state.lastBufferedRequest;
    }
    state.bufferedRequestCount += 1;
  } else {
    doWrite(stream, state, false, len, chunk, encoding, cb);
  }

  return ret;
}

function doWrite(stream, state, writev, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (writev) stream._writev(chunk, state.onwrite);else stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, sync, er, cb) {
  --state.pendingcb;

  if (sync) {
    // defer the callback if we are being called synchronously
    // to avoid piling up things on the stack
    pna.nextTick(cb, er);
    // this can emit finish, and it will always happen
    // after error
    pna.nextTick(finishMaybe, stream, state);
    stream._writableState.errorEmitted = true;
    stream.emit('error', er);
  } else {
    // the caller expect this to happen before if
    // it is async
    cb(er);
    stream._writableState.errorEmitted = true;
    stream.emit('error', er);
    // this can emit finish, but finish must
    // always follow error
    finishMaybe(stream, state);
  }
}

function onwriteStateUpdate(state) {
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
}

function onwrite(stream, er) {
  var state = stream._writableState;
  var sync = state.sync;
  var cb = state.writecb;

  onwriteStateUpdate(state);

  if (er) onwriteError(stream, state, sync, er, cb);else {
    // Check if we're actually ready to finish, but don't emit yet
    var finished = needFinish(state);

    if (!finished && !state.corked && !state.bufferProcessing && state.bufferedRequest) {
      clearBuffer(stream, state);
    }

    if (sync) {
      /*<replacement>*/
      asyncWrite(afterWrite, stream, state, finished, cb);
      /*</replacement>*/
    } else {
      afterWrite(stream, state, finished, cb);
    }
  }
}

function afterWrite(stream, state, finished, cb) {
  if (!finished) onwriteDrain(stream, state);
  state.pendingcb--;
  cb();
  finishMaybe(stream, state);
}

// Must force callback to be called on nextTick, so that we don't
// emit 'drain' before the write() consumer gets the 'false' return
// value, and has a chance to attach a 'drain' listener.
function onwriteDrain(stream, state) {
  if (state.length === 0 && state.needDrain) {
    state.needDrain = false;
    stream.emit('drain');
  }
}

// if there's something in the buffer waiting, then process it
function clearBuffer(stream, state) {
  state.bufferProcessing = true;
  var entry = state.bufferedRequest;

  if (stream._writev && entry && entry.next) {
    // Fast case, write everything using _writev()
    var l = state.bufferedRequestCount;
    var buffer = new Array(l);
    var holder = state.corkedRequestsFree;
    holder.entry = entry;

    var count = 0;
    var allBuffers = true;
    while (entry) {
      buffer[count] = entry;
      if (!entry.isBuf) allBuffers = false;
      entry = entry.next;
      count += 1;
    }
    buffer.allBuffers = allBuffers;

    doWrite(stream, state, true, state.length, buffer, '', holder.finish);

    // doWrite is almost always async, defer these to save a bit of time
    // as the hot path ends with doWrite
    state.pendingcb++;
    state.lastBufferedRequest = null;
    if (holder.next) {
      state.corkedRequestsFree = holder.next;
      holder.next = null;
    } else {
      state.corkedRequestsFree = new CorkedRequest(state);
    }
    state.bufferedRequestCount = 0;
  } else {
    // Slow case, write chunks one-by-one
    while (entry) {
      var chunk = entry.chunk;
      var encoding = entry.encoding;
      var cb = entry.callback;
      var len = state.objectMode ? 1 : chunk.length;

      doWrite(stream, state, false, len, chunk, encoding, cb);
      entry = entry.next;
      state.bufferedRequestCount--;
      // if we didn't call the onwrite immediately, then
      // it means that we need to wait until it does.
      // also, that means that the chunk and cb are currently
      // being processed, so move the buffer counter past them.
      if (state.writing) {
        break;
      }
    }

    if (entry === null) state.lastBufferedRequest = null;
  }

  state.bufferedRequest = entry;
  state.bufferProcessing = false;
}

Writable.prototype._write = function (chunk, encoding, cb) {
  cb(new Error('_write() is not implemented'));
};

Writable.prototype._writev = null;

Writable.prototype.end = function (chunk, encoding, cb) {
  var state = this._writableState;

  if (typeof chunk === 'function') {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);

  // .end() fully uncorks
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }

  // ignore unnecessary end() calls.
  if (!state.ending && !state.finished) endWritable(this, state, cb);
};

function needFinish(state) {
  return state.ending && state.length === 0 && state.bufferedRequest === null && !state.finished && !state.writing;
}
function callFinal(stream, state) {
  stream._final(function (err) {
    state.pendingcb--;
    if (err) {
      stream.emit('error', err);
    }
    state.prefinished = true;
    stream.emit('prefinish');
    finishMaybe(stream, state);
  });
}
function prefinish(stream, state) {
  if (!state.prefinished && !state.finalCalled) {
    if (typeof stream._final === 'function') {
      state.pendingcb++;
      state.finalCalled = true;
      pna.nextTick(callFinal, stream, state);
    } else {
      state.prefinished = true;
      stream.emit('prefinish');
    }
  }
}

function finishMaybe(stream, state) {
  var need = needFinish(state);
  if (need) {
    prefinish(stream, state);
    if (state.pendingcb === 0) {
      state.finished = true;
      stream.emit('finish');
    }
  }
  return need;
}

function endWritable(stream, state, cb) {
  state.ending = true;
  finishMaybe(stream, state);
  if (cb) {
    if (state.finished) pna.nextTick(cb);else stream.once('finish', cb);
  }
  state.ended = true;
  stream.writable = false;
}

function onCorkedFinish(corkReq, state, err) {
  var entry = corkReq.entry;
  corkReq.entry = null;
  while (entry) {
    var cb = entry.callback;
    state.pendingcb--;
    cb(err);
    entry = entry.next;
  }
  if (state.corkedRequestsFree) {
    state.corkedRequestsFree.next = corkReq;
  } else {
    state.corkedRequestsFree = corkReq;
  }
}

Object.defineProperty(Writable.prototype, 'destroyed', {
  get: function () {
    if (this._writableState === undefined) {
      return false;
    }
    return this._writableState.destroyed;
  },
  set: function (value) {
    // we ignore the value if the stream
    // has not been initialized yet
    if (!this._writableState) {
      return;
    }

    // backward compatibility, the user is explicitly
    // managing destroyed
    this._writableState.destroyed = value;
  }
});

Writable.prototype.destroy = destroyImpl.destroy;
Writable.prototype._undestroy = destroyImpl.undestroy;
Writable.prototype._destroy = function (err, cb) {
  this.end();
  cb(err);
};
}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("timers").setImmediate)
},{"./_stream_duplex":68,"./internal/streams/destroy":74,"./internal/streams/stream":75,"_process":63,"core-util-is":16,"inherits":21,"process-nextick-args":62,"safe-buffer":76,"timers":105,"util-deprecate":108}],73:[function(require,module,exports){
'use strict';

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var Buffer = require('safe-buffer').Buffer;
var util = require('util');

function copyBuffer(src, target, offset) {
  src.copy(target, offset);
}

module.exports = function () {
  function BufferList() {
    _classCallCheck(this, BufferList);

    this.head = null;
    this.tail = null;
    this.length = 0;
  }

  BufferList.prototype.push = function push(v) {
    var entry = { data: v, next: null };
    if (this.length > 0) this.tail.next = entry;else this.head = entry;
    this.tail = entry;
    ++this.length;
  };

  BufferList.prototype.unshift = function unshift(v) {
    var entry = { data: v, next: this.head };
    if (this.length === 0) this.tail = entry;
    this.head = entry;
    ++this.length;
  };

  BufferList.prototype.shift = function shift() {
    if (this.length === 0) return;
    var ret = this.head.data;
    if (this.length === 1) this.head = this.tail = null;else this.head = this.head.next;
    --this.length;
    return ret;
  };

  BufferList.prototype.clear = function clear() {
    this.head = this.tail = null;
    this.length = 0;
  };

  BufferList.prototype.join = function join(s) {
    if (this.length === 0) return '';
    var p = this.head;
    var ret = '' + p.data;
    while (p = p.next) {
      ret += s + p.data;
    }return ret;
  };

  BufferList.prototype.concat = function concat(n) {
    if (this.length === 0) return Buffer.alloc(0);
    if (this.length === 1) return this.head.data;
    var ret = Buffer.allocUnsafe(n >>> 0);
    var p = this.head;
    var i = 0;
    while (p) {
      copyBuffer(p.data, ret, i);
      i += p.data.length;
      p = p.next;
    }
    return ret;
  };

  return BufferList;
}();

if (util && util.inspect && util.inspect.custom) {
  module.exports.prototype[util.inspect.custom] = function () {
    var obj = util.inspect({ length: this.length });
    return this.constructor.name + ' ' + obj;
  };
}
},{"safe-buffer":76,"util":11}],74:[function(require,module,exports){
'use strict';

/*<replacement>*/

var pna = require('process-nextick-args');
/*</replacement>*/

// undocumented cb() API, needed for core, not for public API
function destroy(err, cb) {
  var _this = this;

  var readableDestroyed = this._readableState && this._readableState.destroyed;
  var writableDestroyed = this._writableState && this._writableState.destroyed;

  if (readableDestroyed || writableDestroyed) {
    if (cb) {
      cb(err);
    } else if (err && (!this._writableState || !this._writableState.errorEmitted)) {
      pna.nextTick(emitErrorNT, this, err);
    }
    return this;
  }

  // we set destroyed to true before firing error callbacks in order
  // to make it re-entrance safe in case destroy() is called within callbacks

  if (this._readableState) {
    this._readableState.destroyed = true;
  }

  // if this is a duplex stream mark the writable part as destroyed as well
  if (this._writableState) {
    this._writableState.destroyed = true;
  }

  this._destroy(err || null, function (err) {
    if (!cb && err) {
      pna.nextTick(emitErrorNT, _this, err);
      if (_this._writableState) {
        _this._writableState.errorEmitted = true;
      }
    } else if (cb) {
      cb(err);
    }
  });

  return this;
}

function undestroy() {
  if (this._readableState) {
    this._readableState.destroyed = false;
    this._readableState.reading = false;
    this._readableState.ended = false;
    this._readableState.endEmitted = false;
  }

  if (this._writableState) {
    this._writableState.destroyed = false;
    this._writableState.ended = false;
    this._writableState.ending = false;
    this._writableState.finished = false;
    this._writableState.errorEmitted = false;
  }
}

function emitErrorNT(self, err) {
  self.emit('error', err);
}

module.exports = {
  destroy: destroy,
  undestroy: undestroy
};
},{"process-nextick-args":62}],75:[function(require,module,exports){
module.exports = require('events').EventEmitter;

},{"events":19}],76:[function(require,module,exports){
/* eslint-disable node/no-deprecated-api */
var buffer = require('buffer')
var Buffer = buffer.Buffer

// alternative to using Object.keys for old browsers
function copyProps (src, dst) {
  for (var key in src) {
    dst[key] = src[key]
  }
}
if (Buffer.from && Buffer.alloc && Buffer.allocUnsafe && Buffer.allocUnsafeSlow) {
  module.exports = buffer
} else {
  // Copy properties from require('buffer')
  copyProps(buffer, exports)
  exports.Buffer = SafeBuffer
}

function SafeBuffer (arg, encodingOrOffset, length) {
  return Buffer(arg, encodingOrOffset, length)
}

// Copy static methods from Buffer
copyProps(Buffer, SafeBuffer)

SafeBuffer.from = function (arg, encodingOrOffset, length) {
  if (typeof arg === 'number') {
    throw new TypeError('Argument must not be a number')
  }
  return Buffer(arg, encodingOrOffset, length)
}

SafeBuffer.alloc = function (size, fill, encoding) {
  if (typeof size !== 'number') {
    throw new TypeError('Argument must be a number')
  }
  var buf = Buffer(size)
  if (fill !== undefined) {
    if (typeof encoding === 'string') {
      buf.fill(fill, encoding)
    } else {
      buf.fill(fill)
    }
  } else {
    buf.fill(0)
  }
  return buf
}

SafeBuffer.allocUnsafe = function (size) {
  if (typeof size !== 'number') {
    throw new TypeError('Argument must be a number')
  }
  return Buffer(size)
}

SafeBuffer.allocUnsafeSlow = function (size) {
  if (typeof size !== 'number') {
    throw new TypeError('Argument must be a number')
  }
  return buffer.SlowBuffer(size)
}

},{"buffer":14}],77:[function(require,module,exports){
module.exports = require('./readable').PassThrough

},{"./readable":78}],78:[function(require,module,exports){
exports = module.exports = require('./lib/_stream_readable.js');
exports.Stream = exports;
exports.Readable = exports;
exports.Writable = require('./lib/_stream_writable.js');
exports.Duplex = require('./lib/_stream_duplex.js');
exports.Transform = require('./lib/_stream_transform.js');
exports.PassThrough = require('./lib/_stream_passthrough.js');

},{"./lib/_stream_duplex.js":68,"./lib/_stream_passthrough.js":69,"./lib/_stream_readable.js":70,"./lib/_stream_transform.js":71,"./lib/_stream_writable.js":72}],79:[function(require,module,exports){
module.exports = require('./readable').Transform

},{"./readable":78}],80:[function(require,module,exports){
module.exports = require('./lib/_stream_writable.js');

},{"./lib/_stream_writable.js":72}],81:[function(require,module,exports){
"use strict";
function __export(m) {
    for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
}
Object.defineProperty(exports, "__esModule", { value: true });
__export(require("./lib/Resolve"));

},{"./lib/Resolve":82}],82:[function(require,module,exports){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Convert the given relative IRI to an absolute IRI
 * by taking into account the given optional baseIRI.
 *
 * @param {string} relativeIRI The relative IRI to convert to an absolute IRI.
 * @param {string} baseIRI The optional base IRI.
 * @return {string} an absolute IRI.
 */
function resolve(relativeIRI, baseIRI) {
    baseIRI = baseIRI || '';
    const baseFragmentPos = baseIRI.indexOf('#');
    // Ignore any fragments in the base IRI
    if (baseFragmentPos > 0) {
        baseIRI = baseIRI.substr(0, baseFragmentPos);
    }
    // Convert empty value directly to base IRI
    if (!relativeIRI.length) {
        return baseIRI;
    }
    // If the value starts with a query character, concat directly (but strip the existing query)
    if (relativeIRI.startsWith('?')) {
        const baseQueryPos = baseIRI.indexOf('?');
        if (baseQueryPos > 0) {
            baseIRI = baseIRI.substr(0, baseQueryPos);
        }
        return baseIRI + relativeIRI;
    }
    // If the value starts with a fragment character, concat directly
    if (relativeIRI.startsWith('#')) {
        return baseIRI + relativeIRI;
    }
    // Ignore baseIRI if it is empty
    if (!baseIRI.length) {
        return removeDotSegmentsOfPath(relativeIRI, relativeIRI.indexOf(':'));
    }
    // Ignore baseIRI if the value is absolute
    const valueColonPos = relativeIRI.indexOf(':');
    if (valueColonPos >= 0) {
        return removeDotSegmentsOfPath(relativeIRI, valueColonPos);
    }
    // At this point, the baseIRI MUST be absolute, otherwise we error
    const baseColonPos = baseIRI.indexOf(':');
    if (baseColonPos < 0) {
        throw new Error(`Found invalid baseIRI '${baseIRI}' for value '${relativeIRI}'`);
    }
    const baseIRIScheme = baseIRI.substr(0, baseColonPos + 1);
    // Inherit the baseIRI scheme if the value starts with '//'
    if (relativeIRI.indexOf('//') === 0) {
        return baseIRIScheme + removeDotSegmentsOfPath(relativeIRI, valueColonPos);
    }
    // Check cases where '://' occurs in the baseIRI, and where there is no '/' after a ':' anymore.
    let baseSlashAfterColonPos;
    if (baseIRI.indexOf('//', baseColonPos) === baseColonPos + 1) {
        // If there is no additional '/' after the '//'.
        baseSlashAfterColonPos = baseIRI.indexOf('/', baseColonPos + 3);
        if (baseSlashAfterColonPos < 0) {
            // If something other than a '/' follows the '://', append the value after a '/',
            // otherwise, prefix the value with only the baseIRI scheme.
            if (baseIRI.length > baseColonPos + 3) {
                return baseIRI + '/' + removeDotSegmentsOfPath(relativeIRI, valueColonPos);
            }
            else {
                return baseIRIScheme + removeDotSegmentsOfPath(relativeIRI, valueColonPos);
            }
        }
    }
    else {
        // If there is not even a single '/' after the ':'
        baseSlashAfterColonPos = baseIRI.indexOf('/', baseColonPos + 1);
        if (baseSlashAfterColonPos < 0) {
            // If we don't have a '/' after the ':',
            // prefix the value with only the baseIRI scheme.
            return baseIRIScheme + removeDotSegmentsOfPath(relativeIRI, valueColonPos);
        }
    }
    // If the value starts with a '/', then prefix it with everything before the first effective slash of the base IRI.
    if (relativeIRI.indexOf('/') === 0) {
        return baseIRI.substr(0, baseSlashAfterColonPos) + removeDotSegments(relativeIRI);
    }
    let baseIRIPath = baseIRI.substr(baseSlashAfterColonPos);
    const baseIRILastSlashPos = baseIRIPath.lastIndexOf('/');
    // Ignore everything after the last '/' in the baseIRI path
    if (baseIRILastSlashPos >= 0 && baseIRILastSlashPos < baseIRIPath.length - 1) {
        baseIRIPath = baseIRIPath.substr(0, baseIRILastSlashPos + 1);
        // Also remove the first character of the relative path if it starts with '.' (and not '..' or './')
        // This change is only allowed if there is something else following the path
        if (relativeIRI[0] === '.' && relativeIRI[1] !== '.' && relativeIRI[1] !== '/' && relativeIRI[2]) {
            relativeIRI = relativeIRI.substr(1);
        }
    }
    // Prefix the value with the baseIRI path where
    relativeIRI = baseIRIPath + relativeIRI;
    // Remove dot segment from the IRI
    relativeIRI = removeDotSegments(relativeIRI);
    // Prefix our transformed value with the part of the baseIRI until the first '/' after the first ':'.
    return baseIRI.substr(0, baseSlashAfterColonPos) + relativeIRI;
}
exports.resolve = resolve;
/**
 * Remove dot segments from the given path,
 * as described in https://www.ietf.org/rfc/rfc3986.txt (page 32).
 * @param {string} path An IRI path.
 * @return {string} A path, will always start with a '/'.
 */
function removeDotSegments(path) {
    // Prepare a buffer with segments between each '/.
    // Each segment represents an array of characters.
    const segmentBuffers = [];
    let i = 0;
    while (i < path.length) {
        // Remove '/.' or '/..'
        switch (path[i]) {
            case '/':
                if (path[i + 1] === '.') {
                    if (path[i + 2] === '.') {
                        // Start a new segment if we find an invalid character after the '.'
                        if (!isCharacterAllowedAfterRelativePathSegment(path[i + 3])) {
                            segmentBuffers.push([]);
                            i++;
                            break;
                        }
                        // Go to parent directory,
                        // so we remove a parent segment
                        segmentBuffers.pop();
                        // Ensure that we end with a slash if there is a trailing '/..'
                        if (!path[i + 3]) {
                            segmentBuffers.push([]);
                        }
                        i += 3;
                    }
                    else {
                        // Start a new segment if we find an invalid character after the '.'
                        if (!isCharacterAllowedAfterRelativePathSegment(path[i + 2])) {
                            segmentBuffers.push([]);
                            i++;
                            break;
                        }
                        // Ensure that we end with a slash if there is a trailing '/.'
                        if (!path[i + 2]) {
                            segmentBuffers.push([]);
                        }
                        // Go to the current directory,
                        // so we do nothing
                        i += 2;
                    }
                }
                else {
                    // Start a new segment
                    segmentBuffers.push([]);
                    i++;
                }
                break;
            case '#':
            case '?':
                // Query and fragment string should be appended unchanged
                if (!segmentBuffers.length) {
                    segmentBuffers.push([]);
                }
                segmentBuffers[segmentBuffers.length - 1].push(path.substr(i));
                // Break the while loop
                i = path.length;
                break;
            default:
                // Not a special character, just append it to our buffer
                if (!segmentBuffers.length) {
                    segmentBuffers.push([]);
                }
                segmentBuffers[segmentBuffers.length - 1].push(path[i]);
                i++;
                break;
        }
    }
    return '/' + segmentBuffers.map((buffer) => buffer.join('')).join('/');
}
exports.removeDotSegments = removeDotSegments;
/**
 * Removes dot segments of the given IRI.
 * @param {string} iri An IRI (or part of IRI).
 * @param {number} colonPosition The position of the first ':' in the IRI.
 * @return {string} The IRI where dot segments were removed.
 */
function removeDotSegmentsOfPath(iri, colonPosition) {
    // Determine where we should start looking for the first '/' that indicates the start of the path
    let searchOffset = colonPosition + 1;
    if (colonPosition >= 0) {
        if (iri[colonPosition + 1] === '/' && iri[colonPosition + 2] === '/') {
            searchOffset = colonPosition + 3;
        }
    }
    else {
        if (iri[0] === '/' && iri[1] === '/') {
            searchOffset = 2;
        }
    }
    // Determine the path
    const pathSeparator = iri.indexOf('/', searchOffset);
    if (pathSeparator < 0) {
        return iri;
    }
    const base = iri.substr(0, pathSeparator);
    const path = iri.substr(pathSeparator);
    // Remove dot segments from the path
    return base + removeDotSegments(path);
}
exports.removeDotSegmentsOfPath = removeDotSegmentsOfPath;
function isCharacterAllowedAfterRelativePathSegment(character) {
    return !character || character === '#' || character === '?' || character === '/';
}

},{}],83:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

module.exports = Stream;

var EE = require('events').EventEmitter;
var inherits = require('inherits');

inherits(Stream, EE);
Stream.Readable = require('readable-stream/readable.js');
Stream.Writable = require('readable-stream/writable.js');
Stream.Duplex = require('readable-stream/duplex.js');
Stream.Transform = require('readable-stream/transform.js');
Stream.PassThrough = require('readable-stream/passthrough.js');

// Backwards-compat with node 0.4.x
Stream.Stream = Stream;



// old-style streams.  Note that the pipe method (the only relevant
// part of this class) is overridden in the Readable class.

function Stream() {
  EE.call(this);
}

Stream.prototype.pipe = function(dest, options) {
  var source = this;

  function ondata(chunk) {
    if (dest.writable) {
      if (false === dest.write(chunk) && source.pause) {
        source.pause();
      }
    }
  }

  source.on('data', ondata);

  function ondrain() {
    if (source.readable && source.resume) {
      source.resume();
    }
  }

  dest.on('drain', ondrain);

  // If the 'end' option is not supplied, dest.end() will be called when
  // source gets the 'end' or 'close' events.  Only dest.end() once.
  if (!dest._isStdio && (!options || options.end !== false)) {
    source.on('end', onend);
    source.on('close', onclose);
  }

  var didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;

    dest.end();
  }


  function onclose() {
    if (didOnEnd) return;
    didOnEnd = true;

    if (typeof dest.destroy === 'function') dest.destroy();
  }

  // don't leave dangling pipes when there are errors.
  function onerror(er) {
    cleanup();
    if (EE.listenerCount(this, 'error') === 0) {
      throw er; // Unhandled stream error in pipe.
    }
  }

  source.on('error', onerror);
  dest.on('error', onerror);

  // remove all the event listeners that were added.
  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);

    source.removeListener('end', onend);
    source.removeListener('close', onclose);

    source.removeListener('error', onerror);
    dest.removeListener('error', onerror);

    source.removeListener('end', cleanup);
    source.removeListener('close', cleanup);

    dest.removeListener('close', cleanup);
  }

  source.on('end', cleanup);
  source.on('close', cleanup);

  dest.on('close', cleanup);

  dest.emit('pipe', source);

  // Allow for unix-like usage: A.pipe(B).pipe(C)
  return dest;
};

},{"events":19,"inherits":21,"readable-stream/duplex.js":67,"readable-stream/passthrough.js":77,"readable-stream/readable.js":78,"readable-stream/transform.js":79,"readable-stream/writable.js":80}],84:[function(require,module,exports){
(function (global){
var ClientRequest = require('./lib/request')
var response = require('./lib/response')
var extend = require('xtend')
var statusCodes = require('builtin-status-codes')
var url = require('url')

var http = exports

http.request = function (opts, cb) {
	if (typeof opts === 'string')
		opts = url.parse(opts)
	else
		opts = extend(opts)

	// Normally, the page is loaded from http or https, so not specifying a protocol
	// will result in a (valid) protocol-relative url. However, this won't work if
	// the protocol is something else, like 'file:'
	var defaultProtocol = global.location.protocol.search(/^https?:$/) === -1 ? 'http:' : ''

	var protocol = opts.protocol || defaultProtocol
	var host = opts.hostname || opts.host
	var port = opts.port
	var path = opts.path || '/'

	// Necessary for IPv6 addresses
	if (host && host.indexOf(':') !== -1)
		host = '[' + host + ']'

	// This may be a relative url. The browser should always be able to interpret it correctly.
	opts.url = (host ? (protocol + '//' + host) : '') + (port ? ':' + port : '') + path
	opts.method = (opts.method || 'GET').toUpperCase()
	opts.headers = opts.headers || {}

	// Also valid opts.auth, opts.mode

	var req = new ClientRequest(opts)
	if (cb)
		req.on('response', cb)
	return req
}

http.get = function get (opts, cb) {
	var req = http.request(opts, cb)
	req.end()
	return req
}

http.ClientRequest = ClientRequest
http.IncomingMessage = response.IncomingMessage

http.Agent = function () {}
http.Agent.defaultMaxSockets = 4

http.globalAgent = new http.Agent()

http.STATUS_CODES = statusCodes

http.METHODS = [
	'CHECKOUT',
	'CONNECT',
	'COPY',
	'DELETE',
	'GET',
	'HEAD',
	'LOCK',
	'M-SEARCH',
	'MERGE',
	'MKACTIVITY',
	'MKCOL',
	'MOVE',
	'NOTIFY',
	'OPTIONS',
	'PATCH',
	'POST',
	'PROPFIND',
	'PROPPATCH',
	'PURGE',
	'PUT',
	'REPORT',
	'SEARCH',
	'SUBSCRIBE',
	'TRACE',
	'UNLOCK',
	'UNSUBSCRIBE'
]
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./lib/request":86,"./lib/response":87,"builtin-status-codes":15,"url":106,"xtend":110}],85:[function(require,module,exports){
(function (global){
exports.fetch = isFunction(global.fetch) && isFunction(global.ReadableStream)

exports.writableStream = isFunction(global.WritableStream)

exports.abortController = isFunction(global.AbortController)

// The xhr request to example.com may violate some restrictive CSP configurations,
// so if we're running in a browser that supports `fetch`, avoid calling getXHR()
// and assume support for certain features below.
var xhr
function getXHR () {
	// Cache the xhr value
	if (xhr !== undefined) return xhr

	if (global.XMLHttpRequest) {
		xhr = new global.XMLHttpRequest()
		// If XDomainRequest is available (ie only, where xhr might not work
		// cross domain), use the page location. Otherwise use example.com
		// Note: this doesn't actually make an http request.
		try {
			xhr.open('GET', global.XDomainRequest ? '/' : 'https://example.com')
		} catch(e) {
			xhr = null
		}
	} else {
		// Service workers don't have XHR
		xhr = null
	}
	return xhr
}

function checkTypeSupport (type) {
	var xhr = getXHR()
	if (!xhr) return false
	try {
		xhr.responseType = type
		return xhr.responseType === type
	} catch (e) {}
	return false
}

// If fetch is supported, then arraybuffer will be supported too. Skip calling
// checkTypeSupport(), since that calls getXHR().
exports.arraybuffer = exports.fetch || checkTypeSupport('arraybuffer')

// These next two tests unavoidably show warnings in Chrome. Since fetch will always
// be used if it's available, just return false for these to avoid the warnings.
exports.msstream = !exports.fetch && checkTypeSupport('ms-stream')
exports.mozchunkedarraybuffer = !exports.fetch && checkTypeSupport('moz-chunked-arraybuffer')

// If fetch is supported, then overrideMimeType will be supported too. Skip calling
// getXHR().
exports.overrideMimeType = exports.fetch || (getXHR() ? isFunction(getXHR().overrideMimeType) : false)

function isFunction (value) {
	return typeof value === 'function'
}

xhr = null // Help gc

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],86:[function(require,module,exports){
(function (process,global,Buffer){
var capability = require('./capability')
var inherits = require('inherits')
var response = require('./response')
var stream = require('readable-stream')

var IncomingMessage = response.IncomingMessage
var rStates = response.readyStates

function decideMode (preferBinary, useFetch) {
	if (capability.fetch && useFetch) {
		return 'fetch'
	} else if (capability.mozchunkedarraybuffer) {
		return 'moz-chunked-arraybuffer'
	} else if (capability.msstream) {
		return 'ms-stream'
	} else if (capability.arraybuffer && preferBinary) {
		return 'arraybuffer'
	} else {
		return 'text'
	}
}

var ClientRequest = module.exports = function (opts) {
	var self = this
	stream.Writable.call(self)

	self._opts = opts
	self._body = []
	self._headers = {}
	if (opts.auth)
		self.setHeader('Authorization', 'Basic ' + Buffer.from(opts.auth).toString('base64'))
	Object.keys(opts.headers).forEach(function (name) {
		self.setHeader(name, opts.headers[name])
	})

	var preferBinary
	var useFetch = true
	if (opts.mode === 'disable-fetch' || ('requestTimeout' in opts && !capability.abortController)) {
		// If the use of XHR should be preferred. Not typically needed.
		useFetch = false
		preferBinary = true
	} else if (opts.mode === 'prefer-streaming') {
		// If streaming is a high priority but binary compatibility and
		// the accuracy of the 'content-type' header aren't
		preferBinary = false
	} else if (opts.mode === 'allow-wrong-content-type') {
		// If streaming is more important than preserving the 'content-type' header
		preferBinary = !capability.overrideMimeType
	} else if (!opts.mode || opts.mode === 'default' || opts.mode === 'prefer-fast') {
		// Use binary if text streaming may corrupt data or the content-type header, or for speed
		preferBinary = true
	} else {
		throw new Error('Invalid value for opts.mode')
	}
	self._mode = decideMode(preferBinary, useFetch)
	self._fetchTimer = null

	self.on('finish', function () {
		self._onFinish()
	})
}

inherits(ClientRequest, stream.Writable)

ClientRequest.prototype.setHeader = function (name, value) {
	var self = this
	var lowerName = name.toLowerCase()
	// This check is not necessary, but it prevents warnings from browsers about setting unsafe
	// headers. To be honest I'm not entirely sure hiding these warnings is a good thing, but
	// http-browserify did it, so I will too.
	if (unsafeHeaders.indexOf(lowerName) !== -1)
		return

	self._headers[lowerName] = {
		name: name,
		value: value
	}
}

ClientRequest.prototype.getHeader = function (name) {
	var header = this._headers[name.toLowerCase()]
	if (header)
		return header.value
	return null
}

ClientRequest.prototype.removeHeader = function (name) {
	var self = this
	delete self._headers[name.toLowerCase()]
}

ClientRequest.prototype._onFinish = function () {
	var self = this

	if (self._destroyed)
		return
	var opts = self._opts

	var headersObj = self._headers
	var body = null
	if (opts.method !== 'GET' && opts.method !== 'HEAD') {
        body = new Blob(self._body, {
            type: (headersObj['content-type'] || {}).value || ''
        });
    }

	// create flattened list of headers
	var headersList = []
	Object.keys(headersObj).forEach(function (keyName) {
		var name = headersObj[keyName].name
		var value = headersObj[keyName].value
		if (Array.isArray(value)) {
			value.forEach(function (v) {
				headersList.push([name, v])
			})
		} else {
			headersList.push([name, value])
		}
	})

	if (self._mode === 'fetch') {
		var signal = null
		var fetchTimer = null
		if (capability.abortController) {
			var controller = new AbortController()
			signal = controller.signal
			self._fetchAbortController = controller

			if ('requestTimeout' in opts && opts.requestTimeout !== 0) {
				self._fetchTimer = global.setTimeout(function () {
					self.emit('requestTimeout')
					if (self._fetchAbortController)
						self._fetchAbortController.abort()
				}, opts.requestTimeout)
			}
		}

		global.fetch(self._opts.url, {
			method: self._opts.method,
			headers: headersList,
			body: body || undefined,
			mode: 'cors',
			credentials: opts.withCredentials ? 'include' : 'same-origin',
			signal: signal
		}).then(function (response) {
			self._fetchResponse = response
			self._connect()
		}, function (reason) {
			global.clearTimeout(self._fetchTimer)
			if (!self._destroyed)
				self.emit('error', reason)
		})
	} else {
		var xhr = self._xhr = new global.XMLHttpRequest()
		try {
			xhr.open(self._opts.method, self._opts.url, true)
		} catch (err) {
			process.nextTick(function () {
				self.emit('error', err)
			})
			return
		}

		// Can't set responseType on really old browsers
		if ('responseType' in xhr)
			xhr.responseType = self._mode

		if ('withCredentials' in xhr)
			xhr.withCredentials = !!opts.withCredentials

		if (self._mode === 'text' && 'overrideMimeType' in xhr)
			xhr.overrideMimeType('text/plain; charset=x-user-defined')

		if ('requestTimeout' in opts) {
			xhr.timeout = opts.requestTimeout
			xhr.ontimeout = function () {
				self.emit('requestTimeout')
			}
		}

		headersList.forEach(function (header) {
			xhr.setRequestHeader(header[0], header[1])
		})

		self._response = null
		xhr.onreadystatechange = function () {
			switch (xhr.readyState) {
				case rStates.LOADING:
				case rStates.DONE:
					self._onXHRProgress()
					break
			}
		}
		// Necessary for streaming in Firefox, since xhr.response is ONLY defined
		// in onprogress, not in onreadystatechange with xhr.readyState = 3
		if (self._mode === 'moz-chunked-arraybuffer') {
			xhr.onprogress = function () {
				self._onXHRProgress()
			}
		}

		xhr.onerror = function () {
			if (self._destroyed)
				return
			self.emit('error', new Error('XHR error'))
		}

		try {
			xhr.send(body)
		} catch (err) {
			process.nextTick(function () {
				self.emit('error', err)
			})
			return
		}
	}
}

/**
 * Checks if xhr.status is readable and non-zero, indicating no error.
 * Even though the spec says it should be available in readyState 3,
 * accessing it throws an exception in IE8
 */
function statusValid (xhr) {
	try {
		var status = xhr.status
		return (status !== null && status !== 0)
	} catch (e) {
		return false
	}
}

ClientRequest.prototype._onXHRProgress = function () {
	var self = this

	if (!statusValid(self._xhr) || self._destroyed)
		return

	if (!self._response)
		self._connect()

	self._response._onXHRProgress()
}

ClientRequest.prototype._connect = function () {
	var self = this

	if (self._destroyed)
		return

	self._response = new IncomingMessage(self._xhr, self._fetchResponse, self._mode, self._fetchTimer)
	self._response.on('error', function(err) {
		self.emit('error', err)
	})

	self.emit('response', self._response)
}

ClientRequest.prototype._write = function (chunk, encoding, cb) {
	var self = this

	self._body.push(chunk)
	cb()
}

ClientRequest.prototype.abort = ClientRequest.prototype.destroy = function () {
	var self = this
	self._destroyed = true
	global.clearTimeout(self._fetchTimer)
	if (self._response)
		self._response._destroyed = true
	if (self._xhr)
		self._xhr.abort()
	else if (self._fetchAbortController)
		self._fetchAbortController.abort()
}

ClientRequest.prototype.end = function (data, encoding, cb) {
	var self = this
	if (typeof data === 'function') {
		cb = data
		data = undefined
	}

	stream.Writable.prototype.end.call(self, data, encoding, cb)
}

ClientRequest.prototype.flushHeaders = function () {}
ClientRequest.prototype.setTimeout = function () {}
ClientRequest.prototype.setNoDelay = function () {}
ClientRequest.prototype.setSocketKeepAlive = function () {}

// Taken from http://www.w3.org/TR/XMLHttpRequest/#the-setrequestheader%28%29-method
var unsafeHeaders = [
	'accept-charset',
	'accept-encoding',
	'access-control-request-headers',
	'access-control-request-method',
	'connection',
	'content-length',
	'cookie',
	'cookie2',
	'date',
	'dnt',
	'expect',
	'host',
	'keep-alive',
	'origin',
	'referer',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'via'
]

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("buffer").Buffer)
},{"./capability":85,"./response":87,"_process":63,"buffer":14,"inherits":21,"readable-stream":102}],87:[function(require,module,exports){
(function (process,global,Buffer){
var capability = require('./capability')
var inherits = require('inherits')
var stream = require('readable-stream')

var rStates = exports.readyStates = {
	UNSENT: 0,
	OPENED: 1,
	HEADERS_RECEIVED: 2,
	LOADING: 3,
	DONE: 4
}

var IncomingMessage = exports.IncomingMessage = function (xhr, response, mode, fetchTimer) {
	var self = this
	stream.Readable.call(self)

	self._mode = mode
	self.headers = {}
	self.rawHeaders = []
	self.trailers = {}
	self.rawTrailers = []

	// Fake the 'close' event, but only once 'end' fires
	self.on('end', function () {
		// The nextTick is necessary to prevent the 'request' module from causing an infinite loop
		process.nextTick(function () {
			self.emit('close')
		})
	})

	if (mode === 'fetch') {
		self._fetchResponse = response

		self.url = response.url
		self.statusCode = response.status
		self.statusMessage = response.statusText
		
		response.headers.forEach(function (header, key){
			self.headers[key.toLowerCase()] = header
			self.rawHeaders.push(key, header)
		})

		if (capability.writableStream) {
			var writable = new WritableStream({
				write: function (chunk) {
					return new Promise(function (resolve, reject) {
						if (self._destroyed) {
							reject()
						} else if(self.push(Buffer.from(chunk))) {
							resolve()
						} else {
							self._resumeFetch = resolve
						}
					})
				},
				close: function () {
					global.clearTimeout(fetchTimer)
					if (!self._destroyed)
						self.push(null)
				},
				abort: function (err) {
					if (!self._destroyed)
						self.emit('error', err)
				}
			})

			try {
				response.body.pipeTo(writable).catch(function (err) {
					global.clearTimeout(fetchTimer)
					if (!self._destroyed)
						self.emit('error', err)
				})
				return
			} catch (e) {} // pipeTo method isn't defined. Can't find a better way to feature test this
		}
		// fallback for when writableStream or pipeTo aren't available
		var reader = response.body.getReader()
		function read () {
			reader.read().then(function (result) {
				if (self._destroyed)
					return
				if (result.done) {
					global.clearTimeout(fetchTimer)
					self.push(null)
					return
				}
				self.push(Buffer.from(result.value))
				read()
			}).catch(function (err) {
				global.clearTimeout(fetchTimer)
				if (!self._destroyed)
					self.emit('error', err)
			})
		}
		read()
	} else {
		self._xhr = xhr
		self._pos = 0

		self.url = xhr.responseURL
		self.statusCode = xhr.status
		self.statusMessage = xhr.statusText
		var headers = xhr.getAllResponseHeaders().split(/\r?\n/)
		headers.forEach(function (header) {
			var matches = header.match(/^([^:]+):\s*(.*)/)
			if (matches) {
				var key = matches[1].toLowerCase()
				if (key === 'set-cookie') {
					if (self.headers[key] === undefined) {
						self.headers[key] = []
					}
					self.headers[key].push(matches[2])
				} else if (self.headers[key] !== undefined) {
					self.headers[key] += ', ' + matches[2]
				} else {
					self.headers[key] = matches[2]
				}
				self.rawHeaders.push(matches[1], matches[2])
			}
		})

		self._charset = 'x-user-defined'
		if (!capability.overrideMimeType) {
			var mimeType = self.rawHeaders['mime-type']
			if (mimeType) {
				var charsetMatch = mimeType.match(/;\s*charset=([^;])(;|$)/)
				if (charsetMatch) {
					self._charset = charsetMatch[1].toLowerCase()
				}
			}
			if (!self._charset)
				self._charset = 'utf-8' // best guess
		}
	}
}

inherits(IncomingMessage, stream.Readable)

IncomingMessage.prototype._read = function () {
	var self = this

	var resolve = self._resumeFetch
	if (resolve) {
		self._resumeFetch = null
		resolve()
	}
}

IncomingMessage.prototype._onXHRProgress = function () {
	var self = this

	var xhr = self._xhr

	var response = null
	switch (self._mode) {
		case 'text':
			response = xhr.responseText
			if (response.length > self._pos) {
				var newData = response.substr(self._pos)
				if (self._charset === 'x-user-defined') {
					var buffer = Buffer.alloc(newData.length)
					for (var i = 0; i < newData.length; i++)
						buffer[i] = newData.charCodeAt(i) & 0xff

					self.push(buffer)
				} else {
					self.push(newData, self._charset)
				}
				self._pos = response.length
			}
			break
		case 'arraybuffer':
			if (xhr.readyState !== rStates.DONE || !xhr.response)
				break
			response = xhr.response
			self.push(Buffer.from(new Uint8Array(response)))
			break
		case 'moz-chunked-arraybuffer': // take whole
			response = xhr.response
			if (xhr.readyState !== rStates.LOADING || !response)
				break
			self.push(Buffer.from(new Uint8Array(response)))
			break
		case 'ms-stream':
			response = xhr.response
			if (xhr.readyState !== rStates.LOADING)
				break
			var reader = new global.MSStreamReader()
			reader.onprogress = function () {
				if (reader.result.byteLength > self._pos) {
					self.push(Buffer.from(new Uint8Array(reader.result.slice(self._pos))))
					self._pos = reader.result.byteLength
				}
			}
			reader.onload = function () {
				self.push(null)
			}
			// reader.onerror = ??? // TODO: this
			reader.readAsArrayBuffer(response)
			break
	}

	// The ms-stream case handles end separately in reader.onload()
	if (self._xhr.readyState === rStates.DONE && self._mode !== 'ms-stream') {
		self.push(null)
	}
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("buffer").Buffer)
},{"./capability":85,"_process":63,"buffer":14,"inherits":21,"readable-stream":102}],88:[function(require,module,exports){
'use strict';

function _inheritsLoose(subClass, superClass) { subClass.prototype = Object.create(superClass.prototype); subClass.prototype.constructor = subClass; subClass.__proto__ = superClass; }

var codes = {};

function createErrorType(code, message, Base) {
  if (!Base) {
    Base = Error;
  }

  function getMessage(arg1, arg2, arg3) {
    if (typeof message === 'string') {
      return message;
    } else {
      return message(arg1, arg2, arg3);
    }
  }

  var NodeError =
  /*#__PURE__*/
  function (_Base) {
    _inheritsLoose(NodeError, _Base);

    function NodeError(arg1, arg2, arg3) {
      return _Base.call(this, getMessage(arg1, arg2, arg3)) || this;
    }

    return NodeError;
  }(Base);

  NodeError.prototype.name = Base.name;
  NodeError.prototype.code = code;
  codes[code] = NodeError;
} // https://github.com/nodejs/node/blob/v10.8.0/lib/internal/errors.js


function oneOf(expected, thing) {
  if (Array.isArray(expected)) {
    var len = expected.length;
    expected = expected.map(function (i) {
      return String(i);
    });

    if (len > 2) {
      return "one of ".concat(thing, " ").concat(expected.slice(0, len - 1).join(', '), ", or ") + expected[len - 1];
    } else if (len === 2) {
      return "one of ".concat(thing, " ").concat(expected[0], " or ").concat(expected[1]);
    } else {
      return "of ".concat(thing, " ").concat(expected[0]);
    }
  } else {
    return "of ".concat(thing, " ").concat(String(expected));
  }
} // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/startsWith


function startsWith(str, search, pos) {
  return str.substr(!pos || pos < 0 ? 0 : +pos, search.length) === search;
} // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/endsWith


function endsWith(str, search, this_len) {
  if (this_len === undefined || this_len > str.length) {
    this_len = str.length;
  }

  return str.substring(this_len - search.length, this_len) === search;
} // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/includes


function includes(str, search, start) {
  if (typeof start !== 'number') {
    start = 0;
  }

  if (start + search.length > str.length) {
    return false;
  } else {
    return str.indexOf(search, start) !== -1;
  }
}

createErrorType('ERR_INVALID_OPT_VALUE', function (name, value) {
  return 'The value "' + value + '" is invalid for option "' + name + '"';
}, TypeError);
createErrorType('ERR_INVALID_ARG_TYPE', function (name, expected, actual) {
  // determiner: 'must be' or 'must not be'
  var determiner;

  if (typeof expected === 'string' && startsWith(expected, 'not ')) {
    determiner = 'must not be';
    expected = expected.replace(/^not /, '');
  } else {
    determiner = 'must be';
  }

  var msg;

  if (endsWith(name, ' argument')) {
    // For cases like 'first argument'
    msg = "The ".concat(name, " ").concat(determiner, " ").concat(oneOf(expected, 'type'));
  } else {
    var type = includes(name, '.') ? 'property' : 'argument';
    msg = "The \"".concat(name, "\" ").concat(type, " ").concat(determiner, " ").concat(oneOf(expected, 'type'));
  }

  msg += ". Received type ".concat(typeof actual);
  return msg;
}, TypeError);
createErrorType('ERR_STREAM_PUSH_AFTER_EOF', 'stream.push() after EOF');
createErrorType('ERR_METHOD_NOT_IMPLEMENTED', function (name) {
  return 'The ' + name + ' method is not implemented';
});
createErrorType('ERR_STREAM_PREMATURE_CLOSE', 'Premature close');
createErrorType('ERR_STREAM_DESTROYED', function (name) {
  return 'Cannot call ' + name + ' after a stream was destroyed';
});
createErrorType('ERR_MULTIPLE_CALLBACK', 'Callback called multiple times');
createErrorType('ERR_STREAM_CANNOT_PIPE', 'Cannot pipe, not readable');
createErrorType('ERR_STREAM_WRITE_AFTER_END', 'write after end');
createErrorType('ERR_STREAM_NULL_VALUES', 'May not write null values to stream', TypeError);
createErrorType('ERR_UNKNOWN_ENCODING', function (arg) {
  return 'Unknown encoding: ' + arg;
}, TypeError);
createErrorType('ERR_STREAM_UNSHIFT_AFTER_END_EVENT', 'stream.unshift() after end event');
module.exports.codes = codes;

},{}],89:[function(require,module,exports){
(function (process){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.
// a duplex stream is just a stream that is both readable and writable.
// Since JS doesn't have multiple prototypal inheritance, this class
// prototypally inherits from Readable, and then parasitically from
// Writable.
'use strict';
/*<replacement>*/

var objectKeys = Object.keys || function (obj) {
  var keys = [];

  for (var key in obj) {
    keys.push(key);
  }

  return keys;
};
/*</replacement>*/


module.exports = Duplex;

var Readable = require('./_stream_readable');

var Writable = require('./_stream_writable');

require('inherits')(Duplex, Readable);

{
  // Allow the keys array to be GC'ed.
  var keys = objectKeys(Writable.prototype);

  for (var v = 0; v < keys.length; v++) {
    var method = keys[v];
    if (!Duplex.prototype[method]) Duplex.prototype[method] = Writable.prototype[method];
  }
}

function Duplex(options) {
  if (!(this instanceof Duplex)) return new Duplex(options);
  Readable.call(this, options);
  Writable.call(this, options);
  this.allowHalfOpen = true;

  if (options) {
    if (options.readable === false) this.readable = false;
    if (options.writable === false) this.writable = false;

    if (options.allowHalfOpen === false) {
      this.allowHalfOpen = false;
      this.once('end', onend);
    }
  }
}

Object.defineProperty(Duplex.prototype, 'writableHighWaterMark', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    return this._writableState.highWaterMark;
  }
});
Object.defineProperty(Duplex.prototype, 'writableBuffer', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    return this._writableState && this._writableState.getBuffer();
  }
});
Object.defineProperty(Duplex.prototype, 'writableLength', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    return this._writableState.length;
  }
}); // the no-half-open enforcer

function onend() {
  // If the writable side ended, then we're ok.
  if (this._writableState.ended) return; // no more data can be written.
  // But allow more writes to happen in this tick.

  process.nextTick(onEndNT, this);
}

function onEndNT(self) {
  self.end();
}

Object.defineProperty(Duplex.prototype, 'destroyed', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    if (this._readableState === undefined || this._writableState === undefined) {
      return false;
    }

    return this._readableState.destroyed && this._writableState.destroyed;
  },
  set: function set(value) {
    // we ignore the value if the stream
    // has not been initialized yet
    if (this._readableState === undefined || this._writableState === undefined) {
      return;
    } // backward compatibility, the user is explicitly
    // managing destroyed


    this._readableState.destroyed = value;
    this._writableState.destroyed = value;
  }
});
}).call(this,require('_process'))
},{"./_stream_readable":91,"./_stream_writable":93,"_process":63,"inherits":21}],90:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.
// a passthrough stream.
// basically just the most minimal sort of Transform stream.
// Every written chunk gets output as-is.
'use strict';

module.exports = PassThrough;

var Transform = require('./_stream_transform');

require('inherits')(PassThrough, Transform);

function PassThrough(options) {
  if (!(this instanceof PassThrough)) return new PassThrough(options);
  Transform.call(this, options);
}

PassThrough.prototype._transform = function (chunk, encoding, cb) {
  cb(null, chunk);
};
},{"./_stream_transform":92,"inherits":21}],91:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.
'use strict';

module.exports = Readable;
/*<replacement>*/

var Duplex;
/*</replacement>*/

Readable.ReadableState = ReadableState;
/*<replacement>*/

var EE = require('events').EventEmitter;

var EElistenerCount = function EElistenerCount(emitter, type) {
  return emitter.listeners(type).length;
};
/*</replacement>*/

/*<replacement>*/


var Stream = require('./internal/streams/stream');
/*</replacement>*/


var Buffer = require('buffer').Buffer;

var OurUint8Array = global.Uint8Array || function () {};

function _uint8ArrayToBuffer(chunk) {
  return Buffer.from(chunk);
}

function _isUint8Array(obj) {
  return Buffer.isBuffer(obj) || obj instanceof OurUint8Array;
}
/*<replacement>*/


var debugUtil = require('util');

var debug;

if (debugUtil && debugUtil.debuglog) {
  debug = debugUtil.debuglog('stream');
} else {
  debug = function debug() {};
}
/*</replacement>*/


var BufferList = require('./internal/streams/buffer_list');

var destroyImpl = require('./internal/streams/destroy');

var _require = require('./internal/streams/state'),
    getHighWaterMark = _require.getHighWaterMark;

var _require$codes = require('../errors').codes,
    ERR_INVALID_ARG_TYPE = _require$codes.ERR_INVALID_ARG_TYPE,
    ERR_STREAM_PUSH_AFTER_EOF = _require$codes.ERR_STREAM_PUSH_AFTER_EOF,
    ERR_METHOD_NOT_IMPLEMENTED = _require$codes.ERR_METHOD_NOT_IMPLEMENTED,
    ERR_STREAM_UNSHIFT_AFTER_END_EVENT = _require$codes.ERR_STREAM_UNSHIFT_AFTER_END_EVENT; // Lazy loaded to improve the startup performance.


var StringDecoder;
var createReadableStreamAsyncIterator;
var from;

require('inherits')(Readable, Stream);

var errorOrDestroy = destroyImpl.errorOrDestroy;
var kProxyEvents = ['error', 'close', 'destroy', 'pause', 'resume'];

function prependListener(emitter, event, fn) {
  // Sadly this is not cacheable as some libraries bundle their own
  // event emitter implementation with them.
  if (typeof emitter.prependListener === 'function') return emitter.prependListener(event, fn); // This is a hack to make sure that our error handler is attached before any
  // userland ones.  NEVER DO THIS. This is here only because this code needs
  // to continue to work with older versions of Node.js that do not include
  // the prependListener() method. The goal is to eventually remove this hack.

  if (!emitter._events || !emitter._events[event]) emitter.on(event, fn);else if (Array.isArray(emitter._events[event])) emitter._events[event].unshift(fn);else emitter._events[event] = [fn, emitter._events[event]];
}

function ReadableState(options, stream, isDuplex) {
  Duplex = Duplex || require('./_stream_duplex');
  options = options || {}; // Duplex streams are both readable and writable, but share
  // the same options object.
  // However, some cases require setting options to different
  // values for the readable and the writable sides of the duplex stream.
  // These options can be provided separately as readableXXX and writableXXX.

  if (typeof isDuplex !== 'boolean') isDuplex = stream instanceof Duplex; // object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away

  this.objectMode = !!options.objectMode;
  if (isDuplex) this.objectMode = this.objectMode || !!options.readableObjectMode; // the point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"

  this.highWaterMark = getHighWaterMark(this, options, 'readableHighWaterMark', isDuplex); // A linked list is used to store data chunks instead of an array because the
  // linked list can remove elements from the beginning faster than
  // array.shift()

  this.buffer = new BufferList();
  this.length = 0;
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false; // a flag to be able to tell if the event 'readable'/'data' is emitted
  // immediately, or on a later tick.  We set this to true at first, because
  // any actions that shouldn't happen until "later" should generally also
  // not happen before the first read call.

  this.sync = true; // whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.

  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;
  this.resumeScheduled = false;
  this.paused = true; // Should close be emitted on destroy. Defaults to true.

  this.emitClose = options.emitClose !== false; // Should .destroy() be called after 'end' (and potentially 'finish')

  this.autoDestroy = !!options.autoDestroy; // has it been destroyed

  this.destroyed = false; // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.

  this.defaultEncoding = options.defaultEncoding || 'utf8'; // the number of writers that are awaiting a drain event in .pipe()s

  this.awaitDrain = 0; // if true, a maybeReadMore has been scheduled

  this.readingMore = false;
  this.decoder = null;
  this.encoding = null;

  if (options.encoding) {
    if (!StringDecoder) StringDecoder = require('string_decoder/').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

function Readable(options) {
  Duplex = Duplex || require('./_stream_duplex');
  if (!(this instanceof Readable)) return new Readable(options); // Checking for a Stream.Duplex instance is faster here instead of inside
  // the ReadableState constructor, at least with V8 6.5

  var isDuplex = this instanceof Duplex;
  this._readableState = new ReadableState(options, this, isDuplex); // legacy

  this.readable = true;

  if (options) {
    if (typeof options.read === 'function') this._read = options.read;
    if (typeof options.destroy === 'function') this._destroy = options.destroy;
  }

  Stream.call(this);
}

Object.defineProperty(Readable.prototype, 'destroyed', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    if (this._readableState === undefined) {
      return false;
    }

    return this._readableState.destroyed;
  },
  set: function set(value) {
    // we ignore the value if the stream
    // has not been initialized yet
    if (!this._readableState) {
      return;
    } // backward compatibility, the user is explicitly
    // managing destroyed


    this._readableState.destroyed = value;
  }
});
Readable.prototype.destroy = destroyImpl.destroy;
Readable.prototype._undestroy = destroyImpl.undestroy;

Readable.prototype._destroy = function (err, cb) {
  cb(err);
}; // Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.


Readable.prototype.push = function (chunk, encoding) {
  var state = this._readableState;
  var skipChunkCheck;

  if (!state.objectMode) {
    if (typeof chunk === 'string') {
      encoding = encoding || state.defaultEncoding;

      if (encoding !== state.encoding) {
        chunk = Buffer.from(chunk, encoding);
        encoding = '';
      }

      skipChunkCheck = true;
    }
  } else {
    skipChunkCheck = true;
  }

  return readableAddChunk(this, chunk, encoding, false, skipChunkCheck);
}; // Unshift should *always* be something directly out of read()


Readable.prototype.unshift = function (chunk) {
  return readableAddChunk(this, chunk, null, true, false);
};

function readableAddChunk(stream, chunk, encoding, addToFront, skipChunkCheck) {
  debug('readableAddChunk', chunk);
  var state = stream._readableState;

  if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
  } else {
    var er;
    if (!skipChunkCheck) er = chunkInvalid(state, chunk);

    if (er) {
      errorOrDestroy(stream, er);
    } else if (state.objectMode || chunk && chunk.length > 0) {
      if (typeof chunk !== 'string' && !state.objectMode && Object.getPrototypeOf(chunk) !== Buffer.prototype) {
        chunk = _uint8ArrayToBuffer(chunk);
      }

      if (addToFront) {
        if (state.endEmitted) errorOrDestroy(stream, new ERR_STREAM_UNSHIFT_AFTER_END_EVENT());else addChunk(stream, state, chunk, true);
      } else if (state.ended) {
        errorOrDestroy(stream, new ERR_STREAM_PUSH_AFTER_EOF());
      } else if (state.destroyed) {
        return false;
      } else {
        state.reading = false;

        if (state.decoder && !encoding) {
          chunk = state.decoder.write(chunk);
          if (state.objectMode || chunk.length !== 0) addChunk(stream, state, chunk, false);else maybeReadMore(stream, state);
        } else {
          addChunk(stream, state, chunk, false);
        }
      }
    } else if (!addToFront) {
      state.reading = false;
      maybeReadMore(stream, state);
    }
  } // We can push more data if we are below the highWaterMark.
  // Also, if we have no data yet, we can stand some more bytes.
  // This is to work around cases where hwm=0, such as the repl.


  return !state.ended && (state.length < state.highWaterMark || state.length === 0);
}

function addChunk(stream, state, chunk, addToFront) {
  if (state.flowing && state.length === 0 && !state.sync) {
    state.awaitDrain = 0;
    stream.emit('data', chunk);
  } else {
    // update the buffer info.
    state.length += state.objectMode ? 1 : chunk.length;
    if (addToFront) state.buffer.unshift(chunk);else state.buffer.push(chunk);
    if (state.needReadable) emitReadable(stream);
  }

  maybeReadMore(stream, state);
}

function chunkInvalid(state, chunk) {
  var er;

  if (!_isUint8Array(chunk) && typeof chunk !== 'string' && chunk !== undefined && !state.objectMode) {
    er = new ERR_INVALID_ARG_TYPE('chunk', ['string', 'Buffer', 'Uint8Array'], chunk);
  }

  return er;
}

Readable.prototype.isPaused = function () {
  return this._readableState.flowing === false;
}; // backwards compatibility.


Readable.prototype.setEncoding = function (enc) {
  if (!StringDecoder) StringDecoder = require('string_decoder/').StringDecoder;
  var decoder = new StringDecoder(enc);
  this._readableState.decoder = decoder; // If setEncoding(null), decoder.encoding equals utf8

  this._readableState.encoding = this._readableState.decoder.encoding; // Iterate over current buffer to convert already stored Buffers:

  var p = this._readableState.buffer.head;
  var content = '';

  while (p !== null) {
    content += decoder.write(p.data);
    p = p.next;
  }

  this._readableState.buffer.clear();

  if (content !== '') this._readableState.buffer.push(content);
  this._readableState.length = content.length;
  return this;
}; // Don't raise the hwm > 1GB


var MAX_HWM = 0x40000000;

function computeNewHighWaterMark(n) {
  if (n >= MAX_HWM) {
    // TODO(ronag): Throw ERR_VALUE_OUT_OF_RANGE.
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2 to prevent increasing hwm excessively in
    // tiny amounts
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    n++;
  }

  return n;
} // This function is designed to be inlinable, so please take care when making
// changes to the function body.


function howMuchToRead(n, state) {
  if (n <= 0 || state.length === 0 && state.ended) return 0;
  if (state.objectMode) return 1;

  if (n !== n) {
    // Only flow one buffer at a time
    if (state.flowing && state.length) return state.buffer.head.data.length;else return state.length;
  } // If we're asking for more than the current hwm, then raise the hwm.


  if (n > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(n);
  if (n <= state.length) return n; // Don't have enough

  if (!state.ended) {
    state.needReadable = true;
    return 0;
  }

  return state.length;
} // you can override either this method, or the async _read(n) below.


Readable.prototype.read = function (n) {
  debug('read', n);
  n = parseInt(n, 10);
  var state = this._readableState;
  var nOrig = n;
  if (n !== 0) state.emittedReadable = false; // if we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.

  if (n === 0 && state.needReadable && ((state.highWaterMark !== 0 ? state.length >= state.highWaterMark : state.length > 0) || state.ended)) {
    debug('read: emitReadable', state.length, state.ended);
    if (state.length === 0 && state.ended) endReadable(this);else emitReadable(this);
    return null;
  }

  n = howMuchToRead(n, state); // if we've ended, and we're now clear, then finish it up.

  if (n === 0 && state.ended) {
    if (state.length === 0) endReadable(this);
    return null;
  } // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.
  // if we need a readable event, then we need to do some reading.


  var doRead = state.needReadable;
  debug('need readable', doRead); // if we currently have less than the highWaterMark, then also read some

  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  } // however, if we've ended, then there's no point, and if we're already
  // reading, then it's unnecessary.


  if (state.ended || state.reading) {
    doRead = false;
    debug('reading or ended', doRead);
  } else if (doRead) {
    debug('do read');
    state.reading = true;
    state.sync = true; // if the length is currently zero, then we *need* a readable event.

    if (state.length === 0) state.needReadable = true; // call internal read method

    this._read(state.highWaterMark);

    state.sync = false; // If _read pushed data synchronously, then `reading` will be false,
    // and we need to re-evaluate how much data we can return to the user.

    if (!state.reading) n = howMuchToRead(nOrig, state);
  }

  var ret;
  if (n > 0) ret = fromList(n, state);else ret = null;

  if (ret === null) {
    state.needReadable = state.length <= state.highWaterMark;
    n = 0;
  } else {
    state.length -= n;
    state.awaitDrain = 0;
  }

  if (state.length === 0) {
    // If we have nothing in the buffer, then we want to know
    // as soon as we *do* get something into the buffer.
    if (!state.ended) state.needReadable = true; // If we tried to read() past the EOF, then emit end on the next tick.

    if (nOrig !== n && state.ended) endReadable(this);
  }

  if (ret !== null) this.emit('data', ret);
  return ret;
};

function onEofChunk(stream, state) {
  debug('onEofChunk');
  if (state.ended) return;

  if (state.decoder) {
    var chunk = state.decoder.end();

    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }

  state.ended = true;

  if (state.sync) {
    // if we are sync, wait until next tick to emit the data.
    // Otherwise we risk emitting data in the flow()
    // the readable code triggers during a read() call
    emitReadable(stream);
  } else {
    // emit 'readable' now to make sure it gets picked up.
    state.needReadable = false;

    if (!state.emittedReadable) {
      state.emittedReadable = true;
      emitReadable_(stream);
    }
  }
} // Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.


function emitReadable(stream) {
  var state = stream._readableState;
  debug('emitReadable', state.needReadable, state.emittedReadable);
  state.needReadable = false;

  if (!state.emittedReadable) {
    debug('emitReadable', state.flowing);
    state.emittedReadable = true;
    process.nextTick(emitReadable_, stream);
  }
}

function emitReadable_(stream) {
  var state = stream._readableState;
  debug('emitReadable_', state.destroyed, state.length, state.ended);

  if (!state.destroyed && (state.length || state.ended)) {
    stream.emit('readable');
    state.emittedReadable = false;
  } // The stream needs another readable event if
  // 1. It is not flowing, as the flow mechanism will take
  //    care of it.
  // 2. It is not ended.
  // 3. It is below the highWaterMark, so we can schedule
  //    another readable later.


  state.needReadable = !state.flowing && !state.ended && state.length <= state.highWaterMark;
  flow(stream);
} // at this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.


function maybeReadMore(stream, state) {
  if (!state.readingMore) {
    state.readingMore = true;
    process.nextTick(maybeReadMore_, stream, state);
  }
}

function maybeReadMore_(stream, state) {
  // Attempt to read more data if we should.
  //
  // The conditions for reading more data are (one of):
  // - Not enough data buffered (state.length < state.highWaterMark). The loop
  //   is responsible for filling the buffer with enough data if such data
  //   is available. If highWaterMark is 0 and we are not in the flowing mode
  //   we should _not_ attempt to buffer any extra data. We'll get more data
  //   when the stream consumer calls read() instead.
  // - No data in the buffer, and the stream is in flowing mode. In this mode
  //   the loop below is responsible for ensuring read() is called. Failing to
  //   call read here would abort the flow and there's no other mechanism for
  //   continuing the flow if the stream consumer has just subscribed to the
  //   'data' event.
  //
  // In addition to the above conditions to keep reading data, the following
  // conditions prevent the data from being read:
  // - The stream has ended (state.ended).
  // - There is already a pending 'read' operation (state.reading). This is a
  //   case where the the stream has called the implementation defined _read()
  //   method, but they are processing the call asynchronously and have _not_
  //   called push() with new data. In this case we skip performing more
  //   read()s. The execution ends in this method again after the _read() ends
  //   up calling push() with more data.
  while (!state.reading && !state.ended && (state.length < state.highWaterMark || state.flowing && state.length === 0)) {
    var len = state.length;
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length) // didn't get any data, stop spinning.
      break;
  }

  state.readingMore = false;
} // abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.


Readable.prototype._read = function (n) {
  errorOrDestroy(this, new ERR_METHOD_NOT_IMPLEMENTED('_read()'));
};

Readable.prototype.pipe = function (dest, pipeOpts) {
  var src = this;
  var state = this._readableState;

  switch (state.pipesCount) {
    case 0:
      state.pipes = dest;
      break;

    case 1:
      state.pipes = [state.pipes, dest];
      break;

    default:
      state.pipes.push(dest);
      break;
  }

  state.pipesCount += 1;
  debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);
  var doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;
  var endFn = doEnd ? onend : unpipe;
  if (state.endEmitted) process.nextTick(endFn);else src.once('end', endFn);
  dest.on('unpipe', onunpipe);

  function onunpipe(readable, unpipeInfo) {
    debug('onunpipe');

    if (readable === src) {
      if (unpipeInfo && unpipeInfo.hasUnpiped === false) {
        unpipeInfo.hasUnpiped = true;
        cleanup();
      }
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  } // when the dest drains, it reduces the awaitDrain counter
  // on the source.  This would be more elegant with a .once()
  // handler in flow(), but adding and removing repeatedly is
  // too slow.


  var ondrain = pipeOnDrain(src);
  dest.on('drain', ondrain);
  var cleanedUp = false;

  function cleanup() {
    debug('cleanup'); // cleanup event handlers once the pipe is broken

    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    dest.removeListener('drain', ondrain);
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', unpipe);
    src.removeListener('data', ondata);
    cleanedUp = true; // if the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.

    if (state.awaitDrain && (!dest._writableState || dest._writableState.needDrain)) ondrain();
  }

  src.on('data', ondata);

  function ondata(chunk) {
    debug('ondata');
    var ret = dest.write(chunk);
    debug('dest.write', ret);

    if (ret === false) {
      // If the user unpiped during `dest.write()`, it is possible
      // to get stuck in a permanently paused state if that write
      // also returned false.
      // => Check whether `dest` is still a piping destination.
      if ((state.pipesCount === 1 && state.pipes === dest || state.pipesCount > 1 && indexOf(state.pipes, dest) !== -1) && !cleanedUp) {
        debug('false write response, pause', state.awaitDrain);
        state.awaitDrain++;
      }

      src.pause();
    }
  } // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.


  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EElistenerCount(dest, 'error') === 0) errorOrDestroy(dest, er);
  } // Make sure our error handler is attached before userland ones.


  prependListener(dest, 'error', onerror); // Both close and finish should trigger unpipe, but only once.

  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }

  dest.once('close', onclose);

  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }

  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  } // tell the dest that it's being piped to


  dest.emit('pipe', src); // start the flow if it hasn't been started already.

  if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src) {
  return function pipeOnDrainFunctionResult() {
    var state = src._readableState;
    debug('pipeOnDrain', state.awaitDrain);
    if (state.awaitDrain) state.awaitDrain--;

    if (state.awaitDrain === 0 && EElistenerCount(src, 'data')) {
      state.flowing = true;
      flow(src);
    }
  };
}

Readable.prototype.unpipe = function (dest) {
  var state = this._readableState;
  var unpipeInfo = {
    hasUnpiped: false
  }; // if we're not piping anywhere, then do nothing.

  if (state.pipesCount === 0) return this; // just one destination.  most common case.

  if (state.pipesCount === 1) {
    // passed in one, but it's not the right one.
    if (dest && dest !== state.pipes) return this;
    if (!dest) dest = state.pipes; // got a match.

    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;
    if (dest) dest.emit('unpipe', this, unpipeInfo);
    return this;
  } // slow case. multiple pipe destinations.


  if (!dest) {
    // remove all.
    var dests = state.pipes;
    var len = state.pipesCount;
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;

    for (var i = 0; i < len; i++) {
      dests[i].emit('unpipe', this, {
        hasUnpiped: false
      });
    }

    return this;
  } // try to find the right one.


  var index = indexOf(state.pipes, dest);
  if (index === -1) return this;
  state.pipes.splice(index, 1);
  state.pipesCount -= 1;
  if (state.pipesCount === 1) state.pipes = state.pipes[0];
  dest.emit('unpipe', this, unpipeInfo);
  return this;
}; // set up data events if they are asked for
// Ensure readable listeners eventually get something


Readable.prototype.on = function (ev, fn) {
  var res = Stream.prototype.on.call(this, ev, fn);
  var state = this._readableState;

  if (ev === 'data') {
    // update readableListening so that resume() may be a no-op
    // a few lines down. This is needed to support once('readable').
    state.readableListening = this.listenerCount('readable') > 0; // Try start flowing on next tick if stream isn't explicitly paused

    if (state.flowing !== false) this.resume();
  } else if (ev === 'readable') {
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = state.needReadable = true;
      state.flowing = false;
      state.emittedReadable = false;
      debug('on readable', state.length, state.reading);

      if (state.length) {
        emitReadable(this);
      } else if (!state.reading) {
        process.nextTick(nReadingNextTick, this);
      }
    }
  }

  return res;
};

Readable.prototype.addListener = Readable.prototype.on;

Readable.prototype.removeListener = function (ev, fn) {
  var res = Stream.prototype.removeListener.call(this, ev, fn);

  if (ev === 'readable') {
    // We need to check if there is someone still listening to
    // readable and reset the state. However this needs to happen
    // after readable has been emitted but before I/O (nextTick) to
    // support once('readable', fn) cycles. This means that calling
    // resume within the same tick will have no
    // effect.
    process.nextTick(updateReadableListening, this);
  }

  return res;
};

Readable.prototype.removeAllListeners = function (ev) {
  var res = Stream.prototype.removeAllListeners.apply(this, arguments);

  if (ev === 'readable' || ev === undefined) {
    // We need to check if there is someone still listening to
    // readable and reset the state. However this needs to happen
    // after readable has been emitted but before I/O (nextTick) to
    // support once('readable', fn) cycles. This means that calling
    // resume within the same tick will have no
    // effect.
    process.nextTick(updateReadableListening, this);
  }

  return res;
};

function updateReadableListening(self) {
  var state = self._readableState;
  state.readableListening = self.listenerCount('readable') > 0;

  if (state.resumeScheduled && !state.paused) {
    // flowing needs to be set to true now, otherwise
    // the upcoming resume will not flow.
    state.flowing = true; // crude way to check if we should resume
  } else if (self.listenerCount('data') > 0) {
    self.resume();
  }
}

function nReadingNextTick(self) {
  debug('readable nexttick read 0');
  self.read(0);
} // pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.


Readable.prototype.resume = function () {
  var state = this._readableState;

  if (!state.flowing) {
    debug('resume'); // we flow only if there is no one listening
    // for readable, but we still have to call
    // resume()

    state.flowing = !state.readableListening;
    resume(this, state);
  }

  state.paused = false;
  return this;
};

function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    process.nextTick(resume_, stream, state);
  }
}

function resume_(stream, state) {
  debug('resume', state.reading);

  if (!state.reading) {
    stream.read(0);
  }

  state.resumeScheduled = false;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading) stream.read(0);
}

Readable.prototype.pause = function () {
  debug('call pause flowing=%j', this._readableState.flowing);

  if (this._readableState.flowing !== false) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }

  this._readableState.paused = true;
  return this;
};

function flow(stream) {
  var state = stream._readableState;
  debug('flow', state.flowing);

  while (state.flowing && stream.read() !== null) {
    ;
  }
} // wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.


Readable.prototype.wrap = function (stream) {
  var _this = this;

  var state = this._readableState;
  var paused = false;
  stream.on('end', function () {
    debug('wrapped end');

    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length) _this.push(chunk);
    }

    _this.push(null);
  });
  stream.on('data', function (chunk) {
    debug('wrapped data');
    if (state.decoder) chunk = state.decoder.write(chunk); // don't skip over falsy values in objectMode

    if (state.objectMode && (chunk === null || chunk === undefined)) return;else if (!state.objectMode && (!chunk || !chunk.length)) return;

    var ret = _this.push(chunk);

    if (!ret) {
      paused = true;
      stream.pause();
    }
  }); // proxy all the other methods.
  // important when wrapping filters and duplexes.

  for (var i in stream) {
    if (this[i] === undefined && typeof stream[i] === 'function') {
      this[i] = function methodWrap(method) {
        return function methodWrapReturnFunction() {
          return stream[method].apply(stream, arguments);
        };
      }(i);
    }
  } // proxy certain important events.


  for (var n = 0; n < kProxyEvents.length; n++) {
    stream.on(kProxyEvents[n], this.emit.bind(this, kProxyEvents[n]));
  } // when we try to consume some more bytes, simply unpause the
  // underlying stream.


  this._read = function (n) {
    debug('wrapped _read', n);

    if (paused) {
      paused = false;
      stream.resume();
    }
  };

  return this;
};

if (typeof Symbol === 'function') {
  Readable.prototype[Symbol.asyncIterator] = function () {
    if (createReadableStreamAsyncIterator === undefined) {
      createReadableStreamAsyncIterator = require('./internal/streams/async_iterator');
    }

    return createReadableStreamAsyncIterator(this);
  };
}

Object.defineProperty(Readable.prototype, 'readableHighWaterMark', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    return this._readableState.highWaterMark;
  }
});
Object.defineProperty(Readable.prototype, 'readableBuffer', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    return this._readableState && this._readableState.buffer;
  }
});
Object.defineProperty(Readable.prototype, 'readableFlowing', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    return this._readableState.flowing;
  },
  set: function set(state) {
    if (this._readableState) {
      this._readableState.flowing = state;
    }
  }
}); // exposed for testing purposes only.

Readable._fromList = fromList;
Object.defineProperty(Readable.prototype, 'readableLength', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    return this._readableState.length;
  }
}); // Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.

function fromList(n, state) {
  // nothing buffered
  if (state.length === 0) return null;
  var ret;
  if (state.objectMode) ret = state.buffer.shift();else if (!n || n >= state.length) {
    // read it all, truncate the list
    if (state.decoder) ret = state.buffer.join('');else if (state.buffer.length === 1) ret = state.buffer.first();else ret = state.buffer.concat(state.length);
    state.buffer.clear();
  } else {
    // read part of list
    ret = state.buffer.consume(n, state.decoder);
  }
  return ret;
}

function endReadable(stream) {
  var state = stream._readableState;
  debug('endReadable', state.endEmitted);

  if (!state.endEmitted) {
    state.ended = true;
    process.nextTick(endReadableNT, state, stream);
  }
}

function endReadableNT(state, stream) {
  debug('endReadableNT', state.endEmitted, state.length); // Check that we didn't get one last unshift.

  if (!state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.readable = false;
    stream.emit('end');

    if (state.autoDestroy) {
      // In case of duplex streams we need a way to detect
      // if the writable side is ready for autoDestroy as well
      var wState = stream._writableState;

      if (!wState || wState.autoDestroy && wState.finished) {
        stream.destroy();
      }
    }
  }
}

if (typeof Symbol === 'function') {
  Readable.from = function (iterable, opts) {
    if (from === undefined) {
      from = require('./internal/streams/from');
    }

    return from(Readable, iterable, opts);
  };
}

function indexOf(xs, x) {
  for (var i = 0, l = xs.length; i < l; i++) {
    if (xs[i] === x) return i;
  }

  return -1;
}
}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"../errors":88,"./_stream_duplex":89,"./internal/streams/async_iterator":94,"./internal/streams/buffer_list":95,"./internal/streams/destroy":96,"./internal/streams/from":98,"./internal/streams/state":100,"./internal/streams/stream":101,"_process":63,"buffer":14,"events":19,"inherits":21,"string_decoder/":103,"util":11}],92:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.
// a transform stream is a readable/writable stream where you do
// something with the data.  Sometimes it's called a "filter",
// but that's not a great name for it, since that implies a thing where
// some bits pass through, and others are simply ignored.  (That would
// be a valid example of a transform, of course.)
//
// While the output is causally related to the input, it's not a
// necessarily symmetric or synchronous transformation.  For example,
// a zlib stream might take multiple plain-text writes(), and then
// emit a single compressed chunk some time in the future.
//
// Here's how this works:
//
// The Transform stream has all the aspects of the readable and writable
// stream classes.  When you write(chunk), that calls _write(chunk,cb)
// internally, and returns false if there's a lot of pending writes
// buffered up.  When you call read(), that calls _read(n) until
// there's enough pending readable data buffered up.
//
// In a transform stream, the written data is placed in a buffer.  When
// _read(n) is called, it transforms the queued up data, calling the
// buffered _write cb's as it consumes chunks.  If consuming a single
// written chunk would result in multiple output chunks, then the first
// outputted bit calls the readcb, and subsequent chunks just go into
// the read buffer, and will cause it to emit 'readable' if necessary.
//
// This way, back-pressure is actually determined by the reading side,
// since _read has to be called to start processing a new chunk.  However,
// a pathological inflate type of transform can cause excessive buffering
// here.  For example, imagine a stream where every byte of input is
// interpreted as an integer from 0-255, and then results in that many
// bytes of output.  Writing the 4 bytes {ff,ff,ff,ff} would result in
// 1kb of data being output.  In this case, you could write a very small
// amount of input, and end up with a very large amount of output.  In
// such a pathological inflating mechanism, there'd be no way to tell
// the system to stop doing the transform.  A single 4MB write could
// cause the system to run out of memory.
//
// However, even in such a pathological case, only a single written chunk
// would be consumed, and then the rest would wait (un-transformed) until
// the results of the previous transformed chunk were consumed.
'use strict';

module.exports = Transform;

var _require$codes = require('../errors').codes,
    ERR_METHOD_NOT_IMPLEMENTED = _require$codes.ERR_METHOD_NOT_IMPLEMENTED,
    ERR_MULTIPLE_CALLBACK = _require$codes.ERR_MULTIPLE_CALLBACK,
    ERR_TRANSFORM_ALREADY_TRANSFORMING = _require$codes.ERR_TRANSFORM_ALREADY_TRANSFORMING,
    ERR_TRANSFORM_WITH_LENGTH_0 = _require$codes.ERR_TRANSFORM_WITH_LENGTH_0;

var Duplex = require('./_stream_duplex');

require('inherits')(Transform, Duplex);

function afterTransform(er, data) {
  var ts = this._transformState;
  ts.transforming = false;
  var cb = ts.writecb;

  if (cb === null) {
    return this.emit('error', new ERR_MULTIPLE_CALLBACK());
  }

  ts.writechunk = null;
  ts.writecb = null;
  if (data != null) // single equals check for both `null` and `undefined`
    this.push(data);
  cb(er);
  var rs = this._readableState;
  rs.reading = false;

  if (rs.needReadable || rs.length < rs.highWaterMark) {
    this._read(rs.highWaterMark);
  }
}

function Transform(options) {
  if (!(this instanceof Transform)) return new Transform(options);
  Duplex.call(this, options);
  this._transformState = {
    afterTransform: afterTransform.bind(this),
    needTransform: false,
    transforming: false,
    writecb: null,
    writechunk: null,
    writeencoding: null
  }; // start out asking for a readable event once data is transformed.

  this._readableState.needReadable = true; // we have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.

  this._readableState.sync = false;

  if (options) {
    if (typeof options.transform === 'function') this._transform = options.transform;
    if (typeof options.flush === 'function') this._flush = options.flush;
  } // When the writable side finishes, then flush out anything remaining.


  this.on('prefinish', prefinish);
}

function prefinish() {
  var _this = this;

  if (typeof this._flush === 'function' && !this._readableState.destroyed) {
    this._flush(function (er, data) {
      done(_this, er, data);
    });
  } else {
    done(this, null, null);
  }
}

Transform.prototype.push = function (chunk, encoding) {
  this._transformState.needTransform = false;
  return Duplex.prototype.push.call(this, chunk, encoding);
}; // This is the part where you do stuff!
// override this function in implementation classes.
// 'chunk' is an input chunk.
//
// Call `push(newChunk)` to pass along transformed output
// to the readable side.  You may call 'push' zero or more times.
//
// Call `cb(err)` when you are done with this chunk.  If you pass
// an error, then that'll put the hurt on the whole operation.  If you
// never call cb(), then you'll never get another chunk.


Transform.prototype._transform = function (chunk, encoding, cb) {
  cb(new ERR_METHOD_NOT_IMPLEMENTED('_transform()'));
};

Transform.prototype._write = function (chunk, encoding, cb) {
  var ts = this._transformState;
  ts.writecb = cb;
  ts.writechunk = chunk;
  ts.writeencoding = encoding;

  if (!ts.transforming) {
    var rs = this._readableState;
    if (ts.needTransform || rs.needReadable || rs.length < rs.highWaterMark) this._read(rs.highWaterMark);
  }
}; // Doesn't matter what the args are here.
// _transform does all the work.
// That we got here means that the readable side wants more data.


Transform.prototype._read = function (n) {
  var ts = this._transformState;

  if (ts.writechunk !== null && !ts.transforming) {
    ts.transforming = true;

    this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
  } else {
    // mark that we need a transform, so that any data that comes in
    // will get processed, now that we've asked for it.
    ts.needTransform = true;
  }
};

Transform.prototype._destroy = function (err, cb) {
  Duplex.prototype._destroy.call(this, err, function (err2) {
    cb(err2);
  });
};

function done(stream, er, data) {
  if (er) return stream.emit('error', er);
  if (data != null) // single equals check for both `null` and `undefined`
    stream.push(data); // TODO(BridgeAR): Write a test for these two error cases
  // if there's nothing in the write buffer, then that means
  // that nothing more will ever be provided

  if (stream._writableState.length) throw new ERR_TRANSFORM_WITH_LENGTH_0();
  if (stream._transformState.transforming) throw new ERR_TRANSFORM_ALREADY_TRANSFORMING();
  return stream.push(null);
}
},{"../errors":88,"./_stream_duplex":89,"inherits":21}],93:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.
// A bit simpler than readable streams.
// Implement an async ._write(chunk, encoding, cb), and it'll handle all
// the drain event emission and buffering.
'use strict';

module.exports = Writable;
/* <replacement> */

function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
  this.next = null;
} // It seems a linked list but it is not
// there will be only 2 of these for each stream


function CorkedRequest(state) {
  var _this = this;

  this.next = null;
  this.entry = null;

  this.finish = function () {
    onCorkedFinish(_this, state);
  };
}
/* </replacement> */

/*<replacement>*/


var Duplex;
/*</replacement>*/

Writable.WritableState = WritableState;
/*<replacement>*/

var internalUtil = {
  deprecate: require('util-deprecate')
};
/*</replacement>*/

/*<replacement>*/

var Stream = require('./internal/streams/stream');
/*</replacement>*/


var Buffer = require('buffer').Buffer;

var OurUint8Array = global.Uint8Array || function () {};

function _uint8ArrayToBuffer(chunk) {
  return Buffer.from(chunk);
}

function _isUint8Array(obj) {
  return Buffer.isBuffer(obj) || obj instanceof OurUint8Array;
}

var destroyImpl = require('./internal/streams/destroy');

var _require = require('./internal/streams/state'),
    getHighWaterMark = _require.getHighWaterMark;

var _require$codes = require('../errors').codes,
    ERR_INVALID_ARG_TYPE = _require$codes.ERR_INVALID_ARG_TYPE,
    ERR_METHOD_NOT_IMPLEMENTED = _require$codes.ERR_METHOD_NOT_IMPLEMENTED,
    ERR_MULTIPLE_CALLBACK = _require$codes.ERR_MULTIPLE_CALLBACK,
    ERR_STREAM_CANNOT_PIPE = _require$codes.ERR_STREAM_CANNOT_PIPE,
    ERR_STREAM_DESTROYED = _require$codes.ERR_STREAM_DESTROYED,
    ERR_STREAM_NULL_VALUES = _require$codes.ERR_STREAM_NULL_VALUES,
    ERR_STREAM_WRITE_AFTER_END = _require$codes.ERR_STREAM_WRITE_AFTER_END,
    ERR_UNKNOWN_ENCODING = _require$codes.ERR_UNKNOWN_ENCODING;

var errorOrDestroy = destroyImpl.errorOrDestroy;

require('inherits')(Writable, Stream);

function nop() {}

function WritableState(options, stream, isDuplex) {
  Duplex = Duplex || require('./_stream_duplex');
  options = options || {}; // Duplex streams are both readable and writable, but share
  // the same options object.
  // However, some cases require setting options to different
  // values for the readable and the writable sides of the duplex stream,
  // e.g. options.readableObjectMode vs. options.writableObjectMode, etc.

  if (typeof isDuplex !== 'boolean') isDuplex = stream instanceof Duplex; // object stream flag to indicate whether or not this stream
  // contains buffers or objects.

  this.objectMode = !!options.objectMode;
  if (isDuplex) this.objectMode = this.objectMode || !!options.writableObjectMode; // the point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write()

  this.highWaterMark = getHighWaterMark(this, options, 'writableHighWaterMark', isDuplex); // if _final has been called

  this.finalCalled = false; // drain event flag.

  this.needDrain = false; // at the start of calling end()

  this.ending = false; // when end() has been called, and returned

  this.ended = false; // when 'finish' is emitted

  this.finished = false; // has it been destroyed

  this.destroyed = false; // should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.

  var noDecode = options.decodeStrings === false;
  this.decodeStrings = !noDecode; // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.

  this.defaultEncoding = options.defaultEncoding || 'utf8'; // not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.

  this.length = 0; // a flag to see when we're in the middle of a write.

  this.writing = false; // when true all writes will be buffered until .uncork() call

  this.corked = 0; // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.

  this.sync = true; // a flag to know if we're processing previously buffered items, which
  // may call the _write() callback in the same tick, so that we don't
  // end up in an overlapped onwrite situation.

  this.bufferProcessing = false; // the callback that's passed to _write(chunk,cb)

  this.onwrite = function (er) {
    onwrite(stream, er);
  }; // the callback that the user supplies to write(chunk,encoding,cb)


  this.writecb = null; // the amount that is being written when _write is called.

  this.writelen = 0;
  this.bufferedRequest = null;
  this.lastBufferedRequest = null; // number of pending user-supplied write callbacks
  // this must be 0 before 'finish' can be emitted

  this.pendingcb = 0; // emit prefinish if the only thing we're waiting for is _write cbs
  // This is relevant for synchronous Transform streams

  this.prefinished = false; // True if the error was already emitted and should not be thrown again

  this.errorEmitted = false; // Should close be emitted on destroy. Defaults to true.

  this.emitClose = options.emitClose !== false; // Should .destroy() be called after 'finish' (and potentially 'end')

  this.autoDestroy = !!options.autoDestroy; // count buffered requests

  this.bufferedRequestCount = 0; // allocate the first CorkedRequest, there is always
  // one allocated and free to use, and we maintain at most two

  this.corkedRequestsFree = new CorkedRequest(this);
}

WritableState.prototype.getBuffer = function getBuffer() {
  var current = this.bufferedRequest;
  var out = [];

  while (current) {
    out.push(current);
    current = current.next;
  }

  return out;
};

(function () {
  try {
    Object.defineProperty(WritableState.prototype, 'buffer', {
      get: internalUtil.deprecate(function writableStateBufferGetter() {
        return this.getBuffer();
      }, '_writableState.buffer is deprecated. Use _writableState.getBuffer ' + 'instead.', 'DEP0003')
    });
  } catch (_) {}
})(); // Test _writableState for inheritance to account for Duplex streams,
// whose prototype chain only points to Readable.


var realHasInstance;

if (typeof Symbol === 'function' && Symbol.hasInstance && typeof Function.prototype[Symbol.hasInstance] === 'function') {
  realHasInstance = Function.prototype[Symbol.hasInstance];
  Object.defineProperty(Writable, Symbol.hasInstance, {
    value: function value(object) {
      if (realHasInstance.call(this, object)) return true;
      if (this !== Writable) return false;
      return object && object._writableState instanceof WritableState;
    }
  });
} else {
  realHasInstance = function realHasInstance(object) {
    return object instanceof this;
  };
}

function Writable(options) {
  Duplex = Duplex || require('./_stream_duplex'); // Writable ctor is applied to Duplexes, too.
  // `realHasInstance` is necessary because using plain `instanceof`
  // would return false, as no `_writableState` property is attached.
  // Trying to use the custom `instanceof` for Writable here will also break the
  // Node.js LazyTransform implementation, which has a non-trivial getter for
  // `_writableState` that would lead to infinite recursion.
  // Checking for a Stream.Duplex instance is faster here instead of inside
  // the WritableState constructor, at least with V8 6.5

  var isDuplex = this instanceof Duplex;
  if (!isDuplex && !realHasInstance.call(Writable, this)) return new Writable(options);
  this._writableState = new WritableState(options, this, isDuplex); // legacy.

  this.writable = true;

  if (options) {
    if (typeof options.write === 'function') this._write = options.write;
    if (typeof options.writev === 'function') this._writev = options.writev;
    if (typeof options.destroy === 'function') this._destroy = options.destroy;
    if (typeof options.final === 'function') this._final = options.final;
  }

  Stream.call(this);
} // Otherwise people can pipe Writable streams, which is just wrong.


Writable.prototype.pipe = function () {
  errorOrDestroy(this, new ERR_STREAM_CANNOT_PIPE());
};

function writeAfterEnd(stream, cb) {
  var er = new ERR_STREAM_WRITE_AFTER_END(); // TODO: defer error events consistently everywhere, not just the cb

  errorOrDestroy(stream, er);
  process.nextTick(cb, er);
} // Checks that a user-supplied chunk is valid, especially for the particular
// mode the stream is in. Currently this means that `null` is never accepted
// and undefined/non-string values are only allowed in object mode.


function validChunk(stream, state, chunk, cb) {
  var er;

  if (chunk === null) {
    er = new ERR_STREAM_NULL_VALUES();
  } else if (typeof chunk !== 'string' && !state.objectMode) {
    er = new ERR_INVALID_ARG_TYPE('chunk', ['string', 'Buffer'], chunk);
  }

  if (er) {
    errorOrDestroy(stream, er);
    process.nextTick(cb, er);
    return false;
  }

  return true;
}

Writable.prototype.write = function (chunk, encoding, cb) {
  var state = this._writableState;
  var ret = false;

  var isBuf = !state.objectMode && _isUint8Array(chunk);

  if (isBuf && !Buffer.isBuffer(chunk)) {
    chunk = _uint8ArrayToBuffer(chunk);
  }

  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (isBuf) encoding = 'buffer';else if (!encoding) encoding = state.defaultEncoding;
  if (typeof cb !== 'function') cb = nop;
  if (state.ending) writeAfterEnd(this, cb);else if (isBuf || validChunk(this, state, chunk, cb)) {
    state.pendingcb++;
    ret = writeOrBuffer(this, state, isBuf, chunk, encoding, cb);
  }
  return ret;
};

Writable.prototype.cork = function () {
  this._writableState.corked++;
};

Writable.prototype.uncork = function () {
  var state = this._writableState;

  if (state.corked) {
    state.corked--;
    if (!state.writing && !state.corked && !state.bufferProcessing && state.bufferedRequest) clearBuffer(this, state);
  }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
  // node::ParseEncoding() requires lower case.
  if (typeof encoding === 'string') encoding = encoding.toLowerCase();
  if (!(['hex', 'utf8', 'utf-8', 'ascii', 'binary', 'base64', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'raw'].indexOf((encoding + '').toLowerCase()) > -1)) throw new ERR_UNKNOWN_ENCODING(encoding);
  this._writableState.defaultEncoding = encoding;
  return this;
};

Object.defineProperty(Writable.prototype, 'writableBuffer', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    return this._writableState && this._writableState.getBuffer();
  }
});

function decodeChunk(state, chunk, encoding) {
  if (!state.objectMode && state.decodeStrings !== false && typeof chunk === 'string') {
    chunk = Buffer.from(chunk, encoding);
  }

  return chunk;
}

Object.defineProperty(Writable.prototype, 'writableHighWaterMark', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    return this._writableState.highWaterMark;
  }
}); // if we're already writing something, then just put this
// in the queue, and wait our turn.  Otherwise, call _write
// If we return false, then we need a drain event, so set that flag.

function writeOrBuffer(stream, state, isBuf, chunk, encoding, cb) {
  if (!isBuf) {
    var newChunk = decodeChunk(state, chunk, encoding);

    if (chunk !== newChunk) {
      isBuf = true;
      encoding = 'buffer';
      chunk = newChunk;
    }
  }

  var len = state.objectMode ? 1 : chunk.length;
  state.length += len;
  var ret = state.length < state.highWaterMark; // we must ensure that previous needDrain will not be reset to false.

  if (!ret) state.needDrain = true;

  if (state.writing || state.corked) {
    var last = state.lastBufferedRequest;
    state.lastBufferedRequest = {
      chunk: chunk,
      encoding: encoding,
      isBuf: isBuf,
      callback: cb,
      next: null
    };

    if (last) {
      last.next = state.lastBufferedRequest;
    } else {
      state.bufferedRequest = state.lastBufferedRequest;
    }

    state.bufferedRequestCount += 1;
  } else {
    doWrite(stream, state, false, len, chunk, encoding, cb);
  }

  return ret;
}

function doWrite(stream, state, writev, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (state.destroyed) state.onwrite(new ERR_STREAM_DESTROYED('write'));else if (writev) stream._writev(chunk, state.onwrite);else stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, sync, er, cb) {
  --state.pendingcb;

  if (sync) {
    // defer the callback if we are being called synchronously
    // to avoid piling up things on the stack
    process.nextTick(cb, er); // this can emit finish, and it will always happen
    // after error

    process.nextTick(finishMaybe, stream, state);
    stream._writableState.errorEmitted = true;
    errorOrDestroy(stream, er);
  } else {
    // the caller expect this to happen before if
    // it is async
    cb(er);
    stream._writableState.errorEmitted = true;
    errorOrDestroy(stream, er); // this can emit finish, but finish must
    // always follow error

    finishMaybe(stream, state);
  }
}

function onwriteStateUpdate(state) {
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
}

function onwrite(stream, er) {
  var state = stream._writableState;
  var sync = state.sync;
  var cb = state.writecb;
  if (typeof cb !== 'function') throw new ERR_MULTIPLE_CALLBACK();
  onwriteStateUpdate(state);
  if (er) onwriteError(stream, state, sync, er, cb);else {
    // Check if we're actually ready to finish, but don't emit yet
    var finished = needFinish(state) || stream.destroyed;

    if (!finished && !state.corked && !state.bufferProcessing && state.bufferedRequest) {
      clearBuffer(stream, state);
    }

    if (sync) {
      process.nextTick(afterWrite, stream, state, finished, cb);
    } else {
      afterWrite(stream, state, finished, cb);
    }
  }
}

function afterWrite(stream, state, finished, cb) {
  if (!finished) onwriteDrain(stream, state);
  state.pendingcb--;
  cb();
  finishMaybe(stream, state);
} // Must force callback to be called on nextTick, so that we don't
// emit 'drain' before the write() consumer gets the 'false' return
// value, and has a chance to attach a 'drain' listener.


function onwriteDrain(stream, state) {
  if (state.length === 0 && state.needDrain) {
    state.needDrain = false;
    stream.emit('drain');
  }
} // if there's something in the buffer waiting, then process it


function clearBuffer(stream, state) {
  state.bufferProcessing = true;
  var entry = state.bufferedRequest;

  if (stream._writev && entry && entry.next) {
    // Fast case, write everything using _writev()
    var l = state.bufferedRequestCount;
    var buffer = new Array(l);
    var holder = state.corkedRequestsFree;
    holder.entry = entry;
    var count = 0;
    var allBuffers = true;

    while (entry) {
      buffer[count] = entry;
      if (!entry.isBuf) allBuffers = false;
      entry = entry.next;
      count += 1;
    }

    buffer.allBuffers = allBuffers;
    doWrite(stream, state, true, state.length, buffer, '', holder.finish); // doWrite is almost always async, defer these to save a bit of time
    // as the hot path ends with doWrite

    state.pendingcb++;
    state.lastBufferedRequest = null;

    if (holder.next) {
      state.corkedRequestsFree = holder.next;
      holder.next = null;
    } else {
      state.corkedRequestsFree = new CorkedRequest(state);
    }

    state.bufferedRequestCount = 0;
  } else {
    // Slow case, write chunks one-by-one
    while (entry) {
      var chunk = entry.chunk;
      var encoding = entry.encoding;
      var cb = entry.callback;
      var len = state.objectMode ? 1 : chunk.length;
      doWrite(stream, state, false, len, chunk, encoding, cb);
      entry = entry.next;
      state.bufferedRequestCount--; // if we didn't call the onwrite immediately, then
      // it means that we need to wait until it does.
      // also, that means that the chunk and cb are currently
      // being processed, so move the buffer counter past them.

      if (state.writing) {
        break;
      }
    }

    if (entry === null) state.lastBufferedRequest = null;
  }

  state.bufferedRequest = entry;
  state.bufferProcessing = false;
}

Writable.prototype._write = function (chunk, encoding, cb) {
  cb(new ERR_METHOD_NOT_IMPLEMENTED('_write()'));
};

Writable.prototype._writev = null;

Writable.prototype.end = function (chunk, encoding, cb) {
  var state = this._writableState;

  if (typeof chunk === 'function') {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (chunk !== null && chunk !== undefined) this.write(chunk, encoding); // .end() fully uncorks

  if (state.corked) {
    state.corked = 1;
    this.uncork();
  } // ignore unnecessary end() calls.


  if (!state.ending) endWritable(this, state, cb);
  return this;
};

Object.defineProperty(Writable.prototype, 'writableLength', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    return this._writableState.length;
  }
});

function needFinish(state) {
  return state.ending && state.length === 0 && state.bufferedRequest === null && !state.finished && !state.writing;
}

function callFinal(stream, state) {
  stream._final(function (err) {
    state.pendingcb--;

    if (err) {
      errorOrDestroy(stream, err);
    }

    state.prefinished = true;
    stream.emit('prefinish');
    finishMaybe(stream, state);
  });
}

function prefinish(stream, state) {
  if (!state.prefinished && !state.finalCalled) {
    if (typeof stream._final === 'function' && !state.destroyed) {
      state.pendingcb++;
      state.finalCalled = true;
      process.nextTick(callFinal, stream, state);
    } else {
      state.prefinished = true;
      stream.emit('prefinish');
    }
  }
}

function finishMaybe(stream, state) {
  var need = needFinish(state);

  if (need) {
    prefinish(stream, state);

    if (state.pendingcb === 0) {
      state.finished = true;
      stream.emit('finish');

      if (state.autoDestroy) {
        // In case of duplex streams we need a way to detect
        // if the readable side is ready for autoDestroy as well
        var rState = stream._readableState;

        if (!rState || rState.autoDestroy && rState.endEmitted) {
          stream.destroy();
        }
      }
    }
  }

  return need;
}

function endWritable(stream, state, cb) {
  state.ending = true;
  finishMaybe(stream, state);

  if (cb) {
    if (state.finished) process.nextTick(cb);else stream.once('finish', cb);
  }

  state.ended = true;
  stream.writable = false;
}

function onCorkedFinish(corkReq, state, err) {
  var entry = corkReq.entry;
  corkReq.entry = null;

  while (entry) {
    var cb = entry.callback;
    state.pendingcb--;
    cb(err);
    entry = entry.next;
  } // reuse the free corkReq.


  state.corkedRequestsFree.next = corkReq;
}

Object.defineProperty(Writable.prototype, 'destroyed', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function get() {
    if (this._writableState === undefined) {
      return false;
    }

    return this._writableState.destroyed;
  },
  set: function set(value) {
    // we ignore the value if the stream
    // has not been initialized yet
    if (!this._writableState) {
      return;
    } // backward compatibility, the user is explicitly
    // managing destroyed


    this._writableState.destroyed = value;
  }
});
Writable.prototype.destroy = destroyImpl.destroy;
Writable.prototype._undestroy = destroyImpl.undestroy;

Writable.prototype._destroy = function (err, cb) {
  cb(err);
};
}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"../errors":88,"./_stream_duplex":89,"./internal/streams/destroy":96,"./internal/streams/state":100,"./internal/streams/stream":101,"_process":63,"buffer":14,"inherits":21,"util-deprecate":108}],94:[function(require,module,exports){
(function (process){
'use strict';

var _Object$setPrototypeO;

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

var finished = require('./end-of-stream');

var kLastResolve = Symbol('lastResolve');
var kLastReject = Symbol('lastReject');
var kError = Symbol('error');
var kEnded = Symbol('ended');
var kLastPromise = Symbol('lastPromise');
var kHandlePromise = Symbol('handlePromise');
var kStream = Symbol('stream');

function createIterResult(value, done) {
  return {
    value: value,
    done: done
  };
}

function readAndResolve(iter) {
  var resolve = iter[kLastResolve];

  if (resolve !== null) {
    var data = iter[kStream].read(); // we defer if data is null
    // we can be expecting either 'end' or
    // 'error'

    if (data !== null) {
      iter[kLastPromise] = null;
      iter[kLastResolve] = null;
      iter[kLastReject] = null;
      resolve(createIterResult(data, false));
    }
  }
}

function onReadable(iter) {
  // we wait for the next tick, because it might
  // emit an error with process.nextTick
  process.nextTick(readAndResolve, iter);
}

function wrapForNext(lastPromise, iter) {
  return function (resolve, reject) {
    lastPromise.then(function () {
      if (iter[kEnded]) {
        resolve(createIterResult(undefined, true));
        return;
      }

      iter[kHandlePromise](resolve, reject);
    }, reject);
  };
}

var AsyncIteratorPrototype = Object.getPrototypeOf(function () {});
var ReadableStreamAsyncIteratorPrototype = Object.setPrototypeOf((_Object$setPrototypeO = {
  get stream() {
    return this[kStream];
  },

  next: function next() {
    var _this = this;

    // if we have detected an error in the meanwhile
    // reject straight away
    var error = this[kError];

    if (error !== null) {
      return Promise.reject(error);
    }

    if (this[kEnded]) {
      return Promise.resolve(createIterResult(undefined, true));
    }

    if (this[kStream].destroyed) {
      // We need to defer via nextTick because if .destroy(err) is
      // called, the error will be emitted via nextTick, and
      // we cannot guarantee that there is no error lingering around
      // waiting to be emitted.
      return new Promise(function (resolve, reject) {
        process.nextTick(function () {
          if (_this[kError]) {
            reject(_this[kError]);
          } else {
            resolve(createIterResult(undefined, true));
          }
        });
      });
    } // if we have multiple next() calls
    // we will wait for the previous Promise to finish
    // this logic is optimized to support for await loops,
    // where next() is only called once at a time


    var lastPromise = this[kLastPromise];
    var promise;

    if (lastPromise) {
      promise = new Promise(wrapForNext(lastPromise, this));
    } else {
      // fast path needed to support multiple this.push()
      // without triggering the next() queue
      var data = this[kStream].read();

      if (data !== null) {
        return Promise.resolve(createIterResult(data, false));
      }

      promise = new Promise(this[kHandlePromise]);
    }

    this[kLastPromise] = promise;
    return promise;
  }
}, _defineProperty(_Object$setPrototypeO, Symbol.asyncIterator, function () {
  return this;
}), _defineProperty(_Object$setPrototypeO, "return", function _return() {
  var _this2 = this;

  // destroy(err, cb) is a private API
  // we can guarantee we have that here, because we control the
  // Readable class this is attached to
  return new Promise(function (resolve, reject) {
    _this2[kStream].destroy(null, function (err) {
      if (err) {
        reject(err);
        return;
      }

      resolve(createIterResult(undefined, true));
    });
  });
}), _Object$setPrototypeO), AsyncIteratorPrototype);

var createReadableStreamAsyncIterator = function createReadableStreamAsyncIterator(stream) {
  var _Object$create;

  var iterator = Object.create(ReadableStreamAsyncIteratorPrototype, (_Object$create = {}, _defineProperty(_Object$create, kStream, {
    value: stream,
    writable: true
  }), _defineProperty(_Object$create, kLastResolve, {
    value: null,
    writable: true
  }), _defineProperty(_Object$create, kLastReject, {
    value: null,
    writable: true
  }), _defineProperty(_Object$create, kError, {
    value: null,
    writable: true
  }), _defineProperty(_Object$create, kEnded, {
    value: stream._readableState.endEmitted,
    writable: true
  }), _defineProperty(_Object$create, kHandlePromise, {
    value: function value(resolve, reject) {
      var data = iterator[kStream].read();

      if (data) {
        iterator[kLastPromise] = null;
        iterator[kLastResolve] = null;
        iterator[kLastReject] = null;
        resolve(createIterResult(data, false));
      } else {
        iterator[kLastResolve] = resolve;
        iterator[kLastReject] = reject;
      }
    },
    writable: true
  }), _Object$create));
  iterator[kLastPromise] = null;
  finished(stream, function (err) {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      var reject = iterator[kLastReject]; // reject if we are waiting for data in the Promise
      // returned by next() and store the error

      if (reject !== null) {
        iterator[kLastPromise] = null;
        iterator[kLastResolve] = null;
        iterator[kLastReject] = null;
        reject(err);
      }

      iterator[kError] = err;
      return;
    }

    var resolve = iterator[kLastResolve];

    if (resolve !== null) {
      iterator[kLastPromise] = null;
      iterator[kLastResolve] = null;
      iterator[kLastReject] = null;
      resolve(createIterResult(undefined, true));
    }

    iterator[kEnded] = true;
  });
  stream.on('readable', onReadable.bind(null, iterator));
  return iterator;
};

module.exports = createReadableStreamAsyncIterator;
}).call(this,require('_process'))
},{"./end-of-stream":97,"_process":63}],95:[function(require,module,exports){
'use strict';

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } }

function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); return Constructor; }

var _require = require('buffer'),
    Buffer = _require.Buffer;

var _require2 = require('util'),
    inspect = _require2.inspect;

var custom = inspect && inspect.custom || 'inspect';

function copyBuffer(src, target, offset) {
  Buffer.prototype.copy.call(src, target, offset);
}

module.exports =
/*#__PURE__*/
function () {
  function BufferList() {
    _classCallCheck(this, BufferList);

    this.head = null;
    this.tail = null;
    this.length = 0;
  }

  _createClass(BufferList, [{
    key: "push",
    value: function push(v) {
      var entry = {
        data: v,
        next: null
      };
      if (this.length > 0) this.tail.next = entry;else this.head = entry;
      this.tail = entry;
      ++this.length;
    }
  }, {
    key: "unshift",
    value: function unshift(v) {
      var entry = {
        data: v,
        next: this.head
      };
      if (this.length === 0) this.tail = entry;
      this.head = entry;
      ++this.length;
    }
  }, {
    key: "shift",
    value: function shift() {
      if (this.length === 0) return;
      var ret = this.head.data;
      if (this.length === 1) this.head = this.tail = null;else this.head = this.head.next;
      --this.length;
      return ret;
    }
  }, {
    key: "clear",
    value: function clear() {
      this.head = this.tail = null;
      this.length = 0;
    }
  }, {
    key: "join",
    value: function join(s) {
      if (this.length === 0) return '';
      var p = this.head;
      var ret = '' + p.data;

      while (p = p.next) {
        ret += s + p.data;
      }

      return ret;
    }
  }, {
    key: "concat",
    value: function concat(n) {
      if (this.length === 0) return Buffer.alloc(0);
      var ret = Buffer.allocUnsafe(n >>> 0);
      var p = this.head;
      var i = 0;

      while (p) {
        copyBuffer(p.data, ret, i);
        i += p.data.length;
        p = p.next;
      }

      return ret;
    } // Consumes a specified amount of bytes or characters from the buffered data.

  }, {
    key: "consume",
    value: function consume(n, hasStrings) {
      var ret;

      if (n < this.head.data.length) {
        // `slice` is the same for buffers and strings.
        ret = this.head.data.slice(0, n);
        this.head.data = this.head.data.slice(n);
      } else if (n === this.head.data.length) {
        // First chunk is a perfect match.
        ret = this.shift();
      } else {
        // Result spans more than one buffer.
        ret = hasStrings ? this._getString(n) : this._getBuffer(n);
      }

      return ret;
    }
  }, {
    key: "first",
    value: function first() {
      return this.head.data;
    } // Consumes a specified amount of characters from the buffered data.

  }, {
    key: "_getString",
    value: function _getString(n) {
      var p = this.head;
      var c = 1;
      var ret = p.data;
      n -= ret.length;

      while (p = p.next) {
        var str = p.data;
        var nb = n > str.length ? str.length : n;
        if (nb === str.length) ret += str;else ret += str.slice(0, n);
        n -= nb;

        if (n === 0) {
          if (nb === str.length) {
            ++c;
            if (p.next) this.head = p.next;else this.head = this.tail = null;
          } else {
            this.head = p;
            p.data = str.slice(nb);
          }

          break;
        }

        ++c;
      }

      this.length -= c;
      return ret;
    } // Consumes a specified amount of bytes from the buffered data.

  }, {
    key: "_getBuffer",
    value: function _getBuffer(n) {
      var ret = Buffer.allocUnsafe(n);
      var p = this.head;
      var c = 1;
      p.data.copy(ret);
      n -= p.data.length;

      while (p = p.next) {
        var buf = p.data;
        var nb = n > buf.length ? buf.length : n;
        buf.copy(ret, ret.length - n, 0, nb);
        n -= nb;

        if (n === 0) {
          if (nb === buf.length) {
            ++c;
            if (p.next) this.head = p.next;else this.head = this.tail = null;
          } else {
            this.head = p;
            p.data = buf.slice(nb);
          }

          break;
        }

        ++c;
      }

      this.length -= c;
      return ret;
    } // Make sure the linked list only shows the minimal necessary information.

  }, {
    key: custom,
    value: function value(_, options) {
      return inspect(this, _objectSpread({}, options, {
        // Only inspect one level.
        depth: 0,
        // It should not recurse.
        customInspect: false
      }));
    }
  }]);

  return BufferList;
}();
},{"buffer":14,"util":11}],96:[function(require,module,exports){
(function (process){
'use strict'; // undocumented cb() API, needed for core, not for public API

function destroy(err, cb) {
  var _this = this;

  var readableDestroyed = this._readableState && this._readableState.destroyed;
  var writableDestroyed = this._writableState && this._writableState.destroyed;

  if (readableDestroyed || writableDestroyed) {
    if (cb) {
      cb(err);
    } else if (err) {
      if (!this._writableState) {
        process.nextTick(emitErrorNT, this, err);
      } else if (!this._writableState.errorEmitted) {
        this._writableState.errorEmitted = true;
        process.nextTick(emitErrorNT, this, err);
      }
    }

    return this;
  } // we set destroyed to true before firing error callbacks in order
  // to make it re-entrance safe in case destroy() is called within callbacks


  if (this._readableState) {
    this._readableState.destroyed = true;
  } // if this is a duplex stream mark the writable part as destroyed as well


  if (this._writableState) {
    this._writableState.destroyed = true;
  }

  this._destroy(err || null, function (err) {
    if (!cb && err) {
      if (!_this._writableState) {
        process.nextTick(emitErrorAndCloseNT, _this, err);
      } else if (!_this._writableState.errorEmitted) {
        _this._writableState.errorEmitted = true;
        process.nextTick(emitErrorAndCloseNT, _this, err);
      } else {
        process.nextTick(emitCloseNT, _this);
      }
    } else if (cb) {
      process.nextTick(emitCloseNT, _this);
      cb(err);
    } else {
      process.nextTick(emitCloseNT, _this);
    }
  });

  return this;
}

function emitErrorAndCloseNT(self, err) {
  emitErrorNT(self, err);
  emitCloseNT(self);
}

function emitCloseNT(self) {
  if (self._writableState && !self._writableState.emitClose) return;
  if (self._readableState && !self._readableState.emitClose) return;
  self.emit('close');
}

function undestroy() {
  if (this._readableState) {
    this._readableState.destroyed = false;
    this._readableState.reading = false;
    this._readableState.ended = false;
    this._readableState.endEmitted = false;
  }

  if (this._writableState) {
    this._writableState.destroyed = false;
    this._writableState.ended = false;
    this._writableState.ending = false;
    this._writableState.finalCalled = false;
    this._writableState.prefinished = false;
    this._writableState.finished = false;
    this._writableState.errorEmitted = false;
  }
}

function emitErrorNT(self, err) {
  self.emit('error', err);
}

function errorOrDestroy(stream, err) {
  // We have tests that rely on errors being emitted
  // in the same tick, so changing this is semver major.
  // For now when you opt-in to autoDestroy we allow
  // the error to be emitted nextTick. In a future
  // semver major update we should change the default to this.
  var rState = stream._readableState;
  var wState = stream._writableState;
  if (rState && rState.autoDestroy || wState && wState.autoDestroy) stream.destroy(err);else stream.emit('error', err);
}

module.exports = {
  destroy: destroy,
  undestroy: undestroy,
  errorOrDestroy: errorOrDestroy
};
}).call(this,require('_process'))
},{"_process":63}],97:[function(require,module,exports){
// Ported from https://github.com/mafintosh/end-of-stream with
// permission from the author, Mathias Buus (@mafintosh).
'use strict';

var ERR_STREAM_PREMATURE_CLOSE = require('../../../errors').codes.ERR_STREAM_PREMATURE_CLOSE;

function once(callback) {
  var called = false;
  return function () {
    if (called) return;
    called = true;

    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    callback.apply(this, args);
  };
}

function noop() {}

function isRequest(stream) {
  return stream.setHeader && typeof stream.abort === 'function';
}

function eos(stream, opts, callback) {
  if (typeof opts === 'function') return eos(stream, null, opts);
  if (!opts) opts = {};
  callback = once(callback || noop);
  var readable = opts.readable || opts.readable !== false && stream.readable;
  var writable = opts.writable || opts.writable !== false && stream.writable;

  var onlegacyfinish = function onlegacyfinish() {
    if (!stream.writable) onfinish();
  };

  var writableEnded = stream._writableState && stream._writableState.finished;

  var onfinish = function onfinish() {
    writable = false;
    writableEnded = true;
    if (!readable) callback.call(stream);
  };

  var readableEnded = stream._readableState && stream._readableState.endEmitted;

  var onend = function onend() {
    readable = false;
    readableEnded = true;
    if (!writable) callback.call(stream);
  };

  var onerror = function onerror(err) {
    callback.call(stream, err);
  };

  var onclose = function onclose() {
    var err;

    if (readable && !readableEnded) {
      if (!stream._readableState || !stream._readableState.ended) err = new ERR_STREAM_PREMATURE_CLOSE();
      return callback.call(stream, err);
    }

    if (writable && !writableEnded) {
      if (!stream._writableState || !stream._writableState.ended) err = new ERR_STREAM_PREMATURE_CLOSE();
      return callback.call(stream, err);
    }
  };

  var onrequest = function onrequest() {
    stream.req.on('finish', onfinish);
  };

  if (isRequest(stream)) {
    stream.on('complete', onfinish);
    stream.on('abort', onclose);
    if (stream.req) onrequest();else stream.on('request', onrequest);
  } else if (writable && !stream._writableState) {
    // legacy streams
    stream.on('end', onlegacyfinish);
    stream.on('close', onlegacyfinish);
  }

  stream.on('end', onend);
  stream.on('finish', onfinish);
  if (opts.error !== false) stream.on('error', onerror);
  stream.on('close', onclose);
  return function () {
    stream.removeListener('complete', onfinish);
    stream.removeListener('abort', onclose);
    stream.removeListener('request', onrequest);
    if (stream.req) stream.req.removeListener('finish', onfinish);
    stream.removeListener('end', onlegacyfinish);
    stream.removeListener('close', onlegacyfinish);
    stream.removeListener('finish', onfinish);
    stream.removeListener('end', onend);
    stream.removeListener('error', onerror);
    stream.removeListener('close', onclose);
  };
}

module.exports = eos;
},{"../../../errors":88}],98:[function(require,module,exports){
module.exports = function () {
  throw new Error('Readable.from is not available in the browser')
};

},{}],99:[function(require,module,exports){
// Ported from https://github.com/mafintosh/pump with
// permission from the author, Mathias Buus (@mafintosh).
'use strict';

var eos;

function once(callback) {
  var called = false;
  return function () {
    if (called) return;
    called = true;
    callback.apply(void 0, arguments);
  };
}

var _require$codes = require('../../../errors').codes,
    ERR_MISSING_ARGS = _require$codes.ERR_MISSING_ARGS,
    ERR_STREAM_DESTROYED = _require$codes.ERR_STREAM_DESTROYED;

function noop(err) {
  // Rethrow the error if it exists to avoid swallowing it
  if (err) throw err;
}

function isRequest(stream) {
  return stream.setHeader && typeof stream.abort === 'function';
}

function destroyer(stream, reading, writing, callback) {
  callback = once(callback);
  var closed = false;
  stream.on('close', function () {
    closed = true;
  });
  if (eos === undefined) eos = require('./end-of-stream');
  eos(stream, {
    readable: reading,
    writable: writing
  }, function (err) {
    if (err) return callback(err);
    closed = true;
    callback();
  });
  var destroyed = false;
  return function (err) {
    if (closed) return;
    if (destroyed) return;
    destroyed = true; // request.destroy just do .end - .abort is what we want

    if (isRequest(stream)) return stream.abort();
    if (typeof stream.destroy === 'function') return stream.destroy();
    callback(err || new ERR_STREAM_DESTROYED('pipe'));
  };
}

function call(fn) {
  fn();
}

function pipe(from, to) {
  return from.pipe(to);
}

function popCallback(streams) {
  if (!streams.length) return noop;
  if (typeof streams[streams.length - 1] !== 'function') return noop;
  return streams.pop();
}

function pipeline() {
  for (var _len = arguments.length, streams = new Array(_len), _key = 0; _key < _len; _key++) {
    streams[_key] = arguments[_key];
  }

  var callback = popCallback(streams);
  if (Array.isArray(streams[0])) streams = streams[0];

  if (streams.length < 2) {
    throw new ERR_MISSING_ARGS('streams');
  }

  var error;
  var destroys = streams.map(function (stream, i) {
    var reading = i < streams.length - 1;
    var writing = i > 0;
    return destroyer(stream, reading, writing, function (err) {
      if (!error) error = err;
      if (err) destroys.forEach(call);
      if (reading) return;
      destroys.forEach(call);
      callback(error);
    });
  });
  return streams.reduce(pipe);
}

module.exports = pipeline;
},{"../../../errors":88,"./end-of-stream":97}],100:[function(require,module,exports){
'use strict';

var ERR_INVALID_OPT_VALUE = require('../../../errors').codes.ERR_INVALID_OPT_VALUE;

function highWaterMarkFrom(options, isDuplex, duplexKey) {
  return options.highWaterMark != null ? options.highWaterMark : isDuplex ? options[duplexKey] : null;
}

function getHighWaterMark(state, options, duplexKey, isDuplex) {
  var hwm = highWaterMarkFrom(options, isDuplex, duplexKey);

  if (hwm != null) {
    if (!(isFinite(hwm) && Math.floor(hwm) === hwm) || hwm < 0) {
      var name = isDuplex ? duplexKey : 'highWaterMark';
      throw new ERR_INVALID_OPT_VALUE(name, hwm);
    }

    return Math.floor(hwm);
  } // Default value


  return state.objectMode ? 16 : 16 * 1024;
}

module.exports = {
  getHighWaterMark: getHighWaterMark
};
},{"../../../errors":88}],101:[function(require,module,exports){
arguments[4][75][0].apply(exports,arguments)
},{"dup":75,"events":19}],102:[function(require,module,exports){
exports = module.exports = require('./lib/_stream_readable.js');
exports.Stream = exports;
exports.Readable = exports;
exports.Writable = require('./lib/_stream_writable.js');
exports.Duplex = require('./lib/_stream_duplex.js');
exports.Transform = require('./lib/_stream_transform.js');
exports.PassThrough = require('./lib/_stream_passthrough.js');
exports.finished = require('./lib/internal/streams/end-of-stream.js');
exports.pipeline = require('./lib/internal/streams/pipeline.js');

},{"./lib/_stream_duplex.js":89,"./lib/_stream_passthrough.js":90,"./lib/_stream_readable.js":91,"./lib/_stream_transform.js":92,"./lib/_stream_writable.js":93,"./lib/internal/streams/end-of-stream.js":97,"./lib/internal/streams/pipeline.js":99}],103:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

/*<replacement>*/

var Buffer = require('safe-buffer').Buffer;
/*</replacement>*/

var isEncoding = Buffer.isEncoding || function (encoding) {
  encoding = '' + encoding;
  switch (encoding && encoding.toLowerCase()) {
    case 'hex':case 'utf8':case 'utf-8':case 'ascii':case 'binary':case 'base64':case 'ucs2':case 'ucs-2':case 'utf16le':case 'utf-16le':case 'raw':
      return true;
    default:
      return false;
  }
};

function _normalizeEncoding(enc) {
  if (!enc) return 'utf8';
  var retried;
  while (true) {
    switch (enc) {
      case 'utf8':
      case 'utf-8':
        return 'utf8';
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return 'utf16le';
      case 'latin1':
      case 'binary':
        return 'latin1';
      case 'base64':
      case 'ascii':
      case 'hex':
        return enc;
      default:
        if (retried) return; // undefined
        enc = ('' + enc).toLowerCase();
        retried = true;
    }
  }
};

// Do not cache `Buffer.isEncoding` when checking encoding names as some
// modules monkey-patch it to support additional encodings
function normalizeEncoding(enc) {
  var nenc = _normalizeEncoding(enc);
  if (typeof nenc !== 'string' && (Buffer.isEncoding === isEncoding || !isEncoding(enc))) throw new Error('Unknown encoding: ' + enc);
  return nenc || enc;
}

// StringDecoder provides an interface for efficiently splitting a series of
// buffers into a series of JS strings without breaking apart multi-byte
// characters.
exports.StringDecoder = StringDecoder;
function StringDecoder(encoding) {
  this.encoding = normalizeEncoding(encoding);
  var nb;
  switch (this.encoding) {
    case 'utf16le':
      this.text = utf16Text;
      this.end = utf16End;
      nb = 4;
      break;
    case 'utf8':
      this.fillLast = utf8FillLast;
      nb = 4;
      break;
    case 'base64':
      this.text = base64Text;
      this.end = base64End;
      nb = 3;
      break;
    default:
      this.write = simpleWrite;
      this.end = simpleEnd;
      return;
  }
  this.lastNeed = 0;
  this.lastTotal = 0;
  this.lastChar = Buffer.allocUnsafe(nb);
}

StringDecoder.prototype.write = function (buf) {
  if (buf.length === 0) return '';
  var r;
  var i;
  if (this.lastNeed) {
    r = this.fillLast(buf);
    if (r === undefined) return '';
    i = this.lastNeed;
    this.lastNeed = 0;
  } else {
    i = 0;
  }
  if (i < buf.length) return r ? r + this.text(buf, i) : this.text(buf, i);
  return r || '';
};

StringDecoder.prototype.end = utf8End;

// Returns only complete characters in a Buffer
StringDecoder.prototype.text = utf8Text;

// Attempts to complete a partial non-UTF-8 character using bytes from a Buffer
StringDecoder.prototype.fillLast = function (buf) {
  if (this.lastNeed <= buf.length) {
    buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, this.lastNeed);
    return this.lastChar.toString(this.encoding, 0, this.lastTotal);
  }
  buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, buf.length);
  this.lastNeed -= buf.length;
};

// Checks the type of a UTF-8 byte, whether it's ASCII, a leading byte, or a
// continuation byte. If an invalid byte is detected, -2 is returned.
function utf8CheckByte(byte) {
  if (byte <= 0x7F) return 0;else if (byte >> 5 === 0x06) return 2;else if (byte >> 4 === 0x0E) return 3;else if (byte >> 3 === 0x1E) return 4;
  return byte >> 6 === 0x02 ? -1 : -2;
}

// Checks at most 3 bytes at the end of a Buffer in order to detect an
// incomplete multi-byte UTF-8 character. The total number of bytes (2, 3, or 4)
// needed to complete the UTF-8 character (if applicable) are returned.
function utf8CheckIncomplete(self, buf, i) {
  var j = buf.length - 1;
  if (j < i) return 0;
  var nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 1;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 2;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) {
      if (nb === 2) nb = 0;else self.lastNeed = nb - 3;
    }
    return nb;
  }
  return 0;
}

// Validates as many continuation bytes for a multi-byte UTF-8 character as
// needed or are available. If we see a non-continuation byte where we expect
// one, we "replace" the validated continuation bytes we've seen so far with
// a single UTF-8 replacement character ('\ufffd'), to match v8's UTF-8 decoding
// behavior. The continuation byte check is included three times in the case
// where all of the continuation bytes for a character exist in the same buffer.
// It is also done this way as a slight performance increase instead of using a
// loop.
function utf8CheckExtraBytes(self, buf, p) {
  if ((buf[0] & 0xC0) !== 0x80) {
    self.lastNeed = 0;
    return '\ufffd';
  }
  if (self.lastNeed > 1 && buf.length > 1) {
    if ((buf[1] & 0xC0) !== 0x80) {
      self.lastNeed = 1;
      return '\ufffd';
    }
    if (self.lastNeed > 2 && buf.length > 2) {
      if ((buf[2] & 0xC0) !== 0x80) {
        self.lastNeed = 2;
        return '\ufffd';
      }
    }
  }
}

// Attempts to complete a multi-byte UTF-8 character using bytes from a Buffer.
function utf8FillLast(buf) {
  var p = this.lastTotal - this.lastNeed;
  var r = utf8CheckExtraBytes(this, buf, p);
  if (r !== undefined) return r;
  if (this.lastNeed <= buf.length) {
    buf.copy(this.lastChar, p, 0, this.lastNeed);
    return this.lastChar.toString(this.encoding, 0, this.lastTotal);
  }
  buf.copy(this.lastChar, p, 0, buf.length);
  this.lastNeed -= buf.length;
}

// Returns all complete UTF-8 characters in a Buffer. If the Buffer ended on a
// partial character, the character's bytes are buffered until the required
// number of bytes are available.
function utf8Text(buf, i) {
  var total = utf8CheckIncomplete(this, buf, i);
  if (!this.lastNeed) return buf.toString('utf8', i);
  this.lastTotal = total;
  var end = buf.length - (total - this.lastNeed);
  buf.copy(this.lastChar, 0, end);
  return buf.toString('utf8', i, end);
}

// For UTF-8, a replacement character is added when ending on a partial
// character.
function utf8End(buf) {
  var r = buf && buf.length ? this.write(buf) : '';
  if (this.lastNeed) return r + '\ufffd';
  return r;
}

// UTF-16LE typically needs two bytes per character, but even if we have an even
// number of bytes available, we need to check if we end on a leading/high
// surrogate. In that case, we need to wait for the next two bytes in order to
// decode the last character properly.
function utf16Text(buf, i) {
  if ((buf.length - i) % 2 === 0) {
    var r = buf.toString('utf16le', i);
    if (r) {
      var c = r.charCodeAt(r.length - 1);
      if (c >= 0xD800 && c <= 0xDBFF) {
        this.lastNeed = 2;
        this.lastTotal = 4;
        this.lastChar[0] = buf[buf.length - 2];
        this.lastChar[1] = buf[buf.length - 1];
        return r.slice(0, -1);
      }
    }
    return r;
  }
  this.lastNeed = 1;
  this.lastTotal = 2;
  this.lastChar[0] = buf[buf.length - 1];
  return buf.toString('utf16le', i, buf.length - 1);
}

// For UTF-16LE we do not explicitly append special replacement characters if we
// end on a partial character, we simply let v8 handle that.
function utf16End(buf) {
  var r = buf && buf.length ? this.write(buf) : '';
  if (this.lastNeed) {
    var end = this.lastTotal - this.lastNeed;
    return r + this.lastChar.toString('utf16le', 0, end);
  }
  return r;
}

function base64Text(buf, i) {
  var n = (buf.length - i) % 3;
  if (n === 0) return buf.toString('base64', i);
  this.lastNeed = 3 - n;
  this.lastTotal = 3;
  if (n === 1) {
    this.lastChar[0] = buf[buf.length - 1];
  } else {
    this.lastChar[0] = buf[buf.length - 2];
    this.lastChar[1] = buf[buf.length - 1];
  }
  return buf.toString('base64', i, buf.length - n);
}

function base64End(buf) {
  var r = buf && buf.length ? this.write(buf) : '';
  if (this.lastNeed) return r + this.lastChar.toString('base64', 0, 3 - this.lastNeed);
  return r;
}

// Pass bytes on through for single-byte encodings (e.g. ascii, latin1, hex)
function simpleWrite(buf) {
  return buf.toString(this.encoding);
}

function simpleEnd(buf) {
  return buf && buf.length ? this.write(buf) : '';
}
},{"safe-buffer":104}],104:[function(require,module,exports){
arguments[4][76][0].apply(exports,arguments)
},{"buffer":14,"dup":76}],105:[function(require,module,exports){
(function (setImmediate,clearImmediate){
var nextTick = require('process/browser.js').nextTick;
var apply = Function.prototype.apply;
var slice = Array.prototype.slice;
var immediateIds = {};
var nextImmediateId = 0;

// DOM APIs, for completeness

exports.setTimeout = function() {
  return new Timeout(apply.call(setTimeout, window, arguments), clearTimeout);
};
exports.setInterval = function() {
  return new Timeout(apply.call(setInterval, window, arguments), clearInterval);
};
exports.clearTimeout =
exports.clearInterval = function(timeout) { timeout.close(); };

function Timeout(id, clearFn) {
  this._id = id;
  this._clearFn = clearFn;
}
Timeout.prototype.unref = Timeout.prototype.ref = function() {};
Timeout.prototype.close = function() {
  this._clearFn.call(window, this._id);
};

// Does not start the time, just sets up the members needed.
exports.enroll = function(item, msecs) {
  clearTimeout(item._idleTimeoutId);
  item._idleTimeout = msecs;
};

exports.unenroll = function(item) {
  clearTimeout(item._idleTimeoutId);
  item._idleTimeout = -1;
};

exports._unrefActive = exports.active = function(item) {
  clearTimeout(item._idleTimeoutId);

  var msecs = item._idleTimeout;
  if (msecs >= 0) {
    item._idleTimeoutId = setTimeout(function onTimeout() {
      if (item._onTimeout)
        item._onTimeout();
    }, msecs);
  }
};

// That's not how node.js implements it but the exposed api is the same.
exports.setImmediate = typeof setImmediate === "function" ? setImmediate : function(fn) {
  var id = nextImmediateId++;
  var args = arguments.length < 2 ? false : slice.call(arguments, 1);

  immediateIds[id] = true;

  nextTick(function onNextTick() {
    if (immediateIds[id]) {
      // fn.call() is faster so we optimize for the common use-case
      // @see http://jsperf.com/call-apply-segu
      if (args) {
        fn.apply(null, args);
      } else {
        fn.call(null);
      }
      // Prevent ids from leaking
      exports.clearImmediate(id);
    }
  });

  return id;
};

exports.clearImmediate = typeof clearImmediate === "function" ? clearImmediate : function(id) {
  delete immediateIds[id];
};
}).call(this,require("timers").setImmediate,require("timers").clearImmediate)
},{"process/browser.js":63,"timers":105}],106:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var punycode = require('punycode');
var util = require('./util');

exports.parse = urlParse;
exports.resolve = urlResolve;
exports.resolveObject = urlResolveObject;
exports.format = urlFormat;

exports.Url = Url;

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

// Reference: RFC 3986, RFC 1808, RFC 2396

// define these here so at least they only have to be
// compiled once on the first module load.
var protocolPattern = /^([a-z0-9.+-]+:)/i,
    portPattern = /:[0-9]*$/,

    // Special case for a simple path URL
    simplePathPattern = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/,

    // RFC 2396: characters reserved for delimiting URLs.
    // We actually just auto-escape these.
    delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'],

    // RFC 2396: characters not allowed for various reasons.
    unwise = ['{', '}', '|', '\\', '^', '`'].concat(delims),

    // Allowed by RFCs, but cause of XSS attacks.  Always escape these.
    autoEscape = ['\''].concat(unwise),
    // Characters that are never ever allowed in a hostname.
    // Note that any invalid chars are also handled, but these
    // are the ones that are *expected* to be seen, so we fast-path
    // them.
    nonHostChars = ['%', '/', '?', ';', '#'].concat(autoEscape),
    hostEndingChars = ['/', '?', '#'],
    hostnameMaxLen = 255,
    hostnamePartPattern = /^[+a-z0-9A-Z_-]{0,63}$/,
    hostnamePartStart = /^([+a-z0-9A-Z_-]{0,63})(.*)$/,
    // protocols that can allow "unsafe" and "unwise" chars.
    unsafeProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that never have a hostname.
    hostlessProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that always contain a // bit.
    slashedProtocol = {
      'http': true,
      'https': true,
      'ftp': true,
      'gopher': true,
      'file': true,
      'http:': true,
      'https:': true,
      'ftp:': true,
      'gopher:': true,
      'file:': true
    },
    querystring = require('querystring');

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url && util.isObject(url) && url instanceof Url) return url;

  var u = new Url;
  u.parse(url, parseQueryString, slashesDenoteHost);
  return u;
}

Url.prototype.parse = function(url, parseQueryString, slashesDenoteHost) {
  if (!util.isString(url)) {
    throw new TypeError("Parameter 'url' must be a string, not " + typeof url);
  }

  // Copy chrome, IE, opera backslash-handling behavior.
  // Back slashes before the query string get converted to forward slashes
  // See: https://code.google.com/p/chromium/issues/detail?id=25916
  var queryIndex = url.indexOf('?'),
      splitter =
          (queryIndex !== -1 && queryIndex < url.indexOf('#')) ? '?' : '#',
      uSplit = url.split(splitter),
      slashRegex = /\\/g;
  uSplit[0] = uSplit[0].replace(slashRegex, '/');
  url = uSplit.join(splitter);

  var rest = url;

  // trim before proceeding.
  // This is to support parse stuff like "  http://foo.com  \n"
  rest = rest.trim();

  if (!slashesDenoteHost && url.split('#').length === 1) {
    // Try fast path regexp
    var simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      this.path = rest;
      this.href = rest;
      this.pathname = simplePath[1];
      if (simplePath[2]) {
        this.search = simplePath[2];
        if (parseQueryString) {
          this.query = querystring.parse(this.search.substr(1));
        } else {
          this.query = this.search.substr(1);
        }
      } else if (parseQueryString) {
        this.search = '';
        this.query = {};
      }
      return this;
    }
  }

  var proto = protocolPattern.exec(rest);
  if (proto) {
    proto = proto[0];
    var lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.substr(proto.length);
  }

  // figure out if it's got a host
  // user@server is *always* interpreted as a hostname, and url
  // resolution will treat //foo/bar as host=foo,path=bar because that's
  // how the browser resolves relative URLs.
  if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
    var slashes = rest.substr(0, 2) === '//';
    if (slashes && !(proto && hostlessProtocol[proto])) {
      rest = rest.substr(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol[proto] &&
      (slashes || (proto && !slashedProtocol[proto]))) {

    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    //
    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the last @ sign, unless some host-ending character
    // comes *before* the @-sign.
    // URLs are obnoxious.
    //
    // ex:
    // http://a@b@c/ => user:a@b host:c
    // http://a@b?@c => user:a host:c path:/?@c

    // v0.12 TODO(isaacs): This is not quite how Chrome does things.
    // Review our test case against browsers more comprehensively.

    // find the first instance of any hostEndingChars
    var hostEnd = -1;
    for (var i = 0; i < hostEndingChars.length; i++) {
      var hec = rest.indexOf(hostEndingChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }

    // at this point, either we have an explicit point where the
    // auth portion cannot go past, or the last @ char is the decider.
    var auth, atSign;
    if (hostEnd === -1) {
      // atSign can be anywhere.
      atSign = rest.lastIndexOf('@');
    } else {
      // atSign must be in auth portion.
      // http://a@b/c@d => host:b auth:a path:/c@d
      atSign = rest.lastIndexOf('@', hostEnd);
    }

    // Now we have a portion which is definitely the auth.
    // Pull that off.
    if (atSign !== -1) {
      auth = rest.slice(0, atSign);
      rest = rest.slice(atSign + 1);
      this.auth = decodeURIComponent(auth);
    }

    // the host is the remaining to the left of the first non-host char
    hostEnd = -1;
    for (var i = 0; i < nonHostChars.length; i++) {
      var hec = rest.indexOf(nonHostChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }
    // if we still have not hit it, then the entire thing is a host.
    if (hostEnd === -1)
      hostEnd = rest.length;

    this.host = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);

    // pull out port.
    this.parseHost();

    // we've indicated that there is a hostname,
    // so even if it's empty, it has to be present.
    this.hostname = this.hostname || '';

    // if hostname begins with [ and ends with ]
    // assume that it's an IPv6 address.
    var ipv6Hostname = this.hostname[0] === '[' &&
        this.hostname[this.hostname.length - 1] === ']';

    // validate a little.
    if (!ipv6Hostname) {
      var hostparts = this.hostname.split(/\./);
      for (var i = 0, l = hostparts.length; i < l; i++) {
        var part = hostparts[i];
        if (!part) continue;
        if (!part.match(hostnamePartPattern)) {
          var newpart = '';
          for (var j = 0, k = part.length; j < k; j++) {
            if (part.charCodeAt(j) > 127) {
              // we replace non-ASCII char with a temporary placeholder
              // we need this to make sure size of hostname is not
              // broken by replacing non-ASCII by nothing
              newpart += 'x';
            } else {
              newpart += part[j];
            }
          }
          // we test again with ASCII char only
          if (!newpart.match(hostnamePartPattern)) {
            var validParts = hostparts.slice(0, i);
            var notHost = hostparts.slice(i + 1);
            var bit = part.match(hostnamePartStart);
            if (bit) {
              validParts.push(bit[1]);
              notHost.unshift(bit[2]);
            }
            if (notHost.length) {
              rest = '/' + notHost.join('.') + rest;
            }
            this.hostname = validParts.join('.');
            break;
          }
        }
      }
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = '';
    } else {
      // hostnames are always lower case.
      this.hostname = this.hostname.toLowerCase();
    }

    if (!ipv6Hostname) {
      // IDNA Support: Returns a punycoded representation of "domain".
      // It only converts parts of the domain name that
      // have non-ASCII characters, i.e. it doesn't matter if
      // you call it with a domain that already is ASCII-only.
      this.hostname = punycode.toASCII(this.hostname);
    }

    var p = this.port ? ':' + this.port : '';
    var h = this.hostname || '';
    this.host = h + p;
    this.href += this.host;

    // strip [ and ] from the hostname
    // the host field still retains them, though
    if (ipv6Hostname) {
      this.hostname = this.hostname.substr(1, this.hostname.length - 2);
      if (rest[0] !== '/') {
        rest = '/' + rest;
      }
    }
  }

  // now rest is set to the post-host stuff.
  // chop off any delim chars.
  if (!unsafeProtocol[lowerProto]) {

    // First, make 100% sure that any "autoEscape" chars get
    // escaped, even if encodeURIComponent doesn't think they
    // need to be.
    for (var i = 0, l = autoEscape.length; i < l; i++) {
      var ae = autoEscape[i];
      if (rest.indexOf(ae) === -1)
        continue;
      var esc = encodeURIComponent(ae);
      if (esc === ae) {
        esc = escape(ae);
      }
      rest = rest.split(ae).join(esc);
    }
  }


  // chop off from the tail first.
  var hash = rest.indexOf('#');
  if (hash !== -1) {
    // got a fragment string.
    this.hash = rest.substr(hash);
    rest = rest.slice(0, hash);
  }
  var qm = rest.indexOf('?');
  if (qm !== -1) {
    this.search = rest.substr(qm);
    this.query = rest.substr(qm + 1);
    if (parseQueryString) {
      this.query = querystring.parse(this.query);
    }
    rest = rest.slice(0, qm);
  } else if (parseQueryString) {
    // no query string, but parseQueryString still requested
    this.search = '';
    this.query = {};
  }
  if (rest) this.pathname = rest;
  if (slashedProtocol[lowerProto] &&
      this.hostname && !this.pathname) {
    this.pathname = '/';
  }

  //to support http.request
  if (this.pathname || this.search) {
    var p = this.pathname || '';
    var s = this.search || '';
    this.path = p + s;
  }

  // finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

// format a parsed object into a url string
function urlFormat(obj) {
  // ensure it's an object, and not a string url.
  // If it's an obj, this is a no-op.
  // this way, you can call url_format() on strings
  // to clean up potentially wonky urls.
  if (util.isString(obj)) obj = urlParse(obj);
  if (!(obj instanceof Url)) return Url.prototype.format.call(obj);
  return obj.format();
}

Url.prototype.format = function() {
  var auth = this.auth || '';
  if (auth) {
    auth = encodeURIComponent(auth);
    auth = auth.replace(/%3A/i, ':');
    auth += '@';
  }

  var protocol = this.protocol || '',
      pathname = this.pathname || '',
      hash = this.hash || '',
      host = false,
      query = '';

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (this.hostname.indexOf(':') === -1 ?
        this.hostname :
        '[' + this.hostname + ']');
    if (this.port) {
      host += ':' + this.port;
    }
  }

  if (this.query &&
      util.isObject(this.query) &&
      Object.keys(this.query).length) {
    query = querystring.stringify(this.query);
  }

  var search = this.search || (query && ('?' + query)) || '';

  if (protocol && protocol.substr(-1) !== ':') protocol += ':';

  // only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (this.slashes ||
      (!protocol || slashedProtocol[protocol]) && host !== false) {
    host = '//' + (host || '');
    if (pathname && pathname.charAt(0) !== '/') pathname = '/' + pathname;
  } else if (!host) {
    host = '';
  }

  if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
  if (search && search.charAt(0) !== '?') search = '?' + search;

  pathname = pathname.replace(/[?#]/g, function(match) {
    return encodeURIComponent(match);
  });
  search = search.replace('#', '%23');

  return protocol + host + pathname + search + hash;
};

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

Url.prototype.resolveObject = function(relative) {
  if (util.isString(relative)) {
    var rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  var result = new Url();
  var tkeys = Object.keys(this);
  for (var tk = 0; tk < tkeys.length; tk++) {
    var tkey = tkeys[tk];
    result[tkey] = this[tkey];
  }

  // hash is always overridden, no matter what.
  // even href="" will remove it.
  result.hash = relative.hash;

  // if the relative url is empty, then there's nothing left to do here.
  if (relative.href === '') {
    result.href = result.format();
    return result;
  }

  // hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // take everything except the protocol from relative
    var rkeys = Object.keys(relative);
    for (var rk = 0; rk < rkeys.length; rk++) {
      var rkey = rkeys[rk];
      if (rkey !== 'protocol')
        result[rkey] = relative[rkey];
    }

    //urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol[result.protocol] &&
        result.hostname && !result.pathname) {
      result.path = result.pathname = '/';
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // if it's a known url protocol, then changing
    // the protocol does weird things
    // first, if it's not file:, then we MUST have a host,
    // and if there was a path
    // to begin with, then we MUST have a path.
    // if it is file:, then the host is dropped,
    // because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol[relative.protocol]) {
      var keys = Object.keys(relative);
      for (var v = 0; v < keys.length; v++) {
        var k = keys[v];
        result[k] = relative[k];
      }
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host && !hostlessProtocol[relative.protocol]) {
      var relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      if (!relative.host) relative.host = '';
      if (!relative.hostname) relative.hostname = '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      result.pathname = relPath.join('/');
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || '';
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // to support http.request
    if (result.pathname || result.search) {
      var p = result.pathname || '';
      var s = result.search || '';
      result.path = p + s;
    }
    result.slashes = result.slashes || relative.slashes;
    result.href = result.format();
    return result;
  }

  var isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/'),
      isRelAbs = (
          relative.host ||
          relative.pathname && relative.pathname.charAt(0) === '/'
      ),
      mustEndAbs = (isRelAbs || isSourceAbs ||
                    (result.host && relative.pathname)),
      removeAllDots = mustEndAbs,
      srcPath = result.pathname && result.pathname.split('/') || [],
      relPath = relative.pathname && relative.pathname.split('/') || [],
      psychotic = result.protocol && !slashedProtocol[result.protocol];

  // if the url is a non-slashed url, then relative
  // links like ../.. should be able
  // to crawl up to the hostname, as well.  This is strange.
  // result.protocol has already been set by now.
  // Later on, put the first path part into the host field.
  if (psychotic) {
    result.hostname = '';
    result.port = null;
    if (result.host) {
      if (srcPath[0] === '') srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = '';
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    // it's absolute.
    result.host = (relative.host || relative.host === '') ?
                  relative.host : result.host;
    result.hostname = (relative.hostname || relative.hostname === '') ?
                      relative.hostname : result.hostname;
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative
    // throw away the existing file, and take the new path instead.
    if (!srcPath) srcPath = [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (!util.isNullOrUndefined(relative.search)) {
    // just pull out the search.
    // like href='?foo'.
    // Put this after the other two cases because it simplifies the booleans
    if (psychotic) {
      result.hostname = result.host = srcPath.shift();
      //occationaly the auth can get stuck only in host
      //this especially happens in cases like
      //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      var authInHost = result.host && result.host.indexOf('@') > 0 ?
                       result.host.split('@') : false;
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    //to support http.request
    if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
      result.path = (result.pathname ? result.pathname : '') +
                    (result.search ? result.search : '');
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // no path at all.  easy.
    // we've already handled the other stuff above.
    result.pathname = null;
    //to support http.request
    if (result.search) {
      result.path = '/' + result.search;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // if a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  var last = srcPath.slice(-1)[0];
  var hasTrailingSlash = (
      (result.host || relative.host || srcPath.length > 1) &&
      (last === '.' || last === '..') || last === '');

  // strip single dots, resolve double dots to parent dir
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = srcPath.length; i >= 0; i--) {
    last = srcPath[i];
    if (last === '.') {
      srcPath.splice(i, 1);
    } else if (last === '..') {
      srcPath.splice(i, 1);
      up++;
    } else if (up) {
      srcPath.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    for (; up--; up) {
      srcPath.unshift('..');
    }
  }

  if (mustEndAbs && srcPath[0] !== '' &&
      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
    srcPath.push('');
  }

  var isAbsolute = srcPath[0] === '' ||
      (srcPath[0] && srcPath[0].charAt(0) === '/');

  // put the host back
  if (psychotic) {
    result.hostname = result.host = isAbsolute ? '' :
                                    srcPath.length ? srcPath.shift() : '';
    //occationaly the auth can get stuck only in host
    //this especially happens in cases like
    //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    var authInHost = result.host && result.host.indexOf('@') > 0 ?
                     result.host.split('@') : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs = mustEndAbs || (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift('');
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join('/');
  }

  //to support request.http
  if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
    result.path = (result.pathname ? result.pathname : '') +
                  (result.search ? result.search : '');
  }
  result.auth = relative.auth || result.auth;
  result.slashes = result.slashes || relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function() {
  var host = this.host;
  var port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ':') {
      this.port = port.substr(1);
    }
    host = host.substr(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

},{"./util":107,"punycode":13,"querystring":66}],107:[function(require,module,exports){
'use strict';

module.exports = {
  isString: function(arg) {
    return typeof(arg) === 'string';
  },
  isObject: function(arg) {
    return typeof(arg) === 'object' && arg !== null;
  },
  isNull: function(arg) {
    return arg === null;
  },
  isNullOrUndefined: function(arg) {
    return arg == null;
  }
};

},{}],108:[function(require,module,exports){
(function (global){

/**
 * Module exports.
 */

module.exports = deprecate;

/**
 * Mark that a method should not be used.
 * Returns a modified function which warns once by default.
 *
 * If `localStorage.noDeprecation = true` is set, then it is a no-op.
 *
 * If `localStorage.throwDeprecation = true` is set, then deprecated functions
 * will throw an Error when invoked.
 *
 * If `localStorage.traceDeprecation = true` is set, then deprecated functions
 * will invoke `console.trace()` instead of `console.error()`.
 *
 * @param {Function} fn - the function to deprecate
 * @param {String} msg - the string to print to the console when `fn` is invoked
 * @returns {Function} a new "deprecated" version of `fn`
 * @api public
 */

function deprecate (fn, msg) {
  if (config('noDeprecation')) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (config('throwDeprecation')) {
        throw new Error(msg);
      } else if (config('traceDeprecation')) {
        console.trace(msg);
      } else {
        console.warn(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
}

/**
 * Checks `localStorage` for boolean values for the given `name`.
 *
 * @param {String} name
 * @returns {Boolean}
 * @api private
 */

function config (name) {
  // accessing global.localStorage can trigger a DOMException in sandboxed iframes
  try {
    if (!global.localStorage) return false;
  } catch (_) {
    return false;
  }
  var val = global.localStorage[name];
  if (null == val) return false;
  return String(val).toLowerCase() === 'true';
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],109:[function(require,module,exports){
(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
  typeof define === 'function' && define.amd ? define(['exports'], factory) :
  (factory((global.WHATWGFetch = {})));
}(this, (function (exports) { 'use strict';

  var support = {
    searchParams: 'URLSearchParams' in self,
    iterable: 'Symbol' in self && 'iterator' in Symbol,
    blob:
      'FileReader' in self &&
      'Blob' in self &&
      (function() {
        try {
          new Blob();
          return true
        } catch (e) {
          return false
        }
      })(),
    formData: 'FormData' in self,
    arrayBuffer: 'ArrayBuffer' in self
  };

  function isDataView(obj) {
    return obj && DataView.prototype.isPrototypeOf(obj)
  }

  if (support.arrayBuffer) {
    var viewClasses = [
      '[object Int8Array]',
      '[object Uint8Array]',
      '[object Uint8ClampedArray]',
      '[object Int16Array]',
      '[object Uint16Array]',
      '[object Int32Array]',
      '[object Uint32Array]',
      '[object Float32Array]',
      '[object Float64Array]'
    ];

    var isArrayBufferView =
      ArrayBuffer.isView ||
      function(obj) {
        return obj && viewClasses.indexOf(Object.prototype.toString.call(obj)) > -1
      };
  }

  function normalizeName(name) {
    if (typeof name !== 'string') {
      name = String(name);
    }
    if (/[^a-z0-9\-#$%&'*+.^_`|~]/i.test(name)) {
      throw new TypeError('Invalid character in header field name')
    }
    return name.toLowerCase()
  }

  function normalizeValue(value) {
    if (typeof value !== 'string') {
      value = String(value);
    }
    return value
  }

  // Build a destructive iterator for the value list
  function iteratorFor(items) {
    var iterator = {
      next: function() {
        var value = items.shift();
        return {done: value === undefined, value: value}
      }
    };

    if (support.iterable) {
      iterator[Symbol.iterator] = function() {
        return iterator
      };
    }

    return iterator
  }

  function Headers(headers) {
    this.map = {};

    if (headers instanceof Headers) {
      headers.forEach(function(value, name) {
        this.append(name, value);
      }, this);
    } else if (Array.isArray(headers)) {
      headers.forEach(function(header) {
        this.append(header[0], header[1]);
      }, this);
    } else if (headers) {
      Object.getOwnPropertyNames(headers).forEach(function(name) {
        this.append(name, headers[name]);
      }, this);
    }
  }

  Headers.prototype.append = function(name, value) {
    name = normalizeName(name);
    value = normalizeValue(value);
    var oldValue = this.map[name];
    this.map[name] = oldValue ? oldValue + ', ' + value : value;
  };

  Headers.prototype['delete'] = function(name) {
    delete this.map[normalizeName(name)];
  };

  Headers.prototype.get = function(name) {
    name = normalizeName(name);
    return this.has(name) ? this.map[name] : null
  };

  Headers.prototype.has = function(name) {
    return this.map.hasOwnProperty(normalizeName(name))
  };

  Headers.prototype.set = function(name, value) {
    this.map[normalizeName(name)] = normalizeValue(value);
  };

  Headers.prototype.forEach = function(callback, thisArg) {
    for (var name in this.map) {
      if (this.map.hasOwnProperty(name)) {
        callback.call(thisArg, this.map[name], name, this);
      }
    }
  };

  Headers.prototype.keys = function() {
    var items = [];
    this.forEach(function(value, name) {
      items.push(name);
    });
    return iteratorFor(items)
  };

  Headers.prototype.values = function() {
    var items = [];
    this.forEach(function(value) {
      items.push(value);
    });
    return iteratorFor(items)
  };

  Headers.prototype.entries = function() {
    var items = [];
    this.forEach(function(value, name) {
      items.push([name, value]);
    });
    return iteratorFor(items)
  };

  if (support.iterable) {
    Headers.prototype[Symbol.iterator] = Headers.prototype.entries;
  }

  function consumed(body) {
    if (body.bodyUsed) {
      return Promise.reject(new TypeError('Already read'))
    }
    body.bodyUsed = true;
  }

  function fileReaderReady(reader) {
    return new Promise(function(resolve, reject) {
      reader.onload = function() {
        resolve(reader.result);
      };
      reader.onerror = function() {
        reject(reader.error);
      };
    })
  }

  function readBlobAsArrayBuffer(blob) {
    var reader = new FileReader();
    var promise = fileReaderReady(reader);
    reader.readAsArrayBuffer(blob);
    return promise
  }

  function readBlobAsText(blob) {
    var reader = new FileReader();
    var promise = fileReaderReady(reader);
    reader.readAsText(blob);
    return promise
  }

  function readArrayBufferAsText(buf) {
    var view = new Uint8Array(buf);
    var chars = new Array(view.length);

    for (var i = 0; i < view.length; i++) {
      chars[i] = String.fromCharCode(view[i]);
    }
    return chars.join('')
  }

  function bufferClone(buf) {
    if (buf.slice) {
      return buf.slice(0)
    } else {
      var view = new Uint8Array(buf.byteLength);
      view.set(new Uint8Array(buf));
      return view.buffer
    }
  }

  function Body() {
    this.bodyUsed = false;

    this._initBody = function(body) {
      this._bodyInit = body;
      if (!body) {
        this._bodyText = '';
      } else if (typeof body === 'string') {
        this._bodyText = body;
      } else if (support.blob && Blob.prototype.isPrototypeOf(body)) {
        this._bodyBlob = body;
      } else if (support.formData && FormData.prototype.isPrototypeOf(body)) {
        this._bodyFormData = body;
      } else if (support.searchParams && URLSearchParams.prototype.isPrototypeOf(body)) {
        this._bodyText = body.toString();
      } else if (support.arrayBuffer && support.blob && isDataView(body)) {
        this._bodyArrayBuffer = bufferClone(body.buffer);
        // IE 10-11 can't handle a DataView body.
        this._bodyInit = new Blob([this._bodyArrayBuffer]);
      } else if (support.arrayBuffer && (ArrayBuffer.prototype.isPrototypeOf(body) || isArrayBufferView(body))) {
        this._bodyArrayBuffer = bufferClone(body);
      } else {
        this._bodyText = body = Object.prototype.toString.call(body);
      }

      if (!this.headers.get('content-type')) {
        if (typeof body === 'string') {
          this.headers.set('content-type', 'text/plain;charset=UTF-8');
        } else if (this._bodyBlob && this._bodyBlob.type) {
          this.headers.set('content-type', this._bodyBlob.type);
        } else if (support.searchParams && URLSearchParams.prototype.isPrototypeOf(body)) {
          this.headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
        }
      }
    };

    if (support.blob) {
      this.blob = function() {
        var rejected = consumed(this);
        if (rejected) {
          return rejected
        }

        if (this._bodyBlob) {
          return Promise.resolve(this._bodyBlob)
        } else if (this._bodyArrayBuffer) {
          return Promise.resolve(new Blob([this._bodyArrayBuffer]))
        } else if (this._bodyFormData) {
          throw new Error('could not read FormData body as blob')
        } else {
          return Promise.resolve(new Blob([this._bodyText]))
        }
      };

      this.arrayBuffer = function() {
        if (this._bodyArrayBuffer) {
          return consumed(this) || Promise.resolve(this._bodyArrayBuffer)
        } else {
          return this.blob().then(readBlobAsArrayBuffer)
        }
      };
    }

    this.text = function() {
      var rejected = consumed(this);
      if (rejected) {
        return rejected
      }

      if (this._bodyBlob) {
        return readBlobAsText(this._bodyBlob)
      } else if (this._bodyArrayBuffer) {
        return Promise.resolve(readArrayBufferAsText(this._bodyArrayBuffer))
      } else if (this._bodyFormData) {
        throw new Error('could not read FormData body as text')
      } else {
        return Promise.resolve(this._bodyText)
      }
    };

    if (support.formData) {
      this.formData = function() {
        return this.text().then(decode)
      };
    }

    this.json = function() {
      return this.text().then(JSON.parse)
    };

    return this
  }

  // HTTP methods whose capitalization should be normalized
  var methods = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'];

  function normalizeMethod(method) {
    var upcased = method.toUpperCase();
    return methods.indexOf(upcased) > -1 ? upcased : method
  }

  function Request(input, options) {
    options = options || {};
    var body = options.body;

    if (input instanceof Request) {
      if (input.bodyUsed) {
        throw new TypeError('Already read')
      }
      this.url = input.url;
      this.credentials = input.credentials;
      if (!options.headers) {
        this.headers = new Headers(input.headers);
      }
      this.method = input.method;
      this.mode = input.mode;
      this.signal = input.signal;
      if (!body && input._bodyInit != null) {
        body = input._bodyInit;
        input.bodyUsed = true;
      }
    } else {
      this.url = String(input);
    }

    this.credentials = options.credentials || this.credentials || 'same-origin';
    if (options.headers || !this.headers) {
      this.headers = new Headers(options.headers);
    }
    this.method = normalizeMethod(options.method || this.method || 'GET');
    this.mode = options.mode || this.mode || null;
    this.signal = options.signal || this.signal;
    this.referrer = null;

    if ((this.method === 'GET' || this.method === 'HEAD') && body) {
      throw new TypeError('Body not allowed for GET or HEAD requests')
    }
    this._initBody(body);
  }

  Request.prototype.clone = function() {
    return new Request(this, {body: this._bodyInit})
  };

  function decode(body) {
    var form = new FormData();
    body
      .trim()
      .split('&')
      .forEach(function(bytes) {
        if (bytes) {
          var split = bytes.split('=');
          var name = split.shift().replace(/\+/g, ' ');
          var value = split.join('=').replace(/\+/g, ' ');
          form.append(decodeURIComponent(name), decodeURIComponent(value));
        }
      });
    return form
  }

  function parseHeaders(rawHeaders) {
    var headers = new Headers();
    // Replace instances of \r\n and \n followed by at least one space or horizontal tab with a space
    // https://tools.ietf.org/html/rfc7230#section-3.2
    var preProcessedHeaders = rawHeaders.replace(/\r?\n[\t ]+/g, ' ');
    preProcessedHeaders.split(/\r?\n/).forEach(function(line) {
      var parts = line.split(':');
      var key = parts.shift().trim();
      if (key) {
        var value = parts.join(':').trim();
        headers.append(key, value);
      }
    });
    return headers
  }

  Body.call(Request.prototype);

  function Response(bodyInit, options) {
    if (!options) {
      options = {};
    }

    this.type = 'default';
    this.status = options.status === undefined ? 200 : options.status;
    this.ok = this.status >= 200 && this.status < 300;
    this.statusText = 'statusText' in options ? options.statusText : 'OK';
    this.headers = new Headers(options.headers);
    this.url = options.url || '';
    this._initBody(bodyInit);
  }

  Body.call(Response.prototype);

  Response.prototype.clone = function() {
    return new Response(this._bodyInit, {
      status: this.status,
      statusText: this.statusText,
      headers: new Headers(this.headers),
      url: this.url
    })
  };

  Response.error = function() {
    var response = new Response(null, {status: 0, statusText: ''});
    response.type = 'error';
    return response
  };

  var redirectStatuses = [301, 302, 303, 307, 308];

  Response.redirect = function(url, status) {
    if (redirectStatuses.indexOf(status) === -1) {
      throw new RangeError('Invalid status code')
    }

    return new Response(null, {status: status, headers: {location: url}})
  };

  exports.DOMException = self.DOMException;
  try {
    new exports.DOMException();
  } catch (err) {
    exports.DOMException = function(message, name) {
      this.message = message;
      this.name = name;
      var error = Error(message);
      this.stack = error.stack;
    };
    exports.DOMException.prototype = Object.create(Error.prototype);
    exports.DOMException.prototype.constructor = exports.DOMException;
  }

  function fetch(input, init) {
    return new Promise(function(resolve, reject) {
      var request = new Request(input, init);

      if (request.signal && request.signal.aborted) {
        return reject(new exports.DOMException('Aborted', 'AbortError'))
      }

      var xhr = new XMLHttpRequest();

      function abortXhr() {
        xhr.abort();
      }

      xhr.onload = function() {
        var options = {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: parseHeaders(xhr.getAllResponseHeaders() || '')
        };
        options.url = 'responseURL' in xhr ? xhr.responseURL : options.headers.get('X-Request-URL');
        var body = 'response' in xhr ? xhr.response : xhr.responseText;
        resolve(new Response(body, options));
      };

      xhr.onerror = function() {
        reject(new TypeError('Network request failed'));
      };

      xhr.ontimeout = function() {
        reject(new TypeError('Network request failed'));
      };

      xhr.onabort = function() {
        reject(new exports.DOMException('Aborted', 'AbortError'));
      };

      xhr.open(request.method, request.url, true);

      if (request.credentials === 'include') {
        xhr.withCredentials = true;
      } else if (request.credentials === 'omit') {
        xhr.withCredentials = false;
      }

      if ('responseType' in xhr && support.blob) {
        xhr.responseType = 'blob';
      }

      request.headers.forEach(function(value, name) {
        xhr.setRequestHeader(name, value);
      });

      if (request.signal) {
        request.signal.addEventListener('abort', abortXhr);

        xhr.onreadystatechange = function() {
          // DONE (success or failure)
          if (xhr.readyState === 4) {
            request.signal.removeEventListener('abort', abortXhr);
          }
        };
      }

      xhr.send(typeof request._bodyInit === 'undefined' ? null : request._bodyInit);
    })
  }

  fetch.polyfill = true;

  if (!self.fetch) {
    self.fetch = fetch;
    self.Headers = Headers;
    self.Request = Request;
    self.Response = Response;
  }

  exports.Headers = Headers;
  exports.Request = Request;
  exports.Response = Response;
  exports.fetch = fetch;

  Object.defineProperty(exports, '__esModule', { value: true });

})));

},{}],110:[function(require,module,exports){
module.exports = extend

var hasOwnProperty = Object.prototype.hasOwnProperty;

function extend() {
    var target = {}

    for (var i = 0; i < arguments.length; i++) {
        var source = arguments[i]

        for (var key in source) {
            if (hasOwnProperty.call(source, key)) {
                target[key] = source[key]
            }
        }
    }

    return target
}

},{}],111:[function(require,module,exports){
module.exports = {"http://datashapes.org/js/dash.js":"// Functions implementing the validators of SHACL-JS\n// Also include validators for the constraint components of the DASH namespace\n\n// Also included: implementations of the standard DASH functions\n\n// There is no validator for sh:property as this is expected to be\n// natively implemented by the surrounding engine.\n\nvar XSDIntegerTypes = new NodeSet();\nXSDIntegerTypes.add(T(\"xsd:integer\"));\n\nvar XSDDecimalTypes = new NodeSet();\nXSDDecimalTypes.addAll(XSDIntegerTypes.toArray());\nXSDDecimalTypes.add(T(\"xsd:decimal\"));\nXSDDecimalTypes.add(T(\"xsd:float\"));\n\nfunction validateAnd($value, $and) {\n\tvar shapes = new RDFQueryUtil($shapes).rdfListToArray($and);\n\tfor(var i = 0; i < shapes.length; i++) {\n\t\tif(!SHACL.nodeConformsToShape($value, shapes[i])) {\n\t\t\treturn false;\n\t\t}\n\t}\n\treturn true;\n}\n\nfunction validateClass($value, $class) {\n\treturn new RDFQueryUtil($data).isInstanceOf($value, $class);\n}\n\nfunction validateClosed($value, $closed, $ignoredProperties, $currentShape) {\n\tif(!T(\"true\").equals($closed)) {\n\t\treturn;\n\t}\n\tvar allowed = $shapes.query().\n\t\tmatch($currentShape, \"sh:property\", \"?propertyShape\").\n\t\tmatch(\"?propertyShape\", \"sh:path\", \"?path\").\n\t\tfilter(function(solution) { return solution.path.isURI() } ).\n\t\tgetNodeSet(\"?path\");\n\tif($ignoredProperties) {\n\t\tallowed.addAll(new RDFQueryUtil($shapes).rdfListToArray($ignoredProperties));\n\t}\n\tvar results = [];\n\t$data.query().\n\t\tmatch($value, \"?predicate\", \"?object\").\n\t\tfilter(function(sol) { return !allowed.contains(sol.predicate)}).\n\t\tforEach(function(sol) { \n\t\t\tresults.push({ \n\t\t\t\tpath : sol.predicate,\n\t\t\t\tvalue : sol.object\n\t\t\t});\n\t\t});\n\treturn results;\n}\n\nfunction validateClosedByTypesNode($this, $closedByTypes) {\n\tif(!T(\"true\").equals($closedByTypes)) {\n\t\treturn;\n\t}\n\tvar results = [];\n\tvar allowedProperties = new NodeSet();\n\t$data.query().\n\t\tmatch($this, \"rdf:type\", \"?directType\").\n\t\tpath(\"?directType\", { zeroOrMore : T(\"rdfs:subClassOf\") }, \"?type\").\n\t\tforEachNode(\"?type\", function(type) {\n\t\t\t$shapes.query().\n\t\t\t\tmatch(type, \"sh:property\", \"?pshape\").\n\t\t\t\tmatch(\"?pshape\", \"sh:path\", \"?path\").\n\t\t\t\tfilter(function(sol) { return sol.path.isURI() }).\n\t\t\t\taddAllNodes(\"?path\", allowedProperties);\n\t\t});\n\t$data.query().\n\t\tmatch($this, \"?predicate\", \"?object\").\n\t\tfilter(function(sol) { return !T(\"rdf:type\").equals(sol.predicate) }).\n\t\tfilter(function(sol) { return !allowedProperties.contains(sol.predicate) }).\n\t\tforEach(function(sol) {\n\t\t\tresults.push({\n\t\t\t\tpath: sol.predicate,\n\t\t\t\tvalue: sol.object\n\t\t\t});\n\t\t})\n\treturn results;\n}\n\nfunction validateCoExistsWith($this, $path, $coExistsWith) {\n\tvar path = toRDFQueryPath($path);\n\tvar has1 = $data.query().path($this, path, null).getCount() > 0;\n\tvar has2 = $data.query().match($this, $coExistsWith, null).getCount() > 0;\n\treturn has1 == has2;\n}\n\nfunction validateDatatype($value, $datatype) {\n\tif($value.isLiteral()) {\n\t\treturn $datatype.equals($value.datatype) && isValidForDatatype($value.lex, $datatype);\n\t}\n\telse {\n\t\treturn false;\n\t}\n}\n\nfunction validateDisjoint($this, $value, $disjoint) {\n\treturn !$data.query().match($this, $disjoint, $value).hasSolution();\n}\n\nfunction validateEqualsProperty($this, $path, $equals) {\n\tvar results = [];\n\tvar path = toRDFQueryPath($path);\n\t$data.query().path($this, path, \"?value\").forEach(\n\t\tfunction(solution) {\n\t\t\tif(!$data.query().match($this, $equals, solution.value).hasSolution()) {\n\t\t\t\tresults.push({\n\t\t\t\t\tvalue: solution.value\n\t\t\t\t});\n\t\t\t}\n\t\t});\n\t$data.query().match($this, $equals, \"?value\").forEach(\n\t\tfunction(solution) {\n\t\t\tif(!$data.query().path($this, path, solution.value).hasSolution()) {\n\t\t\t\tresults.push({\n\t\t\t\t\tvalue: solution.value\n\t\t\t\t});\n\t\t\t}\n\t\t});\n\treturn results;\n}\n\nvar validateEqualsNode = function ($this, $equals) {\n    var results = [];\n    var solutions = 0;\n    $data.query().path($this, $equals, \"?value\").forEach(\n        function (solution) {\n            solutions++;\n            if (SHACL.compareNodes($this, solution['value']) !== 0) {\n                results.push({\n                    value: solution.value\n                });\n            }\n        });\n    if (results.length === 0 && solutions === 0) {\n        results.push({\n            value: $this\n        });\n    }\n    return results;\n};\n\nfunction validateHasValueNode($this, $hasValue) {\n\treturn $this.equals($hasValue);\n}\n\nfunction validateHasValueProperty($this, $path, $hasValue) {\n\tvar count = $data.query().path($this, toRDFQueryPath($path), $hasValue).getCount();\n\treturn count > 0;\n}\n\nfunction validateHasValueWithClass($this, $path, $hasValueWithClass) {\n\treturn $data.query().\n\t\t\tpath($this, toRDFQueryPath($path), \"?value\").\n\t\t\tfilter(function(sol) { return new RDFQueryUtil($data).isInstanceOf(sol.value, $hasValueWithClass) }).\n\t\t\thasSolution();\n}\n\nfunction validateIn($value, $in) {\n\tvar set = new NodeSet();\n\tset.addAll(new RDFQueryUtil($shapes).rdfListToArray($in));\n\treturn set.contains($value);\n}\n\nfunction validateLanguageIn($value, $languageIn) {\n\tif(!$value.isLiteral()) {\n\t\treturn false;\n\t}\n\tvar lang = $value.language;\n\tif(!lang || lang === \"\") {\n\t\treturn false;\n\t}\n\tvar ls = new RDFQueryUtil($shapes).rdfListToArray($languageIn);\n\tfor(var i = 0; i < ls.length; i++) {\n\t\tif(lang.startsWith(ls[i].lex)) {\n\t\t\treturn true;\n\t\t}\n\t}\n\treturn false;\n}\n\nfunction validateLessThanProperty($this, $path, $lessThan) {\n\tvar results = [];\n\t$data.query().\n\t\tpath($this, toRDFQueryPath($path), \"?value\").\n\t\tmatch($this, $lessThan, \"?otherValue\").\n\t\tforEach(function(sol) {\n\t\t\t\t\tvar c = SHACL.compareNodes(sol.value, sol.otherValue);\n\t\t\t\t\tif(c == null || c >= 0) {\n\t\t\t\t\t\tresults.push({\n\t\t\t\t\t\t\tvalue: sol.value\n\t\t\t\t\t\t});\n\t\t\t\t\t}\n\t\t\t\t});\n\treturn results;\n}\n\nfunction validateLessThanOrEqualsProperty($this, $path, $lessThanOrEquals) {\n\tvar results = [];\n\t$data.query().\n\t\tpath($this, toRDFQueryPath($path), \"?value\").\n\t\tmatch($this, $lessThanOrEquals, \"?otherValue\").\n\t\tforEach(function(sol) {\n\t\t\t\t\tvar c = SHACL.compareNodes(sol.value, sol.otherValue);\n\t\t\t\t\tif(c == null || c > 0) {\n\t\t\t\t\t\tresults.push({\n\t\t\t\t\t\t\tvalue: sol.value\n\t\t\t\t\t\t});\n\t\t\t\t\t}\n\t\t\t\t});\n\treturn results;\n}\n\nfunction validateMaxCountProperty($this, $path, $maxCount) {\n\tvar count = $data.query().path($this, toRDFQueryPath($path), \"?any\").getCount();\n\treturn count <= Number($maxCount.value);\n}\n\nfunction validateMaxExclusive($value, $maxExclusive) {\n\treturn $value.isLiteral() && Number($value.lex) < Number($maxExclusive.lex);\n}\n\nfunction validateMaxInclusive($value, $maxInclusive) {\n\treturn $value.isLiteral() && Number($value.lex) <= Number($maxInclusive.lex);\n}\n\nfunction validateMaxLength($value, $maxLength) {\n\tif($value.isBlankNode()) {\n\t\treturn false;\n\t}\n\treturn $value.value.length <= Number($maxLength.lex);\n}\n\nfunction validateMinCountProperty($this, $path, $minCount) {\n\tvar count = $data.query().path($this, toRDFQueryPath($path), \"?any\").getCount();\n\treturn count >= Number($minCount.value);\n}\n\nfunction validateMinExclusive($value, $minExclusive) {\n\treturn $value.isLiteral() && Number($value.lex) > Number($minExclusive.lex);\n}\n\nfunction validateMinInclusive($value, $minInclusive) {\n\treturn $value.isLiteral() && Number($value.lex) >= Number($minInclusive.lex);\n}\n\nfunction validateMinLength($value, $minLength) {\n\tif($value.isBlankNode()) {\n\t\treturn false;\n\t}\n\treturn $value.value.length >= Number($minLength.lex);\n}\n\nfunction validateNodeKind($value, $nodeKind) {\n\tif($value.isBlankNode()) {\n\t\treturn T(\"sh:BlankNode\").equals($nodeKind) || \n\t\t\tT(\"sh:BlankNodeOrIRI\").equals($nodeKind) ||\n\t\t\tT(\"sh:BlankNodeOrLiteral\").equals($nodeKind);\n\t}\n\telse if($value.isURI()) {\n\t\treturn T(\"sh:IRI\").equals($nodeKind) || \n\t\t\tT(\"sh:BlankNodeOrIRI\").equals($nodeKind) ||\n\t\t\tT(\"sh:IRIOrLiteral\").equals($nodeKind);\n\t}\n\telse if($value.isLiteral()) {\n\t\treturn T(\"sh:Literal\").equals($nodeKind) || \n\t\t\tT(\"sh:BlankNodeOrLiteral\").equals($nodeKind) ||\n\t\t\tT(\"sh:IRIOrLiteral\").equals($nodeKind);\n\t}\n}\n\nfunction validateNode($value, $node) {\n\treturn SHACL.nodeConformsToShape($value, $node);\n}\n\nfunction validateNonRecursiveProperty($this, $path, $nonRecursive) {\n\tif(T(\"true\").equals($nonRecursive)) {\n\t\tif($data.query().path($this, toRDFQueryPath($path), $this).hasSolution()) {\n\t\t\treturn {\n\t\t\t\tpath: $path,\n\t\t\t\tvalue: $this\n\t\t\t}\n\t\t}\n\t}\n}\n\nfunction validateNot($value, $not) {\n\treturn !SHACL.nodeConformsToShape($value, $not);\n}\n\nfunction validateOr($value, $or) {\n\tvar shapes = new RDFQueryUtil($shapes).rdfListToArray($or);\n\tfor(var i = 0; i < shapes.length; i++) {\n\t\tif(SHACL.nodeConformsToShape($value, shapes[i])) {\n\t\t\treturn true;\n\t\t}\n\t}\n\treturn false;\n}\n\nfunction validatePattern($value, $pattern, $flags) {\n\tif($value.isBlankNode()) {\n\t\treturn false;\n\t}\n\tvar re = $flags ? new RegExp($pattern.lex, $flags.lex) : new RegExp($pattern.lex);\n\treturn re.test($value.value);\n}\n\nfunction validatePrimaryKeyProperty($this, $path, $uriStart) {\n\tif(!$this.isURI()) {\n\t\treturn \"Must be an IRI\";\n\t}\n\tif($data.query().path($this, toRDFQueryPath($path), null).getCount() != 1) {\n\t\treturn \"Must have exactly one value\";\n\t}\n\tvar value = $data.query().path($this, toRDFQueryPath($path), \"?value\").getNode(\"?value\");\n\tvar uri = $uriStart.lex + encodeURIComponent(value.value);\n\tif(!$this.uri.equals(uri)) {\n\t\treturn \"Does not have URI \" + uri;\n\t}\n}\n\nfunction validateQualifiedMaxCountProperty($this, $path, $qualifiedValueShape, $qualifiedValueShapesDisjoint, $qualifiedMaxCount, $currentShape) {\n\tvar c = validateQualifiedHelper($this, $path, $qualifiedValueShape, $qualifiedValueShapesDisjoint, $currentShape);\n\treturn c <= Number($qualifiedMaxCount.lex);\n}\n\nfunction validateQualifiedMinCountProperty($this, $path, $qualifiedValueShape, $qualifiedValueShapesDisjoint, $qualifiedMinCount, $currentShape) {\n\tvar c = validateQualifiedHelper($this, $path, $qualifiedValueShape, $qualifiedValueShapesDisjoint, $currentShape);\n\treturn c >= Number($qualifiedMinCount.lex);\n}\n\nfunction validateQualifiedHelper($this, $path, $qualifiedValueShape, $qualifiedValueShapesDisjoint, $currentShape) {\n\tvar siblingShapes = new NodeSet();\n\tif(T(\"true\").equals($qualifiedValueShapesDisjoint)) {\n\t\t$shapes.query().\n\t\t\tmatch(\"?parentShape\", \"sh:property\", $currentShape).\n\t\t\tmatch(\"?parentShape\", \"sh:property\", \"?sibling\").\n\t\t\tmatch(\"?sibling\", \"sh:qualifiedValueShape\", \"?siblingShape\").\n\t\t\tfilter(exprNotEquals(\"?siblingShape\", $qualifiedValueShape)) .\n\t\t\taddAllNodes(\"?siblingShape\", siblingShapes);\n\t}\n\treturn $data.query().\n\t\tpath($this, toRDFQueryPath($path), \"?value\").\n\t\tfilter(function(sol) { \n\t\t\treturn SHACL.nodeConformsToShape(sol.value, $qualifiedValueShape) &&\n\t\t\t\t!validateQualifiedConformsToASibling(sol.value, siblingShapes.toArray()); \n\t\t}).\n\t\tgetCount();\n}\n\nfunction validateQualifiedConformsToASibling(value, siblingShapes) {\n\tfor(var i = 0; i < siblingShapes.length; i++) {\n\t\tif(SHACL.nodeConformsToShape(value, siblingShapes[i])) {\n\t\t\treturn true;\n\t\t}\n\t}\n\treturn false;\n}\n\nfunction validateRootClass($value, $rootClass) {\n\treturn $data.query().path($value, { zeroOrMore: T(\"rdfs:subClassOf\") }, $rootClass).hasSolution();\n}\n\nfunction validateStem($value, $stem) {\n\treturn $value.isURI() && $value.uri.startsWith($stem.lex);\n}\n\nfunction validateSubSetOf($this, $subSetOf, $value) {\n\treturn $data.query().match($this, $subSetOf, $value).hasSolution();\n}\n\nfunction validateUniqueLangProperty($this, $uniqueLang, $path) {\n\tif(!T(\"true\").equals($uniqueLang)) {\n\t\treturn;\n\t}\n\tvar map = {};\n\t$data.query().path($this, toRDFQueryPath($path), \"?value\").forEach(function(sol) {\n\t\tvar lang = sol.value.language;\n\t\tif(lang && lang != \"\") {\n\t\t\tvar old = map[lang];\n\t\t\tif(!old) {\n\t\t\t\tmap[lang] = 1;\n\t\t\t}\n\t\t\telse {\n\t\t\t\tmap[lang] = old + 1;\n\t\t\t}\n\t\t}\n\t})\n\tvar results = [];\n\tfor(var lang in map) {\n\t\tif(map.hasOwnProperty(lang)) {\n\t\t\tvar count = map[lang];\n\t\t\tif(count > 1) {\n\t\t\t\tresults.push(\"Language \\\"\" + lang + \"\\\" has been used by \" + count + \" values\");\n\t\t\t}\n\t\t}\n\t}\n\treturn results;\n}\n\nfunction validateUniqueValueForClass($this, $uniqueValueForClass, $path) {\n\tvar results = [];\n\t$data.query().\n\t\tpath($this, toRDFQueryPath($path), \"?value\").\n\t\tpath(\"?other\", toRDFQueryPath($path), \"?value\").\n\t\tfilter(function(sol) {\n\t\t\t\treturn !$this.equals(sol.other);\n\t\t\t}).\n\t\tfilter(function(sol) {\n\t\t\t\treturn new RDFQueryUtil($data).isInstanceOf(sol.other, $uniqueValueForClass)\n\t\t\t}).\n\t\tforEach(function(sol) {\n\t\t\tresults.push({\n\t\t\t\tother: sol.other,\n\t\t\t\tvalue: sol.value\n\t\t\t})\n\t\t});\n\treturn results;\n}\n\nfunction validateXone($value, $xone) {\n\tvar shapes = new RDFQueryUtil($shapes).rdfListToArray($xone);\n\tvar count = 0;\n\tfor(var i = 0; i < shapes.length; i++) {\n\t\tif(SHACL.nodeConformsToShape($value, shapes[i])) {\n\t\t\tcount++;\n\t\t}\n\t}\n\treturn count == 1;\n}\n\n\n// DASH functions -------------------------------------------------------------\n\n// dash:toString\nfunction dash_toString($arg) {\n\tif($arg.isLiteral()) {\n\t\treturn NodeFactory.literal($arg.lex, T(\"xsd:string\"));\n\t}\n\telse if($arg.isURI()) {\n\t\treturn NodeFactory.literal($arg.uri, T(\"xsd:string\"));\n\t}\n\telse {\n\t\treturn null;\n\t}\n}\n\n\n// DASH targets ---------------------------------------------------------------\n\n// dash:AllObjectsTarget\nfunction dash_allObjects() {\n\treturn $data.query().match(null, null, \"?object\").getNodeSet(\"?object\").toArray();\n}\n\n// dash:AllSubjectsTarget\nfunction dash_allSubjects() {\n\treturn $data.query().match(\"?subject\", null, null).getNodeSet(\"?subject\").toArray();\n}\n\n\n// Utilities ------------------------------------------------------------------\n\nfunction toRDFQueryPath(shPath) {\n    if (shPath.termType === \"Collection\") {\n        var paths = new RDFQueryUtil($shapes).rdfListToArray(shPath);\n        var result = [];\n        for (var i = 0; i < paths.length; i++) {\n            result.push(toRDFQueryPath(paths[i]));\n        }\n        return result;\n    }\n\tif(shPath.isURI()) {\n\t\treturn shPath;\n\t}\n\telse if(shPath.isBlankNode()) {\n\t\tvar util = new RDFQueryUtil($shapes);\n\t\tif($shapes.query().getObject(shPath, \"rdf:first\")) {\n\t\t\tvar paths = util.rdfListToArray(shPath);\n\t\t\tvar result = [];\n\t\t\tfor(var i = 0; i < paths.length; i++) {\n\t\t\t\tresult.push(toRDFQueryPath(paths[i]));\n\t\t\t}\n\t\t\treturn result;\n\t\t}\n\t\tvar alternativePath = $shapes.query().getObject(shPath, \"sh:alternativePath\");\n\t\tif(alternativePath) {\n\t\t\tvar paths = util.rdfListToArray(alternativePath);\n\t\t\tvar result = [];\n\t\t\tfor(var i = 0; i < paths.length; i++) {\n\t\t\t\tresult.push(toRDFQueryPath(paths[i]));\n\t\t\t}\n\t\t\treturn { or : result };\n\t\t}\n\t\tvar zeroOrMorePath = $shapes.query().getObject(shPath, \"sh:zeroOrMorePath\");\n\t\tif(zeroOrMorePath) {\n\t\t\treturn { zeroOrMore : toRDFQueryPath(zeroOrMorePath) };\n\t\t}\n\t\tvar oneOrMorePath = $shapes.query().getObject(shPath, \"sh:oneOrMorePath\");\n\t\tif(oneOrMorePath) {\n\t\t\treturn { oneOrMore : toRDFQueryPath(oneOrMorePath) };\n\t\t}\n\t\tvar zeroOrOnePath = $shapes.query().getObject(shPath, \"sh:zeroOrOnePath\");\n\t\tif(zeroOrOnePath) {\n\t\t\treturn { zeroOrOne : toRDFQueryPath(zeroOrOnePath) };\n\t\t}\n\t\tvar inversePath = $shapes.query().getObject(shPath, \"sh:inversePath\");\n\t\tif(inversePath) {\n\t\t\treturn { inverse : toRDFQueryPath(inversePath) };\n\t\t}\n\t}\n\tthrow \"Unsupported SHACL path \" + shPath;\n\t// TODO: implement conforming to AbstractQuery.path syntax\n\treturn shPath;\n}\n\n\n// Private helper functions\n\n//TODO: Support more datatypes\nfunction isValidForDatatype(lex, datatype) {\n\tif(XSDIntegerTypes.contains(datatype)) {\n\t\tvar r = parseInt(lex);\n\t\treturn !isNaN(r);\n\t}\n\telse if(XSDDecimalTypes.contains(datatype)) {\n\t\tvar r = parseFloat(lex);\n\t\treturn !isNaN(r);\n\t}\n\telse if (datatype.value === \"http://www.w3.org/2001/XMLSchema#boolean\") {\n        return lex === \"true\" || lex === \"false\";\n    }\n\telse {\n\t\treturn true;\n\t}\n}\n\nfunction RDFQueryUtil($source) {\n\tthis.source = $source;\n}\n\nRDFQueryUtil.prototype.getInstancesOf = function($class) {\n\tvar set = new NodeSet();\n\tvar classes = this.getSubClassesOf($class);\n\tclasses.add($class);\n\tvar car = classes.toArray();\n\tfor(var i = 0; i < car.length; i++) {\n\t\tset.addAll(RDFQuery(this.source).match(\"?instance\", \"rdf:type\", car[i]).getNodeArray(\"?instance\"));\n\t}\n\treturn set;\n}\n\nRDFQueryUtil.prototype.getObject = function($subject, $predicate) {\n\tif(!$subject) {\n\t\tthrow \"Missing subject\";\n\t}\n\tif(!$predicate) {\n\t\tthrow \"Missing predicate\";\n\t}\n\treturn RDFQuery(this.source).match($subject, $predicate, \"?object\").getNode(\"?object\");\n}\n\nRDFQueryUtil.prototype.getSubClassesOf = function($class) {\n\tvar set = new NodeSet();\n\tthis.walkSubjects(set, $class, T(\"rdfs:subClassOf\"));\n\treturn set;\n}\n\nRDFQueryUtil.prototype.isInstanceOf = function($instance, $class) {\n\tvar classes = this.getSubClassesOf($class);\n\tvar types = this.source.query().match($instance, \"rdf:type\", \"?type\");\n\tfor(var n = types.nextSolution(); n; n = types.nextSolution()) {\n\t\tif(n.type.equals($class) || classes.contains(n.type)) {\n\t\t\ttypes.close();\n\t\t\treturn true;\n\t\t}\n\t}\n\treturn false;\n}\n\nRDFQueryUtil.prototype.rdfListToArray = function($rdfList) {\n    if ($rdfList.elements != null) {\n        return $rdfList.elements;\n    } else {\n        var array = [];\n        while (!T(\"rdf:nil\").equals($rdfList)) {\n            array.push(this.getObject($rdfList, T(\"rdf:first\")));\n            $rdfList = this.getObject($rdfList, T(\"rdf:rest\"));\n        }\n        return array;\n    }\n}\n\nRDFQueryUtil.prototype.walkObjects = function($results, $subject, $predicate) {\n\tvar it = this.source.find($subject, $predicate, null);\n\tfor(var n = it.next(); n; n = it.next()) {\n\t\tif(!$results.contains(n.object)) {\n\t\t\t$results.add(n.object);\n\t\t\tthis.walkObjects($results, n.object, $predicate);\n\t\t}\n\t}\n}\n\nRDFQueryUtil.prototype.walkSubjects = function($results, $object, $predicate) {\n\tvar it = this.source.find(null, $predicate, $object);\n\tfor(var n = it.next(); n; n = it.next()) {\n\t\tif(!$results.contains(n.subject)) {\n\t\t\t$results.add(n.subject);\n\t\t\tthis.walkSubjects($results, n.subject, $predicate);\n\t\t}\n\t}\n}\n","http://datashapes.org/js/rdfquery.js":"// rdfquery.js\n// A simple RDF query library for JavaScript\n//\n// Contact: Holger Knublauch, TopQuadrant, Inc. (holger@topquadrant.com)\n//\n// The basic idea is that the function RDFQuery produces an initial\n// Query object, which starts with a single \"empty\" solution.\n// Each query object has a function nextSolution() producing an iteration\n// of variable bindings (\"volcano style\").\n// Each query object can be refined with subsequent calls to other\n// functions, producing new queries.\n// Invoking nextSolution on a query will pull solutions from its\n// predecessors in a chain of query objects.\n// The solution objects are plain JavaScript objects providing a\n// mapping from variable names to RDF Term objects.\n// Unless a query has been walked to exhaustion, .close() must be called.\n//\n// Finally, terminal functions such as .getNode() and .getArray() can be used\n// to produce individual values.  All terminal functions close the query.\n//\n// RDF Term/Node objects are expected to follow the contracts from the\n// RDF Representation Task Force's interface specification:\n// https://github.com/rdfjs/representation-task-force/blob/master/interface-spec.md\n//\n// In order to bootstrap all this, graph objects need to implement a\n// function .find(s, p, o) where each parameter is either an RDF term or null\n// producing an iterator object with a .next() function that produces RDF triples\n// (with attributes subject, predicate, object) or null when done.\n//\n// (Note I am not particularly a JavaScript guru so the modularization of this\n// script may be improved to hide private members from public API etc).\n\n/*\nExample:\n\n\tvar result = $data.query().\n\t\tmatch(\"owl:Class\", \"rdfs:label\", \"?label\").\n\t\tmatch(\"?otherClass\", \"rdfs:label\", \"?label\").\n\t\tfilter(function(sol) { return !T(\"owl:Class\").equals(sol.otherClass) }).\n\t\tgetNode(\"?otherClass\");\n\nEquivalent SPARQL:\n\t\tSELECT ?otherClass\n\t\tWHERE {\n\t\t\towl:Class rdfs:label ?label .\n\t\t\t?otherClass rdfs:label ?label .\n\t\t\tFILTER (owl:Class != ?otherClass) .\n\t\t} LIMIT 1\n*/\n\nif(!this[\"TermFactory\"]) {\n    // In some environments such as Nashorn this may already have a value\n    // In TopBraid this is redirecting to native Jena calls\n    TermFactory = {\n\n        REGEX_URI: /^([a-z][a-z0-9+.-]*):(?:\\/\\/((?:(?=((?:[a-z0-9-._~!$&'()*+,;=:]|%[0-9A-F]{2})*))(\\3)@)?(?=(\\[[0-9A-F:.]{2,}\\]|(?:[a-z0-9-._~!$&'()*+,;=]|%[0-9A-F]{2})*))\\5(?::(?=(\\d*))\\6)?)(\\/(?=((?:[a-z0-9-._~!$&'()*+,;=:@\\/]|%[0-9A-F]{2})*))\\8)?|(\\/?(?!\\/)(?=((?:[a-z0-9-._~!$&'()*+,;=:@\\/]|%[0-9A-F]{2})*))\\10)?)(?:\\?(?=((?:[a-z0-9-._~!$&'()*+,;=:@\\/?]|%[0-9A-F]{2})*))\\11)?(?:#(?=((?:[a-z0-9-._~!$&'()*+,;=:@\\/?]|%[0-9A-F]{2})*))\\12)?$/i,\n\n        impl : null,   // This needs to be connected to an API such as $rdf\n\n        // Globally registered prefixes for TTL short cuts\n        namespaces : {},\n\n        /**\n         * Registers a new namespace prefix for global TTL short cuts (qnames).\n         * @param prefix  the prefix to add\n         * @param namespace  the namespace to add for the prefix\n         */\n        registerNamespace : function(prefix, namespace) {\n            if(this.namespaces.prefix) {\n                throw \"Prefix \" + prefix + \" already registered\"\n            }\n            this.namespaces[prefix] = namespace;\n        },\n\n        /**\n         * Produces an RDF term from a TTL string representation.\n         * Also uses the registered prefixes.\n         * @param str  a string, e.g. \"owl:Thing\" or \"true\" or '\"Hello\"@en'.\n         * @return an RDF term\n         */\n        term : function(str) {\n            // TODO: this implementation currently only supports booleans and qnames - better overload to rdflib.js\n            if (\"true\" === str || \"false\" === str) {\n                return this.literal(str, (this.term(\"xsd:boolean\")));\n            }\n\n            if (str.match(/^\\d+$/)) {\n                return this.literal(str, (this.term(\"xsd:integer\")));\n            }\n\n            if (str.match(/^\\d+\\.\\d+$/)) {\n                return this.literal(str, (this.term(\"xsd:float\")));\n            }\n\n            var col = str.indexOf(\":\");\n            if (col > 0) {\n                var ns = this.namespaces[str.substring(0, col)];\n                if (ns != null) {\n                    return this.namedNode(ns + str.substring(col + 1));\n                } else {\n                    if (str.match(REGEX_URI)) {\n                        return this.namedNode(str)\n                    }\n                }\n            }\n            return this.literal(str);\n        },\n\n        /**\n         * Produces a new blank node.\n         * @param id  an optional ID for the node\n         */\n        blankNode : function(id) {\n            return this.impl.blankNode(id);\n        },\n\n        /**\n         * Produces a new literal.  For example .literal(\"42\", T(\"xsd:integer\")).\n         * @param lex  the lexical form, e.g. \"42\"\n         * @param langOrDatatype  either a language string or a URI node with the datatype\n         */\n        literal : function(lex, langOrDatatype) {\n            return this.impl.literal(lex, langOrDatatype)\n        },\n\n        // This function is basically left for Task Force compatibility, but the preferred function is uri()\n        namedNode : function(uri) {\n            return this.impl.namedNode(uri)\n        },\n\n        /**\n         * Produces a new URI node.\n         * @param uri  the URI of the node\n         */\n        uri : function(uri) {\n            return namedNode(uri);\n        }\n    }\n}\n\n// Install NodeFactory as an alias - unsure which name is best long term:\n// The official name in RDF is \"term\", while \"node\" is more commonly understood.\n// Oficially, a \"node\" must be in a graph though, while \"terms\" are independent.\nvar NodeFactory = TermFactory;\n\n\nNodeFactory.registerNamespace(\"dc\", \"http://purl.org/dc/elements/1.1/\")\nNodeFactory.registerNamespace(\"dcterms\", \"http://purl.org/dc/terms/\")\nNodeFactory.registerNamespace(\"rdf\", \"http://www.w3.org/1999/02/22-rdf-syntax-ns#\")\nNodeFactory.registerNamespace(\"rdfs\", \"http://www.w3.org/2000/01/rdf-schema#\")\nNodeFactory.registerNamespace(\"schema\", \"http://schema.org/\")\nNodeFactory.registerNamespace(\"sh\", \"http://www.w3.org/ns/shacl#\")\nNodeFactory.registerNamespace(\"skos\", \"http://www.w3.org/2004/02/skos/core#\")\nNodeFactory.registerNamespace(\"owl\", \"http://www.w3.org/2002/07/owl#\")\nNodeFactory.registerNamespace(\"xsd\", \"http://www.w3.org/2001/XMLSchema#\")\n\n// Candidates:\n// NodeFactory.registerNamespace(\"prov\", \"http://www.w3.org/ns/prov#\");\n\n/**\n * A shortcut for NodeFactory.term(str) - turns a TTL string representation of an RDF\n * term into a proper RDF term.\n * This will also use the globally registered namespace prefixes.\n * @param str  the string representation, e.g. \"owl:Thing\"\n * @returns\n */\nfunction T(str) {\n    return NodeFactory.term(str)\n}\n\n\n/**\n * Creates a query object for a given graph and optional initial solution.\n * The resulting object can be further refined using the functions on\n * AbstractQuery such as <code>match()</code> and <code>filter()</code>.\n * Functions such as <code>nextSolution()</code> can be used to get the actual results.\n * @param graph  the graph to query\n * @param initialSolution  the initial solutions or null for none\n * @returns a query object\n */\nfunction RDFQuery(graph, initialSolution) {\n    return new StartQuery(graph, initialSolution ? initialSolution : []);\n}\n\n\n// class AbstractQuery\n\nfunction AbstractQuery() {\n}\n\n// ----------------------------------------------------------------------------\n// Query constructor functions, can be chained together\n// ----------------------------------------------------------------------------\n\n/**\n * Creates a new query that adds a binding for a given variable into\n * each solution produced by the input query.\n * @param varName  the name of the variable to bind, starting with \"?\"\n * @param bindFunction  a function that takes a solution object\n *                      and returns a node or null based on it.\n */\nAbstractQuery.prototype.bind = function(varName, bindFunction) {\n    return new BindQuery(this, varName, bindFunction);\n}\n\n/**\n * Creates a new query that filters the solutions produced by this.\n * @param filterFunction  a function that takes a solution object\n *                        and returns true iff that solution is valid\n */\nAbstractQuery.prototype.filter = function(filterFunction) {\n    return new FilterQuery(this, filterFunction);\n}\n\n/**\n * Creates a new query that only allows the first n solutions through.\n * @param limit  the maximum number of results to allow\n */\nAbstractQuery.prototype.limit = function(limit) {\n    return new LimitQuery(this, limit);\n}\n\n/**\n * Creates a new query doing a triple match.\n * In each subject, predicate, object position, the values can either be\n * an RDF term object or null (wildcard) or a string.\n * If it is a string it may either be a variable (starting with \"?\")\n * or the TTL representation of an RDF term using the T() function.\n * @param s  the match subject\n * @param p  the match predicate\n * @param o  the match object\n */\nAbstractQuery.prototype.match = function(s, p, o) {\n    return new MatchQuery(this, s, p, o);\n}\n\n/**\n * Creates a new query that sorts all input solutions by the bindings\n * for a given variable.\n * @param varName  the name of the variable to sort by, starting with \"?\"\n */\nAbstractQuery.prototype.orderBy = function(varName) {\n    return new OrderByQuery(this, varName);\n}\n\n/**\n * Creates a new query doing a match where the predicate may be a RDF Path object.\n * Note: This is currently not using lazy evaluation and will always walk all matches.\n * Path syntax:\n * - PredicatePaths: NamedNode\n * - SequencePaths: [path1, path2]\n * - AlternativePaths: { or : [ path1, path2 ] }\n * - InversePaths: { inverse : path }   LIMITATION: Only supports NamedNodes for path here\n * - ZeroOrMorePaths: { zeroOrMore : path }\n * - OneOrMorePaths: { oneOrMore : path }\n * - ZeroOrOnePaths: { zeroOrOne : path }\n * @param s  the match subject or a variable name (string) - must have a value\n *           at execution time!\n * @param path  the match path object (e.g. a NamedNode for a simple predicate hop)\n * @param o  the match object or a variable name (string)\n */\nAbstractQuery.prototype.path = function(s, path, o) {\n    if(path && path.value && path.isURI()) {\n        return new MatchQuery(this, s, path, o);\n    }\n    else {\n        return new PathQuery(this, s, path, o);\n    }\n}\n\n// TODO: add other SPARQL-like query types\n//       - .distinct()\n//       - .union(otherQuery)\n\n\n// ----------------------------------------------------------------------------\n// Terminal functions - convenience functions to get values.\n// All these functions close the solution iterators.\n// ----------------------------------------------------------------------------\n\n/**\n * Adds all nodes produced by a given solution variable into a set.\n * The set must have an add(node) function.\n * @param varName  the name of the variable, starting with \"?\"\n * @param set  the set to add to\n */\nAbstractQuery.prototype.addAllNodes = function(varName, set) {\n    var attrName = var2Attr(varName);\n    for(var sol = this.nextSolution(); sol; sol = this.nextSolution()) {\n        var node = sol[attrName];\n        if(node) {\n            set.add(node);\n        }\n    }\n}\n\n/**\n * Produces an array of triple objects where each triple object has properties\n * subject, predicate and object derived from the provided template values.\n * Each of these templates can be either a variable name (starting with '?'),\n * an RDF term string (such as \"rdfs:label\") or a JavaScript node object.\n * @param subject  the subject node\n * @param predicate  the predicate node\n * @param object  the object node\n */\nAbstractQuery.prototype.construct = function(subject, predicate, object) {\n    var results = [];\n    for(var sol = this.nextSolution(); sol; sol = this.nextSolution()) {\n        var s = null;\n        if(typeof subject === 'string') {\n            if(subject.indexOf('?') == 0) {\n                s = sol[var2Attr(subject)];\n            }\n            else {\n                s = T(subject);\n            }\n        }\n        else {\n            s = subject;\n        }\n        var p = null;\n        if(typeof predicate === 'string') {\n            if(predicate.indexOf('?') == 0) {\n                p = sol[var2Attr(predicate)];\n            }\n            else {\n                p = T(predicate);\n            }\n        }\n        else {\n            p = predicate;\n        }\n\n        var o = null;\n        if(typeof object === 'string') {\n            if(object.indexOf('?') == 0) {\n                o = sol[var2Attr(object)];\n            }\n            else {\n                o = T(object);\n            }\n        }\n        else {\n            o = object;\n        }\n\n        if(s && p && o) {\n            results.push({ subject: s, predicate: p, object: o});\n        }\n    }\n    return results;\n}\n\n/**\n * Executes a given function for each solution.\n * @param callback  a function that takes a solution as argument\n */\nAbstractQuery.prototype.forEach = function(callback) {\n    for(var n = this.nextSolution(); n; n = this.nextSolution()) {\n        callback(n);\n    }\n}\n\n/**\n * Executes a given function for each node in a solution set.\n * @param varName  the name of a variable, starting with \"?\"\n * @param callback  a function that takes a node as argument\n */\nAbstractQuery.prototype.forEachNode = function(varName, callback) {\n    var attrName = var2Attr(varName);\n    for(var sol = this.nextSolution(); sol; sol = this.nextSolution()) {\n        var node = sol[attrName];\n        if(node) {\n            callback(node);\n        }\n    }\n}\n\n/**\n * Turns all result solutions into an array.\n * @return an array consisting of solution objects\n */\nAbstractQuery.prototype.getArray = function() {\n    var results = [];\n    for(var n = this.nextSolution(); n != null; n = this.nextSolution()) {\n        results.push(n);\n    }\n    return results;\n}\n\n/**\n * Gets the number of (remaining) solutions.\n * @return the count\n */\nAbstractQuery.prototype.getCount = function() {\n    return this.getArray().length; // Quick and dirty implementation\n}\n\n/**\n * Gets the next solution and, if that exists, returns the binding for a\n * given variable from that solution.\n * @param varName  the name of the binding to get, starting with \"?\"\n * @return the value of the variable or null or undefined if it doesn't exist\n */\nAbstractQuery.prototype.getNode = function(varName) {\n    var s = this.nextSolution();\n    if(s) {\n        this.close();\n        return s[var2Attr(varName)];\n    }\n    else {\n        return null;\n    }\n}\n\n/**\n * Turns all results into an array of bindings for a given variable.\n * @return an array consisting of RDF node objects\n */\nAbstractQuery.prototype.getNodeArray = function(varName) {\n    var results = [];\n    var attr = var2Attr(varName);\n    for(var n = this.nextSolution(); n != null; n = this.nextSolution()) {\n        results.push(n[attr]);\n    }\n    return results;\n}\n\n/**\n * Turns all result bindings for a given variable into a set.\n * The set has functions .contains and .toArray.\n * @param varName  the name of the variable, starting with \"?\"\n * @return a set consisting of RDF node objects\n */\nAbstractQuery.prototype.getNodeSet = function(varName) {\n    var results = new NodeSet();\n    var attr = var2Attr(varName);\n    for(var n = this.nextSolution(); n != null; n = this.nextSolution()) {\n        results.add(n[attr]);\n    }\n    return results;\n}\n\n/**\n * Queries the underlying graph for the object of a subject/predicate combination,\n * where either subject or predicate can be a variable which is substituted with\n * a value from the next input solution.\n * Note that even if there are multiple solutions it will just return the \"first\"\n * one and since the order of triples in RDF is undefined this may lead to random results.\n * Unbound values produce errors.\n * @param subject  an RDF term or a variable (starting with \"?\") or a TTL representation\n * @param predicate  an RDF term or a variable (starting with \"?\") or a TTL representation\n * @return the object of the \"first\" triple matching the subject/predicate combination\n */\nAbstractQuery.prototype.getObject = function(subject, predicate) {\n    var sol = this.nextSolution();\n    if(sol) {\n        this.close();\n        var s;\n        if(typeof subject === 'string') {\n            if(subject.indexOf('?') == 0) {\n                s = sol[var2Attr(subject)];\n            }\n            else {\n                s = T(subject);\n            }\n        }\n        else {\n            s = subject;\n        }\n        if(!s) {\n            throw \"getObject() called with null subject\";\n        }\n        var p;\n        if(typeof predicate === 'string') {\n            if(predicate.indexOf('?') == 0) {\n                p = sol[var2Attr(predicate)];\n            }\n            else {\n                p = T(predicate);\n            }\n        }\n        else {\n            p = predicate;\n        }\n        if(!p) {\n            throw \"getObject() called with null predicate\";\n        }\n\n        var it = this.source.find(s, p, null);\n        var triple = it.next();\n        if(triple) {\n            it.close();\n            return triple.object;\n        }\n    }\n    return null;\n}\n\n/**\n * Tests if there is any solution and closes the query.\n * @return true if there is another solution\n */\nAbstractQuery.prototype.hasSolution = function() {\n    if(this.nextSolution()) {\n        this.close();\n        return true;\n    }\n    else {\n        return false;\n    }\n}\n\n\n// ----------------------------------------------------------------------------\n// Expression functions - may be used in filter and bind queries\n// ----------------------------------------------------------------------------\n\n/**\n * Creates a function that takes a solution and compares a given node with\n * the binding of a given variable from that solution.\n * @param varName  the name of the variable (starting with \"?\")\n * @param node  the node to compare with\n * @returns true if the solution's variable equals the node\n */\nfunction exprEquals(varName, node) {\n    return function(sol) {\n        return node.equals(sol[var2Attr(varName)]);\n    }\n}\n\n/**\n * Creates a function that takes a solution and compares a given node with\n * the binding of a given variable from that solution.\n * @param varName  the name of the variable (starting with \"?\")\n * @param node  the node to compare with\n * @returns true if the solution's variable does not equal the node\n */\nfunction exprNotEquals(varName, node) {\n    return function(sol) {\n        return !node.equals(sol[var2Attr(varName)]);\n    }\n}\n\n\n// ----------------------------------------------------------------------------\n// END OF PUBLIC API ----------------------------------------------------------\n// ----------------------------------------------------------------------------\n\n\n// class BindQuery\n// Takes all input solutions but adds a value for a given variable so that\n// the value is computed by a given function based on the current solution.\n// It is illegal to use a variable that already has a value from the input.\n\nfunction BindQuery(input, varName, bindFunction) {\n    this.attr = var2Attr(varName);\n    this.source = input.source;\n    this.input = input;\n    this.bindFunction = bindFunction;\n}\n\nBindQuery.prototype = Object.create(AbstractQuery.prototype);\n\nBindQuery.prototype.close = function() {\n    this.input.close();\n}\n\n// Pulls the next result from the input Query and passes it into\n// the given bind function to add a new node\nBindQuery.prototype.nextSolution = function() {\n    var result = this.input.nextSolution();\n    if(result == null) {\n        return null;\n    }\n    else {\n        var newNode = this.bindFunction(result);\n        if(newNode) {\n            result[this.attr] = newNode;\n        }\n        return result;\n    }\n}\n\n\n// class FilterQuery\n// Filters the incoming solutions, only letting through those where\n// filterFunction(solution) returns true\n\nfunction FilterQuery(input, filterFunction) {\n    this.source = input.source;\n    this.input = input;\n    this.filterFunction = filterFunction;\n}\n\nFilterQuery.prototype = Object.create(AbstractQuery.prototype);\n\nFilterQuery.prototype.close = function() {\n    this.input.close();\n}\n\n// Pulls the next result from the input Query and passes it into\n// the given filter function\nFilterQuery.prototype.nextSolution = function() {\n    for(;;) {\n        var result = this.input.nextSolution();\n        if(result == null) {\n            return null;\n        }\n        else if(this.filterFunction(result) === true) {\n            return result;\n        }\n    }\n}\n\n\n// class LimitQuery\n// Only allows the first n values of the input query through\n\nfunction LimitQuery(input, limit) {\n    this.source = input.source;\n    this.input = input;\n    this.limit = limit;\n}\n\nLimitQuery.prototype = Object.create(AbstractQuery.prototype);\n\nLimitQuery.prototype.close = function() {\n    this.input.close();\n}\n\n// Pulls the next result from the input Query unless the number\n// of previous calls has exceeded the given limit\nLimitQuery.prototype.nextSolution = function() {\n    if(this.limit > 0) {\n        this.limit--;\n        return this.input.nextSolution();\n    }\n    else {\n        this.input.close();\n        return null;\n    }\n}\n\n\n// class MatchQuery\n// Joins the solutions from the input Query with triple matches against\n// the current input graph.\n\nfunction MatchQuery(input, s, p, o) {\n    this.source = input.source;\n    this.input = input;\n    if(typeof s === 'string') {\n        if(s.indexOf('?') == 0) {\n            this.sv = var2Attr(s);\n        }\n        else {\n            this.s = T(s);\n        }\n    }\n    else {\n        this.s = s;\n    }\n    if(typeof p === 'string') {\n        if(p.indexOf('?') == 0) {\n            this.pv = var2Attr(p);\n        }\n        else {\n            this.p = T(p);\n        }\n    }\n    else {\n        this.p = p;\n    }\n    if(typeof o === 'string') {\n        if(o.indexOf('?') == 0) {\n            this.ov = var2Attr(o);\n        }\n        else {\n            this.o = T(o);\n        }\n    }\n    else {\n        this.o = o;\n    }\n}\n\nMatchQuery.prototype = Object.create(AbstractQuery.prototype);\n\nMatchQuery.prototype.close = function() {\n    this.input.close();\n    if(this.ownIterator) {\n        this.ownIterator.close();\n    }\n}\n\n// This pulls the first solution from the input Query and uses it to\n// create an \"ownIterator\" which applies the input solution to those\n// specified by s, p, o.\n// Once this \"ownIterator\" has been exhausted, it moves to the next\n// solution from the input Query, and so on.\n// At each step, it produces the union of the input solutions plus the\n// own solutions.\nMatchQuery.prototype.nextSolution = function() {\n\n    var oit = this.ownIterator;\n    if(oit) {\n        var n = oit.next();\n        if(n != null) {\n            var result = createSolution(this.inputSolution);\n            if(this.sv) {\n                result[this.sv] = n.subject;\n            }\n            if(this.pv) {\n                result[this.pv] = n.predicate;\n            }\n            if(this.ov) {\n                result[this.ov] = n.object;\n            }\n            return result;\n        }\n        else {\n            delete this.ownIterator; // Mark as exhausted\n        }\n    }\n\n    // Pull from input\n    this.inputSolution = this.input.nextSolution();\n    if(this.inputSolution) {\n        var sm = this.sv ? this.inputSolution[this.sv] : this.s;\n        var pm = this.pv ? this.inputSolution[this.pv] : this.p;\n        var om = this.ov ? this.inputSolution[this.ov] : this.o;\n        this.ownIterator = this.source.find(sm, pm, om);\n        return this.nextSolution();\n    }\n    else {\n        return null;\n    }\n}\n\n\n// class OrderByQuery\n// Sorts all solutions from the input stream by a given variable\n\nfunction OrderByQuery(input, varName) {\n    this.input = input;\n    this.source = input.source;\n    this.attrName = var2Attr(varName);\n}\n\nOrderByQuery.prototype = Object.create(AbstractQuery.prototype);\n\nOrderByQuery.prototype.close = function() {\n    this.input.close();\n}\n\nOrderByQuery.prototype.nextSolution = function() {\n    if(!this.solutions) {\n        this.solutions = this.input.getArray();\n        var attrName = this.attrName;\n        this.solutions.sort(function(s1, s2) {\n            return compareTerms(s1[attrName], s2[attrName]);\n        });\n        this.index = 0;\n    }\n    if(this.index < this.solutions.length) {\n        return this.solutions[this.index++];\n    }\n    else {\n        return null;\n    }\n}\n\n\n// class PathQuery\n// Expects subject and path to be bound and produces all bindings\n// for the object variable or matches that by evaluating the given path\n\nfunction PathQuery(input, subject, path, object) {\n    this.input = input;\n    this.source = input.source;\n    if(typeof subject === 'string' && subject.indexOf(\"?\") == 0) {\n        this.subjectAttr = var2Attr(subject);\n    }\n    else {\n        this.subject = subject;\n    }\n    if(path == null) {\n        throw \"Path cannot be unbound\";\n    }\n    if(typeof path === 'string') {\n        this.path_ = T(path);\n    }\n    else {\n        this.path_ = path;\n    }\n    if(typeof object === 'string' && object.indexOf(\"?\") == 0) {\n        this.objectAttr = var2Attr(object);\n    }\n    else {\n        this.object = object;\n    }\n}\n\nPathQuery.prototype = Object.create(AbstractQuery.prototype);\n\nPathQuery.prototype.close = function() {\n    this.input.close();\n}\n\nPathQuery.prototype.nextSolution = function() {\n\n    var r = this.pathResults;\n    if(r) {\n        var n = r[this.pathIndex++];\n        var result = createSolution(this.inputSolution);\n        if(this.objectAttr) {\n            result[this.objectAttr] = n;\n        }\n        if(this.pathIndex == r.length) {\n            delete this.pathResults; // Mark as exhausted\n        }\n        return result;\n    }\n\n    // Pull from input\n    this.inputSolution = this.input.nextSolution();\n    if(this.inputSolution) {\n        var sm = this.subjectAttr ? this.inputSolution[this.subjectAttr] : this.subject;\n        if(sm == null) {\n            throw \"Path cannot have unbound subject\";\n        }\n        var om = this.objectAttr ? this.inputSolution[this.objectAttr] : this.object;\n        var pathResultsSet = new NodeSet();\n        addPathValues(this.source, sm, this.path_, pathResultsSet);\n        this.pathResults = pathResultsSet.toArray();\n        if(this.pathResults.length == 0) {\n            delete this.pathResults;\n        }\n        else if(om) {\n            delete this.pathResults;\n            if(pathResultsSet.contains(om)) {\n                return this.inputSolution;\n            }\n        }\n        else {\n            this.pathIndex = 0;\n        }\n        return this.nextSolution();\n    }\n    else {\n        return null;\n    }\n}\n\n\n// class StartQuery\n// This simply produces a single result: the initial solution\n\nfunction StartQuery(source, initialSolution) {\n    this.source = source;\n    if (initialSolution && initialSolution.length > 0) {\n        this.solution = initialSolution;\n    } else {\n        this.solution = [{}];\n    }\n}\n\nStartQuery.prototype = Object.create(AbstractQuery.prototype);\n\nStartQuery.prototype.close = function() {\n}\n\nStartQuery.prototype.nextSolution = function() {\n    if (this.solution) {\n        if (this.solution.length > 0) {\n            return this.solution.shift();\n        } else {\n            delete this.solution;\n        }\n    }\n}\n\n\n// Helper functions\n\nfunction createSolution(base) {\n    var result = {};\n    for(var attr in base) {\n        if(base.hasOwnProperty(attr)) {\n            result[attr] = base[attr];\n        }\n    }\n    return result;\n}\n\n\nfunction compareTerms(t1, t2) {\n    if(!t1) {\n        return !t2 ? 0 : 1;\n    }\n    else if(!t2) {\n        return -1;\n    }\n    var bt = t1.termType.localeCompare(t2.termType);\n    if(bt != 0) {\n        return bt;\n    }\n    else {\n        if(t1.isLiteral()) {\n            // TODO: Does not handle date comparison\n            var bd = t1.datatype.uri.localeCompare(t2.datatype.uri);\n            if(bd != 0) {\n                return bd;\n            }\n            else if(T(\"rdf:langString\").equals(t1.datatype)) {\n                return t1.language.localeCompare(t2.language);\n            }\n            else if(T(\"xsd:integer\").equals(t1.datatype) || T(\"xsd:decimal\").equals(t1.datatype) || T(\"xsd:long\").equals(t1.datatype)) {\n                const t1val = parseInt(t1.valueOf());\n                const t2val = parseInt(t2.valueOf());\n                if (t1val === t2val) {\n                    return 0;\n                } else if (t1val < t2val) {\n                    return -1;\n                } else {\n                    return 1;\n                }\n            }\n            else if(T(\"xsd:float\").equals(t1.datatype) || T(\"xsd:double\").equals(t1.datatype)) {\n                const t1val = parseFloat(t1.valueOf());\n                const t2val = parseFloat(t2.valueOf());\n                if (t1val === t2val) {\n                    return 0;\n                } else if (t1val < t2val) {\n                    return -1;\n                } else {\n                    return 1;\n                }\n            }\n            else {\n                return 0;\n            }\n        }\n        else {\n            var bv = t1.value.localeCompare(t2.value);\n            if(bv != 0) {\n                return bv;\n            }\n            else {\n                return 0;\n            }\n        }\n    }\n}\n\nfunction getLocalName(uri) {\n    // TODO: This is not the 100% correct local name algorithm\n    var index = uri.lastIndexOf(\"#\");\n    if(index < 0) {\n        index = uri.lastIndexOf(\"/\");\n    }\n    if(index < 0) {\n        throw \"Cannot get local name of \" + uri;\n    }\n    return uri.substring(index + 1);\n}\n\n\n// class NodeSet\n// (a super-primitive implementation for now!)\n\nfunction NodeSet() {\n    this.values = [];\n}\n\nNodeSet.prototype.add = function(node) {\n    if(!this.contains(node)) {\n        this.values.push(node);\n    }\n}\n\nNodeSet.prototype.addAll = function(nodes) {\n    for(var i = 0; i < nodes.length; i++) {\n        this.add(nodes[i]);\n    }\n}\n\nNodeSet.prototype.contains = function(node) {\n    for(var i = 0; i < this.values.length; i++) {\n        if(this.values[i].equals(node)) {\n            return true;\n        }\n    }\n    return false;\n}\n\nNodeSet.prototype.forEach = function(callback) {\n    for(var i = 0; i < this.values.length; i++) {\n        callback(this.values[i]);\n    }\n}\n\nNodeSet.prototype.size = function() {\n    return this.values.length;\n}\n\nNodeSet.prototype.toArray = function() {\n    return this.values;\n}\n\nNodeSet.prototype.toString = function() {\n    var str = \"NodeSet(\" + this.size() + \"): [\";\n    var arr = this.toArray();\n    for(var i = 0; i < arr.length; i++) {\n        if(i > 0) {\n            str += \", \";\n        }\n        str += arr[i];\n    }\n    return str + \"]\";\n}\n\n\nfunction var2Attr(varName) {\n    if(!varName.indexOf(\"?\") == 0) {\n        throw \"Variable name must start with ?\";\n    }\n    if(varName.length == 1) {\n        throw \"Variable name too short\";\n    }\n    return varName.substring(1);\n}\n\n\n\n// Simple Path syntax implementation:\n// Adds all matches for a given subject and path combination into a given NodeSet.\n// This should really be doing lazy evaluation and only up to the point\n// where the match object is found.\nfunction addPathValues(graph, subject, path, set) {\n    if(path.uri) {\n        set.addAll(RDFQuery(graph).match(subject, path, \"?object\").getNodeArray(\"?object\"));\n    }\n    else if(Array.isArray(path)) {\n        var s = new NodeSet();\n        s.add(subject);\n        for(var i = 0; i < path.length; i++) {\n            var a = s.toArray();\n            s = new NodeSet();\n            for(var j = 0; j < a.length; j++) {\n                addPathValues(graph, a[j], path[i], s);\n            }\n        }\n        set.addAll(s.toArray());\n    }\n    else if(path.or) {\n        for(var i = 0; i < path.or.length; i++) {\n            addPathValues(graph, subject, path.or[i], set);\n        }\n    }\n    else if(path.inverse) {\n        if(path.inverse.isURI()) {\n            set.addAll(RDFQuery(graph).match(\"?subject\", path.inverse, subject).getNodeArray(\"?subject\"));\n        }\n        else {\n            throw \"Unsupported: Inverse paths only work for named nodes\";\n        }\n    }\n    else if(path.zeroOrOne) {\n        addPathValues(graph, subject, path.zeroOrOne, set);\n        set.add(subject);\n    }\n    else if(path.zeroOrMore) {\n        walkPath(graph, subject, path.zeroOrMore, set, new NodeSet());\n        set.add(subject);\n    }\n    else if(path.oneOrMore) {\n        walkPath(graph, subject, path.oneOrMore, set, new NodeSet());\n    }\n    else {\n        throw \"Unsupported path object: \" + path;\n    }\n}\n\nfunction walkPath(graph, subject, path, set, visited) {\n    visited.add(subject);\n    var s = new NodeSet();\n    addPathValues(graph, subject, path, s);\n    var a = s.toArray();\n    set.addAll(a);\n    for(var i = 0; i < a.length; i++) {\n        if(!visited.contains(a[i])) {\n            walkPath(graph, a[i], path, set, visited);\n        }\n    }\n}"}
},{}],112:[function(require,module,exports){
const n3 = require("n3");
const JsonLdParser = require("jsonld-streaming-parser").JsonLdParser;

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
    postProcessGraph(this.store, graphURI, rdfModel)
    andThen();
};

RDFLibGraph.prototype.loadGraph = function(str, graphURI, mimeType, andThen, handleError) {
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

RDFLibGraph.prototype.clear = function() {
    this.store = $rdf.graph();
};



var RDFLibGraphIterator = function (store, s, p, o) {
    this.index = 0;
    this.ss = store.getQuads(s, p, o);
};

RDFLibGraphIterator.prototype.close = function () {
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
},{"./rdfquery":113,"debug":17,"jsonld-streaming-parser":28,"n3":61}],113:[function(require,module,exports){
/// ADDED...
var TermFactory = require("./rdfquery/term-factory");
this["TermFactory"] = TermFactory;
///

// rdfquery.js
// A simple RDF query library for JavaScript
//
// Contact: Holger Knublauch, TopQuadrant, Inc. (holger@topquadrant.com)
//
// The basic idea is that the function RDFQuery produces an initial
// Query object, which starts with a single "empty" solution.
// Each query object has a function nextSolution() producing an iteration
// of variable bindings ("volcano style").
// Each query object can be refined with subsequent calls to other
// functions, producing new queries.
// Invoking nextSolution on a query will pull solutions from its
// predecessors in a chain of query objects.
// The solution objects are plain JavaScript objects providing a
// mapping from variable names to RDF Term objects.
// Unless a query has been walked to exhaustion, .close() must be called.
//
// Finally, terminal functions such as .getNode() and .getArray() can be used
// to produce individual values.  All terminal functions close the query.
//
// RDF Term/Node objects are expected to follow the contracts from the
// RDF Representation Task Force's interface specification:
// https://github.com/rdfjs/representation-task-force/blob/master/interface-spec.md
//
// In order to bootstrap all this, graph objects need to implement a
// function .find(s, p, o) where each parameter is either an RDF term or null
// producing an iterator object with a .next() function that produces RDF triples
// (with attributes subject, predicate, object) or null when done.
//
// (Note I am not particularly a JavaScript guru so the modularization of this
// script may be improved to hide private members from public API etc).

/*
Example:

	var result = $data.query().
		match("owl:Class", "rdfs:label", "?label").
		match("?otherClass", "rdfs:label", "?label").
		filter(function(sol) { return !T("owl:Class").equals(sol.otherClass) }).
		getNode("?otherClass");

Equivalent SPARQL:
		SELECT ?otherClass
		WHERE {
			owl:Class rdfs:label ?label .
			?otherClass rdfs:label ?label .
			FILTER (owl:Class != ?otherClass) .
		} LIMIT 1
*/

if(!this["TermFactory"]) {
    // In some environments such as Nashorn this may already have a value
    // In TopBraid this is redirecting to native Jena calls
    TermFactory = {

        REGEX_URI: /^([a-z][a-z0-9+.-]*):(?:\/\/((?:(?=((?:[a-z0-9-._~!</content>'()*+,;=:]|%[0-9A-F]{2})*))(\3)@)?(?=(\[[0-9A-F:.]{2,}\]|(?:[a-z0-9-._~!</content>'()*+,;=]|%[0-9A-F]{2})*))\5(?::(?=(\d*))\6)?)(\/(?=((?:[a-z0-9-._~!</content>'()*+,;=:@\/]|%[0-9A-F]{2})*))\8)?|(\/?(?!\/)(?=((?:[a-z0-9-._~!</content>'()*+,;=:@\/]|%[0-9A-F]{2})*))\10)?)(?:\?(?=((?:[a-z0-9-._~!</content>'()*+,;=:@\/?]|%[0-9A-F]{2})*))\11)?(?:#(?=((?:[a-z0-9-._~!</content>'()*+,;=:@\/?]|%[0-9A-F]{2})*))\12)?$/i,

        impl : null,   // This needs to be connected to an API such as $rdf

        // Globally registered prefixes for TTL short cuts
        namespaces : {},

        /**
         * Registers a new namespace prefix for global TTL short cuts (qnames).
         * @param prefix  the prefix to add
         * @param namespace  the namespace to add for the prefix
         */
        registerNamespace : function(prefix, namespace) {
            if(this.namespaces.prefix) {
                throw "Prefix " + prefix + " already registered"
            }
            this.namespaces[prefix] = namespace;
        },

        /**
         * Produces an RDF term from a TTL string representation.
         * Also uses the registered prefixes.
         * @param str  a string, e.g. "owl:Thing" or "true" or '"Hello"@en'.
         * @return an RDF term
         */
        term : function(str) {
            // TODO: this implementation currently only supports booleans and qnames - better overload to rdflib.js
            if ("true" === str || "false" === str) {
                return this.literal(str, (this.term("xsd:boolean")));
            }

            if (str.match(/^\d+$/)) {
                return this.literal(str, (this.term("xsd:integer")));
            }

            if (str.match(/^\d+\.\d+$/)) {
                return this.literal(str, (this.term("xsd:float")));
            }

            var col = str.indexOf(":");
            if (col > 0) {
                var ns = this.namespaces[str.substring(0, col)];
                if (ns != null) {
                    return this.namedNode(ns + str.substring(col + 1));
                } else {
                    if (str.match(REGEX_URI)) {
                        return this.namedNode(str)
                    }
                }
            }
            return this.literal(str);
        },

        /**
         * Produces a new blank node.
         * @param id  an optional ID for the node
         */
        blankNode : function(id) {
            return this.impl.blankNode(id);
        },

        /**
         * Produces a new literal.  For example .literal("42", T("xsd:integer")).
         * @param lex  the lexical form, e.g. "42"
         * @param langOrDatatype  either a language string or a URI node with the datatype
         */
        literal : function(lex, langOrDatatype) {
            return this.impl.literal(lex, langOrDatatype)
        },

        // This function is basically left for Task Force compatibility, but the preferred function is uri()
        namedNode : function(uri) {
            return this.impl.namedNode(uri)
        },

        /**
         * Produces a new URI node.
         * @param uri  the URI of the node
         */
        uri : function(uri) {
            return namedNode(uri);
        }
    }
}

// Install NodeFactory as an alias - unsure which name is best long term:
// The official name in RDF is "term", while "node" is more commonly understood.
// Oficially, a "node" must be in a graph though, while "terms" are independent.
var NodeFactory = TermFactory;


NodeFactory.registerNamespace("dc", "http://purl.org/dc/elements/1.1/")
NodeFactory.registerNamespace("dcterms", "http://purl.org/dc/terms/")
NodeFactory.registerNamespace("rdf", "http://www.w3.org/1999/02/22-rdf-syntax-ns#")
NodeFactory.registerNamespace("rdfs", "http://www.w3.org/2000/01/rdf-schema#")
NodeFactory.registerNamespace("schema", "http://schema.org/")
NodeFactory.registerNamespace("sh", "http://www.w3.org/ns/shacl#")
NodeFactory.registerNamespace("skos", "http://www.w3.org/2004/02/skos/core#")
NodeFactory.registerNamespace("owl", "http://www.w3.org/2002/07/owl#")
NodeFactory.registerNamespace("xsd", "http://www.w3.org/2001/XMLSchema#")

// Candidates:
// NodeFactory.registerNamespace("prov", "http://www.w3.org/ns/prov#");

/**
 * A shortcut for NodeFactory.term(str) - turns a TTL string representation of an RDF
 * term into a proper RDF term.
 * This will also use the globally registered namespace prefixes.
 * @param str  the string representation, e.g. "owl:Thing"
 * @returns
 */
function T(str) {
    return NodeFactory.term(str)
}


/**
 * Creates a query object for a given graph and optional initial solution.
 * The resulting object can be further refined using the functions on
 * AbstractQuery such as <code>match()</code> and <code>filter()</code>.
 * Functions such as <code>nextSolution()</code> can be used to get the actual results.
 * @param graph  the graph to query
 * @param initialSolution  the initial solutions or null for none
 * @returns a query object
 */
function RDFQuery(graph, initialSolution) {
    return new StartQuery(graph, initialSolution ? initialSolution : []);
}


// class AbstractQuery

function AbstractQuery() {
}

// ----------------------------------------------------------------------------
// Query constructor functions, can be chained together
// ----------------------------------------------------------------------------

/**
 * Creates a new query that adds a binding for a given variable into
 * each solution produced by the input query.
 * @param varName  the name of the variable to bind, starting with "?"
 * @param bindFunction  a function that takes a solution object
 *                      and returns a node or null based on it.
 */
AbstractQuery.prototype.bind = function(varName, bindFunction) {
    return new BindQuery(this, varName, bindFunction);
}

/**
 * Creates a new query that filters the solutions produced by this.
 * @param filterFunction  a function that takes a solution object
 *                        and returns true iff that solution is valid
 */
AbstractQuery.prototype.filter = function(filterFunction) {
    return new FilterQuery(this, filterFunction);
}

/**
 * Creates a new query that only allows the first n solutions through.
 * @param limit  the maximum number of results to allow
 */
AbstractQuery.prototype.limit = function(limit) {
    return new LimitQuery(this, limit);
}

/**
 * Creates a new query doing a triple match.
 * In each subject, predicate, object position, the values can either be
 * an RDF term object or null (wildcard) or a string.
 * If it is a string it may either be a variable (starting with "?")
 * or the TTL representation of an RDF term using the T() function.
 * @param s  the match subject
 * @param p  the match predicate
 * @param o  the match object
 */
AbstractQuery.prototype.match = function(s, p, o) {
    return new MatchQuery(this, s, p, o);
}

/**
 * Creates a new query that sorts all input solutions by the bindings
 * for a given variable.
 * @param varName  the name of the variable to sort by, starting with "?"
 */
AbstractQuery.prototype.orderBy = function(varName) {
    return new OrderByQuery(this, varName);
}

/**
 * Creates a new query doing a match where the predicate may be a RDF Path object.
 * Note: This is currently not using lazy evaluation and will always walk all matches.
 * Path syntax:
 * - PredicatePaths: NamedNode
 * - SequencePaths: [path1, path2]
 * - AlternativePaths: { or : [ path1, path2 ] }
 * - InversePaths: { inverse : path }   LIMITATION: Only supports NamedNodes for path here
 * - ZeroOrMorePaths: { zeroOrMore : path }
 * - OneOrMorePaths: { oneOrMore : path }
 * - ZeroOrOnePaths: { zeroOrOne : path }
 * @param s  the match subject or a variable name (string) - must have a value
 *           at execution time!
 * @param path  the match path object (e.g. a NamedNode for a simple predicate hop)
 * @param o  the match object or a variable name (string)
 */
AbstractQuery.prototype.path = function(s, path, o) {
    if(path && path.value && path.isURI()) {
        return new MatchQuery(this, s, path, o);
    }
    else {
        return new PathQuery(this, s, path, o);
    }
}

// TODO: add other SPARQL-like query types
//       - .distinct()
//       - .union(otherQuery)


// ----------------------------------------------------------------------------
// Terminal functions - convenience functions to get values.
// All these functions close the solution iterators.
// ----------------------------------------------------------------------------

/**
 * Adds all nodes produced by a given solution variable into a set.
 * The set must have an add(node) function.
 * @param varName  the name of the variable, starting with "?"
 * @param set  the set to add to
 */
AbstractQuery.prototype.addAllNodes = function(varName, set) {
    var attrName = var2Attr(varName);
    for(var sol = this.nextSolution(); sol; sol = this.nextSolution()) {
        var node = sol[attrName];
        if(node) {
            set.add(node);
        }
    }
}

/**
 * Produces an array of triple objects where each triple object has properties
 * subject, predicate and object derived from the provided template values.
 * Each of these templates can be either a variable name (starting with '?'),
 * an RDF term string (such as "rdfs:label") or a JavaScript node object.
 * @param subject  the subject node
 * @param predicate  the predicate node
 * @param object  the object node
 */
AbstractQuery.prototype.construct = function(subject, predicate, object) {
    var results = [];
    for(var sol = this.nextSolution(); sol; sol = this.nextSolution()) {
        var s = null;
        if(typeof subject === 'string') {
            if(subject.indexOf('?') == 0) {
                s = sol[var2Attr(subject)];
            }
            else {
                s = T(subject);
            }
        }
        else {
            s = subject;
        }
        var p = null;
        if(typeof predicate === 'string') {
            if(predicate.indexOf('?') == 0) {
                p = sol[var2Attr(predicate)];
            }
            else {
                p = T(predicate);
            }
        }
        else {
            p = predicate;
        }

        var o = null;
        if(typeof object === 'string') {
            if(object.indexOf('?') == 0) {
                o = sol[var2Attr(object)];
            }
            else {
                o = T(object);
            }
        }
        else {
            o = object;
        }

        if(s && p && o) {
            results.push({ subject: s, predicate: p, object: o});
        }
    }
    return results;
}

/**
 * Executes a given function for each solution.
 * @param callback  a function that takes a solution as argument
 */
AbstractQuery.prototype.forEach = function(callback) {
    for(var n = this.nextSolution(); n; n = this.nextSolution()) {
        callback(n);
    }
}

/**
 * Executes a given function for each node in a solution set.
 * @param varName  the name of a variable, starting with "?"
 * @param callback  a function that takes a node as argument
 */
AbstractQuery.prototype.forEachNode = function(varName, callback) {
    var attrName = var2Attr(varName);
    for(var sol = this.nextSolution(); sol; sol = this.nextSolution()) {
        var node = sol[attrName];
        if(node) {
            callback(node);
        }
    }
}

/**
 * Turns all result solutions into an array.
 * @return an array consisting of solution objects
 */
AbstractQuery.prototype.getArray = function() {
    var results = [];
    for(var n = this.nextSolution(); n != null; n = this.nextSolution()) {
        results.push(n);
    }
    return results;
}

/**
 * Gets the number of (remaining) solutions.
 * @return the count
 */
AbstractQuery.prototype.getCount = function() {
    return this.getArray().length; // Quick and dirty implementation
}

/**
 * Gets the next solution and, if that exists, returns the binding for a
 * given variable from that solution.
 * @param varName  the name of the binding to get, starting with "?"
 * @return the value of the variable or null or undefined if it doesn't exist
 */
AbstractQuery.prototype.getNode = function(varName) {
    var s = this.nextSolution();
    if(s) {
        this.close();
        return s[var2Attr(varName)];
    }
    else {
        return null;
    }
}

/**
 * Turns all results into an array of bindings for a given variable.
 * @return an array consisting of RDF node objects
 */
AbstractQuery.prototype.getNodeArray = function(varName) {
    var results = [];
    var attr = var2Attr(varName);
    for(var n = this.nextSolution(); n != null; n = this.nextSolution()) {
        results.push(n[attr]);
    }
    return results;
}

/**
 * Turns all result bindings for a given variable into a set.
 * The set has functions .contains and .toArray.
 * @param varName  the name of the variable, starting with "?"
 * @return a set consisting of RDF node objects
 */
AbstractQuery.prototype.getNodeSet = function(varName) {
    var results = new NodeSet();
    var attr = var2Attr(varName);
    for(var n = this.nextSolution(); n != null; n = this.nextSolution()) {
        results.add(n[attr]);
    }
    return results;
}

/**
 * Queries the underlying graph for the object of a subject/predicate combination,
 * where either subject or predicate can be a variable which is substituted with
 * a value from the next input solution.
 * Note that even if there are multiple solutions it will just return the "first"
 * one and since the order of triples in RDF is undefined this may lead to random results.
 * Unbound values produce errors.
 * @param subject  an RDF term or a variable (starting with "?") or a TTL representation
 * @param predicate  an RDF term or a variable (starting with "?") or a TTL representation
 * @return the object of the "first" triple matching the subject/predicate combination
 */
AbstractQuery.prototype.getObject = function(subject, predicate) {
    var sol = this.nextSolution();
    if(sol) {
        this.close();
        var s;
        if(typeof subject === 'string') {
            if(subject.indexOf('?') == 0) {
                s = sol[var2Attr(subject)];
            }
            else {
                s = T(subject);
            }
        }
        else {
            s = subject;
        }
        if(!s) {
            throw "getObject() called with null subject";
        }
        var p;
        if(typeof predicate === 'string') {
            if(predicate.indexOf('?') == 0) {
                p = sol[var2Attr(predicate)];
            }
            else {
                p = T(predicate);
            }
        }
        else {
            p = predicate;
        }
        if(!p) {
            throw "getObject() called with null predicate";
        }

        var it = this.source.find(s, p, null);
        var triple = it.next();
        if(triple) {
            it.close();
            return triple.object;
        }
    }
    return null;
}

/**
 * Tests if there is any solution and closes the query.
 * @return true if there is another solution
 */
AbstractQuery.prototype.hasSolution = function() {
    if(this.nextSolution()) {
        this.close();
        return true;
    }
    else {
        return false;
    }
}


// ----------------------------------------------------------------------------
// Expression functions - may be used in filter and bind queries
// ----------------------------------------------------------------------------

/**
 * Creates a function that takes a solution and compares a given node with
 * the binding of a given variable from that solution.
 * @param varName  the name of the variable (starting with "?")
 * @param node  the node to compare with
 * @returns true if the solution's variable equals the node
 */
function exprEquals(varName, node) {
    return function(sol) {
        return node.equals(sol[var2Attr(varName)]);
    }
}

/**
 * Creates a function that takes a solution and compares a given node with
 * the binding of a given variable from that solution.
 * @param varName  the name of the variable (starting with "?")
 * @param node  the node to compare with
 * @returns true if the solution's variable does not equal the node
 */
function exprNotEquals(varName, node) {
    return function(sol) {
        return !node.equals(sol[var2Attr(varName)]);
    }
}


// ----------------------------------------------------------------------------
// END OF PUBLIC API ----------------------------------------------------------
// ----------------------------------------------------------------------------


// class BindQuery
// Takes all input solutions but adds a value for a given variable so that
// the value is computed by a given function based on the current solution.
// It is illegal to use a variable that already has a value from the input.

function BindQuery(input, varName, bindFunction) {
    this.attr = var2Attr(varName);
    this.source = input.source;
    this.input = input;
    this.bindFunction = bindFunction;
}

BindQuery.prototype = Object.create(AbstractQuery.prototype);

BindQuery.prototype.close = function() {
    this.input.close();
}

// Pulls the next result from the input Query and passes it into
// the given bind function to add a new node
BindQuery.prototype.nextSolution = function() {
    var result = this.input.nextSolution();
    if(result == null) {
        return null;
    }
    else {
        var newNode = this.bindFunction(result);
        if(newNode) {
            result[this.attr] = newNode;
        }
        return result;
    }
}


// class FilterQuery
// Filters the incoming solutions, only letting through those where
// filterFunction(solution) returns true

function FilterQuery(input, filterFunction) {
    this.source = input.source;
    this.input = input;
    this.filterFunction = filterFunction;
}

FilterQuery.prototype = Object.create(AbstractQuery.prototype);

FilterQuery.prototype.close = function() {
    this.input.close();
}

// Pulls the next result from the input Query and passes it into
// the given filter function
FilterQuery.prototype.nextSolution = function() {
    for(;;) {
        var result = this.input.nextSolution();
        if(result == null) {
            return null;
        }
        else if(this.filterFunction(result) === true) {
            return result;
        }
    }
}


// class LimitQuery
// Only allows the first n values of the input query through

function LimitQuery(input, limit) {
    this.source = input.source;
    this.input = input;
    this.limit = limit;
}

LimitQuery.prototype = Object.create(AbstractQuery.prototype);

LimitQuery.prototype.close = function() {
    this.input.close();
}

// Pulls the next result from the input Query unless the number
// of previous calls has exceeded the given limit
LimitQuery.prototype.nextSolution = function() {
    if(this.limit > 0) {
        this.limit--;
        return this.input.nextSolution();
    }
    else {
        this.input.close();
        return null;
    }
}


// class MatchQuery
// Joins the solutions from the input Query with triple matches against
// the current input graph.

function MatchQuery(input, s, p, o) {
    this.source = input.source;
    this.input = input;
    if(typeof s === 'string') {
        if(s.indexOf('?') == 0) {
            this.sv = var2Attr(s);
        }
        else {
            this.s = T(s);
        }
    }
    else {
        this.s = s;
    }
    if(typeof p === 'string') {
        if(p.indexOf('?') == 0) {
            this.pv = var2Attr(p);
        }
        else {
            this.p = T(p);
        }
    }
    else {
        this.p = p;
    }
    if(typeof o === 'string') {
        if(o.indexOf('?') == 0) {
            this.ov = var2Attr(o);
        }
        else {
            this.o = T(o);
        }
    }
    else {
        this.o = o;
    }
}

MatchQuery.prototype = Object.create(AbstractQuery.prototype);

MatchQuery.prototype.close = function() {
    this.input.close();
    if(this.ownIterator) {
        this.ownIterator.close();
    }
}

// This pulls the first solution from the input Query and uses it to
// create an "ownIterator" which applies the input solution to those
// specified by s, p, o.
// Once this "ownIterator" has been exhausted, it moves to the next
// solution from the input Query, and so on.
// At each step, it produces the union of the input solutions plus the
// own solutions.
MatchQuery.prototype.nextSolution = function() {

    var oit = this.ownIterator;
    if(oit) {
        var n = oit.next();
        if(n != null) {
            var result = createSolution(this.inputSolution);
            if(this.sv) {
                result[this.sv] = n.subject;
            }
            if(this.pv) {
                result[this.pv] = n.predicate;
            }
            if(this.ov) {
                result[this.ov] = n.object;
            }
            return result;
        }
        else {
            delete this.ownIterator; // Mark as exhausted
        }
    }

    // Pull from input
    this.inputSolution = this.input.nextSolution();
    if(this.inputSolution) {
        var sm = this.sv ? this.inputSolution[this.sv] : this.s;
        var pm = this.pv ? this.inputSolution[this.pv] : this.p;
        var om = this.ov ? this.inputSolution[this.ov] : this.o;
        this.ownIterator = this.source.find(sm, pm, om);
        return this.nextSolution();
    }
    else {
        return null;
    }
}


// class OrderByQuery
// Sorts all solutions from the input stream by a given variable

function OrderByQuery(input, varName) {
    this.input = input;
    this.source = input.source;
    this.attrName = var2Attr(varName);
}

OrderByQuery.prototype = Object.create(AbstractQuery.prototype);

OrderByQuery.prototype.close = function() {
    this.input.close();
}

OrderByQuery.prototype.nextSolution = function() {
    if(!this.solutions) {
        this.solutions = this.input.getArray();
        var attrName = this.attrName;
        this.solutions.sort(function(s1, s2) {
            return compareTerms(s1[attrName], s2[attrName]);
        });
        this.index = 0;
    }
    if(this.index < this.solutions.length) {
        return this.solutions[this.index++];
    }
    else {
        return null;
    }
}


// class PathQuery
// Expects subject and path to be bound and produces all bindings
// for the object variable or matches that by evaluating the given path

function PathQuery(input, subject, path, object) {
    this.input = input;
    this.source = input.source;
    if(typeof subject === 'string' && subject.indexOf("?") == 0) {
        this.subjectAttr = var2Attr(subject);
    }
    else {
        this.subject = subject;
    }
    if(path == null) {
        throw "Path cannot be unbound";
    }
    if(typeof path === 'string') {
        this.path_ = T(path);
    }
    else {
        this.path_ = path;
    }
    if(typeof object === 'string' && object.indexOf("?") == 0) {
        this.objectAttr = var2Attr(object);
    }
    else {
        this.object = object;
    }
}

PathQuery.prototype = Object.create(AbstractQuery.prototype);

PathQuery.prototype.close = function() {
    this.input.close();
}

PathQuery.prototype.nextSolution = function() {

    var r = this.pathResults;
    if(r) {
        var n = r[this.pathIndex++];
        var result = createSolution(this.inputSolution);
        if(this.objectAttr) {
            result[this.objectAttr] = n;
        }
        if(this.pathIndex == r.length) {
            delete this.pathResults; // Mark as exhausted
        }
        return result;
    }

    // Pull from input
    this.inputSolution = this.input.nextSolution();
    if(this.inputSolution) {
        var sm = this.subjectAttr ? this.inputSolution[this.subjectAttr] : this.subject;
        if(sm == null) {
            throw "Path cannot have unbound subject";
        }
        var om = this.objectAttr ? this.inputSolution[this.objectAttr] : this.object;
        var pathResultsSet = new NodeSet();
        addPathValues(this.source, sm, this.path_, pathResultsSet);
        this.pathResults = pathResultsSet.toArray();
        if(this.pathResults.length == 0) {
            delete this.pathResults;
        }
        else if(om) {
            delete this.pathResults;
            if(pathResultsSet.contains(om)) {
                return this.inputSolution;
            }
        }
        else {
            this.pathIndex = 0;
        }
        return this.nextSolution();
    }
    else {
        return null;
    }
}


// class StartQuery
// This simply produces a single result: the initial solution

function StartQuery(source, initialSolution) {
    this.source = source;
    if (initialSolution && initialSolution.length > 0) {
        this.solution = initialSolution;
    } else {
        this.solution = [{}];
    }
}

StartQuery.prototype = Object.create(AbstractQuery.prototype);

StartQuery.prototype.close = function() {
}

StartQuery.prototype.nextSolution = function() {
    if (this.solution) {
        if (this.solution.length > 0) {
            return this.solution.shift();
        } else {
            delete this.solution;
        }
    }
}


// Helper functions

function createSolution(base) {
    var result = {};
    for(var attr in base) {
        if(base.hasOwnProperty(attr)) {
            result[attr] = base[attr];
        }
    }
    return result;
}


function compareTerms(t1, t2) {
    if(!t1) {
        return !t2 ? 0 : 1;
    }
    else if(!t2) {
        return -1;
    }
    var bt = t1.termType.localeCompare(t2.termType);
    if(bt != 0) {
        return bt;
    }
    else {
        if(t1.isLiteral()) {
            // TODO: Does not handle date comparison
            var bd = t1.datatype.uri.localeCompare(t2.datatype.uri);
            if(bd != 0) {
                return bd;
            }
            else if(T("rdf:langString").equals(t1.datatype)) {
                return t1.language.localeCompare(t2.language);
            }
            else if(T("xsd:integer").equals(t1.datatype) || T("xsd:decimal").equals(t1.datatype) || T("xsd:long").equals(t1.datatype)) {
                const t1val = parseInt(t1.valueOf());
                const t2val = parseInt(t2.valueOf());
                if (t1val === t2val) {
                    return 0;
                } else if (t1val < t2val) {
                    return -1;
                } else {
                    return 1;
                }
            }
            else if(T("xsd:float").equals(t1.datatype) || T("xsd:double").equals(t1.datatype)) {
                const t1val = parseFloat(t1.valueOf());
                const t2val = parseFloat(t2.valueOf());
                if (t1val === t2val) {
                    return 0;
                } else if (t1val < t2val) {
                    return -1;
                } else {
                    return 1;
                }
            }
            else {
                return 0;
            }
        }
        else {
            var bv = t1.value.localeCompare(t2.value);
            if(bv != 0) {
                return bv;
            }
            else {
                return 0;
            }
        }
    }
}

function getLocalName(uri) {
    // TODO: This is not the 100% correct local name algorithm
    var index = uri.lastIndexOf("#");
    if(index < 0) {
        index = uri.lastIndexOf("/");
    }
    if(index < 0) {
        throw "Cannot get local name of " + uri;
    }
    return uri.substring(index + 1);
}


// class NodeSet
// (a super-primitive implementation for now!)

function NodeSet() {
    this.values = [];
}

NodeSet.prototype.add = function(node) {
    if(!this.contains(node)) {
        this.values.push(node);
    }
}

NodeSet.prototype.addAll = function(nodes) {
    for(var i = 0; i < nodes.length; i++) {
        this.add(nodes[i]);
    }
}

NodeSet.prototype.contains = function(node) {
    for(var i = 0; i < this.values.length; i++) {
        if(this.values[i].equals(node)) {
            return true;
        }
    }
    return false;
}

NodeSet.prototype.forEach = function(callback) {
    for(var i = 0; i < this.values.length; i++) {
        callback(this.values[i]);
    }
}

NodeSet.prototype.size = function() {
    return this.values.length;
}

NodeSet.prototype.toArray = function() {
    return this.values;
}

NodeSet.prototype.toString = function() {
    var str = "NodeSet(" + this.size() + "): [";
    var arr = this.toArray();
    for(var i = 0; i < arr.length; i++) {
        if(i > 0) {
            str += ", ";
        }
        str += arr[i];
    }
    return str + "]";
}


function var2Attr(varName) {
    if(!varName.indexOf("?") == 0) {
        throw "Variable name must start with ?";
    }
    if(varName.length == 1) {
        throw "Variable name too short";
    }
    return varName.substring(1);
}



// Simple Path syntax implementation:
// Adds all matches for a given subject and path combination into a given NodeSet.
// This should really be doing lazy evaluation and only up to the point
// where the match object is found.
function addPathValues(graph, subject, path, set) {
    if(path.uri) {
        set.addAll(RDFQuery(graph).match(subject, path, "?object").getNodeArray("?object"));
    }
    else if(Array.isArray(path)) {
        var s = new NodeSet();
        s.add(subject);
        for(var i = 0; i < path.length; i++) {
            var a = s.toArray();
            s = new NodeSet();
            for(var j = 0; j < a.length; j++) {
                addPathValues(graph, a[j], path[i], s);
            }
        }
        set.addAll(s.toArray());
    }
    else if(path.or) {
        for(var i = 0; i < path.or.length; i++) {
            addPathValues(graph, subject, path.or[i], set);
        }
    }
    else if(path.inverse) {
        if(path.inverse.isURI()) {
            set.addAll(RDFQuery(graph).match("?subject", path.inverse, subject).getNodeArray("?subject"));
        }
        else {
            throw "Unsupported: Inverse paths only work for named nodes";
        }
    }
    else if(path.zeroOrOne) {
        addPathValues(graph, subject, path.zeroOrOne, set);
        set.add(subject);
    }
    else if(path.zeroOrMore) {
        walkPath(graph, subject, path.zeroOrMore, set, new NodeSet());
        set.add(subject);
    }
    else if(path.oneOrMore) {
        walkPath(graph, subject, path.oneOrMore, set, new NodeSet());
    }
    else {
        throw "Unsupported path object: " + path;
    }
}

function walkPath(graph, subject, path, set, visited) {
    visited.add(subject);
    var s = new NodeSet();
    addPathValues(graph, subject, path, s);
    var a = s.toArray();
    set.addAll(a);
    for(var i = 0; i < a.length; i++) {
        if(!visited.contains(a[i])) {
            walkPath(graph, a[i], path, set, visited);
        }
    }
}

/// ADDED...
RDFQuery.T = T;
RDFQuery.getLocalName = getLocalName;
RDFQuery.compareTerms = compareTerms;
RDFQuery.exprEquals = exprEquals;
RDFQuery.exprNotEquals = exprNotEquals;
RDFQuery.NodeSet = NodeSet;

module.exports = RDFQuery;
///
},{"./rdfquery/term-factory":114}],114:[function(require,module,exports){
// In some environments such as Nashorn this may already have a value
// In TopBraid this is redirecting to native Jena calls
var TermFactory = {

    REGEX_URI: /^([a-z][a-z0-9+.-]*):(?:\/\/((?:(?=((?:[a-z0-9-._~!$&'()*+,;=:]|%[0-9A-F]{2})*))(\3)@)?(?=(\[[0-9A-F:.]{2,}\]|(?:[a-z0-9-._~!$&'()*+,;=]|%[0-9A-F]{2})*))\5(?::(?=(\d*))\6)?)(\/(?=((?:[a-z0-9-._~!$&'()*+,;=:@\/]|%[0-9A-F]{2})*))\8)?|(\/?(?!\/)(?=((?:[a-z0-9-._~!$&'()*+,;=:@\/]|%[0-9A-F]{2})*))\10)?)(?:\?(?=((?:[a-z0-9-._~!$&'()*+,;=:@\/?]|%[0-9A-F]{2})*))\11)?(?:#(?=((?:[a-z0-9-._~!$&'()*+,;=:@\/?]|%[0-9A-F]{2})*))\12)?$/i,

    impl: require("n3").DataFactory,   // This needs to be connected to an API such as $rdf

    // Globally registered prefixes for TTL short cuts
    namespaces: {},

    /**
     * Registers a new namespace prefix for global TTL short cuts (qnames).
     * @param prefix  the prefix to add
     * @param namespace  the namespace to add for the prefix
     */
    registerNamespace: function (prefix, namespace) {
        if (this.namespaces.prefix) {
            throw "Prefix " + prefix + " already registered"
        }
        this.namespaces[prefix] = namespace;
    },

    /**
     * Produces an RDF* term from a TTL string representation.
     * Also uses the registered prefixes.
     * @param str  a string, e.g. "owl:Thing" or "true" or '"Hello"@en'.
     * @return an RDF term
     */
    term: function (str) {
        // TODO: this implementation currently only supports booleans and qnames - better overload to rdflib.js
        if ("true" === str || "false" === str) {
            return this.literal(str, (this.term("xsd:boolean")));
        }

        if (str.match(/^\d+$/)) {
            return this.literal(str, (this.term("xsd:integer")));
        }

        if (str.match(/^\d+\.\d+$/)) {
            return this.literal(str, (this.term("xsd:float")));
        }

        const col = str.indexOf(":");
        if (col > 0) {
            const ns = this.namespaces[str.substring(0, col)];
            if (ns != null) {
                return this.namedNode(ns + str.substring(col + 1));
            } else {
                if (str.match(REGEX_URI)) {
                    return this.namedNode(str)
                }
            }
        }
        return this.literal(str);
    },

    /**
     * Produces a new blank node.
     * @param id  an optional ID for the node
     */
    blankNode: function (id) {
        return this.impl.blankNode(id);
    },

    /**
     * Produces a new literal.  For example .literal("42", T("xsd:integer")).
     * @param lex  the lexical form, e.g. "42"
     * @param langOrDatatype  either a language string or a URI node with the datatype
     */
    literal: function (lex, langOrDatatype) {
        return this.impl.literal(lex, langOrDatatype)
    },

    // This function is basically left for Task Force compatibility, but the preferred function is uri()
    namedNode: function (uri) {
        return this.impl.namedNode(uri)
    },

    /**
     * Produces a new URI node.
     * @param uri  the URI of the node
     */
    uri: function (uri) {
        return TermFactory.namedNode(uri);
    }
};

module.exports = TermFactory;
},{"n3":61}],115:[function(require,module,exports){
// A simple SHACL validator in JavaScript based on SHACL-JS.

// Design:
//
// First, derive a ShapesGraph object from the definitions in $shapes.
// This manages a map of parameters to ConstraintComponents.
// Each ConstraintComponent manages its list of parameters and a link to the validators.
//
// The ShapesGraph also manages a list of Shapes, each which has a list of Constraints.
// A Constraint is a specific combination of parameters for a constraint component,
// and has functions to access the target nodes.
//
// Each ShapesGraph can be reused between validation calls, and thus often only needs
// to be created once per application.
//
// The validation process is started by creating a ValidationEngine that relies on
// a given ShapesGraph and operates on the current $data().
// It basically walks through all Shapes that have target nodes and runs the validators
// for each Constraint of the shape, producing results along the way.

var TermFactory = require("./rdfquery/term-factory");
var RDFQuery = require("./rdfquery");
var NodeSet = RDFQuery.NodeSet;
var T = RDFQuery.T;
var ValidationFunction = require("./validation-function");

TermFactory.registerNamespace("dash", "http://datashapes.org/dash#");

function RDFQueryUtil($source) {
    this.source = $source;
}

RDFQueryUtil.prototype.getInstancesOf = function ($class) {
    var set = new NodeSet();
    var classes = this.getSubClassesOf($class);
    classes.add($class);
    var car = classes.toArray();
    for (var i = 0; i < car.length; i++) {
        set.addAll(RDFQuery(this.source).match("?instance", "rdf:type", car[i]).getNodeArray("?instance"));
    }
    return set;
};

RDFQueryUtil.prototype.getObject = function ($subject, $predicate) {
    if (!$subject) {
        throw "Missing subject";
    }
    if (!$predicate) {
        throw "Missing predicate";
    }
    return RDFQuery(this.source).match($subject, $predicate, "?object").getNode("?object");
};

RDFQueryUtil.prototype.getSubClassesOf = function ($class) {
    var set = new NodeSet();
    this.walkSubjects(set, $class, T("rdfs:subClassOf"));
    return set;
};

RDFQueryUtil.prototype.isInstanceOf = function ($instance, $class) {
    var classes = this.getSubClassesOf($class);
    var types = $data.query().match($instance, "rdf:type", "?type");
    for (var n = types.nextSolution(); n; n = types.nextSolution()) {
        if (n.type.equals($class) || classes.contains(n.type)) {
            types.close();
            return true;
        }
    }
    return false;
};

RDFQueryUtil.prototype.rdfListToArray = function ($rdfList) {
    if ($rdfList.elements) {
        return $rdfList.elements;
    } else {
        var array = [];
        while (!T("rdf:nil").equals($rdfList)) {
            array.push(this.getObject($rdfList, T("rdf:first")));
            $rdfList = this.getObject($rdfList, T("rdf:rest"));
        }
        return array;
    }
};

RDFQueryUtil.prototype.walkObjects = function ($results, $subject, $predicate) {
    var it = this.source.find($subject, $predicate, null);
    for (var n = it.next(); n; n = it.next()) {
        if (!$results.contains(n.object)) {
            $results.add(n.object);
            this.walkObjects($results, n.object, $predicate);
        }
    }
};

RDFQueryUtil.prototype.walkSubjects = function ($results, $object, $predicate) {
    var it = this.source.find(null, $predicate, $object);
    for (var n = it.next(); n; n = it.next()) {
        if (!$results.contains(n.subject)) {
            $results.add(n.subject);
            this.walkSubjects($results, n.subject, $predicate);
        }
    }
};

var toRDFQueryPath = function ($shapes, shPath) {
    if (shPath.termType === "Collection") {
        var paths = new RDFQueryUtil($shapes).rdfListToArray(shPath);
        var result = [];
        for (var i = 0; i < paths.length; i++) {
            result.push(toRDFQueryPath($shapes, paths[i]));
        }
        return result;
    }
    if (shPath.isURI()) {
        return shPath;
    }
    else if (shPath.isBlankNode()) {
        var util = new RDFQueryUtil($shapes);
        if (util.getObject(shPath, "rdf:first")) {
            var paths = util.rdfListToArray(shPath);
            var result = [];
            for (var i = 0; i < paths.length; i++) {
                result.push(toRDFQueryPath($shapes, paths[i]));
            }
            return result;
        }
        var alternativePath = new RDFQuery($shapes).getObject(shPath, "sh:alternativePath");
        if (alternativePath) {
            var paths = util.rdfListToArray(alternativePath);
            var result = [];
            for (var i = 0; i < paths.length; i++) {
                result.push(toRDFQueryPath($shapes, paths[i]));
            }
            return {or: result};
        }
        var zeroOrMorePath = util.getObject(shPath, "sh:zeroOrMorePath");
        if (zeroOrMorePath) {
            return {zeroOrMore: toRDFQueryPath($shapes, zeroOrMorePath)};
        }
        var oneOrMorePath = util.getObject(shPath, "sh:oneOrMorePath");
        if (oneOrMorePath) {
            return {oneOrMore: toRDFQueryPath($shapes, oneOrMorePath)};
        }
        var zeroOrOnePath = util.getObject(shPath, "sh:zeroOrOnePath");
        if (zeroOrOnePath) {
            return {zeroOrOne: toRDFQueryPath($shapes, zeroOrOnePath)};
        }
        var inversePath = util.getObject(shPath, "sh:inversePath");
        if (inversePath) {
            return {inverse: toRDFQueryPath($shapes, inversePath)};
        }
    }
    throw "Unsupported SHACL path " + shPath;
    // TODO: implement conforming to AbstractQuery.path syntax
    return shPath;
};


// class Constraint

var Constraint = function(shape, component, paramValue, rdfShapesGraph) {
    this.shape = shape;
    this.component = component;
    this.paramValue = paramValue;
    var parameterValues = {};
    var params = component.getParameters();
    for (var i = 0; i < params.length; i++) {
        var param = params[i];
        var value = paramValue ? paramValue : rdfShapesGraph.query().match(shape.shapeNode, param, "?value").getNode("?value");
        if (value) {
            var localName = RDFQuery.getLocalName(param.uri);
            parameterValues[localName] = value;
        }
    }
    this.parameterValues = parameterValues;
};

Constraint.prototype.getParameterValue = function (paramName) {
    return this.parameterValues[paramName];
};

// class ConstraintComponent

var ConstraintComponent = function(node, context) {
    this.context = context;
    this.node = node;
    var parameters = [];
    var parameterNodes = [];
    var requiredParameters = [];
    var optionals = {};
    var that = this;
    this.context.$shapes.query().
        match(node, "sh:parameter", "?parameter").
        match("?parameter", "sh:path", "?path").forEach(function (sol) {
            parameters.push(sol.path);
            parameterNodes.push(sol.parameter);
            if (that.context.$shapes.query().match(sol.parameter, "sh:optional", "true").hasSolution()) {
                optionals[sol.path.uri] = true;
            }
            else {
                requiredParameters.push(sol.path);
            }
        });
    this.optionals = optionals;
    this.parameters = parameters;
    this.parameterNodes = parameterNodes;
    this.requiredParameters = requiredParameters;
    this.nodeValidationFunction = this.findValidationFunction(T("sh:nodeValidator"));
    if (!this.nodeValidationFunction) {
        this.nodeValidationFunction = this.findValidationFunction(T("sh:validator"));
        this.nodeValidationFunctionGeneric = true;
    }
    this.propertyValidationFunction = this.findValidationFunction(T("sh:propertyValidator"));
    if (!this.propertyValidationFunction) {
        this.propertyValidationFunction = this.findValidationFunction(T("sh:validator"));
        this.propertyValidationFunctionGeneric = true;
    }
};

ConstraintComponent.prototype.findValidationFunction = function (predicate) {
    var functionName = this.context.$shapes.query().
        match(this.node, predicate, "?validator").
        match("?validator", "rdf:type", "sh:JSValidator").
        match("?validator", "sh:jsFunctionName", "?functionName").
        getNode("?functionName");
    var libraryNode = this.context.$shapes.query().
      match(this.node, predicate, "?validator").
      match("?validator", "rdf:type", "sh:JSValidator").
      match("?validator", "sh:jsLibrary", "?library").
      getNode("?library");

    var libraries = [];
    while (libraryNode != null) {
        var libraryUrl = this.context.$shapes.query().match(libraryNode, "sh:jsLibraryURL", "?libraryUrl").getNode("?libraryUrl");
        if (libraryUrl == null) {
            break;
        } else {
            libraries.unshift(libraryUrl.toString());
        }
        libraryNode = this.context.$shapes.query().match(libraryNode, "sh:jsLibrary", "?library").getNode("?library");
    }

    if (functionName) {
        var script = "var makeFindInScript = function($data, $shapes, SHACL, TermFactory) {\n"
        + " this.$data = $data; this.$shapes = $shapes; this.SHACL = SHACL; this.TermFactory = TermFactory;\n";
        for (var i=0; i<libraries.length; i++)
            script = script + this.context.functionsRegistry[libraries[i]];
        script = script + "\n";
        script = script + "  return function(name) { return eval(name) }\n}";
        eval(script);
        var findInScript = makeFindInScript(this.context.$data, this.context.$shapes, this.context, TermFactory);
        return new ValidationFunction(functionName.lex, this.parameters, findInScript);
    }
    else {
        return null;
    }
};

ConstraintComponent.prototype.getParameters = function () {
    return this.parameters;
};

ConstraintComponent.prototype.isComplete = function (shapeNode) {
    for (var i = 0; i < this.parameters.length; i++) {
        var parameter = this.parameters[i];
        if (!this.isOptional(parameter.uri)) {
            if (!this.context.$shapes.query().match(shapeNode, parameter, null).hasSolution()) {
                return false;
            }
        }
    }
    return true;
};

ConstraintComponent.prototype.isOptional = function (parameterURI) {
    return this.optionals[parameterURI];
};


// class Shape

var Shape = function(context, shapeNode) {

    this.context = context;
    this.severity = context.$shapes.query().match(shapeNode, "sh:severity", "?severity").getNode("?severity");
    if (!this.severity) {
        this.severity = T("sh:Violation");
    }

    this.deactivated = context.$shapes.query().match(shapeNode, "sh:deactivated", "true").hasSolution();
    this.path = context.$shapes.query().match(shapeNode, "sh:path", "?path").getNode("?path");
    this.shapeNode = shapeNode;
    this.constraints = [];

    var handled = new NodeSet();
    var self = this;
    var that = this;
    context.$shapes.query().match(shapeNode, "?predicate", "?object").forEach(function (sol) {
        var component = that.context.shapesGraph.getComponentWithParameter(sol.predicate);
        if (component && !handled.contains(component.node)) {
            var params = component.getParameters();
            if (params.length === 1) {
                self.constraints.push(new Constraint(self, component, sol.object, context.$shapes));
            }
            else if (component.isComplete(shapeNode)) {
                self.constraints.push(new Constraint(self, component, undefined, context.$shapes));
                handled.add(component.node);
            }
        }
    });
};

Shape.prototype.getConstraints = function () {
    return this.constraints;
};

Shape.prototype.getTargetNodes = function (rdfDataGraph) {
    var results = new NodeSet();

    if (new RDFQueryUtil(this.context.$shapes).isInstanceOf(this.shapeNode, T("rdfs:Class"))) {
        results.addAll(new RDFQueryUtil(rdfDataGraph).getInstancesOf(this.shapeNode).toArray());
    }

    this.context.$shapes.query().
        match(this.shapeNode, "sh:targetClass", "?targetClass").forEachNode("?targetClass", function (targetClass) {
            results.addAll(new RDFQueryUtil(rdfDataGraph).getInstancesOf(targetClass).toArray());
        });

    results.addAll(this.context.$shapes.query().
        match(this.shapeNode, "sh:targetNode", "?targetNode").getNodeArray("?targetNode"));

    this.context.$shapes.query().
        match(this.shapeNode, "sh:targetSubjectsOf", "?subjectsOf").
        forEachNode("?subjectsOf", function (predicate) {
            results.addAll(rdfDataGraph.query().match("?subject", predicate, null).getNodeArray("?subject"));
        });

    this.context.$shapes.query().
        match(this.shapeNode, "sh:targetObjectsOf", "?objectsOf").
        forEachNode("?objectsOf", function (predicate) {
            results.addAll(rdfDataGraph.query().match(null, predicate, "?object").getNodeArray("?object"));
        });

    return results.toArray();
};


Shape.prototype.getValueNodes = function (focusNode, rdfDataGraph) {
    if (this.path) {
        return rdfDataGraph.query().path(focusNode, toRDFQueryPath(this.context.$shapes, this.path), "?object").getNodeArray("?object");
    }
    else {
        return [focusNode];
    }
};

Shape.prototype.isPropertyShape = function () {
    return this.path != null;
};


// class ShapesGraph

var ShapesGraph = function (context) {

    this.context = context;

    // Collect all defined constraint components
    var components = [];
    new RDFQueryUtil(this.context.$shapes).getInstancesOf(T("sh:ConstraintComponent")).forEach(function (node) {
        if (!T("dash:ParameterConstraintComponent").equals(node)) {
            components.push(new ConstraintComponent(node, context));
        }
    });
    this.components = components;

    // Build map from parameters to constraint components
    this.parametersMap = {};
    for (var i = 0; i < this.components.length; i++) {
        var component = this.components[i];
        var parameters = component.getParameters();
        for (var j = 0; j < parameters.length; j++) {
            this.parametersMap[parameters[j].value] = component;
        }
    }

    // Collection of shapes is populated on demand - here we remember the instances
    this.shapes = {}; // Keys are the URIs/bnode ids of the shape nodes
};


ShapesGraph.prototype.getComponentWithParameter = function (parameter) {
    return this.parametersMap[parameter.value];
};

ShapesGraph.prototype.getShape = function (shapeNode) {
    var shape = this.shapes[shapeNode.value];
    if (!shape) {
        shape = new Shape(this.context, shapeNode);
        this.shapes[shapeNode.value] = shape;
    }
    return shape;
};

ShapesGraph.prototype.getShapeNodesWithConstraints = function () {
    if (!this.shapeNodesWithConstraints) {
        var set = new NodeSet();
        for (var i = 0; i < this.components.length; i++) {
            var params = this.components[i].requiredParameters;
            for (var j = 0; j < params.length; j++) {
                this.context.$shapes.query().match("?shape", params[j], null).addAllNodes("?shape", set);
            }
        }
        this.shapeNodesWithConstraints = set.toArray();
    }
    return this.shapeNodesWithConstraints;
};

ShapesGraph.prototype.getShapesWithTarget = function () {

    if (!this.targetShapes) {
        this.targetShapes = [];
        var cs = this.getShapeNodesWithConstraints();
        for (var i = 0; i < cs.length; i++) {
            var shapeNode = cs[i];
            if (new RDFQueryUtil(this.context.$shapes).isInstanceOf(shapeNode, T("rdfs:Class")) ||
                this.context.$shapes.query().match(shapeNode, "sh:targetClass", null).hasSolution() ||
                this.context.$shapes.query().match(shapeNode, "sh:targetNode", null).hasSolution() ||
                this.context.$shapes.query().match(shapeNode, "sh:targetSubjectsOf", null).hasSolution() ||
                this.context.$shapes.query().match(shapeNode, "sh:targetObjectsOf", null).hasSolution() ||
                this.context.$shapes.query().match(shapeNode, "sh:target", null).hasSolution()) {
                this.targetShapes.push(this.getShape(shapeNode));
            }
        }
    }

    return this.targetShapes;
};

var fetchLibraries = function(libraries, context, acc, k) {
    if (libraries.length === 0) {
        k(null, acc);
    } else {
        var nextLibrary = libraries.shift();
        if (context.functionsRegistry[nextLibrary] != null) {
            fetchLibraries(libraries, context, acc, k);
        } else {
            var response = "";
            try {
                require('http').get(nextLibrary, function (res) {
                    res.on('data', function (b) {
                        response = response + b.toString();
                    });

                    res.on('error', function (e) {
                        k(e, null);
                    });

                    res.on('end', function () {
                        acc[nextLibrary] = response;
                        fetchLibraries(libraries, context, acc, k);
                    });
                });
            } catch (e) {
                k(e, null);
            }
        }
    }
};

ShapesGraph.prototype.loadJSLibraries = function(k) {
    var that = this;
    var libraries= this.context.$shapes.query().
      match("?library", "sh:jsLibraryURL", "?library").getNodeArray("?library");
    for (var i=0 ;i<libraries.length; i++) {
        libraries[i] = libraries[i].toString();
    }
    fetchLibraries(libraries, this.context, that.context.functionsRegistry, function(err) {
        if (err) {
            k(err);
        } else {
            k();
        }
    })
};


module.exports = ShapesGraph;
},{"./rdfquery":113,"./rdfquery/term-factory":114,"./validation-function":118,"http":84}],116:[function(require,module,exports){

var ValidationEngineConfiguration = function() {
    // By default validate all errors
    this.validationErrorBatch = -1;
};


ValidationEngineConfiguration.prototype.setValidationErrorBatch = function(validationErrorBatch) {
    this.validationErrorBatch = validationErrorBatch;
    return this;
};

ValidationEngineConfiguration.prototype.getValidationErrorBatch = function() {
    return this.validationErrorBatch;
};

module.exports = ValidationEngineConfiguration;
},{}],117:[function(require,module,exports){
var RDFQuery = require("./rdfquery");
var T = RDFQuery.T;
var TermFactory = require("./rdfquery/term-factory");
var ValidationEngineConfiguration = require("./validation-engine-configuration");

var nodeLabel = function (node, store) {
    if (node.termType === "Collection") {
        var acc = [];
        for (var i = 0; i < node.elements.length; i++) {
            acc.push(nodeLabel(node.elements[i], store));
        }
        return acc.join(", ");
    }
    if (node.isURI()) {
        for (prefix in store.namespaces) {
            var ns = store.namespaces[prefix];
            if (node.value.indexOf(ns) === 0) {
                return prefix + ":" + node.value.substring(ns.length);
            }
        }
        return "<" + node.value + ">";
    }
    else if (node.isBlankNode()) {
        return "Blank node " + node.toString();
    }
    else {
        return "" + node;
    }
};

// class ValidationEngine

var ValidationEngine = function (context, conformanceOnly) {
    this.context = context;
    this.conformanceOnly = conformanceOnly;
    this.results = [];
    this.recordErrorsLevel = 0;
    this.violationsCount = 0;
    this.setConfiguration(new ValidationEngineConfiguration());
};

ValidationEngine.prototype.addResultProperty = function (result, predicate, object) {
    this.results.push([result, predicate, object]);
};

/**
 * Creates a new BlankNode holding the SHACL validation result, adding the default
 * properties for the constraint, focused node and value node
 */
ValidationEngine.prototype.createResult = function (constraint, focusNode, valueNode) {
    var result = TermFactory.blankNode();
    var severity = constraint.shape.severity;
    var sourceConstraintComponent = constraint.component.node;
    var sourceShape = constraint.shape.shapeNode;
    this.addResultProperty(result, T("rdf:type"), T("sh:ValidationResult"));
    this.addResultProperty(result, T("sh:resultSeverity"), severity);
    this.addResultProperty(result, T("sh:sourceConstraintComponent"), sourceConstraintComponent);
    this.addResultProperty(result, T("sh:sourceShape"), sourceShape);
    this.addResultProperty(result, T("sh:focusNode"), focusNode);
    if (valueNode) {
        this.addResultProperty(result, T("sh:value"), valueNode);
    }
    return result;
};

/**
 * Creates all the validation result nodes and messages for the result of applying the validation logic
 * of a constraints against a node.
 * Result passed as the first argument can be false, a resultMessage or a validation result object.
 * If none of these values is passed no error result or error message will be created.
 */
ValidationEngine.prototype.createResultFromObject = function (obj, constraint, focusNode, valueNode) {
    if (obj === false) {
        if (this.recordErrorsLevel > 0) {
            if (this.conformanceOnly) {
                return false;
            } else {
                return true;
            }
        }

        if (this.conformanceOnly) {
            return false;
        }
        var result = this.createResult(constraint, focusNode, valueNode);
        if (constraint.shape.isPropertyShape()) {
            this.addResultProperty(result, T("sh:resultPath"), constraint.shape.path); // TODO: Make deep copy
        }
        this.createResultMessages(result, constraint);
        return true;
    }
    else if (typeof obj === 'string') {
        if (this.recordErrorsLevel > 0) {
            if (this.conformanceOnly) {
                return false;
            } else {
                return true;
            }
        }
        if (this.conformanceOnly) {
            return false;
        }
        result = this.createResult(constraint, focusNode, valueNode);
        if (constraint.shape.isPropertyShape()) {
            this.addResultProperty(result, T("sh:resultPath"), constraint.shape.path); // TODO: Make deep copy
        }
        this.addResultProperty(result, T("sh:resultMessage"), TermFactory.literal(obj, T("xsd:string")));
        this.createResultMessages(result, constraint);
        return true;
    }
    else if (typeof obj === 'object') {
        if (this.recordErrorsLevel > 0) {
            if (this.conformanceOnly) {
                return false;
            } else {
                return true;
            }
        }
        if (this.conformanceOnly) {
            return false;
        }
        result = this.createResult(constraint, focusNode);
        if (obj.path) {
            this.addResultProperty(result, T("sh:resultPath"), obj.path); // TODO: Make deep copy
        }
        else if (constraint.shape.isPropertyShape()) {
            this.addResultProperty(result, T("sh:resultPath"), constraint.shape.path); // TODO: Make deep copy
        }
        if (obj.value) {
            this.addResultProperty(result, T("sh:value"), obj.value);
        }
        else if (valueNode) {
            this.addResultProperty(result, T("sh:value"), valueNode);
        }
        if (obj.message) {
            this.addResultProperty(result, T("sh:resultMessage"), TermFactory.literal(obj.message, T("xsd:string")));
        }
        else {
            this.createResultMessages(result, constraint);
        }
        return true;
    }
    return false;
};

/**
 * Creates a result message from the result and the message pattern in the constraint
 */
ValidationEngine.prototype.createResultMessages = function (result, constraint) {
    var ms = this.context.$shapes.query()
        .match(constraint.shape.shapeNode, "sh:message", "?message")
        .getNodeArray("?message");
    if (ms.length === 0) {
        var generic = constraint.shape.isPropertyShape() ?
            constraint.component.propertyValidationFunctionGeneric :
            constraint.component.nodeValidationFunctionGeneric;
        var predicate = generic ? T("sh:validator") : (constraint.shape.isPropertyShape() ? T("sh:propertyValidator") : T("sh:nodeValidator"));
        ms = this.context.$shapes.query()
            .match(constraint.component.node, predicate, "?validator")
            .match("?validator", "sh:message", "?message")
            .getNodeArray("?message");
    }
    if (ms.length === 0) {
        ms = this.context.$shapes.query()
            .match(constraint.component.node, "sh:message", "?message")
            .getNodeArray("?message");
    }
    for (var i = 0; i < ms.length; i++) {
        var m = ms[i];
        var str = this.withSubstitutions(m, constraint);
        this.addResultProperty(result, T("sh:resultMessage"), str);
    }
};

/**
 * Validates the data graph against the shapes graph
 */
ValidationEngine.prototype.validateAll = function (rdfDataGraph) {
    if (this.maxErrorsReached()) {
        return true;
    } else {
        this.results = [];
        var foundError = false;
        var shapes = this.context.shapesGraph.getShapesWithTarget();
        for (var i = 0; i < shapes.length; i++) {
            var shape = shapes[i];
            var focusNodes = shape.getTargetNodes(rdfDataGraph);
            for (var j = 0; j < focusNodes.length; j++) {
                if (this.validateNodeAgainstShape(focusNodes[j], shape, rdfDataGraph)) {
                    foundError = true;
                }
            }
        }
        return foundError;
    }
};

/**
 * Returns true if any violation has been found
 */
ValidationEngine.prototype.validateNodeAgainstShape = function (focusNode, shape, rdfDataGraph) {
    if (this.maxErrorsReached()) {
        return true;
    } else {
        if (shape.deactivated) {
            return false;
        }
        var constraints = shape.getConstraints();
        var valueNodes = shape.getValueNodes(focusNode, rdfDataGraph);
        var errorFound = false;
        for (var i = 0; i < constraints.length; i++) {
            if (this.validateNodeAgainstConstraint(focusNode, valueNodes, constraints[i], rdfDataGraph)) {
                errorFound = true;
            }
        }
        return errorFound;
    }
};

ValidationEngine.prototype.validateNodeAgainstConstraint = function (focusNode, valueNodes, constraint, rdfDataGraph) {
    if (this.maxErrorsReached()) {
        return true;
    } else {
        if (T("sh:PropertyConstraintComponent").equals(constraint.component.node)) {
            var errorFound = false;
            for (var i = 0; i < valueNodes.length; i++) {
                if (this.validateNodeAgainstShape(valueNodes[i], this.context.shapesGraph.getShape(constraint.paramValue), rdfDataGraph)) {
                    errorFound = true;
                }
            }
            return errorFound;
        }
        // TODO add SPARQL here
        else {
            var validationFunction = constraint.shape.isPropertyShape() ?
                constraint.component.propertyValidationFunction :
                constraint.component.nodeValidationFunction;
            if (validationFunction) {
                var generic = constraint.shape.isPropertyShape() ?
                    constraint.component.propertyValidationFunctionGeneric :
                    constraint.component.nodeValidationFunctionGeneric;
                if (generic) {
                    // Generic sh:validator is called for each value node separately
                    var errorFound = false;
                    for (i = 0; i < valueNodes.length; i++) {
                        if (this.maxErrorsReached()) {
                            break;
                        }
                        var iterationError = false;
                        var valueNode = valueNodes[i];
                        //if (validationFunction.funcName === "validateAnd" || validationFunction.funcName === "validateOr" || validationFunction.funcName === "validateNot") {
                        this.recordErrorsLevel++;
                        //}
                        var obj = validationFunction.execute(focusNode, valueNode, constraint);
                        //if (validationFunction.funcName === "validateAnd" || validationFunction.funcName === "validateOr" || validationFunction.funcName === "validateNot") {
                        this.recordErrorsLevel--;
                        //}
                        if (Array.isArray(obj)) {
                            for (a = 0; a < obj.length; a++) {
                                if (this.createResultFromObject(obj[a], constraint, focusNode, valueNode)) {
                                    iterationError = true;
                                }
                            }
                        }
                        else {
                            if (this.createResultFromObject(obj, constraint, focusNode, valueNode)) {
                                iterationError = true;
                            }
                        }
                        if (iterationError) {
                            this.violationsCount++;
                        }
                        errorFound = errorFound || iterationError;
                    }
                    return errorFound;
                }
                else {
                    //if (validationFunction.funcName === "validateAnd" || validationFunction.funcName === "validateOr" || validationFunction.funcName === "validateNot") {
                    this.recordErrorsLevel++;
                    //}
                    obj = validationFunction.execute(focusNode, null, constraint);
                    //if (validationFunction.funcName === "validateAnd" || validationFunction.funcName === "validateOr" || validationFunction.funcName === "validateNot") {
                    this.recordErrorsLevel--;
                    //}
                    if (Array.isArray(obj)) {
                        var errorFound = false;
                        for (var a = 0; a < obj.length; a++) {
                            if (this.createResultFromObject(obj[a], constraint, focusNode)) {
                                errorFound = true;
                            }
                        }
                        return errorFound;
                    }
                    else {
                        if (this.createResultFromObject(obj, constraint, focusNode)) {
                            return true;
                        }
                    }
                }
            }
            else {
                throw "Cannot find validator for constraint component " + constraint.component.node.value;
            }
        }
        return false;
    }
};

ValidationEngine.prototype.maxErrorsReached = function() {
    if (this.getConfiguration().getValidationErrorBatch() === -1) {
        return false;
    } else {
        return this.violationsCount >= this.getConfiguration().getValidationErrorBatch();
    }
};

ValidationEngine.prototype.withSubstitutions = function (msg, constraint) {
    var str = msg.lex;
    var values = constraint.parameterValues;
    for (var key in values) {
        var label = nodeLabel(values[key], this.context.$shapes);
        str = str.replace("{$" + key + "}", label);
        str = str.replace("{?" + key + "}", label);
    }
    return TermFactory.literal(str, msg.language | msg.datatype);
};

ValidationEngine.prototype.getConfiguration = function () {
    return this.configuration;
};

ValidationEngine.prototype.setConfiguration = function(configuration) {
    this.configuration = configuration;
};

module.exports = ValidationEngine;
},{"./rdfquery":113,"./rdfquery/term-factory":114,"./validation-engine-configuration":116}],118:[function(require,module,exports){
(function (global){
// class ValidationFunction
var RDFQuery = require("./rdfquery");
var debug = require("debug")("validation-function");

var globalObject = typeof window !== 'undefined' ? window : global;

var ValidationFunction = function (functionName, parameters, findInScript) {

    this.funcName = functionName;
    this.func = findInScript(functionName);
    if (!this.func) {
        throw "Cannot find validator function " + functionName;
    }
    // Get list of argument of the function, see
    // https://davidwalsh.name/javascript-arguments
    var args = this.func.toString().match(/function\s.*?\(([^)]*)\)/)[1];
    var funcArgsRaw = args.split(',').map(function (arg) {
        return arg.replace(/\/\*.*\*\//, '').trim();
    }).filter(function (arg) {
        return arg;
    });
    this.funcArgs = [];
    this.parameters = [];
    for (var i = 0; i < funcArgsRaw.length; i++) {
        var arg = funcArgsRaw[i];
        if (arg.indexOf("$") === 0) {
            arg = arg.substring(1);
        }
        this.funcArgs.push(arg);
        for (var j = 0; j < parameters.length; j++) {
            var parameter = parameters[j];
            var localName = RDFQuery.getLocalName(parameter.value);
            if (arg === localName) {
                this.parameters[i] = parameter;
                break;
            }
        }
    }
};

ValidationFunction.prototype.doExecute = function (args) {
    return this.func.apply(globalObject, args);
};

ValidationFunction.prototype.execute = function (focusNode, valueNode, constraint) {
    debug("Validating " + this.funcName);
    var args = [];
    for (var i = 0; i < this.funcArgs.length; i++) {
        var arg = this.funcArgs[i];
        var param = this.parameters[i];
        if (param) {
            var value = constraint.getParameterValue(arg);
            args.push(value);
        }
        else if (arg === "focusNode") {
            args.push(focusNode);
        }
        else if (arg === "value") {
            args.push(valueNode);
        }
        else if (arg === "currentShape") {
            args.push(constraint.shape.shapeNode);
        }
        else if (arg === "path") {
            args.push(constraint.shape.path);
        }
        else if (arg === "shapesGraph") {
            args.push("DummyShapesGraph");
        }
        else if (arg === "this") {
            args.push(focusNode);
        }
        else {
            throw "Unexpected validator function argument " + arg + " for function " + this.funcName;
        }
    }
    return this.doExecute(args);
};

module.exports = ValidationFunction;
}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./rdfquery":113,"debug":17}],119:[function(require,module,exports){


var extractValue = function(node, property) {
    var obj = node[property];
    if (obj) {
        return obj[0]["@value"];
    }
};

var extractId = function(node, property) {
    var obj = node[property];
    if (obj) {
        return obj[0]["@id"];
    }
};

var ValidationResult = function(resultNode, g) {
    this.graph = g;
    this.resultNode = resultNode;
};

ValidationResult.prototype.message = function() {
    return extractValue(this.resultNode, "http://www.w3.org/ns/shacl#resultMessage");
};

ValidationResult.prototype.path = function() {
    return extractId(this.resultNode, "http://www.w3.org/ns/shacl#resultPath");
};

ValidationResult.prototype.sourceConstraintComponent = function() {
    return extractId(this.resultNode, "http://www.w3.org/ns/shacl#sourceConstraintComponent");
};

ValidationResult.prototype.focusNode = function() {
    return extractId(this.resultNode, "http://www.w3.org/ns/shacl#focusNode");
};

ValidationResult.prototype.severity = function() {
    var severity = extractId(this.resultNode, "http://www.w3.org/ns/shacl#resultSeverity");
    if (severity != null) {
        return severity.split("#")[1];
    }
};

ValidationResult.prototype.sourceConstraintComponent = function() {
    return extractId(this.resultNode, "http://www.w3.org/ns/shacl#sourceConstraintComponent");
};

ValidationResult.prototype.sourceShape = function() {
    return extractId(this.resultNode, "http://www.w3.org/ns/shacl#sourceShape");
};

var ValidationReport = function(g) {
    this.graph = g;
    this.validationNode = null;
    for(var i=0; i<g.length; i++) {
        var conforms = g[i]["http://www.w3.org/ns/shacl#conforms"];
        if (conforms != null && conforms[0] != null) {
            this.validationNode = g[i];
            break;
        }
    }
    if (this.validationNode == null) {
        throw new Exception("Cannot find validation report node");
    }
};

ValidationReport.prototype.conforms = function() {
    var conforms = this.validationNode["http://www.w3.org/ns/shacl#conforms"][0];
    if (conforms != null) {
        return conforms["@value"] === "true";
    }
};

ValidationReport.prototype.results = function() {
    var results = this.validationNode["http://www.w3.org/ns/shacl#result"] || [];
    var that = this;
    return results.map(function(result) {
        return new ValidationResult(that.findNode(result["@id"]), this.graph);
    });
};

ValidationReport.prototype.findNode = function(id) {
    for (var i=0; i<this.graph.length; i++) {
        if (this.graph[i]["@id"] === id) {
            return this.graph[i];
        }
    }
};


module.exports = ValidationReport;
},{}],120:[function(require,module,exports){
module.exports = {"dash":"# baseURI: http://datashapes.org/dash\n# imports: http://www.w3.org/ns/shacl#\n# prefix: dash\n\n@prefix dash: <http://datashapes.org/dash#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n@prefix sh: <http://www.w3.org/ns/shacl#> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n<http://datashapes.org/dash>\n  rdf:type owl:Ontology ;\n  rdfs:comment \"\"\"DASH defines SPARQL-based validators for many SHACL Core constraint components. These are (among others) utilized by TopBraid and its API. Note that constraint components that require validation of nested shapes (such as sh:node) are not implementable without a function such as tosh:hasShape.\n\nDASH is also a SHACL library for frequently needed features and design patterns. All features in this library are 100% standards compliant and will work on any engine that fully supports SHACL.\"\"\" ;\n  rdfs:label \"DASH Data Shapes Library\" ;\n  owl:imports sh: ;\n  sh:declare [\n      sh:namespace \"http://datashapes.org/dash#\"^^xsd:anyURI ;\n      sh:prefix \"dash\" ;\n    ] ;\n  sh:declare [\n      sh:namespace \"http://purl.org/dc/terms/\"^^xsd:anyURI ;\n      sh:prefix \"dcterms\" ;\n    ] ;\n  sh:declare [\n      sh:namespace \"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"^^xsd:anyURI ;\n      sh:prefix \"rdf\" ;\n    ] ;\n  sh:declare [\n      sh:namespace \"http://www.w3.org/2000/01/rdf-schema#\"^^xsd:anyURI ;\n      sh:prefix \"rdfs\" ;\n    ] ;\n  sh:declare [\n      sh:namespace \"http://www.w3.org/2001/XMLSchema#\"^^xsd:anyURI ;\n      sh:prefix \"xsd\" ;\n    ] ;\n  sh:declare [\n      sh:namespace \"http://www.w3.org/2002/07/owl#\"^^xsd:anyURI ;\n      sh:prefix \"owl\" ;\n    ] ;\n  sh:declare [\n      sh:namespace \"http://www.w3.org/2004/02/skos/core#\"^^xsd:anyURI ;\n      sh:prefix \"skos\" ;\n    ] ;\n.\ndash:AllObjects\n  rdf:type dash:AllObjectsTarget ;\n  rdfs:comment \"A reusable instance of dash:AllObjectsTarget.\" ;\n  rdfs:label \"All objects\" ;\n.\ndash:AllObjectsTarget\n  rdf:type sh:JSTargetType ;\n  rdf:type sh:SPARQLTargetType ;\n  rdfs:comment \"A target containing all objects in the data graph as focus nodes.\" ;\n  rdfs:label \"All objects target\" ;\n  rdfs:subClassOf sh:Target ;\n  sh:jsFunctionName \"dash_allObjects\" ;\n  sh:jsLibrary dash:DASHJSLibrary ;\n  sh:labelTemplate \"All objects\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n  sh:select \"\"\"SELECT DISTINCT ?this\nWHERE {\n    ?anyS ?anyP ?this .\n}\"\"\" ;\n.\ndash:AllSubjects\n  rdf:type dash:AllSubjectsTarget ;\n  rdfs:comment \"A reusable instance of dash:AllSubjectsTarget.\" ;\n  rdfs:label \"All subjects\" ;\n.\ndash:AllSubjectsTarget\n  rdf:type sh:JSTargetType ;\n  rdf:type sh:SPARQLTargetType ;\n  rdfs:comment \"A target containing all subjects in the data graph as focus nodes.\" ;\n  rdfs:label \"All subjects target\" ;\n  rdfs:subClassOf sh:Target ;\n  sh:jsFunctionName \"dash_allSubjects\" ;\n  sh:jsLibrary dash:DASHJSLibrary ;\n  sh:labelTemplate \"All subjects\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n  sh:select \"\"\"SELECT DISTINCT ?this\nWHERE {\n    ?this ?anyP ?anyO .\n}\"\"\" ;\n.\ndash:ClosedByTypesConstraintComponent\n  rdf:type sh:ConstraintComponent ;\n  rdfs:comment \"A constraint component that can be used to declare that focus nodes are \\\"closed\\\" based on their rdf:types, meaning that focus nodes may only have values for the properties that are explicitly enumerated via sh:property/sh:path in property constraints at their rdf:types and the superclasses of those. This assumes that the type classes are also shapes.\" ;\n  rdfs:label \"Closed by types constraint component\" ;\n  sh:nodeValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateClosedByTypesNode\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n      sh:message \"Property is not among those permitted for any of the types\" ;\n    ] ;\n  sh:nodeValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:message \"Property {?path} is not among those permitted for any of the types\" ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"SELECT $this (?predicate AS ?path) ?value\nWHERE {\n\tFILTER ($closedByTypes) .\n    $this ?predicate ?value .\n\tFILTER (?predicate != rdf:type) .\n\tFILTER NOT EXISTS {\n\t\t$this rdf:type ?type .\n\t\t?type rdfs:subClassOf* ?class .\n\t\tGRAPH $shapesGraph {\n\t\t\t?class sh:property/sh:path ?predicate .\n\t\t}\n\t}\n}\"\"\" ;\n    ] ;\n  sh:parameter dash:ClosedByTypesConstraintComponent-closedByTypes ;\n  sh:targetClass sh:NodeShape ;\n.\ndash:ClosedByTypesConstraintComponent-closedByTypes\n  rdf:type sh:Parameter ;\n  sh:path dash:closedByTypes ;\n  sh:datatype xsd:boolean ;\n  sh:description \"True to indicate that the focus nodes are closed by their types. A constraint violation is reported for each property value of the focus node where the property is not among those that are explicitly declared via sh:property/sh:path in any of the rdf:types of the focus node (and their superclasses). The property rdf:type is always permitted.\" ;\n.\ndash:CoExistsWithConstraintComponent\n  rdf:type sh:ConstraintComponent ;\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  rdfs:comment \"A constraint component that can be used to express a constraint on property shapes so that if the property path has any value then the given property must also have a value, and vice versa.\" ;\n  rdfs:label \"Co-exists-with constraint component\" ;\n  sh:message \"Values must co-exist with values of {$coExistsWith}\" ;\n  sh:parameter dash:CoExistsWithConstraintComponent-coExistsWith ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateCoExistsWith\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"SELECT $this\nWHERE {\n\t{\n    \tFILTER (EXISTS { $this $PATH ?any } && NOT EXISTS { $this $coExistsWith ?any })\n\t}\n\tUNION\n\t{\n    \tFILTER (NOT EXISTS { $this $PATH ?any } && EXISTS { $this $coExistsWith ?any })\n\t}\n}\"\"\" ;\n    ] ;\n  sh:targetClass sh:PropertyShape ;\n.\ndash:CoExistsWithConstraintComponent-coExistsWith\n  rdf:type sh:Parameter ;\n  sh:path dash:coExistsWith ;\n  sh:class rdf:Property ;\n  sh:nodeKind sh:IRI ;\n.\ndash:DASHJSLibrary\n  rdf:type sh:JSLibrary ;\n  rdfs:label \"DASH JavaScript library\" ;\n  sh:jsLibrary dash:RDFQueryJSLibrary ;\n  sh:jsLibraryURL \"http://datashapes.org/js/dash.js\"^^xsd:anyURI ;\n.\ndash:DateOrDateTime\n  rdf:type rdf:List ;\n  rdf:first xsd:date ;\n  rdf:rest (\n      xsd:dateTime\n    ) ;\n  rdfs:comment \"An rdf:List that can be used in property constraints as value for sh:or to indicate that all values of a property must be either xsd:date or xsd:dateTime.\" ;\n  rdfs:label \"Date or date time\" ;\n.\ndash:DefaultValueTypeRule\n  rdf:type sh:SPARQLConstructExecutable ;\n  rdfs:comment \"\"\"\n\t\tA resource encapsulating a query that can be used to construct rdf:type triples for certain untyped nodes\n\t\tthat are an object in a triple where the predicate has a sh:defaultValueType.\n\t\tThis can be used as a pre-processor for shape graphs before they are validated.\n\t\t\"\"\"^^rdf:HTML ;\n  rdfs:label \"default value type inference rule\" ;\n  sh:construct \"\"\"\n\t\tCONSTRUCT {\n\t\t\t?node a ?defaultValueType .\n\t\t}\n\t\tWHERE {\n\t\t\t?predicate sh:defaultValueType ?defaultValueType .\n\t\t\t?anySubject ?predicate ?node .\n\t\t\tFILTER (NOT EXISTS { ?node a ?anyType }) .\n\t\t}\n\t\t\"\"\" ;\n.\ndash:FailureResult\n  rdf:type rdfs:Class ;\n  rdfs:comment \"A result representing a validation failure such as an unsupported recursion.\" ;\n  rdfs:label \"Failure result\" ;\n  rdfs:subClassOf sh:AbstractResult ;\n.\ndash:FailureTestCaseResult\n  rdf:type rdfs:Class ;\n  rdfs:comment \"Represents a failure of a test case.\" ;\n  rdfs:label \"Failure test case result\" ;\n  rdfs:subClassOf dash:TestCaseResult ;\n.\ndash:FunctionTestCase\n  rdf:type rdfs:Class ;\n  rdfs:comment \"A test case that verifies that a given SPARQL expression produces a given, expected result.\" ;\n  rdfs:label \"Function test case\" ;\n  rdfs:subClassOf dash:TestCase ;\n  sh:property [\n      sh:path dash:expectedResult ;\n      sh:description \"The expected result of a function call.\" ;\n      sh:maxCount 1 ;\n      sh:name \"expected result\" ;\n    ] ;\n  sh:property [\n      sh:path dash:expression ;\n      sh:description \"A valid SPARQL expression calling the function to test.\" ;\n      sh:maxCount 1 ;\n      sh:minCount 1 ;\n      sh:name \"expression\" ;\n    ] ;\n.\ndash:GraphUpdate\n  rdf:type rdfs:Class ;\n  rdfs:label \"Graph update\" ;\n  rdfs:subClassOf dash:Suggestion ;\n.\ndash:GraphValidationTestCase\n  rdf:type rdfs:Class ;\n  rdfs:comment \"A test case that performs SHACL constraint validation on the whole graph and compares the results with the expected validation results stored with the test case. By default this excludes meta-validation (i.e. the validation of the shape definitions themselves). If that's desired, set dash:validateShapes to true.\" ;\n  rdfs:label \"Graph validation test case\" ;\n  rdfs:subClassOf dash:ValidationTestCase ;\n.\ndash:HasValueWithClassConstraintComponent\n  rdf:type sh:ConstraintComponent ;\n  rdfs:comment \"A constraint component that can be used to express a constraint on property shapes so that one of the values of the property path must be an instance of a given class.\" ;\n  rdfs:label \"Has value with class constraint component\" ;\n  sh:message \"At least one of the values must have class {$hasValueWithClass}\" ;\n  sh:parameter dash:HasValueWithClassConstraintComponent-hasValueWithClass ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateHasValueWithClass\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"SELECT $this\nWHERE {\n\tFILTER NOT EXISTS {\n    \t$this $PATH ?value .\n\t\t?value a ?type .\n\t\t?type rdfs:subClassOf* ?hasValueWithClass .\n\t}\n}\"\"\" ;\n    ] ;\n  sh:targetClass sh:PropertyShape ;\n.\ndash:HasValueWithClassConstraintComponent-hasValueWithClass\n  rdf:type sh:Parameter ;\n  sh:path dash:hasValueWithClass ;\n  sh:class rdfs:Class ;\n  sh:nodeKind sh:IRI ;\n.\ndash:InferencingTestCase\n  rdf:type rdfs:Class ;\n  rdf:type sh:NodeShape ;\n  rdfs:comment \"A test case to verify whether an inferencing engine is producing identical results to those stored as expected results.\" ;\n  rdfs:label \"Inferencing test case\" ;\n  rdfs:subClassOf dash:TestCase ;\n  sh:property [\n      sh:path dash:expectedResult ;\n      sh:description \"The expected inferred triples, represented by instances of rdfs:Statement.\" ;\n      sh:name \"expected result\" ;\n    ] ;\n.\ndash:JSTestCase\n  rdf:type rdfs:Class ;\n  rdfs:comment \"A test case that calls a given JavaScript function like a sh:JSFunction and compares its result with the dash:expectedResult.\" ;\n  rdfs:label \"JavaScript test case\" ;\n  rdfs:subClassOf dash:TestCase ;\n  rdfs:subClassOf sh:JSFunction ;\n  sh:property [\n      sh:path dash:expectedResult ;\n      sh:description \"The expected result of the JavaScript function call, as an RDF node.\" ;\n      sh:maxCount 1 ;\n      sh:name \"expected result\" ;\n    ] ;\n.\ndash:ListNodeShape\n  rdf:type sh:NodeShape ;\n  rdfs:comment \"Defines constraints on what it means for a node to be a node within a well-formed RDF list. Note that this does not check whether the rdf:rest items are also well-formed lists as this would lead to unsupported recursion.\" ;\n  rdfs:label \"List node shape\" ;\n  sh:or (\n      [\n        sh:hasValue () ;\n        sh:property [\n            sh:path rdf:first ;\n            sh:maxCount 0 ;\n          ] ;\n        sh:property [\n            sh:path rdf:rest ;\n            sh:maxCount 0 ;\n          ] ;\n      ]\n      [\n        sh:not [\n            sh:hasValue () ;\n          ] ;\n        sh:property [\n            sh:path rdf:first ;\n            sh:maxCount 1 ;\n            sh:minCount 1 ;\n          ] ;\n        sh:property [\n            sh:path rdf:rest ;\n            sh:maxCount 1 ;\n            sh:minCount 1 ;\n          ] ;\n      ]\n    ) ;\n.\ndash:ListShape\n  rdf:type sh:NodeShape ;\n  rdfs:comment \"\"\"Defines constraints on what it means for a node to be a well-formed RDF list.\n\nThe focus node must either be rdf:nil or not recursive. Furthermore, this shape uses dash:ListNodeShape as a \\\"helper\\\" to walk through all members of the whole list (including itself).\"\"\" ;\n  rdfs:label \"List shape\" ;\n  sh:or (\n      [\n        sh:hasValue () ;\n      ]\n      [\n        sh:not [\n            sh:hasValue () ;\n          ] ;\n        sh:property [\n            sh:path [\n                sh:oneOrMorePath rdf:rest ;\n              ] ;\n            dash:nonRecursive \"true\"^^xsd:boolean ;\n          ] ;\n      ]\n    ) ;\n  sh:property [\n      sh:path [\n          sh:zeroOrMorePath rdf:rest ;\n        ] ;\n      rdfs:comment \"Each list member (including this node) must be have the shape dash:ListNodeShape.\" ;\n      sh:node dash:ListNodeShape ;\n    ] ;\n.\ndash:NonRecursiveConstraintComponent\n  rdf:type sh:ConstraintComponent ;\n  rdfs:comment \"\"\"Used to state that a property or path must not point back to itself.\n\nFor example, \\\"a person cannot have itself as parent\\\" can be expressed by setting dash:nonRecursive=true for a given sh:path.\n\nTo express that a person cannot have itself among any of its (recursive) parents, use a sh:path with the + operator such as ex:parent+.\"\"\" ;\n  rdfs:label \"Non-recursive constraint component\" ;\n  sh:message \"Points back at itself (recursively)\" ;\n  sh:parameter dash:NonRecursiveConstraintComponent-nonRecursive ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateNonRecursiveProperty\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"SELECT DISTINCT $this ($this AS ?value)\nWHERE {\n\t{\n\t\tFILTER (?nonRecursive)\n\t}\n    $this $PATH $this .\n}\"\"\" ;\n    ] ;\n  sh:targetClass sh:PropertyShape ;\n.\ndash:NonRecursiveConstraintComponent-nonRecursive\n  rdf:type sh:Parameter ;\n  sh:path dash:nonRecursive ;\n  sh:datatype xsd:boolean ;\n  sh:maxCount 1 ;\n  sh:name \"non-recursive\" ;\n.\ndash:None\n  rdf:type sh:NodeShape ;\n  rdfs:comment \"A Shape that is no node can conform to.\" ;\n  rdfs:label \"None\" ;\n  sh:in () ;\n.\ndash:ParameterConstraintComponent\n  rdf:type sh:ConstraintComponent ;\n  rdfs:comment \"A constraint component that can be used to verify that all value nodes conform to the given Parameter.\"@en ;\n  rdfs:label \"Parameter constraint component\"@en ;\n  sh:parameter dash:ParameterConstraintComponent-parameter ;\n.\ndash:ParameterConstraintComponent-parameter\n  rdf:type sh:Parameter ;\n  sh:path sh:parameter ;\n.\ndash:PrimaryKeyConstraintComponent\n  rdf:type sh:ConstraintComponent ;\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  rdfs:comment \"Enforces a constraint that the given property (sh:path) serves as primary key for all resources in the target of the shape. If a property has been declared to be the primary key then each resource must have exactly one value for that property. Furthermore, the URIs of those resources must start with a given string (dash:uriStart), followed by the URL-encoded primary key value. For example if dash:uriStart is \\\"http://example.org/country-\\\" and the primary key for an instance is \\\"de\\\" then the URI must be \\\"http://example.org/country-de\\\". Finally, as a result of the URI policy, there can not be any other resource with the same value under the same primary key policy.\" ;\n  rdfs:label \"Primary key constraint component\" ;\n  sh:labelTemplate \"The property {?predicate} is the primary key and URIs start with {?uriStart}\" ;\n  sh:message \"Violation of primary key constraint\" ;\n  sh:parameter dash:PrimaryKeyConstraintComponent-uriStart ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validatePrimaryKeyProperty\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"SELECT DISTINCT $this\nWHERE {\n        FILTER (\n\t\t\t# Must have a value for the primary key\n\t\t\tNOT EXISTS { ?this $PATH ?any }\n\t\t\t||\n\t\t\t# Must have no more than one value for the primary key\n\t\t\tEXISTS {\n\t\t\t\t?this $PATH ?value1 .\n\t\t\t\t?this $PATH ?value2 .\n\t\t\t\tFILTER (?value1 != ?value2) .\n\t\t\t}\n\t\t\t||\n\t\t\t# The value of the primary key must align with the derived URI\n\t\t\tEXISTS {\n\t\t\t\t{\n        \t\t\t?this $PATH ?value .\n\t\t\t\t\tFILTER NOT EXISTS { ?this $PATH ?value2 . FILTER (?value != ?value2) }\n\t\t\t\t}\n        \t\tBIND (CONCAT($uriStart, ENCODE_FOR_URI(str(?value))) AS ?uri) .\n        \t\tFILTER (str(?this) != ?uri) .\n    \t\t}\n\t\t)\n}\"\"\" ;\n    ] ;\n  sh:targetClass sh:PropertyShape ;\n.\ndash:PrimaryKeyConstraintComponent-uriStart\n  rdf:type sh:Parameter ;\n  sh:path dash:uriStart ;\n  sh:datatype xsd:string ;\n  sh:description \"The start of the URIs of well-formed resources.\" ;\n  sh:name \"URI start\" ;\n.\ndash:QueryTestCase\n  rdf:type rdfs:Class ;\n  rdf:type sh:NodeShape ;\n  rdfs:comment \"A test case running a given SPARQL SELECT query and comparing its results with those stored as JSON Result Set in the expected result property.\" ;\n  rdfs:label \"Query test case\" ;\n  rdfs:subClassOf dash:TestCase ;\n  rdfs:subClassOf sh:SPARQLSelectExecutable ;\n  sh:property [\n      sh:path dash:expectedResult ;\n      sh:datatype xsd:string ;\n      sh:description \"The expected result set, as a JSON string.\" ;\n      sh:maxCount 1 ;\n      sh:minCount 1 ;\n      sh:name \"expected result\" ;\n    ] ;\n  sh:property [\n      sh:path sh:select ;\n      sh:datatype xsd:string ;\n      sh:description \"The SPARQL SELECT query to execute.\" ;\n      sh:maxCount 1 ;\n      sh:minCount 1 ;\n      sh:name \"SPARQL query\" ;\n    ] ;\n.\ndash:RDFQueryJSLibrary\n  rdf:type sh:JSLibrary ;\n  rdfs:label \"rdfQuery JavaScript Library\" ;\n  sh:jsLibraryURL \"http://datashapes.org/js/rdfquery.js\"^^xsd:anyURI ;\n.\ndash:RootClassConstraintComponent\n  rdf:type sh:ConstraintComponent ;\n  rdfs:comment \"A constraint component defining the parameter dash:rootClass, which restricts the values to be either the root class itself or one of its subclasses. This is typically used in conjunction with properties that have rdfs:Class as their type.\" ;\n  rdfs:label \"Root class constraint component\" ;\n  sh:labelTemplate \"Root class {$rootClass}\" ;\n  sh:message \"Value must be subclass of {$rootClass}\" ;\n  sh:parameter dash:RootClassConstraintComponent-rootClass ;\n  sh:targetClass sh:PropertyShape ;\n  sh:validator dash:hasRootClass ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateRootClass\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\ndash:RootClassConstraintComponent-rootClass\n  rdf:type sh:Parameter ;\n  sh:path dash:rootClass ;\n  sh:class rdfs:Class ;\n  sh:description \"The root class.\" ;\n  sh:name \"root class\" ;\n  sh:nodeKind sh:IRI ;\n.\ndash:SPARQLUpdateSuggestionGenerator\n  rdf:type rdfs:Class ;\n  rdfs:comment \"\"\"A SuggestionGenerator based on a SPARQL UPDATE query (sh:update), producing an instance of dash:GraphUpdate. The INSERTs become dash:addedTriple and the DELETEs become dash:deletedTriple. The WHERE clause operates on the data graph with the pre-bound variables $subject, $predicate and $object, as well as the other pre-bound variables for the parameters of the constraint.\n\nIn many cases, there may be multiple possible suggestions to fix a problem. For example, with sh:maxLength there are many ways to slice a string. In those cases, the system will first iterate through the result variables from a SELECT query (sh:select) and apply these results as pre-bound variables into the UPDATE query.\"\"\" ;\n  rdfs:label \"SPARQL UPDATE suggestion generator\" ;\n  rdfs:subClassOf dash:SuggestionGenerator ;\n  rdfs:subClassOf sh:SPARQLSelectExecutable ;\n  rdfs:subClassOf sh:SPARQLUpdateExecutable ;\n.\ndash:StemConstraintComponent\n  rdf:type sh:ConstraintComponent ;\n  dash:staticConstraint \"true\"^^xsd:boolean ;\n  rdfs:comment \"A constraint component that can be used to verify that every value node is an IRI and the IRI starts with a given string value.\"@en ;\n  rdfs:label \"Stem constraint component\"@en ;\n  sh:message \"Value does not have stem {$stem}\" ;\n  sh:parameter dash:StemConstraintComponent-stem ;\n  sh:targetClass sh:Shape ;\n  sh:validator dash:hasStem ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateStem\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\ndash:StemConstraintComponent-stem\n  rdf:type sh:Parameter ;\n  sh:path dash:stem ;\n  sh:datatype xsd:string ;\n.\ndash:StringOrLangString\n  rdf:type rdf:List ;\n  rdf:first xsd:string ;\n  rdf:rest (\n      rdf:langString\n    ) ;\n  rdfs:comment \"An rdf:List that can be used in property constraints as value for sh:or to indicate that all values of a property must be either xsd:string or rdf:langString.\" ;\n  rdfs:label \"String or langString\" ;\n.\ndash:SubSetOfConstraintComponent\n  rdf:type sh:ConstraintComponent ;\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  rdfs:comment \"A constraint component that can be used to state that the set of value nodes must be a subset of the value of a given property.\" ;\n  rdfs:label \"Sub set of constraint component\" ;\n  sh:message \"Must be one of the values of {$subSetOf}\" ;\n  sh:parameter dash:SubSetOfConstraintComponent-subSetOf ;\n  sh:propertyValidator [\n      rdf:type sh:SPARQLAskValidator ;\n      sh:ask \"\"\"ASK {\n    $this $subSetOf $value .\n}\"\"\" ;\n      sh:prefixes <http://datashapes.org/dash> ;\n    ] ;\n  sh:targetClass sh:PropertyShape ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateSubSetOf\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\ndash:SubSetOfConstraintComponent-subSetOf\n  rdf:type sh:Parameter ;\n  sh:path dash:subSetOf ;\n  sh:class rdf:Property ;\n  sh:description \"A property (of the focus node) that must (at least) have all values from the set of value nodes.\" ;\n.\ndash:SuccessResult\n  rdf:type rdfs:Class ;\n  rdfs:comment \"A result representing a successfully validated constraint.\" ;\n  rdfs:label \"Success result\" ;\n  rdfs:subClassOf sh:AbstractResult ;\n.\ndash:SuccessTestCaseResult\n  rdf:type rdfs:Class ;\n  rdfs:comment \"Represents a successful run of a test case.\" ;\n  rdfs:label \"Success test case result\" ;\n  rdfs:subClassOf dash:TestCaseResult ;\n.\ndash:Suggestion\n  rdf:type rdfs:Class ;\n  rdfs:comment \"Base class of suggestions that modify a graph to \\\"fix\\\" the source of a validation result.\" ;\n  rdfs:label \"Suggestion\" ;\n  rdfs:subClassOf rdfs:Resource ;\n.\ndash:SuggestionGenerator\n  rdf:type rdfs:Class ;\n  rdfs:comment \"Base class of objects that can generate suggestions (added or deleted triples) for a validation result of a given constraint component.\" ;\n  rdfs:label \"Suggestion generator\" ;\n  rdfs:subClassOf rdfs:Resource ;\n.\ndash:TestCase\n  rdf:type rdfs:Class ;\n  dash:abstract \"true\"^^xsd:boolean ;\n  rdfs:comment \"A test case to verify that a (SHACL-based) feature works as expected.\" ;\n  rdfs:label \"Test case\" ;\n  rdfs:subClassOf rdfs:Resource ;\n.\ndash:TestCaseResult\n  rdf:type rdfs:Class ;\n  rdfs:comment \"Base class for results produced by running test cases.\" ;\n  rdfs:label \"Test case result\" ;\n  rdfs:subClassOf sh:AbstractResult ;\n  sh:property [\n      sh:path dash:testCase ;\n      sh:class dash:TestCase ;\n      sh:description \"The dash:TestCase that was executed.\" ;\n      sh:maxCount 1 ;\n      sh:minCount 1 ;\n      sh:name \"test case\" ;\n    ] ;\n  sh:property [\n      sh:path dash:testGraph ;\n      sh:class rdfs:Resource ;\n      sh:description \"The graph containing the test case.\" ;\n      sh:maxCount 1 ;\n      sh:minCount 1 ;\n      sh:name \"test graph\" ;\n      sh:nodeKind sh:IRI ;\n    ] ;\n.\ndash:TestEnvironment\n  rdf:type rdfs:Class ;\n  dash:abstract \"true\"^^xsd:boolean ;\n  rdfs:comment \"Abstract base class for test environments, holding information on how to set up a test case.\" ;\n  rdfs:label \"Test environment\" ;\n  rdfs:subClassOf rdfs:Resource ;\n.\ndash:ValidationTestCase\n  rdf:type rdfs:Class ;\n  rdf:type sh:NodeShape ;\n  dash:abstract \"true\"^^xsd:boolean ;\n  rdfs:comment \"Abstract superclass for test cases concerning SHACL constraint validation. Future versions may add new kinds of validatin test cases, e.g. to validate a single resource only.\" ;\n  rdfs:label \"Validation test case\" ;\n  rdfs:subClassOf dash:TestCase ;\n  sh:property [\n      sh:path dash:expectedResult ;\n      sh:class sh:ValidationReport ;\n      sh:description \"The expected validation report.\" ;\n      sh:name \"expected result\" ;\n    ] ;\n.\ndash:abstract\n  rdf:type rdf:Property ;\n  rdfs:comment \"Indicates that a class is \\\"abstract\\\" and cannot be used in asserted rdf:type triples. Only non-abstract subclasses of abstract classes should be instantiated directly.\" ;\n  rdfs:domain rdfs:Class ;\n  rdfs:label \"abstract\" ;\n  rdfs:range xsd:boolean ;\n.\ndash:addedTriple\n  rdf:type rdf:Property ;\n  rdfs:comment \"May link a dash:GraphUpdate with one or more triples (represented as instances of rdf:Statement) that should be added to fix the source of the result.\" ;\n  rdfs:domain dash:GraphUpdate ;\n  rdfs:label \"added triple\" ;\n  rdfs:range rdf:Statement ;\n.\ndash:cachable\n  rdf:type rdf:Property ;\n  rdfs:comment \"If set to true then the results of the SHACL function can be cached in between invocations with the same arguments. In other words, they are stateless and do not depend on triples in any graph, or the current time stamp etc.\" ;\n  rdfs:domain sh:Function ;\n  rdfs:label \"cachable\" ;\n  rdfs:range xsd:boolean ;\n.\ndash:closedByTypes\n  rdf:type rdf:Property ;\n  rdfs:label \"closed by types\" ;\n.\ndash:coExistsWith\n  rdf:type rdf:Property ;\n  rdfs:comment \"Specifies a property that must have a value whenever the property path has a value, and must have no value whenever the property path has no value.\" ;\n  rdfs:label \"co-exists with\" ;\n  rdfs:range rdf:Property ;\n.\ndash:composite\n  rdf:type rdf:Property ;\n  rdfs:comment \"Can be used to indicate that a property/path represented by a property constraint represents a composite relationship. In a composite relationship, the life cycle of a \\\"child\\\" object (value of the property/path) depends on the \\\"parent\\\" object (focus node). If the parent gets deleted, then the child objects should be deleted, too. Tools may use dash:composite (if set to true) to implement cascading delete operations.\" ;\n  rdfs:domain sh:PropertyShape ;\n  rdfs:label \"composite\" ;\n  rdfs:range xsd:boolean ;\n.\ndash:defaultValueType\n  rdf:type rdf:Property ;\n  rdfs:comment \"\"\"\n\t\tLinks a property with a default value type.\n\t\tThe default value type is assumed to be the <code>rdf:type</code> of values of the property\n\t\tthat declare no type on their own.\n\t\tAn example use of <code>sh:defaultValueType</code> is <code>sh:property</code>,\n\t\tthe values of which are assumed to be instances of <code>sh:PropertyShape</code>\n\t\teven if they are untyped (blank) nodes.\n\t\t\"\"\"^^rdf:HTML ;\n  rdfs:label \"default value type\" ;\n  rdfs:range rdfs:Class ;\n  owl:versionInfo \"Note this property may get removed in future versions. It is a left-over from a previous design in SHACL.\" ;\n.\ndash:deletedTriple\n  rdf:type rdf:Property ;\n  rdfs:comment \"May link a dash:GraphUpdate result with one or more triples (represented as instances of rdf:Statement) that should be deleted to fix the source of the result.\" ;\n  rdfs:domain dash:GraphUpdate ;\n  rdfs:label \"deleted triple\" ;\n  rdfs:range rdf:Statement ;\n.\ndash:expectedResult\n  rdf:type rdf:Property ;\n  rdfs:comment \"The expected result(s) of a test case. The value range of this property is different for each kind of test cases.\" ;\n  rdfs:domain dash:TestCase ;\n  rdfs:label \"expected result\" ;\n.\ndash:fixed\n  rdf:type rdf:Property ;\n  rdfs:comment \"Can be used to mark that certain validation results have already been fixed.\" ;\n  rdfs:domain sh:ValidationResult ;\n  rdfs:label \"fixed\" ;\n  rdfs:range xsd:boolean ;\n.\ndash:hasClass\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:label \"has class\" ;\n  sh:ask \"\"\"\n\t\tASK {\n\t\t\t$value rdf:type/rdfs:subClassOf* $class .\n\t\t}\n\t\t\"\"\" ;\n  sh:message \"Value does not have class {$class}\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:hasMaxExclusive\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:comment \"Checks whether a given node (?value) has value less than (<) the provided ?maxExclusive. Returns false if this cannot be determined, e.g. because values do not have comparable types.\" ;\n  rdfs:label \"has max exclusive\" ;\n  sh:ask \"ASK { FILTER ($value < $maxExclusive) }\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:hasMaxInclusive\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:comment \"Checks whether a given node (?value) has value less than or equal to (<=) the provided ?maxInclusive. Returns false if this cannot be determined, e.g. because values do not have comparable types.\" ;\n  rdfs:label \"has max inclusive\" ;\n  sh:ask \"ASK { FILTER ($value <= $maxInclusive) }\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:hasMaxLength\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:comment \"Checks whether a given string (?value) has a length within a given maximum string length.\" ;\n  rdfs:label \"has max length\" ;\n  sh:ask \"\"\"\n\t\tASK {\n\t\t\tFILTER (STRLEN(str($value)) <= $maxLength) .\n\t\t}\n\t\t\"\"\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:hasMinExclusive\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:comment \"Checks whether a given node (?value) has value greater than (>) the provided ?minExclusive. Returns false if this cannot be determined, e.g. because values do not have comparable types.\" ;\n  rdfs:label \"has min exclusive\" ;\n  sh:ask \"ASK { FILTER ($value > $minExclusive) }\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:hasMinInclusive\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:comment \"Checks whether a given node (?value) has value greater than or equal to (>=) the provided ?minInclusive. Returns false if this cannot be determined, e.g. because values do not have comparable types.\" ;\n  rdfs:label \"has min inclusive\" ;\n  sh:ask \"ASK { FILTER ($value >= $minInclusive) }\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:hasMinLength\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:comment \"Checks whether a given string (?value) has a length within a given minimum string length.\" ;\n  rdfs:label \"has min length\" ;\n  sh:ask \"\"\"\n\t\tASK {\n\t\t\tFILTER (STRLEN(str($value)) >= $minLength) .\n\t\t}\n\t\t\"\"\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:hasNodeKind\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:comment \"Checks whether a given node (?value) has a given sh:NodeKind (?nodeKind). For example, sh:hasNodeKind(42, sh:Literal) = true.\" ;\n  rdfs:label \"has node kind\" ;\n  sh:ask \"\"\"\n\t\tASK {\n\t\t\tFILTER ((isIRI($value) && $nodeKind IN ( sh:IRI, sh:BlankNodeOrIRI, sh:IRIOrLiteral ) ) ||\n\t\t\t\t(isLiteral($value) && $nodeKind IN ( sh:Literal, sh:BlankNodeOrLiteral, sh:IRIOrLiteral ) ) ||\n\t\t\t\t(isBlank($value)   && $nodeKind IN ( sh:BlankNode, sh:BlankNodeOrIRI, sh:BlankNodeOrLiteral ) )) .\n\t\t}\n\t\t\"\"\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:hasPattern\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:comment \"Checks whether the string representation of a given node (?value) matches a given regular expression (?pattern). Returns false if the value is a blank node.\" ;\n  rdfs:label \"has pattern\" ;\n  sh:ask \"ASK { FILTER (!isBlank($value) && IF(bound($flags), regex(str($value), $pattern, $flags), regex(str($value), $pattern))) }\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:hasRootClass\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:label \"has root class\" ;\n  sh:ask \"\"\"ASK {\n    $value rdfs:subClassOf* $rootClass .\n}\"\"\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:hasStem\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:comment \"Checks whether a given node is an IRI starting with a given stem.\" ;\n  rdfs:label \"has stem\" ;\n  sh:ask \"ASK { FILTER (isIRI($value) && STRSTARTS(str($value), $stem)) }\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:hasValueWithClass\n  rdf:type rdf:Property ;\n  rdfs:comment \"Specifies a constraint that at least one of the value nodes must be an instance of a given class.\" ;\n  rdfs:label \"has value with class\" ;\n  rdfs:range rdfs:Class ;\n.\ndash:height\n  rdf:type rdf:Property ;\n  rdfs:comment \"The height.\" ;\n  rdfs:label \"height\" ;\n  rdfs:range xsd:integer ;\n.\ndash:isDeactivated\n  rdf:type sh:SPARQLFunction ;\n  rdfs:comment \"Checks whether a given shape or constraint has been marked as \\\"deactivated\\\" using sh:deactivated.\" ;\n  rdfs:label \"is deactivated\" ;\n  sh:ask \"\"\"ASK {\n    ?constraintOrShape sh:deactivated true .\n}\"\"\" ;\n  sh:parameter [\n      sh:path dash:constraintOrShape ;\n      sh:description \"The sh:Constraint or sh:Shape to test.\" ;\n      sh:name \"constraint or shape\" ;\n    ] ;\n  sh:prefixes <http://datashapes.org/dash> ;\n  sh:returnType xsd:boolean ;\n.\ndash:isIn\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:label \"is in\" ;\n  sh:ask \"\"\"\n\t\tASK {\n\t\t\tGRAPH $shapesGraph {\n\t\t\t\t$in (rdf:rest*)/rdf:first $value .\n\t\t\t}\n\t\t}\n\t\t\"\"\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:isLanguageIn\n  rdf:type sh:SPARQLAskValidator ;\n  rdfs:label \"is language in\" ;\n  sh:ask \"\"\"\n\t\tASK {\n\t\t\tBIND (lang($value) AS ?valueLang) .\n\t\t\tFILTER EXISTS {\n\t\t\t\tGRAPH $shapesGraph {\n\t\t\t\t\t$languageIn (rdf:rest*)/rdf:first ?lang .\n\t\t\t\t    FILTER (langMatches(?valueLang, ?lang))\n\t\t\t\t} }\n\t\t}\n\t\t\"\"\" ;\n  sh:prefixes <http://datashapes.org/dash> ;\n.\ndash:isNodeKindBlankNode\n  rdf:type sh:SPARQLFunction ;\n  dash:cachable \"true\"^^xsd:boolean ;\n  rdfs:comment \"Checks if a given sh:NodeKind is one that includes BlankNodes.\" ;\n  rdfs:label \"is NodeKind BlankNode\" ;\n  sh:ask \"\"\"ASK {\n\tFILTER ($nodeKind IN ( sh:BlankNode, sh:BlankNodeOrIRI, sh:BlankNodeOrLiteral ))\n}\"\"\" ;\n  sh:parameter [\n      sh:path dash:nodeKind ;\n      sh:class sh:NodeKind ;\n      sh:description \"The sh:NodeKind to check.\" ;\n      sh:name \"node kind\" ;\n      sh:nodeKind sh:IRI ;\n    ] ;\n  sh:prefixes <http://datashapes.org/dash> ;\n  sh:returnType xsd:boolean ;\n.\ndash:isNodeKindIRI\n  rdf:type sh:SPARQLFunction ;\n  dash:cachable \"true\"^^xsd:boolean ;\n  rdfs:comment \"Checks if a given sh:NodeKind is one that includes IRIs.\" ;\n  rdfs:label \"is NodeKind IRI\" ;\n  sh:ask \"\"\"ASK {\n\tFILTER ($nodeKind IN ( sh:IRI, sh:BlankNodeOrIRI, sh:IRIOrLiteral ))\n}\"\"\" ;\n  sh:parameter [\n      sh:path dash:nodeKind ;\n      sh:class sh:NodeKind ;\n      sh:description \"The sh:NodeKind to check.\" ;\n      sh:name \"node kind\" ;\n      sh:nodeKind sh:IRI ;\n    ] ;\n  sh:prefixes <http://datashapes.org/dash> ;\n  sh:returnType xsd:boolean ;\n.\ndash:isNodeKindLiteral\n  rdf:type sh:SPARQLFunction ;\n  dash:cachable \"true\"^^xsd:boolean ;\n  rdfs:comment \"Checks if a given sh:NodeKind is one that includes Literals.\" ;\n  rdfs:label \"is NodeKind Literal\" ;\n  sh:ask \"\"\"ASK {\n\tFILTER ($nodeKind IN ( sh:Literal, sh:BlankNodeOrLiteral, sh:IRIOrLiteral ))\n}\"\"\" ;\n  sh:parameter [\n      sh:path dash:nodeKind ;\n      sh:class sh:NodeKind ;\n      sh:description \"The sh:NodeKind to check.\" ;\n      sh:name \"node kind\" ;\n      sh:nodeKind sh:IRI ;\n    ] ;\n  sh:prefixes <http://datashapes.org/dash> ;\n  sh:returnType xsd:boolean ;\n.\ndash:localConstraint\n  rdf:type rdf:Property ;\n  rdfs:comment \"\"\"Can be set to true for those constraint components where the validation does not require to visit any other triples than the shape definitions and the direct property values of the focus node mentioned in the property constraints. Examples of this include sh:minCount and sh:hasValue.\n\nConstraint components that are marked as such can be optimized by engines, e.g. they can be evaluated client-side at form submission time, without having to make a round-trip to a server, assuming the client has downloaded a complete snapshot of the resource.\n\nAny component marked with dash:staticConstraint is also a dash:localConstraint.\"\"\" ;\n  rdfs:domain sh:ConstraintComponent ;\n  rdfs:label \"local constraint\" ;\n  rdfs:range xsd:boolean ;\n.\ndash:propertySuggestionGenerator\n  rdf:type rdf:Property ;\n  rdfs:comment \"Links the constraint component with instances of dash:SuggestionGenerator that may be used to produce suggestions for a given validation result that was produced by a property constraint.\" ;\n  rdfs:domain sh:ConstraintComponent ;\n  rdfs:label \"property suggestion generator\" ;\n  rdfs:range dash:SuggestionGenerator ;\n.\ndash:rootClass\n  rdf:type rdf:Property ;\n  rdfs:label \"root class\" ;\n.\ndash:staticConstraint\n  rdf:type rdf:Property ;\n  rdfs:comment \"\"\"Can be set to true for those constraint components where the validation does not require to visit any other triples than the parameters. Examples of this include sh:datatype or sh:nodeKind, where no further triples need to be queried to determine the result.\n\nConstraint components that are marked as such can be optimized by engines, e.g. they can be evaluated client-side at form submission time, without having to make a round-trip to a server.\"\"\" ;\n  rdfs:domain sh:ConstraintComponent ;\n  rdfs:label \"static constraint\" ;\n  rdfs:range xsd:boolean ;\n.\ndash:stem\n  rdf:type rdf:Property ;\n  rdfs:comment \"Specifies a string value that the IRI of the value nodes must start with.\"@en ;\n  rdfs:label \"stem\"@en ;\n  rdfs:range xsd:string ;\n.\ndash:subSetOf\n  rdf:type rdf:Property ;\n  rdfs:label \"sub set of\" ;\n.\ndash:suggestion\n  rdf:type rdf:Property ;\n  rdfs:comment \"Can be used to link a validation result with one or more suggestions on how to fix the underlying issue.\" ;\n  rdfs:domain sh:ValidationResult ;\n  rdfs:label \"suggestion\" ;\n  rdfs:range dash:Suggestion ;\n.\ndash:suggestionGenerator\n  rdf:type rdf:Property ;\n  rdfs:comment \"Links a sh:SPARQLConstraint with instances of dash:SuggestionGenerator that may be used to produce suggestions for a given validation result that was produced by the constraint.\" ;\n  rdfs:domain sh:SPARQLConstraint ;\n  rdfs:label \"suggestion generator\" ;\n  rdfs:range dash:SuggestionGenerator ;\n.\ndash:suggestionGroup\n  rdf:type rdf:Property ;\n  rdfs:comment \"Can be used to link a suggestion with the group identifier to which it belongs. By default this is a link to the dash:SuggestionGenerator, but in principle this could be any value.\" ;\n  rdfs:domain dash:Suggestion ;\n  rdfs:label \"suggestion\" ;\n.\ndash:testEnvironment\n  rdf:type rdf:Property ;\n  rdfs:comment \"Can be used by TestCases to point at a resource with information on how to set up the execution environment prior to execution.\" ;\n  rdfs:domain dash:TestCase ;\n  rdfs:label \"test environment\" ;\n  rdfs:range dash:TestEnvironment ;\n.\ndash:testModifiesEnvironment\n  rdf:type rdf:Property ;\n  rdfs:comment \"Indicates whether this test modifies the specified dash:testEnvironment. If set to true then a test runner can make sure to wipe out the previous environment, while leaving it false (or undefined) means that the test runner can reuse the environment from the previous test case. As setting up and tearing down tests is sometimes slow, this flag can significantly accelerate test execution.\" ;\n  rdfs:domain dash:TestCase ;\n  rdfs:label \"test modifies environment\" ;\n  rdfs:range xsd:boolean ;\n.\ndash:toString\n  rdf:type sh:JSFunction ;\n  rdf:type sh:SPARQLFunction ;\n  dash:cachable \"true\"^^xsd:boolean ;\n  rdfs:comment \"Returns a literal with datatype xsd:string that has the input value as its string. If the input value is an (URI) resource then its URI will be used.\" ;\n  rdfs:label \"to string\" ;\n  sh:jsFunctionName \"dash_toString\" ;\n  sh:jsLibrary dash:DASHJSLibrary ;\n  sh:labelTemplate \"Convert {$arg} to xsd:string\" ;\n  sh:parameter [\n      sh:path dash:arg ;\n      sh:description \"The input value.\" ;\n      sh:name \"arg\" ;\n      sh:nodeKind sh:IRIOrLiteral ;\n    ] ;\n  sh:prefixes <http://datashapes.org/dash> ;\n  sh:returnType xsd:string ;\n  sh:select \"\"\"SELECT (xsd:string($arg) AS ?result)\nWHERE {\n}\"\"\" ;\n.\ndash:validateShapes\n  rdf:type rdf:Property ;\n  rdfs:comment \"True to also validate the shapes itself (i.e. parameter declarations).\" ;\n  rdfs:domain dash:GraphValidationTestCase ;\n  rdfs:label \"validate shapes\" ;\n  rdfs:range xsd:boolean ;\n.\ndash:valueCount\n  rdf:type sh:SPARQLFunction ;\n  rdfs:comment \"Computes the number of objects for a given subject/predicate combination.\" ;\n  rdfs:label \"value count\" ;\n  sh:parameter [\n      sh:path dash:predicate ;\n      sh:class rdfs:Resource ;\n      sh:description \"The predicate to get the number of objects of.\" ;\n      sh:name \"predicate\" ;\n      sh:order 1 ;\n    ] ;\n  sh:parameter [\n      sh:path dash:subject ;\n      sh:class rdfs:Resource ;\n      sh:description \"The subject to get the number of objects of.\" ;\n      sh:name \"subject\" ;\n      sh:order 0 ;\n    ] ;\n  sh:prefixes <http://datashapes.org/dash> ;\n  sh:returnType xsd:integer ;\n  sh:select \"\"\"\n\t\tSELECT (COUNT(?object) AS ?result)\n\t\tWHERE {\n    \t\t$subject $predicate ?object .\n\t\t}\n\"\"\" ;\n.\ndash:width\n  rdf:type rdf:Property ;\n  rdfs:comment \"The width.\" ;\n  rdfs:label \"width\" ;\n  rdfs:range xsd:integer ;\n.\ndash:x\n  rdf:type rdf:Property ;\n  rdfs:comment \"The x position.\" ;\n  rdfs:label \"x\" ;\n  rdfs:range xsd:integer ;\n.\ndash:y\n  rdf:type rdf:Property ;\n  rdfs:comment \"The y position.\" ;\n  rdfs:label \"y\" ;\n  rdfs:range xsd:integer ;\n.\nowl:Class\n  rdf:type rdfs:Class ;\n  rdfs:subClassOf rdfs:Class ;\n.\nsh:AndConstraintComponent\n  sh:targetClass sh:Shape ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateAnd\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:ClassConstraintComponent\n  sh:targetClass sh:Shape ;\n  sh:validator dash:hasClass ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateClass\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:ClosedConstraintComponent\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  sh:nodeValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:message \"Predicate {?path} is not allowed (closed shape)\" ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"\n\t\tSELECT $this (?predicate AS ?path) ?value\n\t\tWHERE {\n\t\t\t{\n\t\t\t\tFILTER ($closed) .\n\t\t\t}\n\t\t\t$this ?predicate ?value .\n\t\t\tFILTER (NOT EXISTS {\n\t\t\t\tGRAPH $shapesGraph {\n\t\t\t\t\t$currentShape sh:property/sh:path ?predicate .\n\t\t\t\t}\n\t\t\t} && (!bound($ignoredProperties) || NOT EXISTS {\n\t\t\t\tGRAPH $shapesGraph {\n\t\t\t\t\t$ignoredProperties rdf:rest*/rdf:first ?predicate .\n\t\t\t\t}\n\t\t\t}))\n\t\t}\n\"\"\" ;\n    ] ;\n  sh:targetClass sh:NodeShape ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateClosed\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n      sh:message \"Predicate is not allowed (closed shape)\" ;\n    ] ;\n.\nsh:DatatypeConstraintComponent\n  dash:staticConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Value does not have datatype {$datatype}\" ;\n  sh:targetClass sh:PropertyShape ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateDatatype\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:DerivedValuesConstraintComponent\n  sh:targetClass sh:PropertyShape ;\n.\nsh:DisjointConstraintComponent\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  sh:targetClass sh:Shape ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateDisjoint\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n      sh:message \"Value node must not also be one of the values of {$disjoint}\" ;\n    ] ;\n  sh:validator [\n      rdf:type sh:SPARQLAskValidator ;\n      sh:ask \"\"\"\n\t\tASK {\n\t\t\tFILTER NOT EXISTS {\n\t\t\t\t$this $disjoint $value .\n\t\t\t}\n\t\t}\n\t\t\"\"\" ;\n      sh:message \"Property must not share any values with {$disjoint}\" ;\n      sh:prefixes <http://datashapes.org/dash> ;\n    ] ;\n.\nsh:EqualsConstraintComponent\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Must have same values as {$equals}\" ;\n  sh:nodeValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"\n\t\tSELECT DISTINCT $this ?value\n\t\tWHERE {\n\t\t\t{\n\t\t\t\tFILTER NOT EXISTS { $this $equals $this }\n\t\t\t\tBIND ($this AS ?value) .\n\t\t\t}\n\t\t\tUNION\n\t\t\t{\n\t\t\t\t$this $equals ?value .\n\t\t\t\tFILTER (?value != $this) .\n\t\t\t}\n\t\t}\n\t\t\"\"\" ;\n    ] ;\n  sh:nodeValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateEqualsNode\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateEqualsProperty\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"\n\t\tSELECT DISTINCT $this ?value\n\t\tWHERE {\n\t\t\t{\n\t\t\t\t$this $PATH ?value .\n\t\t\t\tMINUS {\n\t\t\t\t\t$this $equals ?value .\n\t\t\t\t}\n\t\t\t}\n\t\t\tUNION\n\t\t\t{\n\t\t\t\t$this $equals ?value .\n\t\t\t\tMINUS {\n\t\t\t\t\t$this $PATH ?value .\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t\t\"\"\" ;\n    ] ;\n  sh:targetClass sh:Shape ;\n.\nsh:Function\n  sh:property [\n      sh:path dash:cachable ;\n      sh:datatype xsd:boolean ;\n      sh:description \"True to indicate that this function will always return the same values for the same combination of arguments, regardless of the query graphs. Engines can use this information to cache and reuse previous function calls.\" ;\n      sh:maxCount 1 ;\n      sh:name \"cachable\" ;\n    ] ;\n.\nsh:HasValueConstraintComponent\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  sh:nodeValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateHasValueNode\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n      sh:message \"Value must be {$hasValue}\" ;\n    ] ;\n  sh:nodeValidator [\n      rdf:type sh:SPARQLAskValidator ;\n      sh:ask \"\"\"ASK {\n    FILTER ($value = $hasValue)\n}\"\"\" ;\n      sh:message \"Value must be {$hasValue}\" ;\n      sh:prefixes <http://datashapes.org/dash> ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateHasValueProperty\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n      sh:message \"Missing expected value {$hasValue}\" ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:message \"Missing expected value {$hasValue}\" ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"\n\t\tSELECT $this\n\t\tWHERE {\n\t\t\tFILTER NOT EXISTS { $this $PATH $hasValue }\n\t\t}\n\t\t\"\"\" ;\n    ] ;\n  sh:targetClass sh:Shape ;\n.\nsh:InConstraintComponent\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Value is not in {$in}\" ;\n  sh:targetClass sh:Shape ;\n  sh:validator dash:isIn ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateIn\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:LanguageInConstraintComponent\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Language does not match any of {$languageIn}\" ;\n  sh:targetClass sh:Shape ;\n  sh:validator dash:isLanguageIn ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateLanguageIn\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:LessThanConstraintComponent\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Value is not < value of {$lessThan}\" ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateLessThanProperty\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"\n\t\tSELECT $this ?value\n\t\tWHERE {\n\t\t\t$this $PATH ?value .\n\t\t\t$this $lessThan ?otherValue .\n\t\t\tBIND (?value < ?otherValue AS ?result) .\n\t\t\tFILTER (!bound(?result) || !(?result)) .\n\t\t}\n\t\t\"\"\" ;\n    ] ;\n  sh:targetClass sh:PropertyShape ;\n.\nsh:LessThanOrEqualsConstraintComponent\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Value is not <= value of {$lessThanOrEquals}\" ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateLessThanOrEqualsProperty\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"\n\t\tSELECT DISTINCT $this ?value\n\t\tWHERE {\n\t\t\t$this $PATH ?value .\n\t\t\t$this $lessThanOrEquals ?otherValue .\n\t\t\tBIND (?value <= ?otherValue AS ?result) .\n\t\t\tFILTER (!bound(?result) || !(?result)) .\n\t\t}\n\"\"\" ;\n    ] ;\n  sh:targetClass sh:PropertyShape ;\n.\nsh:MaxCountConstraintComponent\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  sh:message \"More than {$maxCount} values\" ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateMaxCountProperty\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"\n\t\tSELECT $this\n\t\tWHERE {\n\t\t\t$this $PATH ?value .\n\t\t}\n\t\tGROUP BY $this\n\t\tHAVING (COUNT(DISTINCT ?value) > $maxCount)\n\t\t\"\"\" ;\n    ] ;\n  sh:targetClass sh:PropertyShape ;\n.\nsh:MaxExclusiveConstraintComponent\n  dash:staticConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Value is not < {$maxExclusive}\" ;\n  sh:targetClass sh:Shape ;\n  sh:validator dash:hasMaxExclusive ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateMaxExclusive\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:MaxInclusiveConstraintComponent\n  dash:staticConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Value is not <= {$maxInclusive}\" ;\n  sh:targetClass sh:Shape ;\n  sh:validator dash:hasMaxInclusive ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateMaxInclusive\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:MaxLengthConstraintComponent\n  dash:staticConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Value has more than {$maxLength} characters\" ;\n  sh:targetClass sh:Shape ;\n  sh:validator dash:hasMaxLength ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateMaxLength\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:MinCountConstraintComponent\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Less than {$minCount} values\" ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateMinCountProperty\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"\n\t\tSELECT $this\n\t\tWHERE {\n\t\t\tOPTIONAL {\n\t\t\t\t$this $PATH ?value .\n\t\t\t}\n\t\t}\n\t\tGROUP BY $this\n\t\tHAVING (COUNT(DISTINCT ?value) < $minCount)\n\t\t\"\"\" ;\n    ] ;\n  sh:targetClass sh:PropertyShape ;\n.\nsh:MinExclusiveConstraintComponent\n  dash:staticConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Value is not > {$minExclusive}\" ;\n  sh:targetClass sh:Shape ;\n  sh:validator dash:hasMinExclusive ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateMinExclusive\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:MinInclusiveConstraintComponent\n  dash:staticConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Value is not >= {$minInclusive}\" ;\n  sh:targetClass sh:Shape ;\n  sh:validator dash:hasMinInclusive ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateMinInclusive\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:MinLengthConstraintComponent\n  dash:staticConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Value has less than {$minLength} characters\" ;\n  sh:targetClass sh:Shape ;\n  sh:validator dash:hasMinLength ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateMinLength\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:NodeConstraintComponent\n  sh:message \"Value does not have shape {$node}\" ;\n  sh:targetClass sh:Shape ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateNode\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:NodeKindConstraintComponent\n  dash:staticConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Value does not have node kind {$nodeKind}\" ;\n  sh:targetClass sh:Shape ;\n  sh:validator dash:hasNodeKind ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateNodeKind\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:NotConstraintComponent\n  sh:message \"Value does have shape {$not}\" ;\n  sh:targetClass sh:Shape ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateNot\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:OrConstraintComponent\n  sh:targetClass sh:Shape ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateOr\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:PatternConstraintComponent\n  dash:staticConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Value does not match pattern \\\"{$pattern}\\\"\" ;\n  sh:targetClass sh:Shape ;\n  sh:validator dash:hasPattern ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validatePattern\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:QualifiedMaxCountConstraintComponent\n  sh:message \"More than {$qualifiedMaxCount} values have shape {$qualifiedValueShape}\" ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateQualifiedMaxCountProperty\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:targetClass sh:PropertyShape ;\n.\nsh:QualifiedMinCountConstraintComponent\n  sh:message \"Less than {$qualifiedMinCount} values have shape {$qualifiedValueShape}\" ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateQualifiedMinCountProperty\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:targetClass sh:PropertyShape ;\n.\nsh:UniqueLangConstraintComponent\n  dash:localConstraint \"true\"^^xsd:boolean ;\n  sh:message \"Language \\\"{?lang}\\\" used more than once\" ;\n  sh:propertyValidator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateUniqueLangProperty\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n  sh:propertyValidator [\n      rdf:type sh:SPARQLSelectValidator ;\n      sh:prefixes <http://datashapes.org/dash> ;\n      sh:select \"\"\"\n\t\tSELECT DISTINCT $this ?lang\n\t\tWHERE {\n\t\t\t{\n\t\t\t\tFILTER sameTerm($uniqueLang, true) .\n\t\t\t}\n\t\t\t$this $PATH ?value .\n\t\t\tBIND (lang(?value) AS ?lang) .\n\t\t\tFILTER (bound(?lang) && ?lang != \\\"\\\") .\n\t\t\tFILTER EXISTS {\n\t\t\t\t$this $PATH ?otherValue .\n\t\t\t\tFILTER (?otherValue != ?value && ?lang = lang(?otherValue)) .\n\t\t\t}\n\t\t}\n\t\t\"\"\" ;\n    ] ;\n  sh:targetClass sh:PropertyShape ;\n.\nsh:XoneConstraintComponent\n  sh:targetClass sh:Shape ;\n  sh:validator [\n      rdf:type sh:JSValidator ;\n      sh:jsFunctionName \"validateXone\" ;\n      sh:jsLibrary dash:DASHJSLibrary ;\n    ] ;\n.\nsh:node\n  dash:defaultValueType sh:NodeShape ;\n.\nsh:not\n  dash:defaultValueType sh:Shape ;\n.\nsh:order\n  rdfs:range xsd:decimal ;\n.\nsh:parameter\n  dash:defaultValueType sh:Parameter ;\n.\nsh:property\n  dash:defaultValueType sh:PropertyShape ;\n.\nsh:qualifiedValueShape\n  dash:defaultValueType sh:Shape ;\n.\nsh:sparql\n  dash:defaultValueType sh:SPARQLConstraint ;\n.\n","shacl":"##  W3C SOFTWARE AND DOCUMENT NOTICE AND LICENSE\n## https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document\n## --------\n\n# W3C Shapes Constraint Language (SHACL) Vocabulary\n# Version from 2017-07-20\n\n@prefix owl:  <http://www.w3.org/2002/07/owl#> .\n@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .\n\n@prefix sh:   <http://www.w3.org/ns/shacl#> .\n\nsh:\n\ta owl:Ontology ;\n\trdfs:label \"W3C Shapes Constraint Language (SHACL) Vocabulary\"@en ;\n\trdfs:comment \"This vocabulary defines terms used in SHACL, the W3C Shapes Constraint Language.\"@en ;\n\tsh:declare [\n\t\tsh:prefix \"sh\" ;\n\t\tsh:namespace \"http://www.w3.org/ns/shacl#\" ;\n\t] ;\n\tsh:suggestedShapesGraph <http://www.w3.org/ns/shacl-shacl#> .\n\n\n# Shapes vocabulary -----------------------------------------------------------\n\nsh:Shape\n\ta rdfs:Class ;\n\trdfs:label \"Shape\"@en ;\n\trdfs:comment \"A shape is a collection of constraints that may be targeted for certain nodes.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:NodeShape\n\ta rdfs:Class ;\n\trdfs:label \"Node shape\"@en ;\n\trdfs:comment \"A node shape is a shape that specifies constraint that need to be met with respect to focus nodes.\"@en ;\n\trdfs:subClassOf sh:Shape ;\n\trdfs:isDefinedBy sh: .\n\nsh:PropertyShape\n\ta rdfs:Class ;\n\trdfs:label \"Property shape\"@en ;\n\trdfs:comment \"A property shape is a shape that specifies constraints on the values of a focus node for a given property or path.\"@en ;\n\trdfs:subClassOf sh:Shape ;\n\trdfs:isDefinedBy sh: .\n\nsh:deactivated\n\ta rdf:Property ;\n\trdfs:label \"deactivated\"@en ;\n\trdfs:comment \"If set to true then all nodes conform to this.\"@en ;\n\t# rdfs:domain sh:Shape or sh:SPARQLConstraint\n\trdfs:range xsd:boolean ;\n\trdfs:isDefinedBy sh: .\n\nsh:targetClass \n\ta rdf:Property ;\n\trdfs:label \"target class\"@en ;\n\trdfs:comment \"Links a shape to a class, indicating that all instances of the class must conform to the shape.\"@en ;\n\trdfs:domain sh:Shape ;\n\trdfs:range rdfs:Class ;\n\trdfs:isDefinedBy sh: .\n\nsh:targetNode \n\ta rdf:Property ;\n\trdfs:label \"target node\"@en ;\n\trdfs:comment \"Links a shape to individual nodes, indicating that these nodes must conform to the shape.\"@en ;\n\trdfs:domain sh:Shape ;\n\trdfs:isDefinedBy sh: .\n\nsh:targetObjectsOf\n\ta rdf:Property ;\n\trdfs:label \"target objects of\"@en ;\n\trdfs:comment \"Links a shape to a property, indicating that all all objects of triples that have the given property as their predicate must conform to the shape.\"@en ;\n\trdfs:domain sh:Shape ;\n\trdfs:range rdf:Property ;\n\trdfs:isDefinedBy sh: .\n\nsh:targetSubjectsOf\n\ta rdf:Property ;\n\trdfs:label \"target subjects of\"@en ;\n\trdfs:comment \"Links a shape to a property, indicating that all subjects of triples that have the given property as their predicate must conform to the shape.\"@en ;\n\trdfs:domain sh:Shape ;\n\trdfs:range rdf:Property ;\n\trdfs:isDefinedBy sh: .\n\nsh:message\n\ta rdf:Property ;\n\t# domain: sh:Shape or sh:SPARQLConstraint or sh:SPARQLSelectValidator or sh:SPARQLAskValidator\n\t# range: xsd:string or rdf:langString\n\trdfs:label \"message\"@en ;\n\trdfs:comment \"A human-readable message (possibly with placeholders for variables) explaining the cause of the result.\"@en ;\n\trdfs:isDefinedBy sh: .\n\nsh:severity\n\ta rdf:Property ;\n\trdfs:label \"severity\"@en ;\n\trdfs:comment \"Defines the severity that validation results produced by a shape must have. Defaults to sh:Violation.\"@en ;\n\trdfs:domain sh:Shape ;\n\trdfs:range sh:Severity ;\n\trdfs:isDefinedBy sh: .\n\n\n# Node kind vocabulary --------------------------------------------------------\n\nsh:NodeKind\n\ta rdfs:Class ;\n\trdfs:label \"Node kind\"@en ;\n\trdfs:comment \"The class of all node kinds, including sh:BlankNode, sh:IRI, sh:Literal or the combinations of these: sh:BlankNodeOrIRI, sh:BlankNodeOrLiteral, sh:IRIOrLiteral.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:BlankNode\n\ta sh:NodeKind ;\n\trdfs:label \"Blank node\"@en ;\n\trdfs:comment \"The node kind of all blank nodes.\"@en ;\n\trdfs:isDefinedBy sh: .\n\nsh:BlankNodeOrIRI\n\ta sh:NodeKind ;\n\trdfs:label \"Blank node or IRI\"@en ;\n\trdfs:comment \"The node kind of all blank nodes or IRIs.\"@en ;\n\trdfs:isDefinedBy sh: .\n\nsh:BlankNodeOrLiteral\n\ta sh:NodeKind ;\n\trdfs:label \"Blank node or literal\"@en ;\n\trdfs:comment \"The node kind of all blank nodes or literals.\"@en ;\n\trdfs:isDefinedBy sh: .\n\nsh:IRI\n\ta sh:NodeKind ;\n\trdfs:label \"IRI\"@en ;\n\trdfs:comment \"The node kind of all IRIs.\"@en ;\n\trdfs:isDefinedBy sh: .\n\nsh:IRIOrLiteral\n\ta sh:NodeKind ;\n\trdfs:label \"IRI or literal\"@en ;\n\trdfs:comment \"The node kind of all IRIs or literals.\"@en ;\n\trdfs:isDefinedBy sh: .\n\nsh:Literal\n\ta sh:NodeKind ;\n\trdfs:label \"Literal\"@en ;\n\trdfs:comment \"The node kind of all literals.\"@en ;\n\trdfs:isDefinedBy sh: .\n\n\n# Results vocabulary ----------------------------------------------------------\n\nsh:ValidationReport\n\ta rdfs:Class ;\n\trdfs:label \"Validation report\"@en ;\n\trdfs:comment \"The class of SHACL validation reports.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:conforms\n\ta rdf:Property ;\n\trdfs:label \"conforms\"@en ;\n\trdfs:comment \"True if the validation did not produce any validation results, and false otherwise.\"@en ;\n\trdfs:domain sh:ValidationReport ;\n\trdfs:range xsd:boolean ;\n\trdfs:isDefinedBy sh: .\n\nsh:result\n\ta rdf:Property ;\n\trdfs:label \"result\"@en ;\n\trdfs:comment \"The validation results contained in a validation report.\"@en ;\n\trdfs:domain sh:ValidationReport ;\n\trdfs:range sh:ValidationResult ;\n\trdfs:isDefinedBy sh: .\n\nsh:shapesGraphWellFormed\n\ta rdf:Property ;\n\trdfs:label \"shapes graph well-formed\"@en ;\n\trdfs:comment \"If true then the validation engine was certain that the shapes graph has passed all SHACL syntax requirements during the validation process.\"@en ;\n\trdfs:domain sh:ValidationReport ;\n\trdfs:range xsd:boolean ;\n\trdfs:isDefinedBy sh: .\n\nsh:AbstractResult\n\ta rdfs:Class ;\n\trdfs:label \"Abstract result\"@en ;\n\trdfs:comment \"The base class of validation results, typically not instantiated directly.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:ValidationResult\n\ta rdfs:Class ;\n\trdfs:label \"Validation result\"@en ;\n\trdfs:comment \"The class of validation results.\"@en ;\n\trdfs:subClassOf sh:AbstractResult ;\n\trdfs:isDefinedBy sh: .\n\nsh:Severity\n\ta rdfs:Class ;\n\trdfs:label \"Severity\"@en ;\n\trdfs:comment \"The class of validation result severity levels, including violation and warning levels.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:Info\n\ta sh:Severity ;\n\trdfs:label \"Info\"@en ;\n\trdfs:comment \"The severity for an informational validation result.\"@en ;\n\trdfs:isDefinedBy sh: .\n\nsh:Violation\n\ta sh:Severity ;\n\trdfs:label \"Violation\"@en ;\n\trdfs:comment \"The severity for a violation validation result.\"@en ;\n\trdfs:isDefinedBy sh: .\n\nsh:Warning\n\ta sh:Severity ;\n\trdfs:label \"Warning\"@en ;\n\trdfs:comment \"The severity for a warning validation result.\"@en ;\n\trdfs:isDefinedBy sh: .\n\nsh:detail\n\ta rdf:Property ;\n\trdfs:label \"detail\"@en ;\n\trdfs:comment \"Links a result with other results that provide more details, for example to describe violations against nested shapes.\"@en ;\n\trdfs:domain sh:AbstractResult ;\n\trdfs:range sh:AbstractResult ;\n\trdfs:isDefinedBy sh: .\n\nsh:focusNode\n\ta rdf:Property ;\n\trdfs:label \"focus node\"@en ;\n\trdfs:comment \"The focus node that was validated when the result was produced.\"@en ;\n\trdfs:domain sh:AbstractResult ;\n\trdfs:isDefinedBy sh: .\n\nsh:resultMessage\n\ta rdf:Property ;\n\trdfs:label \"result message\"@en ;\n\trdfs:comment \"Human-readable messages explaining the cause of the result.\"@en ;\n\trdfs:domain sh:AbstractResult ;\n\t# range: xsd:string or rdf:langString\n\trdfs:isDefinedBy sh: .\n\nsh:resultPath\n\ta rdf:Property ;\n\trdfs:label \"result path\"@en ;\n\trdfs:comment \"The path of a validation result, based on the path of the validated property shape.\"@en ;\n\trdfs:domain sh:AbstractResult ;\n\trdfs:range rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:resultSeverity\n\ta rdf:Property ;\n\trdfs:label \"result severity\"@en ;\n\trdfs:comment \"The severity of the result, e.g. warning.\"@en ;\n\trdfs:domain sh:AbstractResult ;\n\trdfs:range sh:Severity ;\n\trdfs:isDefinedBy sh: .\n\nsh:sourceConstraint\n\ta rdf:Property ;\n\trdfs:label \"source constraint\"@en ;\n\trdfs:comment \"The constraint that was validated when the result was produced.\"@en ;\n\trdfs:domain sh:AbstractResult ;\n\trdfs:isDefinedBy sh: .\n\nsh:sourceShape\n\ta rdf:Property ;\n\trdfs:label \"source shape\"@en ;\n\trdfs:comment \"The shape that is was validated when the result was produced.\"@en ;\n\trdfs:domain sh:AbstractResult ;\n\trdfs:range sh:Shape ;\n\trdfs:isDefinedBy sh: .\n\nsh:sourceConstraintComponent\n\ta rdf:Property ;\n\trdfs:label \"source constraint component\"@en ;\n\trdfs:comment \"The constraint component that is the source of the result.\"@en ;\n\trdfs:domain sh:AbstractResult ;\n\trdfs:range sh:ConstraintComponent ;\n\trdfs:isDefinedBy sh: .\n\nsh:value\n\ta rdf:Property ;\n\trdfs:label \"value\"@en ;\n\trdfs:comment \"An RDF node that has caused the result.\"@en ;\n\trdfs:domain sh:AbstractResult ;\n\trdfs:isDefinedBy sh: .\n\n\t\n# Graph properties ------------------------------------------------------------\n\nsh:shapesGraph\n\ta rdf:Property ;\n\trdfs:label \"shapes graph\"@en ;\n\trdfs:comment \"Shapes graphs that should be used when validating this data graph.\"@en ;\n\trdfs:domain owl:Ontology ;\n\trdfs:range owl:Ontology ;\n\trdfs:isDefinedBy sh: .\n\nsh:suggestedShapesGraph\n\ta rdf:Property ;\n\trdfs:label \"suggested shapes graph\"@en ;\n\trdfs:comment \"Suggested shapes graphs for this ontology. The values of this property may be used in the absence of specific sh:shapesGraph statements.\"@en ;\n\trdfs:domain owl:Ontology ;\n\trdfs:range owl:Ontology ;\n\trdfs:isDefinedBy sh: .\n\nsh:entailment\n\ta rdf:Property ;\n\trdfs:label \"entailment\"@en ;\n\trdfs:comment \"An entailment regime that indicates what kind of inferencing is required by a shapes graph.\"@en ;\n\trdfs:domain owl:Ontology ;\n\trdfs:range rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\n\n# Path vocabulary -------------------------------------------------------------\n\nsh:path\n\ta rdf:Property ;\n\trdfs:label \"path\"@en ;\n\trdfs:comment \"Specifies the property path of a property shape.\"@en ;\n\trdfs:domain sh:PropertyShape ;\n\trdfs:range rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:inversePath\n\ta rdf:Property ;\n\trdfs:label \"inverse path\"@en ;\n\trdfs:comment \"The (single) value of this property represents an inverse path (object to subject).\"@en ;\n\trdfs:range rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:alternativePath\n\ta rdf:Property ;\n\trdfs:label \"alternative path\"@en ;\n\trdfs:comment \"The (single) value of this property must be a list of path elements, representing the elements of alternative paths.\"@en ;\n\trdfs:range rdf:List ;\n\trdfs:isDefinedBy sh: .\n\nsh:zeroOrMorePath\n\ta rdf:Property ;\n\trdfs:label \"zero or more path\"@en ;\n\trdfs:comment \"The (single) value of this property represents a path that is matched zero or more times.\"@en ;\n\trdfs:range rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:oneOrMorePath\n\ta rdf:Property ;\n\trdfs:label \"one or more path\"@en ;\n\trdfs:comment \"The (single) value of this property represents a path that is matched one or more times.\"@en ;\n\trdfs:range rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:zeroOrOnePath\n\ta rdf:Property ;\n\trdfs:label \"zero or one path\"@en ;\n\trdfs:comment \"The (single) value of this property represents a path that is matched zero or one times.\"@en ;\n\trdfs:range rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\n\n# Parameters metamodel --------------------------------------------------------\n\nsh:Parameterizable\n\ta rdfs:Class ;\n\trdfs:label \"Parameterizable\"@en ;\n\trdfs:comment \"Superclass of components that can take parameters, especially functions and constraint components.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:parameter\n\ta rdf:Property ;\n\trdfs:label \"parameter\"@en ;\n\trdfs:comment \"The parameters of a function or constraint component.\"@en ;\n\trdfs:domain sh:Parameterizable ;\n\trdfs:range sh:Parameter ;\n\trdfs:isDefinedBy sh: .\n\nsh:labelTemplate\n\ta rdf:Property ;\n\trdfs:label \"label template\"@en ;\n\trdfs:comment \"Outlines how human-readable labels of instances of the associated Parameterizable shall be produced. The values can contain {?paramName} as placeholders for the actual values of the given parameter.\"@en ;\n\trdfs:domain sh:Parameterizable ;\n\t# range: xsd:string or rdf:langString\n\trdfs:isDefinedBy sh: .\n\nsh:Parameter\n\ta rdfs:Class ;\n\trdfs:label \"Parameter\"@en ;\n\trdfs:comment \"The class of parameter declarations, consisting of a path predicate and (possibly) information about allowed value type, cardinality and other characteristics.\"@en ;\n\trdfs:subClassOf sh:PropertyShape ;\n\trdfs:isDefinedBy sh: .\n\nsh:optional\n\ta rdf:Property ;\n\trdfs:label \"optional\"@en ;\n\trdfs:comment \"Indicates whether a parameter is optional.\"@en ;\n\trdfs:domain sh:Parameter ;\n\trdfs:range xsd:boolean ;\n\trdfs:isDefinedBy sh: .\n\n\n# Constraint components metamodel ---------------------------------------------\n\nsh:ConstraintComponent\n\ta rdfs:Class ;\n\trdfs:label \"Constraint component\"@en ;\n\trdfs:comment \"The class of constraint components.\"@en ;\n\trdfs:subClassOf sh:Parameterizable ;\n\trdfs:isDefinedBy sh: .\n\nsh:validator\n\ta rdf:Property ;\n\trdfs:label \"validator\"@en ;\n\trdfs:comment \"The validator(s) used to evaluate constraints of either node or property shapes.\"@en ;\n\trdfs:domain sh:ConstraintComponent ;\n\trdfs:range sh:Validator ;\n\trdfs:isDefinedBy sh: .\n\nsh:nodeValidator\n\ta rdf:Property ;\n\trdfs:label \"shape validator\"@en ;\n\trdfs:comment \"The validator(s) used to evaluate a constraint in the context of a node shape.\"@en ;\n\trdfs:domain sh:ConstraintComponent ;\n\trdfs:range sh:Validator ;\n\trdfs:isDefinedBy sh: .\n\nsh:propertyValidator\n\ta rdf:Property ;\n\trdfs:label \"property validator\"@en ;\n\trdfs:comment \"The validator(s) used to evaluate a constraint in the context of a property shape.\"@en ;\n\trdfs:domain sh:ConstraintComponent ;\n\trdfs:range sh:Validator ;\n\trdfs:isDefinedBy sh: .\n\nsh:Validator\n\ta rdfs:Class ;\n\trdfs:label \"Validator\"@en ;\n\trdfs:comment \"The class of validators, which provide instructions on how to process a constraint definition. This class serves as base class for the SPARQL-based validators and other possible implementations.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:SPARQLAskValidator\n\ta rdfs:Class ;\n\trdfs:label \"SPARQL ASK validator\"@en ;\n\trdfs:comment \"The class of validators based on SPARQL ASK queries. The queries are evaluated for each value node and are supposed to return true if the given node conforms.\"@en ;\n\trdfs:subClassOf sh:Validator ;\n\trdfs:subClassOf sh:SPARQLAskExecutable ;\n\trdfs:isDefinedBy sh: .\n\nsh:SPARQLSelectValidator\n\ta rdfs:Class ;\n\trdfs:label \"SPARQL SELECT validator\"@en ;\n\trdfs:comment \"The class of validators based on SPARQL SELECT queries. The queries are evaluated for each focus node and are supposed to produce bindings for all focus nodes that do not conform.\"@en ;\n\trdfs:subClassOf sh:Validator ;\n\trdfs:subClassOf sh:SPARQLSelectExecutable ;\n\trdfs:isDefinedBy sh: .\n\n\n# Library of Core Constraint Components and their properties ------------------\n\nsh:AndConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"And constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to test whether a value node conforms to all members of a provided list of shapes.\"@en ;\n\tsh:parameter sh:AndConstraintComponent-and ;\n\trdfs:isDefinedBy sh: .\n\nsh:AndConstraintComponent-and\n\ta sh:Parameter ;\n\tsh:path sh:and ;\n\trdfs:isDefinedBy sh: .\n\nsh:and\n\ta rdf:Property ;\n\trdfs:label \"and\"@en ;\n\trdfs:comment \"RDF list of shapes to validate the value nodes against.\"@en ;\n\trdfs:range rdf:List ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:ClassConstraintComponent \n\ta sh:ConstraintComponent ;\n\trdfs:label \"Class constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that each value node is an instance of a given type.\"@en ;\n\tsh:parameter sh:ClassConstraintComponent-class ;\n\trdfs:isDefinedBy sh: .\n\nsh:ClassConstraintComponent-class\n\ta sh:Parameter ;\n\tsh:path sh:class ;\n\tsh:nodeKind sh:IRI ;\n\trdfs:isDefinedBy sh: .\n\nsh:class\n\ta rdf:Property ;\n\trdfs:label \"class\"@en ;\n\trdfs:comment \"The type that all value nodes must have.\"@en ;\n\trdfs:range rdfs:Class ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:ClosedConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Closed constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to indicate that focus nodes must only have values for those properties that have been explicitly enumerated via sh:property/sh:path.\"@en ;\n\tsh:parameter sh:ClosedConstraintComponent-closed ;\n\tsh:parameter sh:ClosedConstraintComponent-ignoredProperties ;\n\trdfs:isDefinedBy sh: .\n\nsh:ClosedConstraintComponent-closed\n\ta sh:Parameter ; \n\tsh:path sh:closed ;\n\tsh:datatype xsd:boolean ;\n\trdfs:isDefinedBy sh: .\n\nsh:ClosedConstraintComponent-ignoredProperties\n\ta sh:Parameter ;\n\tsh:path sh:ignoredProperties ;\n\tsh:optional true ;\n\trdfs:isDefinedBy sh: .\n\nsh:closed\n\ta rdf:Property ;\n\trdfs:label \"closed\"@en ;\n\trdfs:comment \"If set to true then the shape is closed.\"@en ;\n\trdfs:range xsd:boolean ;\n\trdfs:isDefinedBy sh: .\n\nsh:ignoredProperties\n\ta rdf:Property ;\n\trdfs:label \"ignored properties\"@en ;\n\trdfs:comment \"An optional RDF list of properties that are also permitted in addition to those explicitly enumerated via sh:property/sh:path.\"@en ;\n\trdfs:range rdf:List ;    # members: rdf:Property\n\trdfs:isDefinedBy sh: .\n\n\nsh:DatatypeConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Datatype constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to restrict the datatype of all value nodes.\"@en ;\n\tsh:parameter sh:DatatypeConstraintComponent-datatype ;\n\trdfs:isDefinedBy sh: .\n\nsh:DatatypeConstraintComponent-datatype\n\ta sh:Parameter ;\n\tsh:path sh:datatype ;\n\tsh:nodeKind sh:IRI ;\n\tsh:maxCount 1 ;\n\trdfs:isDefinedBy sh: .\n\nsh:datatype\n\ta rdf:Property ;\n\trdfs:label \"datatype\"@en ;\n\trdfs:comment \"Specifies an RDF datatype that all value nodes must have.\"@en ;\n\trdfs:range rdfs:Datatype ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:DisjointConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Disjoint constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that the set of value nodes is disjoint with the the set of nodes that have the focus node as subject and the value of a given property as predicate.\"@en ;\n\tsh:parameter sh:DisjointConstraintComponent-disjoint ;\n\trdfs:isDefinedBy sh: .\n\nsh:DisjointConstraintComponent-disjoint\n\ta sh:Parameter ;\n\tsh:path sh:disjoint ;\n\tsh:nodeKind sh:IRI ;\n\trdfs:isDefinedBy sh: .\n\nsh:disjoint\n\ta rdf:Property ;\n\trdfs:label \"disjoint\"@en ;\n\trdfs:comment \"Specifies a property where the set of values must be disjoint with the value nodes.\"@en ;\n\trdfs:range rdf:Property ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:EqualsConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Equals constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that the set of value nodes is equal to the set of nodes that have the focus node as subject and the value of a given property as predicate.\"@en ;\n\tsh:parameter sh:EqualsConstraintComponent-equals ;\n\trdfs:isDefinedBy sh: .\n\nsh:EqualsConstraintComponent-equals\n\ta sh:Parameter ;\n\tsh:path sh:equals ;\n\tsh:nodeKind sh:IRI ;\n\trdfs:isDefinedBy sh: .\n\nsh:equals\n\ta rdf:Property ;\n\trdfs:label \"equals\"@en ;\n\trdfs:comment \"Specifies a property that must have the same values as the value nodes.\"@en ;\n\trdfs:range rdf:Property ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:HasValueConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Has-value constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that one of the value nodes is a given RDF node.\"@en ;\n\tsh:parameter sh:HasValueConstraintComponent-hasValue ;\n\trdfs:isDefinedBy sh: .\n\nsh:HasValueConstraintComponent-hasValue\n\ta sh:Parameter ;\n\tsh:path sh:hasValue ;\n\trdfs:isDefinedBy sh: .\n\nsh:hasValue\n\ta rdf:Property ;\n\trdfs:label \"has value\"@en ;\n\trdfs:comment \"Specifies a value that must be among the value nodes.\"@en ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:InConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"In constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to exclusively enumerate the permitted value nodes.\"@en ;\n\tsh:parameter sh:InConstraintComponent-in ;\n\trdfs:isDefinedBy sh: .\n\nsh:InConstraintComponent-in\n\ta sh:Parameter ;\n\tsh:path sh:in ;\n\tsh:maxCount 1 ;\n\trdfs:isDefinedBy sh: .\n\nsh:in\n\ta rdf:Property ;\n\trdfs:label \"in\"@en ;\n\trdfs:comment \"Specifies a list of allowed values so that each value node must be among the members of the given list.\"@en ;\n\trdfs:range rdf:List ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:LanguageInConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Language-in constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to enumerate language tags that all value nodes must have.\"@en ;\n\tsh:parameter sh:LanguageInConstraintComponent-languageIn ;\n\trdfs:isDefinedBy sh: .\n\nsh:LanguageInConstraintComponent-languageIn\n\ta sh:Parameter ;\n\tsh:path sh:languageIn ;\n\tsh:maxCount 1 ;\n\trdfs:isDefinedBy sh: .\n\nsh:languageIn\n\ta rdf:Property ;\n\trdfs:label \"language in\"@en ;\n\trdfs:comment \"Specifies a list of language tags that all value nodes must have.\"@en ;\n\trdfs:range rdf:List ;   # members: xsd:string\n\trdfs:isDefinedBy sh: .\n\n\nsh:LessThanConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Less-than constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that each value node is smaller than all the nodes that have the focus node as subject and the value of a given property as predicate.\"@en ;\n\tsh:parameter sh:LessThanConstraintComponent-lessThan ;\n\trdfs:isDefinedBy sh: .\n\nsh:LessThanConstraintComponent-lessThan\n\ta sh:Parameter ;\n\tsh:path sh:lessThan ;\n\tsh:nodeKind sh:IRI ;\n\trdfs:isDefinedBy sh: .\n\nsh:lessThan\n\ta rdf:Property ;\n\trdfs:label \"less than\"@en ;\n\trdfs:comment \"Specifies a property that must have smaller values than the value nodes.\"@en ;\n\trdfs:range rdf:Property ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:LessThanOrEqualsConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"less-than-or-equals constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that every value node is smaller than all the nodes that have the focus node as subject and the value of a given property as predicate.\"@en ;\n\tsh:parameter sh:LessThanOrEqualsConstraintComponent-lessThanOrEquals ;\n\trdfs:isDefinedBy sh: .\n\nsh:LessThanOrEqualsConstraintComponent-lessThanOrEquals\n\ta sh:Parameter ;\n\tsh:path sh:lessThanOrEquals ;\n\tsh:nodeKind sh:IRI ;\n\trdfs:isDefinedBy sh: .\n\nsh:lessThanOrEquals\n\ta rdf:Property ;\n\trdfs:label \"less than or equals\"@en ;\n\trdfs:comment \"Specifies a property that must have smaller or equal values than the value nodes.\"@en ;\n\trdfs:range rdf:Property ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:MaxCountConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Max-count constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to restrict the maximum number of value nodes.\"@en ;\n\tsh:parameter sh:MaxCountConstraintComponent-maxCount ;\n\trdfs:isDefinedBy sh: .\n\nsh:MaxCountConstraintComponent-maxCount\n\ta sh:Parameter ;\n\tsh:path sh:maxCount ;\n\tsh:datatype xsd:integer ;\n\tsh:maxCount 1 ;\n\trdfs:isDefinedBy sh: .\n\nsh:maxCount\n\ta rdf:Property ;\n\trdfs:label \"max count\"@en ;\n\trdfs:comment \"Specifies the maximum number of values in the set of value nodes.\"@en ;\n\trdfs:range xsd:integer ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:MaxExclusiveConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Max-exclusive constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to restrict the range of value nodes with a maximum exclusive value.\"@en ;\n\tsh:parameter sh:MaxExclusiveConstraintComponent-maxExclusive ;\n\trdfs:isDefinedBy sh: .\n\nsh:MaxExclusiveConstraintComponent-maxExclusive\n\ta sh:Parameter ;\n\tsh:path sh:maxExclusive ;\n\tsh:maxCount 1 ;\n\tsh:nodeKind sh:Literal ;\n\trdfs:isDefinedBy sh: .\n\nsh:maxExclusive\n\ta rdf:Property ;\n\trdfs:label \"max exclusive\"@en ;\n\trdfs:comment \"Specifies the maximum exclusive value of each value node.\"@en ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:MaxInclusiveConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Max-inclusive constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to restrict the range of value nodes with a maximum inclusive value.\"@en ;\n\tsh:parameter sh:MaxInclusiveConstraintComponent-maxInclusive ;\n\trdfs:isDefinedBy sh: .\n\nsh:MaxInclusiveConstraintComponent-maxInclusive\n\ta sh:Parameter ;\n\tsh:path sh:maxInclusive ;\n\tsh:maxCount 1 ;\n\tsh:nodeKind sh:Literal ;\n\trdfs:isDefinedBy sh: .\n\nsh:maxInclusive\n\ta rdf:Property ;\n\trdfs:label \"max inclusive\"@en ;\n\trdfs:comment \"Specifies the maximum inclusive value of each value node.\"@en ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:MaxLengthConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Max-length constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to restrict the maximum string length of value nodes.\"@en ;\n\tsh:parameter sh:MaxLengthConstraintComponent-maxLength ;\n\trdfs:isDefinedBy sh: .\n\nsh:MaxLengthConstraintComponent-maxLength\n\ta sh:Parameter ;\n\tsh:path sh:maxLength ;\n\tsh:datatype xsd:integer ;\n\tsh:maxCount 1 ;\n\trdfs:isDefinedBy sh: .\n\nsh:maxLength\n\ta rdf:Property ;\n\trdfs:label \"max length\"@en ;\n\trdfs:comment \"Specifies the maximum string length of each value node.\"@en ;\n\trdfs:range xsd:integer ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:MinCountConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Min-count constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to restrict the minimum number of value nodes.\"@en ;\n\tsh:parameter sh:MinCountConstraintComponent-minCount ;\n\trdfs:isDefinedBy sh: .\n\nsh:MinCountConstraintComponent-minCount\n\ta sh:Parameter ;\n\tsh:path sh:minCount ;\n\tsh:datatype xsd:integer ;\n\tsh:maxCount 1 ;\n\trdfs:isDefinedBy sh: .\n\nsh:minCount\n\ta rdf:Property ;\n\trdfs:label \"min count\"@en ;\n\trdfs:comment \"Specifies the minimum number of values in the set of value nodes.\"@en ;\n\trdfs:range xsd:integer ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:MinExclusiveConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Min-exclusive constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to restrict the range of value nodes with a minimum exclusive value.\"@en ;\n\tsh:parameter sh:MinExclusiveConstraintComponent-minExclusive ;\n\trdfs:isDefinedBy sh: .\n\nsh:MinExclusiveConstraintComponent-minExclusive\n\ta sh:Parameter ;\n\tsh:path sh:minExclusive ;\n\tsh:maxCount 1 ;\n\tsh:nodeKind sh:Literal ;\n\trdfs:isDefinedBy sh: .\n\nsh:minExclusive\n\ta rdf:Property ;\n\trdfs:label \"min exclusive\"@en ;\n\trdfs:comment \"Specifies the minimum exclusive value of each value node.\"@en ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:MinInclusiveConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Min-inclusive constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to restrict the range of value nodes with a minimum inclusive value.\"@en ;\n\tsh:parameter sh:MinInclusiveConstraintComponent-minInclusive ;\n\trdfs:isDefinedBy sh: .\n\nsh:MinInclusiveConstraintComponent-minInclusive\n\ta sh:Parameter ;\n\tsh:path sh:minInclusive ;\n\tsh:maxCount 1 ;\n\tsh:nodeKind sh:Literal ;\n\trdfs:isDefinedBy sh: .\n\nsh:minInclusive\n\ta rdf:Property ;\n\trdfs:label \"min inclusive\"@en ;\n\trdfs:comment \"Specifies the minimum inclusive value of each value node.\"@en ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:MinLengthConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Min-length constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to restrict the minimum string length of value nodes.\"@en ;\n\tsh:parameter sh:MinLengthConstraintComponent-minLength ;\n\trdfs:isDefinedBy sh: .\n\nsh:MinLengthConstraintComponent-minLength\n\ta sh:Parameter ;\n\tsh:path sh:minLength ;\n\tsh:datatype xsd:integer ;\n\tsh:maxCount 1 ;\n\trdfs:isDefinedBy sh: .\n\nsh:minLength\n\ta rdf:Property ;\n\trdfs:label \"min length\"@en ;\n\trdfs:comment \"Specifies the minimum string length of each value node.\"@en ;\n\trdfs:range xsd:integer ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:NodeConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Node constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that all value nodes conform to the given node shape.\"@en ;\n\tsh:parameter sh:NodeConstraintComponent-node ;\n\trdfs:isDefinedBy sh: .\n\nsh:NodeConstraintComponent-node\n\ta sh:Parameter ;\n\tsh:path sh:node ;\n\trdfs:isDefinedBy sh: .\n\nsh:node\n\ta rdf:Property ;\n\trdfs:label \"node\"@en ;\n\trdfs:comment \"Specifies the node shape that all value nodes must conform to.\"@en ;\n\trdfs:range sh:NodeShape ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:NodeKindConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Node-kind constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to restrict the RDF node kind of each value node.\"@en ;\n\tsh:parameter sh:NodeKindConstraintComponent-nodeKind ;\n\trdfs:isDefinedBy sh: .\n\nsh:NodeKindConstraintComponent-nodeKind\n\ta sh:Parameter ;\n\tsh:path sh:nodeKind ;\n\tsh:in ( sh:BlankNode sh:IRI sh:Literal sh:BlankNodeOrIRI sh:BlankNodeOrLiteral sh:IRIOrLiteral ) ;\n\tsh:maxCount 1 ;\n\trdfs:isDefinedBy sh: .\n\nsh:nodeKind\n\ta rdf:Property ;\n\trdfs:label \"node kind\"@en ;\n\trdfs:comment \"Specifies the node kind (e.g. IRI or literal) each value node.\"@en ;\n\trdfs:range sh:NodeKind ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:NotConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Not constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that value nodes do not conform to a given shape.\"@en ;\n\tsh:parameter sh:NotConstraintComponent-not ;\n\trdfs:isDefinedBy sh: .\n\nsh:NotConstraintComponent-not\n\ta sh:Parameter ;\n\tsh:path sh:not ;\n\trdfs:isDefinedBy sh: .\n\nsh:not\n\ta rdf:Property ;\n\trdfs:label \"not\"@en ;\n\trdfs:comment \"Specifies a shape that the value nodes must not conform to.\"@en ;\n\trdfs:range sh:Shape ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:OrConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Or constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to restrict the value nodes so that they conform to at least one out of several provided shapes.\"@en ;\n\tsh:parameter sh:OrConstraintComponent-or ;\n\trdfs:isDefinedBy sh: .\n\nsh:OrConstraintComponent-or\n\ta sh:Parameter ;\n\tsh:path sh:or ;\n\trdfs:isDefinedBy sh: .\n\nsh:or\n\ta rdf:Property ;\n\trdfs:label \"or\"@en ;\n\trdfs:comment \"Specifies a list of shapes so that the value nodes must conform to at least one of the shapes.\"@en ;\n\trdfs:range rdf:List ;    # members: sh:Shape ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:PatternConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Pattern constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that every value node matches a given regular expression.\"@en ;\n\tsh:parameter sh:PatternConstraintComponent-pattern ;\n\tsh:parameter sh:PatternConstraintComponent-flags ;\n\trdfs:isDefinedBy sh: .\n\nsh:PatternConstraintComponent-pattern\n\ta sh:Parameter ;\n\tsh:path sh:pattern ;\n\tsh:datatype xsd:string ;\n\trdfs:isDefinedBy sh: .\n\nsh:PatternConstraintComponent-flags\n\ta sh:Parameter ;\n\tsh:path sh:flags ;\n\tsh:datatype xsd:string ;\n\tsh:optional true ;\n\trdfs:isDefinedBy sh: .\n\nsh:flags\n\ta rdf:Property ;\n\trdfs:label \"flags\"@en ;\n\trdfs:comment \"An optional flag to be used with regular expression pattern matching.\"@en ;\n\trdfs:range xsd:string ;\n\trdfs:isDefinedBy sh: .\n\nsh:pattern\n\ta rdf:Property ;\n\trdfs:label \"pattern\"@en ;\n\trdfs:comment \"Specifies a regular expression pattern that the string representations of the value nodes must match.\"@en ;\n\trdfs:range xsd:string ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:PropertyConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Property constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that all value nodes conform to the given property shape.\"@en ;\n\tsh:parameter sh:PropertyConstraintComponent-property ;\n\trdfs:isDefinedBy sh: .\n\nsh:PropertyConstraintComponent-property\n\ta sh:Parameter ;\n\tsh:path sh:property ;\n\trdfs:isDefinedBy sh: .\n\nsh:property\n\ta rdf:Property ;\n\trdfs:label \"property\"@en ;\n\trdfs:comment \"Links a shape to its property shapes.\"@en ;\n\trdfs:domain sh:Shape ;\n\trdfs:range sh:PropertyShape ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:QualifiedMaxCountConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Qualified-max-count constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that a specified maximum number of value nodes conforms to a given shape.\"@en ;\n\tsh:parameter sh:QualifiedMaxCountConstraintComponent-qualifiedMaxCount ;\n\tsh:parameter sh:QualifiedMaxCountConstraintComponent-qualifiedValueShape ;\n\tsh:parameter sh:QualifiedMaxCountConstraintComponent-qualifiedValueShapesDisjoint ;\n\trdfs:isDefinedBy sh: .\n\nsh:QualifiedMaxCountConstraintComponent-qualifiedMaxCount\n\ta sh:Parameter ;\n\tsh:path sh:qualifiedMaxCount ;\n\tsh:datatype xsd:integer ;\n\trdfs:isDefinedBy sh: .\n\nsh:QualifiedMaxCountConstraintComponent-qualifiedValueShape\n\ta sh:Parameter ;\n\tsh:path sh:qualifiedValueShape ;\n\trdfs:isDefinedBy sh: .\n\nsh:QualifiedMaxCountConstraintComponent-qualifiedValueShapesDisjoint\n\ta sh:Parameter ;\n\tsh:path sh:qualifiedValueShapesDisjoint ;\n\tsh:datatype xsd:boolean ;\n\tsh:optional true ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:QualifiedMinCountConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Qualified-min-count constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that a specified minimum number of value nodes conforms to a given shape.\"@en ;\n\tsh:parameter sh:QualifiedMinCountConstraintComponent-qualifiedMinCount ;\n\tsh:parameter sh:QualifiedMinCountConstraintComponent-qualifiedValueShape ;\n\tsh:parameter sh:QualifiedMinCountConstraintComponent-qualifiedValueShapesDisjoint ;\n\trdfs:isDefinedBy sh: .\n\nsh:QualifiedMinCountConstraintComponent-qualifiedMinCount\n\ta sh:Parameter ;\n\tsh:path sh:qualifiedMinCount ;\n\tsh:datatype xsd:integer ;\n\trdfs:isDefinedBy sh: .\n\nsh:QualifiedMinCountConstraintComponent-qualifiedValueShape\n\ta sh:Parameter ;\n\tsh:path sh:qualifiedValueShape ;\n\trdfs:isDefinedBy sh: .\n\nsh:QualifiedMinCountConstraintComponent-qualifiedValueShapesDisjoint\n\ta sh:Parameter ;\n\tsh:path sh:qualifiedValueShapesDisjoint ;\n\tsh:datatype xsd:boolean ;\n\tsh:optional true ;\n\trdfs:isDefinedBy sh: .\n\nsh:qualifiedMaxCount\n\ta rdf:Property ;\n\trdfs:label \"qualified max count\"@en ;\n\trdfs:comment \"The maximum number of value nodes that can conform to the shape.\"@en ;\n\trdfs:range xsd:integer ;\n\trdfs:isDefinedBy sh: .\n\nsh:qualifiedMinCount\n\ta rdf:Property ;\n\trdfs:label \"qualified min count\"@en ;\n\trdfs:comment \"The minimum number of value nodes that must conform to the shape.\"@en ;\n\trdfs:range xsd:integer ;\n\trdfs:isDefinedBy sh: .\n\nsh:qualifiedValueShape\n\ta rdf:Property ;\n\trdfs:label \"qualified value shape\"@en ;\n\trdfs:comment \"The shape that a specified number of values must conform to.\"@en ;\n\trdfs:range sh:Shape ;\n\trdfs:isDefinedBy sh: .\n\t\nsh:qualifiedValueShapesDisjoint\n\ta rdf:Property ;\n\trdfs:label \"qualified value shapes disjoint\"@en ;\n\trdfs:comment \"Can be used to mark the qualified value shape to be disjoint with its sibling shapes.\"@en ;\n\trdfs:range xsd:boolean ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:UniqueLangConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Unique-languages constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to specify that no pair of value nodes may use the same language tag.\"@en ;\n\tsh:parameter sh:UniqueLangConstraintComponent-uniqueLang ;\n\trdfs:isDefinedBy sh: .\n\nsh:UniqueLangConstraintComponent-uniqueLang\n\ta sh:Parameter ;\n\tsh:path sh:uniqueLang ;\n\tsh:datatype xsd:boolean ;\n\tsh:maxCount 1 ;\n\trdfs:isDefinedBy sh: .\n\nsh:uniqueLang\n\ta rdf:Property ;\n\trdfs:label \"unique languages\"@en ;\n\trdfs:comment \"Specifies whether all node values must have a unique (or no) language tag.\"@en ;\n\trdfs:range xsd:boolean ;\n\trdfs:isDefinedBy sh: .\n\n\nsh:XoneConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Exactly one constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to restrict the value nodes so that they conform to exactly one out of several provided shapes.\"@en ;\n\tsh:parameter sh:XoneConstraintComponent-xone ;\n\trdfs:isDefinedBy sh: .\n\nsh:XoneConstraintComponent-xone\n\ta sh:Parameter ;\n\tsh:path sh:xone ;\n\trdfs:isDefinedBy sh: .\n\nsh:xone\n\ta rdf:Property ;\n\trdfs:label \"exactly one\"@en ;\n\trdfs:comment \"Specifies a list of shapes so that the value nodes must conform to exactly one of the shapes.\"@en ;\n\trdfs:range rdf:List ;    # members: sh:Shape ;\n\trdfs:isDefinedBy sh: .\n\n\n# General SPARQL execution support --------------------------------------------\n\nsh:SPARQLExecutable\n\ta rdfs:Class ;\n\trdfs:label \"SPARQL executable\"@en ;\n\trdfs:comment \"The class of resources that encapsulate a SPARQL query.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:SPARQLAskExecutable\n\ta rdfs:Class ;\n\trdfs:label \"SPARQL ASK executable\"@en ;\n\trdfs:comment \"The class of SPARQL executables that are based on an ASK query.\"@en ;\n\trdfs:subClassOf sh:SPARQLExecutable ;\n\trdfs:isDefinedBy sh: .\n\nsh:ask\n\ta rdf:Property ;\n\trdfs:label \"ask\"@en ;\n\trdfs:comment \"The SPARQL ASK query to execute.\"@en ;\n\trdfs:domain sh:SPARQLAskExecutable ;\n\trdfs:range xsd:string ;\n\trdfs:isDefinedBy sh: .\n\nsh:SPARQLConstructExecutable\n\ta rdfs:Class ;\n\trdfs:label \"SPARQL CONSTRUCT executable\"@en ;\n\trdfs:comment \"The class of SPARQL executables that are based on a CONSTRUCT query.\"@en ;\n\trdfs:subClassOf sh:SPARQLExecutable ;\n\trdfs:isDefinedBy sh: .\n\nsh:construct\n\ta rdf:Property ;\n\trdfs:label \"construct\"@en ;\n\trdfs:comment \"The SPARQL CONSTRUCT query to execute.\"@en ;\n\trdfs:domain sh:SPARQLConstructExecutable ;\n\trdfs:range xsd:string ;\n\trdfs:isDefinedBy sh: .\n\nsh:SPARQLSelectExecutable\n\ta rdfs:Class ;\n\trdfs:label \"SPARQL SELECT executable\"@en ;\n\trdfs:comment \"The class of SPARQL executables based on a SELECT query.\"@en ;\n\trdfs:subClassOf sh:SPARQLExecutable ;\n\trdfs:isDefinedBy sh: .\n\nsh:select\n\ta rdf:Property ;\n\trdfs:label \"select\"@en ;\n\trdfs:comment \"The SPARQL SELECT query to execute.\"@en ;\n\trdfs:range xsd:string ;\n\trdfs:domain sh:SPARQLSelectExecutable ;\n\trdfs:isDefinedBy sh: .\n\nsh:SPARQLUpdateExecutable\n\ta rdfs:Class ;\n\trdfs:label \"SPARQL UPDATE executable\"@en ;\n\trdfs:comment \"The class of SPARQL executables based on a SPARQL UPDATE.\"@en ;\n\trdfs:subClassOf sh:SPARQLExecutable ;\n\trdfs:isDefinedBy sh: .\n\nsh:update\n\ta rdf:Property ;\n\trdfs:label \"update\"@en ;\n\trdfs:comment \"The SPARQL UPDATE to execute.\"@en ;\n\trdfs:domain sh:SPARQLUpdateExecutable ;\n\trdfs:range xsd:string ;\n\trdfs:isDefinedBy sh: .\n\nsh:prefixes\n\ta rdf:Property ;\n\trdfs:label \"prefixes\"@en ;\n\trdfs:comment \"The prefixes that shall be applied before parsing the associated SPARQL query.\"@en ;\n\trdfs:domain sh:SPARQLExecutable ;\n\trdfs:range owl:Ontology ;\n\trdfs:isDefinedBy sh: .\n\nsh:PrefixDeclaration\n\ta rdfs:Class ;\n\trdfs:label \"Prefix declaration\"@en ;\n\trdfs:comment \"The class of prefix declarations, consisting of pairs of a prefix with a namespace.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:declare\n\ta rdf:Property ;\n\trdfs:label \"declare\"@en ;\n\trdfs:comment \"Links a resource with its namespace prefix declarations.\"@en ;\n\trdfs:domain owl:Ontology ;\n\trdfs:range sh:PrefixDeclaration ;\n\trdfs:isDefinedBy sh: .\n\nsh:prefix\n\ta rdf:Property ;\n\trdfs:label \"prefix\"@en ;\n\trdfs:comment \"The prefix of a prefix declaration.\"@en ;\n\trdfs:domain sh:PrefixDeclaration ;\n\trdfs:range xsd:string ;\n\trdfs:isDefinedBy sh: .\n\nsh:namespace\n\ta rdf:Property ;\n\trdfs:label \"namespace\"@en ;\n\trdfs:comment \"The namespace associated with a prefix in a prefix declaration.\"@en ;\n\trdfs:domain sh:PrefixDeclaration ;\n\trdfs:range xsd:anyURI ;\n\trdfs:isDefinedBy sh: .\n\t\n\n# SPARQL-based Constraints support --------------------------------------------\n\nsh:SPARQLConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"SPARQL constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to define constraints based on SPARQL queries.\"@en ;\n\tsh:parameter sh:SPARQLConstraintComponent-sparql ;\n\trdfs:isDefinedBy sh: .\n\nsh:SPARQLConstraintComponent-sparql\n\ta sh:Parameter ;\n\tsh:path sh:sparql ;\n\trdfs:isDefinedBy sh: .\n\nsh:sparql\n\ta rdf:Property ;\n\trdfs:label \"constraint (in SPARQL)\"@en ;\n\trdfs:comment \"Links a shape with SPARQL constraints.\"@en ;\n\trdfs:domain sh:Shape ;\n\trdfs:range sh:SPARQLConstraint ;\n\trdfs:isDefinedBy sh: .\n\nsh:SPARQLConstraint\n\ta rdfs:Class ;\n\trdfs:label \"SPARQL constraint\"@en ;\n\trdfs:comment \"The class of constraints based on SPARQL SELECT queries.\"@en ;\n\trdfs:subClassOf sh:SPARQLSelectExecutable ;\n\trdfs:isDefinedBy sh: .\n\n\n# Non-validating constraint properties ----------------------------------------\n\nsh:defaultValue\n\ta rdf:Property ;\n\trdfs:label \"default value\"@en ;\n\trdfs:comment \"A default value for a property, for example for user interface tools to pre-populate input fields.\"@en ;\n\trdfs:domain sh:PropertyShape ;\n\trdfs:isDefinedBy sh: .\n\nsh:description\n\ta rdf:Property ;\n\trdfs:label \"description\"@en ;\n\trdfs:comment \"Human-readable descriptions for the property in the context of the surrounding shape.\"@en ;\n\trdfs:domain sh:PropertyShape ;\n\t# range: xsd:string or rdf:langString\n\trdfs:isDefinedBy sh: .\n\nsh:group\n\ta rdf:Property ;\n\trdfs:label \"group\"@en ;\n\trdfs:comment \"Can be used to link to a property group to indicate that a property shape belongs to a group of related property shapes.\"@en ;\n\trdfs:domain sh:PropertyShape ;\n\trdfs:range sh:PropertyGroup ;\n\trdfs:isDefinedBy sh: .\n\nsh:name\n\ta rdf:Property ;\n\trdfs:label \"name\"@en ;\n\trdfs:comment \"Human-readable labels for the property in the context of the surrounding shape.\"@en ;\n\trdfs:domain sh:PropertyShape ;\n\t# range: xsd:string or rdf:langString\n\trdfs:isDefinedBy sh: .\n\nsh:order\n\ta rdf:Property ;\n\trdfs:label \"order\"@en ;\n\trdfs:comment \"Specifies the relative order of this compared to its siblings. For example use 0 for the first, 1 for the second.\"@en ;\n\t# range: xsd:decimal or xsd:integer ;\n\trdfs:isDefinedBy sh: .\n\nsh:PropertyGroup\n\ta rdfs:Class ;\n\trdfs:label \"Property group\"@en ;\n\trdfs:comment \"Instances of this class represent groups of property shapes that belong together.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\n\n# -----------------------------------------------------------------------------\n# SHACL ADVANCED FEATURES -----------------------------------------------------\n# -----------------------------------------------------------------------------\n\t\n\n# Advanced Target vocabulary --------------------------------------------------\n\nsh:target\n\ta rdf:Property ;\n\trdfs:label \"target\"@en ;\n\trdfs:comment \"Links a shape to a target specified by an extension language, for example instances of sh:SPARQLTarget.\"@en ;\n\trdfs:domain sh:Shape ;\n\trdfs:range sh:Target ;\n\trdfs:isDefinedBy sh: .\n\nsh:Target\n\ta rdfs:Class ;\n\trdfs:label \"Target\"@en ;\n\trdfs:comment \"The base class of targets such as those based on SPARQL queries.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:TargetType\n\ta rdfs:Class ;\n\trdfs:label \"Target type\"@en ;\n\trdfs:comment \"The (meta) class for parameterizable targets.\tInstances of this are instantiated as values of the sh:target property.\"@en ;\n\trdfs:subClassOf rdfs:Class ;\n\trdfs:subClassOf sh:Parameterizable ;\n\trdfs:isDefinedBy sh: .\n\nsh:SPARQLTarget\n\ta rdfs:Class ;\n\trdfs:label \"SPARQL target\"@en ;\n\trdfs:comment \"The class of targets that are based on SPARQL queries.\"@en ;\n\trdfs:subClassOf sh:Target ;\n\trdfs:subClassOf sh:SPARQLAskExecutable ;\n\trdfs:subClassOf sh:SPARQLSelectExecutable ;\n\trdfs:isDefinedBy sh: .\n\nsh:SPARQLTargetType\n\ta rdfs:Class ;\n\trdfs:label \"SPARQL target type\"@en ;\n\trdfs:comment \"The (meta) class for parameterizable targets that are based on SPARQL queries.\"@en ;\n\trdfs:subClassOf sh:TargetType ;\n\trdfs:subClassOf sh:SPARQLAskExecutable ;\n\trdfs:subClassOf sh:SPARQLSelectExecutable ;\n\trdfs:isDefinedBy sh: .\n\n\n# Functions Vocabulary --------------------------------------------------------\n\nsh:Function\n\ta rdfs:Class ;\n\trdfs:label \"Function\"@en ;\n\trdfs:comment \"The class of SHACL functions.\"@en ;\n\trdfs:subClassOf sh:Parameterizable ;\n\trdfs:isDefinedBy sh: .\n\nsh:returnType\n\ta rdf:Property ;\n\trdfs:label \"return type\"@en ;\n\trdfs:comment \"The expected type of values returned by the associated function.\"@en ;\n\trdfs:domain sh:Function ;\n\trdfs:range rdfs:Class ;\n\trdfs:isDefinedBy sh: .\n\nsh:SPARQLFunction\n\ta rdfs:Class ;\n\trdfs:label \"SPARQL function\"@en ;\n\trdfs:comment \"A function backed by a SPARQL query - either ASK or SELECT.\"@en ;\n\trdfs:subClassOf sh:Function ;\n\trdfs:subClassOf sh:SPARQLAskExecutable ;\n\trdfs:subClassOf sh:SPARQLSelectExecutable ;\n\trdfs:isDefinedBy sh: .\n\n\n# Result Annotations ----------------------------------------------------------\n\nsh:resultAnnotation\n\ta rdf:Property ;\n\trdfs:label \"result annotation\"@en ;\n\trdfs:comment \"Links a SPARQL validator with zero or more sh:ResultAnnotation instances, defining how to derive additional result properties based on the variables of the SELECT query.\"@en ;\n\trdfs:domain sh:SPARQLSelectValidator ;\n\trdfs:range sh:ResultAnnotation ;\n\trdfs:isDefinedBy sh: .\n\nsh:ResultAnnotation\n\ta rdfs:Class ;\n\trdfs:label \"Result annotation\"@en ;\n\trdfs:comment \"A class of result annotations, which define the rules to derive the values of a given annotation property as extra values for a validation result.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:annotationProperty\n\ta rdf:Property ;\n\trdfs:label \"annotation property\"@en ;\n\trdfs:comment \"The annotation property that shall be set.\"@en ;\n\trdfs:domain sh:ResultAnnotation ;\n\trdfs:range rdf:Property ;\n\trdfs:isDefinedBy sh: .\n\nsh:annotationValue\n\ta rdf:Property ;\n\trdfs:label \"annotation value\"@en ;\n\trdfs:comment \"The (default) values of the annotation property.\"@en ;\n\trdfs:domain sh:ResultAnnotation ;\n\trdfs:isDefinedBy sh: .\n\nsh:annotationVarName\n\ta rdf:Property ;\n\trdfs:label \"annotation variable name\"@en ;\n\trdfs:comment \"The name of the SPARQL variable from the SELECT clause that shall be used for the values.\"@en ;\n\trdfs:domain sh:ResultAnnotation ;\n\trdfs:range xsd:string ;\n\trdfs:isDefinedBy sh: .\n\n\t\n# Node Expressions ------------------------------------------------------------\n\nsh:this\n\ta rdfs:Resource ;\n\trdfs:label \"this\"@en ;\n\trdfs:comment \"A node expression that represents the current focus node.\"@en ;\n\trdfs:isDefinedBy sh: .\n\nsh:filterShape\n\ta rdf:Property ;\n\trdfs:label \"filter shape\"@en ;\n\trdfs:comment \"The shape that all input nodes of the expression need to conform to.\"@en ;\n\trdfs:range sh:Shape ;\n\trdfs:isDefinedBy sh: .\n\nsh:nodes\n\ta rdf:Property ;\n\trdfs:label \"nodes\"@en ;\n\trdfs:comment \"The node expression producing the input nodes of a filter shape expression.\"@en ;\n\trdfs:isDefinedBy sh: .\n\nsh:intersection\n\ta rdf:Property ;\n\trdfs:label \"intersection\"@en ;\n\trdfs:comment \"A list of node expressions that shall be intersected.\"@en ;\n\trdfs:isDefinedBy sh: .\n\nsh:union\n\ta rdf:Property ;\n\trdfs:label \"union\"@en ;\n\trdfs:comment \"A list of node expressions that shall be used together.\"@en ;\n\trdfs:isDefinedBy sh: .\n\n\n# Expression Constraints ------------------------------------------------------\n\nsh:ExpressionConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"Expression constraint component\"@en ;\n\trdfs:comment \"A constraint component that can be used to verify that a given node expression produces true for all value nodes.\"@en ;\n\tsh:parameter sh:ExpressionConstraintComponent-expression ;\n\trdfs:isDefinedBy sh: .\n\nsh:ExpressionConstraintComponent-expression\n\ta sh:Parameter ;\n\tsh:path sh:expression ;\n\trdfs:isDefinedBy sh: .\n\nsh:expression\n\ta rdf:Property ;\n\trdfs:label \"expression\"@en ;\n\trdfs:comment \"The node expression that must return true for the value nodes.\"@en ;\n\trdfs:isDefinedBy sh: .\n\n\n# Rules -----------------------------------------------------------------------\n\nsh:Rule\n\ta rdfs:Class ;\n\trdfs:label \"Rule\"@en ;\n\trdfs:comment \"The class of SHACL rules. Never instantiated directly.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:rule\n\ta rdf:Property ;\n\trdfs:label \"rule\"@en ;\n\trdfs:comment \"The rules linked to a shape.\"@en ;\n\trdfs:domain sh:Shape ;\n\trdfs:range sh:Rule ;\n\trdfs:isDefinedBy sh:  .\n\nsh:condition\n\ta rdf:Property ;\n\trdfs:label \"condition\"@en ;\n\trdfs:comment \"The shapes that the focus nodes need to conform to before a rule is executed on them.\"@en ;\n\trdfs:domain sh:Rule ;\n\trdfs:range sh:Shape ;\n\trdfs:isDefinedBy sh: .\n\nsh:TripleRule\n\ta rdfs:Class ;\n\trdfs:label \"A rule based on triple (subject, predicate, object) pattern.\"@en ;\n\trdfs:subClassOf sh:Rule ;\n\trdfs:isDefinedBy sh: .\n\nsh:subject\n\ta rdf:Property ;\n\trdfs:label \"subject\"@en ;\n\trdfs:comment \"An expression producing the resources that shall be inferred as subjects.\"@en ;\n\trdfs:domain sh:TripleRule ;\n\trdfs:isDefinedBy sh: .\n\nsh:predicate\n\ta rdf:Property ;\n\trdfs:label \"predicate\"@en ;\n\trdfs:comment \"An expression producing the properties that shall be inferred as predicates.\"@en ;\n\trdfs:domain sh:TripleRule ;\n\trdfs:isDefinedBy sh: .\n\nsh:object\n\ta rdf:Property ;\n\trdfs:label \"object\"@en ;\n\trdfs:comment \"An expression producing the nodes that shall be inferred as objects.\"@en ;\n\trdfs:domain sh:TripleRule ;\n\trdfs:isDefinedBy sh: .\n\nsh:SPARQLRule\n\ta rdfs:Class ;\n\trdfs:label \"SPARQL CONSTRUCT rule\"@en ;\n\trdfs:comment \"The class of SHACL rules based on SPARQL CONSTRUCT queries.\"@en ;\n\trdfs:subClassOf sh:Rule ;\n\trdfs:subClassOf sh:SPARQLConstructExecutable ;\n\trdfs:isDefinedBy sh: .\n\n\n# SHACL-JS --------------------------------------------------------------------\n\nsh:JSExecutable\n\ta rdfs:Class ;\n\trdfs:label \"JavaScript executable\"@en ;\n\trdfs:comment \"Abstract base class of resources that declare an executable JavaScript.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:JSTarget\n\ta rdfs:Class ;\n\trdfs:label \"JavaScript target\"@en ;\n\trdfs:comment \"The class of targets that are based on JavaScript functions.\"@en ;\n\trdfs:subClassOf sh:Target ;\n\trdfs:subClassOf sh:JSExecutable ;\n\trdfs:isDefinedBy sh: .\n\nsh:JSTargetType\n\ta rdfs:Class ;\n\trdfs:label \"JavaScript target type\"@en ;\n\trdfs:comment \"The (meta) class for parameterizable targets that are based on JavaScript functions.\"@en ;\n\trdfs:subClassOf sh:TargetType ;\n\trdfs:subClassOf sh:JSExecutable ;\n\trdfs:isDefinedBy sh: .\n\nsh:JSConstraint\n\ta rdfs:Class ;\n\trdfs:label \"JavaScript-based constraint\"@en ;\n\trdfs:comment \"The class of constraints backed by a JavaScript function.\"@en ;\n\trdfs:subClassOf sh:JSExecutable ;\n\trdfs:isDefinedBy sh: .\n\t\nsh:JSConstraintComponent\n\ta sh:ConstraintComponent ;\n\trdfs:label \"JavaScript constraint component\"@en ;\n\trdfs:comment \"A constraint component with the parameter sh:js linking to a sh:JSConstraint containing a sh:script.\"@en ;\n  \tsh:parameter sh:JSConstraint-js ;\n\trdfs:isDefinedBy sh: .\n \nsh:JSConstraint-js\n\ta sh:Parameter ;\n\tsh:path sh:js ;\n\trdfs:isDefinedBy sh: .\n\t\nsh:js\n\ta rdf:Property ;\n\trdfs:label \"JavaScript constraint\"@en ;\n\trdfs:comment \"Constraints expressed in JavaScript.\" ;\n  \trdfs:range sh:JSConstraint ;\n\trdfs:isDefinedBy sh: .\n\nsh:jsFunctionName\n\ta rdf:Property ;\n\trdfs:label \"JavaScript function name\"@en ;\n\trdfs:comment \"The name of the JavaScript function to execute.\"@en ;\n\trdfs:domain sh:JSExecutable ;\n\trdfs:range xsd:string ;\n\trdfs:isDefinedBy sh: .\n\nsh:jsLibrary\n\ta rdf:Property ;\n\trdfs:label \"JavaScript library\"@en ;\n  \trdfs:comment \"Declares which JavaScript libraries are needed to execute this.\"@en ;\n\trdfs:range sh:JSLibrary ;\n\trdfs:isDefinedBy sh: .\n\nsh:jsLibraryURL\n\ta rdf:Property ;\n\trdfs:label \"JavaScript library URL\"@en ;\n\trdfs:comment \"Declares the URLs of a JavaScript library. This should be the absolute URL of a JavaScript file. Implementations may redirect those to local files.\"@en ;\n\trdfs:domain sh:JSLibrary ;\n\trdfs:range xsd:anyURI ;\n\trdfs:isDefinedBy sh: .\n\t\nsh:JSFunction\n\ta rdfs:Class ;\n  \trdfs:label \"JavaScript function\"@en ;\n\trdfs:comment \"The class of SHACL functions that execute a JavaScript function when called.\"@en ;\n\trdfs:subClassOf sh:Function ;\n\trdfs:subClassOf sh:JSExecutable ;\n\trdfs:isDefinedBy sh: .\n\nsh:JSLibrary\n\ta rdfs:Class ;\n\trdfs:label \"JavaScript library\"@en ;\n\trdfs:comment \"Represents a JavaScript library, typically identified by one or more URLs of files to include.\"@en ;\n\trdfs:subClassOf rdfs:Resource ;\n\trdfs:isDefinedBy sh: .\n\nsh:JSRule\n\ta rdfs:Class ;\n\trdfs:label \"JavaScript rule\"@en ;\n\trdfs:comment \"The class of SHACL rules expressed using JavaScript.\"@en ;\n\trdfs:subClassOf sh:JSExecutable ;\n\trdfs:subClassOf sh:Rule ;\n\trdfs:isDefinedBy sh: .\n\nsh:JSValidator\n\ta rdfs:Class ;\n  \trdfs:label \"JavaScript validator\"@en ;\n\trdfs:comment \"A SHACL validator based on JavaScript. This can be used to declare SHACL constraint components that perform JavaScript-based validation when used.\"@en ;\n  \trdfs:subClassOf sh:JSExecutable ;\n  \trdfs:subClassOf sh:Validator ;\n  \trdfs:isDefinedBy sh: .\n"}
},{}]},{},[1]);
