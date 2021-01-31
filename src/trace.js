
const DEBUG_TRACE = false;

const functionsTargetShapes = {
    validateIn: "in"
}

var Tracer = function() {
    this.shouldTrace = false;
    // map from source shape to target nodes
    this.targets = {}
    this.roots = {};
    this.logs = [];
    this.idCounter = 0;
}

Tracer.prototype.withTracing = function(shouldTrace) {
    this.shouldTrace = shouldTrace;
}

Tracer.prototype.mark = function(nodes) {
    if (Array.isArray(nodes)) {
        nodes.forEach((n) => {
            if (n.__TRACER_ID == null) {
                this.idCounter++;
                n.__TRACER_ID = "_tracer_"+ this.idCounter;
            }
        });
    }
}

Tracer.prototype.reset = function() {
    this.logs = [];
    this.idCounter = 0;
    this.roots = {};
    this.targets = {}
}

Tracer.prototype.setTargets = function(shapeId, targets, reason, selector, argument) {
    if (this.shouldTrace) {
        this.mark(targets)
        const targetIds = targets.map((n) => {
            const id = n.value
            const tracerId = n.__TRACER_ID
            return {
                id: id,
                tracerId: tracerId
            }
        });
        if (DEBUG_TRACE) {
            console.log("** SET TARGETS")
            console.log(" - SHAPE: " + shapeId);
            console.log(" - SELECTOR TYPE " + selector);
            if (argument) {
                console.log(" - ARGUMENT " + argument);
            }
            console.log(" - TARGETS: " + JSON.stringify(targetIds));
            console.log(" - REASON: " + reason);
        }
        let shapeTargets = this.targets[shapeId] || []
        shapeTargets.push({targets: targetIds, reason: reason, selector: selector, argument: argument})
        this.targets[shapeId] = shapeTargets;
    }
}

Tracer.prototype.setRootShape = function(shapeId) {
    if (this.shouldTrace) {
        if (DEBUG_TRACE) {
            console.log("** SET ROOT SHAPE")
            console.log(" - SHAPE: " + shapeId);
        }
        this.roots[shapeId.value] = true;
    }
}

Tracer.prototype.log = function(shapeId, focusNodeId, tracerId, type, reason) {
    if (this.shouldTrace) {
        let actualFocusNodeId = focusNodeId.toString()
        if (DEBUG_TRACE) {
            console.log("** LOG [" + type + "]");
            console.log("  - SHAPE: " + shapeId);
            console.log("  - FOCUS: " + actualFocusNodeId);
            console.log("  - TRACER_ID: " + tracerId);
            console.log("  - REASON: " + JSON.stringify(reason));
        }
        if (type === "FUNCTION-EVALUATION" && reason && reason.result && reason.result.then) {
            reason.result.then((actualResult) => {
                reason.result = actualResult;
                this.logs.push({
                    shapeId: shapeId.toString(),
                    focusNodeId: actualFocusNodeId,
                    tracerId: tracerId,
                    type: type,
                    reason: reason
                });
            })
        } else {
            this.logs.push({
                shapeId: shapeId.toString(),
                focusNodeId: actualFocusNodeId,
                tracerId: tracerId,
                type: type,
                reason: reason
            });
        }
    }
}

Tracer.prototype.frames = function() {
    var acc = [];
    Object.keys(this.roots).forEach((rootShapeId) => {
        const targets = this.targets[rootShapeId];
        acc.push(this.buildFrames(rootShapeId, targets, 0));
    });

    return acc;
};

Tracer.prototype.buildFrames = function(shapeId, targetGroups, level) {
    let nestedShape = targetGroups.map((targets) => {
        const focusNodes = targets.targets;
        const reason = targets.reason;
        const nested = focusNodes.map((focusNode) => {
            return this.buildFrame(shapeId, focusNode, level+2, []);
        });
        return {
            shapeId: shapeId,
            focusNode: "",
            type: "target-selection",
            message: "Selecting targets by " + reason + " => " + focusNodes.length + " nodes found",
            targetValues: focusNodes,
            nested: nested,
            level: level + 1,
            explanation: {
                selector:targets.selector,
                argument: targets.argument
            },
            error: this.computeStatus(nested)
        }
    });
    return {
        shapeId: shapeId,
        focusNode: "",
        type: "top-level-shape",
        message: "Evaluating shape " + shapeId,
        targetValues: [],
        nested: nestedShape,
        level: level,
        error: this.computeStatus(nestedShape)
    }
};

Tracer.prototype.buildFrame = function(shapeId, focusNode, level, acc) {
    if (focusNode.tracerId == null) {
        throw new Error("Frame without tracerId");
    }
    let key = shapeId + "::" + focusNode.tracerId;
    if (acc.find((k) => k === key)) {
        return {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "node-recursion",
            message: "Recursive evaluation",
            nested: [],
            level: level,
            error: false
        }
    }
    acc = acc.concat([key])

    const logs = this.logs.filter((log) => {
        return log.shapeId === shapeId && log.tracerId === focusNode.tracerId;
    });
    const deactivated = logs.find((l) => l.type === "DEACTIVATED")
    if (deactivated) {
        return {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "deactivated",
            message: deactivated.reason,
            nested: [],
            level: level,
            error: false
        }
    }

    const functions = logs.filter((l) => l.type === "FUNCTION-EVALUATION");
    const functionFrames = functions.map((fl) => {
        return this.buildFunctionFrame(shapeId, focusNode, fl, level+1, acc)
    });

    const lbranches = logs.filter((l) => l.type === "BRANCH")
    const lpath = logs.find((l) => l.type === "PATH-SELECTION" );
    const lsparql = logs.find((l) => l.type === "SPARQL-QUERY")

    if (lbranches.length > 0 && lpath != null) {
        throw new Error("BRANCH AND PATH AT THE SAME TIME!")
    }
    if (lsparql != null) {
        let lsparqlResult= logs.find((l) => l.type === "SPARQL-QUERY-RESULT" && l.shapeId === lsparql.shapeId && l.tracerId === lsparql.tracerId)
        return {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "sparql",
            message: "Executing a SPARQL based validation",
            query: lsparql.reason.text,
            "query-results": lsparql.reason.results,
            nested: [],
            level: level,
            error: lsparqlResult.reason.error
        }
    } else if (lbranches.length > 0 || lpath == null) {
        // branching frame of a node shape
        const nested = lbranches.map((lbranch) => {
            const constraintShape = lbranch.reason.constraint;
            //const branchTarget = {id: lbranch.reason.value.id, tracerId: lbranch.reason.value.__TRACER_ID};
            const branchTarget = {id: lbranch.focusNodeId, tracerId: lbranch.tracerId};
            return this.buildFrame(constraintShape, branchTarget, level+2, acc)
        });
        const propertiesFrame = {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "properties",
            message: "Evaluating nested property constraints",
            nested: nested,
            level: level+1,
            error: this.computeStatus(nested)
        };

        let nestedFrames = functionFrames;
        if (propertiesFrame.nested.length > 0) {
            nestedFrames.push(propertiesFrame)
        }

        return {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "node",
            message: "Evaluating target node " + focusNode.id,
            nested: nestedFrames,
            level: level,
            error: this.computeStatus(nestedFrames)
        };

    } else if (lpath) {
        // property selection frame of a property constraint
        const path = lpath.reason.path;
        const targets = lpath.reason.target;
        let nested = functionFrames;
        const nestedValues = targets.map((target) => {
            const pathTarget = {id: target.id, tracerId: target.__TRACER_ID};
            return this.buildFrame(shapeId, pathTarget, level + 1, acc)
        });
        nested = nested.concat(nestedValues.filter((n) => n.nested.length > 0))

        return {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "path",
            message: "Selecting target " + targets.length + " values for path",
            path: path,
            targetValues: targets,
            nested: nested,
            level: level,
            error: this.computeStatus(nested)
        };
    } else {
        throw new Error("Should not reach here")
    }
}

Tracer.prototype.buildFunctionFrame = function(shapeId, focusNode, functionLog, level, acc) {
    if (functionLog.reason.function === "validateNode") {
        const nodeTargetShape = functionLog.reason.args.node;
        const nextValueNode = {id: functionLog.reason.valueNode.id, tracerId: functionLog.reason.valueNode.__TRACER_ID}
        const nested = this.buildFrame(nodeTargetShape, nextValueNode, level, acc)
        return {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "shape",
            message: "Evaluating shape",
            nested: nested.nested,
            level: level - 1,
            error: !functionLog.reason.result
        }
    } else if (functionLog.reason.function === "validateQualifiedMinCountProperty" || functionLog.reason.function === "validateQualifiedMaxCountProperty") {
        const name = functionLog.reason.function === "validateQualifiedMinCountProperty" ? "minCount" : "maxCount";
        const tracerId = functionLog.tracerId;
        const branches = this.logs.filter((l) => l.type === "QUALIFIED-BRANCH" && l.reason.$this.__TRACER_ID === tracerId);
        const nested = branches.map((br) => {
            const brResult = this.logs.find((l) => l.type === "QUALIFIED-BRANCH-RESULT" && l.shapeId === br.shapeId && l.focusNodeId === br.focusNodeId && l.reason.$this.__TRACER_ID === br.reason.$this.__TRACER_ID);
            const nestedFrame = this.buildFrame(br.shapeId, {id: br.focusNodeId, tracerId: br.tracerId}, level + 1, acc)
            nestedFrame.result = this.computeError(brResult);
            return nestedFrame;
        });
        const args = functionLog.reason.args || {};
        args["qualifiedCount"] = args.qualifiedMinCount || args.qualifiedMaxCount;
        args["qualification"] = name;
        return {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "qualified",
            message: "evaluating qualified " + name,
            args: args,
            nested: nested,
            level: level,
            error: !functionLog.reason.result
        }
    } else if (functionLog.reason.function === "validateNot") {
        const notTargetShape = functionLog.reason.args.not;
        const nextValueNode = {id: functionLog.reason.valueNode.id, tracerId: functionLog.reason.valueNode.__TRACER_ID}
        const nested = this.buildFrame(notTargetShape, nextValueNode, level, acc)
        return {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "not",
            message: "Evaluating not",
            nested: nested.nested,
            level: level,
            error: !functionLog.reason.result
        }
    } else if (functionLog.reason.function === "validateAnd") {
        const andShape = functionLog.reason.args.and;
        const andTarget = functionLog.reason.args.$value;
        const andTargetValueNode = functionLog.reason.valueNode.__TRACER_ID
        const branches = this.logs.filter((l) => l.type === "AND-BRANCH" && l.reason.and === andShape && (l.tracerId === andTargetValueNode || l.focusNodeId === andTarget));
        const nested = branches.map((br) => {
            const brResult = this.logs.find((l) => l.type === "AND-BRANCH-RESULT" && l.shapeId === br.shapeId && l.focusNodeId === br.focusNodeId && l.reason.and === br.reason.and);
            const nestedFrame = this.buildFrame(br.shapeId, {id: br.focusNodeId, tracerId: br.tracerId}, level + 1, acc)
            nestedFrame.result = this.computeError(brResult);
            return nestedFrame;
        });
        return {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "and",
            message: "Evaluating AND",
            nested: nested,
            level: level,
            error: !functionLog.reason.result
        }
    } else if (functionLog.reason.function === "validateOr") {
        const orShape = functionLog.reason.args.or;
        const orTarget = functionLog.reason.args.$value;
        const orTargetValueNode = functionLog.reason.valueNode.__TRACER_ID
        const branches = this.logs.filter((l) => l.type === "OR-BRANCH" && l.reason.or === orShape && (l.tracerId === orTargetValueNode || l.focusNodeId === orTarget));
        const nested = branches.map((br) => {
            const brResult = this.logs.find((l) => l.type === "OR-BRANCH-RESULT" && l.shapeId === br.shapeId && l.focusNodeId === br.focusNodeId && l.reason.or === br.reason.or);
            const nestedFrame = this.buildFrame(br.shapeId, {id: br.focusNodeId, tracerId: br.tracerId}, level + 1, acc)
            nestedFrame.result = this.computeError(brResult);
            return nestedFrame;
        });
        return {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "or",
            message: "Evaluating OR",
            nested: nested,
            level: level,
            error: !functionLog.reason.result
        }
    } else if (functionLog.reason.function === "validateXone") {
        const xoneShape = functionLog.reason.args.xone;
        const xoneTarget = functionLog.reason.args.$value;
        const xoneTargetValueNode = functionLog.reason.valueNode.__TRACER_ID
        const branches = this.logs.filter((l) => l.type === "XONE-BRANCH" && l.reason.xone === xoneShape && (l.tracerId === xoneTargetValueNode || l.focusNodeId === xoneTarget));
        const nested = branches.map((br) => {
            const brResult = this.logs.find((l) => l.type === "XONE-BRANCH-RESULT" && l.shapeId === br.shapeId && l.focusNodeId === br.focusNodeId && l.reason.xone === br.reason.xone);
            const nestedFrame = this.buildFrame(br.shapeId, {id: br.focusNodeId, tracerId: br.tracerId}, level + 1, acc)
            nestedFrame.result = this.computeError(brResult);
            return nestedFrame;
        });
        return {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "xone",
            message: "Evaluating XONE",
            nested: nested,
            level: level,
            error: !functionLog.reason.result
        }
    } else {
        let explanation;
        let explanationShapeArg = functionsTargetShapes[functionLog.reason.function];
        if (explanationShapeArg) {
            const explainedShape = functionLog.reason.args[explanationShapeArg];
            const targetValueNode = functionLog.reason.valueNode.__TRACER_ID
            explanation = this.logs.find((l) => l.type === "EXPLANATION" && l.shapeId === explainedShape && l.tracerId === targetValueNode);
            if (explanation) {
                explanation = explanation.reason;
            }
        }
        if (explanation == null && Array.isArray(functionLog.reason.result) && functionLog.reason.result.length>0) {
            explanation = functionLog.reason.result
        }

        return {
            shapeId: shapeId,
            focusNode: focusNode,
            type: "function",
            message: "Evaluating function " + functionLog.reason.function,
            function: functionLog.reason.function,
            explanation: explanation,
            nested: [],
            args: functionLog.reason.args,
            result: functionLog.reason.result,
            level: level,
            error: !functionLog.reason.result
        }
    }
};

Tracer.prototype.computeError = function(log) {
    let error = (log.reason.result === false);
    if (Array.isArray(log.reason.result) && log.reason.result.length > 0){
        error = true;
    }

    if (Array.isArray(log.reason.result) === false && typeof(log.reason.result) === "object" && Object.keys(log.reason.result).length > 0) {
        error = true;
    }

    return error;
}

Tracer.prototype.computeStatus = function(frames) {
    let error = false;
    frames.forEach((f) => {
        error = error || f.error
    });

    return error;
}

Tracer.prototype.computeOrStatus = function(frames) {
    let error = true;
    frames.forEach((f) => {
        error = error && f.error
    });

    return error;
}

Tracer.prototype.printFrames = function() {
    try {
        const rendered = this.renderFrames();
        rendered.forEach((f) => console.log(f));
    } catch (e) {
        console.log(e);
    }
}

Tracer.prototype.renderFrames = function() {
    try {
        const frames = this.frames();
        let rendered = [];
        frames.forEach((f) => {
            rendered = rendered.concat(this.renderFrame(f));
        });
        return rendered;
    } catch (e) {
        console.log(e);
    }
}

Tracer.prototype.renderFrame = function(frame) {
    let acc = [];
    let margin = "";
    for (let i=0; i<frame.level; i++) {
        margin = margin + "  "
    }
    if (frame.level > 0) {
        acc.push(margin + "|");
        acc.push(margin + "-> Shape: " + frame.shapeId);
        margin = margin + "   ";


    } else {
        acc.push(margin + "+ Shape: " + frame.shapeId);
        margin = margin + "  ";
    }

    acc.push(margin + "[" + frame.type + "]");

    if (frame.focusNode) {
        acc.push(margin + "Target: " + frame.focusNode.id)
        acc.push(margin + "TracerId: " + frame.focusNode.tracerId)
    }
    acc.push(margin + frame.message);
    if (frame.args) {
        acc.push(margin + "Args: " + JSON.stringify(frame.args))
    }
    if (frame.path) {
        acc.push(margin + "Path: " + JSON.stringify(this.renderPath(frame.path)))
    }
    if (frame.targetValues) {
        acc.push(margin + "Selected: " + JSON.stringify(frame.targetValues))
    }
    if (frame.explanation) {
        acc.push(margin + "Explanation: " + JSON.stringify(frame.explanation))
    }

    if (frame.query) {
        acc.push(margin + "Query:")
        frame.query.split("\n").forEach((l) => {
            acc.push(margin + "   " + l)
        })
        acc.push(margin + "Results: " + JSON.stringify(frame['query-results']))
    }

    acc.push(margin + "Error? " + frame.error);
    (frame.nested || []).forEach((f) => {
        acc = acc.concat(this.renderFrame(f));
    });
    return acc;
}

Tracer.prototype.renderPath = function(path) {
    if (Array.isArray(path)) {
        return path.map((p) => this.renderPath(p))
    } else if (typeof(path) === "object") {
        if (path.id != null) {
            return path.id;
        } else {
            let acc = {}
            for (var k in path) {
                acc[k] = this.renderPath(path[k])
            }
            return acc;
        }
    } else {
        return path;
    }
}
const tracerSingleton = new Tracer();

module.exports = tracerSingleton;