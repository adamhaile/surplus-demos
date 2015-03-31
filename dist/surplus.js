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
        this.deferred = [];
    }

    Overseer.prototype = {
        reportReference: function reportReference(src) {
            if (this.target) this.target.addSource(src);
        },
        reportFormula: function reportFormula(dispose, pin) {
            if (this.target) this.target.addSubformula(dispose, pin);
        },
        runDeferred: function runDeferred() {
            if (!this.target) {
                while (this.deferred.length !== 0) {
                    this.deferred.shift()();
                }
            }
        }
    };

    function Source(os) {
        this.id = os.count++;
        this.lineage = os.target ? os.target.lineage : [];

        this.updates = [];
    }

    Source.prototype = {
        propagate: function propagate() {
            var i,
                update,
                updates = this.updates,
                len = updates.length;

            for (i = 0; i < len; i++) {
                update = updates[i];
                if (update) update();
            }
        },
        dispose: function () {
            this.lineage = null;
            this.updates.length = 0;
        }
    };

    function Target(update, options, os) {
        var i, ancestor, oldTarget;

        this.lineage = os.target ? os.target.lineage.slice(0) : [];
        this.lineage.push(this);
        this.scheduler = options.update;

        this.listening = true;
        this.pinning = options.pinning || false;
        this.locked = true;

        this.gen = 1;
        this.dependencies = [];
        this.dependenciesIndex = {};

        this.cleanups = [];
        this.finalizers = [];

        this.updaters = new Array(this.lineage.length + 1);
        this.updaters[this.lineage.length] = update;

        for (i = this.lineage.length - 1; i >= 0; i--) {
            ancestor = this.lineage[i];
            if (ancestor.scheduler) update = ancestor.scheduler(update);
            this.updaters[i] = update;
        }

        if (options.sources) {
            oldTarget = os.target, os.target = this;
            this.locked = false;
            try {
                for (i = 0; i < options.sources.length; i++)
                    options.sources[i]();
            } finally {
                this.locked = true;
                os.target = oldTarget;
            }

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
        addSubformula: function addSubformula(dispose, pin) {
            if (this.locked)
                throw new Error("Cannot create a new subformula except while updating the parent");
            ((pin || this.pinning) ? this.finalizers : this.cleanups).push(dispose);
        },
        addSource: function addSource(src) {
            if (!this.listening || this.locked) return;

            var dep = this.dependenciesIndex[src.id];

            if (dep) {
                dep.activate(this.gen, src);
            } else {
                new Dependency(this, src);
            }
        },
        cleanup: function cleanup() {
            for (var i = 0; i < this.cleanups.length; i++) {
                this.cleanups[i]();
            }
            this.cleanups = [];
        },
        dispose: function dispose() {
            var i;

            this.cleanup();

            for (i = 0; i < this.finalizers.length; i++) {
                this.finalizers[i]();
            }

            for (i = this.dependencies.length - 1; i >= 0; i--) {
                this.dependencies[i].deactivate();
            }

            this.lineage = null;
            this.scheduler = null;
            this.updaters = null;
            this.cleanups = null;
            this.finalizers = null;
            this.dependencies = null;
            this.dependenciesIndex = null;
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

        //for (var i = 0; i < target.lineage.length && i < src.lineage.length && target.lineage[i] === src.lineage[i]; i++);

        this.update = target.updaters[i];
        this.updates.push(this.update);

        target.dependencies.push(this);
        target.dependenciesIndex[src.id] = this;
    }

    Dependency.prototype = {
        activate: function activate(gen, src) {
            if (!this.active) {
                this.active = true;
                this.updates = src.updates;
                this.updates[this.offset] = this.update;
            }
            this.gen = gen;
        },
        deactivate: function deactivate() {
            if (this.active) {
                this.updates[this.offset] = null;
                this.updates = null;
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

define('core', ['graph'], function (graph) {
    var os = new graph.Overseer();

    return {
        data:           data,
        FormulaOptions: FormulaOptions,
        formula:        formula,
        defer:          defer,
        peek:           peek,
        pin:            pin,
        cleanup:        cleanup,
        finalize:       finalize
    }

    function data(value) {
        var src = new graph.Source(os);

        data.toJSON = signalToJSON;

        return data;

        function data(newValue) {
            if (arguments.length > 0) {
                value = newValue;
                src.propagate();
                os.runDeferred();
            } else {
                os.reportReference(src);
            }
            return value;
        }
    }

    function FormulaOptions() {
        this.sources = null;
        this.pin     = false;
        this.update  = null;
        this.init    = null;
    }

    function formula(fn, options) {
        var src = new graph.Source(os),
            tgt = new graph.Target(update, options, os),
            value,
            updating;

        // register dispose before running fn, in case it throws
        os.reportFormula(dispose, options.pin);

        formula.dispose = dispose;
        //formula.toString = toString;
        formula.toJSON = signalToJSON;

        (options.init ? options.init(update) : update)();

        os.runDeferred();

        return formula;

        function formula() {
            if (src) os.reportReference(src);
            return value;
        }

        function update() {
            if (updating || !tgt) return;
            updating = true;

            var oldTarget;

            oldTarget = os.target, os.target = tgt;

            tgt.beginUpdate();
            tgt.locked = false;

            try {
                value = fn();
                if (tgt) tgt.locked = true;
                if (src) src.propagate(); // executing fn might have disposed us (!)
            } finally {
                updating = false;
                if (tgt) tgt.locked = true;
                os.target = oldTarget;
            }

            if (tgt) tgt.endUpdate();
        }

        function dispose() {
            if (src) {
                src.dispose();
                tgt.dispose();
            }
            src = tgt = fn = value = undefined;
        }

        //function toString() {
        //    return "[formula: " + (value !== undefined ? value + " - " : "") + fn + "]";
        //}
    }

    function signalToJSON() {
        return this();
    }

    function peek(fn) {
        if (os.target && os.target.listening) {
            os.target.listening = false;

            try {
                return fn();
            } finally {
                os.target.listening = true;
            }
        } else {
            return fn();
        }
    }

    function pin(fn) {
        if (os.target && !os.target.pinning) {
            os.target.pinning = true;

            try {
                return fn();
            } finally {
                os.target.pinning = false;
            }
        } else {
            return fn();
        }
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
});

define('schedulers', ['core'], function (core) {

    return {
        stop:     stop,
        pause:    pause,
        defer:    defer,
        throttle: throttle,
        debounce: debounce,
        stopsign: stopsign,
        when:     when
    };

    function stop(update) {
        return function stopped() { }
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

    function defer(fn) {
        return pause(core.defer);
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

    function when(preds) {
        return function when(update) {
            for (var i = 0; i < preds.length; i++) {
                if (preds[i]() === undefined) return;
            }
            update();
        }
    }
});

define('options', ['core', 'schedulers'], function (core, schedulers) {

    function FormulaOptionsBuilder() {
        this.options = new core.FormulaOptions();
    }

    FormulaOptionsBuilder.prototype = {
        on: function (l) {
            l = !l ? [] : !Array.isArray(l) ? [l] : l;
            this.options.sources = maybeConcat(this.options.sources, l);
            return this;
        },
        once: function () {
            this.options.sources = [];
            return this;
        },
        pin: function () {
            this.options.pin = true;
            return this;
        },
        when: function (l) {
            l = !l ? [] : !Array.isArray(l) ? [l] : l;
            this.options.sources = maybeConcat(this.options.sources, l);
            var scheduler = schedulers.pause(schedulers.when(l));
            composeInit(this, scheduler);
            composeUpdate(this, scheduler);
            return this;
        }
    };

    // add methods for schedulers
    'defer throttle debounce pause'.split(' ').map(function (method) {
        FormulaOptionsBuilder.prototype[method] = function (v) { composeUpdate(this, schedulers[method](v)); return this; };
    });

    return {
        FormulaOptionsBuilder: FormulaOptionsBuilder
    };

    function maybeCompose(f, g) { return g ? function compose() { return f(g()); } : f; }
    function maybeConcat(a, b) { return a ? a.concat(b) : b; }
    function composeUpdate(b, fn) { b.options.update = maybeCompose(fn, b.options.update); }
    function composeInit(b, fn) { b.options.init = maybeCompose(fn, b.options.init); }
});

define('misc', [], function () {
    return {
        proxy: proxy
    };

    function proxy(getter, setter) {
        return function proxy(value) {
            if (arguments.length !== 0) setter(value);
            return getter();
        };
    }
});

define('S', ['core', 'options', 'schedulers', 'misc'], function (core, options, schedulers, misc) {
    // build our top-level object S
    function S(fn /*, ...args */) {
        var _fn, _args;
        if (arguments.length > 1) {
            _fn = fn;
            _args = Array.prototype.slice.call(arguments, 1);
            fn = function () { return _fn.apply(null, _args); };
        }

        return core.formula(fn, new core.FormulaOptions());
    }

    S.data      = core.data;
    S.peek      = core.peek;
    S.cleanup   = core.cleanup;
    S.finalize  = core.finalize;

    // add methods to S for formula options builder
    'on once when defer throttle debounce pause'.split(' ').map(function (method) {
        S[method] = function (v) { return new options.FormulaOptionsBuilder()[method](v); };
    });

    // S.pin is either an option for a formula being created or the marker of a region where all subs are pinned
    S.pin = function pin(fn) {
        if (arguments.length === 0) {
            return new options.FormulaOptionsBuilder().pin();
        } else {
            core.pin(fn);
        }
    }

    // enable creation of formula from options builder
    options.FormulaOptionsBuilder.prototype.S = function S(fn /*, args */) {
        var _fn, _args;
        if (arguments.length > 1) {
            _fn = fn;
            _args = Array.prototype.slice.call(arguments, 1);
            fn = function () { return _fn.apply(null, _args); };
        }

        return core.formula(fn, this.options);
    }

    S.stopsign = schedulers.stopsign;

    S.proxy = misc.proxy;

    return S;
})

});

// sets, unordered and ordered, for S.js
(function (package) {
    if (typeof exports === 'object')
        package(require('S')); // CommonJS
    else if (typeof define === 'function')
        define(['S'], package); // AMD
    else package(S); // globals
})(function (S) {
    "use strict";

    S.array = array;

    function array(values) {
        if (!Array.isArray(values))
            throw new Error("S.array must be initialized with an array");

        var array = S.data(values);

        // add mutators
        array.pop       = pop;
        array.push      = push;
        array.shift     = shift;
        array.splice    = splice;
        array.unshift   = unshift;

        // not ES5
        array.remove    = remove;
        array.removeAll = removeAll;

        return transformer(array);
    }

    // util to add transformer methods
    function transformer(s) {
        s.concat      = concat;
        s.every       = every;
        s.filter      = filter;
        s.find        = find;
        //s.findIndex = findIndex;
        s.forEach     = forEach;
        s.includes    = includes;
        //s.indexOf   = indexOf;
        //s.join      = join;
        //s.lastIndexOf = lastIndexOf;
        s.map         = map;
        s.sort        = sort;
        s.reduce      = reduce;
        s.reduceRight = reduceRight;
        s.reverse     = reverse;
        s.slice       = slice;
        s.some        = some;

        // non-ES5 transformers
        s.mapS        = mapS;
        s.combine     = combine;
        s.orderBy     = orderBy;

        // schedulers
        s.defer       = defer;
        s.throttle    = throttle;
        s.debounce    = debounce;
        s.pause       = pause;

        return s;
    }

    function mapS(enter, exit, move) {
        var seq = this,
            items = [],
            mapped = [],
            len = 0;

        var mapS = S.on(seq).S(function mapS() {
            var new_items = seq(),
                new_len = new_items.length,
                temp = new Array(new_len),
                from = [],
                to = [],
                i, j, k, item, enterItem;

            // 1) step through all old items and see if they can be found in the new set; if so, save them in a temp array and mark them moved; if not, exit them
            NEXT:
            for (i = 0, k = 0; i < len; i++) {
                item = mapped[i];
                for (j = 0; j < new_len; j++, k = (k + 1) % new_len) {
                    if (items[i] === new_items[k] && !temp.hasOwnProperty(k)) {
                        temp[k] = item;
                        if (i !== k) { from.push(i); to.push(k); }
                        k = (k + 1) % new_len;
                        continue NEXT;
                    }
                }
                if (exit) exit(item, i);
                enter && item.dispose();
            }

            if (move && from.length) move(from, to);

            // 2) set all the new values, pulling from the temp array if copied, otherwise entering the new value
            for (var i = 0; i < new_len; i++) {
                if (temp.hasOwnProperty(i)) {
                    mapped[i] = temp[i];
                } else {
                    item = new_items[i];
                    if (enter) {
                        // capture the current value of item and i in a closure
                        enterItem = (function (item, i) {
                                        return function () { return enter(item, i); };
                                    })(item, i);
                        mapped[i] = S.pin().S(enterItem);
                    } else {
                        mapped[i] = item;
                    }
                }
            }

            // 3) in case the new set is shorter than the old, set the length of the mapped array
            len = mapped.length = new_len;

            // 4) save a copy of the mapped items for the next update
            items = new_items.slice();

            return mapped;
        });

        return transformer(mapS);
    }

    function forEach(enter, exit, move) {
        var seq = this,
            items = [],
            len = 0;

        var forEach = S.on(seq).S(function forEach() {
            var new_items = seq(),
                new_len = new_items.length,
                found = new Array(new_len),
                from = [],
                to = [],
                i, j, k, item;

            // 1) step through all old items and see if they can be found in the new set; if so, save them in a temp array and mark them moved; if not, exit them
            NEXT:
            for (i = 0, k = 0; i < len; i++) {
                item = items[i];
                for (j = 0; j < new_len; j++, k = (k + 1) % new_len) {
                    if (item === new_items[k] && !found[k]) {
                        found[k] = true;
                        if (i !== k) { from.push(i); to.push(k); }
                        k = (k + 1) % new_len;
                        continue NEXT;
                    }
                }
                if (exit) exit(item, i);
            }

            if (move && from.length) move(from, to);

            // 2) set all the new values, pulling from the temp array if copied, otherwise entering the new value
            if (enter) {
                S.pin(function forEach() {
                    for (var i = 0; i < new_len; i++) {
                        if (!found[i]) enter(new_items[i], i);
                    }
                });
            }

            // 3) in case the new set is shorter than the old, set the length of the mapped array
            len = new_len;

            // 4) save a copy of the mapped items for the next update
            items = new_items.slice();

            return items;
        });

        return transformer(forEach);
    }

    function combine() {
        var seq = this;
        return transformer(S(function combine() {
            var s = seq(),
                result = new Array(s.length);
            for (var i = 0; i < s.length; i++) {
                result[i] = s[i]();
            }
            return result;
        }));
    }

    function map(enter, exit, move) {
        var mapS = this.mapS(enter, exit, move);
        return enter ? mapS.combine() : mapS;
    }

    function find(pred) {
        var seq = this;
        return transformer(S(function find() {
            var s = seq(),
                i, item;
            for (i = 0; i < s.length; i++) {
                item = s[i];
                if (pred(item)) return item;
            }
            return undefined;
        }));
    }

    function includes(o) {
        var seq = this;
        return transformer(S(function find() {
            var s = seq();
            for (var i = 0; i < s.length; i++) {
                if (s[i] === o) return true;
            }
            return false;
        }));
    }

    function sort(fn) {
        var seq = this;
        return transformer(S(function sort() {
            var copy = seq().slice(0);
            if (fn) copy.sort(fn);
            else copy.sort();
            return copy;
        }));
    }

    function orderBy(by) {
        var seq = this,
            key;

        if (typeof by !== 'function') {
            key = by;
            by = function (o) { return o[key]; };
        }

        return transformer(S(function orderBy() {
            var copy = seq().slice(0);
            copy.sort(function (a, b) {
                a = by(a);
                b = by(b);
                return a < b ? -1 : a > b ? 1 : 0;
            });
            return copy;
        }));
    }

    function filter(predicate) {
        var seq = this;
        return transformer(S(function filter() {
            var s = seq(),
                result = [],
                i, v;

            for (i = 0; i < s.length; i++) {
                v = s[i];
                if (predicate(v)) result.push(v);
            }

            return result;
        }));
    }

    function concat(/* others */) {
        var seq = this,
            others = Array.prototype.slice.call(arguments);
        return transformer(S(function concat() {
            var s = seq();
            for (var i = 0; i < others.length; i++) {
                s = s.concat(others[i]());
            }
            return s;
        }));
    }

    function reduce(fn, seed) {
        var seq = this;
        return transformer(S(function reduce() {
            var s = seq(),
                result = seed;
            for (var i = 0; i < s.length; i++) {
                result = fn(result, s[i], i, s);
            }
            return result;
        }));
    }

    function reduceRight(fn, seed) {
        var seq = this;
        return transformer(S(function reduceRight() {
            var s = seq(),
                result = seed;
            for (var i = s.length - 1; i >= 0; i--) {
                result = fn(result, s[i], i, s);
            }
            return result;
        }));
    }

    function every(fn) {
        var seq = this;
        return transformer(S(function every() {
            var s = seq();
            for (var i = 0; i < s.length; i++) {
                if (!fn(s[i])) return false;
            }
            return true;
        }));
    }

    function some(fn) {
        var seq = this;
        return transformer(S(function some() {
            var s = seq();
            if (fn === undefined) return s.length !== 0;
            for (var i = 0; i < s.length; i++) {
                if (fn(s[i])) return true;
            }
            return false;
        }));
    }

    function reverse() {
        var seq = this;
        return transformer(S(function () {
            var copy = seq().slice(0);
            copy.reverse();
            return copy;
        }));
    }

    function slice(s, e) {
        var seq = this;
        return transformer(S(function () {
            return seq().slice(s, e);
        }));
    }

    // mutators
    function push(item) {
        var values = S.peek(this);

        values.push(item);
        this(values);

        return this;
    }

    function pop(item) {
        var values = S.peek(this),
            value = values.pop();

        this(values);

        return value;
    }

    function unshift(item) {
        var values = S.peek(this);

        values.unshift(item);
        this(values);

        return this;
    }

    function shift(item) {
        var values = S.peek(this),
            value = values.shift();

        this(values);

        return value;
    }

    function splice(index, count, item) {
        var values = S.peek(this);

        Array.prototype.splice.apply(values, arguments);
        this(values);

        return this;
    }

    function remove(item) {
        var values = S.peek(this);

        for (var i = 0; i < values.length; i++) {
            if (values[i] === item) {
                values.splice(i, 1);
                break;
            }
        }

        this(values);

        return this;
    }

    function removeAll(item) {
        var values = S.peek(this),
            i = 0;

        while (i < values.length) {
            if (values[i] === item) {
                values.splice(i, 1);
            } else {
                i++;
            }
        }

        this(values);

        return this;
    }

    // schedulers
    function defer() {
        return transformer(S.defer().S(this));
    }

    function throttle(t) {
        return transformer(S.throttle(t).S(this));
    }
    function debounce(t) {
        return transformer(S.debounce(t).S(this));
    }

    function pause(collector) {
        return transformer(S.pause(collector).S(this));
    }
});

(function (package) {
    // nano-implementation of require.js-like define(name, deps, impl) for internal use
    var definitions = {},
        publish = {};

    package(function define(name, deps, fn) {
        if (definitions.hasOwnProperty(name)) throw new Error("define: cannot redefine module " + name);
        definitions[name] = fn.apply(null, deps.map(function (dep) {
            if (!definitions.hasOwnProperty(dep)) throw new Error("define: module " + dep + " required by " + name + " has not been defined.");
            return definitions[dep];
        }));
    });

    if (typeof exports === 'object') publish = exports; // CommonJS
    else if (typeof define === 'function') define([], function () { return publish; }); // AMD
    else publish = this.htmlliterals = this.htmlliterals || publish; // fallback to global object

    publish.preprocess = definitions.preprocess;

})(function (define) {
    "use strict";

define('sourcemap', [], function () {
    var rx = {
            locs: /(\n)|(\u0000(\d+),(\d+)\u0000)|(\u0000\u0000)/g
        },
        vlqlast = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
        vlqcont = "ghijklmnopqrstuvwxyz0123456789+/";

    return {
        segmentStart: segmentStart,
        segmentEnd:   segmentEnd,
        extractMap:   extractMap,
        appendMap:    appendMap
    };

    function segmentStart(loc) {
        return "\u0000" + loc.line + "," + loc.col + "\u0000";
    }

    function segmentEnd() {
        return "\u0000\u0000";
    }

    function extractMappings(embedded) {
        var mappings = "",
            pgcol = 0,
            psline = 0,
            pscol = 0,
            insegment = false,
            linestart = 0,
            linecont = false;

        var src = embedded.replace(rx.locs, function (_, nl, start, line, col, end, offset) {
            if (nl) {
                mappings += ";";

                if (insegment) {
                    mappings += "AA" + vlq(1) + vlq(0 - pscol);
                    psline++;
                    pscol = 0;
                    linecont = true;
                } else {
                    linecont = false;
                }

                linestart = offset + nl.length;

                pgcol = 0;

                return nl;
            } else if (start) {
                var gcol = offset - linestart;
                line = parseInt(line);
                col = parseInt(col);

                mappings += (linecont ? "," : "")
                          + vlq(gcol - pgcol)
                          + "A" // only one file
                          + vlq(line - psline)
                          + vlq(col - pscol);

                insegment = true;
                linecont = true;

                pgcol = gcol;
                psline = line;
                pscol = col;

                return "";
            } else if (end) {
                insegment = false;
                return "";
            }
        });

        return {
            src: src,
            mappings: mappings
        };
    }

    function extractMap(src, original, opts) {
        var extract = extractMappings(src),
            map = createMap(extract.mappings, original);

        return {
            src: extract.src,
            map: map
        };
    }

    function createMap(mappings, original) {
        return {
            version       : 3,
            file          : 'out.js',
            sources       : [ 'in.js' ],
            sourcesContent: [ original ],
            names         : [],
            mappings      : mappings
        };
    }

    function appendMap(src, original, opts) {
        var extract = extractMap(src, original),
            appended = extract.src
              + "\n//# sourceMappingURL=data:"
              + escape(JSON.stringify(extract.map));

        return appended;
    }

    function vlq(num) {
        var str = "", i;

        // convert num sign representation from 2s complement to sign bit in lsd
        num = num < 0 ? (-num << 1) + 1 : num << 1 + 0;
        // convert num to base 32 number
        num = num.toString(32);

        // convert base32 digits of num to vlq continuation digits in reverse order
        for (i = num.length - 1; i > 0; i--)
            str += vlqcont[parseInt(num[i], 32)];

        // add final vlqlast digit
        str += vlqlast[parseInt(num[0], 32)];

        return str;
    }
});

define('tokenize', [], function () {
    /// tokens:
    /// < (followed by \w)
    /// </ (followed by \w))
    /// >
    /// />
    /// <!--
    /// -->
    /// @
    /// =
    /// )
    /// (
    /// [
    /// ]
    /// {
    /// }
    /// "
    /// '
    /// //
    /// \n
    /// /*
    /// */
    /// misc (any string not containing one of the above)

    // pre-compiled regular expressions
    var rx = {
        tokens: /<\/?(?=\w)|\/?>|<!--|-->|@|=|\)|\(|\[|\]|\{|\}|"|'|\/\/|\n|\/\*|\*\/|(?:[^<>@=\/@=()[\]{}"'\n*-]|(?!-->)-|\/(?![>/*])|\*(?!\/)|(?!<\/?\w|<!--)<\/?)+/g,
    };

    return function tokenize(str, opts) {
        var toks = str.match(rx.tokens);

        return toks;
        //return TokenStream(toks);
    }

    function TokenStream(toks) {
        var i       = 0,
            eof     = toks.length === 0,
            tok     = !eof && toks[i],
            line    = 0,
            col     = 0;

        return {
            TOK:      function TOK() { return TOK; },
            EOF:      function EOF() { return EOF; },
            NEXT:     NEXT,
            ERR:      ERR,
            IS:       IS,
            NOT:      NOT,
            MATCH:    MATCH,
            WS:       WS,
            SPLIT:    SPLIT,
            LOC:      LOC,
            MARK:     MARK,
            ROLLBACK: ROLLBACK
        };

        // token stream ops
        function NEXT() {
            if (tok === "\n") line++, col = 0;
            else if (tok) col += tok.length;

            if (++i >= toks.length) eof = true, tok = null;
            else tok = toks[i];
        }

        function ERR(msg) {
            throw new Error(msg);
        }

        function IS(t) {
            return tok === t;
        }

        function NOT(t) {
            return tok !== t;
        }

        function MATCH(rx) {
            return rx.test(tok);
        }

        function WS() {
            return !!MATCH(rx.ws);
        }

        function SPLIT(rx) {
            var m = rx.exec(tok);
            if (m && (m = m[0])) {
                col += m.length;
                tok = tok.substring(m.length);
                if (tok === "") NEXT();
                return m;
            } else {
                return null;
            }
        }

        function LOC() {
            return { line: line, col: col };
        }

        function MARK() {
            return {
                tok:     tok,
                i:       i,
                eof:     eof,
                line:    line,
                col:     col,
                segment: segment
            };
        }

        function ROLLBACK(mark) {
            tok     = mark.tok;
            i       = mark.i;
            eof     = mark.eof;
            line    = mark.line;
            col     = mark.col;
            segment = mark.segment;
        }
    }
});

define('AST', [], function () {
    return {
        CodeTopLevel: function (segments) {
            this.segments = segments; // [ CodeText | HtmlLiteral ]
        },
        CodeText: function (text, loc) {
            this.text = text; // string
            this.loc = loc; // { line: int, col: int }
        },
        EmbeddedCode: function (segments) {
            this.segments = segments; // [ CodeText | HtmlLiteral ]
        },
        HtmlLiteral: function(nodes) {
            this.nodes = nodes; // [ HtmlElement | HtmlComment | HtmlText(ws only) | HtmlInsert ]
        },
        HtmlElement: function(beginTag, properties, directives, content, endTag) {
            this.beginTag = beginTag; // string
            this.properties = properties; // [ Property ]
            this.directives = directives; // [ Directive | AttrStyleDirective ]
            this.content = content; // [ HtmlElement | HtmlComment | HtmlText | HtmlInsert ]
            this.endTag = endTag; // string | null
        },
        HtmlText: function (text) {
            this.text = text; // string
        },
        HtmlComment: function (text) {
            this.text = text; // string
        },
        HtmlInsert: function (code) {
            this.code = code; // EmbeddedCode
        },
        Property: function (name, code, callback) {
            this.name = name; // string
            this.code = code; // EmbeddedCode
            this.callback = callback; // bool
        },
        Directive: function (name, code) {
            this.name = name; // string
            this.code = code; // EmbeddedCode
        },
        AttrStyleDirective: function (name, params, code, callback) {
            this.name = name; // string
            this.params = params; // [ string ]
            this.code = code; // EmbeddedCode
            this.callback = callback; // bool
        }
    };
});

define('parse', ['AST'], function (AST) {

    // pre-compiled regular expressions
    var rx = {
        propertyLeftSide   : /\s(\S+)\s*=>?\s*$/,
        embeddedCodePrefix : /^[+\-!~]*[a-zA-Z_$][a-zA-Z_$0-9]*/, // prefix unary operators + identifier
        embeddedCodeInterim: /^(?:\.[a-zA-Z_$][a-zA-Z_$0-9]*)+/, // property chain, like .bar.blech
        embeddedCodeSuffix : /^\+\+|--/, // suffix unary operators
        directiveName      : /^[a-zA-Z_$][a-zA-Z_$0-9]*(:[^\s:=]*)*/, // like "foo:bar:blech"
        stringEscapedEnd   : /[^\\](\\\\)*\\$/, // ending in odd number of escape slashes = next char of string escaped
        ws                 : /^\s*$/,
        leadingWs          : /^\s+/,
        tagTrailingWs      : /\s+(?=\/?>$)/,
        emptyLines         : /\n\s+(?=\n)/g
    };

    var parens = {
        "(": ")",
        "[": "]",
        "{": "}"
    };

    return function parse(TOKS, opts) {
        var i = 0,
            EOF = TOKS.length === 0,
            TOK = !EOF && TOKS[i],
            LINE = 0,
            COL = 0,
            POS = 0;

        return codeTopLevel();

        function codeTopLevel() {
            var segments = [],
                text = "",
                loc = LOC();

            while (!EOF) {
                if (IS('<') || IS('<!--') || IS('@')) {
                    if (text) segments.push(new AST.CodeText(text, loc));
                    text = "";
                    segments.push(htmlLiteral());
                    loc = LOC();
                } else if (IS('"') || IS("'")) {
                    text += quotedString();
                } else if (IS('//')) {
                    text += codeSingleLineComment();
                } else if (IS('/*')) {
                    text += codeMultiLineComment();
                } else {
                    text += TOK, NEXT();
                }
            }

            if (text) segments.push(new AST.CodeText(text, loc));

            return new AST.CodeTopLevel(segments);
        }

        function htmlLiteral() {
            if (NOT('<') && NOT('<!--') && NOT('@')) ERR("not at start of html expression");

            var nodes = [],
                mark,
                wsText;

            while (!EOF) {
                if (IS('<')) {
                    nodes.push(htmlElement());
                } else if (IS('<!--')) {
                    nodes.push(htmlComment());
                } else if (IS('@')) {
                    nodes.push(htmlInsert());
                } else {
                    mark = MARK();
                    wsText = htmlWhitespaceText();

                    if (!EOF && (IS('<') || IS('<!--') || IS('@'))) {
                        nodes.push(wsText);
                    } else {
                        ROLLBACK(mark);
                        break;
                    }
                }
            }

            return new AST.HtmlLiteral(nodes);
        }

        function htmlElement() {
            if (NOT('<')) ERR("not at start of html element");

            var start = LOC(),
                beginTag = "",
                properties = [],
                directives = [],
                content = [],
                endTag = "",
                hasContent = true;

            beginTag += TOK, NEXT();

            // scan for attributes until end of opening tag
            while (!EOF && NOT('>') && NOT('/>')) {
                if (IS('@')) {
                    directives.push(directive());
                } else if (IS('=')) {
                    beginTag = property(beginTag, properties);
                } else {
                    beginTag += TOK, NEXT();
                }
            }

            if (EOF) ERR("unterminated start node", start);

            hasContent = IS('>');

            beginTag += TOK, NEXT();

            // clean up extra whitespace now that directives have been removed
            beginTag = beginTag.replace(rx.tagTrailingWs, "").replace(rx.emptyLines, "");

            if (hasContent) {
                while (!EOF && NOT('</')) {
                    if (IS('<')) {
                        content.push(htmlElement());
                    } else if (IS('@')) {
                        content.push(htmlInsert());
                    } else if (IS('<!--')) {
                        content.push(htmlComment());
                    } else {
                        content.push(htmlText());
                    }
                }

                if (EOF) ERR("element missing close tag");

                while (!EOF && NOT('>')) {
                    endTag += TOK, NEXT();
                }

                if (EOF) ERR("eof while looking for element close tag");

                endTag += TOK, NEXT();
            }

            return new AST.HtmlElement(beginTag, properties, directives, content, endTag);
        }

        function htmlText() {
            var text = "";

            while (!EOF && NOT('<') && NOT('<!--') && NOT('@') && NOT('</')) {
                text += TOK, NEXT();
            }

            return new AST.HtmlText(text);
        }

        function htmlWhitespaceText() {
            var text = "";

            while (!EOF && WS()) {
                text += TOK, NEXT();
            }

            return new AST.HtmlText(text);
        }

        function htmlComment() {
            if (NOT('<!--')) ERR("not in HTML comment");

            var text = "";

            while (!EOF && NOT('-->')) {
                text += TOK, NEXT();
            }

            if (EOF) ERR("unterminated html comment");

            text += TOK, NEXT();

            return new AST.HtmlComment(text);
        }

        function htmlInsert() {
            if (NOT('@')) ERR("not at start of code insert");

            NEXT();

            return new AST.HtmlInsert(embeddedCode());
        }

        function property(beginTag, properties) {
            if(NOT('=')) ERR("not at equals sign of a property assignment");

            var match,
                name,
                callback = false;

            beginTag += TOK, NEXT();

            if (IS('>')) callback = true, beginTag += TOK, NEXT();

            if (WS()) beginTag += TOK, NEXT();

            match = rx.propertyLeftSide.exec(beginTag);

            // check if it's an attribute not a property assignment
            if (match && (callback || (NOT('"') && NOT("'")))) {
                beginTag = beginTag.substring(0, beginTag.length - match[0].length);

                name = match[1];

                SPLIT(rx.leadingWs);

                properties.push(new AST.Property(name, embeddedCode(), callback));
            }

            return beginTag;
        }

        function directive() {
            if (NOT('@')) ERR("not at start of directive");

            NEXT();

            var name = SPLIT(rx.directiveName),
                text,
                segments,
                loc,
                callback = false;

            if (!name) ERR("directive must have name");

            if (IS('(')) {
                segments = [];
                loc = LOC();
                text = balancedParens(segments, "", loc);
                if (text) segments.push(new AST.CodeText(text, loc));

                return new AST.Directive(name, new AST.EmbeddedCode(segments));
            } else {
                if (WS()) NEXT();

                if (NOT('=')) ERR("unrecognized directive - must have form like @foo:bar = ... or @foo( ... )");

                NEXT();

                if (IS('>')) callback = true, NEXT();

                SPLIT(rx.leadingWs);

                name = name.split(":");

                return new AST.AttrStyleDirective(name[0], name.slice(1), embeddedCode(), callback);
            }
        }

        function embeddedCode() {
            var start = LOC(),
                segments = [],
                text = "",
                part,
                loc = LOC();

            // consume any initial operators and identifier (!foo)
            if (part = SPLIT(rx.embeddedCodePrefix)) {
                text += part;

                // consume any property chain (.bar.blech)
                if (part = SPLIT(rx.embeddedCodeInterim)) {
                    text += part;
                }
            }

            // consume any sets of balanced parentheses
            while (PARENS()) {
                text = balancedParens(segments, text, loc);

                // consume interim property chain (.blech.gorp)
                if (part = SPLIT(rx.embeddedCodeInterim)) {
                    text += part;
                }
            }

            // consume any operator suffix (++, --)
            if (part = SPLIT(rx.embeddedCodeSuffix)) {
                text += part;
            }

            if (text) segments.push(new AST.CodeText(text, loc));

            if (segments.length === 0) ERR("not in embedded code", start);

            return new AST.EmbeddedCode(segments);
        }

        function balancedParens(segments, text, loc) {
            var end = PARENS();

            if (end === undefined) ERR("not in parentheses");

            text += TOK, NEXT();

            while (!EOF && NOT(end)) {
                if (IS("'") || IS('"')) {
                    text += quotedString();
                } else if (IS('//')) {
                    text += codeSingleLineComment();
                } else if (IS('/*')) {
                    text += codeMultiLineComment();
                } else if (IS("<") || IS('<!--')) {
                    if (text) segments.push(new AST.CodeText(text, { line: loc.line, col: loc.col }));
                    text = "";
                    segments.push(htmlLiteral());
                    loc.line = LINE;
                    loc.col = COL;
                } else if (IS('(')) {
                    text = balancedParens(segments, text, loc);
                } else {
                    text += TOK, NEXT();
                }
            }

            if (EOF) ERR("unterminated parentheses");

            text += TOK, NEXT();

            return text;
        }

        function quotedString() {
            if (NOT("'") && NOT('"')) ERR("not in quoted string");

            var quote,
                text;

            quote = text = TOK, NEXT();

            while (!EOF && (NOT(quote) || rx.stringEscapedEnd.test(text))) {
                text += TOK, NEXT();
            }

            if (EOF) ERR("unterminated string");

            text += TOK, NEXT();

            return text;
        }

        function codeSingleLineComment() {
            if (NOT("//")) ERR("not in code comment");

            var text = "";

            while (!EOF && NOT('\n')) {
                text += TOK, NEXT();
            }

            // EOF within a code comment is ok, just means that the text ended with a comment
            if (!EOF) text += TOK, NEXT();

            return text;
        }

        function codeMultiLineComment() {
            if (NOT("/*")) ERR("not in code comment");

            var text = "";

            while (!EOF && NOT('*/')) {
                text += TOK, NEXT();
            }

            if (EOF) ERR("unterminated multi-line comment");

            text += TOK, NEXT();

            return text;
        }

        // token stream ops
        function NEXT() {
            if (TOK === "\n") LINE++, COL = 0, POS++;
            else if (TOK) COL += TOK.length, POS += TOK.length;

            if (++i >= TOKS.length) EOF = true, TOK = null;
            else TOK = TOKS[i];
        }

        function ERR(msg, loc) {
            var frag = loc ? " at line " + loc.line + " col " + loc.col + ": ``" + TOKS.join('').substr(loc.pos, 30).replace("\n", "") + "''" : "";
            throw new Error(msg + frag);
        }

        function IS(t) {
            return TOK === t;
        }

        function NOT(t) {
            return TOK !== t;
        }

        function MATCH(rx) {
            return rx.test(TOK);
        }

        function MATCHES(rx) {
            return rx.exec(TOK);
        }

        function WS() {
            return !!MATCH(rx.ws);
        }

        function PARENS() {
            return parens[TOK];
        }

        function SPLIT(rx) {
            var m = MATCHES(rx);
            if (m && (m = m[0])) {
                COL += m.length;
                POS += m.length;
                TOK = TOK.substring(m.length);
                if (TOK === "") NEXT();
                return m;
            } else {
                return null;
            }
        }

        function LOC() {
            return { line: LINE, col: COL, pos: POS };
        }

        function MARK() {
            return {
                TOK: TOK,
                i:   i,
                EOF: EOF,
                LINE: LINE,
                COL: COL
            };
        }

        function ROLLBACK(mark) {
            TOK = mark.TOK;
            i   = mark.i;
            EOF = mark.EOF;
            LINE = mark.LINE;
            COL = mark.COL;
        }
    }
});

define('genCode', ['AST', 'sourcemap'], function (AST, sourcemap) {

    // pre-compiled regular expressions
    var rx = {
        eventProperty      : /^on/,
        backslashes        : /\\/g,
        newlines           : /\n/g,
        singleQuotes       : /'/g,
        firstline          : /^[^\n]*/,
        lastline           : /[^\n]*$/,
        nonws              : /\S/g
    };

    // genCode
    AST.CodeTopLevel.prototype.genCode   =
    AST.EmbeddedCode.prototype.genCode   = function (opts) { return concatResults(opts, this.segments, 'genCode'); };
    AST.CodeText.prototype.genCode       = function (opts) {
        return (opts.sourcemap ? sourcemap.segmentStart(this.loc) : "")
            + this.text
            + (opts.sourcemap ? sourcemap.segmentEnd() : "");
    };
    var htmlLiteralId = 0; //Math.floor(Math.random() * Math.pow(2, 31));
    AST.HtmlLiteral.prototype.genCode = function (opts, prior) {
        var html = concatResults(opts, this.nodes, 'genHtml'),
            nl = "\n" + indent(prior),
            directives = this.nodes.length > 1 ? genChildDirectives(opts, this.nodes, nl) : this.nodes[0].genDirectives(opts, nl),
            code = "new " + opts.symbol + "(" + htmlLiteralId++ + "," + nl + codeStr(html) + ")";

        if (directives) code += nl + directives + nl;

        code = "(" + code + ".node)";

        return code;
    };

    // genHtml
    AST.HtmlElement.prototype.genHtml = function(opts) {
        return this.beginTag + concatResults(opts, this.content, 'genHtml') + (this.endTag || "");
    };
    AST.HtmlComment.prototype.genHtml =
    AST.HtmlText.prototype.genHtml    = function (opts) { return this.text; };
    AST.HtmlInsert.prototype.genHtml  = function (opts) { return '<!-- insert -->'; };

    // genDirectives
    AST.HtmlElement.prototype.genDirectives = function (opts, nl) {
        var childDirectives = genChildDirectives(opts, this.content, nl),
            properties = concatResults(opts, this.properties, 'genDirective', nl),
            directives = concatResults(opts, this.directives, 'genDirective', nl);

        return properties + (properties && (directives || childDirectives) ? nl : "")
            + directives + (directives && childDirectives ? nl : "")
            + childDirectives;
    };
    AST.HtmlComment.prototype.genDirectives =
    AST.HtmlText.prototype.genDirectives    = function (opts, nl) { return null; };
    AST.HtmlInsert.prototype.genDirectives  = function (opts, nl) {
        return new AST.AttrStyleDirective('insert', [], this.code, false).genDirective(opts);
    }

    // genDirective
    AST.Property.prototype.genDirective = function (opts) {
        var code = this.code.genCode(opts);
        if (this.callback) code = genCallback(this.name, code);
        return ".property(function (__) { __." + this.name + " = " + code + "; })";
    };
    AST.Directive.prototype.genDirective = function (opts) {
        return "." + this.name + "(function (__) { __" + this.code.genCode(opts) + "; })";
    };
    AST.AttrStyleDirective.prototype.genDirective = function (opts) {
        var code = "." + this.name + "(function (__) { __(";

        for (var i = 0; i < this.params.length; i++)
            code += codeStr(this.params[i]) + ", ";

        code += this.callback ? genCallback(this.name, this.code.genCode(opts))
                              : this.code.genCode(opts);

        code += "); })";

        return code;
    };

    function genChildDirectives(opts, childNodes, nl) {
        var indices = [],
            directives = [],
            identifiers = [],
            cnl = nl + "    ",
            ccnl = cnl + "     ",
            directive,
            i,
            result = "";

        for (i = 0; i < childNodes.length; i++) {
            directive = childNodes[i].genDirectives(opts, ccnl);
            if (directive) {
                indices.push(i);
                identifiers.push(childIdentifier(childNodes[i]));
                directives.push(directive);
            }
        }

        if (indices.length) {
            result += ".child([" + indices.join(", ") + "], function (__) {" + cnl;
            for (i = 0; i < directives.length; i++) {
                if (i) result += cnl;
                result += "// " + identifiers[i] + cnl;
                result += "__[" + i + "]" + directives[i] + ";"
            }
            result += nl + "})";
        }

        return result;
    }

    function concatResults(opts, children, method, sep) {
        var result = "", i;

        for (i = 0; i < children.length; i++) {
            if (i && sep) result += sep;
            result += children[i][method](opts, result);
        }

        return result;
    }

    function codeStr(str) {
        return "'" + str.replace(rx.backslashes, "\\\\")
                        .replace(rx.singleQuotes, "\\'")
                        .replace(rx.newlines, "\\\n")
                   + "'";
    }

    function genCallback(name, code) {
        var param = rx.eventProperty.test(name) ? name.substring(2) : "__";
        return "function (" + param + ") { " + code + " }";
    }

    function indent(prior) {
        var lastline = rx.lastline.exec(prior);
        lastline = lastline ? lastline[0] : '';
        return lastline.replace(rx.nonws, " ");
    }

    function childIdentifier(child) {
        return firstline(child.beginTag || child.text || child.genHtml());
    }

    function firstline(str) {
        var l = rx.firstline.exec(str);
        return l ? l[0] : '';
    }
});

// Cross-browser compatibility shims
define('shims', ['AST'], function (AST) {

    var shimmed = false;

    // add base shim methods that visit AST
    AST.CodeTopLevel.prototype.shim = function (ctx) { shimSiblings(this, this.segments, ctx); };
    AST.HtmlLiteral.prototype.shim  = function (ctx) { shimSiblings(this, this.nodes, ctx); };
    AST.HtmlElement.prototype.shim  = function (ctx) { shimSiblings(this, this.content, ctx); };
    AST.HtmlInsert.prototype.shim   = function (ctx) { shimSiblings(this, this.segments, ctx) };
    AST.CodeText.prototype.shim     =
    AST.HtmlText.prototype.shim     =
    AST.HtmlComment.prototype.shim  = function (ctx) {};

    if (!browserPreservesWhitespaceTextNodes())
        addFEFFtoWhitespaceTextNodes();

    if (!browserPreservesInitialComments())
        insertTextNodeBeforeInitialComments();

    return shimmed;

    // IE <9 will removes text nodes that just contain whitespace in certain situations.
    // Solution is to add a zero-width non-breaking space (entity &#xfeff) to the nodes.
    function browserPreservesWhitespaceTextNodes() {
        var ul = document.createElement("ul");
        ul.innerHTML = "    <li></li>";
        return ul.childNodes.length === 2;
    }

    function addFEFFtoWhitespaceTextNodes() {
        shim(AST.HtmlText, function (ctx) {
            if (ws.test(this.text) && !(ctx.parent instanceof AST.HtmlAttr)) {
                this.text = '&#xfeff;' + this.text;
            }
        });
    }

    // IE <9 will remove comments when they're the first child of certain elements
    // Solution is to prepend a non-whitespace text node, using the &#xfeff trick.
    function browserPreservesInitialComments() {
        var ul = document.createElement("ul");
        ul.innerHTML = "<!-- --><li></li>";
        return ul.childNodes.length === 2;
    }

    function insertTextNodeBeforeInitialComments() {
        shim(AST.HtmlComment, function (ctx) {
            if (ctx.index === 0) {
                insertBefore(new AST.HtmlText('&#xfeff;'), ctx);
            }
        })
    }

    function shimSiblings(parent, siblings, prevCtx) {
        var ctx = { index: 0, parent: parent, sibings: siblings }
        for (; ctx.index < siblings.length; ctx.index++) {
            siblings[ctx.index].shim(ctx);
        }
    }

    function shim(node, fn) {
        shimmed = true;
        var oldShim = node.prototype.shim;
        node.prototype.shim = function (ctx) { fn.call(this, ctx); oldShim.call(this, ctx); };
    }

    function insertBefore(node, ctx) {
        ctx.siblings.splice(ctx.index, 0, node);
        node.shim(ctx);
        ctx.index++;
    }

    function insertAfter(node, ctx) {
        ctx.siblings.splice(ctx.index + 1, 0, node);
    }

});

define('preprocess', ['tokenize', 'parse', 'shims', 'sourcemap'], function (tokenize, parse, shimmed, sourcemap) {
    return function preprocess(str, opts) {
        opts = opts || {};
        opts.symbol = opts.symbol || 'Html';
        opts.sourcemap = opts.sourcemap || null;

        var toks = tokenize(str, opts),
            ast = parse(toks, opts);

        if (shimmed) ast.shim();

        var code = ast.genCode(opts),
            out;

        if (opts.sourcemap === 'extract') out = sourcemap.extractMap(code, str, opts);
        else if (opts.sourcemap === 'append') out = sourcemap.appendMap(code, str, opts);
        else out = code;

        return out;
    }
});

});

(function (package) {
    // nano-implementation of require.js-like define(name, deps, impl) for internal use
    var definitions = {},
        symbol = 'Html';

    package(function define(name, deps, fn) {
        if (definitions.hasOwnProperty(name)) throw new Error("define: cannot redefine module " + name);
        definitions[name] = fn.apply(null, deps.map(function (dep) {
            if (!definitions.hasOwnProperty(dep)) throw new Error("define: module " + dep + " required by " + name + " has not been defined.");
            return definitions[dep];
        }));
    });

    if (typeof module === 'object' && typeof module.exports === 'object')  // CommonJS
        module.exports = definitions[symbol];
    else if (typeof define === 'function')  // AMD
        define([], function () { return definitions[symbol]; });
    else // new global object
        this[symbol] = definitions[symbol];

})(function (define) {
    "use strict";

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
            "li"      : "ul",
            "td"      : "tr",
            "th"      : "tr",
            "tr"      : "tbody",
            "thead"   : "table",
            "tbody"   : "table",
            "dd"      : "dl",
            "dt"      : "dl",
            "head"    : "html",
            "body"    : "html",
            "svg"     : "svg",
            "g"       : "svg",
            "circle"  : "svg",
            "elipse"  : "svg",
            "rect"    : "svg",
            "text"    : "svg",
            "polyline": "svg",
            "polygon" : "svg",
            "line"    : "svg"
        };

    return function parse(html) {
        var container = makeContainer(html),
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

            frag.startNode = frag.firstChild;
            frag.endNode = frag.lastChild;

            return frag;
        }
    }

    function makeContainer(html) {
        var m = matchOpenTag.exec(html),
            tag = m && containerElements[m[1].toLowerCase()] || "div";

        return tag ==="svg" ? document.createElementNS("http://www.w3.org/2000/svg", tag)
            : document.createElement(tag);
    }
});

define('cachedParse', ['parse'], function (parse) {
    var cache = {},
        DOCUMENT_FRAGMENT_NODE = 11;

    return function cachedParse(id, html) {
        var cached = cache[id],
            copy;

        if (cached === undefined) {
            cached = parse(html);
            cache[id] = cached;
        }

        copy = cached.cloneNode(true);

        if (copy.nodeType === DOCUMENT_FRAGMENT_NODE) {
            copy.startNode = copy.firstChild;
            copy.endNode = copy.lastChild;
        }

        return copy;
    }
})

define('Html', ['parse', 'cachedParse', 'domlib'], function (parse, cachedParse, domlib) {
    function Html(node, cache) {
        if (node.nodeType === undefined)
            node = cache ? cachedParse(node, cache) : parse(node);

        this.node = node;
    }

    Html.prototype = {
        child: function child(indices, fn) {
            var children = this.node.childNodes,
                len = indices.length,
                childShells = new Array(len),
                i, child;

            if (children === undefined)
                throw new Error("Shell.childNodes can only be applied to a node with a \n"
                    + ".childNodes collection.  Node ``" + this.node + "'' does not have one. \n"
                    + "Perhaps you applied it to the wrong node?");

            for (i = 0; i < len; i++) {
                child = children[indices[i]];
                if (!child)
                    throw new Error("Node ``" + this.node + "'' does not have a child at index " + i + ".");

                childShells[i] = new Html(child);
            }

            fn(childShells);

            return this;
        },

        property: function property(setter) {
            setter(this.node);
            return this;
        }
    };

    Html.addDirective = function addDirective(name, fn) {
        Html.prototype[name] = function directive(values) {
            Html.runDirective(fn, this.node, values);
            return this;
        };
    };

    Html.runDirective = function runDirective(fn, node, values) {
        values(fn(node));
    };

    Html.cleanup = function (node, fn) {
        // nothing right now -- this is primarily a hook for S.cleanup
        // will consider a non-S design, like perhaps adding a .cleanup()
        // closure to the node.
    };

    Html.domlib = domlib;

    return Html;
});

define('directives.attr', ['Html'], function (Html) {
    Html.addDirective('attr', function (node) {
        return function attr(name, value) {
            node.setAttribute(name, value);
        };
    });
});

define('directives.class', ['Html'], function (Html) {
    Html.addDirective('class', function (node) {
        if (node.className === undefined)
            throw new Error("@class can only be applied to an element that accepts class names. \n"
                + "Element ``" + node + "'' does not. Perhaps you applied it to the wrong node?");

        return function classDirective(on, off, flag) {
            if (arguments.length < 3) flag = off, off = null;

            var hasOn = Html.domlib.classListContains(node, on),
                hasOff = off && Html.domlib.classListContains(node, off);

            if (flag) {
                if (!hasOn) Html.domlib.classListAdd(node, on);
                if (off && hasOff) Html.domlib.classListRemove(node, off);
            } else {
                if (hasOn) Html.domlib.classListRemove(node, on);
                if (off && !hasOff) Html.domlib.classListAdd(node, off);
            }
        };
    });
});

define('directives.focus', ['Html'], function (Html) {
    Html.addDirective('focus', function focus(node) {
        return function focus(flag) {
            flag ? node.focus() : node.blur();
        };
    });
});

define('directives.insert', ['Html'], function (Html) {

    var DOCUMENT_FRAGMENT_NODE = 11;

    Html.addDirective('insert', function (node) {
        var parent,
            start,
            cursor;

        return function insert(value) {
            parent = node.parentNode;

            if (!parent)
                throw new Error("@insert can only be used on a node that has a parent node. \n"
                    + "Node ``" + node + "'' is currently unattached to a parent.");

            if (start) {
                if (start.parentNode !== parent)
                    throw new Error("@insert requires that the inserted nodes remain sibilings \n"
                        + "of the original node.  The DOM has been modified such that this is \n"
                        + "no longer the case.");

                //clear(start, node);
            } else start = marker(node);

            cursor = start;

            insertValue(value);

            clear(cursor, node);
        };

        // value ::
        //   null or undefined
        //   string
        //   node
        //   array of value
        function insertValue(value) {
            var next = cursor.nextSibling;

            if (value === null || value === undefined) {
                // nothing to insert
            } else if (value.nodeType === DOCUMENT_FRAGMENT_NODE) {
                // special case for document fragment that has already been emptied:
                // use the cached start and end nodes and insert as a range
                if (value.childNodes.length === 0 && value.startNode && value.endNode) {
                    insertRange(value.startNode, value.endNode);
                } else {
                    parent.insertBefore(value, next);
                    cursor = next.previousSibling;
                }
            } else if (value.nodeType /* instanceof Node */) {
                if (next !== value) {
                    parent.insertBefore(value, next);
                }
                cursor = value;
            } else if (Array.isArray(value)) {
                insertArray(value);
            } else {
                value = value.toString();

                if (next.nodeType !== 3 || next.data !== value) {
                    cursor = parent.insertBefore(document.createTextNode(value), next);
                } else {
                    cursor = next;
                }
            }
        }

        function insertArray(array) {
            var i, len, prev;
            for (i = 0, len = array.length; i < len; i++) {
                insertValue(array[i]);
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

        function insertRange(head, end) {
            var node,
                next = cursor.nextSibling;

            if (head.parentNode !== end.parentNode)
                throw new Error("Range must be siblings");

            do {
                node = head, head = head.nextSibling;

                if (!node) throw new Error("end must come after head");

                if (node !== next) {
                    parent.insertBefore(node, next);
                } else {
                    next = next.nextSibling;
                }
            } while (node !== end);

            cursor = end;
        }

        function clear(start, end) {
            if (start === end) return;
            var next = start.nextSibling;
            while (next !== end) {
                parent.removeChild(next);
                next = start.nextSibling;
            }
        }

        function marker(el) {
            return parent.insertBefore(document.createTextNode(""), el);
        }
    });
});

define('directives.onkey', ['Html'], function (Html) {
    Html.addDirective('onkey', function (node) {
        return function onkey(key, event, fn) {
            if (arguments.length < 3) fn = event, event = 'down';

            var keyCode = keyCodes[key.toLowerCase()];

            if (keyCode === undefined)
                throw new Error("@onkey: unrecognized key identifier '" + key + "'");

            if (typeof fn !== 'function')
                throw new Error("@onkey: must supply a function to call when the key is entered");

            Html.domlib.addEventListener(node, 'key' + event, onkeyListener);
            Html.cleanup(node, function () { Html.domlib.removeEventListener(node, 'key' + event, onkeyListener); });

            function onkeyListener(e) {
                if (e.keyCode === keyCode) fn();
                return true;
            }
        };
    });

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
        escape:     27,
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

});

(function (package) {
    if (typeof exports === 'object')
        package(require('S'), require('htmlliterals-runtime')); // CommonJS
    else if (typeof define === 'function')
        define(['S', 'htmlliterals-runtime'], package); // AMD
    else package(S, Html); // globals
})(function (S, Html) {

    Html.runDirective = function runDirective(fn, node, values) {
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
    };

    Html.cleanup = function cleanup(node, fn) {
        S.cleanup(fn);
    };

    Html.prototype.property = function property(setter) {
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

    Html.addDirective('data', function (node) {
        var signal = null,
            tag = node.nodeName,
            type = node.type && node.type.toUpperCase(),
            handler =
                tag === 'INPUT'         ? (
                    type === 'TEXT'     ? valueData    :
                    type === 'RADIO'    ? radioData    :
                    type === 'CHECKBOX' ? checkboxData :
                    null) :
                tag === 'TEXTAREA'      ? valueData    :
                tag === 'SELECT'        ? valueData    :
                null;

        if (!handler)
            throw new Error("@signal can only be applied to a form control element, \n"
                + "such as <input/>, <textarea/> or <select/>.  Element ``" + node + "'' is \n"
                + "not a recognized control.  Perhaps you applied it to the wrong node?");

        return handler();

        function valueData() {
            return function valueData(event, signal) {
                if (arguments.length < 2) signal = event, event = 'change';

                S(function updateValue() {
                    node.value = signal();
                });

                Html.domlib.addEventListener(node, event, valueListener);
                S.cleanup(function () { Html.domlib.removeEventListener(node, event, valueListener); });

                function valueListener() {
                    var cur = S.peek(signal),
                        update = node.value;
                    if (cur.toString() !== update) signal(update);
                    return true;
                }
            };
        }

        function checkboxData() {
            return function checkboxData(signal, on, off) {
                on = on === undefined ? true : on;
                off = off === undefined ? (on === true ? false : null) : off;

                S(function updateCheckbox() {
                    node.checked = (signal() === on);
                });

                Html.domlib.addEventListener(node, "change", checkboxListener);
                S.cleanup(function () { Html.domlib.removeEventListener(node, "change", checkboxListener); });

                function checkboxListener() {
                    signal(node.checked ? on : off);
                    return true;
                }
            };
        }

        function radioData() {
            return function radioData(signal, on) {
                on = on === undefined ? true : on;

                S(function updateRadio() {
                    node.checked = (signal() === on);
                });

                Html.domlib.addEventListener(node, "change", radioListener);
                S.cleanup(function () { Html.domlib.removeEventListener(node, "change", radioListener); });

                function radioListener() {
                    if (node.checked) signal(on);
                    return true;
                }
            };
        }
    });
});

(function (package) {
    if (typeof exports === 'object')
        package(require('S'), require('htmlliterals-runtime')); // CommonJS
    else if (typeof define === 'function')
        define(['S', 'htmlliterals-runtime'], package); // AMD
    else package(S, htmlliterals); // globals
})(function (S, htmlliterals) {
    var type = 'text/javascript-htmlliterals',
        config = window.surplus || {},
        XHR_DONE = 4;

    var scripts = S.array([]),
        i = 0;

    S(function surplusPreprocessQueue() {
        for (; i < scripts().length && scripts()[i].source() !== undefined; i++) {
            preprocess(scripts()[i]);
        }
    });

    preprocessAllScripts();

    function preprocessAllScripts() {
        var el,
            source;

        while (el = document.querySelector("script[type='" + type + "']")) {
            el.type += '-processed';
            if (el.src) {
                source = requestScript(el.src);
            } else {
                source = S.data(el.textContent || el.innerText || el.innerHTML);
            }
            scripts.push(new LiteralScript(el, source));
        }
    }

    function preprocess(lit) {
        var src = htmlliterals.preprocess(lit.source(), config),
            script = document.createElement('script'),
            parent = lit.el.parentNode,
            next = lit.el.nextSibling;

        script.type = 'text/javascript';
        script.src  = 'data:text/javascript;charset=utf-8,' + escape(src);
        script.async = lit.el.async;
        script.defer = lit.el.defer;

        if (next) {
            parent.insertBefore(script, next);
        } else {
            parent.appendNode(script);
        }
    }

    function requestScript(url) {
        var response = S.data(undefined),
            ajax = new window.XMLHttpRequest();

        ajax.open('GET', url, true);
        ajax.onreadystatechange = function surplusScriptRequest() {
			if (ajax.readyState === XHR_DONE) {
				if (ajax.status < 200 || ajax.status >= 300) {
                    throw new Error("surplus.js: error fetching file:" + url);
				} else {
                    response(ajax.responseText);
                }
			}
        }
        ajax.send();

        return response;
    }

    function LiteralScript(el, source) {
        this.el = el;
        this.source = source;
    }
});
