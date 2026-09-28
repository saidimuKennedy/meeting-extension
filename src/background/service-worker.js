import { MSG } from '../lib/messages.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

// setPanelBehavior persists across reloads. An earlier build set this to true, which
// swallows the action click and prevents the activeTab grant that tabCapture requires.
// Force it off so chrome.action.onClicked fires instead.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);

chrome.action.onClicked.addListener((tab) => {
  // Opening from the action click counts as invoking the extension, which grants
  // activeTab for this tab. tabCapture.getMediaStreamId requires that invocation.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
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
    startCapture(msg.meetingId).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === MSG.STOP_CAPTURE) {
    stopCapture().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

async function startCapture(meetingId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab to capture.');

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
    tabTitle: tab.title || 'Untitled meeting'
  });
}

async function stopCapture() {
  await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_STOP });
}
