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
              + encodeURIComponent(JSON.stringify(extract.map));

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
        //       |          |    |    |   | +- =
        //       |          |    |    |   +- @
        //       |          |    |    +- -->
        //       |          |    +- <!--
        //       |          +- /> or >
        //       +- < or </ followed by \w
    };

    return function tokenize(str, opts) {
        var toks = str.match(rx.tokens);

        if (toks.join('') !== str) throw new Error("tokenize failure");

        return toks;
        //return TokenStream(toks);
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
        HtmlElement: function(beginTag, properties, mixins, content, endTag) {
            this.beginTag = beginTag; // string
            this.properties = properties; // [ Property ]
            this.mixins = mixins; // [ Mixin ]
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
        Property: function (name, code) {
            this.name = name; // string
            this.code = code; // EmbeddedCode
        },
        Mixin: function (code) {
            this.code = code; // EmbeddedCode
        }
    };
});

define('parse', ['AST'], function (AST) {

    // pre-compiled regular expressions
    var rx = {
        propertyLeftSide   : /\s(\S+)\s*=\s*$/,
        stringEscapedEnd   : /[^\\](\\\\)*\\$/, // ending in odd number of escape slashes = next char of string escaped
        ws                 : /^\s*$/,
        leadingWs          : /^\s+/,
        codeTerminator     : /^[\s<>/,;)\]}]/,
        codeContinuation   : /^[^\s<>/,;)\]}]+/,
        tagTrailingWs      : /\s+(?=\/?>$)/,
        emptyLines         : /\n\s+(?=\n)/g
    };

    var parens = {
        "(": ")",
        "[": "]",
        "{": "}"
    };

    return function parse(TOKS, opts, orig) {
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
                    // look ahead to see if coming text is whitespace followed by another node
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
                mixins = [],
                content = [],
                endTag = "",
                hasContent = true;

            beginTag += TOK, NEXT();

            // scan for attributes until end of opening tag
            while (!EOF && NOT('>') && NOT('/>')) {
                if (IS('@')) {
                    mixins.push(mixin());
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

                if (EOF) ERR("element missing close tag", start);

                while (!EOF && NOT('>')) {
                    endTag += TOK, NEXT();
                }

                if (EOF) ERR("eof while looking for element close tag");

                endTag += TOK, NEXT();
            }

            return new AST.HtmlElement(beginTag, properties, mixins, content, endTag);
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
                name;

            beginTag += TOK, NEXT();

            if (WS()) beginTag += TOK, NEXT();

            match = rx.propertyLeftSide.exec(beginTag);

            // check if it's an attribute not a property assignment
            if (match) {
                if (IS('"') || IS("'")) {
                    beginTag += quotedString();
                } else {
                    beginTag = beginTag.substring(0, beginTag.length - match[0].length);

                    name = match[1];

                    SPLIT(rx.leadingWs);

                    properties.push(new AST.Property(name, embeddedCode()));
                }
            }

            return beginTag;
        }

        function mixin() {
            if (NOT('@')) ERR("not at start of mixin");

            NEXT();

            return new AST.Mixin(embeddedCode());
        }

        function embeddedCode() {
            var start = LOC(),
                segments = [],
                text = "",
                loc = LOC();

            // consume source text up to the first top-level terminating character
            while(!EOF && !MATCH(rx.codeTerminator)) {
                if (PARENS()) {
                    text = balancedParens(segments, text, loc);
                } else if (IS("'") || IS('"')) {
                    text += quotedString();
                } else {
                    text += SPLIT(rx.codeContinuation);
                }
            }

            if (text) segments.push(new AST.CodeText(text, loc));

            if (segments.length === 0) ERR("not in embedded code", start);

            return new AST.EmbeddedCode(segments);
        }

        function balancedParens(segments, text, loc) {
            var start = LOC(),
                end = PARENS();

            if (end === undefined) ERR("not in parentheses");

            text += TOK, NEXT();

            while (!EOF && NOT(end)) {
                if (IS("'") || IS('"')) {
                    text += quotedString();
                } else if (IS('//')) {
                    text += codeSingleLineComment();
                } else if (IS('/*')) {
                    text += codeMultiLineComment();
                } else if (IS("<") || IS('<!--') || IS('@')) {
                    if (text) segments.push(new AST.CodeText(text, { line: loc.line, col: loc.col }));
                    text = "";
                    segments.push(htmlLiteral());
                    loc.line = LINE;
                    loc.col = COL;
                } else if (PARENS()) {
                    text = balancedParens(segments, text, loc);
                } else {
                    text += TOK, NEXT();
                }
            }

            if (EOF) ERR("unterminated parentheses", start);

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
            loc = loc || LOC();
            var frag = " at line " + loc.line + " col " + loc.col + ": ``" + orig.substr(loc.pos, 30).replace("\n", "").replace("\r", "") + "''";
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
    };
});

define('genCode', ['AST', 'sourcemap'], function (AST, sourcemap) {

    // pre-compiled regular expressions
    var rx = {
        backslashes        : /\\/g,
        newlines           : /\r?\n/g,
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
    AST.HtmlLiteral.prototype.genCode = function (opts, prior) {
        var html = concatResults(opts, this.nodes, 'genHtml'),
            id = hash52(html),
            nl = "\r\n" + indent(prior),
            init = genInit(opts, this.nodes, nl),
            code = opts.symbol + "(" + id + "," + nl + codeStr(html) + ")";

        if (init) code = "(" + init + ")(" + code + ")";

        return code;
    };

    // genHtml
    AST.HtmlElement.prototype.genHtml = function(opts) {
        return this.beginTag + concatResults(opts, this.content, 'genHtml') + (this.endTag || "");
    };
    AST.HtmlComment.prototype.genHtml =
    AST.HtmlText.prototype.genHtml    = function (opts) { return this.text; };
    AST.HtmlInsert.prototype.genHtml  = function (opts) { return '<!-- insert -->'; };

    // genRefs
    AST.HtmlElement.prototype.genCommands = function (opts, refs, cmds, refnum, parentnum, child) {
        for (var i = 0; i < this.content.length; i++) {
            this.content[i].genCommands(opts, refs, cmds, Math.max(refnum + 1, refs.length), refnum, i);
        }
        for (i = 0; i < this.properties.length; i++) {
            this.properties[i].genCommand(opts, cmds, refnum);
        }
        for (i = 0; i < this.mixins.length; i++) {
            this.mixins[i].genCommand(opts, cmds, refnum);
        }
        if (this.properties.length || this.mixins.length || refs.length !== refnum) {
            if (refnum !== -1) refs[refnum] = declareRef(refnum, parentnum, child);
        }
    };
    AST.HtmlComment.prototype.genCommands =
    AST.HtmlText.prototype.genCommands    = function (opts, refs, cmds, refnum, parentnum, child) { };
    AST.HtmlInsert.prototype.genCommands  = function (opts, refs, cmds, refnum, parentnum, child) {
        refs[refnum] = declareRef(refnum, parentnum, child);
        cmds.push(opts.symbol + ".exec(function (state) { return Html.insert(" + ref(refnum) + ", " + this.code.genCode(opts) + ", state); });");
    };

    // genDirective
    AST.Property.prototype.genCommand = function (opts, cmds, refnum) {
        var code = this.code.genCode(opts);
        cmds.push(opts.symbol + ".exec(function () { " + ref(refnum) + "." + this.name + " = " + code + "; });");
    };
    AST.Mixin.prototype.genCommand = function (opts, cmds, refnum) {
        var code = this.code.genCode(opts);
        cmds.push(opts.symbol + ".exec(function (state) { return " + this.code.genCode(opts) + "(" + ref(refnum) + ", state); });");
    };

    function declareRef(refnum, parentnum, child) {
        return "var " + ref(refnum) + " = " + ref(parentnum) + ".childNodes[" + child + "];";
    }

    function ref(refnum) {
        return "__" + (refnum === -1 ? '' : refnum);
    }

    function genInit(opts, nodes, nl) {
        var refs = [],
            cmds = [],
            //identifiers = [],
            cnl = nl + "    ",
            i;

        if (nodes.length === 1) {
            nodes[0].genCommands(opts, refs, cmds, -1, -1, 0);
        } else {
            for (i = 0; i < nodes.length; i++) {
                nodes[i].genCommands(opts, refs, cmds, refs.length, -1, i);
            }
        }

        if (cmds.length === 0) return null;

        return "function (__) {" + cnl + refs.join(cnl) + cnl + cmds.join(cnl) + cnl + "return __;" + nl + "}";
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

    var MAX32 = Math.pow(2 ,32);

    // K&R hash, returning 52-bit integer, the max a double can represent
    // this gives us an 0.0001% chance of collision with 67k templates (a lot of templates)
    function hash52(str) {
        var low = 0, high = 0, i, len, c, v;
        for (i = 0, len = str.length; i < len; i++) {
            c = str.charCodeAt(i);
            v = (low * 31) + c;
            low = v|0;
            c = (v - low) / MAX32;
            high = (high * 31 + c)|0;
        }
        return ((high & 0xFFFFF) * MAX32) + low;
    }
});

// Cross-browser compatibility shims
define('shims', ['AST'], function (AST) {

    // can only probe for shims if we're running in a browser
    if (!this || !this.document) return false;
    
    var rx = {
        ws: /^\s*$/
    };
    
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
            if (rx.ws.test(this.text) && !(ctx.parent instanceof AST.HtmlAttr)) {
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
            ast = parse(toks, opts, str);

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
