// class ValidationFunction
var RDFQuery = require("./rdfquery");
var debug = require("debug")("validation-function");
var tracer = require("./trace")
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
    try {
        return this.func.apply(globalObject, args);
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
                namedParams[arg] = value.id;
            } else {
                namedParams[arg] = null;
            }
        }
        else if (arg === "focusNode") {
            args.push(focusNode);
            if (focusNode != null) {
                namedParams["focusNode"] = focusNode.id;
            }
        }
        else if (arg === "value") {
            if (valueNode != null) {
                namedParams["$value"] = valueNode.id;
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

module.exports = ValidationFunction;