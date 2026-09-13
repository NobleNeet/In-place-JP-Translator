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

    function pump() {
      while (active < maxSlots && queue.length) {
        var next = queue.shift();
        active++;
        next.fn().then(next.ok, next.err).finally(function () {
          active--;
          pump();
        });
      }
    }

    function run(fn) {
      return new Promise(function (resolve, reject) {
        queue.push({ fn: fn, ok: resolve, err: reject });
        pump();
      });
    }

    return {
      run: run,
      getActive: function () { return active; },
      getPending: function () { return queue.length; }
    };
  }

  ns.Semaphore = Semaphore;
})();
