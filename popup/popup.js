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
  var profileNames = ns.profiles.profileNames;
  var MSG_TRANSLATE_PAGE = ns.constants.MSG_TRANSLATE_PAGE;
  var MSG_RESTORE = ns.constants.MSG_RESTORE;
  var MSG_STOP = ns.constants.MSG_STOP;

  var $ = function (id) { return document.getElementById(id); };
  var settings = {};
  var status = 'idle';
  var lastError = null;
  var counts = { segments: 0, translated: 0, failed: 0 };

  function render() {
    if ($('status')) $('status').textContent = status;
    if ($('segCount')) $('segCount').textContent = counts.segments;
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
      cacheHits: res.cacheHits, elapsedMs: res.elapsedMs, phase: res.phase
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

  function populateProfiles() {
    var sel = $('profile');
    profileNames().forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  }

  function init() {
    populateProfiles();
    loadSettings().then(function (s) {
      settings = s;
      var profileSel = $('profile');
      if (profileSel) profileSel.value = settings.profileName;
      var concSel = $('concurrency');
      if (concSel) concSel.value = String(clampConcurrent(settings.maxConcurrent));
      render();
    }).catch(function (err) {
      lastError = 'settings could not be loaded: ' + String((err && err.message) || err);
      renderStatus('error');
    });

    $('translateBtn').addEventListener('click', function () {
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
        counts = { segments: res.total, translated: res.translated, failed: res.failed };
        var applied = (res.applied != null) ? res.applied : res.translated;
        var label = res.failed
          ? ('failed ' + res.failed + ' / ' + res.total)
          : ('applied ' + applied + ' / ' + res.total);
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
          counts = { segments: 0, translated: 0, failed: 0 };
          var still = (res.translated != null) ? res.translated : 0;
          renderStatus('restored ' + (res.restored || 0) + ' text node(s)' + (still ? ' (' + still + ' still translated)' : ''));
        }).catch(function (err) {
          lastError = String((err && err.message) || err) + messaging.hintFor(err && err.message);
          renderStatus('page not ready (reload it)');
        });
      });
    }

    $('profile').addEventListener('change', function () {
      settings.profileName = $('profile').value;
      saveSettings({ profileName: settings.profileName });
    });
    $('mode').addEventListener('change', function () {
      settings.mode = $('mode').value;
      saveSettings({ mode: settings.mode });
    });
    $('concurrency').addEventListener('change', function () {
      settings.maxConcurrent = clampConcurrent($('concurrency').value);
      saveSettings({ maxConcurrent: settings.maxConcurrent });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
