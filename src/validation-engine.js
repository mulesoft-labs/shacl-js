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
ValidationEngine.prototype.createResultFromObject = function (obj, constraint, focusNode, valueNode, topLevel) {
    if (obj === false) {
        if (this.conformanceOnly) {
            return false;
        }

        if (topLevel) { // only record error if we are at the  top level
            var result = this.createResult(constraint, focusNode, valueNode);
            if (constraint.shape.isPropertyShape()) {
                this.addResultProperty(result, T("sh:resultPath"), constraint.shape.path); // TODO: Make deep copy
            }
            this.createResultMessages(result, constraint);
        }
        return true; // always return the validation error
    }
    else if (typeof obj === 'string') {
        if (this.conformanceOnly) {
            return false;
        }
        if (topLevel) {
            result = this.createResult(constraint, focusNode, valueNode);
            if (constraint.shape.isPropertyShape()) {
                this.addResultProperty(result, T("sh:resultPath"), constraint.shape.path); // TODO: Make deep copy
            }
            this.addResultProperty(result, T("sh:resultMessage"), TermFactory.literal(obj, T("xsd:string")));
            this.createResultMessages(result, constraint);
        }
        return true;
    }
    else if (typeof obj === 'object') {
        if (this.conformanceOnly) {
            return false;
        }
        if  (topLevel) {
            result = this.createResult(constraint, focusNode);
            if (obj.path) {
                this.addResultProperty(result, T("sh:resultPath"), obj.path); // TODO: Make deep copy
            } else if (constraint.shape.isPropertyShape()) {
                this.addResultProperty(result, T("sh:resultPath"), constraint.shape.path); // TODO: Make deep copy
            }
            if (obj.value) {
                this.addResultProperty(result, T("sh:value"), obj.value);
            } else if (valueNode) {
                this.addResultProperty(result, T("sh:value"), valueNode);
            }
            if (obj.message) {
                this.addResultProperty(result, T("sh:resultMessage"), TermFactory.literal(obj.message, T("xsd:string")));
            } else {
                this.createResultMessages(result, constraint);
            }
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
ValidationEngine.prototype.validateAll = async function (rdfDataGraph) {
    if (this.maxErrorsReached()) {
        return true;
    } else {
        this.results = [];
        let foundError = false;
        const shapes = this.context.shapesGraph.getShapesWithTarget();
        for (let i = 0; i < shapes.length; i++) {
            const shape = shapes[i];
            const focusNodes = shape.getTargetNodes(rdfDataGraph);
            const asyncValidations = focusNodes.map((focusNode) => this.validateNodeAgainstShape(focusNode, shape, rdfDataGraph, true));
            const results = await Promise.all(asyncValidations);
            results.forEach((result) => {
                foundError = foundError || result
            })
        }
        return foundError;
    }
};

/**
 * Returns true if any violation has been found
 */
ValidationEngine.prototype.validateNodeAgainstShape = async function (focusNode, shape, rdfDataGraph, topLevel) {
    if (this.maxErrorsReached()) {
        return true;
    } else {
        if (shape.deactivated) {
            return false;
        }
        const constraints = shape.getConstraints();
        const valueNodes = shape.getValueNodes(focusNode, rdfDataGraph);
        const results = constraints.map((constraint) => {
            return this.validateNodeAgainstConstraint(focusNode, valueNodes, constraint, rdfDataGraph, topLevel);
        });
        const result = await Promise.all(results).then((results) => {
            let foundError = false;
            results.forEach((result) => foundError = foundError || result);
            return foundError
        });
        return result;
    }
};

ValidationEngine.prototype.validateNodeAgainstConstraint = async function (focusNode, valueNodes, constraint, rdfDataGraph, topLevel) {
    if (this.maxErrorsReached()) {
        return true;
    } else {
        if (T("sh:PropertyConstraintComponent").equals(constraint.component.node)) {
            var errorFound = false;
            for (var i = 0; i < valueNodes.length; i++) {
                if (await this.validateNodeAgainstShape(valueNodes[i], this.context.shapesGraph.getShape(constraint.paramValue), rdfDataGraph, topLevel)) {
                    errorFound = true;
                }
            }
            return errorFound;
        }
        if (T("sh:SPARQLConstraintComponent").equals(constraint.component.node)) {
            return await new Promise((resolve, reject) => {
                for (let i=0; i<valueNodes.length; i++) {
                    const valueNode = valueNodes[i];
                    constraint.validateSparql(valueNode, rdfDataGraph, (err, data) => {
                        if (err) {
                            reject(err);
                        } else {
                            try {
                                let foundError = false;
                                data.forEach((result) => {
                                    const failureNode = result.get("?failure") || result.get("$failure");
                                    if (!(failureNode && failureNode.value === "true" && failureNode.datatype.equals(T("xsd:boolean")))) {
                                        let valueNode = result.get("?value") || result.get("$value");
                                        let path = result.get("?path") || result.get("$path");
                                        if (valueNode) {
                                            foundError = true;
                                            const result = {
                                                value: valueNode.id,
                                                path: (path != null) ? path.value : null
                                            };
                                            this.createResultFromObject(result, constraint, focusNode, valueNode, topLevel);
                                        } else {
                                            this.createResultFromObject(null, constraint, focusNode, valueNode, topLevel);
                                        }
                                    } else {
                                        reject(new Error("Failure variable returned true in SPARQL query for shape <" + constraint.shape.shapeNode + ">"));
                                    }
                                });
                                resolve(foundError)
                            } catch (e) {
                                reject(e);
                            }
                        }
                    });
                }
            })
        }
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
                    let individualValidations = [];
                    for (i = 0; i < valueNodes.length; i++) {
                        if (this.maxErrorsReached()) {
                            break;
                        }
                        var valueNode = valueNodes[i];
                        let prom = validationFunction.execute(focusNode, valueNode, constraint);
                        if (prom.then == null) {
                            const promValue = prom;
                            prom = new Promise((resolve, reject) => resolve(promValue));
                        }
                       individualValidations.push(prom.then((obj) => {
                            var iterationError = false;
                            if (Array.isArray(obj)) {
                                for (a = 0; a < obj.length; a++) {
                                    if (this.createResultFromObject(obj[a], constraint, focusNode, valueNode, topLevel))  {
                                        iterationError = true;
                                    }
                                }
                            }
                            else {
                                if (this.createResultFromObject(obj, constraint, focusNode, valueNode, topLevel)) {
                                    iterationError = true;
                                }
                            }
                            return iterationError;
                        }));
                    }
                    await Promise.all(individualValidations).then((results) => {
                        for (var i=0; i<results.length; i++) {
                            if (results[i]) {
                                this.violationsCount++;
                            }
                            errorFound = errorFound || results[i];
                        }
                    });

                    return errorFound;
                }
                else {
                    prom = validationFunction.execute(focusNode, null, constraint);
                    if (prom.then == null) {
                        const promValue = prom
                        prom = new Promise((resolve, reject) => resolve(promValue));
                    }
                    return await prom.then((obj) => {
                        if (Array.isArray(obj)) {
                            var errorFound = false;
                            for (var a = 0; a < obj.length; a++) {
                                if (this.createResultFromObject(obj[a], constraint, focusNode, null, topLevel)) {
                                    errorFound = true;
                                }
                            }
                            return errorFound;
                        }
                        else {
                            if (this.createResultFromObject(obj, constraint, focusNode, null, topLevel)) {
                                return true;
                            }
                        }
                    });
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