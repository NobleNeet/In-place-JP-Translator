// content/ui.js
// Classic-script widget. Exports: ns.ui
// The floating button in the bottom-right corner of every page: 和訳 starts a
// run, the button then reports the run's progress (翻訳中… n/m) and offers to
// stop it, and once the page is translated the same button turns into
// 原文に戻す. It is deliberately dumb: every number it shows is read back from
// __plamo.getState(), so it can never display a counter that the orchestrator
// does not also report to the console. content.js reports the run to it via
// ns.ui.onRunEvent(kind); the widget itself takes a click and calls back into
// window.__plamo.
//
// Two constraints shaped this file:
//
// 1. No <style> element is ever injected. A page's Content-Security-Policy can
//    refuse the extension the right to add one, and half a styled widget is
//    worse than an inline-styled one; every bit of styling here lives in
//    element.style / setAttribute('style').
//
// 2. The widget must never be translated. extractor.js skips any subtree under
//    a class starting with 'plamo-' plus the shared 'plamo-ui' class, so the
//    button keeps saying 和訳 in Japanese on an English page (and on an
//    already-Japanese one, where 原文に戻す would otherwise be fair game).
(function () {
  var ns = globalThis.__PLAMO__;
  var log = ns.logger.log;

  var WIDGET_ID = 'plamo-translate-widget';
  var BUTTON_ID = 'plamo-translate-button';
  var SUB_ID = 'plamo-translate-sub';

  // idle: nothing translated on this page right now.
  // running: a run is in flight; a click asks for a stop.
  // stopping: the stop was requested; in-flight batches are still landing.
  // done: the page carries translations; a click restores the originals.
  var mode = 'idle';
  var button = null;
  var sub = null;

  var LABELS = {
    idle: '和訳',
    running: '翻訳中…',
    stopping: '停止中…',
    done: '原文に戻す'
  };
  var COLORS = { idle: '#1a73e8', running: '#b45309', stopping: '#b45309', done: '#0f9d58' };

  function plamo() {
    return globalThis.__plamo || null;
  }

  function state() {
    var p = plamo();
    try { return (p && p.getState()) || null; }
    catch (e) { return null; }
  }

  // --- rendering ---------------------------------------------------------------
  // 処理所要時間を人が読みやすい秒表示にする（9.4秒 / 1分23秒）。
  function fmtSeconds(ms) {
    var s = ms / 1000;
    if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + '秒';
    return Math.floor(s / 60) + '分' + (Math.round(s) % 60) + '秒';
  }

  // The sub line is the "how far along is it?" answer: while running it tracks
  // the live counters, once done it reports what the last run achieved.
  function subText() {
    var st = state();
    if (!st) return '';
    if (mode === 'running' || mode === 'stopping') {
      var parts = [(st.applied || 0) + '/' + (st.segments || 0) + ' 件'];
      if (st.cacheHits) parts.push('cache ' + st.cacheHits);
      if (st.failed) parts.push('失敗 ' + st.failed);
      if (st.inFlight) parts.push('送信中 ' + st.inFlight);
      return parts.join(' / ');
    }
    if (mode === 'done') {
      var run = st.lastRun || {};
      var bits = ['翻訳 ' + (st.renderedNodes || 0) + 'ノード'];
      if (run.cacheHits) bits.push('cache ' + run.cacheHits);
      if (run.persistentHits) bits.push('恒久cache ' + run.persistentHits);
      if (run.failed) bits.push('失敗 ' + run.failed);
      if (run.elapsedMs) bits.push(fmtSeconds(run.elapsedMs));
      return bits.join(' / ');
    }
    return '';
  }

  function render() {
    if (!button) return;
    var label = LABELS[mode] || LABELS.idle;
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.style.setProperty('background', COLORS[mode] || COLORS.idle, 'important');
    if (sub) {
      var t = subText();
      sub.textContent = t;
      sub.style.display = t ? 'block' : 'none';
    }
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    render();
  }

  // --- clicks -------------------------------------------------------------------
  function onClick() {
    var p = plamo();
    if (!p) {
      log('warn', 'ui: window.__plamo is missing, the widget cannot reach the translator');
      return;
    }
    try {
      if (mode === 'idle') {
        // run-start arrives from content.js and flips us to 'running'; until it
        // does the button keeps its label, so a failed call is not silently
        // painted as "running forever".
        p.translatePage();
        if (mode === 'idle') setMode('running'); // the event may have been lost
        return;
      }
      if (mode === 'running') {
        if (typeof p.stopTranslation === 'function') p.stopTranslation();
        setMode('stopping'); // the MSG_STOP path also fires this; setMode dedupes
        return;
      }
      if (mode === 'stopping') return; // one stop is enough
      if (mode === 'done') {
        p.restoreAll();
        setMode('idle');
      }
    } catch (err) {
      log('warn', 'ui: button action failed: ' + String((err && err.message) || err));
    }
  }

  // --- run events (from content.js) ----------------------------------------------
  // The widget never counts anything itself; onRunEvent just says "something
  // changed, look again". kinds: run-start, progress, stop, run-end, run-abort,
  // restore.
  function onRunEvent(kind) {
    if (!button) return;
    if (kind === 'run-start') { setMode('running'); render(); return; }
    if (kind === 'stop') { setMode('stopping'); return; }
    if (kind === 'progress') { if (mode === 'running' || mode === 'stopping') render(); return; }
    if (kind === 'restore') { setMode('idle'); return; }
    if (kind === 'run-end' || kind === 'run-abort') {
      // 'applied' counts writes of THIS run; a second run that found everything
      // cached applies nothing while the page is still fully translated, so the
      // question is answered from the renderer registry instead.
      var st = state();
      var landed = st && st.renderedNodes > 0;
      setMode(landed ? 'done' : 'idle');
      return;
    }
  }

  // --- mounting -------------------------------------------------------------------
  function styleString() {
    // One style attribute per element; no stylesheet, see the header comment.
    return {
      widget: 'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
        'display:flex;flex-direction:column;align-items:flex-end;gap:4px;' +
        'font-family:system-ui,-apple-system,"Segoe UI","Noto Sans JP",sans-serif;pointer-events:none;',
      button: 'pointer-events:auto;display:inline-block;border:0;border-radius:24px;' +
        'padding:10px 18px;color:#ffffff;font-size:14px;font-weight:600;line-height:1.4;' +
        'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);opacity:.96;' +
        'font-family:inherit;',
      sub: 'font-size:11px;color:#202124;' +
        'text-shadow:0 0 3px #ffffff,0 0 3px #ffffff,0 1px 3px #ffffff;'
    };
  }

  function mount() {
    if (button) return true;
    if (globalThis.document.getElementById(WIDGET_ID)) {
      // A second content-script injection (extension reload without a page
      // reload): adopt the old node instead of stacking a second widget.
      var old = globalThis.document.getElementById(BUTTON_ID);
      if (old) {
        button = old;
        sub = globalThis.document.getElementById(SUB_ID);
        button.addEventListener('click', onClick);
        var st0 = state();
        mode = (st0 && st0.renderedNodes > 0) ? 'done' : 'idle';
        render();
        return true;
      }
      // A widget shell we cannot complete: remove it and build a fresh one.
      var shell = globalThis.document.getElementById(WIDGET_ID);
      if (shell && shell.parentNode) shell.parentNode.removeChild(shell);
    }
    var body = globalThis.document.body;
    if (!body) return false; // retried via DOMContentLoaded below

    var styles = styleString();
    var widget = globalThis.document.createElement('div');
    widget.id = WIDGET_ID;
    widget.className = 'plamo-translate-widget plamo-ui';
    widget.setAttribute('data-plamo-skip', 'true');
    widget.setAttribute('lang', 'ja');
    widget.setAttribute('style', styles.widget);

    button = globalThis.document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.className = 'plamo-ui';
    button.setAttribute('data-plamo-skip', 'true');
    button.setAttribute('style', styles.button);
    button.addEventListener('click', onClick);

    sub = globalThis.document.createElement('div');
    sub.id = SUB_ID;
    sub.className = 'plamo-ui';
    sub.setAttribute('data-plamo-skip', 'true');
    sub.setAttribute('style', styles.sub);

    widget.appendChild(button);
    widget.appendChild(sub);
    body.appendChild(widget);

    var st = state();
    // A page translated before this script arrived (a run started from the
    // popup, or a late injection) must not offer 和訳 twice.
    mode = (st && st.renderedNodes > 0) ? 'done' : 'idle';
    render();
    return true;
  }

  if (!mount() && globalThis.document) {
    globalThis.document.addEventListener('DOMContentLoaded', function () { mount(); });
  }

  ns.ui = {
    onRunEvent: onRunEvent,
    mount: mount,
    // Exposed for the console: force a repaint after poking __plamo by hand.
    refresh: render,
    getMode: function () { return mode; }
  };
})();
