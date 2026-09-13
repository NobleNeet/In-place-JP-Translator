// translation/queue.js
// Classic-script module. Exports: ns.Queue
// Priority queue for pending work items (used in Phase 2 for viewport-driven
// streaming). Not used in Phase 1 (we translate top-level priority order).
(function () {
  var ns = globalThis.__PLAMO__;
  var log = ns.logger.log;

  function Queue() {
    this._items = [];
  }

  Queue.prototype.enqueue = function (item) {
    this._items.push(item);
    this._items.sort(function (a, b) { return a.priority - b.priority; });
  };

  Queue.prototype.dequeue = function () {
    return this._items.shift();
  };

  Queue.prototype.peek = function () {
    return this._items[0];
  };

  Queue.prototype.size = function () {
    return this._items.length;
  };

  Queue.prototype.clear = function () {
    this._items = [];
  };

  ns.Queue = Queue;
})();
