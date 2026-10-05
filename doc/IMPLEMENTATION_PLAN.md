# Meeting Notes Extension — Cold-Agent Implementation Plan

> Execute this plan from the repository root. The extension is Manifest V3, vanilla JavaScript,
> and has no build step. Keep the current architecture and dependencies unless a task below requires
> a change. Do not commit, push, or add third-party services.

## Objective

Make the extension reliable and straightforward for multi-hour meetings. Users must be able to choose
a transcription provider, keep transcripts and notes, generate notes with or without a template, and
recover from interrupted recording or processing.

## Current baseline

- `src/offscreen/offscreen.js` records tab and optional microphone audio, rotating WebM recordings
  into ten-minute segments.
- `src/lib/store.js` stores meetings and audio segments in IndexedDB.
- `src/sidepanel/sidepanel.js` sequences transcription, note generation, history, and retry UI.
- Transcription uses a provider registry with OpenAI Whisper as the current adapter. Notes use DeepSeek.
- Audio is segmented and stored in IndexedDB; per-segment transcripts and long-note reduction steps
  are resumable. Meetings retain transcript and notes, with export and delete support.
- General Notes and six optional formats are available, along with custom instructions.
- The toolbar opens the full-page workspace in a tab; the originating meeting tab ID is carried
  through so capture stays targeted correctly.
- `architecture.md` describes the current architecture. `doc/AGENT_PLAN.md` retains historical
  T1–T17 details and should not override current implementation or this plan.

Read `architecture.md`, `doc/RESILIENCE_PLAN.md` §11, `manifest.json`, and the current source before
editing. Treat the source tree as the behavioral baseline where older documentation disagrees. Update
the docs as implementation changes land.

## Product decisions

1. **Providers:** replace Gemini with OpenAI Whisper as the first transcription adapter. Add a small
   provider interface/registry so another compatible API can be added or selected without changing
   capture, segment storage, or meeting history. Do not claim arbitrary providers work until an
   adapter is implemented. Keep provider API keys separate and local.
2. **Long sessions:** keep audio segmented and persisted locally. Process segments sequentially, show
   elapsed time/progress, and resume at the first unfinished segment after a recoverable failure.
3. **Saved work:** preserve the completed transcript and notes with each meeting. Export both. Keep
   audio until processing succeeds or the user deletes the meeting; deleting a meeting also deletes
   its segments and derived data.
4. **Notes:** offer General Notes without a required template, optional built-in formats, and custom
   instructions. Do not invent facts, owners, decisions, or due dates.
5. **UI:** prioritize Start/Stop, elapsed time, recording/processing state, and meeting history.
   Put infrequent provider and notes settings in a clear settings area.

## Execution rules

- Work in task order T18 → T21. Finish and document each task before moving to the next.
- Preserve existing IndexedDB meetings and settings. Add safe migrations; never clear user data to
  simplify an upgrade.
- Keep all secrets out of logs and rendered error details where they could reveal credentials.
- Do not add dependencies, a build system, analytics, a backend, or remote script loading.
- Keep audio and transcripts local except for the explicit provider request currently being processed.
- Run the existing `bash tools/check.sh` after each task and report the result. Do not claim browser,
  API-key, or multi-hour behavior was verified unless it was actually exercised.
- Update this plan's progress table and `architecture.md` as work is completed.

## T18 — Replace Gemini and add a transcription-provider seam

**Goal:** working Whisper transcription with a clean path for adding another provider later.

**Inspect/edit:**

- `src/lib/providers/transcription.gemini.js` (replace or rename)
- add a provider registry/interface under `src/lib/providers/`
- `src/lib/models.js`, `src/lib/settings.js`
- `src/sidepanel/sidepanel.html`, `src/sidepanel/sidepanel.js`
- `manifest.json`
- `architecture.md`, `doc/AGENT_PLAN.md`, `doc/RESILIENCE_PLAN.md`

**Implementation:**

1. Define one provider contract that accepts a saved audio `Blob` plus provider settings and returns
   transcript text and, when available, timestamped segments/metadata.
2. Implement the OpenAI `whisper-1` adapter using the official transcription endpoint and browser
   `FormData` multipart upload. Do not manually set the multipart `Content-Type` boundary.
3. Add provider selection and provider-specific API-key/model fields. Store keys in
   `chrome.storage.local`; never put keys in meeting records or logs.
4. Request `https://api.openai.com/*` host permission and remove Gemini host permission and active
   Gemini settings/code. Do not delete old meeting data.
5. Reject empty/oversized segments with a clear error. The OpenAI API reference lists a 25 MB file
   limit; enforce a safety margin and retain the current ten-minute segmentation unless actual
   measurements justify changing it.
6. Keep provider-specific behavior behind the adapter so recording/storage do not depend on Whisper.

**Acceptance:** valid short WebM segment is submitted as multipart and parsed correctly; missing or
invalid keys show a useful error; provider selection persists; DeepSeek notes still work; existing
meeting history remains readable; no Gemini runtime references remain.

## T19 — Multi-hour reliability, resume, and saved results

**Goal:** tolerate long capture and transient failures without losing segments or repeating completed
transcription work.

**Inspect/edit:**

- `src/offscreen/offscreen.js`, `src/background/service-worker.js`, `src/lib/messages.js`
- `src/lib/store.js`, `src/sidepanel/sidepanel.js`
- `architecture.md`

**Implementation:**

1. Persist each completed segment before advancing its index. Record segment metadata including
   order, start offset, duration, and byte size.
2. Persist transcription results per segment. Resume from missing/failed segments only, then stitch
   transcript output in segment order. Preserve timestamps and offset local timestamps when supported.
3. Handle recorder errors, ended tab tracks, IndexedDB write/quota errors, and extension/panel reloads.
   Stop safely and retain all successfully persisted data.
4. On reopening the panel, reconcile meetings left in `recording` or an in-progress state. Clearly
   mark interrupted recordings; never offer Retry while capture is actually active.
5. Show elapsed time, segment count, transcription progress, and explicit states: recording,
   recorded, transcribing, generating notes, done, interrupted, and error.
6. Persist the full transcript and generated notes on the meeting. Retain audio until successful
   completion or explicit deletion. Add export for transcript and notes (Markdown/text).
7. Delete all meeting-owned segments and results when the user deletes a meeting.

**Acceptance:** multi-hour recording produces ordered, non-empty segments; reloading the workspace
does not lose them; a mid-run transcription failure and retry skips completed segments; transcript
and notes remain available after reload and export; storage/capture errors are visible and recoverable.

## T20 — General notes, optional templates, and better long notes

**Goal:** useful notes with no template requirement and reliable long-transcript synthesis.

**Inspect/edit:**

- `src/lib/templates.js`, `src/lib/providers/notes.deepseek.js`
- `src/sidepanel/sidepanel.html`, `src/sidepanel/sidepanel.js`
- `src/lib/store.js` only if meeting records need new note settings/metadata
- `architecture.md`

**Implementation:**

1. Add General Notes as the default, with no fixed section structure. Add optional Standard Meeting,
   Standup, Project Review, Interview, Lecture/Training, and Action Items formats.
2. Add an optional custom-instructions field. Persist the selected format and custom instructions
   with the meeting so later regeneration uses the same choices.
3. Make prompts distinguish confirmed decisions from proposals, capture owners/dates only when stated,
   and preserve risks, dependencies, disagreements, and unresolved questions when present.
4. For long transcripts, split on paragraph/timestamp boundaries with modest overlap; use a
   template-aware reduction prompt; persist each completed reduction chunk so Retry resumes.
5. Treat all model output as untrusted text and continue escaping it in the UI.

**Acceptance:** General Notes works without selecting a template; formats and custom instructions
persist; short and long transcripts retain concrete facts without invented details; retries reuse
completed reduction chunks; output renders safely.

## T21 — Simplify the UI and finish the operating guide

**Goal:** make first-run setup, recording, and saved work obvious.

**Inspect/edit:**

- `src/sidepanel/sidepanel.html`, `src/sidepanel/sidepanel.css`, `src/sidepanel/sidepanel.js`
- add or update `README.md`
- `architecture.md` and this plan

**Implementation:**

1. Make the toolbar open the full-page workspace in an extension tab. Preserve the originating
   meeting-tab ID so Start records the meeting tab, not the extension tab. Use a responsive two-column desktop layout and single-column
   narrow layout. Make Start/Stop and elapsed time primary with clear recording/processing/error states.
2. Group provider choice and credentials separately from note style/instructions. Provide sensible
   defaults, key format examples, and concise setup help.
3. Make history easy to scan and reopen. Provide rename, export, retry when appropriate, and delete
   actions with confirmation for destructive deletion.
4. Make microphone availability and tab-capture problems actionable. Ensure keyboard focus and
   dark/light themes remain readable.
5. Document unpacked installation, supported providers, required API keys, permissions, local audio
   retention, export/delete behavior, and common troubleshooting steps.

**Acceptance:** a first-time user can configure keys, open the full-page workspace, record and stop,
understand status, reopen and rename a meeting, export transcript/notes, and delete meeting data
without needing developer instructions.

## Progress

| Task | Status | Evidence |
|---|---|---|
| T18 Provider interface and Whisper | complete | `tools/check.sh`: all static checks passed; stubbed multipart adapter/registry validation checks passed; legacy Gemini code and host permission removed; legacy meetings and unrelated settings fields preserved |
| T19 Multi-hour reliability and saved results | complete | segment metadata + per-segment transcript store (DB v3); offscreen recorder interruption handling; reload reconciliation; elapsed/segment UI; transcript+notes export; delete cascades to audio/transcripts (`bash tools/check.sh` green) |
| T20 Optional templates and notes | complete | General Notes default + 6 optional formats; custom instructions persisted per meeting; paragraph-boundary map-reduce with persisted reduction chunks (DB v4) and cache reuse; escaped rendering; `bash tools/check.sh` green |
| T21 Usable UI and guide | complete | grouped provider/notes settings; toolbar opens full-page workspace with meeting-tab targeting; Start/Stop + elapsed/status; rename/export/regenerate/delete; README covers setup; OpenAI quota errors show billing guidance |
