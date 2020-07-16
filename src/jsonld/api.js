'use strict';
const {expand: _expand} = require('./expand');
const {flatten: _flatten} = require('./flatten');
const util = require("./util");
const IdentifierIssuer = util.IdentifierIssuer;
const {
    isSubjectReference: _isSubjectReference
} = require('./graphTypes');

const {
    createMergedNodeMap: _createMergedNodeMap
} = require('./nodeMap');
const {
    expandIri: _expandIri,
    getInitialContext: _getInitialContext,
    process: _processContext,
    processingMode: _processingMode
} = require('./context');
const {
    compact: _compact,
    compactIri: _compactIri
} = require('./compact');
const {
    isArray: _isArray,
    isObject: _isObject,
    isString: _isString
} = require('./types');
const ContextResolver = require('./ContextResolver');
const LRU = require('lru-cache');

const api = {};
module.exports = api;

function _setDefaults(options,defaults) {
    return Object.assign({}, defaults, options);
}
const RESOLVED_CONTEXT_CACHE_MAX_SIZE = 100;
const _resolvedContextCache = new LRU({max: RESOLVED_CONTEXT_CACHE_MAX_SIZE});

api.expand = function(input, options) {
    if(arguments.length < 1) {
        throw new TypeError('Could not expand, too few arguments.');
    }

    // set default options
    options = _setDefaults(options, {
        keepFreeFloatingNodes: false,
        contextResolver: new ContextResolver(
            {sharedCache: _resolvedContextCache})
    });
    if(options.expansionMap === false) {
        options.expansionMap = undefined;
    }

    // build set of objects that may have @contexts to resolve
    const toResolve = {};

    // build set of contexts to process prior to expansion
    const contextsToProcess = [];

    // if an `expandContext` has been given ensure it gets resolved
    if('expandContext' in options) {
        const expandContext = util.clone(options.expandContext);
        if(_isObject(expandContext) && '@context' in expandContext) {
            toResolve.expandContext = expandContext;
        } else {
            toResolve.expandContext = {'@context': expandContext};
        }
        contextsToProcess.push(toResolve.expandContext);
    }

    // if input is a string, attempt to dereference remote document
    let defaultBase;
    if(!_isString(input)) {
        // input is not a URL, do not need to retrieve it first
        toResolve.input = util.clone(input);
    } else {
        throw new Error('Cannot process remote docs');
    }

    // set default base
    if(!('base' in options)) {
        options.base = defaultBase || '';
    }

    // process any additional contexts
    let activeCtx = _getInitialContext(options);
    for(const localCtx of contextsToProcess) {
        activeCtx = _processContext({activeCtx, localCtx, options});
    }

    // expand resolved input
    let expanded = _expand({
        activeCtx,
        element: toResolve.input,
        options,
        expansionMap: options.expansionMap
    });

    // optimize away @graph with no other properties
    if(_isObject(expanded) && ('@graph' in expanded) &&
        Object.keys(expanded).length === 1) {
        expanded = expanded['@graph'];
    } else if(expanded === null) {
        expanded = [];
    }

    // normalize to an array
    if(!_isArray(expanded)) {
        expanded = [expanded];
    }

    return expanded;
}

api.flatten = function(input, ctx, options) {
    if(arguments.length < 1) {
        return new TypeError('Could not flatten, too few arguments.');
    }

    if(typeof ctx === 'function') {
        ctx = null;
    } else {
        ctx = ctx || null;
    }

    // set default options
    options = _setDefaults(options, {
        base: _isString(input) ? input : '',
        contextResolver: new ContextResolver(
            {sharedCache: _resolvedContextCache})
    });

    // expand input
    const expanded = api.expand(input, options);

    // do flattening
    const flattened = _flatten(expanded);

    if(ctx === null) {
        // no compaction required
        return flattened;
    }

    // compact result (force @graph option to true, skip expansion)
    options.graph = true;
    options.skipExpansion = true;
    return api.compact(flattened, ctx, options);
};

api.compact = function(input, ctx, options) {
    if(arguments.length < 2) {
        throw new TypeError('Could not compact, too few arguments.');
    }

    if(ctx === null) {
        throw new JsonLdError(
            'The compaction context must not be null.',
            'jsonld.CompactError', {code: 'invalid local context'});
    }

    // nothing to compact
    if(input === null) {
        return null;
    }

    // set default options
    options = _setDefaults(options, {
        base: _isString(input) ? input : '',
        compactArrays: true,
        compactToRelative: true,
        graph: false,
        skipExpansion: false,
        link: false,
        issuer: new IdentifierIssuer('_:b'),
        contextResolver: new ContextResolver(
            {sharedCache: _resolvedContextCache})
    });
    if(options.link) {
        // force skip expansion when linking, "link" is not part of the public
        // API, it should only be called from framing
        options.skipExpansion = true;
    }
    if(!options.compactToRelative) {
        delete options.base;
    }

    // expand input
    let expanded;
    if(options.skipExpansion) {
        expanded = input;
    } else {
        expanded = api.expand(input, options);
    }

    // process context
    const activeCtx = jsonld.processContext(
        _getInitialContext(options), ctx, options);

    // do compaction
    let compacted = _compact({
        activeCtx,
        element: expanded,
        options,
        compactionMap: options.compactionMap
    });

    // perform clean up
    if(options.compactArrays && !options.graph && _isArray(compacted)) {
        if(compacted.length === 1) {
            // simplify to a single item
            compacted = compacted[0];
        } else if(compacted.length === 0) {
            // simplify to an empty object
            compacted = {};
        }
    } else if(options.graph && _isObject(compacted)) {
        // always use array if graph option is on
        compacted = [compacted];
    }

    // follow @context key
    if(_isObject(ctx) && '@context' in ctx) {
        ctx = ctx['@context'];
    }

    // build output context
    ctx = util.clone(ctx);
    if(!_isArray(ctx)) {
        ctx = [ctx];
    }
    // remove empty contexts
    const tmp = ctx;
    ctx = [];
    for(let i = 0; i < tmp.length; ++i) {
        if(!_isObject(tmp[i]) || Object.keys(tmp[i]).length > 0) {
            ctx.push(tmp[i]);
        }
    }

    // remove array if only one context
    const hasContext = (ctx.length > 0);
    if(ctx.length === 1) {
        ctx = ctx[0];
    }

    // add context and/or @graph
    if(_isArray(compacted)) {
        // use '@graph' keyword
        const graphAlias = _compactIri({
            activeCtx, iri: '@graph', relativeTo: {vocab: true}
        });
        const graph = compacted;
        compacted = {};
        if(hasContext) {
            compacted['@context'] = ctx;
        }
        compacted[graphAlias] = graph;
    } else if(_isObject(compacted) && hasContext) {
        // reorder keys so @context is first
        const graph = compacted;
        compacted = {'@context': ctx};
        for(const key in graph) {
            compacted[key] = graph[key];
        }
    }

    return compacted;
};
