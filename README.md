# Meeting Notes (internal)

A small, unbundled Chrome extension (Manifest V3) that records a browser tab plus your
microphone, transcribes the audio, and generates structured notes. It is an internal tool for a
handful of people, loaded unpacked — there is **no Chrome Web Store listing, no backend, and no
account**.

- **Ears:** OpenAI transcription (`whisper-1`).
- **Brain:** DeepSeek (`deepseek-chat`) turns the transcript into notes.
- **Storage:** everything lives locally in IndexedDB (meetings, audio segments, transcripts, notes).

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this project folder (the one containing `manifest.json`).
4. Pin the extension: click the puzzle-piece icon in the toolbar and pin **Meeting Notes**.

## Configure keys

Click the extension icon on a normal tab to open the full-page workspace, then choose **Settings**:

- **OpenAI API key** — https://platform.openai.com/api-keys (`sk-...`). Used for transcription.
- **DeepSeek API key** — https://platform.deepseek.com (`sk-...`). Used for notes.
- Optionally change models, choose a **note format**, or add **custom instructions**.

Keys are stored with `chrome.storage.local` and are scoped to this extension. They are never
written to meeting records or logs.

## Record a meeting

1. Open the tab you want to capture (Meet, Zoom web, Teams web, YouTube, etc.).
2. **Click the extension's toolbar icon on that tab.** This is required: Chrome only lets the
   extension capture a tab after you invoke it on that tab. The full-page workspace opens with that
   meeting tab selected as the capture target.
3. Press **Start**. The tab keeps playing audio while it records; your microphone is captured too.
4. Press **Stop** when finished. The extension transcribes each saved segment and then writes notes.

Recording is saved as ten-minute segments, so long sessions are safe. Progress and elapsed time are
shown in the panel.

## Recover from interruption

If the tab closes, audio stops, or transcription fails, the meeting is kept with an explicit status
(`interrupted`, `error`). Use **Retry** in History:

- interrupted recordings resume transcription from the saved segments;
- transcription resumes from the first unfinished segment, so completed work is not repeated;
- a failed run keeps its audio until it succeeds or you delete the meeting.

## Results, export, delete

- **Transcript** tab shows the transcript with timestamps.
- **Notes** tab shows the generated notes; use **Regenerate notes** after changing format or
  instructions.
- **Export transcript** downloads `.txt`; **Export notes** downloads `.md`.
- **Delete** (with confirmation) removes the meeting **and** its audio, transcripts, and notes.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save API keys and preferences |
| `tabCapture` | Capture tab audio (requires invoking the extension on the tab) |
| `offscreen` | Record outside the service worker (an MV3 requirement) |
| `activeTab` | Access the tab you invoked the extension on |
| host `api.openai.com` | Transcription requests |
| host `api.deepseek.com` | Notes requests |

Audio is sent only to the configured transcription provider. Transcripts are sent only to DeepSeek.
No analytics, telemetry, or remote scripts are used.

## Troubleshooting

- **"Extension has not been invoked…"** — click the extension icon on the tab you want to record,
  then press Start.
- **"Microphone blocked…"** — recording continues with tab audio only. Allow microphone access for
  the extension to capture your own voice.
- **Start does nothing** — reload the extension on `chrome://extensions` (the offscreen recorder can
  go stale across reloads), then reopen the panel.
- **OpenAI says quota/credits are exhausted** — add API credits or raise the project's API spending
  limit in OpenAI Platform, then choose **Retry** in meeting history.
- Keep the workspace open while recording and processing so you can see
  progress and results.
- **No Gemini / old model errors** — transcription is OpenAI only; make sure the OpenAI key is set.
- **Blank toolbar icon** — reload the extension once.

## Development

- No build step: vanilla HTML/CSS/JS, native ES modules.
- Static checks: `bash tools/check.sh` (manifest JSON, JS syntax, host/target rules, expected files).
- Key documents: `architecture.md`, `doc/IMPLEMENTATION_PLAN.md`, `doc/RESILIENCE_PLAN.md`,
  `doc/AGENT_PLAN.md`.

To load local changes, reload the extension on `chrome://extensions` and click its toolbar icon.
