# AGENT_PLAN.md — Cold-Start Execution Plan

> **Audience:** an autonomous coding agent starting with no prior conversation context.
> **Owner of this plan:** the reviewer. The agent executes tasks; the reviewer verifies them.
> **Authoritative spec:** [`../architecture.md`](../architecture.md). Read it in full before starting.

---

## 0. How to use this document

1. Read `architecture.md` completely. It contains the product rationale, data model, and the **full
   contents of every file** you will create. Do not redesign it.
2. Work tasks **strictly in order** (`T1 → T6`). Do not start a task until the previous one is marked
   `approved` in §7.
3. After finishing a task: run the verification in §6, update the tracking table in §7, and **stop**.
   Wait for the reviewer. Do not continue to the next task on your own.
4. If any §9 stop condition applies, stop and ask instead of guessing.

You are not expected to commit anything. Do not run `git` write commands unless the reviewer asks.

---

## 1. Context brief (what this is)

An internal Chrome extension (Manifest V3) that records meeting audio and produces structured notes.
It is used by at most 5 people. It is distributed by loading it unpacked — **no Chrome Web Store**.

Pipeline:

```
meeting tab --tabCapture--> offscreen document records tab + mic into one webm blob
   --base64--> side panel --Gemini--> transcript text --DeepSeek--> Markdown notes
   --> IndexedDB (local history)
```

Key decisions already made (do not revisit):

- **No build step.** Vanilla HTML/CSS/JS, native ES modules. No bundler, no TypeScript, no npm deps.
- **No UI library.** Hand-written monochrome CSS (black/white, dark-mode aware). MV3 CSP forbids
  remote scripts, so all JS is local.
- **BYOK.** API keys are stored in `chrome.storage.local` and read from the side panel settings UI.
- **Storage is IndexedDB**, not `chrome.storage` (transcripts are large).
- **Providers are swappable seams:** `TranscriptionProvider` (Gemini), `NotesProvider` (DeepSeek),
  `NotesStore` (IndexedDB).

---

## 2. Authoritative spec & path convention

- `architecture.md` is the source of truth for file contents, data model, and the design system.
- **Path convention (important):** the repository root **is** the extension root.
  - `architecture.md` §6 shows an illustrative `meeting-notes-extension/` wrapper folder —
    **ignore that wrapper.** Create `manifest.json`, `src/`, and `doc/` directly at the repo root.
  - Repo root = `/home/saidimu/Desktop/buda/bots`.
- Do **not** modify `architecture.md`. If you believe it is wrong or ambiguous, raise it in your
  handoff (see §10) rather than editing it.

---

## 3. Hard constraints (invariants)

These must hold after every task:

1. `manifest.json` is valid JSON and loads without errors in `chrome://extensions`.
2. All JavaScript is local ES modules. No `http(s)://` script references anywhere.
3. No new runtime dependencies. `package.json` is **not** required for the product.
4. Keep code comments minimal — only where behavior is non-obvious (e.g. the tab-audio routing
   gotcha in the offscreen recorder). Do not narrate obvious code.
5. No analytics, telemetry, or third-party network calls beyond the two declared provider hosts.
6. Do not log API keys or full audio/transcript payloads to the console.

---

## 4. Definition of Done (applies to every task)

A task is only `done` when all of the following are true:

- All files listed for the task exist and match `architecture.md`.
- The task's **acceptance criteria** are met.
- The task's **agent-side verification** passes and its output is pasted into the tracking table.
- The agent has written a short handoff (see §10) and **stopped** for review.

The reviewer then marks the task `approved` or `changes-requested`.

---

## 5. Task breakdown

### T1 — Extension loads (milestone 1)

**Goal:** a loadable extension that opens a side panel shell.

**Files**
- `manifest.json`
- `src/background/service-worker.js`
- `src/sidepanel/sidepanel.html`
- `src/sidepanel/sidepanel.css`
- `src/sidepanel/sidepanel.js` (shell only: tabs + status, no capture logic yet)
- `src/lib/messages.js`
- `src/lib/settings.js`

**Steps**
1. Create the directory structure from `architecture.md` §6 (minus the wrapper).
2. Write `manifest.json` from §7.1. **Omit the `icons` key** (no binary assets yet; add in T6).
3. Write the side panel shell (§7.4 / §7.4b / §7.4c) with the layout but stub the Start/Stop and
   settings handlers so the page loads cleanly.
4. Write the service worker (§7.2) with `setPanelBehavior` and the message listener.
5. Write `messages.js` (§7.5) and `settings.js` (§7.6).

**Acceptance criteria**
- `manifest.json` parses as valid JSON.
- Clicking the toolbar icon opens the side panel.
- The panel renders the header, controls, tabs, output area, and history section.
- No console errors on load.

**Agent-side verification:** run `bash tools/check.sh` (§6) and paste output.

**Human verification (request in handoff):** load unpacked, click icon, confirm panel opens.

---

### T2 — Records tab + mic (milestone 2)

**Goal:** Start/Stop captures tab and microphone audio into one blob; tab audio stays audible.

**Files**
- `src/offscreen/offscreen.html`
- `src/offscreen/offscreen.js`
- update `src/background/service-worker.js` (capture orchestration, offscreen lifecycle)
- update `src/sidepanel/sidepanel.js` (wire Start/Stop; log blob size on `RECORDING_DONE`)

**Steps**
1. Implement `offscreen.js` exactly per `architecture.md` §7.3b, including the line that routes the
   tab source back to `audioCtx.destination` (otherwise the captured tab goes silent).
2. Implement `startCapture()` / `stopCapture()` and `ensureOffscreen()` in the service worker (§7.2).
3. Wire the side panel Start/Stop buttons to the messages; on `RECORDING_DONE`, log
   `base64.length` (not the payload) and the duration.
4. Do **not** call Gemini/DeepSeek yet.

**Acceptance criteria**
- Start on a tab that plays audio (e.g. YouTube) begins recording; Stop ends it.
- Tab audio remains audible during recording.
- Mic audio is captured without feedback/echo to the speakers.
- `RECORDING_DONE` fires with a non-zero base64 payload; blob size is logged.
- Starting on a page with no active tab fails gracefully with a visible status message.

**Agent-side verification:** `bash tools/check.sh`; confirm no `content_scripts` were added.

**Human verification (request in handoff):** run the §16 audio checks in `architecture.md`.

---

### T3 — Transcription (milestone 3)

**Goal:** audio blob → transcript text via Gemini, shown in the Transcript tab.

**Files**
- `src/lib/providers/transcription.gemini.js`
- update `src/sidepanel/sidepanel.js` (`onRecordingDone` → base64 → `transcribe()` → render text)

**Steps**
1. Implement the provider per `architecture.md` §7.7.
2. In the side panel, on `RECORDING_DONE`, call `transcribe()` and render the result in the
   Transcript view.
3. Surface non-OK responses as a readable status error (do not swallow them).

**Acceptance criteria**
- A short recording produces a non-empty transcript.
- The transcript is visible in the Transcript tab.
- A missing/invalid Gemini key produces a clear status error, not a silent failure.

**Agent-side verification:** `bash tools/check.sh`; confirm the only new host referenced is
`generativelanguage.googleapis.com`.

**Human verification (request in handoff):** record 60–90 s, confirm transcript appears.

---

### T4 — Notes (milestone 4)

**Goal:** transcript → structured Markdown via DeepSeek using a template.

**Files**
- `src/lib/providers/notes.deepseek.js`
- `src/lib/templates.js`
- update `src/sidepanel/sidepanel.js` (render Markdown; template selector wiring)

**Steps**
1. Implement the provider per `architecture.md` §7.8 and templates per §7.9.
2. Add the small hand-rolled Markdown renderer from §7.4c (no dependencies).
3. Wire the template `<select>` to persist `templateId` via `settings.js`.

**Acceptance criteria**
- The Notes tab shows all sections defined by the selected template (Summary, Key Decisions,
  Action Items, Discussion Highlights for `standard`).
- Switching to the `standup` template changes the output sections.
- HTML in model output is escaped (no injection).

**Agent-side verification:** `bash tools/check.sh`; confirm only `api.deepseek.com` added.

**Human verification (request in handoff):** confirm rendered notes look correct in both themes.

---

### T5 — Local history (milestone 5)

**Goal:** persist meetings to IndexedDB and reload them from the History list.

**Files**
- `src/lib/store.js`
- update `src/sidepanel/sidepanel.js` (`saveMeeting` after generation; `renderHistory`; click to reopen)

**Steps**
1. Implement `store.js` per `architecture.md` §7.10.
2. Save the `Meeting` record (data model in §8) after notes are generated.
3. Render history sorted by `startedAt` descending; clicking an item reopens its notes + transcript.

**Acceptance criteria**
- A completed meeting appears in History.
- Reloading the side panel (and the extension) preserves history.
- Clicking a history item restores that meeting's notes and transcript.

**Agent-side verification:** `bash tools/check.sh`.

**Human verification (request in handoff):** create two meetings, reload, reopen both.

---

### T6 — Polish & hardening (milestone 6)

**Goal:** finish settings persistence, error states, icons, and the full §16 checklist.

**Files**
- update `manifest.json` (add `icons`)
- add `src/assets/icon-16.png`, `icon-48.png`, `icon-128.png`
- any final touches to side panel UI/UX

**Steps**
1. Generate three simple monochrome placeholder PNGs (black glyph on transparent or white).
   If you cannot create binary PNGs, stop and request them from the reviewer (§9).
2. Ensure settings load/save round-trips (keys, template) across panel and extension reloads.
3. Add clear empty/error/processing states for every async step.
4. Confirm dark mode (`prefers-color-scheme: dark`) is white-on-black and readable.

**Acceptance criteria**
- Every item in `architecture.md` §16 passes (record results in the handoff).
- No secrets appear in logs; no remote scripts; manifest unchanged except `icons`.

**Agent-side verification:** `bash tools/check.sh` (full file set now required, including icons).

**Human verification (request in handoff):** run the entire §16 checklist.

---

### T7 — Runtime hardening (post-review, added by reviewer)

**Goal:** remove three failure modes in the live audio path that would make the first real smoke
test flaky. All three stem from the original spec; the agent implemented the spec faithfully.

**Findings being fixed**
- **F1 (high)** `offscreen.js` creates `AudioContext` without `resume()`. Offscreen docs are not
  created from a user gesture, so the context can start suspended and the recorder captures silence.
- **F2 (high)** `offscreen.js` calls `start(msg.streamId)` with no `.catch()`. If `getUserMedia`
  rejects (mic denied / bad stream id) the side panel is stuck on "Recording" with no feedback.
- **F3 (medium)** `service-worker.js` broadcasts `OFFSCREEN_START` immediately after
  `offscreen.createDocument()`; if the offscreen listener is not registered yet the message is
  dropped and recording silently never starts.

**Files**
- `src/lib/messages.js` (add `OFFSCREEN_READY`, `CAPTURE_ERROR`)
- `src/offscreen/offscreen.js`
- `src/background/service-worker.js`
- `src/sidepanel/sidepanel.js` (handle `CAPTURE_ERROR`, reset controls)

**Steps**
1. After `new AudioContext()`, `await audioCtx.resume()` before wiring nodes.
2. Send `OFFSCREEN_READY` once at offscreen startup (after the listener is registered).
3. Service worker: after `ensureOffscreen()`, wait for `OFFSCREEN_READY` (with a short timeout)
   before sending `OFFSCREEN_START`.
4. Wrap `start()` in `try/catch`; on failure, run `cleanup()` and send `CAPTURE_ERROR` with the
   message. Side panel listens, shows it in status, and calls `setRecording(false)`.

**Acceptance criteria**
- A recording of a tab that is playing audio yields non-silent audio.
- Denying mic permission shows a clear status error and resets Start/Stop.
- Start reliably begins recording on the first attempt (no silent no-op).

**Agent-side verification:** `bash tools/check.sh`; confirm only the new message constants changed.

**Human verification (request in handoff):** rerun the `architecture.md` §16 checklist.

**Optional (note, not required):** `service-worker.js` passes `tab.title`, which requires the
`tabs` permission; without it the value is `undefined`. Either add `"tabs"` and use it for
`Meeting.title`, or drop the dead parameter.

---

## 6. Verification tooling

Create `tools/check.sh` as part of **T1** and run it after every task. It performs static checks only
(the agent has no interactive browser). Human/browser checks are requested in the handoff.

```bash
#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

echo "== manifest.json =="
if python3 -m json.tool "$ROOT/manifest.json" >/dev/null 2>&1; then
  echo "OK manifest.json"
else
  echo "FAIL manifest.json is not valid JSON"; fail=1
fi

echo "== JS syntax =="
while IFS= read -r f; do
  tmp="$(mktemp --suffix=.mjs)"
  cp "$f" "$tmp"
  if node --check "$tmp" >/dev/null 2>&1; then
    echo "OK $f"
  else
    echo "FAIL syntax: $f"; node --check "$tmp"; fail=1
  fi
  rm -f "$tmp"
done < <(find "$ROOT/src" -name '*.js' 2>/dev/null)

echo "== remote scripts (must be none) =="
if grep -rnE 'https?://[^"'"'"' )]+\.js' "$ROOT/src" "$ROOT/manifest.json" 2>/dev/null; then
  echo "FAIL remote script reference found"; fail=1
else
  echo "OK no remote scripts"
fi

echo "== forbidden hosts (only the two providers allowed) =="
if grep -rhoE 'https://[a-z0-9.-]+' "$ROOT/src" 2>/dev/null \
   | sort -u \
   | grep -vE 'generativelanguage\.googleapis\.com|api\.deepseek\.com|^$'; then
  echo "NOTE: unexpected host(s) above — confirm with reviewer"
fi

echo "== expected files =="
for f in \
  manifest.json \
  src/background/service-worker.js \
  src/offscreen/offscreen.html \
  src/offscreen/offscreen.js \
  src/sidepanel/sidepanel.html \
  src/sidepanel/sidepanel.css \
  src/sidepanel/sidepanel.js \
  src/lib/messages.js \
  src/lib/settings.js \
  src/lib/store.js \
  src/lib/templates.js \
  src/lib/providers/transcription.gemini.js \
  src/lib/providers/notes.deepseek.js ; do
  if [ -f "$ROOT/$f" ]; then echo "OK $f"; else echo "MISSING $f"; fail=1; fi
done

echo
[ "$fail" -eq 0 ] && echo "ALL STATIC CHECKS PASSED" || echo "STATIC CHECKS FAILED"
exit $fail
```

Notes:
- `node --check` runs in CommonJS mode for `.js`, which rejects `import`. The script copies each file
  to a temp `.mjs` so syntax checking works for ES modules. Imports are not resolved (syntax only).
- For T1–T5, files not yet created are expected to be reported `MISSING`; that is fine until T6.
  Treat only failures for files that should exist by the current task as blocking.

---

## 7. Progress tracking

The agent updates **Status** and **Evidence** after each task. The reviewer updates **Review**.

| ID | Task | Status | Evidence (paste) | Review |
|----|------|--------|------------------|--------|
| T1 | Extension loads | done | manifest valid; 4/4 JS syntax OK; no remote scripts; T1 files all OK; T2–T5 MISSING expected | approved |
| T2 | Records tab + mic | done | 6/6 JS syntax OK; no remote scripts; no content_scripts; T2 files all OK; T3–T5 MISSING expected | approved |
| T3 | Transcription (Gemini) | done | 7/7 JS syntax OK; only generativelanguage host; T3 files all OK; T4–T5 MISSING expected | approved |
| T4 | Notes (DeepSeek) | done | 9/9 JS syntax OK; only the two provider hosts; T4 files all OK; only store.js MISSING (T5) | approved |
| T5 | Local history | done | ALL STATIC CHECKS PASSED; 10/10 JS OK; full file set present | approved |
| T6 | Polish & hardening | done | ALL STATIC CHECKS PASSED; icons valid PNGs wired in manifest; console.error only; empty states added | approved |
| T7 | Runtime hardening (post-review) | done | ALL STATIC CHECKS PASSED; OFFSCREEN_READY + CAPTURE_ERROR constants wired; audioCtx.resume added | approved |
| T8 | tabCapture host-permission fix | reverted | Smoke test proved `*://*/*` does not fix it — Chrome requires extension invocation, not host permissions; reverted | superseded |
| T9 | tabCapture invocation fix | done | Panel now opens from `action.onClicked` (grants activeTab); friendlier error; architecture.md §7.1/§7.2/§11/§13 synced | pending |
| T10 | Reset persisted `setPanelBehavior` | done | Root cause: `openPanelOnActionClick:true` persists across reloads and swallows the invocation; now forced `false` at service-worker startup | pending |
| T11 | Prime mic permission from side panel | done | Offscreen can't prompt for `getUserMedia`; side panel now requests mic before capture; offscreen degrades to tab-audio-only if blocked | pending |
| T12 | Update Gemini model | done | `gemini-2.5-flash` retired for new keys (404); switched to `gemini-3.6-flash` in provider + architecture.md §7.7 | pending |
| T13 | Shared retry helper | done | `src/lib/net.js`; both providers use it | pending |
| T14 | Persist on stop + status + Retry | done | segments store (DB v2); status lifecycle; Retry button | pending |
| T15 | Chunked recording + stitched transcription | done | 10-min segment rotation; sequential transcription with progress | pending |
| T16 | Model fallback chain (configurable) | done | `models.js` + settings inputs; fall-through on 404/5xx | pending |
| T17 | Map-reduce notes for long transcripts | done | `notes.deepseek.js` map-reduce above 40k chars | pending |

Status values: `todo` · `in-progress` · `done` · `blocked`.
Review values: `pending` · `approved` · `changes-requested`.

> T13–T17 are specified in detail in [`RESILIENCE_PLAN.md`](./RESILIENCE_PLAN.md).

---

## 8. Review protocol (how the reviewer operates)

After each task the agent stops. The reviewer will:

1. Confirm the task's files exist and match `architecture.md` (no drift, no extra dependencies).
2. Re-run `bash tools/check.sh` independently.
3. Check the acceptance criteria against the agent's evidence and the code.
4. Mark the task `approved` (agent proceeds to the next) or `changes-requested` with a specific,
   itemized list. On `changes-requested`, the agent fixes only the listed items and stops again.
5. Keep the table in §7 current; this table is the single source of truth for project state.

The reviewer does not write product code. If the reviewer changes scope, it is recorded as a new task
`T7+` in this document before work begins.

---

## 9. Stop conditions (ask, don't guess)

Stop and request guidance if any of these occur:

- You cannot create binary PNG icons (T6).
- A task's acceptance criteria seem to conflict with `architecture.md`.
- A required file's contents in `architecture.md` are ambiguous or appear incorrect.
- You are asked, or tempted, to add a dependency, a build step, or a third-party host.
- The environment blocks network access needed for anything beyond static checks.
- API keys are required to verify something (never hardcode keys; ask the human to test).
- You finish a task (always stop for review after finishing).

---

## 10. Handoff template (use after every task)

```
## Handoff — T<n>
Status: done | blocked

Files created/changed:
- <path>
- <path>

check.sh output:
<full output>

Acceptance criteria:
- [x] <criterion> — <how verified>
- [ ] <criterion> — <needs human>

Human verification needed:
- <exact steps the reviewer should perform>

Questions / ambiguities:
- <none | list>

Next task: T<n+1> (awaiting approval)
```

---

## 11. What NOT to do

- Do not add TypeScript, a bundler, npm packages, or a `package.json` for the product.
- Do not add a content script, caption scraping, live streaming, or speaker diarization — those are
  post-v1 upgrades (`architecture.md` §17).
- Do not add a backend, proxy, accounts, or analytics.
- Do not store audio blobs in `chrome.storage`; IndexedDB is for meeting records only.
- Do not commit, push, or create branches unless the reviewer explicitly asks.
- Do not proceed past a task without review, even if everything passes.
