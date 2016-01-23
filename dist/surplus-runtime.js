/// <reference path="../S.d.ts" />
(function () {
    "use strict";
    // "Globals" used to keep track of current system state
    var Time = 1, // our clock, ticks every update
    Batching = 0, // whether we're batching data changes, 0 = no, 1+ = yes, with index to next Batch slot
    Batch = [], // batched changes to data nodes
    Updating = null, // whether we're updating, null = no, non-null = node being updated
    Sampling = false, // whether we're sampling signals, with no dependencies
    Disposing = false, // whether we're disposing
    Disposes = []; // disposals to run after current batch of changes finishes 
    var S = function S(fn, options) {
        var parent = Updating, gate = (options && options.async && Gate(options.async)) || (parent && parent.gate) || null, node = new ComputationNode(fn, gate);
        if (parent && (!options || !options.toplevel)) {
            (parent.children || (parent.children = [])).push(node);
        }
        Updating = node;
        if (Batching) {
            node.value = fn();
        }
        else {
            node.value = initialExecution(node, fn);
        }
        Updating = parent;
        return function computation() {
            if (Disposing) {
                if (Batching)
                    Disposes.push(node);
                else
                    node.dispose();
            }
            else if (Updating && node.fn) {
                if (node.receiver && node.receiver.marks !== 0 && node.receiver.age === Time) {
                    backtrack(node.receiver);
                }
                if (!Sampling) {
                    if (!node.emitter)
                        node.emitter = new Emitter(node);
                    addEdge(node.emitter, Updating);
                }
            }
            return node.value;
        };
    };
    function initialExecution(node, fn) {
        var result;
        Time++;
        Batching = 1;
        try {
            result = fn();
            if (Batching > 1)
                resolve(null);
        }
        finally {
            Updating = null;
            Batching = 0;
        }
        return result;
    }
    S.data = function data(value) {
        var node = new DataNode(value);
        return function data(value) {
            if (arguments.length > 0) {
                if (Batching) {
                    if (node.age === Time) {
                        if (value !== node.pending) {
                            throw new Error("conflicting changes: " + value + " !== " + node.pending);
                        }
                    }
                    else {
                        node.age = Time;
                        node.pending = value;
                        Batch[Batching++] = node;
                    }
                }
                else {
                    node.age = Time;
                    node.value = value;
                    if (node.emitter)
                        handleEvent(node);
                }
                return value;
            }
            else {
                if (Updating && !Sampling) {
                    if (!node.emitter)
                        node.emitter = new Emitter(null);
                    addEdge(node.emitter, Updating);
                }
                return node.value;
            }
        };
    };
    S.sum = function sum(value) {
        var node = new DataNode(value);
        return function sum(update) {
            if (arguments.length > 0) {
                if (Batching) {
                    if (node.age === Time) {
                        node.pending = update(node.pending);
                    }
                    else {
                        node.age = Time;
                        node.pending = update(node.value);
                        Batch[Batching++] = node;
                    }
                }
                else {
                    node.age = Time;
                    node.value = update(node.value);
                    if (node.emitter)
                        handleEvent(node);
                }
                return value;
            }
            else {
                if (Updating && !Sampling) {
                    if (!node.emitter)
                        node.emitter = new Emitter(null);
                    addEdge(node.emitter, Updating);
                }
                return node.value;
            }
        };
    };
    S.on = function on(ev, fn, seed, options) {
        var first = true;
        return S(on, options);
        function on() { typeof ev === 'function' ? ev() : multi(); first ? first = false : S.sample(next); return seed; }
        function next() { seed = fn(seed); }
        function multi() { for (var i = 0; i < ev.length; i++)
            ev[i](); }
    };
    function Gate(scheduler) {
        var root = new DataNode(null), scheduled = false, gotime = 0, tick;
        root.emitter = new Emitter(null);
        return function gate(node) {
            if (gotime === Time)
                return true;
            if (typeof tick === 'function')
                tick();
            else if (!scheduled) {
                scheduled = true;
                tick = scheduler(go);
            }
            addEdge(root.emitter, node);
            return false;
        };
        function go() {
            if (gotime === Time)
                return;
            scheduled = false;
            gotime = Time + 1;
            if (Batching) {
                Batch[Batching++] = root;
            }
            else {
                handleEvent(root);
            }
        }
    }
    ;
    S.event = function event(fn) {
        var result;
        if (Batching) {
            result = fn();
        }
        else {
            Batching = 1;
            try {
                result = fn();
                handleEvent(null);
            }
            finally {
                Batching = 0;
            }
        }
        return result;
    };
    S.sample = function sample(fn) {
        var result;
        if (Updating && !Sampling) {
            Sampling = true;
            result = fn();
            Sampling = false;
        }
        else {
            result = fn();
        }
        return result;
    };
    S.dispose = function dispose(signal) {
        if (Disposing) {
            signal();
        }
        else {
            Disposing = true;
            try {
                signal();
            }
            finally {
                Disposing = false;
            }
        }
    };
    S.cleanup = function cleanup(fn) {
        if (Updating) {
            (Updating.cleanups || (Updating.cleanups = [])).push(fn);
        }
        else {
            throw new Error("S.cleanup() must be called from within an S() computation.  Cannot call it at toplevel.");
        }
    };
    function handleEvent(change) {
        try {
            resolve(change);
        }
        finally {
            Batching = 0;
            Updating = null;
            Sampling = false;
            Disposing = false;
        }
    }
    var _batch = [];
    function resolve(change) {
        var count = 0, batch, i, len;
        if (!Batching)
            Batching = 1;
        if (change) {
            Time++;
            prepare(change.emitter);
            notify(change.emitter);
            i = -1, len = Disposes.length;
            if (len) {
                while (++i < len)
                    Disposes[i].dispose();
                Disposes = [];
            }
        }
        // for each batch ...
        while (Batching !== 1) {
            // prepare globals to record next batch
            Time++;
            batch = Batch, Batch = _batch, _batch = batch; // rotate batch arrays
            len = Batching, Batching = 1;
            // set nodes' values, clear pending data, and prepare them for update
            i = 0;
            while (++i < len) {
                change = batch[i];
                change.value = change.pending;
                change.pending = undefined;
                if (change.emitter)
                    prepare(change.emitter);
            }
            // run all updates in batch
            i = 0;
            while (++i < len) {
                change = batch[i];
                if (change.emitter)
                    notify(change.emitter);
                batch[i] = null;
            }
            // run disposes accumulated while updating
            i = -1, len = Disposes.length;
            if (len) {
                while (++i < len)
                    Disposes[i].dispose();
                Disposes = [];
            }
            // if there are still changes after excessive batches, assume runaway            
            if (count++ > 1e5) {
                throw new Error("Runaway frames detected");
            }
        }
    }
    /// mark the node and all downstream nodes as within the range to be updated
    function prepare(emitter) {
        var edges = emitter.edges, i = -1, len = edges.length, edge, to, node, toEmitter;
        emitter.emitting = true;
        while (++i < len) {
            edge = edges[i];
            if (edge && (!edge.boundary || edge.to.node.gate(edge.to.node))) {
                to = edge.to;
                node = to.node;
                toEmitter = node.emitter;
                // if an earlier update threw an exception, marks may be dirty - clear it now
                if (to.marks !== 0 && to.age < Time) {
                    to.marks = 0;
                    if (toEmitter)
                        toEmitter.emitting = false;
                }
                // if we've come back to an emitting Emitter, that's a cycle
                if (toEmitter && toEmitter.emitting)
                    throw new Error("circular dependency"); // TODO: more helpful reporting
                edge.marked = true;
                to.marks++;
                to.age = Time;
                // if this is the first time to's been marked, then prepare children propagate
                if (to.marks === 1) {
                    if (node.children)
                        prepareChildren(node.children);
                    if (toEmitter)
                        prepare(toEmitter);
                }
            }
        }
        emitter.emitting = false;
    }
    function prepareChildren(children) {
        var i = -1, len = children.length, child;
        while (++i < len) {
            child = children[i];
            child.fn = null;
            if (child.children)
                prepareChildren(child.children);
        }
    }
    function notify(emitter) {
        var i = -1, len = emitter.edges.length, edge, to;
        while (++i < len) {
            edge = emitter.edges[i];
            if (edge && edge.marked) {
                to = edge.to;
                edge.marked = false;
                to.marks--;
                if (to.marks === 0) {
                    update(to.node);
                }
            }
        }
        if (emitter.fragmented())
            emitter.compact();
    }
    /// update the given node by re-executing any payload, updating inbound links, then updating all downstream nodes
    function update(node) {
        var emitter = node.emitter, receiver = node.receiver, disposing = node.fn === null, i, len, edge, to;
        Updating = node;
        disposeChildren(node);
        node.cleanup(disposing);
        if (!disposing)
            node.value = node.fn();
        if (emitter) {
            // this is the content of notify(emitter), inserted to shorten call stack for ergonomics
            i = -1, len = emitter.edges.length;
            while (++i < len) {
                edge = emitter.edges[i];
                if (edge && edge.marked) {
                    to = edge.to;
                    edge.marked = false;
                    to.marks--;
                    if (to.marks === 0) {
                        update(to.node);
                    }
                }
            }
            if (disposing) {
                emitter.detach();
            }
            else if (emitter.fragmented())
                emitter.compact();
        }
        if (receiver) {
            if (disposing) {
                receiver.detach();
            }
            else {
                i = -1, len = receiver.edges.length;
                while (++i < len) {
                    edge = receiver.edges[i];
                    if (edge.active && edge.age < Time) {
                        edge.deactivate();
                    }
                }
                if (receiver.fragmented())
                    receiver.compact();
            }
        }
    }
    function disposeChildren(node) {
        if (!node.children)
            return;
        var i = -1, len = node.children.length, child;
        while (++i < len) {
            child = node.children[i];
            if (!child.receiver || child.receiver.age < Time) {
                disposeChildren(child);
                child.dispose();
            }
        }
        node.children = null;
    }
    /// update the given node by backtracking its dependencies to clean state and updating from there
    function backtrack(receiver) {
        var updating = Updating, sampling = Sampling;
        backtrack(receiver);
        Updating = updating;
        Sampling = sampling;
        function backtrack(receiver) {
            var i = -1, len = receiver.edges.length, edge;
            while (++i < len) {
                edge = receiver.edges[i];
                if (edge && edge.marked) {
                    if (edge.from.node && edge.from.node.receiver.marks) {
                        // keep working backwards through the marked nodes ...
                        backtrack(edge.from.node.receiver);
                    }
                    else {
                        // ... until we find clean state, from which to start updating
                        notify(edge.from);
                    }
                }
            }
        }
    }
    /// Graph classes and operations
    var DataNode = (function () {
        function DataNode(value) {
            this.value = value;
            this.age = 0; // Data nodes start at a time prior to the present, or else they can't be set in the current frame
            this.emitter = null;
        }
        return DataNode;
    })();
    var ComputationNode = (function () {
        function ComputationNode(fn, gate) {
            this.fn = fn;
            this.gate = gate;
            this.emitter = null;
            this.receiver = null;
            // children and cleanups generated by last update
            this.children = null;
            this.cleanups = null;
        }
        // dispose node: free memory, dispose children, cleanup, detach from graph
        ComputationNode.prototype.dispose = function () {
            if (!this.fn)
                return;
            this.fn = null;
            this.gate = null;
            if (this.children) {
                var i = -1, len = this.children.length;
                while (++i < len) {
                    this.children[i].dispose();
                }
            }
            this.cleanup(true);
            if (this.receiver)
                this.receiver.detach();
            if (this.emitter)
                this.emitter.detach();
        };
        ComputationNode.prototype.cleanup = function (final) {
            if (this.cleanups) {
                var i = -1, len = this.cleanups.length;
                while (++i < len) {
                    this.cleanups[i](final);
                }
                this.cleanups = null;
            }
        };
        return ComputationNode;
    })();
    var Emitter = (function () {
        function Emitter(node) {
            this.node = node;
            this.id = Emitter.count++;
            this.emitting = false;
            this.edges = [];
            this.index = [];
            this.active = 0;
            this.edgesAge = 0;
        }
        Emitter.prototype.detach = function () {
            var i = -1, len = this.edges.length, edge;
            while (++i < len) {
                edge = this.edges[i];
                if (edge)
                    edge.deactivate();
            }
        };
        Emitter.prototype.fragmented = function () {
            return this.edges.length > 10 && this.edges.length / this.active > 4;
        };
        Emitter.prototype.compact = function () {
            var i = -1, len = this.edges.length, edges = [], compaction = ++this.edgesAge, edge;
            while (++i < len) {
                edge = this.edges[i];
                if (edge) {
                    edge.slot = edges.length;
                    edge.slotAge = compaction;
                    edges.push(edge);
                }
            }
            this.edges = edges;
        };
        Emitter.count = 0;
        return Emitter;
    })();
    function addEdge(from, to) {
        var edge = null;
        if (!to.receiver)
            to.receiver = new Receiver(to);
        else
            edge = to.receiver.index[from.id];
        if (edge)
            edge.activate(from);
        else
            new Edge(from, to.receiver, to.gate && (from.node === null || to.gate !== from.node.gate));
    }
    var Receiver = (function () {
        function Receiver(node) {
            this.node = node;
            this.id = Emitter.count++;
            this.marks = 0;
            this.age = Time;
            this.edges = [];
            this.index = [];
            this.active = 0;
        }
        Receiver.prototype.detach = function () {
            var i = -1, len = this.edges.length;
            while (++i < len) {
                this.edges[i].deactivate();
            }
        };
        Receiver.prototype.fragmented = function () {
            return this.edges.length > 10 && this.edges.length / this.active > 4;
        };
        Receiver.prototype.compact = function () {
            var i = -1, len = this.edges.length, edges = [], index = [], edge;
            while (++i < len) {
                edge = this.edges[i];
                if (edge.active) {
                    edges.push(edge);
                    index[edge.from.id] = edge;
                }
            }
            this.edges = edges;
            this.index = index;
        };
        Receiver.count = 0;
        return Receiver;
    })();
    var Edge = (function () {
        function Edge(from, to, boundary) {
            this.from = from;
            this.to = to;
            this.boundary = boundary;
            this.age = Time;
            this.active = true;
            this.marked = false;
            this.slot = from.edges.length;
            this.slotAge = from.edgesAge;
            from.edges.push(this);
            to.edges.push(this);
            to.index[from.id] = this;
            from.active++;
            to.active++;
        }
        Edge.prototype.activate = function (from) {
            if (!this.active) {
                this.active = true;
                if (this.slotAge === from.edgesAge) {
                    from.edges[this.slot] = this;
                }
                else {
                    this.slotAge = from.edgesAge;
                    this.slot = from.edges.length;
                    from.edges.push(this);
                }
                this.to.active++;
                from.active++;
                this.from = from;
            }
            this.age = Time;
        };
        Edge.prototype.deactivate = function () {
            if (!this.active)
                return;
            var from = this.from, to = this.to;
            this.active = false;
            from.edges[this.slot] = null;
            from.active--;
            to.active--;
            this.from = null;
        };
        return Edge;
    })();
    // UMD exporter
    /* globals define */
    if (typeof module === 'object' && typeof module.exports === 'object') {
        module.exports = S; // CommonJS
    }
    else if (typeof define === 'function') {
        define([], function () { return S; }); // AMD
    }
    else {
        (eval || function () { })("this").S = S; // fallback to global object
    }
})();

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

        var data = S.data(values);

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
        
        function array(newvalues) {
            if (arguments.length > 0) {
                values = newvalues;
                return data(newvalues);
            } else {
                return data();
            }
        }
        
        // mutators
        function push(item) {
            values.push(item);
            data(values);
            return array;
        }
    
        function pop(item) {
            var value = values.pop();
            data(values);
            return value;
        }
    
        function unshift(item) {
            values.unshift(item);
            data(values);
            return array;
        }
    
        function shift(item) {
            var value = values.shift();
            data(values);
            return value;
        }
    
        function splice(index, count, item) {
            Array.prototype.splice.apply(values, arguments);
            data(values);
            return array;
        }
    
        function remove(item) {
            for (var i = 0; i < values.length; i++) {
                if (values[i] === item) {
                    values.splice(i, 1);
                    break;
                }
            }
            
            data(values);
            return array;
        }
    
        function removeAll(item) {
            var i = 0;
    
            while (i < values.length) {
                if (values[i] === item) {
                    values.splice(i, 1);
                } else {
                    i++;
                }
            }
            
            data(values);
            return array;
        }
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
        s.async        = async;

        return s;
    }

    function mapS(fn) {
        var seq = this,
            items = [],
            mapped = [],
            len = 0;

        var mapS = S(function mapS() {
            var new_items = seq(),
                new_len = new_items.length,
                temp = new Array(new_len),
                i, j, k, item;

            // 1) step through all old items and see if they can be found in the new set; if so, save them in a temp array and mark them moved; if not, exit them
            NEXT:
            for (i = 0, k = 0; i < len; i++) {
                item = mapped[i];
                for (j = 0; j < new_len; j++, k = (k + 1) % new_len) {
                    if (items[i] === new_items[k] && !temp.hasOwnProperty(k)) {
                        temp[k] = item;
                        k = (k + 1) % new_len;
                        continue NEXT;
                    }
                }
                S.dispose(item);
            }

            // 2) set all the new values, pulling from the temp array if copied, otherwise entering the new value
            for (i = 0; i < new_len; i++) {
                if (temp.hasOwnProperty(i)) {
                    mapped[i] = temp[i];
                } else {
                    item = new_items[i];
                    mapped[i] = (function (item, i) { 
                        return S(function () { return fn(item, i); }, { toplevel: true }); 
                    })(item, i);
                }
            }
            
            S.cleanup(function (final) { if (final) mapped.map(S.dispose); });

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

        var forEach = S(function forEach() {
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
                S.sample(function forEach() {
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

    // schedulers
    function async(scheduler) {
        return transformer(S.async(scheduler).S(this));
    }
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
    // default (conformant) implementations
    var domlib = {
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
        },
        
        isContentEditable: function (el) {
            return el.isContentEditable;
        },
        
        isAttachedToDocument: function (el) {
            return (document.compareDocumentPosition(el) & 1) === 0;
        }
    };
    
    // shims for broken and/or older browsers
    if (!browserSetsIsContentEditablePropertyReliably())
        useContentEditableAttribute();
    
    return domlib;
    
    // Element.isContentEditable is currently broken on Chrome.  It returns false for non-displayed elements. See https://code.google.com/p/chromium/issues/detail?id=313082 .
    function browserSetsIsContentEditablePropertyReliably() {
        var div = document.createElement("div");
        div.innerHTML = '<div contentEditable="true"></div>';
        return div.children[0].isContentEditable === true;
    }
    
    function useContentEditableAttribute() {
        domlib.isContentEditable = function (el) {
            var contentEditable = el.getAttribute("contentEditable");
            return contentEditable === "true" || contentEditable === "";
        }
    }
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
            "line"    : "svg",
            "path"    : "svg"
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
        },
        
        mixin: function mixin(fn) {
            fn()(this.node);
            return this;
        }
    };

    Html.cleanup = function (node, fn) {
        // nothing right now -- this is primarily a hook for S.cleanup
        // will consider a non-S design, like perhaps adding a .cleanup()
        // closure to the node.
    };

    Html.domlib = domlib;

    return Html;
});

define('Html.insert', ['Html'], function (Html) {
    var DOCUMENT_FRAGMENT_NODE = 11,
        TEXT_NODE = 3;
        
    Html.prototype.insert = function insert(value) {
        var node = this.node,
            parent = node.parentNode,
            start = marker(node),
            cursor = start;

        return this.mixin(insert);

        function insert() {
            return function insert(node, state) {
                parent = node.parentNode;
    
                if (!parent) {
                    throw new Error("@insert can only be used on a node that has a parent node. \n"
                        + "Node ``" + node + "'' is currently unattached to a parent.");
                }
                
                if (start.parentNode !== parent) {
                    throw new Error("@insert requires that the inserted nodes remain sibilings \n"
                        + "of the original node.  The DOM has been modified such that this is \n"
                        + "no longer the case.");
                }
    
                // set our cursor to the start of the insert range
                cursor = start;
    
                // insert the current value
                insertValue(value());
    
                // remove anything left after the cursor from the insert range
                clear(cursor, node);
            };
        }

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
                    if (next.nextSibling === value && next !== value.nextSibling) {
                        parent.removeChild(next);
                    } else {
                        parent.insertBefore(value, next);
                    }
                }
                cursor = value;
            } else if (Array.isArray(value)) {
                insertArray(value);
            } else {
                value = value.toString();

                if (next.nodeType !== TEXT_NODE) {
                    cursor = parent.insertBefore(document.createTextNode(value), next);
                } else {
                    if (next.data !== value) {
                        next.data = value;
                    }
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
    };
});

define('Html.attr', ['Html'], function (Html) {
    Html.attr = function attr(name, value) {
        return function attr(node) {
            node.setAttribute(name, value);
        };
    };
});

define('Html.class', ['Html'], function (Html) {
    Html.class = function classMixin(on, off, flag) {            
        if (arguments.length < 3) flag = off, off = null;
            
        return function classMixin(node, state) {
            if (node.className === undefined)
                throw new Error("@class can only be applied to an element that accepts class names. \n"
                    + "Element ``" + node + "'' does not. Perhaps you applied it to the wrong node?");
                    
            if (flag === state) return state;

            var hasOn = Html.domlib.classListContains(node, on),
                hasOff = off && Html.domlib.classListContains(node, off);

            if (flag) {
                if (!hasOn) Html.domlib.classListAdd(node, on);
                if (off && hasOff) Html.domlib.classListRemove(node, off);
            } else {
                if (hasOn) Html.domlib.classListRemove(node, on);
                if (off && !hasOff) Html.domlib.classListAdd(node, off);
            }
            
            return flag;
        };
    };
});

define('Html.focus', ['Html'], function (Html) {
    /**
     * In htmlliterals, directives run when a node is created, meaning before it has usually
     * been inserted into the document.  This causes a problem for the @focus directive, as only
     * elements that are in the document (and visible) are focusable.  As a hack, we delay
     * the focus event until the next animation frame, thereby giving htmlliterals a chance
     * to get the node into the document.  If it isn't in by then (or if the user tried to focus
     * a hidden node) then we give up.
     */
    var nodeToFocus = null,
        startPos = NaN,
        endPos = NaN,
        scheduled = false;
    
    Html.focus = function focus(flag, start, end) {
        start = arguments.length > 1 ? start : NaN;
        end = arguments.length > 2 ? end : start;
        
        return function focus(node) {
            if (!node.focus) {
                throw new Error("@focus can only be applied to an element that has a .focus() method, like <input>, <select>, <textarea>, etc.");
            }
                
            if (flag) {
                nodeToFocus = node;
                startPos = start;
                endPos = end;
                if (!scheduled) window.requestAnimationFrame(focuser);
            } else {
                node.blur();
            }
        };
    };
    
    function focuser() {
        scheduled = false;
        
        var start = startPos < 0 ? nodeToFocus.textContent.length + startPos + 1 : startPos,
            end = endPos < 0 ? nodeToFocus.textContent.length + endPos + 1 : endPos,
            range, sel;
        
        nodeToFocus.focus();
        
        if (!isNaN(start)) {
            if (nodeToFocus.setSelectionRange) {
                nodeToFocus.setSelectionRange(start, end);
            } else if (nodeToFocus.createTextRange) {
                range = nodeToFocus.createTextRange();
                range.moveEnd('character', end);
                range.moveStart('character', start);
                range.select();
            } else if (Html.domlib.isContentEditable(nodeToFocus) && nodeToFocus.childNodes.length > 0) {
                range = document.createRange();
                range.setStart(nodeToFocus.childNodes[0], start);
                range.setEnd(nodeToFocus.childNodes[0], end);
                sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        }
    }
});

define('Html.onkey', ['Html'], function (Html) {
    Html.onkey = function onkey(key, event, fn) {
        if (arguments.length < 3) fn = event, event = 'down';

        var parts = key.toLowerCase().split('-', 2),
            keyCode = keyCodes[parts[parts.length - 1]],
            mod = parts.length > 1 ? parts[0] + "Key" : null;

        if (keyCode === undefined)
            throw new Error("@Html.onkey: unrecognized key identifier '" + key + "'");

        if (typeof fn !== 'function')
            throw new Error("@Html.onkey: must supply a function to call when the key is entered");
            
        return function (node) {
            Html.domlib.addEventListener(node, 'key' + event, onkeyListener);
            Html.cleanup(node, function () { Html.domlib.removeEventListener(node, 'key' + event, onkeyListener); });
        };
        
        function onkeyListener(e) {
            if (e.keyCode === keyCode && (!mod || e[mod])) fn(e);
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
    "use strict";

    Html.prototype.mixin = function mixin(fn) {
        var node = this.node,
            state;

        //var logFn = function() {
        //    var args = Array.prototype.slice.call(arguments);
        //    console.log("[@" + name + "(" + args.join(", ") + ")]");
        //    fn.apply(undefined, args);
        //};

        S(function mixin() {
            //values(logFn);
            state = fn()(node, state);
        });
        
        return this;
    };

    Html.prototype.property = function property(setter) {
        var node = this.node;

        //var logSetter = function (node) {
        //    var msg = setter.toString().substr(18); // remove "function () { __."
        //    msg = msg.substr(0, msg.length - 3); // remove "; }"
        //    console.log("[@" + node.nodeName + msg + "]");
        //    setter(node);
        //};

        S(function property() {
            //logSetter(node);
            setter(node);
        });

        return this;
    };

    Html.cleanup = function cleanup(node, fn) {
        S.cleanup(fn);
    };
    
    Html.data = function(signal, arg1, arg2) {
        return function (node) {
            var tag = node.nodeName,
                type = node.type && node.type.toUpperCase(),
                handler =
                    tag === 'INPUT'         ? (
                        type === 'TEXT'                 ? valueData       :
                        type === 'RADIO'                ? radioData       :
                        type === 'CHECKBOX'             ? checkboxData    :
                        null) :
                    tag === 'TEXTAREA'                  ? valueData       :
                    tag === 'SELECT'                    ? valueData       :
                    Html.domlib.isContentEditable(node) ? textContentData :
                    null;
    
            if (!handler)
                throw new Error("@data can only be applied to a form control element, \n"
                    + "such as <input/>, <textarea/> or <select/>, or to an element with "
                    + "'contentEditable' set.  Element ``" + tag + "'' is \n"
                    + "not such an element.  Perhaps you applied it to the wrong node?");
    
            return handler();
    
            function valueData() {
                var event = arg1 || 'change';

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
            }
    
            function checkboxData() {
                var on = arg1 === undefined ? true : arg1,
                    off = arg2 === undefined ? (on === true ? false : null) : arg2;

                S(function updateCheckbox() {
                    node.checked = (signal() === on);
                });

                Html.domlib.addEventListener(node, "change", checkboxListener);
                S.cleanup(function () { Html.domlib.removeEventListener(node, "change", checkboxListener); });

                function checkboxListener() {
                    signal(node.checked ? on : off);
                    return true;
                }
            }
    
            function radioData() {
                var on = arg1 === undefined ? true : arg1;

                S(function updateRadio() {
                    node.checked = (signal() === on);
                });

                Html.domlib.addEventListener(node, "change", radioListener);
                S.cleanup(function () { Html.domlib.removeEventListener(node, "change", radioListener); });

                function radioListener() {
                    if (node.checked) signal(on);
                    return true;
                }
            }
            
            function textContentData() {
                var event = arg1 || 'input';

                S(function updateTextContent() {
                    node.textContent = signal();
                });

                Html.domlib.addEventListener(node, event, textContentListener);
                S.cleanup(function () { Html.domlib.removeEventListener(node, event, textContentListener); });

                function textContentListener() {
                    var cur = S.peek(signal),
                        update = node.textContent;
                    if (cur.toString() !== update) signal(update);
                    return true;
                }
            }
        };
    };
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
