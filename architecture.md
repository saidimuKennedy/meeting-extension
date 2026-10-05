# Meeting Notes — Architecture & Scaffolding Blueprint

> Internal tool. 5 users max. Chrome Extension (Manifest V3), vanilla HTML/CSS/JS, **no build step**.
> Capture tab + mic audio → transcribe with OpenAI Whisper → structure notes with DeepSeek → store locally.

> **Current implementation:** the toolbar opens the full-page workspace in an extension tab and
> carries the original meeting-tab ID forward, so capture still targets the meeting. Audio is saved
> in ordered IndexedDB segments; transcription and
> long-note reduction resume from saved results. Transcripts and notes stay with meeting history and
> can be exported. General Notes is available without a fixed template. For actual current behavior,
> consult `doc/IMPLEMENTATION_PLAN.md` and the source files; older bootstrap snippets below may omit
> later additions.

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
| Ears (audio→text) | OpenAI Whisper (`whisper-1`) via provider registry | Selectable transcription seam; multipart upload uses saved segment Blobs |
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
│         │ RECORDING_DONE (metadata; audio stays in IndexedDB)     │
│         ▼                                                      │
│  [Service worker]  orchestrates, owns offscreen lifecycle       │
│         ▲                                                      │
│         │ START / STOP                                         │
│  [Full-page extension UI]  controls, settings, notes, history │
│         │                                                      │
└─────────┼──────────────────────────────────────────────────────┘
          │ fetch (BYOK)
          ▼
   OpenAI Whisper (audio → transcript text)  →  DeepSeek (text → Markdown)
          │
          ▼
   IndexedDB (meeting history, local only)
```

Three seams keep the system swappable:
`TranscriptionProvider`, `NotesProvider`, `NotesStore`.

---

## 5. Data flow

1. User clicks the extension toolbar icon on the meeting tab. It opens the full-page workspace and
   carries the originating meeting-tab ID in the page URL.
2. User clicks **Start**. The visible extension page requests microphone permission if available.
3. UI → service worker: `START_CAPTURE` with the meeting ID and, for the full-page view, target tab ID.
4. Service worker resolves that target tab (or the active tab in the side-panel view), calls
   `chrome.tabCapture.getMediaStreamId({ targetTabId })`, ensures the offscreen document exists,
   and forwards the stream id.
5. Offscreen document:
   - `getUserMedia` for the tab stream (via `chromeMediaSourceId`) and the mic.
   - Mixes both into one `MediaStreamDestination` via Web Audio.
   - **Routes tab audio back to speakers** (capturing a tab otherwise silences it).
   - Records with `MediaRecorder` (Opus, low bitrate).
   - Persists completed segments to IndexedDB as they are finished.
6. User clicks **Stop** → service worker → offscreen stops → offscreen emits `RECORDING_DONE`
   with recording metadata. Runtime messaging remains JSON-only; audio `Blob`s stay in IndexedDB.
7. UI calls the selected transcription-provider adapter. Whisper receives the saved
   audio segment as multipart `FormData` and returns transcript text plus segment timestamps.
8. UI calls `NotesProvider.generateNotes()` (DeepSeek) with General Notes or an optional format → Markdown.
9. UI saves the transcript and notes to the meeting record and renders them. Successful processing
   removes source audio segments; failed processing retains them for Retry.

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
    │   ├── models.js                # default transcription/notes provider settings
    │   ├── net.js                   # fetchWithRetry (backoff + Retry-After)
    │   ├── store.js                 # NotesStore over IndexedDB (+ audio segments)
    │   ├── templates.js             # note templates as data
    │   └── providers/
    │       ├── transcription/
    │       │   └── index.js
    │       ├── transcription.openai.js
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
  "description": "Capture tab + mic audio, transcribe with OpenAI, structure notes with DeepSeek.",
  "minimum_chrome_version": "116",
  "permissions": [
    "storage",
    "tabCapture",
    "offscreen",
    "activeTab"
  ],
  "host_permissions": [
    "https://api.openai.com/*",
    "https://api.deepseek.com/*"
  ],
  "background": {
    "service_worker": "src/background/service-worker.js",
    "type": "module"
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

chrome.action.onClicked.addListener((tab) => {
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
    startCapture(msg.meetingId, msg.targetTabId).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === MSG.STOP_CAPTURE) {
    stopCapture().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});

async function startCapture(meetingId, targetTabId) {
  let tab;
  if (Number.isInteger(targetTabId) && targetTabId > 0) {
    tab = await chrome.tabs.get(targetTabId);
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
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
```

Notes:
- `RECORDING_DONE` is emitted by the offscreen document and is received directly by the workspace,
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

> Canonical implementation: `src/offscreen/offscreen.js`. Behavior:

- On `OFFSCREEN_START` it acquires the tab stream and the microphone, mixes both through Web Audio
  into one `MediaStreamDestination`, and routes the tab source back to `audioCtx.destination` (the
  "keep the tab audible" line — without it the captured tab goes silent).
- It records in **ten-minute segments**, creating a fresh `MediaRecorder` per segment, and writes
  each completed segment to IndexedDB (`saveSegment`) with `byteSize`, `startOffsetSec`,
  `durationSec`, and `recordedAt` **before** advancing the index. It emits `SEGMENT_SAVED` per
  segment and keeps a `captureRuns` lifecycle record.
- It handles errors, ended tab tracks, and stop requests by transitioning to an interrupted or
  complete state, emitting `CAPTURE_INTERRUPTED` or `RECORDING_DONE` with metadata only (audio never
  crosses the messaging boundary), and responds to `GET_CAPTURE_STATUS` so a reopened panel can
  reconcile an in-progress recording.
- `audioBitsPerSecond: 32000` keeps ten-minute segments far below OpenAI's 25 MB upload limit; the
  transcription adapter independently rejects segments above a 24 MB safety margin.

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
      <label>Transcription provider
        <select id="transcription-provider"></select>
      </label>
      <label>OpenAI API key <input type="password" id="openai-key" placeholder="sk-..." /></label>
      <label>OpenAI transcription model
        <select id="openai-model">
          <option value="whisper-1">whisper-1</option>
        </select>
      </label>
      <label>DeepSeek API key <input type="password" id="deepseek-key" placeholder="sk-..." /></label>
      <label>Template
        <select id="template"></select>
      </label>
      <label>DeepSeek model <input id="deepseek-model" placeholder="deepseek-chat" /></label>
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

### 7.4c `src/sidepanel/sidepanel.js`

> Canonical implementation: `src/sidepanel/sidepanel.js`. Behavior:

- Owns the pipeline in the full-page workspace. **Start** creates the meeting record
  (`status: recording`), requests the microphone from this visible page, and sends `START_CAPTURE`
  with the meeting ID and `targetTabId`. The page preserves the originating meeting tab. Controls
  show Start/Stop, elapsed time, saved-segment count, and status.
- `SEGMENT_SAVED` updates the elapsed/segment display; `RECORDING_DONE` marks the meeting
  `recorded` and starts processing; `CAPTURE_INTERRUPTED`/`CAPTURE_ERROR` mark it `interrupted`.
- `processMeeting` is resumable: it transcribes saved segments, persisting a per-segment transcript
  and skipping already-completed ones, then generates notes via `generateNotes` with the meeting's
  `noteFormatId` and `customInstructions`, reusing cached reductions. On success it deletes segments
  and reductions; on failure it stores the error and leaves the audio in place for Retry.
- Init reconciles meetings left in `recording` (via `GET_CAPTURE_STATUS` and saved segments). History
  supports open, rename, Retry, Delete (with confirmation), and export of transcript/notes; a
  **Regenerate notes** action re-runs notes with the selected format/instructions.
- All model output is escaped before rendering (`renderMarkdown`).

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

### 7.6a `src/lib/models.js`

```js
export const DEFAULT_TRANSCRIPTION_PROVIDER_ID = 'openai-whisper';
export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = 'whisper-1';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
```

### 7.7 Transcription providers

The registry at `src/lib/providers/transcription/index.js` is the only supported entry point for
transcription. A provider must expose:

- a stable `id` and human-readable `label`;
- `defaultModel` and the `models` actually implemented by its adapter;
- `maxUploadBytes`;
- `transcribe({ blob, index, baseSeconds, mimeType, apiKey, model })`, returning transcript
  `text` plus timestamp metadata when the provider supplies it.

It currently exposes OpenAI Whisper only. The OpenAI adapter accepts a saved segment `Blob`,
rejects missing keys, empty segments, oversized uploads, and unimplemented models, then submits
browser-constructed multipart `FormData` (`file`, `model`, `response_format=verbose_json`, and
segment timestamp granularity). It never manually sets the multipart boundary. Future compatible
adapters can register another object with this shape; no unsupported provider should be advertised.

Notes:
- Ten-minute, 32 kbps segment recordings stay far below OpenAI's 25 MB upload ceiling. The
  adapter separately enforces a 24 MB safety margin.

### 7.8 `src/lib/providers/notes.deepseek.js`

The notes provider calls DeepSeek's OpenAI-compatible chat endpoint through `fetchWithRetry` and
tries the `models` chain on `404`/`5xx`. Its interface is:

```js
generateNotes({
  transcript,            // stitched transcript text
  formatId,              // note format id (see §7.9)
  customInstructions,    // optional user instructions
  apiKey,
  models,                // ordered DeepSeek model fallback chain
  onProgress,            // (chunkIndex, chunkTotal) => void
  getCachedReduction,    // async (index) => string | null
  saveReduction          // async (index, text) => void
}) -> Promise<string>
```

For short transcripts it makes a single call. For long transcripts (over ~24k chars) it splits on
paragraph boundaries with a small overlap, produces one faithful partial summary per chunk (reusing
cached reductions so a retry does not repeat them), then runs a final pass that merges the partials
into the selected format. All prompts forbid inventing facts, owners, or dates.

### 7.9 `src/lib/templates.js`

Exports `noteFormats`: **General notes** (default, no fixed structure) plus optional Standard
meeting, Daily standup, Project review, Interview, Lecture/training, and Action items formats. Each
has an `id`, `name`, `system` prompt, and `user(transcript)` builder. Helpers build messages:

```js
getNoteFormat(id)                              // falls back to General notes
buildNoteMessages({ formatId, transcript, customInstructions })
buildReductionMessages({ formatId, chunk, index, total, customInstructions })
```

`buildNoteMessages` appends custom instructions to the system prompt. `templates` is kept as an
alias of `noteFormats`.

### 7.10 `src/lib/store.js` (NotesStore over IndexedDB)

Database `meeting-notes` (current version 4) with object stores:

- `meetings` — `Meeting` records, keyed by `id` (see §8).
- `segments` — audio `Blob`s, key `${meetingId}:${index}`, index `meetingId`; each carries
  `byteSize`, `startOffsetSec`, `durationSec`, `recordedAt`, and `status`.
- `segmentTranscripts` — per-segment transcription results, key `${meetingId}:${index}`,
  index `meetingId`; carries text/word timestamps, model, offsets, byte size, attempts, status, error.
- `captureRuns` — recorder lifecycle per meeting (`active`, `finishing`, `complete`, `interrupted`).
- `reductions` — cached long-transcript partial summaries, key `${meetingId}:${index}`.

Exports: `saveMeeting`, `listMeetings`, `getMeeting`, `deleteMeeting` (cascades to all owned
stores), `saveSegment`, `listSegments`, `deleteSegments`, `saveSegmentTranscript`,
`listSegmentTranscripts`, `deleteSegmentTranscripts`, `saveCaptureRun`, `getCaptureRun`,
`saveReduction`, `listReductions`, `deleteReductions`. Upgrades create missing stores/indexes
without clearing existing data.

---

## 8. Data model

```ts
Meeting {
  id: string;                 // crypto.randomUUID()
  title: string;              // 'Meeting'
  source: string;             // 'tab'
  startedAt: number;          // epoch ms
  durationSec: number;
  segmentCount: number;       // audio segments recorded
  participants: string[];     // reserved for the participants pre-fill upgrade
  transcript: string;         // plain stitched provider text
  transcriptTimed: string;    // transcript with timestamps for display/export
  noteFormatId: string;       // note format used to produce the notes
  customInstructions: string; // optional per-meeting instructions
  notesMarkdown: string;      // Markdown from DeepSeek
  status: 'recording' | 'recorded' | 'transcribing' | 'transcribed'
        | 'generating' | 'done' | 'interrupted' | 'error';
  error?: string | null;      // set when status === 'error'
}
```

Audio (`segments`), per-segment transcription (`segmentTranscripts`), recorder lifecycle
(`captureRuns`), and cached long-transcript reductions (`reductions`) live in separate stores so
the meeting record stays small and runs are recoverable. Segments and reductions are deleted once
the meeting reaches `done`; deleting a meeting deletes all of its owned data. See
[`doc/RESILIENCE_PLAN.md`](doc/RESILIENCE_PLAN.md).

---

## 9. Provider interfaces (contracts)

These are the seams. Implementations can be swapped without touching UI logic.

```ts
TranscriptionProvider.transcribe({ blob, index, baseSeconds, mimeType, apiKey, model }) -> Promise<{ text, segments }>
NotesProvider.generateNotes({ transcript, formatId, customInstructions, apiKey, models, onProgress, getCachedReduction, saveReduction }) -> Promise<string>
NotesStore.saveMeeting / listMeetings / getMeeting / deleteMeeting
NotesStore.saveSegment / listSegments / deleteSegments
NotesStore.saveSegmentTranscript / listSegmentTranscripts / deleteSegmentTranscripts
NotesStore.saveCaptureRun / getCaptureRun
NotesStore.saveReduction / listReductions / deleteReductions
```

- All provider calls go through `fetchWithRetry` (`src/lib/net.js`): retries network errors and
  `408/429/500/502/503/504` with backoff + jitter, honoring `Retry-After`; never retries other `4xx`.
- `models` is an ordered fallback chain; the provider tries the next model on `404` or `5xx`.
- Notes use a cached map-reduce path when the transcript exceeds ~24k chars. Details in
  [`doc/RESILIENCE_PLAN.md`](doc/RESILIENCE_PLAN.md).

Speaker attribution strategy (layered, cheapest first):
1. **Current baseline:** mix mic + tab; rely on provider output for whatever speaker/segment
   information it supplies. Do not add a diarization model in this phase.
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
| `storage` | Persist API keys and preferences |
| `tabCapture` | Capture tab audio |
| `offscreen` | Record audio outside the service worker (MV3 requirement) |
| `activeTab` | Resolve the tab being captured on user action |
| host `api.openai.com` | OpenAI Whisper transcription |
| host `api.deepseek.com` | DeepSeek fetch |

`tabCapture` does **not** accept host permissions as a substitute for invocation. Per the Chrome
docs, capture "can only be called after the user invokes an extension, such as by clicking the
extension's action button," and only tabs granted `activeTab` may be targets. The toolbar handler
opens the workspace with the invoked tab's ID; the user must click the toolbar icon on the tab they
want to record.

No content scripts and no browsing-history access. Broaden permissions only when a feature requires it.

---

## 12. Security & privacy

- **Keys** live in `chrome.storage.local`, scoped to the extension. Never log them, never send them
  anywhere except the provider endpoint. Consider the proxy (§14.3) before sharing the extension widely.
- **Audio** is sent only to the selected transcription provider. **Transcripts** are sent only to DeepSeek and stored
  locally in IndexedDB. Say this plainly in the UI.
- **Consent:** show the recording indicator whenever capture is active. Recording other people may
  require their consent depending on jurisdiction; the team should agree on a norm.
- **Data minimization:** do not add analytics, telemetry, or third-party scripts.

---

## 13. Known pitfalls / gotchas

1. **Captured tab goes silent** unless you route tab audio back to `audioCtx.destination`. (§7.3b)
2. **Runtime messaging is JSON-only.** Never send audio through it — the offscreen document
   persists segment `Blob`s directly to IndexedDB, and messages carry metadata only.
3. **Service workers are ephemeral.** Keep the recorder in the offscreen document, not the worker.
4. **Inline audio size cap** (~20 MB). Low bitrate, or Files API for long meetings.
5. **`getMediaStreamId` needs a real user gesture** (the Start button). Do not auto-start.
6. **`tabCapture` needs an extension invocation on the target tab.** Require the user to click the
   toolbar icon on the tab they intend to record and carry that tab ID into the workspace.
   Host permissions do not substitute for invocation.
7. **Keep an extension view open for live progress.** If it closes, captured segments remain in
   IndexedDB. On reopening, the UI reconciles the capture run and resumes processing from saved data.
8. **MV3 CSP forbids remote scripts.** All JS must be local; no CDN imports.
9. **API/model drift.** Model names and pricing change; centralize them as constants (§7.7, §7.8).
10. **Mic permission must be primed from a visible context.** The offscreen document cannot reliably
    prompt for `getUserMedia`. Request microphone access in the workspace (a visible extension page)
    before capture; the grant applies to the extension origin, so the offscreen document inherits it.
    Extension grants do **not** appear in `chrome://settings/content/microphone` (that list is for
    sites). If mic is unavailable, capture continues tab-audio-only rather than failing.

---

## 14. Deployment

### 14.1 Development (per developer)
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `meeting-notes-extension/`.
3. Pin the extension. Click its icon on the meeting tab to open the full-page workspace.
4. Add the OpenAI and DeepSeek API keys in Settings once.

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
      ? `https://api.openai.com/v1/audio/transcriptions`
      : 'https://api.deepseek.com/chat/completions';
    const headers = {};
    if (path === 'transcribe') headers.Authorization = `Bearer ${env.OPENAI_KEY}`;
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

1. **Loads.** `manifest.json` + workspace shell. Toolbar icon opens the full-page workspace.
2. **Records.** Start/Stop + offscreen capture → log the blob size on stop. (Hardest step; isolate it.)
3. **Transcribes.** Send saved segments to the selected transcription provider → transcript text.
4. **Summarizes.** Send transcript to DeepSeek with the selected format → render Markdown.
5. **Persists.** Save to IndexedDB; history list loads past meetings.
6. **Polish.** Settings persistence, error states, format selector, export/delete.

Upgrades after 1–6, in payoff order: mic/tab split → live transcript → templates editor →
participants pre-fill → history delete/export → shared proxy.

---

## 16. Testing checklist

- [ ] Extension loads with no manifest errors.
- [ ] Full-page workspace opens from the toolbar icon.
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
- **Long meetings:** use provider-neutral 10-minute segments rather than provider inline audio limits.
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
