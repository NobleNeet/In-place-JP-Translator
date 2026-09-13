// translation/queue.js
// Simple ordered queue consumed by the content orchestrator.
// The actual priority ordering is done before batching in content.js.

export class TranslationQueue {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
  }

  next() {
    return this.items.shift();
  }

  peek() {
    return this.items[0];
  }

  get size() {
    return this.items.length;
  }

  clear() {
    this.items = [];
  }
}
