// translation/scheduler.js
// Classic-script module. Exports: ns.Semaphore
// Concurrency limiter. Runs a queue of async tasks; keeps in-flight count
// <= max. Used by background to bound API fan-out and by the page queue later.
(function () {
  var ns = globalThis.__PLAMO__;

  function Semaphore(max) {
    if (!Number.isFinite(max) || max < 1) throw new Error('Semaphore: max must be >= 1');
    var maxSlots = max;
    var active = 0;
    var queue = [];

    // One queued task on its own, in its own function: the answer must settle the
    // caller it belongs to and free the slot it started on, not whatever task the
    // pump loop was holding when it came back.
    function start(next) {
      active++;
      // A slot is only ever given back once. Calling fn() bare inside the pump
      // loop meant a task that threw synchronously (or returned something with no
      // `then`) took its slot with it: active never came back down, the rest of
      // that pump pass never started, and the limiter lost capacity for good -
      // which reads exactly like "that server went busy and never picked up the
      // next request again".
      var settled = false;
      var finish = function () {
        if (settled) return;
        settled = true;
        active--;
        if (active < 0) active = 0;
        pump();
      };
      var started;
      try { started = next.fn(); } catch (err) { started = Promise.reject(err); }
      Promise.resolve(started).then(function (v) { finish(); next.ok(v); },
        function (e) { finish(); next.err(e); });
    }

    function pump() {
      while (active < maxSlots && queue.length) start(queue.shift());
    }

    function run(fn) {
      return new Promise(function (resolve, reject) {
        queue.push({ fn: fn, ok: resolve, err: reject });
        pump();
      });
    }

    // Changes the limit in place (used when the popup concurrency setting
    // changes). Replacing the Semaphore instead would let the old queue and the
    // new one run past the limit at the same time.
    function setMax(next) {
      var prev = maxSlots;
      if (Number.isFinite(next) && next >= 1) maxSlots = Math.floor(next);
      if (maxSlots !== prev) pump();
      return { prev: prev, max: maxSlots, active: active, pending: queue.length };
    }

    return {
      run: run,
      setMax: setMax,
      getMax: function () { return maxSlots; },
      getActive: function () { return active; },
      getPending: function () { return queue.length; }
    };
  }

  ns.Semaphore = Semaphore;
})();
