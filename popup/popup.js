// popup/popup.js
// Classic-script popup controller. Depends on: shared/settings.js, api/profiles.js
// (loaded before this file in popup.html).
(function () {
  var ns = globalThis.__PLAMO__;
  var log = ns.logger.log;
  var messaging = ns.messaging;
  var loadSettings = ns.settings.loadSettings;
  var saveSettings = ns.settings.saveSettings;
  var clampConcurrent = ns.settings.clampConcurrent;
  var clampStrategy = ns.settings.clampStrategy;
  var profileNames = ns.profiles.profileNames;
  var MSG_TRANSLATE_PAGE = ns.constants.MSG_TRANSLATE_PAGE;
  var MSG_RESTORE = ns.constants.MSG_RESTORE;
  var MSG_STOP = ns.constants.MSG_STOP;

  var $ = function (id) { return document.getElementById(id); };
  var settings = {};
  var status = 'idle';
  var lastError = null;
  var counts = { segments: 0, translated: 0, failed: 0, requests: 0 };

  // Every popup write goes through one chain. saveSettings() is a
  // load-merge-write, so two overlapping saves can each merge onto the same
  // base and the later write silently drops the earlier one's patch — most
  // easily hit now that typing in a system prompt schedules its own save
  // while a select change saves at the same moment. Chained, each save
  // merges onto the previous save's result.
  var saveChain = Promise.resolve();
  // Set once the popup starts closing: queued chain saves are skipped so a
  // save that captured older prompt text cannot land after the synchronous
  // pagehide flush and overwrite the newer text.
  var closing = false;
  // Bumped by every synchronous prompt flush. A queued chain save that was
  // built before the flush carries an older generation and skips its write:
  // the flush's own full-settings write already contains that patch (every
  // call site updates `settings` before calling persist), so nothing is
  // lost and the newest prompt text always wins.
  var flushGen = 0;
  function persist(patch) {
    var gen = flushGen;
    saveChain = saveChain.then(function () {
      if (closing || gen !== flushGen) return undefined;
      return saveSettings(patch);
    }).then(function (saved) {
      if (closing || !saved) return saved;
      settings = saved;
      return saved;
    })
      .catch(function (err) {
        log.warn('popup: saveSettings failed: ' + String((err && err.message) || err));
      });
    return saveChain;
  }

  // The system prompt is persisted WHILE it is typed, not only on blur:
  // 'change' fires only when the textarea loses focus after an edit, and
  // closing the popup destroys the document before that can happen, losing
  // the last edit. 'input' + a short debounce saves each pause in typing,
  // and pagehide flushes whatever the debounce still holds when the popup
  // closes. A run started afterwards — the popup's "Translate Page" or the
  // page's 和訳 button — reloads settings from storage (content.js
  // translatePage calls loadSettings() per run), so whatever is saved here
  // is the system prompt every path sends.

  function render() {
    if ($('status')) $('status').textContent = status;
    if ($('segCount')) $('segCount').textContent = counts.segments;
    if ($('reqCount')) $('reqCount').textContent = counts.requests;
    if ($('transCount')) $('transCount').textContent = counts.translated;
    if ($('failCount')) $('failCount').textContent = counts.failed;
    var errEl = $('lastError');
    if (errEl) {
      errEl.textContent = lastError || '';
      errEl.className = lastError ? 'hint error' : 'hint';
    }
    var modeSel = $('mode');
    if (modeSel && !ns.settings.isModeSupported(settings.mode)) modeSel.disabled = true;
  }

  function describeResponse(res) {
    if (!res) return 'no response body';
    if (res.error) return 'ERROR [' + (res.errorType || '?') + '] ' + res.error;
    return JSON.stringify({
      total: res.total, translated: res.translated, failed: res.failed, applied: res.applied,
      requests: res.requests, cacheHits: res.cacheHits, elapsedMs: res.elapsedMs, phase: res.phase
    });
  }

  // Popup -> active tab. Every failure is logged with the hint that applies,
  // because the popup used to swallow them into "Page not ready (reload first)".
  function sendToTab(msg) {
    var t0 = Date.now();
    return new Promise(function (resolve, reject) {
      log.debug('popup -> active tab ' + messaging.summarizeMessage(msg));
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (!tabs || !tabs.length) {
          var noTab = new Error('No active tab');
          log.error('popup: ' + noTab.message + messaging.hintFor(noTab.message));
          reject(noTab);
          return;
        }
        var tabId = tabs[0].id;
        chrome.tabs.sendMessage(tabId, msg, function (response) {
          var ms = Date.now() - t0;
          if (chrome.runtime.lastError) {
            var err = new Error(chrome.runtime.lastError.message);
            log.error('popup: tab#' + tabId + ' reply failed after ' + ms + 'ms :: ' + err.message + messaging.hintFor(err.message));
            reject(err);
            return;
          }
          if (response === undefined) {
            log.warn('popup: tab#' + tabId + ' replied with NO body after ' + ms + 'ms');
          } else {
            log.debug('popup <- tab#' + tabId + ' in ' + ms + 'ms ' + describeResponse(response));
          }
          resolve(response);
        });
      });
    });
  }

  function renderStatus(s, c) {
    status = s;
    if (c) counts = c;
    render();
  }

  // One block per API profile (api/profiles.js): a tick box for "use this
  // server", its own concurrency select, a model dropdown fed by the
  // server's GET /models endpoint, and its own system prompt textarea. Tick
  // several and a run sends its batches through all of them at once: the
  // batches wait in one queue on the page and a server takes the next one
  // when it has a free slot, so the concurrency set here is that server's
  // own bound (translation/dispatch.js).
  //
  // Model and system prompt are per-API and independent: each server runs
  // the model picked in ITS dropdown with THE SYSTEM PROMPT TYPED IN ITS OWN
  // box. An empty box sends no system message at all, which is what a
  // translation-specialised model (plamo2translate) needs; the bundled
  // profiles ship with an empty prompt for exactly that reason, and the
  // "default" button fills in the general-purpose prompt from constants for
  // a general LLM.
  function populateApis() {
    var host = $('apis');
    if (!host) return;
    profileNames().forEach(function (name) {
      var block = document.createElement('div');
      block.className = 'api-block';
      block.setAttribute('data-profile', name);

      // Row 1: tick box + name + this server's own concurrency.
      var row = document.createElement('div');
      row.className = 'api-row';
      var label = document.createElement('label');
      label.className = 'api-name';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'api-enabled';
      label.appendChild(box);
      label.appendChild(document.createTextNode(' ' + name));
      row.appendChild(label);

      var conc = document.createElement('select');
      conc.className = 'api-conc';
      conc.title = 'concurrent requests for this server';
      ns.constants.CONCUR_OPTIONS.forEach(function (n) {
        var opt = document.createElement('option');
        opt.value = String(n);
        opt.textContent = String(n);
        conc.appendChild(opt);
      });
      row.appendChild(conc);
      block.appendChild(row);

      // Row 2: the model dropdown (filled from GET <base>/models) + reload.
      var mrow = document.createElement('div');
      mrow.className = 'api-row';
      var modelSel = document.createElement('select');
      modelSel.className = 'api-model';
      modelSel.title = 'model this server translates with (from its /models endpoint)';
      mrow.appendChild(modelSel);
      var reloadBtn = document.createElement('button');
      reloadBtn.className = 'api-reload';
      reloadBtn.type = 'button';
      reloadBtn.title = 'reload the model list from ' + ns.profiles.modelsUrl(ns.profiles.getProfile(name));
      reloadBtn.textContent = '\u21bb';
      mrow.appendChild(reloadBtn);
      block.appendChild(mrow);

      var modelsHint = document.createElement('div');
      modelsHint.className = 'api-models hint';
      modelsHint.textContent = 'models: loading\u2026';
      block.appendChild(modelsHint);

      // Row 3: this API's own system prompt.
      var prow = document.createElement('div');
      prow.className = 'api-prompt-label';
      var plabel = document.createElement('span');
      plabel.textContent = 'System prompt';
      prow.appendChild(plabel);
      var defBtn = document.createElement('button');
      defBtn.className = 'api-prompt-default';
      defBtn.type = 'button';
      defBtn.title = 'fill the default translation prompt (empty box = send no system prompt)';
      defBtn.textContent = 'use default';
      prow.appendChild(defBtn);
      block.appendChild(prow);

      var ta = document.createElement('textarea');
      ta.className = 'api-system';
      ta.rows = 3;
      ta.spellcheck = false;
      ta.placeholder = 'empty = send no system prompt (required for translation-specialised models)';
      block.appendChild(ta);

      box.addEventListener('change', function () { saveApis(box); });
      conc.addEventListener('change', function () { saveApis(null); });
      modelSel.addEventListener('change', function () { saveApis(null); });
      ta.addEventListener('input', schedulePromptSave);
      ta.addEventListener('change', function () { saveApis(null); });
      reloadBtn.addEventListener('click', function () { refreshModels(name); });
      defBtn.addEventListener('click', function () {
        ta.value = ns.constants.DEFAULT_SYSTEM_PROMPT;
        // Same path as typing: the debounced save covers a popup that closes
        // right after, and promptTouched lets the translate button's
        // synchronous flush pick the new text up before the run starts.
        schedulePromptSave();
      });
      host.appendChild(block);
    });
  }

  function apiBlocks() { return document.querySelectorAll('.api-block'); }

  // Make sure `value` is selectable in `sel` (a saved model the fetched list
  // does not contain still has to show up, marked so it is not mistaken for
  // a live one). Returns the option that was added, if any.
  function ensureOption(sel, value, suffix) {
    if (!value) return null;
    var found = Array.prototype.some.call(sel.options, function (o) { return o.value === value; });
    if (found) return null;
    var opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value + (suffix ? (' ' + suffix) : '');
    sel.insertBefore(opt, sel.firstChild);
    return opt;
  }

  // GET <base>/models for one profile and fill its dropdown. The popup has
  // the same host_permissions as the worker, so this is the same server the
  // batches go to. A failure is shown in the block's hint and leaves the
  // current selection alone: a server that is down for /models can still be
  // translated with (the profile's own model name is kept).
  function refreshModels(name) {
    var block = document.querySelector('.api-block[data-profile="' + name + '"]');
    if (!block) return;
    var sel = block.querySelector('.api-model');
    var hint = block.querySelector('.api-models');
    var profile = ns.profiles.getProfile(name);
    var url = ns.profiles.modelsUrl(profile);
    if (!url) {
      hint.textContent = 'models: no base url configured';
      return;
    }
    hint.textContent = 'models: loading\u2026';
    var opts = { method: 'GET', headers: {} };
    if (profile.apiKey) opts.headers['Authorization'] = 'Bearer ' + profile.apiKey;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 8000);
    opts.signal = ctrl.signal;
    fetch(url, opts).then(function (res) {
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      return res.json();
    }).then(function (json) {
      clearTimeout(timer);
      var raw = (json && json.data) || [];
      var ids = raw.map(function (m) { return m && (m.id || m.model || m.name); })
        .filter(function (id) { return typeof id === 'string' && id.length; });
      if (!ids.length) throw new Error('no models in the response');
      var current = sel.value || profile.model || '';
      sel.innerHTML = '';
      ids.forEach(function (id) {
        var opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        sel.appendChild(opt);
      });
      // Keep whatever was selected (or saved) even if the server no longer
      // lists it; otherwise fall back to the profile's own model.
      var keep = current || profile.model || '';
      if (keep) {
        ensureOption(sel, keep, '(not listed)');
        sel.value = keep;
      }
      hint.textContent = ids.length + ' model(s) from ' + url;
    }).catch(function (err) {
      clearTimeout(timer);
      // Keep the dropdown usable: the profile's own model is the only choice.
      if (!sel.options.length && profile.model) {
        var opt = document.createElement('option');
        opt.value = profile.model;
        opt.textContent = profile.model;
        sel.appendChild(opt);
      }
      hint.textContent = 'models: ' + String((err && err.message) || err) + ' (using the profile model)';
      log.warn('popup: /models failed for ' + name + ' ' + url + ': ' + String((err && err.message) || err));
    });
  }

  function refreshAllModels() {
    profileNames().forEach(function (name) { refreshModels(name); });
  }

  // Everything typed into the blocks, keyed by profile name.
  function readApis() {
    var apis = {};
    Array.prototype.forEach.call(apiBlocks(), function (block) {
      var name = block.getAttribute('data-profile');
      var box = block.querySelector('.api-enabled');
      var conc = block.querySelector('.api-conc');
      var modelSel = block.querySelector('.api-model');
      var ta = block.querySelector('.api-system');
      apis[name] = {
        enabled: !!box.checked,
        concurrency: clampConcurrent(conc.value),
        model: (modelSel && modelSel.value) ? String(modelSel.value).trim() : '',
        systemPrompt: ta ? String(ta.value) : ''
      };
    });
    return apis;
  }

  // One row's change saves the whole block: settings.apis is one object, and a
  // half-saved block would lose the other servers' limits.
  function saveApis(toggledBox) {
    var apis = readApis();
    var enabled = Object.keys(apis).filter(function (name) { return apis[name].enabled; });
    if (!enabled.length) {
      // With no server ticked there is nothing to translate with: re-tick what
      // the user just removed and say why, instead of saving an empty plan.
      if (toggledBox) toggledBox.checked = true;
      renderStatus('at least one API must be ticked');
      return;
    }
    settings.apis = apis;
    // profileName stays the primary server (the fallback plan and the console
    // helpers read it), kept on one that is actually ticked.
    if (enabled.indexOf(settings.profileName) === -1) settings.profileName = enabled[0];
    persist({ apis: settings.apis, profileName: settings.profileName });
  }

  // Reflect the saved settings in the blocks. Nothing ticked in storage (every
  // install saved before per-API settings existed) shows as exactly one tick —
  // the primary profile at the old shared concurrency, which is what it has
  // been doing all along.
  function renderApis() {
    var saved = settings.apis || {};
    var anyTicked = Object.keys(saved).some(function (name) { return saved[name] && saved[name].enabled; });
    Array.prototype.forEach.call(apiBlocks(), function (block) {
      var name = block.getAttribute('data-profile');
      var entry = saved[name];
      var profile = ns.profiles.getProfile(name);
      var box = block.querySelector('.api-enabled');
      var conc = block.querySelector('.api-conc');
      var modelSel = block.querySelector('.api-model');
      var ta = block.querySelector('.api-system');
      box.checked = anyTicked ? !!(entry && entry.enabled) : (name === settings.profileName);
      var c = (entry && entry.concurrency) || settings.maxConcurrent;
      // A saved limit that is not one of the presets (typed into storage, or an
      // older option list) still has to show up in the select.
      var preset = Array.prototype.some.call(conc.options, function (o) { return o.value === String(c); });
      if (!preset) {
        var extra = document.createElement('option');
        extra.value = String(c);
        extra.textContent = String(c) + ' (saved)';
        conc.appendChild(extra);
      }
      conc.value = String(c);
      // The model dropdown starts with what is saved (or the profile's own
      // model) while the /models fetch runs; refreshModels() replaces the list
      // and keeps this selection, marking it "(not listed)" if the server no
      // longer offers it.
      var savedModel = (entry && entry.model) || profile.model || '';
      if (savedModel) {
        var mo = document.createElement('option');
        mo.value = savedModel;
        mo.textContent = savedModel;
        modelSel.appendChild(mo);
        modelSel.value = savedModel;
      }
      // The textarea shows exactly what a run would send for this API right
      // now: the saved per-API prompt, else the profile's own, else the
      // general default. An empty box means no system message at all.
      if (ta) {
        ta.value = (entry && entry.systemPrompt != null) ? entry.systemPrompt
          : ns.profiles.effectiveSystemPrompt(profile);
      }
    });
    refreshAllModels();
  }

  function init() {
    populateApis();
    loadSettings().then(function (s) {
      settings = s;
      renderApis();
      var stratSel = $('strategy');
      if (stratSel) stratSel.value = clampStrategy(settings.request && settings.request.strategy);
      // Only the boolean is surfaced in the popup; the reveal timings stay at
      // their defaults (settings.js clamps anything typed into storage).
      var hiddenSel = $('hidden');
      if (hiddenSel) {
        hiddenSel.value = (settings.priority && settings.priority.deferHidden === false) ? 'now' : 'defer';
      }
      var orderSel = $('order');
      if (orderSel) {
        orderSel.value = (settings.priority && settings.priority.topDown === false) ? 'markup' : 'topDown';
      }
      var segSel = $('segments');
      if (segSel) {
        // A saved cap that is not one of the preset sizes (an older build, or a
        // value typed into storage) still has to show up in the select.
        var segCap = (settings.batch && settings.batch.maxSegmentsPerBatch) ||
          ns.constants.BATCH_SETTINGS.maxSegmentsPerBatch;
        var preset = Array.prototype.some.call(segSel.options, function (o) { return o.value === String(segCap); });
        if (!preset) {
          var extra = document.createElement('option');
          extra.value = String(segCap);
          extra.textContent = String(segCap) + ' (saved)';
          segSel.appendChild(extra);
        }
        segSel.value = String(segCap);
      }
      render();
    }).catch(function (err) {
      lastError = 'settings could not be loaded: ' + String((err && err.message) || err);
      renderStatus('error');
    });

    $('translateBtn').addEventListener('click', function () {
      // Persist the newest prompt text before the run starts, so the content
      // script's per-run loadSettings() cannot read a stale value (see
      // flushPromptNow).
      flushPromptNow();
      lastError = null;
      renderStatus('translating');
      sendToTab({ type: MSG_TRANSLATE_PAGE, id: messaging.makeRequestId('popup') }).then(function (res) {
        if (!res) {
          lastError = 'the page sent no reply. Open the page console (F12) and run __plamo.dumpLogs().';
          renderStatus('no reply from page');
          return;
        }
        if (res.error) {
          lastError = '[' + (res.errorType || '?') + '] ' + res.error + messaging.hintFor(res.error);
          renderStatus('error');
          return;
        }
        counts = { segments: res.total, translated: res.translated, failed: res.failed, requests: res.requests || 0 };
        var applied = (res.applied != null) ? res.applied : res.translated;
        var label = res.failed
          ? ('failed ' + res.failed + ' / ' + res.total)
          : ('applied ' + applied + ' / ' + res.total + (res.requests != null ? ' (' + res.requests + ' request(s))' : ''));
        if (res.errorCounts && Object.keys(res.errorCounts).length) {
          lastError = 'errors: ' + Object.keys(res.errorCounts).map(function (k) {
            return k + '×' + res.errorCounts[k];
          }).join(', ') + ' :: in the page console run __plamo.dumpLogs() (page) and __plamo.backgroundLogs() (worker)';
        } else if (res.total && !applied) {
          lastError = 'the API answered but no text node changed: in the page console run ' +
            '__plamo.getState().skipCounts (why a write was refused) and __plamo.getApplied() (what landed).';
        }
        renderStatus(label + ' in ' + res.elapsedMs + 'ms');
      }).catch(function (err) {
        lastError = String((err && err.message) || err) + messaging.hintFor(err && err.message);
        renderStatus('page not ready (reload it)');
      });
    });

    $('stopBtn').addEventListener('click', function () {
      sendToTab({ type: MSG_STOP, id: messaging.makeRequestId('popup') })
        .then(function () { renderStatus('idle'); })
        .catch(function (err) {
          lastError = String((err && err.message) || err) + messaging.hintFor(err && err.message);
          renderStatus('error');
        });
    });

    // Back to the page as it was loaded: every text node we rewrote gets its
    // original value. Safe to press at any time (also while a run is in flight;
    // translations that arrive afterwards are written again).
    var restoreBtn = $('restoreBtn');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', function () {
        lastError = null;
        renderStatus('restoring');
        sendToTab({ type: MSG_RESTORE, id: messaging.makeRequestId('popup') }).then(function (res) {
          if (!res) {
            lastError = 'the page sent no reply. Open the page console (F12) and run __plamo.dumpLogs().';
            renderStatus('no reply from page');
            return;
          }
          if (res.error) {
            lastError = '[' + (res.errorType || '?') + '] ' + res.error + messaging.hintFor(res.error);
            renderStatus('error');
            return;
          }
          counts = { segments: 0, translated: 0, failed: 0, requests: 0 };
          var still = (res.translated != null) ? res.translated : 0;
          renderStatus('restored ' + (res.restored || 0) + ' text node(s)' + (still ? ' (' + still + ' still translated)' : ''));
        }).catch(function (err) {
          lastError = String((err && err.message) || err) + messaging.hintFor(err && err.message);
          renderStatus('page not ready (reload it)');
        });
      });
    }

    $('mode').addEventListener('change', function () {
      settings.mode = $('mode').value;
      persist({ mode: settings.mode });
    });

    // Packing settings are read by the content script when a run starts, so a
    // change here applies to the next "Translate Page" press.
    var strategySel = $('strategy');
    if (strategySel) {
      strategySel.addEventListener('change', function () {
        settings.request = Object.assign({}, settings.request, { strategy: clampStrategy($('strategy').value) });
        persist({ request: settings.request });
      });
    }
    var segmentsSel = $('segments');
    if (segmentsSel) {
      segmentsSel.addEventListener('change', function () {
        var n = parseInt($('segments').value, 10);
        if (!isFinite(n) || n < 1) return;
        settings.batch = Object.assign({}, settings.batch, { maxSegmentsPerBatch: n });
        persist({ batch: settings.batch });
      });
    }
    // The segmenter reads this when a run starts, so it applies to the next
    // "Translate Page" press. A run that already held text back keeps watching
    // for that text until it is displayed or Stop / Restore is pressed.
    var hiddenSel = $('hidden');
    if (hiddenSel) {
      hiddenSel.addEventListener('change', function () {
        var defer = $('hidden').value !== 'now';
        settings.priority = Object.assign({}, settings.priority || {}, { deferHidden: defer });
        persist({ priority: settings.priority });
      });
    }
    // Which order the next run sorts its segments in (content/priority.js): the
    // region class always comes first, so this only decides the order *within*
    // the article, within the headings, within the menu.
    var orderSel = $('order');
    if (orderSel) {
      orderSel.addEventListener('change', function () {
        var topDown = $('order').value !== 'markup';
        settings.priority = Object.assign({}, settings.priority || {}, { topDown: topDown });
        persist({ priority: settings.priority });
      });
    }
  }

  // Debounced save for the system prompt textareas: one save per typing pause
  // (readApis() reads the live DOM, so the save always carries the newest
  // text of every block, not just the one being typed in).
  var promptSaveTimer = null;
  // Set on the first keystroke in any prompt box and never cleared: the
  // pagehide flush then always re-writes the live textareas, which is the
  // only write that is guaranteed to run before the popup document dies.
  var promptTouched = false;
  function schedulePromptSave() {
    promptTouched = true;
    if (promptSaveTimer) clearTimeout(promptSaveTimer);
    promptSaveTimer = setTimeout(function () {
      promptSaveTimer = null;
      saveApis(null);
    }, 250);
  }

  // Writes the live prompt text to storage with one synchronous set().
  // Called from two places, both of which must not lose the last keystrokes:
  //   - the translate button, BEFORE the run message goes out: the set is
  //     issued before sendMessage, and the content script's loadSettings()
  //     only runs after that message arrives, so the run - whether started
  //     here or later by the page's 和訳 button - reads the newest prompt.
  //   - pagehide: the popup document is destroyed as soon as it closes, so
  //     the async load-merge-write of saveSettings() can die between its
  //     two awaits; this single set() is the flush that actually lands (the
  //     storage write is IPC to the browser process and completes on its
  //     own). `closing` then stops any queued chain save from overwriting it.
  // settings is the in-memory copy every persist() keeps current and
  // readApis() reads the live textareas, so the write carries the newest
  // text of every field, not just the prompt.
  function flushPromptNow() {
    if (!promptTouched) return;
    if (promptSaveTimer) { clearTimeout(promptSaveTimer); promptSaveTimer = null; }
    var apis = readApis();
    var enabled = Object.keys(apis).filter(function (name) { return apis[name].enabled; });
    if (!enabled.length) return; // never save an empty plan (same rule as saveApis)
    settings.apis = apis;
    if (enabled.indexOf(settings.profileName) === -1) settings.profileName = enabled[0];
    flushGen++;
    try {
      chrome.storage.local.set({ plamo: Object.assign({}, settings) });
    } catch (e) {
      log.warn('popup: prompt flush failed: ' + String((e && e.message) || e));
    }
  }

  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('pagehide', function () {
      closing = true;
      flushPromptNow();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
