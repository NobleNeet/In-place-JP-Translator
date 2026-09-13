// popup/popup.js
// Classic-script popup controller. Depends on: shared/settings.js, api/profiles.js
// (loaded before this file in popup.html).
(function () {
  var ns = globalThis.__PLAMO__;
  var loadSettings = ns.settings.loadSettings;
  var saveSettings = ns.settings.saveSettings;
  var clampConcurrent = ns.settings.clampConcurrent;
  var profileNames = ns.profiles.profileNames;
  var MSG_TRANSLATE_PAGE = ns.constants.MSG_TRANSLATE_PAGE;
  var MSG_STOP = ns.constants.MSG_STOP;

  var $ = function (id) { return document.getElementById(id); };
  var settings = {};
  var status = 'idle';
  var counts = { segments: 0, translated: 0, failed: 0 };

  function render() {
    if ($('status')) $('status').textContent = status;
    if ($('segCount')) $('segCount').textContent = counts.segments;
    if ($('transCount')) $('transCount').textContent = counts.translated;
    if ($('failCount')) $('failCount').textContent = counts.failed;
    var modeSel = $('mode');
    if (modeSel && !ns.settings.isModeSupported(settings.mode)) modeSel.disabled = true;
  }

  function sendToTab(type) {
    return new Promise(function (resolve, reject) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (!tabs || !tabs.length) { reject(new Error('No active tab')); return; }
        chrome.tabs.sendMessage(tabs[0].id, { type: type }, function (response) {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
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
    }).catch(function () { renderStatus('error'); });

    $('translateBtn').addEventListener('click', function () {
      renderStatus('translating');
      sendToTab(MSG_TRANSLATE_PAGE).then(function () { setTimeout(function () { renderStatus('idle'); }, 500); })
        .catch(function () { renderStatus('Page not ready (reload first)'); });
    });

    $('stopBtn').addEventListener('click', function () {
      sendToTab(MSG_STOP).then(function () { renderStatus('idle'); }).catch(function () { renderStatus('error'); });
    });

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
