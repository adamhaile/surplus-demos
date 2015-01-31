(function (package) {
    // nano-implementation of require.js-like define(name, deps, impl) for internal use
    var definitions = {};

    package(function define(name, deps, fn) {
        if (definitions.hasOwnProperty(name)) throw new Error("define: cannot redefine module " + name);
        definitions[name] = fn.apply(null, deps.map(function (dep) {
            if (!definitions.hasOwnProperty(dep)) throw new Error("define: module " + dep + " required by " + name + " has not been defined.");
            return definitions[dep];
        }));
    });

    if (typeof module === 'object' && typeof module.exports === 'object') module.exports = definitions.S; // CommonJS
    else if (typeof define === 'function') define([], function () { return definitions.S; }); // AMD
    else this.S = definitions.S; // fallback to global object

})(function (define) {
    "use strict";

define('graph', [], function () {

    function Overseer() {
        this.count = 1;
        this.target = null;
        this.generating = false;
        this.deferred = [];
    }

    Overseer.prototype = {
        reportReference: function reportReference(src) {
            if (this.target) this.target.addSource(src);
        },
        reportFormula: function reportFormula(dispose) {
            if (this.target) {
                (this.generating ? this.target.finalizers : this.target.cleanups).push(dispose);
            }
        },
        runWithTarget: function runWithTarget(fn, target) {
            if (target.updating) return;

            var oldTarget, result;

            oldTarget = this.target, this.target = target;

            target.beginUpdate();
            target.updating = true;

            result = this.runWithTargetInner(fn, oldTarget);

            target.endUpdate();

            return result;
        },
        // Chrome can't optimize a function with a try { } statement, so we move
        // the minimal set of needed ops into a separate function.
        runWithTargetInner: function runWithTargetInner(fn, oldTarget) {
            try {
                return fn();
            } finally {
                this.target.updating = false;
                this.target = oldTarget;
            }
        },
        peek: function runWithoutListening(fn) {
            var oldListening;

            if (this.target) {
                oldListening = this.target.listening, this.target.listening = false;

                try {
                    return fn();
                } finally {
                    this.target.listening = oldListening;
                }
            } else {
                return fn();
            }
        },
        runDeferred: function runDeferred() {
            if (!this.target) {
                while (this.deferred.length !== 0) {
                    this.deferred.shift()();
                }
            }
        }
    };

    function Source(recorder) {
        this.id = recorder.count++;
        this.lineage = recorder.target ? recorder.target.lineage : [];

        this.updates = [];
    }

    Source.prototype = {
        propagate: function propagate() {
            var i, u, us = this.updates;

            for (i = 0; i < us.length; i++) {
                u = us[i];
                if (u) u();
            }
        }
    };

    function Target(update, options, recorder) {
        var i, l;

        this.lineage = recorder.target ? recorder.target.lineage.slice(0) : [];
        this.lineage.push(this);
        this.mod = options.update;
        this.updaters = [];

        this.updating = false;
        this.listening = true;
        this.generator = !!options.generator;
        this.gen = 1;
        this.dependencies = [];
        this.dependenciesIndex = {};
        this.cleanups = [];
        this.finalizers = [];

        for (i = this.lineage.length - 1; i >= 0; i--) {
            l = this.lineage[i];
            if (l.mod) update = l.mod(update);
            this.updaters[i] = update;
        }

        if (options.sources) {
            recorder.runWithTarget(function () {
                for (var i = 0; i < options.sources.length; i++)
                    options.sources[i]();
            }, this);

            this.listening = false;
        }
    }

    Target.prototype = {
        beginUpdate: function beginUpdate() {
            this.cleanup();
            this.gen++;
        },
        endUpdate: function endUpdate() {
            if (!this.listening) return;

            var i, dep;

            for (i = 0; i < this.dependencies.length; i++) {
                dep = this.dependencies[i];
                if (dep.active && dep.gen < this.gen) {
                    dep.deactivate();
                }
            }
        },
        addSource: function addSource(src) {
            if (!this.listening) return;

            var dep = this.dependenciesIndex[src.id];

            if (dep) {
                dep.activate(this.gen);
            } else {
                new Dependency(this, src);
            }
        },
        addChild: function addChild(disposeChild) {
            (this.generator ? this.finalizers : this.cleanups).push(disposeChild);
        },
        cleanup: function cleanup() {
            for (var i = 0; i < this.cleanups.length; i++) {
                this.cleanups[i]();
            }
            this.cleanups = [];
        },
        dispose: function dispose() {
            var i;

            for (i = 0; i < this.finalizers.length; i++) {
                this.finalizers[i]();
            }
            for (i = this.dependencies.length - 1; i >= 0; i--) {
                this.dependencies[i].deactivate();
            }
        }
    };

    function Dependency(target, src) {
        this.active = true;
        this.gen = target.gen;
        this.updates = src.updates;
        this.offset = src.updates.length;

        // set i to the point where the lineages diverge
        for (var i = 0, len = Math.min(target.lineage.length, src.lineage.length);
            i < len && target.lineage[i] === src.lineage[i];
            i++);

        this.update = target.updaters[i];
        this.updates.push(this.update);

        target.dependencies.push(this);
        target.dependenciesIndex[src.id] = this;
    }

    Dependency.prototype = {
        activate: function activate(gen) {
            if (!this.active) {
                this.active = true;
                this.updates[this.offset] = this.update;
            }
            this.gen = gen;
        },
        deactivate: function deactivate() {
            if (this.active) {
                this.updates[this.offset] = null;
            }
            this.active = false;
        }
    };

    return {
        Overseer: Overseer,
        Source: Source,
        Target: Target,
        Dependency: Dependency
    };
});

define('S', ['graph'], function (graph) {
    var os = new graph.Overseer();

    // add methods to S
    S.data     = data;
    S.peek     = peek;
    S.defer    = defer;
    S.proxy    = proxy;
    S.cleanup  = cleanup;
    S.finalize = finalize;
    S.generator = generator;
    S.toJSON   = toJSON;

    return S;

    function data(value) {
        if (value === undefined)
            throw new Error("S.data can't be initialized with undefined.  In S, undefined is reserved for namespace lookup failures.");

        var src = new graph.Source(os);

        data.toString = dataToString;

        if (Array.isArray(value)) arrayify(data);

        return data;

        function data(newValue) {
            if (arguments.length > 0) {
                if (newValue === undefined)
                    throw new Error("S.data can't be set to undefined.  In S, undefined is reserved for namespace lookup failures.");
                value = newValue;
                src.propagate();
                os.runDeferred();
            } else {
                os.reportReference(src);
            }
            return value;
        }
    }

    function S(fn, options) {
        options = options || {};

        var src = new graph.Source(os),
            tgt = new graph.Target(update, options, os),
            value;

        // register dispose before running fn, in case it throws
        os.reportFormula(dispose);

        formula.dispose = dispose;
        formula.toString = toString;

        (options.init ? options.init(update) : update)();

        os.runDeferred();

        return formula;

        function formula() {
            os.reportReference(src);
            return value;
        }

        function update() {
            os.runWithTarget(updateInner, tgt);
        }

        function updateInner() {
            var newValue = fn();

            if (newValue !== undefined) {
                value = newValue;
                src.propagate();
            }
        }

        function dispose() {
            tgt.cleanup();
            tgt.dispose();
        }

        function toString() {
            return "[formula: " + (value !== undefined ? value + " - " : "") + fn + "]";
        }
    }

    function dataToString() {
        return "[data: " + S.peek(this) + "]";
    }

    function peek(fn) {
        return os.peek(fn);
    }

    function defer(fn) {
        if (os.target) {
            os.deferred.push(fn);
        } else {
            fn();
        }
    }

    function cleanup(fn) {
        if (os.target) {
            os.target.cleanups.push(fn);
        } else {
            throw new Error("S.cleanup() must be called from within an S.formula.  Cannot call it at toplevel.");
        }
    }

    function finalize(fn) {
        if (os.target) {
            os.target.finalizers.push(fn);
        } else {
            throw new Error("S.finalize() must be called from within an S.formula.  Cannot call it at toplevel.");
        }
    }

    function proxy(getter, setter) {
        return function proxy(value) {
            if (arguments.length !== 0) setter(value);
            return getter();
        };
    }

    function generator(fn) {
        var result;

        if (os.target && !os.generating) {
                result = fn();
            } else {
                try {

                } finally {

                }

            }
        }
        var oldGenerating;

        oldGenerator = os.generator, os.generator = generator;
        if (os.target) os.target.finalizers.push(dispose);

        try {
            fn();
        } finally {
            os.generator = oldGenerator;
        }

        return dispose;

        function dispose() {
            var i;

            for (i = 0; i < generator.length; i++) {
                generator[i]();
            }

            generator = [];
        }
    }

    function toJSON(o) {
        return JSON.stringify(o, function (k, v) {
            return (typeof v === 'function') ? v() : v;
        });
    }

    function arrayify(s) {
        s.push    = push;
        s.pop     = pop;
        s.shift   = shift;
        s.unshift = unshift;
        s.splice  = splice;
        s.remove  = remove;
    }

    function push(v)         { var l = peek(this); l.push(v);     this(l); return v; }
    function pop()           { var l = peek(this), v = l.pop();   this(l); return v; }
    function shift()         { var l = peek(this), v = l.shift(); this(l); return v; }
    function unshift(v)      { var l = peek(this); l.unshift(v);  this(l); return v; }
    function splice(/*...*/) { var l = peek(this), v = l.splice.apply(l, arguments); this(l); return v;}
    function remove(v)       { var l = peek(this), i = l.indexOf(v); if (i !== -1) { l.splice(i, 1); this(l); return v; } }
});

define('schedulers', ['S'], function (S) {

    var _S_defer = S.defer;

    return {
        stop:     stop,
        defer:    defer,
        throttle: throttle,
        debounce: debounce,
        pause:    pause,
        stopsign: stopsign
    };

    function stop(update) {
        return function stopped() { }
    }

    function defer(fn) {
        if (fn !== undefined)
            return _S_defer(fn);

        return function (update) {
            var scheduled = false;

            return function deferred() {
                if (scheduled) return;
                scheduled = true;

                _S_defer(function deferred() {
                    scheduled = false;
                    update();
                });
            }
        };
    }

    function throttle(t) {
        return function throttle(update) {
            var last = 0,
                scheduled = false;

            return function throttle() {
                if (scheduled) return;

                var now = Date.now();

                if ((now - last) > t) {
                    last = now;
                    update();
                } else {
                    scheduled = true;
                    setTimeout(function throttled() {
                        last = Date.now();
                        scheduled = false;
                        update();
                    }, t - (now - last));
                }
            };
        };
    }

    function debounce(t) {
        return function (update) {
            var last = 0,
                tout = 0;

            return function () {
                var now = Date.now();

                if (now > last) {
                    last = now;
                    if (tout) clearTimeout(tout);

                    tout = setTimeout(function debounce() { update(); }, t);
                }
            };
        };
    }

    function pause(collector) {
        return function (update) {
            var scheduled = false;

            return function paused() {
                if (scheduled) return;
                scheduled = true;

                collector(function resume() {
                    scheduled = false;
                    update();
                });
            }
        };
    }

    function stopsign() {
        var updates = [];

        collector.go = go;

        return collector;

        function collector(update) {
            updates.push(update);
        }

        function go() {
            for (var i = 0; i < updates.length; i++) {
                updates[i]();
            }
            updates = [];
        }
    }
});

define('FormulaOptionBuilder', ['S', 'schedulers'], function (S, schedulers) {

    function FormulaOptionBuilder() {
        this.options = {
            sources: null,
            update: null,
            init: null,
            generator: false
        };
    }

    FormulaOptionBuilder.prototype = {
        S: function (fn) {
            return S(fn, this.options);
        },
        on: function (l) {
            l = !l ? [] : !Array.isArray(l) ? [l] : l;
            this.options.sources = maybeConcat(this.options.sources, l);
            return this;
        },
        once: function () {
            this.options.sources = [];
            return this;
        },
        skipFirst: function () {
            if (this.options.sources === null || this.options.sources.length === 0)
                throw new Error("to use skipFirst, you must first have specified at least one dependency with .on(...)")
            composeInit(this, modifiers.stop);
            return this;
        }
    };

    // add methods for modifiers
    'defer throttle debounce pause'.split(' ').map(function (method) {
        FormulaOptionBuilder.prototype[method] = function (v) { composeUpdate(this, schedulers[method](v)); return this; };
    });

    // add methods to S
    'on once defer throttle debounce pause'.split(' ').map(function (method) {
        S[method] = function (v) { return new FormulaOptionBuilder()[method](v); };
    });

    S.stopsign = schedulers.stopsign;

    return;

    function maybeCompose(f, g) { return g ? function compose() { return f(g()); } : f; }
    function maybeConcat(a, b) { return a ? a.concat(b) : b; }
    function composeUpdate(b, fn) { b.options.update = maybeCompose(fn, b.options.update); }
    function composeInit(b, fn) { b.options.init = maybeCompose(fn, b.options.init); }
});

});

(function (package) {
    // nano-implementation of require.js-like define(name, deps, impl) for internal use
    var definitions = {},
        symbol = 'htmlliterals',
        p;

    package(function define(name, deps, fn) {
        if (definitions.hasOwnProperty(name)) throw new Error("define: cannot redefine module " + name);
        definitions[name] = fn.apply(null, deps.map(function (dep) {
            if (!definitions.hasOwnProperty(dep)) throw new Error("define: module " + dep + " required by " + name + " has not been defined.");
            return definitions[dep];
        }));
    });

    if (typeof module === 'object' && typeof module.exports === 'object')  // CommonJS
        module.exports = definitions.export;
    else if (typeof define === 'function')  // AMD
        define([], function () { return definitions.export; });
    else if (typeof this[symbol] !== 'undefined') // existing global object
        for (p in definitions.export) this[symbol][p] = definitions.export[p];
    else // new global object
        this[symbol] = definitions.export;

})(function (define) {
    "use strict";

define('directives', [], function () { return {}; });

// internal cross-browser library of required DOM functions
define('domlib', [], function () {
    return {
        addEventListener: function addEventListener(node, event, fn) {
            node.addEventListener(event, fn, false);
        },

        removeEventListener: function removeEventListener(node, event, fn) {
            node.removeEventListener(event, fn);
        },

        classListContains: function (el, name) {
            return el.classList.contains(name);
        },

        classListAdd: function (el, name) {
            return el.classList.add(name);
        },

        classListRemove: function (el, name) {
            return el.classList.remove(name);
        }
    };
});

define('parse', [], function () {
    var matchOpenTag = /<(\w+)/,
        containerElements = {
            "li": "ul",
            "td": "tr",
            "th": "tr",
            "tr": "tbody",
            "thead": "table",
            "tbody": "table",
            "dd": "dl",
            "dt": "dl",
            "head": "html",
            "body": "html"
        };

    return function parse(html) {
        var container = document.createElement(containerElement(html)),
            len,
            frag;

        container.innerHTML = html;
        len = container.childNodes.length;

        if (len === 0) {
            // special case: empty text node gets swallowed, so create it directly
            if (html === "") return document.createTextNode("");
            throw new Error("HTML parse failed for: " + html);
        } else if (len === 1) {
            return container.childNodes[0];
        } else {
            frag = document.createDocumentFragment();

            while(container.childNodes.length !== 0) {
                frag.appendChild(container.childNodes[0]);
            }

            return frag;
        }
    }

    function containerElement(html) {
        var m = matchOpenTag.exec(html);
        return m && containerElements[m[1].toLowerCase()] || "div";
    }
});

define('cachedParse', ['parse'], function (parse) {
    var cache = {};

    return function cachedParse(id, html) {
        var cached = cache[id];

        if (cached === undefined) {
            cached = parse(html);
            cache[id] = cached;
        }

        return cached.cloneNode(true);
    }
})

define('Shell', ['directives'], function (directives) {
    function Shell(node) {
        if (node.nodeType === undefined)
            throw new Error("Shell can only wrap a DOM node.  Value ``" + node + "'' is not a DOM node.")
        this.node = node;
    }

    Shell.prototype = {
        childNodes: function children(indices, fn) {
            var childNodes = this.node.childNodes,
                len = indices.length,
                childShells = new Array(len),
                i, child;

            if (childNodes === undefined)
                throw new Error("Shell.childNodes can only be applied to a node with a \n"
                    + ".childNodes collection.  Node ``" + this.node + "'' does not have one. \n"
                    + "Perhaps you applied it to the wrong node?");

            for (i = 0; i < len; i++) {
                child = childNodes[indices[i]];
                if (!child)
                    throw new Error("Node ``" + this.node + "'' does not have a child at index " + i + ".");

                childShells[i] = new Shell(child);
            }

            fn(childShells);

            return this;
        },

        directive: function directive(name, values) {
            var fn = directives[name];

            if (typeof fn !== 'function')
                throw new Error("No directive registered with name: " + name);

            values(fn(this.node));

            return this;
        },

        property: function property(setter) {
            setter(this.node);
            return this;
        }
    };

    return Shell;
});

define('directives.class', ['directives', 'domlib'], function (directives, domlib) {
    directives.class = function (node) {
        if (node.className === undefined)
            throw new Error("@class can only be applied to an element that accepts class names. \n"
                + "Element ``" + node + "'' does not. Perhaps you applied it to the wrong node?");

        return function classDirective(on, off, flag) {
            if (arguments.length < 3) flag = off, off = null;

            var hasOn = domlib.classListContains(node, on),
                hasOff = off && domlib.classListContains(node, off);

            if (flag) {
                if (!hasOn) domlib.classListAdd(node, on);
                if (off && hasOff) domlib.classListRemove(node, off);
            } else {
                if (hasOn) domlib.classListRemove(node, on);
                if (off && !hasOff) domlib.classListAdd(node, off);
            }
        };
    };
});

define('directives.focus', ['directives'], function (directives) {
    directives.focus = function focus(node) {
        return function focus(flag) {
            flag ? node.focus() : node.blur();
        };
    };
});

define('directives.insert', ['directives'], function (directives) {
    directives.insert = function(node) {
        var parent,
            start;

        return function (value) {
            parent = node.parentNode;

            if (!parent)
                throw new Error("@insert can only be used on a node that has a parent node. \n"
                    + "Node ``" + node + "'' is currently unattached to a parent.");

            if (start) {
                if (start.parentNode !== parent)
                    throw new Error("@insert requires that the inserted nodes remain sibilings \n"
                        + "of the original node.  The DOM has been modified such that this is \n"
                        + "no longer the case.");

                clear(start, node);
            } else start = marker(node);

            insert(value);
        };

        // value ::
        //   null or undefined
        //   string
        //   node
        //   array of value
        function insert(value) {
            if (value === null || value === undefined) {
                // nothing to insert
            } else if (value.nodeType /* instanceof Node */) {
                parent.insertBefore(value, node);
            } else if (Array.isArray(value)) {
                insertArray(value);
            } else {
                parent.insertBefore(document.createTextNode(value.toString()), node);
            }
        }

        function insertArray(array) {
            var i, len, prev;
            for (i = 0, len = array.length; i < len; i++) {
                insert(array[i]);
                // if we've enjambed two text nodes, separate them with a space
                if (prev
                    && prev.nodeType == 3
                    && prev.nextSibling !== node
                    && prev.nextSibling.nodeType === 3)
                {
                    parent.insertBefore(document.createTextNode(" "), prev.nextSibling);
                }
                prev = node.previousSibling;
            }
        }

        function clear(start, end) {
            var next = start.nextSibling;
            while (next !== end) {
                parent.removeChild(next);
                next = start.nextSibling;
            }
        }

        function marker(el) {
            return parent.insertBefore(document.createTextNode(""), el);
        }
    };
});

define('directives.onkey', ['directives', 'domlib'], function (directives, domlib) {
    directives.onkey = function (node) {
        var keyCode,
            event,
            fn;

        return function onkey(_key, _event, _fn) {
            if (arguments.length < 3) _fn = _event, _event = 'down';

            keyCode = keyCodes[_key.toLowerCase()];
            fn = _fn;

            if (keyCode === undefined)
                throw new Error("@key: unrecognized key identifier '" + _key + "'");

            if (typeof fn !== 'function')
                throw new Error("@key: must supply a function to call when the key is entered");

            _event = 'key' + _event;
            if (_event !== event) {
                if (event) domlib.removeEventListener(node, event, onkeyListener);
                domlib.addEventListener(node, _event, onkeyListener);
                event = _event;
            }
        };

        function onkeyListener(e) {
            if (e.keyCode === keyCode) fn();
            return true;
        }
    };

    var keyCodes = {
        backspace:  8,
        tab:        9,
        enter:      13,
        shift:      16,
        ctrl:       17,
        alt:        18,
        pause:      19,
        break:      19,
        capslock:   20,
        esc:        27,
        space:      32,
        pageup:     33,
        pagedown:   34,
        end:        35,
        home:       36,
        leftarrow:  37,
        uparrow:    38,
        rightarrow: 39,
        downarrow:  40,
        prntscrn:   44,
        insert:     45,
        delete:     46,
        "0":        48,
        "1":        49,
        "2":        50,
        "3":        51,
        "4":        52,
        "5":        53,
        "6":        54,
        "7":        55,
        "8":        56,
        "9":        57,
        a:          65,
        b:          66,
        c:          67,
        d:          68,
        e:          69,
        f:          70,
        g:          71,
        h:          72,
        i:          73,
        j:          74,
        k:          75,
        l:          76,
        m:          77,
        n:          78,
        o:          79,
        p:          80,
        q:          81,
        r:          82,
        s:          83,
        t:          84,
        u:          85,
        v:          86,
        w:          87,
        x:          88,
        y:          89,
        z:          90,
        winkey:     91,
        winmenu:    93,
        f1:         112,
        f2:         113,
        f3:         114,
        f4:         115,
        f5:         116,
        f6:         117,
        f7:         118,
        f8:         119,
        f9:         120,
        f10:        121,
        f11:        122,
        f12:        123,
        numlock:    144,
        scrolllock: 145,
        ",":        188,
        "<":        188,
        ".":        190,
        ">":        190,
        "/":        191,
        "?":        191,
        "`":        192,
        "~":        192,
        "[":        219,
        "{":        219,
        "\\":       220,
        "|":        220,
        "]":        221,
        "}":        221,
        "'":        222,
        "\"":       222
    };
});

define('export', ['parse', 'cachedParse', 'Shell', 'directives', 'domlib'], function (parse, cachedParse, Shell, directives, domlib) {
    return {
        parse: parse,
        cachedParse: cachedParse,
        Shell: Shell,
        directives: directives,
        domlib: domlib
    };
});

});

(function (package) {
    if (typeof exports === 'object')
        package(require('S'), require('htmlliterals-runtime')); // CommonJS
    else if (typeof define === 'function')
        define(['S', 'htmlliterals-runtime'], package); // AMD
    else package(S, htmlliterals); // globals
})(function (S, htmlliterals) {

    htmlliterals.Shell.prototype.directive = function directive(name, values) {
        var node = this.node,
            fn = htmlliterals.directives[name];

        if (typeof fn !== 'function')
            throw new Error("No directive registered with name: " + name);

        fn = fn(node);

        //var logFn = function() {
        //    var args = Array.prototype.slice.call(arguments);
        //    console.log("[@" + name + "(" + args.join(", ") + ")]");
        //    fn.apply(undefined, args);
        //};

        S(function updateDirective() {
            //values(logFn);
            values(fn);
        });

        return this;
    };

    htmlliterals.Shell.prototype.property = function property(setter) {
        var node = this.node;

        //var logSetter = function (node) {
        //    var msg = setter.toString().substr(18); // remove "function () { __."
        //    msg = msg.substr(0, msg.length - 3); // remove "; }"
        //    console.log("[@" + node.nodeName + msg + "]");
        //    setter(node);
        //};

        S(function updateProperty() {
            //logSetter(node);
            setter(node);
        });

        return this;
    };

    htmlliterals.directives.signal = function (node) {
        var signal = null,
            tag = node.nodeName,
            type = node.type && node.type.toUpperCase(),
            handler =
                tag === 'INPUT'         ? (
                    type === 'TEXT'     ? valueSignal    :
                    type === 'RADIO'    ? radioSignal    :
                    type === 'CHECKBOX' ? checkboxSignal :
                    null) :
                tag === 'TEXTAREA'      ? valueSignal    :
                tag === 'SELECT'        ? valueSignal    :
                null;

        if (!handler)
            throw new Error("@signal can only be applied to a form control element, \n"
                + "such as <input/>, <textarea/> or <select/>.  Element ``" + node + "'' is \n"
                + "not a recognized control.  Perhaps you applied it to the wrong node?");

        return handler();

        function valueSignal() {
            var event = null;

            return function valueSignal(_event, _signal) {
                if (arguments.length < 2) _signal = _event, _event = 'change';
                setSignal(_signal);

                S(function updateValue() {
                    node.value = signal();
                });

                if (_event !== event) {
                    if (event) htmlliterals.domlib.removeEventListener(node, event, valueListener);
                    htmlliterals.domlib.addEventListener(node, _event, valueListener);
                    event = _event;
                }
            };

            function valueListener() {
                var cur = S.peek(signal),
                    update = node.value;
                if (cur.toString() !== update) signal(update);
                return true;
            }
        }

        function checkboxSignal() {
            var on = true,
                off = false;

            htmlliterals.domlib.addEventListener(node, "change", function checkboxListener() {
                signal(node.checked ? on : off);
                return true;
            });

            return function checkboxSignal(_signal, _on, _off) {
                setSignal(_signal);

                on = _on === undefined ? true : _on;
                off = _off === undefined ? (on === true ? false : null) : _off;

                S(function updateCheckbox() {
                    node.checked = (signal() === on);
                });
            };
        }

        function radioSignal() {
            var on = true;

            htmlliterals.domlib.addEventListener(node, "change", function radioListener() {
                if (node.checked) signal(on);
                return true;
            });

            return function radioSignal(_signal, _on) {
                setSignal(_signal);

                on = _on === undefined ? true : _on;

                S(function updateRadio() {
                    node.checked = (signal() === on);
                });
            };
        }

        function setSignal(s) {
            if (typeof s !== 'function')
                throw new Error("@signal must receive a function for two-way binding.  \n"
                    + "Perhaps you mistakenly dereferenced it with '()'?");
            signal = s;
        }
    };

});
