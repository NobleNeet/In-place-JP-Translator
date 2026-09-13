// popup/popup.js
// Minimal control panel. Reads/writes settings via chrome.storage.local and
// drives the content script on the active tab.

import { loadSettings, saveSettings, clampConcurrent } from '../shared/settings.js';
import { profileNames } from '../api/profiles.js';
import { MSG_TRANSLATE_PAGE, MSG_STOP } from '../shared/constants.js';

const $ = (id) => document.getElementById(id);

const els = {
  translateBtn: $('translateBtn'),
  stopBtn: $('stopBtn'),
  profile: $('profile'),
  mode: $('mode'),
  concurrency: $('concurrency'),
  state: $('state'),
  segments: $('segments'),
  translated: $('translated'),
  failed: $('failed'),
};

let settings = await loadSettings();

function populateProfiles() {
  els.profile.innerHTML = '';
  for (const name of profileNames()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === settings.profileName) opt.selected = true;
    els.profile.appendChild(opt);
  }
}

function renderSettings() {
  els.profile.value = settings.profileName;
  els.mode.value = settings.mode;
  els.concurrency.value = String(settings.maxConcurrent);
}

function renderState(st) {
  els.state.textContent = st.phase;
  els.segments.textContent = st.segments;
  els.translated.textContent = st.translated;
  els.failed.textContent = st.failed;
  const busy = st.phase === 'translating' || st.phase === 'extracting';
  els.translateBtn.disabled = busy;
  els.stopBtn.disabled = !busy;
}

function activeTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0]));
  });
}

async function sendToTab(message) {
  const tab = await activeTab();
  if (!tab || !tab.id) {
    els.state.textContent = 'No page (reload the page first)';
    return;
  }
  chrome.tabs.sendMessage(tab.id, message, () => {
    if (chrome.runtime.lastError) {
      els.state.textContent = 'Page not ready (reload first)';
      console.warn('[PLaMoTranslate]', chrome.runtime.lastError.message);
    }
  });
}

async function applySettings() {
  const patch = {
    profileName: els.profile.value,
    mode: els.mode.value,
    maxConcurrent: clampConcurrent(els.concurrency.value),
  };
  await saveSettings(patch);
  settings = await loadSettings();
}

els.translateBtn.addEventListener('click', async () => {
  await applySettings();
  await sendToTab({ type: MSG_TRANSLATE_PAGE });
});

els.stopBtn.addEventListener('click', async () => {
  await applySettings();
  await sendToTab({ type: MSG_STOP });
});

els.profile.addEventListener('change', applySettings);
els.mode.addEventListener('change', applySettings);
els.concurrency.addEventListener('change', applySettings);

// Live status updates from the content script.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === MSG_STATUS && msg.state) renderState(msg.state);
});

populateProfiles();
renderSettings();

// Pull the current state from the active tab on open.
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  if (tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: MSG_STATUS }, (resp) => {
      if (resp && resp.state) renderState(resp.state);
    });
  }
});
