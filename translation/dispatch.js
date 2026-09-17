// translation/dispatch.js
// Classic-script module. Exports: ns.Dispatcher
// Work-conserving fan-out of one run's batches over several API servers.
//
// The scheme this replaces computed a weighted round-robin from the concurrency
// of every ticked server and picked a batch's destination with
// `batchIndex % schedule.length`, then posted every batch of the run at once.
// That made two servers behave like ONE queue: everything dealt to the slow
// server waited behind that server's own limiter for the whole run, while the
// server that had finished its share sat idle and was never offered any of the
// work still waiting. Equalising the two concurrency settings hid the symptom
// without fixing it, and an asymmetric pair looked as if it translated only part
// of the page.
//
// Here nothing is dealt out in advance. The batches wait in ONE queue in send
// order, and a batch is handed to a server only when that server has a free
// slot, so:
//   * a server's concurrency is a real bound (this side never over-subscribes
//     it), and the worker's per-profile semaphore stays a backstop rather than
//     becoming the place where the run piles up;
//   * work that has not started belongs to no server, so a server that answers
//     slowly simply ends up with fewer batches instead of holding them hostage;
//   * the send ORDER never changes - article body first, then headings, then
//     page chrome - only which server a batch lands on.
(function () {
  var ns = globalThis.__PLAMO__;
  var log = ns.logger.log;

  // servers: [{ name, concurrency }] - one entry per API the run sends through.
  // send(item, server) starts the work for one item. Whatever it returns is
  // awaited, and the server's slot is released when it settles; a rejection
  // counts as finished, because a request that died must not occupy a slot
  // forever (that is how a server ends up "busy" with nothing running).
  function Dispatcher(servers, send) {
    var pool = [];
    var named = {};
    var waiting = [];   // { item, resolve } in submit order
    var inflight = 0;
    var dropped = 0;

    (servers || []).forEach(function (api) {
      var name = api && api.name;
      if (!name || named[name]) return;
      var n = parseInt(api && api.concurrency, 10);
      named[name] = true;
      pool.push({
        name: name,
        concurrency: (Number.isFinite(n) && n >= 1) ? Math.floor(n) : 1,
        active: 0,
        dispatched: 0
      });
    });
    // A run with no usable server entry still has to translate something.
    if (!pool.length) pool.push({ name: 'default', concurrency: 1, active: 0, dispatched: 0 });
    if (typeof send !== 'function') send = function () { return Promise.resolve(); };

    function freeSlots(one) { return one.concurrency - one.active; }

    // The roomiest server takes the next batch; a tie goes to the server that
    // was ticked first, so one settings state always gives one assignment.
    function pick() {
      var best = null;
      var bestFree = 0;
      for (var i = 0; i < pool.length; i++) {
        var free = freeSlots(pool[i]);
        if (free > bestFree) { best = pool[i]; bestFree = free; }
      }
      return best;
    }

    // For work that must stay sequential (the echo-retry round): names the
    // server with the most room right now, even when every server is busy.
    function pickRoomiest() {
      var best = pool[0];
      var bestFree = freeSlots(pool[0]);
      for (var i = 1; i < pool.length; i++) {
        var free = freeSlots(pool[i]);
        if (free > bestFree) { best = pool[i]; bestFree = free; }
      }
      return best;
    }

    // One item on one server. Its own function on purpose: the answer must free
    // the slot it was started on, not whatever server the loop happened to be
    // holding when it came back.
    function start(one, slot) {
      one.active++;
      one.dispatched++;
      inflight++;
      var settled = false;
      var finish = function () {
        if (settled) return;
        settled = true;
        one.active--;
        if (one.active < 0) one.active = 0;
        inflight--;
        if (inflight < 0) inflight = 0;
        if (slot.resolve) slot.resolve();
        pump(); // a freed slot is an order for the queue, whoever freed it
      };
      var started;
      try { started = send(slot.item, one); }
      catch (err) { started = Promise.reject(err); }
      Promise.resolve(started).then(finish, finish);
    }

    function pump() {
      while (waiting.length) {
        var one = pick();
        if (!one) return; // every server is saturated; the next answer pumps again
        start(one, waiting.shift());
      }
    }

    // One item into the queue; the returned promise settles when that item's
    // work is over (started or, after drop(), never started).
    function submit(item) {
      var slot = { item: item };
      var p = new Promise(function (resolve) { slot.resolve = resolve; });
      waiting.push(slot);
      pump();
      return p;
    }

    function runAll(items) {
      var list = items || [];
      var all = [];
      for (var i = 0; i < list.length; i++) all.push(submit(list[i]));
      return Promise.all(all);
    }

    // Stop means "no more requests": everything still queued is released (its
    // promise resolves, so the run can write its summary) and never sent.
    function drop(reason) {
      var queued = waiting.splice(0, waiting.length);
      dropped += queued.length;
      queued.forEach(function (slot) {
        // Resolved a turn later: a caller that drops while it is still iterating
        // its own run must not have the run finish inside that loop.
        if (slot.resolve) Promise.resolve().then(slot.resolve);
      });
      if (queued.length) {
        log.warn('dispatch: ' + queued.length + ' queued batch(es) not sent (' + (reason || 'stopped') + ')');
      }
      return queued.length;
    }

    function stats() {
      return {
        servers: pool.map(function (one) {
          return {
            name: one.name, limit: one.concurrency, active: one.active,
            free: freeSlots(one), dispatched: one.dispatched
          };
        }),
        waiting: waiting.length,
        inflight: inflight,
        dropped: dropped
      };
    }

    return {
      submit: submit,
      runAll: runAll,
      pickRoomiest: pickRoomiest,
      drop: drop,
      stats: stats
    };
  }

  ns.Dispatcher = Dispatcher;
})();
