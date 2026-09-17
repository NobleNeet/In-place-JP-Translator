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
// Nothing is dealt out in advance. The batches wait in ONE queue in send order,
// and a batch is handed to a server only when that server has a free slot, so:
//   * a server's concurrency is a real bound (this side never over-subscribes
//     it), and the worker's per-profile semaphore stays a backstop rather than
//     becoming the place where the run piles up;
//   * work that has not started belongs to no server, so a server that answers
//     slowly simply ends up with fewer batches instead of holding them hostage;
//   * the send ORDER never changes - article body first, then headings, then
//     page chrome - only which server a batch lands on.
//
// Two rules decide WHO fills a free slot, and together they keep every ticked
// API busy while work remains:
//   * the server that just answered pulls the next batch itself
//     (pump(preferred) below) - the API that finished receiving is the one
//     asked for the next queue item, so it never sits idle waiting to be
//     offered work while batches still wait;
//   * when several servers are free at once (the cold start of a run, or a
//     short queue), pick() rotates over the SERVERS rather than always taking
//     the roomiest. Under the old roomiest-first rule a short queue was
//     swallowed whole by the roomier server - evo at 1 and local at 4 with
//     three batches meant evo got none and sat idle the whole run. Rotating
//     shares a short queue; the roomier server still takes more because it
//     answers more often, which is its correct share.
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

    // Round-robin cursor over the pool. pick() advances it past every server it
    // passes over, so consecutive batches go to DIFFERENT servers whenever more
    // than one has room. This is what stops a short queue from being swallowed
    // whole by the roomiest server: with evo at 1 and local at 4 and only three
    // batches waiting, roomiest-first handed all three to local and left evo
    // idle for the whole run - the "one API does nothing while the other
    // works" symptom. Rotating over the servers shares a short queue between
    // them; the roomier one still takes more because it answers more often.
    var rr = 0;

    // The next server that has a free slot, starting from the round-robin
    // cursor. Returns null only when every server is saturated.
    function pick() {
      for (var k = 0; k < pool.length; k++) {
        var idx = (rr + k) % pool.length;
        var one = pool[idx];
        if (freeSlots(one) > 0) { rr = (idx + 1) % pool.length; return one; }
      }
      return null;
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

    // Round-robin for work that must go one request at a time (the echo-retry
    // round). The chunk index names the server, so a sequential tail is shared
    // between the ticked APIs instead of pinned to whichever one pickRoomiest()
    // happens to favour - with both servers idle after the main run, that choice
    // never changes, and one API would grind through the whole tail alone.
    function pickRoundRobin(index) {
      var i = ((index % pool.length) + pool.length) % pool.length;
      return pool[i];
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
        // The server that just answered pulls the next batch itself, before any
        // other server is offered it: a freed slot is an order for the queue,
        // and the server that freed it fills it.
        pump(one);
      };
      var started;
      try { started = send(slot.item, one); }
      catch (err) { started = Promise.reject(err); }
      Promise.resolve(started).then(finish, finish);
    }

    // `preferred` is the server that just freed a slot (nothing on the
    // cold-start pump). It takes the next batch while it still has room - the
    // server that just answered is the one asked for the next queue item, which
    // is the work-conserving rule the run runs on. Once it is full again the
    // round-robin pick() fills the other servers, so a short queue is shared
    // instead of being taken whole by the roomiest one.
    function pump(preferred) {
      while (waiting.length) {
        var one = (preferred && freeSlots(preferred) > 0) ? preferred : pick();
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
      pickRoundRobin: pickRoundRobin,
      drop: drop,
      stats: stats
    };
  }

  ns.Dispatcher = Dispatcher;
})();
