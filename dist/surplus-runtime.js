/// <reference path="../S.d.ts" />
(function () {
    "use strict";
    // Public interface
    var S = function S(fn, seed) {
        var owner = Owner, clock = RunningClock || RootClock, running = RunningNode;
        if (!owner)
            throw new Error("all computations must be created under a parent computation or root");
        var node = new ComputationNode(clock, fn, seed);
        Owner = RunningNode = node;
        if (RunningClock) {
            node.value = node.fn(node.value);
        }
        else {
            toplevelComputation(node);
        }
        if (owner !== UNOWNED)
            (owner.owned || (owner.owned = [])).push(node);
        Owner = owner;
        RunningNode = running;
        return function computation() {
            if (RunningNode) {
                var rclock = RunningClock, sclock = node.clock;
                while (rclock.depth > sclock.depth + 1)
                    rclock = rclock.parent;
                if (rclock === sclock || rclock.parent === sclock) {
                    if (node.preclocks) {
                        for (var i = 0; i < node.preclocks.count; i++) {
                            var preclock = node.preclocks.clocks[i];
                            updateClock(preclock);
                        }
                    }
                    if (node.age === node.clock.time()) {
                        if (node.state === RUNNING)
                            throw new Error("circular dependency");
                        else
                            updateNode(node); // checks for state === STALE internally, so don't need to check here
                    }
                    if (node.preclocks) {
                        for (var i = 0; i < node.preclocks.count; i++) {
                            var preclock = node.preclocks.clocks[i];
                            if (rclock === sclock)
                                logNodePreClock(preclock, RunningNode);
                            else
                                logClockPreClock(preclock, rclock, RunningNode);
                        }
                    }
                }
                else {
                    if (rclock.depth > sclock.depth)
                        rclock = rclock.parent;
                    while (sclock.depth > rclock.depth + 1)
                        sclock = sclock.parent;
                    if (sclock.parent === rclock) {
                        logNodePreClock(sclock, RunningNode);
                    }
                    else {
                        if (sclock.depth > rclock.depth)
                            sclock = sclock.parent;
                        while (rclock.parent !== sclock.parent)
                            rclock = rclock.parent, sclock = sclock.parent;
                        logClockPreClock(sclock, rclock, RunningNode);
                    }
                    updateClock(sclock);
                }
                logComputationRead(node, RunningNode);
            }
            return node.value;
        };
    };
    S.root = function root(fn) {
        var owner = Owner, root = fn.length === 0 ? UNOWNED : new ComputationNode(RunningClock || RootClock, null, null), result = undefined;
        Owner = root;
        try {
            result = fn.length === 0 ? fn() : fn(function _dispose() {
                if (RunningClock) {
                    markClockStale(root.clock);
                    root.clock.disposes.add(root);
                }
                else {
                    dispose(root);
                }
            });
        }
        finally {
            Owner = owner;
        }
        return result;
    };
    S.on = function on(ev, fn, seed, onchanges) {
        if (Array.isArray(ev))
            ev = callAll(ev);
        onchanges = !!onchanges;
        return S(on, seed);
        function on(value) {
            var running = RunningNode;
            ev();
            if (onchanges)
                onchanges = false;
            else {
                RunningNode = null;
                value = fn(value);
                RunningNode = running;
            }
            return value;
        }
    };
    function callAll(ss) {
        return function all() {
            for (var i = 0; i < ss.length; i++)
                ss[i]();
        };
    }
    S.data = function data(value) {
        var node = new DataNode(RunningClock || RootClock, value);
        return function data(value) {
            var rclock = RunningClock, sclock = node.clock;
            if (RunningClock) {
                while (rclock.depth > sclock.depth)
                    rclock = rclock.parent;
                while (sclock.depth > rclock.depth && sclock.parent !== rclock)
                    sclock = sclock.parent;
                if (sclock.parent !== rclock)
                    while (rclock.parent !== sclock.parent)
                        rclock = rclock.parent, sclock = sclock.parent;
                if (rclock !== sclock) {
                    updateClock(sclock);
                }
            }
            var cclock = rclock === sclock ? sclock : sclock.parent;
            if (arguments.length > 0) {
                if (RunningClock) {
                    if (node.pending !== NOTPENDING) {
                        if (value !== node.pending) {
                            throw new Error("conflicting changes: " + value + " !== " + node.pending);
                        }
                    }
                    else {
                        markClockStale(cclock);
                        node.pending = value;
                        cclock.changes.add(node);
                    }
                }
                else {
                    if (node.log) {
                        node.pending = value;
                        RootClock.changes.add(node);
                        event();
                    }
                    else {
                        node.value = value;
                    }
                }
                return value;
            }
            else {
                if (RunningNode) {
                    logDataRead(node, RunningNode);
                    if (sclock.parent === rclock)
                        logNodePreClock(sclock, RunningNode);
                    else if (sclock !== rclock)
                        logClockPreClock(sclock, rclock, RunningNode);
                }
                return node.value;
            }
        };
    };
    S.value = function value(current, eq) {
        var data = S.data(current), clock = RunningClock || RootClock, age = 0;
        return function value(update) {
            if (arguments.length === 0) {
                return data();
            }
            else {
                var same = eq ? eq(current, update) : current === update;
                if (!same) {
                    var time = clock.time();
                    if (age === time)
                        throw new Error("conflicting values: " + value + " is not the same as " + current);
                    age = time;
                    current = update;
                    data(update);
                }
                return update;
            }
        };
    };
    S.freeze = function freeze(fn) {
        var result = undefined;
        if (RunningClock) {
            result = fn();
        }
        else {
            RunningClock = RootClock;
            RunningClock.changes.reset();
            try {
                result = fn();
                event();
            }
            finally {
                RunningClock = null;
            }
        }
        return result;
    };
    S.sample = function sample(fn) {
        var result, running = RunningNode;
        if (running) {
            RunningNode = null;
            result = fn();
            RunningNode = running;
        }
        else {
            result = fn();
        }
        return result;
    };
    S.cleanup = function cleanup(fn) {
        if (Owner) {
            (Owner.cleanups || (Owner.cleanups = [])).push(fn);
        }
        else {
            throw new Error("S.cleanup() must be called from within an S() computation.  Cannot call it at toplevel.");
        }
    };
    S.subclock = function subclock(fn) {
        var clock = new Clock(RunningClock || RootClock);
        return fn ? subclock(fn) : subclock;
        function subclock(fn) {
            var result = null, running = RunningClock;
            RunningClock = clock;
            clock.state = STALE;
            try {
                result = fn();
                clock.subtime++;
                run(clock);
            }
            finally {
                RunningClock = running;
            }
            return result;
        }
    };
    // Internal implementation
    /// Graph classes and operations
    var Clock = (function () {
        function Clock(parent) {
            this.parent = parent;
            this.id = Clock.count++;
            this.state = CURRENT;
            this.subtime = 0;
            this.preclocks = null;
            this.changes = new Queue(); // batched changes to data nodes
            this.subclocks = new Queue(); // subclocks that need to be updated
            this.updates = new Queue(); // computations to update
            this.disposes = new Queue(); // disposals to run after current batch of updates finishes
            if (parent) {
                this.age = parent.time();
                this.depth = parent.depth + 1;
            }
            else {
                this.age = 0;
                this.depth = 0;
            }
        }
        Clock.prototype.time = function () {
            var time = this.subtime, p = this;
            while (p = p.parent)
                time += p.subtime;
            return time;
        };
        return Clock;
    }());
    Clock.count = 0;
    var DataNode = (function () {
        function DataNode(clock, value) {
            this.clock = clock;
            this.value = value;
            this.pending = NOTPENDING;
            this.log = null;
        }
        return DataNode;
    }());
    var ComputationNode = (function () {
        function ComputationNode(clock, fn, value) {
            this.clock = clock;
            this.fn = fn;
            this.value = value;
            this.state = CURRENT;
            this.count = 0;
            this.sources = [];
            this.sourceslots = [];
            this.log = null;
            this.preclocks = null;
            this.owned = null;
            this.cleanups = null;
            this.age = this.clock.time();
        }
        return ComputationNode;
    }());
    var Log = (function () {
        function Log() {
            this.count = 0;
            this.nodes = [];
            this.nodeslots = [];
            this.freecount = 0;
            this.freeslots = [];
        }
        return Log;
    }());
    var NodePreClockLog = (function () {
        function NodePreClockLog() {
            this.count = 0;
            this.clocks = []; // [clock], where clock.parent === node.clock
            this.ages = []; // clock.id -> node.age
            this.ucount = 0; // number of ancestor clocks with preclocks from this node
            this.uclocks = [];
            this.uclockids = [];
        }
        return NodePreClockLog;
    }());
    var ClockPreClockLog = (function () {
        function ClockPreClockLog() {
            this.count = 0;
            this.clockcounts = []; // clock.id -> ref count
            this.clocks = []; // clock.id -> clock 
            this.ids = []; // [clock.id]
        }
        return ClockPreClockLog;
    }());
    var Queue = (function () {
        function Queue() {
            this.items = [];
            this.count = 0;
        }
        Queue.prototype.reset = function () {
            this.count = 0;
        };
        Queue.prototype.add = function (item) {
            this.items[this.count++] = item;
        };
        Queue.prototype.run = function (fn) {
            var items = this.items;
            for (var i = 0; i < this.count; i++) {
                fn(items[i]);
                items[i] = null;
            }
            this.count = 0;
        };
        return Queue;
    }());
    // Constants
    var NOTPENDING = {}, CURRENT = 0, STALE = 1, RUNNING = 2;
    // "Globals" used to keep track of current system state
    var RootClock = new Clock(null), RunningClock = null, // currently running clock 
    RunningNode = null, // currently running computation
    Owner = null; // owner for new computations
    // Constants
    var UNOWNED = new ComputationNode(RootClock, null, null);
    // Functions
    function logRead(from, to) {
        var fromslot = from.freecount ? from.freeslots[--from.freecount] : from.count++, toslot = to.count++;
        from.nodes[fromslot] = to;
        from.nodeslots[fromslot] = toslot;
        to.sources[toslot] = from;
        to.sourceslots[toslot] = fromslot;
    }
    function logDataRead(data, to) {
        if (!data.log)
            data.log = new Log();
        logRead(data.log, to);
    }
    function logComputationRead(node, to) {
        if (!node.log)
            node.log = new Log();
        logRead(node.log, to);
    }
    function logNodePreClock(clock, to) {
        if (!to.preclocks)
            to.preclocks = new NodePreClockLog();
        else if (to.preclocks.ages[clock.id] === to.age)
            return;
        to.preclocks.ages[clock.id] = to.age;
        to.preclocks.clocks[to.preclocks.count++] = clock;
    }
    function logClockPreClock(sclock, rclock, rnode) {
        var clocklog = rclock.preclocks || (rclock.preclocks = new ClockPreClockLog()), nodelog = rnode.preclocks || (rnode.preclocks = new NodePreClockLog());
        if (nodelog.ages[sclock.id] === rnode.age)
            return;
        nodelog.ages[sclock.id] = rnode.age;
        nodelog.uclocks[nodelog.ucount] = rclock;
        nodelog.uclockids[nodelog.ucount++] = sclock.id;
        var clockcount = clocklog.clockcounts[sclock.id];
        if (!clockcount) {
            if (clockcount === undefined)
                clocklog.ids[clocklog.count++] = sclock.id;
            clocklog.clockcounts[sclock.id] = 1;
            clocklog.clocks[sclock.id] = sclock;
        }
        else {
            clocklog.clockcounts[sclock.id]++;
        }
    }
    function event() {
        RootClock.subclocks.reset();
        RootClock.updates.reset();
        RootClock.subtime++;
        try {
            run(RootClock);
        }
        finally {
            RunningClock = Owner = RunningNode = null;
        }
    }
    function toplevelComputation(node) {
        RunningClock = RootClock;
        RootClock.changes.reset();
        RootClock.subclocks.reset();
        RootClock.updates.reset();
        try {
            node.value = node.fn(node.value);
            if (RootClock.changes.count > 0 || RootClock.subclocks.count > 0 || RootClock.updates.count > 0) {
                RootClock.subtime++;
                run(RootClock);
            }
        }
        finally {
            RunningClock = Owner = RunningNode = null;
        }
    }
    function run(clock) {
        var running = RunningClock, count = 0;
        RunningClock = clock;
        clock.disposes.reset();
        // for each batch ...
        while (clock.changes.count !== 0 || clock.subclocks.count !== 0 || clock.updates.count !== 0 || clock.disposes.count !== 0) {
            if (count > 0)
                clock.subtime++;
            clock.changes.run(applyDataChange);
            clock.subclocks.run(updateClock);
            clock.updates.run(updateNode);
            clock.disposes.run(dispose);
            // if there are still changes after excessive batches, assume runaway            
            if (count++ > 1e5) {
                throw new Error("Runaway clock detected");
            }
        }
        RunningClock = running;
    }
    function applyDataChange(data) {
        data.value = data.pending;
        data.pending = NOTPENDING;
        if (data.log)
            markComputationsStale(data.log);
    }
    function markComputationsStale(log) {
        var nodes = log.nodes, nodeslots = log.nodeslots, dead = 0, slot, nodeslot;
        // mark all downstream nodes stale which haven't been already, compacting log.nodes as we go
        for (var i = 0; i < log.count; i++) {
            var node = nodes[i];
            if (node) {
                var time = node.clock.time();
                if (node.age < time) {
                    markClockStale(node.clock);
                    node.age = time;
                    node.state = STALE;
                    node.clock.updates.add(node);
                    if (node.owned)
                        markOwnedNodesForDisposal(node.owned);
                    if (node.log)
                        markComputationsStale(node.log);
                }
                if (dead) {
                    slot = i - dead;
                    nodeslot = nodeslots[i];
                    nodes[i] = null;
                    nodes[slot] = node;
                    nodeslots[slot] = nodeslot;
                    node.sourceslots[nodeslot] = slot;
                }
            }
            else {
                dead++;
            }
        }
        log.count -= dead;
        log.freecount = 0;
    }
    function markOwnedNodesForDisposal(owned) {
        for (var i = 0; i < owned.length; i++) {
            var child = owned[i];
            child.age = child.clock.time();
            child.state = CURRENT;
            if (child.owned)
                markOwnedNodesForDisposal(child.owned);
        }
    }
    function markClockStale(clock) {
        var time = 0;
        if ((clock.parent && clock.age < (time = clock.parent.time())) || clock.state === CURRENT) {
            if (clock.parent) {
                clock.age = time;
                markClockStale(clock.parent);
                clock.parent.subclocks.add(clock);
            }
            clock.changes.reset();
            clock.subclocks.reset();
            clock.updates.reset();
            clock.state = STALE;
        }
    }
    function updateClock(clock) {
        var time = clock.parent.time();
        if (clock.age < time || clock.state === STALE) {
            if (clock.age < time)
                clock.state = CURRENT;
            if (clock.preclocks) {
                for (var i = 0; i < clock.preclocks.ids.length; i++) {
                    var preclock = clock.preclocks.clocks[clock.preclocks.ids[i]];
                    if (preclock)
                        updateClock(preclock);
                }
            }
            clock.age = time;
        }
        if (clock.state === RUNNING) {
            throw new Error("clock circular reference");
        }
        else if (clock.state === STALE) {
            clock.state = RUNNING;
            run(clock);
            clock.state = CURRENT;
        }
    }
    function updateNode(node) {
        if (node.state === STALE) {
            var owner = Owner, running = RunningNode, clock = RunningClock;
            Owner = RunningNode = node;
            RunningClock = node.clock;
            node.state = RUNNING;
            cleanup(node, false);
            node.value = node.fn(node.value);
            node.state = CURRENT;
            Owner = owner;
            RunningNode = running;
            RunningClock = clock;
        }
    }
    function cleanup(node, final) {
        var sources = node.sources, sourceslots = node.sourceslots, cleanups = node.cleanups, owned = node.owned, preclocks = node.preclocks, i, source, slot;
        if (cleanups) {
            for (i = 0; i < cleanups.length; i++) {
                cleanups[i](final);
            }
            node.cleanups = null;
        }
        if (owned) {
            for (i = 0; i < owned.length; i++) {
                dispose(owned[i]);
            }
            node.owned = null;
        }
        for (i = 0; i < node.count; i++) {
            source = sources[i];
            slot = sourceslots[i];
            source.nodes[slot] = null;
            source.freeslots[source.freecount++] = slot;
            sources[i] = null;
        }
        node.count = 0;
        if (preclocks) {
            for (i = 0; i < preclocks.count; i++) {
                preclocks.clocks[i] = null;
            }
            preclocks.count = 0;
            for (i = 0; i < preclocks.ucount; i++) {
                var upreclocks = preclocks.uclocks[i].preclocks, uclockid = preclocks.uclockids[i];
                if (--upreclocks.clockcounts[uclockid] === 0) {
                    upreclocks.clocks[uclockid] = null;
                }
            }
            preclocks.ucount = 0;
        }
    }
    function dispose(node) {
        node.fn = null;
        node.log = null;
        node.preclocks = null;
        cleanup(node, true);
    }
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

// synchronous array signals for S.js
(function (package) {
    if (typeof exports === 'object' && exports.__esModule) {
        exports.default = package(require(S)); // ES6 to CommonJS
    } else if (typeof module === 'object' && typeof module.exports === 'object') {
        module.exports = package(require(S)); // CommonJS
    } else if (typeof define === 'function') {
        define(['S'], package); // AMD
    } else {
        (eval || function () {})("this").SArray = package(S); // globals
    }
})(function (S) {
    "use strict";

    return SArray;

    function SArray(values) {
        if (!Array.isArray(values))
            throw new Error("S.array must be initialized with an array");

        var dirty     = S.data(false),
            mutations = [],
            mutcount  = 0,
            pops      = 0,
            shifts    = 0,
            data      = S.root(function () { return S.on(dirty, update, values, true); });

        // add mutators
        array.push      = push;
        array.pop       = pop;
        array.unshift   = unshift;
        array.shift     = shift;
        array.splice    = splice;

        // not ES5
        array.remove    = remove;
        array.removeAll = removeAll;

        return transformer(array);
        
        function array(newvalues) {
            if (arguments.length > 0) {
                mutation(function array() { values = newvalues; });
                return newvalues;
            } else {
                return data();
            }
        }

        function mutation(m) {
            mutations[mutcount++] = m;
            dirty(true);
        }
        
        function update() {
            if (pops)   values.splice(values.length - pops, pops);
            if (shifts) values.splice(0, shifts);
            
            pops     = 0;
            shifts   = 0;
            
            for (var i = 0; i < mutcount; i++) {
                mutations[i]();
                mutations[i] = null;
            }
            
            mutcount = 0;
            
            return values;
        }
        
        // mutators
        function push(item) {
            mutation(function push() { values.push(item); });
            return array;
        }
    
        function pop() {
            array();
            if ((pops + shifts) < values.length) {
                var value = values[values.length - ++pops];
                dirty(true);
                return value;
            }
        }
    
        function unshift(item) {
            mutation(function unshift() { values.unshift(item); });
            return array;
        }
    
        function shift() {
            array();
            if ((pops + shifts) < values.length) {
                var value = values[shifts++];
                dirty(true);
                return value;
            }
        }
    
        function splice(/* arguments */) {
            var args = Array.prototype.slice.call(arguments);
            mutation(function splice() { Array.prototype.splice.apply(values, args); });
            return array;
        }
    
        function remove(item) {
            mutation(function remove() {
                for (var i = 0; i < values.length; i++) {
                    if (values[i] === item) {
                        values.splice(i, 1);
                        break;
                    }
                }
            });
            return array;
        }
    
        function removeAll(item) {
            mutation(function removeAll() {
                for (var i = 0; i < values.length; ) {
                    if (values[i] === item) {
                        values.splice(i, 1);
                    } else {
                        i++;
                    }
                }
            });
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
        s.defer       = defer;

        return s;
    }

    function mapS(enter, exit, move) {
        var seq = this,
            items = [],
            mapped = [],
            disposers = enter ? [] : null,
            len = 0;

        var mapS = S(function mapS() {
            var new_items = seq(),
                new_len = new_items.length,
                temp = new Array(new_len),
                tempdisposers = enter ? new Array(new_len) : null,
                from, to, i, j, k, item;

            if (move) from = [], to = [];

            // 1) step through all old items and see if they can be found in the new set; if so, save them in a temp array and mark them moved; if not, exit them
            NEXT:
            for (i = 0, k = 0; i < len; i++) {
                item = items[i];
                for (j = 0; j < new_len; j++, k = (k + 1) % new_len) {
                    if (item === new_items[k] && !temp.hasOwnProperty(k)) {
                        temp[k] = mapped[i];
                        if (enter) tempdisposers[k] = disposers[i];
                        if (move && i !== k) { from.push(i); to.push(k); }
                        k = (k + 1) % new_len;
                        continue NEXT;
                    }
                }
                if (exit) S.sample(function () { exit(item, enter ? mapped[i]() : mapped[i], i); });
                if (enter) disposers[i]();
            }

            if (move && from.length) S.sample(function () { move(items, mapped, from, to); });

            // 2) set all the new values, pulling from the temp array if copied, otherwise entering the new value
            for (i = 0; i < new_len; i++) {
                if (temp.hasOwnProperty(i)) {
                    mapped[i] = temp[i];
                    if (enter) disposers[i] = tempdisposers[i];
                } else {
                    item = new_items[i];
                    mapped[i] = !enter ? item : (function (item, value, i) { 
                        return S.root(function (disposer) {
                            if (enter) disposers[i] = disposer;
                            return S(function () { return value = enter(item, value, i); });
                        }); 
                    })(item, undefined, i);
                }
            }
            
            S.cleanup(function (final) { if (final && enter) disposers.forEach(function (d) { d(); }); });

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
    function defer(scheduler) {
        return transformer(S.defer(scheduler).S(this));
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

            frag.originalNodes = Array.prototype.slice.apply(frag.childNodes);
            
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
            copy.originalNodes = Array.prototype.slice.call(copy.childNodes);
        }

        return copy;
    }
})

define('Html', ['parse', 'cachedParse', 'domlib'], function (parse, cachedParse, domlib) {
    function Html(id, html) {
        return cachedParse(id, html);
    }

    Html.exec = function exec(fn) {
        fn();
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
        
    Html.insert = function insert(node, value, start) {
        start = start || marker(node);
        var parent, cursor;

        unwrap(value);

        return start;

        function unwrap(value) {
            if (value instanceof Function) {
                Html.exec(function insert() {
                    unwrap(value());
                });
            } else {
                insert(value);
            }
        }

        function insert(value) {
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
            insertValue(value);

            // remove anything left after the cursor from the insert range
            clear(cursor, node);
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
                // use the cached originalNodes array and insert as an array
                if (value.childNodes.length === 0 && value.originalNodes) {
                    insertArray(value.originalNodes);
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

        function clear(start, end) {
            if (start === end) return;
            var next = start.nextSibling;
            while (next !== end) {
                parent.removeChild(next);
                next = start.nextSibling;
            }
        }

        function marker(el) {
            return el.parentNode.insertBefore(document.createTextNode(""), el);
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

    Html.exec = S;

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
                    var cur = S.sample(signal),
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
                    var cur = S.sample(signal),
                        update = node.textContent;
                    if (cur.toString() !== update) signal(update);
                    return true;
                }
            }
        };
    };
    
    Html.animationFrame = function animationFrame(go) {
        var scheduled = false,
            args = null;
    
        return tick;
    
        function tick() {
            args = Array.prototype.slice.apply(arguments);
            if (!scheduled) {
                scheduled = true;
                requestAnimationFrame(run);
            }
        }
        
        function run() {
            scheduled = false;
            go.apply(null, args);
        }
    }
});

(function (package) {
    if (typeof exports === 'object')
        package(require('S'), require('SArray'), require('htmlliterals-runtime')); // CommonJS
    else if (typeof define === 'function')
        define(['S', 'SArray', 'htmlliterals-runtime'], package); // AMD
    else package(S, SArray, htmlliterals); // globals
})(function (S, SArray, htmlliterals) {
    var type = 'text/javascript-htmlliterals',
        config = window.surplus || {},
        XHR_DONE = 4;

    var scripts = SArray([]),
        i = 0;

    S.root(function () { return S(function surplusPreprocessQueue() {
        for (; i < scripts().length && scripts()[i].source() !== undefined; i++) {
            preprocess(scripts()[i]);
        }
    }); });

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
