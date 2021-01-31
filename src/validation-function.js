// class ValidationFunction
var RDFQuery = require("./rdfquery");
const NodeSet = require("./rdfquery/node-set");
const T = RDFQuery.T;
var RDFQueryUtil = require("./rdfquery/rdfquery-util");
var debug = require("debug")("validation-function");
var tracer = require("./trace")
var globalObject = typeof window !== 'undefined' ? window : global;


// Functions implementing the validators of SHACL-JS
// Also include validators for the constraint components of the DASH namespace

// Also included: implementations of the standard DASH functions

// There is no validator for sh:property as this is expected to be
// natively implemented by the surrounding engine.

var XSDIntegerTypes = new NodeSet();
XSDIntegerTypes.add(T("xsd:integer"));

var XSDDecimalTypes = new NodeSet();
XSDDecimalTypes.addAll(XSDIntegerTypes.toArray());
XSDDecimalTypes.add(T("xsd:decimal"));
XSDDecimalTypes.add(T("xsd:float"));



var ValidationFunction = function (functionName, parameters, findInScript) {
    
    this.supportedFunctions = [
        "validateAnd",
        "validateClass",
        "validateClosed",
        "validateClosedByTypesNode",
        "validateCoExistsWith",
        "validateDatatype",
        "validateDisjoint",
        "validateEqualsProperty",
        "validateHasValueNode",
        "validateHasValueProperty",
        "validateHasValueWithClass",
        "validateIn",
        "validateLanguageIn",
        "validateLessThanProperty",
        "validateLessThanOrEqualsProperty",
        "validateMaxCountProperty",
        "validateMaxExclusive",
        "validateMaxInclusive",
        "validateMaxLength",
        "validateMinCountProperty",
        "validateMinExclusive",
        "validateMinInclusive",
        "validateMinLength",
        "validateNodeKind",
        "validateNode",
        "validateNonRecursiveProperty",
        "validateNot",
        "validateOr",
        "validatePattern",
        "validatePrimaryKeyProperty",
        "validateQualifiedMaxCountProperty",
        "validateQualifiedMinCountProperty",
        "validateQualifiedHelper",
        "validateQualifiedConformsToASibling",
        "validateRootClass",
        "validateStem",
        "validateSubSetOf",
        "validateUniqueLangProperty",
        "validateUniqueValueForClass",
        "validateXone"
    ];

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
    try {
        if (this.supportedFunctions.find((supportedFn) => supportedFn === this.funcName)) {
            return this[this.funcName].apply(this,args)
        } else {
            return this.func.apply(globalObject, args);
        }
    } catch(e)  {
        throw(e)
    }
};

ValidationFunction.prototype.execute = function (focusNode, valueNode, constraint) {
    var args = [];
    var namedParams = {};
    var pushedValue = false;
    for (var i = 0; i < this.funcArgs.length; i++) {
        var arg = this.funcArgs[i];
        var param = this.parameters[i];
        if (param) {
            var value = constraint.getParameterValue(arg);
            args.push(value);

            if (value) {
                namedParams[arg] = value.value;
            } else {
                namedParams[arg] = null;
            }
        }
        else if (arg === "focusNode") {
            args.push(focusNode);
            if (focusNode != null) {
                namedParams["focusNode"] = focusNode.value;
            }
        }
        else if (arg === "value") {
            if (valueNode != null) {
                namedParams["$value"] = valueNode.value;
            }
            pushedValue = true;
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
    const result = this.doExecute(args);

    tracer.log(constraint.shape.shapeNode.toString(), (valueNode||focusNode), (valueNode||focusNode).__TRACER_ID,"FUNCTION-EVALUATION", {
        function: this.funcName,
        valueNode: valueNode,
        from: focusNode,
        args: namedParams,
        result: result
    });
    return result;
};


// validations

function toPromise(value) {
    return new Promise((resolve, _) => {
        resolve(value);
    });
}

ValidationFunction.prototype.validateAnd = function($value, $and) {
    tracer.log($and, $value, $value.__TRACER_ID,"AND", "" )
    const shapes = new RDFQueryUtil($shapes).rdfListToArray($and);
    const promises = shapes.map((shape) => {
        tracer.log(shape, $value, $value.__TRACER_ID,"AND-BRANCH", {and: $and.value} )
        const result = SHACL.nodeConformsToShape($value, shape)
        tracer.log(shape, $value, $value.__TRACER_ID,"AND-BRANCH-RESULT", {and: $and.value, result: result} )
        return result
    });
    return Promise.all(promises).then((results) => {
        for(var i = 0; i < results.length; i++) {
            if(!results[i]) {
                tracer.log($and, $value, $value.__TRACER_ID,"AND-RESULT", {result: true} )
                return false;
            }
        }
        tracer.log($and, $value, $value.__TRACER_ID,"AND-RESULT", {result: false} )
        return true;
    });
}

ValidationFunction.prototype.validateClass = function($value, $class) {
    return new RDFQueryUtil($data).isInstanceOf($value, $class);
}

ValidationFunction.prototype.validateClosed = function($value, $closed, $ignoredProperties, $currentShape) {
    if(!T("true").equals($closed)) {
        return;
    }
    var allowed = $shapes.query().
    match($currentShape, "sh:property", "?propertyShape").
    match("?propertyShape", "sh:path", "?path").
    filter(function(solution) { return solution.path.isNamedNode } ).
    getNodeSet("?path");
    if($ignoredProperties) {
        allowed.addAll(new RDFQueryUtil($shapes).rdfListToArray($ignoredProperties));
    }
    var results = [];
    $data.query().
    match($value, "?predicate", "?object").
    filter(function(sol) { return !allowed.contains(sol.predicate)}).
    forEach(function(sol) {
        results.push({
            path : sol.predicate,
            value : sol.object
        });
    });
    return results;
}

ValidationFunction.prototype.validateClosedByTypesNode = function($this, $closedByTypes) {
    if(!T("true").equals($closedByTypes)) {
        return;
    }
    var results = [];
    var allowedProperties = new NodeSet();
    $data.query().
    match($this, "rdf:type", "?directType").
    path("?directType", { zeroOrMore : T("rdfs:subClassOf") }, "?type").
    forEachNode("?type", function(type) {
        $shapes.query().
        match(type, "sh:property", "?pshape").
        match("?pshape", "sh:path", "?path").
        filter(function(sol) { return sol.path.isNamedNode }).
        addAllNodes("?path", allowedProperties);
    });
    $data.query().
    match($this, "?predicate", "?object").
    filter(function(sol) { return !T("rdf:type").equals(sol.predicate) }).
    filter(function(sol) { return !allowedProperties.contains(sol.predicate) }).
    forEach(function(sol) {
        results.push({
            path: sol.predicate,
            value: sol.object
        });
    })
    return results;
}

ValidationFunction.prototype.validateCoExistsWith = function($this, $path, $coExistsWith) {
    var path = toRDFQueryPath($path);
    var has1 = $data.query().path($this, path, null).getCount() > 0;
    var has2 = $data.query().match($this, $coExistsWith, null).getCount() > 0;
    return has1 == has2;
}

ValidationFunction.prototype.validateDatatype = function($value, $datatype) {
    if($value.isLiteral) {
        return $datatype.equals($value.datatype) && isValidForDatatype($value.value, $datatype);
    }
    else {
        return false;
    }
}

ValidationFunction.prototype.validateDisjoint = function($this, $value, $disjoint) {
    return !$data.query().match($this, $disjoint, $value).hasSolution();
}

ValidationFunction.prototype.validateEqualsProperty = function($this, $path, $equals) {
    var results = [];
    var path = toRDFQueryPath($path);
    $data.query().path($this, path, "?value").forEach(
        function(solution) {
            if(!$data.query().match($this, $equals, solution.value).hasSolution()) {
                results.push({
                    value: solution.value
                });
            }
        });
    $data.query().match($this, $equals, "?value").forEach(
        function(solution) {
            if(!$data.query().path($this, path, solution.value).hasSolution()) {
                results.push({
                    value: solution.value
                });
            }
        });
    return results;
}

ValidationFunction.prototype.validateEqualsNode = function ($this, $equals) {
    var results = [];
    var solutions = 0;
    $data.query().path($this, $equals, "?value").forEach(
        function (solution) {
            solutions++;
            if (SHACL.compareNodes($this, solution['value']) !== 0) {
                results.push({
                    value: solution.value
                });
            }
        });
    if (results.length === 0 && solutions === 0) {
        results.push({
            value: $this
        });
    }
    return results;
};

ValidationFunction.prototype.validateHasValueNode = function($this, $hasValue) {
    return $this.equals($hasValue);
}

ValidationFunction.prototype.validateHasValueProperty = function($this, $path, $hasValue) {
    var count = $data.query().path($this, toRDFQueryPath($path), $hasValue).getCount();
    return count > 0;
}

ValidationFunction.prototype.validateHasValueWithClass = function($this, $path, $hasValueWithClass) {
    return $data.query().
    path($this, toRDFQueryPath($path), "?value").
    filter(function(sol) { return new RDFQueryUtil($data).isInstanceOf(sol.value, $hasValueWithClass) }).
    hasSolution();
}

ValidationFunction.prototype.validateIn = function($value, $in) {
    var set = new NodeSet();
    set.addAll(new RDFQueryUtil($shapes).rdfListToArray($in));
    tracer.log($in, $value, $value.__TRACER_ID,"EXPLANATION", {set: set.values.map((v) => v.value) })
    return set.contains($value);
}

ValidationFunction.prototype.validateLanguageIn = function($value, $languageIn) {
    if(!$value.isLiteral) {
        return false;
    }
    var lang = $value.language;
    if(!lang || lang === "") {
        return false;
    }
    var ls = new RDFQueryUtil($shapes).rdfListToArray($languageIn);
    for(var i = 0; i < ls.length; i++) {
        if(lang.startsWith(ls[i].value)) {
            return true;
        }
    }
    return false;
}

ValidationFunction.prototype.validateLessThanProperty = function($this, $path, $lessThan) {
    var results = [];
    $data.query().
    path($this, toRDFQueryPath($path), "?value").
    match($this, $lessThan, "?otherValue").
    forEach(function(sol) {
        var c = SHACL.compareNodes(sol.value, sol.otherValue);
        if(c == null || c >= 0) {
            results.push({
                value: sol.value
            });
        }
    });
    return results;
}

ValidationFunction.prototype.validateLessThanOrEqualsProperty = function($this, $path, $lessThanOrEquals) {
    var results = [];
    $data.query().
    path($this, toRDFQueryPath($path), "?value").
    match($this, $lessThanOrEquals, "?otherValue").
    forEach(function(sol) {
        var c = SHACL.compareNodes(sol.value, sol.otherValue);
        if(c == null || c > 0) {
            results.push({
                value: sol.value
            });
        }
    });
    return results;
}

ValidationFunction.prototype.validateMaxCountProperty = function($this, $path, $maxCount) {
    var count = $data.query().path($this, toRDFQueryPath($path), "?any").getCount();
    return count <= Number($maxCount.value);
}

ValidationFunction.prototype.validateMaxExclusive = function($value, $maxExclusive) {
    return $value.isLiteral && Number($value.value) < Number($maxExclusive.value);
}

ValidationFunction.prototype.validateMaxInclusive = function($value, $maxInclusive) {
    return $value.isLiteral && Number($value.value) <= Number($maxInclusive.value);
}

ValidationFunction.prototype.validateMaxLength = function($value, $maxLength) {
    if($value.isBlankNode) {
        return false;
    }
    return $value.value.length <= Number($maxLength.value);
}

ValidationFunction.prototype.validateMinCountProperty = function($this, $path, $minCount) {
    var count = $data.query().path($this, toRDFQueryPath($path), "?any").getCount();
    return count >= Number($minCount.value);
}

ValidationFunction.prototype.validateMinExclusive = function($value, $minExclusive) {
    return $value.isLiteral === true && Number($value.value) > Number($minExclusive.value);
}

ValidationFunction.prototype.validateMinInclusive = function($value, $minInclusive) {
    return $value.isLiteral === true && Number($value.value) >= Number($minInclusive.value);
}

ValidationFunction.prototype.validateMinLength = function($value, $minLength) {
    if($value.isBlankNode) {
        return false;
    }
    return $value.value.length >= Number($minLength.value);
}

ValidationFunction.prototype.validateNodeKind = function($value, $nodeKind) {
    if($value.isBlankNode) {
        return T("sh:BlankNode").equals($nodeKind) ||
            T("sh:BlankNodeOrIRI").equals($nodeKind) ||
            T("sh:BlankNodeOrLiteral").equals($nodeKind);
    }
    else if($value.isNamedNode) {
        return T("sh:IRI").equals($nodeKind) ||
            T("sh:BlankNodeOrIRI").equals($nodeKind) ||
            T("sh:IRIOrLiteral").equals($nodeKind);
    }
    else if($value.isLiteral) {
        return T("sh:Literal").equals($nodeKind) ||
            T("sh:BlankNodeOrLiteral").equals($nodeKind) ||
            T("sh:IRIOrLiteral").equals($nodeKind);
    }
}

ValidationFunction.prototype.validateNode = function($value, $node) {
    return SHACL.nodeConformsToShape($value, $node);
}

ValidationFunction.prototype.validateNonRecursiveProperty = function($this, $path, $nonRecursive) {
    if(T("true").equals($nonRecursive)) {
        if($data.query().path($this, toRDFQueryPath($path), $this).hasSolution()) {
            return {
                path: $path,
                value: $this
            }
        }
    }
}

ValidationFunction.prototype.validateNot = function($value, $not) {
    return SHACL.nodeConformsToShape($value, $not).then((v) => !v);
}

ValidationFunction.prototype.validateOr = function($value, $or) {
    tracer.log($or, $value, $value.__TRACER_ID,"OR", "" )
    var shapes = new RDFQueryUtil($shapes).rdfListToArray($or);
    const promises = shapes.map((shape) => {
        tracer.log(shape, $value, $value.__TRACER_ID,"OR-BRANCH", {or: $or.value});
        const result = SHACL.nodeConformsToShape($value, shape)
        tracer.log(shape, $value, $value.__TRACER_ID, "OR-BRANCH-RESULT", {or: $or.value});
        return result
    })
    return Promise.all(promises).then((results) => {
        for(var i = 0; i < shapes.length; i++) {
            if(results[i]) {
                tracer.log($or, $value, $value.__TRACER_ID,"OR-RESULT", {result: false} )
                return true;
            }
        }
        tracer.log($or, $value, $value.__TRACER_ID,"OR-RESULT", {result: true} )
        return false;
    });
}

ValidationFunction.prototype.validatePattern = function($value, $pattern, $flags) {
    if($value.isBlankNode) {
        return false;
    }
    var re = $flags ? new RegExp($pattern.value, $flags.value) : new RegExp($pattern.value);
    return re.test($value.value);
}

ValidationFunction.prototype.validatePrimaryKeyProperty = function($this, $path, $uriStart) {
    if(!$this.isNamedNode) {
        return "Must be an IRI";
    }
    if($data.query().path($this, toRDFQueryPath($path), null).getCount() != 1) {
        return "Must have exactly one value";
    }
    var value = $data.query().path($this, toRDFQueryPath($path), "?value").getNode("?value");
    var uri = $uriStart.value + encodeURIComponent(value.value);
    if(!$this.uri.equals(uri)) {
        return "Does not have URI " + uri;
    }
}

ValidationFunction.prototype.validateQualifiedMaxCountProperty = function($this, $path, $qualifiedValueShape, $qualifiedValueShapesDisjoint, $qualifiedMaxCount, $currentShape) {
    return this.validateQualifiedHelper($this, $path, $qualifiedValueShape, $qualifiedValueShapesDisjoint, $currentShape).then((c) =>{
        if ($qualifiedMaxCount) {
            return c <= Number($qualifiedMaxCount.value);
        } else {
            return true;
        }
    });
}

ValidationFunction.prototype.validateQualifiedMinCountProperty = function($this, $path, $qualifiedValueShape, $qualifiedValueShapesDisjoint, $qualifiedMinCount, $currentShape) {
    return this.validateQualifiedHelper($this, $path, $qualifiedValueShape, $qualifiedValueShapesDisjoint, $currentShape).then((c) => {
        if ($qualifiedMinCount) {
            return c >= Number($qualifiedMinCount.value);
        } else {
            return true;
        }
    });
}

ValidationFunction.prototype.validateQualifiedHelper = function($this, $path, $qualifiedValueShape, $qualifiedValueShapesDisjoint, $currentShape) {
    let siblingShapes = new NodeSet();
    if(T("true").equals($qualifiedValueShapesDisjoint)) {
        $shapes.query().
        match("?parentShape", "sh:property", $currentShape).
        match("?parentShape", "sh:property", "?sibling").
        match("?sibling", "sh:qualifiedValueShape", "?siblingShape").
        filter(RDFQuery.exprNotEquals("?siblingShape", $qualifiedValueShape)) .
        addAllNodes("?siblingShape", siblingShapes);
    }
    const allResults = $data.query()
        .path($this, toRDFQueryPath($path), "?value")
        .getArray();

    let subTraceCounter = 0;
    const proms = allResults.map((sol) => {
        const nextTrace = `${$this.__TRACER_ID}_${subTraceCounter}`;
        sol.value.__TRACER_ID = nextTrace;
        subTraceCounter++;

        tracer.log($qualifiedValueShape, sol.value, nextTrace, "QUALIFIED-BRANCH", {$this: $this})
        return SHACL.nodeConformsToShape(sol.value, $qualifiedValueShape).catch((e) => console.log("ERROR 1")).then((condProm1) => {
            return this.validateQualifiedConformsToASibling(sol.value, siblingShapes.toArray()).catch((e) => console.log("ERROR 2")).then((condProm2) => {
                return condProm1 && !condProm2; // negation on second condition

            })
        });
    })

    return Promise.all(proms).then((results) => {
        let count =0;
        results.forEach((result) => {
            if(result) {
                count++
            }
        });
        return count
    }).catch((e) => {
        console.log("ERROR!")
    });
}

ValidationFunction.prototype.validateQualifiedConformsToASibling = function(value, siblingShapes) {
    const proms = siblingShapes.map((sibling) => SHACL.nodeConformsToShape(value, sibling));
    return Promise.all(proms).then((results) => {
        for(var i = 0; i < results.length; i++) {
            if(results[i] === true) {
                return true;
            }
        }
        return false;
    });
}

ValidationFunction.prototype.validateRootClass = function($value, $rootClass) {
    return $data.query().path($value, { zeroOrMore: T("rdfs:subClassOf") }, $rootClass).hasSolution();
}

ValidationFunction.prototype.validateStem = function($value, $stem) {
    return $value.isNamedNode && $value.uri.startsWith($stem.value);
}

ValidationFunction.prototype.validateSubSetOf = function($this, $subSetOf, $value) {
    return $data.query().match($this, $subSetOf, $value).hasSolution();
}

ValidationFunction.prototype.validateUniqueLangProperty = function($this, $uniqueLang, $path) {
    if(!T("true").equals($uniqueLang)) {
        return;
    }
    var map = {};
    $data.query().path($this, toRDFQueryPath($path), "?value").forEach(function(sol) {
        var lang = sol.value.language;
        if(lang && lang != "") {
            var old = map[lang];
            if(!old) {
                map[lang] = 1;
            }
            else {
                map[lang] = old + 1;
            }
        }
    })
    var results = [];
    for(var lang in map) {
        if(map.hasOwnProperty(lang)) {
            var count = map[lang];
            if(count > 1) {
                results.push("Language \"" + lang + "\" has been used by " + count + " values");
            }
        }
    }
    return results;
}

ValidationFunction.prototype.validateUniqueValueForClass = function($this, $uniqueValueForClass, $path) {
    var results = [];
    $data.query().
    path($this, toRDFQueryPath($path), "?value").
    path("?other", toRDFQueryPath($path), "?value").
    filter(function(sol) {
        return !$this.equals(sol.other);
    }).
    filter(function(sol) {
        return new RDFQueryUtil($data).isInstanceOf(sol.other, $uniqueValueForClass)
    }).
    forEach(function(sol) {
        results.push({
            other: sol.other,
            value: sol.value
        })
    });
    return results;
}

ValidationFunction.prototype.validateXone = function($value, $xone) {
    tracer.log($xone, $value, $value.__TRACER_ID,"XONE", "" )
    var shapes = new RDFQueryUtil($shapes).rdfListToArray($xone);
    var count = 0;
    const promises = shapes.map((shape) => {
        tracer.log(shape, $value, $value.__TRACER_ID, "XONE-BRANCH", {xone: $xone.value});
        const result = SHACL.nodeConformsToShape($value, shape)
        tracer.log(shape, $value, $value.__TRACER_ID, "XONE-BRANCH-RESULT", {xone: $xone.value});
        return result;
    });
    return Promise.all(promises).then((results) => {
        for(var i = 0; i < shapes.length; i++) {
            if(results[i]) {
                count++;
            }
        }
        tracer.log($xone, $value, $value.__TRACER_ID,"XONE-RESULT", {result: !(count === 1)} )
        return count === 1;
    });
}


// DASH functions -------------------------------------------------------------

// dash:toString
function dash_toString($arg) {
    if($arg.isLiteral) {
        return NodeFactory.literal($arg.value, T("xsd:string"));
    }
    else if($arg.isNamedNode) {
        return NodeFactory.literal($arg.uri, T("xsd:string"));
    }
    else {
        return null;
    }
}


// DASH targets ---------------------------------------------------------------

// dash:AllObjectsTarget
function dash_allObjects() {
    return $data.query().match(null, null, "?object").getNodeSet("?object").toArray();
}

// dash:AllSubjectsTarget
function dash_allSubjects() {
    return $data.query().match("?subject", null, null).getNodeSet("?subject").toArray();
}


// Utilities ------------------------------------------------------------------

function toRDFQueryPath(shPath) {
    if (shPath.termType === "Collection") {
        var paths = new RDFQueryUtil($shapes).rdfListToArray(shPath);
        var result = [];
        for (var i = 0; i < paths.length; i++) {
            result.push(toRDFQueryPath(paths[i]));
        }
        return result;
    }
    if(shPath.isNamedNode) {
        return shPath;
    }
    else if(shPath.isBlankNode) {
        var util = new RDFQueryUtil($shapes);
        if($shapes.query().getObject(shPath, "rdf:first")) {
            var paths = util.rdfListToArray(shPath);
            var result = [];
            for(var i = 0; i < paths.length; i++) {
                result.push(toRDFQueryPath(paths[i]));
            }
            return result;
        }
        var alternativePath = $shapes.query().getObject(shPath, "sh:alternativePath");
        if(alternativePath) {
            var paths = util.rdfListToArray(alternativePath);
            var result = [];
            for(var i = 0; i < paths.length; i++) {
                result.push(toRDFQueryPath(paths[i]));
            }
            return { or : result };
        }
        var zeroOrMorePath = $shapes.query().getObject(shPath, "sh:zeroOrMorePath");
        if(zeroOrMorePath) {
            return { zeroOrMore : toRDFQueryPath(zeroOrMorePath) };
        }
        var oneOrMorePath = $shapes.query().getObject(shPath, "sh:oneOrMorePath");
        if(oneOrMorePath) {
            return { oneOrMore : toRDFQueryPath(oneOrMorePath) };
        }
        var zeroOrOnePath = $shapes.query().getObject(shPath, "sh:zeroOrOnePath");
        if(zeroOrOnePath) {
            return { zeroOrOne : toRDFQueryPath(zeroOrOnePath) };
        }
        var inversePath = $shapes.query().getObject(shPath, "sh:inversePath");
        if(inversePath) {
            return { inverse : toRDFQueryPath(inversePath) };
        }
    }
    throw "Unsupported SHACL path " + shPath;
    // TODO: implement conforming to AbstractQuery.path syntax
    return shPath;
}


// Private helper functions

//TODO: Support more datatypes
function isValidForDatatype(lex, datatype) {
    if(XSDIntegerTypes.contains(datatype)) {
        var r = parseInt(lex);
        return !isNaN(r);
    }
    else if(XSDDecimalTypes.contains(datatype)) {
        var r = parseFloat(lex);
        return !isNaN(r);
    }
    else if (datatype.value === "http://www.w3.org/2001/XMLSchema#boolean") {
        return lex === "true" || lex === "false";
    }
    else {
        return true;
    }
}

module.exports = ValidationFunction;