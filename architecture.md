# Meeting Notes — Architecture & Scaffolding Blueprint

> Internal tool. 5 users max. Chrome Extension (Manifest V3), vanilla HTML/CSS/JS, **no build step**.
> Capture tab + mic audio → transcribe with Gemini → structure notes with DeepSeek → store locally.

---

## 1. Purpose & context

An internal, near-zero-cost alternative to paid note-takers (Otter, Fireflies, Granola). It is **not** a
hosted agent and **not** a SaaS product. It runs entirely in the browser as an unpacked extension,
uses bring-your-own-key (BYOK) APIs, and keeps transcripts on the user's machine.

The wedge is **cost** (~$0 vs ~$20/user/mo) and **custom note format**, not feature parity.

---

## 2. Goals / non-goals

**Goals**
- Capture audio from any tab (Meet, Zoom web, Teams web, YouTube) plus the user's microphone.
- Produce faithful, structured Markdown notes via a swappable template.
- Store meeting history locally; export as Markdown.
- Keep the code small enough for one new developer to maintain.

**Non-goals (v1)**
- Chrome Web Store publication, accounts, billing, teams/roles.
- Calendar integrations, mobile, sharing, real-time collaboration.
- A diarization model. Speaker attribution is a cheap heuristic (see §9).

---

## 3. Constraints & key decisions

| Decision | Choice | Why |
|---|---|---|
| Distribution | Unpacked extension (zip + load) | No store review; only 5 users |
| Build tooling | None — vanilla JS, ES modules | MV3 can't run TS directly; toolchain is overhead |
| UI library | None — hand-written monochrome CSS | Radix is React; mimic the neutral aesthetic instead |
| Capture | `tabCapture` + offscreen doc | Platform-agnostic, robust vs DOM scraping |
| Ears (audio→text) | Gemini `gemini-3.6-flash` native audio | One vendor, free tier, handles audio directly |
| Brain (text→notes) | DeepSeek `deepseek-chat` | User already has a key; cheap, good summarizer |
| Storage | IndexedDB | `chrome.storage` has tight size limits; transcripts are large |
| Keys | `chrome.storage.local`, BYOK | Zero infra; proxy deferred to v1.5 |
| Speaker labels | Mix mic + tab; label generically | Avoids a diarization model in v1 |

---

## 4. High-level architecture

```
┌──────────────────────────── Chrome ────────────────────────────┐
│                                                                │
│  [Meeting tab] ──tabCapture──┐                                 │
│                              ▼                                 │
│  [Offscreen document]  record tab + mic → mixed webm blob       │
│         │                                                      │
│         │ RECORDING_DONE (base64)                              │
│         ▼                                                      │
│  [Service worker]  orchestrates, owns offscreen lifecycle       │
│         ▲                                                      │
│         │ START / STOP                                         │
│  [Side panel UI]  settings, controls, notes, history            │
│         │                                                      │
└─────────┼──────────────────────────────────────────────────────┘
          │ fetch (BYOK)
          ▼
   Gemini (audio → transcript text)  →  DeepSeek (text → Markdown)
          │
          ▼
   IndexedDB (meeting history, local only)
```

Three seams keep the system swappable:
`TranscriptionProvider`, `NotesProvider`, `NotesStore`.

---

## 5. Data flow

1. User opens the side panel on a meeting tab and clicks **Start**.
2. Side panel → service worker: `START_CAPTURE`.
3. Service worker resolves the active tab, calls
   `chrome.tabCapture.getMediaStreamId({ targetTabId })`, ensures the offscreen document exists,
   and forwards the stream id.
4. Offscreen document:
   - `getUserMedia` for the tab stream (via `chromeMediaSourceId`) and the mic.
   - Mixes both into one `MediaStreamDestination` via Web Audio.
   - **Routes tab audio back to speakers** (capturing a tab otherwise silences it).
   - Records with `MediaRecorder` (Opus, low bitrate).
5. User clicks **Stop** → service worker → offscreen stops → offscreen emits `RECORDING_DONE`
   with a base64 blob (runtime messaging is JSON-only, so base64, not a Blob).
6. Side panel receives the blob, calls `TranscriptionProvider.transcribe()` (Gemini) → transcript text.
7. Side panel calls `NotesProvider.generateNotes()` (DeepSeek) with the selected template → Markdown.
8. Side panel saves a `Meeting` record to IndexedDB and renders the notes.

---

## 6. File tree

```
meeting-notes-extension/
├── manifest.json
├── architecture.md
├── README.md
└── src/
    ├── background/
    │   └── service-worker.js        # orchestration + offscreen lifecycle
    ├── offscreen/
    │   ├── offscreen.html           # empty shell; loads offscreen.js as a module
    │   └── offscreen.js             # audio capture, mixing, recording
    ├── sidepanel/
    │   ├── sidepanel.html           # UI shell
    │   ├── sidepanel.css            # monochrome design system
    │   └── sidepanel.js             # UI logic, pipeline wiring, history
    ├── lib/
    │   ├── messages.js              # message type constants
    │   ├── settings.js              # API keys + prefs in chrome.storage.local
    │   ├── models.js                # default Gemini/DeepSeek model chains
    │   ├── net.js                   # fetchWithRetry (backoff + Retry-After)
    │   ├── store.js                 # NotesStore over IndexedDB (+ audio segments)
    │   ├── templates.js             # note templates as data
    │   └── providers/
    │       ├── transcription.gemini.js
    │       └── notes.deepseek.js
    └── assets/
        ├── icon-16.png
        ├── icon-48.png
        └── icon-128.png
```

---

## 7. File-by-file specification

### 7.1 `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "Meeting Notes (internal)",
  "version": "0.1.0",
  "description": "Capture tab + mic audio, transcribe with Gemini, structure notes with DeepSeek.",
  "minimum_chrome_version": "116",
  "permissions": [
    "sidePanel",
    "storage",
    "tabCapture",
    "offscreen",
    "activeTab"
  ],
  "host_permissions": [
    "https://generativelanguage.googleapis.com/*",
    "https://api.deepseek.com/*"
  ],
  "background": {
    "service_worker": "src/background/service-worker.js",
    "type": "module"
  },
  "side_panel": {
    "default_path": "src/sidepanel/sidepanel.html"
  },
  "action": {
    "default_title": "Meeting Notes"
  },
  "icons": {
    "16": "src/assets/icon-16.png",
    "48": "src/assets/icon-48.png",
    "128": "src/assets/icon-128.png"
  }
}
```

Notes:
- `minimum_chrome_version: 116` is required for `chrome.runtime.getContexts()`.
- `host_permissions` are what let extension pages `fetch` those APIs without CORS issues.
- No `content_scripts`. v1 does not scrape pages.

### 7.2 `src/background/service-worker.js`

```js
import { MSG } from '../lib/messages.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

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
    startCapture().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === MSG.STOP_CAPTURE) {
    stopCapture().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

async function startCapture() {
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
    tabTitle: tab.title || 'Untitled meeting'
  });
}

async function stopCapture() {
  await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_STOP });
}
```

Notes:
- `RECORDING_DONE` is emitted by the offscreen document and is received directly by the side panel,
  so the service worker does not need to relay it.
- If the service worker is suspended mid-recording, the offscreen document keeps recording; a later
  message from it wakes the worker. This is expected MV3 behavior.

### 7.3 `src/offscreen/offscreen.html`

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <script type="module" src="offscreen.js"></script>
  </body>
</html>
```

### 7.3b `src/offscreen/offscreen.js`

```js
import { MSG } from '../lib/messages.js';

let recorder = null;
let chunks = [];
let audioCtx = null;
let tabStream = null;
let micStream = null;
let startedAt = 0;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.OFFSCREEN_START) start(msg.streamId);
  if (msg.type === MSG.OFFSCREEN_STOP) stop();
});

chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_READY });

async function start(streamId) {
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false
    });

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);

    audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const dest = audioCtx.createMediaStreamDestination();

    const tabSrc = audioCtx.createMediaStreamSource(tabStream);
    tabSrc.connect(dest);
    tabSrc.connect(audioCtx.destination); // keep the captured tab audible to the user

    if (micStream) {
      const micSrc = audioCtx.createMediaStreamSource(micStream);
      micSrc.connect(dest); // never route the mic to speakers (feedback)
    }

    recorder = new MediaRecorder(dest.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 32000
    });

    chunks = [];
    startedAt = Date.now();
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = onStop;
    recorder.start(1000);
  } catch (err) {
    cleanup();
    await chrome.runtime.sendMessage({
      type: MSG.CAPTURE_ERROR,
      error: String(err?.message || err)
    });
  }
}

async function stop() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function onStop() {
  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const base64 = await blobToBase64(blob);
  cleanup();

  await chrome.runtime.sendMessage({
    type: MSG.RECORDING_DONE,
    base64,
    mimeType: 'audio/webm',
    durationSec
  });
}

function cleanup() {
  tabStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  tabStream = micStream = audioCtx = recorder = null;
  chunks = [];
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
```

Notes:
- The "route tab audio back to `audioCtx.destination`" line is essential. Without it, the user hears
  nothing from the captured tab for the whole meeting.
- `audioBitsPerSecond: 32000` keeps a one-hour recording near ~15 MB, under the Gemini inline limit
  (~20 MB). Raise it only if quality demands and you switch to the Files API.

### 7.4 `src/sidepanel/sidepanel.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="sidepanel.css" />
  </head>
  <body>
    <header class="bar">
      <span class="dot" id="status-dot"></span>
      <h1>Meeting Notes</h1>
      <button class="ghost" id="settings-toggle" aria-label="Settings">Settings</button>
    </header>

    <section class="controls">
      <button id="start" class="primary">Start</button>
      <button id="stop" class="secondary" disabled>Stop</button>
      <span class="status" id="status-text">Idle</span>
    </section>

    <section class="settings hidden" id="settings">
      <label>Gemini API key <input type="password" id="gemini-key" placeholder="AIza..." /></label>
      <label>DeepSeek API key <input type="password" id="deepseek-key" placeholder="sk-..." /></label>
      <label>Template
        <select id="template"></select>
      </label>
      <button id="save-settings" class="primary">Save</button>
    </section>

    <section class="output">
      <div class="tabs">
        <button class="tab active" data-view="notes">Notes</button>
        <button class="tab" data-view="transcript">Transcript</button>
      </div>
      <article id="notes" class="markdown empty">No notes yet.</article>
      <pre id="transcript" class="hidden"></pre>
    </section>

    <section class="history">
      <h2>History</h2>
      <ul id="history-list"></ul>
    </section>

    <script type="module" src="sidepanel.js"></script>
  </body>
</html>
```

### 7.4b `src/sidepanel/sidepanel.css`

```css
:root {
  --bg: #ffffff;
  --fg: #000000;
  --muted: #6b6b6b;
  --border: #d9d9d9;
  --surface: #f5f5f5;
  --radius: 6px;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000000;
    --fg: #ffffff;
    --muted: #9a9a9a;
    --border: #2a2a2a;
    --surface: #121212;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 12px;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.5;
}

h1 { font-size: 14px; margin: 0; font-weight: 600; }
h2 { font-size: 12px; margin: 16px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }

.bar { display: flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.dot.recording { background: var(--fg); animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { opacity: .3; } }

button {
  font: inherit;
  padding: 6px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}
button:disabled { opacity: .4; cursor: default; }
.primary { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.ghost { margin-left: auto; border: none; color: var(--muted); padding: 4px; }
.secondary { background: transparent; }

.controls { display: flex; align-items: center; gap: 8px; margin: 12px 0; }
.status { color: var(--muted); margin-left: auto; }

.settings { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); margin-bottom: 12px; }
.settings label { display: grid; gap: 4px; color: var(--muted); }
input, select {
  font: inherit; padding: 6px 8px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg); color: var(--fg);
}

.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
.tab { border: none; border-radius: 0; color: var(--muted); }
.tab.active { color: var(--fg); border-bottom: 2px solid var(--fg); }

.markdown { padding: 12px 0; }
.markdown h1 { font-size: 15px; margin: 14px 0 6px; }
.markdown h2 { font-size: 13px; color: var(--fg); text-transform: none; letter-spacing: 0; margin: 12px 0 4px; }
.markdown ul { padding-left: 18px; margin: 4px 0; }
.markdown code { font-family: var(--mono); background: var(--surface); padding: 1px 4px; border-radius: 4px; }
.markdown.empty { color: var(--muted); }

pre { white-space: pre-wrap; font-family: var(--mono); font-size: 12px; }

.history ul { list-style: none; padding: 0; margin: 0; }
.history li { padding: 8px 0; border-bottom: 1px solid var(--border); cursor: pointer; }
.history li:hover { background: var(--surface); }
.history .meta { color: var(--muted); font-size: 11px; }

.hidden { display: none; }
```

### 7.4c `src/sidepanel/sidepanel.js`

```js
import { MSG } from '../lib/messages.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { templates } from '../lib/templates.js';
import { transcribe } from '../lib/providers/transcription.gemini.js';
import { generateNotes } from '../lib/providers/notes.deepseek.js';
import { saveMeeting, listMeetings, getMeeting, deleteMeeting } from '../lib/store.js';

const $ = (id) => document.getElementById(id);
const els = {
  dot: $('status-dot'), status: $('status-text'),
  start: $('start'), stop: $('stop'),
  settingsToggle: $('settings-toggle'), settings: $('settings'),
  geminiKey: $('gemini-key'), deepseekKey: $('deepseek-key'),
  template: $('template'), saveSettings: $('save-settings'),
  notes: $('notes'), transcript: $('transcript'),
  history: $('history-list')
};

let currentMeetingId = null;

init();

async function init() {
  templates.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    els.template.appendChild(opt);
  });

  const settings = await getSettings();
  els.geminiKey.value = settings.geminiKey || '';
  els.deepseekKey.value = settings.deepseekKey || '';
  els.template.value = settings.templateId || templates[0].id;

  renderHistory();

  els.settingsToggle.onclick = () => els.settings.classList.toggle('hidden');
  els.saveSettings.onclick = onSaveSettings;
  els.start.onclick = onStart;
  els.stop.onclick = onStop;

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => switchView(tab.dataset.view);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.RECORDING_DONE) onRecordingDone(msg);
  });
}

async function onSaveSettings() {
  await saveSettings({
    geminiKey: els.geminiKey.value.trim(),
    deepseekKey: els.deepseekKey.value.trim(),
    templateId: els.template.value
  });
  els.settings.classList.add('hidden');
  setStatus('Settings saved');
}

async function onStart() {
  const settings = await getSettings();
  if (!settings.geminiKey || !settings.deepseekKey) {
    els.settings.classList.remove('hidden');
    setStatus('Add your API keys first');
    return;
  }
  let micOk = true;
  try {
    await primeMicrophone();
  } catch (err) {
    micOk = false;
  }
  setStatus('Starting...');
  const res = await chrome.runtime.sendMessage({ type: MSG.START_CAPTURE });
  if (!res?.ok) { setStatus(res?.error || 'Failed to start'); return; }
  setRecording(true);
  if (!micOk) setStatus('Recording (microphone blocked — tab audio only)');
}

async function primeMicrophone() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
}

async function onStop() {
  setStatus('Stopping...');
  await chrome.runtime.sendMessage({ type: MSG.STOP_CAPTURE });
}

async function onRecordingDone({ base64, mimeType, durationSec }) {
  setRecording(false);
  const settings = await getSettings();
  const template = templates.find((t) => t.id === settings.templateId) || templates[0];

  try {
    setStatus('Transcribing...');
    const transcript = await transcribe({ base64, mimeType, apiKey: settings.geminiKey });
    els.transcript.textContent = transcript;

    setStatus('Generating notes...');
    const notesMarkdown = await generateNotes({ transcript, template, apiKey: settings.deepseekKey });
    renderMarkdown(notesMarkdown);

    const meeting = {
      id: crypto.randomUUID(),
      title: 'Meeting',
      source: 'tab',
      startedAt: Date.now() - durationSec * 1000,
      durationSec,
      participants: [],
      transcript,
      templateId: template.id,
      notesMarkdown,
      status: 'done'
    };
    await saveMeeting(meeting);
    currentMeetingId = meeting.id;
    renderHistory();
    setStatus('Done');
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + err.message);
  }
}

function setRecording(on) {
  els.start.disabled = on;
  els.stop.disabled = !on;
  els.dot.classList.toggle('recording', on);
  if (on) setStatus('Recording');
}

function setStatus(text) { els.status.textContent = text; }

function switchView(view) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  els.notes.classList.toggle('hidden', view !== 'notes');
  els.transcript.classList.toggle('hidden', view !== 'transcript');
}

function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = esc(md)
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^\s*[-*] \[ \] (.*)$/gm, '<li>$1</li>')
    .replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br/>');
  els.notes.classList.remove('empty');
  els.notes.innerHTML = html;
}

async function renderHistory() {
  const meetings = await listMeetings();
  els.history.innerHTML = '';
  for (const m of meetings) {
    const li = document.createElement('li');
    const date = new Date(m.startedAt).toLocaleString();
    li.innerHTML = `<div>${escapeHtml(m.title)}</div><div class="meta">${date} · ${Math.round(m.durationSec / 60)} min</div>`;
    li.onclick = async () => {
      const full = await getMeeting(m.id);
      renderMarkdown(full.notesMarkdown);
      els.transcript.textContent = full.transcript;
      switchView('notes');
    };
    els.history.appendChild(li);
  }
}

function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
```

Notes:
- Markdown rendering is a deliberately tiny hand-rolled renderer (no dependencies, no remote scripts —
  MV3 CSP forbids remote code). Swap in a bundled `marked` later if needed.
- `deleteMeeting` is imported for a future history delete button.

### 7.5 `src/lib/messages.js`

```js
export const MSG = {
  START_CAPTURE: 'START_CAPTURE',
  STOP_CAPTURE: 'STOP_CAPTURE',
  OFFSCREEN_START: 'OFFSCREEN_START',
  OFFSCREEN_STOP: 'OFFSCREEN_STOP',
  RECORDING_DONE: 'RECORDING_DONE'
};
```

### 7.6 `src/lib/settings.js`

```js
const KEY = 'settings';

export async function getSettings() {
  const { [KEY]: settings = {} } = await chrome.storage.local.get(KEY);
  return settings;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
```

### 7.7 `src/lib/providers/transcription.gemini.js`

```js
const MODEL = 'gemini-3.6-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PROMPT = [
  'Transcribe this meeting audio verbatim.',
  'Label distinct speakers as Speaker 1, Speaker 2, etc. Do not guess names.',
  'Insert a timestamp [mm:ss] every ~30 seconds.',
  'Output plain text only, no commentary.'
].join(' ');

export async function transcribe({ base64, mimeType, apiKey }) {
  const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: PROMPT },
          { inlineData: { mimeType, data: base64 } }
        ]
      }],
      generationConfig: { temperature: 0 }
    })
  });

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}
```

Notes:
- Inline audio is capped near 20 MB total request size. At 32 kbps that is roughly 80+ minutes.
  For longer sessions, chunk audio or switch to the Gemini Files API (see §17).

### 7.8 `src/lib/providers/notes.deepseek.js`

```js
const ENDPOINT = 'https://api.deepseek.com/chat/completions';

export async function generateNotes({ transcript, template, apiKey, model = 'deepseek-chat' }) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: template.system },
        { role: 'user', content: template.user(transcript) }
      ]
    })
  });

  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}
```

### 7.9 `src/lib/templates.js`

```js
export const templates = [
  {
    id: 'standard',
    name: 'Standard meeting',
    system: 'You are an executive assistant. Produce concise, faithful meeting notes in Markdown. Never invent facts. If something is unclear, omit it.',
    user: (t) => [
      'Summarize this meeting transcript using exactly this structure:',
      '',
      '# Summary',
      '(2-3 sentences)',
      '',
      '# Key Decisions',
      '- ...',
      '',
      '# Action Items',
      '- [ ] Owner — task',
      '',
      '# Discussion Highlights',
      '- ...',
      '',
      'Transcript:',
      '"""',
      t,
      '"""'
    ].join('\n')
  },
  {
    id: 'standup',
    name: 'Daily standup',
    system: 'You are a team lead summarizing a standup. Be terse and factual.',
    user: (t) => [
      'From this standup transcript, produce:',
      '',
      '# Done',
      '# Doing',
      '# Blockers',
      '# Action Items',
      '- [ ] Owner — task',
      '',
      'Transcript:',
      '"""',
      t,
      '"""'
    ].join('\n')
  }
];
```

### 7.10 `src/lib/store.js` (NotesStore over IndexedDB)

```js
const DB_NAME = 'meeting-notes';
const DB_VERSION = 1;
const STORE = 'meetings';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveMeeting(meeting) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(meeting);
    tx.oncomplete = () => resolve(meeting.id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listMeetings() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.startedAt - a.startedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function getMeeting(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteMeeting(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```

---

## 8. Data model

```ts
Meeting {
  id: string;              // crypto.randomUUID()
  title: string;           // from captured tab title
  source: string;          // 'tab' (future: 'upload')
  startedAt: number;       // epoch ms
  durationSec: number;
  participants: string[];  // reserved for the participants pre-fill upgrade
  transcript: string;      // raw text from Gemini (stitched from segments)
  templateId: string;      // which template produced the notes
  notesMarkdown: string;   // raw Markdown from DeepSeek
  status: 'recording' | 'recorded' | 'transcribing' | 'transcribed'
        | 'generating' | 'done' | 'error';
  error?: string;          // set when status === 'error'
  segmentCount?: number;   // audio segments recorded
}
```

Audio is stored separately in a `segments` object store (key `${meetingId}:${index}`,
indexed by `meetingId`) so the meeting record stays small and runs are recoverable. Segments are
deleted once the meeting reaches `done`. See [`doc/RESILIENCE_PLAN.md`](doc/RESILIENCE_PLAN.md).

---

## 9. Provider interfaces (contracts)

These are the seams. Implementations can be swapped without touching UI logic.

```ts
TranscriptionProvider.transcribe({ base64, mimeType, apiKey, models? }) -> Promise<string>
NotesProvider.generateNotes({ transcript, template, apiKey, models? })  -> Promise<string>
NotesStore.saveMeeting(m) / listMeetings() / getMeeting(id) / deleteMeeting(id)
NotesStore.saveSegment(id, i, blob) / listSegments(id) / deleteSegments(id)
```

- All provider calls go through `fetchWithRetry` (`src/lib/net.js`): retries network errors and
  `408/429/500/502/503/504` with backoff + jitter, honoring `Retry-After`; never retries other `4xx`.
- `models` is an ordered fallback chain; the provider tries the next model on `404` or `5xx`.
- Notes use a map-reduce path when the transcript exceeds ~40k chars. Details in
  [`doc/RESILIENCE_PLAN.md`](doc/RESILIENCE_PLAN.md).

Speaker attribution strategy (layered, cheapest first):
1. **v1:** mic + tab mixed; Gemini labels `Speaker 1/2/…` generically. Acceptable to start.
2. **Next:** keep mic and tab as separate streams → "Me" vs "Others" for free.
3. **Later:** optional participants pre-fill mapping `Speaker N → name`.
4. **Never (v1):** a dedicated diarization model.

---

## 10. UI design system

Minimal, monochrome, Radix-like neutral. No color, no shadows, 1px borders, small radii,
system fonts, generous whitespace.

- Light: black on white (`--fg #000`, `--bg #fff`).
- Dark: white on black via `prefers-color-scheme: dark` (`--fg #fff`, `--bg #000`).
- All tokens are CSS custom properties (see §7.4b). Change the palette in one place.
- Native controls only (no component library). This keeps the extension build-free and CSP-safe.

---

## 11. Permissions & why

| Permission | Reason |
|---|---|
| `sidePanel` | Host the UI next to the meeting |
| `storage` | Persist API keys and preferences |
| `tabCapture` | Capture tab audio |
| `offscreen` | Record audio outside the service worker (MV3 requirement) |
| `activeTab` | Resolve the tab being captured on user action |
| host `generativelanguage.googleapis.com` | Gemini fetch |
| host `api.deepseek.com` | DeepSeek fetch |

`tabCapture` does **not** accept host permissions as a substitute for invocation. Per the Chrome
docs, capture "can only be called after the user invokes an extension, such as by clicking the
extension's action button," and only tabs granted `activeTab` may be targets. Therefore the side
panel must be opened from `action.onClicked` (not `setPanelBehavior({ openPanelOnActionClick })`,
which swallows the invocation). The user must click the toolbar icon on the tab they want to record.

No content scripts and no browsing-history access. Broaden permissions only when a feature requires it.

---

## 12. Security & privacy

- **Keys** live in `chrome.storage.local`, scoped to the extension. Never log them, never send them
  anywhere except the provider endpoint. Consider the proxy (§14.3) before sharing the extension widely.
- **Audio** is sent only to Google (Gemini). **Transcripts** are sent only to DeepSeek and stored
  locally in IndexedDB. Say this plainly in the UI.
- **Consent:** show the recording indicator whenever capture is active. Recording other people may
  require their consent depending on jurisdiction; the team should agree on a norm.
- **Data minimization:** do not add analytics, telemetry, or third-party scripts.

---

## 13. Known pitfalls / gotchas

1. **Captured tab goes silent** unless you route tab audio back to `audioCtx.destination`. (§7.3b)
2. **Runtime messaging is JSON-only.** Blobs/ArrayBuffers cannot be sent directly; base64 the audio.
3. **Service workers are ephemeral.** Keep the recorder in the offscreen document, not the worker.
4. **Inline audio size cap** (~20 MB). Low bitrate, or Files API for long meetings.
5. **`getMediaStreamId` needs a real user gesture** (the Start button). Do not auto-start.
6. **`tabCapture` needs an extension invocation on the target tab.** Opening the panel via
   `setPanelBehavior({ openPanelOnActionClick })` does *not* grant `activeTab`; open it from
   `action.onClicked` instead, and require the user to click the toolbar icon on the tab to record.
   Host permissions do not substitute for invocation.
7. **`sidePanel.setPanelBehavior` persists across reloads.** If `openPanelOnActionClick` was ever
   set to `true`, it stays true even after the call is removed, which swallows the action click.
   Set it explicitly to `false` at service-worker startup.
8. **Side panel must stay open** to receive `RECORDING_DONE` in v1. If it closes, the result is lost.
   Mitigation (later): have the worker persist the blob to IndexedDB on `RECORDING_DONE`.
9. **MV3 CSP forbids remote scripts.** All JS must be local; no CDN imports.
10. **API/model drift.** Model names and pricing change; centralize them as constants (§7.7, §7.8).
11. **Mic permission must be primed from a visible context.** The offscreen document cannot reliably
    prompt for `getUserMedia`. Request microphone access in the side panel (a visible extension page)
    before capture; the grant applies to the extension origin, so the offscreen document inherits it.
    Extension grants do **not** appear in `chrome://settings/content/microphone` (that list is for
    sites). If mic is unavailable, capture continues tab-audio-only rather than failing.

---

## 14. Deployment

### 14.1 Development (per developer)
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `meeting-notes-extension/`.
3. Pin the extension. Click the icon to open the side panel.
4. Paste both API keys in Settings once.

### 14.2 Sharing with the 5-person team
1. Zip the `meeting-notes-extension/` folder (exclude nothing except `architecture.md` if desired).
2. Each teammate loads it unpacked the same way and enters their own keys.
3. No Chrome Web Store, no review, no signing. Reload the extension after code changes
   (the extensions page has a reload button).

### 14.3 Optional v1.5 — shared key proxy
When passing keys around gets annoying, add a tiny Cloudflare Worker that holds **one** key server-side.
The extension then calls the worker instead of the provider; teammates need no keys.

```js
export default {
  async fetch(request, env) {
    const { path } = await request.json(); // 'transcribe' | 'notes'
    const url = path === 'transcribe'
      ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${env.GEMINI_KEY}`
      : 'https://api.deepseek.com/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (path === 'notes') headers.Authorization = `Bearer ${env.DEEPSEEK_KEY}`;
    return fetch(url, { method: 'POST', headers, body: JSON.stringify((await request.json()).body) });
  }
};
```

Point `TranscriptionProvider` / `NotesProvider` at the worker by swapping the endpoint constant.
This is also where metering, rate limits, or model switching would live.

---

## 15. Build order / milestones

Each milestone should be demoable before moving on.

1. **Loads.** `manifest.json` + side panel shell. Icon opens the panel.
2. **Records.** Start/Stop + offscreen capture → log the blob size on stop. (Hardest step; isolate it.)
3. **Transcribes.** Send blob to Gemini → show raw transcript text.
4. **Summarizes.** Send transcript to DeepSeek with the standard template → render Markdown.
5. **Persists.** Save to IndexedDB; history list loads past meetings.
6. **Polish.** Settings persistence, error states, template selector.

Upgrades after 1–6, in payoff order: mic/tab split → live transcript → templates editor →
participants pre-fill → history delete/export → shared proxy.

---

## 16. Testing checklist

- [ ] Extension loads with no manifest errors.
- [ ] Side panel opens from the toolbar icon.
- [ ] Start on a YouTube tab records audible playback and stops cleanly.
- [ ] Tab audio remains audible *during* recording.
- [ ] Mic audio is captured and not echoed back.
- [ ] A 2-minute recording returns a transcript.
- [ ] Notes render as Markdown with all template sections.
- [ ] Meeting appears in history and reopens.
- [ ] Reloading the extension does not lose settings or history.
- [ ] Missing/invalid key shows a clear error, not a silent failure.
- [ ] Dark mode (`prefers-color-scheme: dark`) renders white-on-black.

---

## 17. Roadmap / future upgrades

- **Live transcript:** chunk audio every ~30 s, transcribe incrementally, merge overlaps.
- **Mic/tab split:** separate streams → real "Me" vs "Others" attribution.
- **Long meetings:** Gemini Files API upload, or local Whisper for $0/private transcription.
- **Templates UI:** add/edit templates from the side panel; persist to `chrome.storage`.
- **Export:** download `.md`, copy to clipboard, or push to Obsidian/Notion.
- **Shared proxy + dashboard:** implement `NotesStore` over HTTP to sync history across the team.
- **Auto-detect meetings:** badge the action when a known meeting URL is active.

---

## 18. Open questions

- Who owns the shared API keys, and do we accept transcript data leaving to DeepSeek/Google?
- Do we want the mic/tab split in v1, or ship mixed audio first?
- What is the team's default note template (beyond "Standard meeting")?
- Is a shared proxy worth it at 5 users, or is per-person BYOK fine?
