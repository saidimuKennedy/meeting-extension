import { MSG } from '../lib/messages.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

chrome.action.onClicked.addListener((tab) => {
  const extensionRoot = chrome.runtime.getURL('');
  if (tab?.url?.startsWith(extensionRoot)) return;

  const workspaceUrl = new URL(chrome.runtime.getURL('src/sidepanel/sidepanel.html'));
  if (tab?.id) workspaceUrl.searchParams.set('targetTabId', String(tab.id));
  chrome.tabs.create({ url: workspaceUrl.href }).catch(console.error);
});

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  return contexts.length > 0;
}

let readyResolvers = [];

function waitForOffscreenReady(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const resolveOnce = () => {
      clearTimeout(timer);
      readyResolvers = readyResolvers.filter((r) => r !== resolveOnce);
      resolve();
    };
    const timer = setTimeout(resolveOnce, timeoutMs);
    readyResolvers.push(resolveOnce);
  });
}

function signalOffscreenReady() {
  const resolvers = readyResolvers;
  readyResolvers = [];
  resolvers.forEach((r) => r());
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  const ready = waitForOffscreenReady();
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Record tab and microphone audio for meeting transcription.'
  });
  await ready;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === MSG.OFFSCREEN_READY) {
    signalOffscreenReady();
    return;
  }
  if (msg.type === MSG.START_CAPTURE) {
    startCapture(msg.meetingId, msg.targetTabId, msg.maxDurationSec).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === MSG.STOP_CAPTURE) {
    stopCapture().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

async function startCapture(meetingId, targetTabId, maxDurationSec) {
  let tab;
  if (Number.isInteger(targetTabId) && targetTabId > 0) {
    try {
      tab = await chrome.tabs.get(targetTabId);
    } catch {
      throw new Error('The meeting tab is no longer open. Reopen the meeting tab and start again.');
    }
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab?.id) throw new Error('No active tab to capture.');
  if (isSpotifyUrl(tab.url)) {
    throw new Error('Spotify audio cannot be transcribed. Start recording from a permitted meeting or audio source.');
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (e) {
    if (String(e).includes('has not been invoked')) {
      throw new Error('Click the Meeting Notes toolbar icon on the tab you want to record, then press Start.');
    }
    throw e;
  }
  await ensureOffscreen();

  await chrome.runtime.sendMessage({
    type: MSG.OFFSCREEN_START,
    streamId,
    meetingId,
    maxDurationSec,
    tabTitle: tab.title || 'Untitled meeting'
  });
}

function isSpotifyUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'spotify.com' || hostname.endsWith('.spotify.com');
  } catch {
    return false;
  }
}

async function stopCapture() {
  await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_STOP });
}
