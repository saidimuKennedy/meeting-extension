# RESILIENCE_PLAN.md — Provider Failures & Long Meetings

> Companion to [`AGENT_PLAN.md`](./AGENT_PLAN.md) and [`../architecture.md`](../architecture.md).
> Executed with the same discipline: one task at a time, stop for review after each.
> Status is tracked in the table in §8.

---

## 1. Why this exists

The v1 pipeline is correct but fragile under real-world conditions:

- **Transient provider errors** (`503`, `429`, `500`, network) fail the whole run.
- **Model retirement** (`404`, e.g. `gemini-2.5-flash` retired for new keys) requires a code change.
- **Long audio** sent inline approaches the ~20 MB request cap and is a common source of `503`s.
- **Long transcripts** can exceed the notes model's context window.
- **Worst of all: a failed run loses the recording.** We currently persist only on success, so a
  transient error throws away the user's meeting.

## 2. Failure taxonomy

| Class | Examples | Recovery |
|---|---|---|
| Transient network | offline, DNS, connection reset | retry with backoff |
| Provider throttling | HTTP 429 | retry, honor `Retry-After` |
| Provider outage | HTTP 500/502/503/504 | retry, then model fallback chain |
| Model retired/unavailable | HTTP 404 "no longer available" | try next model in chain |
| Payload too large | inline audio over ~20 MB | chunked recording (§Phase 2) |
| Context overflow | transcript too long for notes model | map-reduce (§Phase 3) |
| User error | bad API key, mic blocked | surface clearly, no retry |

## 3. Principles

1. **Never lose user data.** The recording is persisted before any network call.
2. **Retry idempotent work.** Transcription and note generation are safe to repeat.
3. **Keep requests small.** Many small calls beat one huge call (better latency, fewer 503s).
4. **Resume from the failed step.** A meeting advances through explicit states; retry continues,
   it does not restart.
5. **Fail visibly, never silently.** Every failure leaves a durable record and a clear status.

---

## 4. Phase 1 — Recoverable runs (highest value, smallest change)

### T13 — Shared retry helper

**Goal:** one place that retries transient provider failures.

**Files**
- `src/lib/net.js` (new)
- `src/lib/providers/transcription.gemini.js`, `src/lib/providers/notes.deepseek.js` (use it)

**Steps**
1. Add `fetchWithRetry(url, options, { retries = 5, baseDelayMs = 1000, maxDelayMs = 30000 })`.
2. Retry when: network `TypeError`, or status in `{408, 429, 500, 502, 503, 504}`.
3. Backoff: `min(maxDelay, baseDelay * 2^attempt)` plus full jitter (`Math.random()`).
4. Honor `Retry-After` (seconds or HTTP date) when present.
5. Do **not** retry other `4xx` (bad key, bad request) — throw immediately.
6. Parse the response body only once; return the `Response` on success.

**Acceptance**
- A simulated `503` then `200` resolves without error (verified with a stubbed fetcher).
- A `401` fails immediately with no retries.
- Backoff delays are bounded and include jitter.

**Verification:** `bash tools/check.sh`; a small Node script exercising the retry logic against a
stub (no network).

---

### T14 — Persist on stop, status lifecycle, Retry button

**Goal:** a failed run keeps the recording and can be resumed.

**Files**
- `src/lib/store.js` (extend the `Meeting` schema + segment storage)
- `src/offscreen/offscreen.js` (write segments to IndexedDB as they complete)
- `src/background/service-worker.js` (pass a `recordingId` to offscreen)
- `src/sidepanel/sidepanel.js` (status lifecycle, persist-before-process, Retry)
- `../architecture.md` (data model §8, provider notes)

**Data model (additions to `Meeting`)**
```
status: 'recording' | 'recorded' | 'transcribing' | 'transcribed'
      | 'generating' | 'done' | 'error'
error?: string
segmentCount?: number
```
Segments are stored separately (`segments` object store, key `${meetingId}:${index}`) so the
meeting record stays small.

**Steps**
1. On Start, service worker generates `recordingId` and passes it with `OFFSCREEN_START`.
2. Offscreen rotates `MediaRecorder` every `SEGMENT_MS` (default 10 min); each finished segment is
   written to IndexedDB immediately (blob, indexed). On stop, flush the final segment.
3. `RECORDING_DONE` carries `{ recordingId, segmentCount, durationSec }` — **not** the audio.
4. Side panel creates/updates the meeting with `status: 'recorded'` and **persists it before** any
   network call.
5. Advance status per step (`transcribing` → `transcribed` → `generating` → `done`/`error`),
   persisting after each transition.
6. History items with `status: 'error'` (or any pre-`done` state) show a **Retry** button that
   resumes from the failed step using stored segments / transcript.
7. Delete segments only after `status: 'done'`.

**Acceptance**
- Kill the network, record, Stop → meeting persisted as `error`; recording is not lost.
- Restore network → Retry completes transcription + notes from stored segments.
- Reloading the extension mid-`error` keeps the retryable meeting.
- A successful run deletes its segments.

**Verification:** `bash tools/check.sh`; human test of the network-kill scenario.

---

## 5. Phase 2 — Long audio

### T15 — Chunked recording + stitched transcription

**Goal:** meetings of any length transcribe with many small requests.

**Files**
- `src/offscreen/offscreen.js` (segment rotation — partly done in T14)
- `src/lib/providers/transcription.gemini.js` (accept a single segment)
- `src/sidepanel/sidepanel.js` (sequential transcription, overlap handling, stitching)

**Steps**
1. Reuse T14's segment rotation (≈10–15 min each). Optionally keep ~2 s overlap between segments.
2. Transcribe segments **sequentially** (small, fast, retryable) rather than in parallel, to avoid
   bursty `429`s. Surface progress: "Transcribing 3/6…".
3. Stitch transcripts in order; de-duplicate text at overlap boundaries (best-effort).
4. If one segment fails after retries, mark the meeting `error` but keep already-transcribed
   segments so Retry only redoes the failed ones.
5. Keep the single-call path for short recordings (< one segment) — do not regress.

**Acceptance**
- A >1 h recording is transcribed via multiple segment calls with no size-limit errors.
- Progress is visible during transcription.
- Retry after a mid-way failure resumes from the failed segment.

**Verification:** `bash tools/check.sh`; human test with a long recording (or a lowered
`SEGMENT_MS` to force many segments in a short test).

---

## 6. Phase 3 — Model resilience + long transcripts

### T16 — Model fallback chain (configurable)

**Goal:** model rotation never requires a code change.

**Files**
- `src/lib/providers/transcription.gemini.js`, `src/lib/providers/notes.deepseek.js`
- `src/lib/settings.js`, `src/sidepanel/sidepanel.html` + `.js` (settings UI)
- `../architecture.md` (§7.7, §7.8, §13 pitfall #10)

**Steps**
1. Settings gain `geminiModels: string[]` and `deepseekModel: string`, with sensible defaults.
2. Providers accept a model and try the chain on `404` and repeated `503`; each attempt uses
   `fetchWithRetry`.
3. Log/return which model succeeded; show it in the status line (helps future debugging).
4. Default chain: primary `gemini-3.6-flash`, fallback(s) updated as Google rotates models.

**Acceptance**
- A retired/`404` primary model transparently falls through to the fallback and completes.
- The settings UI lets the user edit the chain and persists it.

**Verification:** `bash tools/check.sh`; human test by setting the primary to a bogus model name.

---

### T17 — Map-reduce notes for long transcripts

**Goal:** notes still generate when the transcript exceeds the notes model's context.

**Files**
- `src/lib/providers/notes.deepseek.js` (or a new `notes.chunked.js`)
- `src/sidepanel/sidepanel.js`

**Steps**
1. Estimate transcript size (chars or tokens). If under threshold, use the current single call.
2. If over threshold: split into overlapping chunks → summarize each (with retry) → final pass that
   merges the partial summaries into the selected template.
3. Persist intermediate summaries so Retry does not redo completed chunks.

**Acceptance**
- A synthetic very long transcript (concatenated fixtures) produces complete notes with no
  context-overflow error.
- Short transcripts still use the single call (no behavior change).

**Verification:** `bash tools/check.sh`; a Node fixture test for chunking boundaries.

---

## 7. Cross-cutting

- **Observability:** the status line shows the current step, model used, and segment progress.
  Errors are stored on the meeting record (`error`), not just shown transiently.
- **Idempotency:** every retried call must be safe (transcription/notes are).
- **Cleanup:** segments are deleted on success; a "Clear failed recordings" affordance is optional.
- **Docs:** `architecture.md` is updated in the same task that changes behavior (no drift).
- **No new dependencies:** retry/chunking are hand-written; keep the no-build constraint.

## 8. Tracking

The agent updates **Status**/**Evidence**; the reviewer updates **Review**. Rows are also mirrored
into `AGENT_PLAN.md` §7.

| ID | Task | Phase | Status | Evidence | Review |
|----|------|-------|--------|----------|--------|
| T13 | Shared retry helper | 1 | done | `src/lib/net.js`; both providers use it; static checks pass | pending |
| T14 | Persist on stop + status + Retry | 1 | done | segments store (DB v2); status lifecycle; Retry button in History | pending |
| T15 | Chunked recording + stitched transcription | 2 | done | offscreen rotates 10-min segments; sidepanel transcribes sequentially with progress | pending |
| T16 | Model fallback chain (configurable) | 3 | done | `models.js` + settings inputs; providers fall through on 404/5xx | pending |
| T17 | Map-reduce notes for long transcripts | 3 | done | `notes.deepseek.js` map-reduce above 40k chars | pending |

Status values: `todo` · `in-progress` · `done` · `blocked`.
Review values: `pending` · `approved` · `changes-requested`.

## 9. Recommended order

`T13 → T14 → T15 → T16 → T17`. T13 and T14 together make every subsequent failure recoverable, so
they come first. T15 unblocks long meetings; T16 and T17 harden the model and context edges.

## 10. Open questions

- Default segment length (`SEGMENT_MS`)? 10 min balances request size vs. overlap/wasted tokens.
- Do we keep the audio after success (for re-transcription with a better model), or delete it?
- Should Retry be automatic (on transient errors) or always user-initiated? (Proposal: automatic
  within a run; user-initiated after a terminal failure.)
- Is a "processing queue" needed if two meetings are recorded back-to-back? (Probably not at 5 users.)

---

## 11. Next improvement roadmap — audit 2026-10-02

The original T13–T17 work is present in the source tree. It is a useful baseline, but the plans
and `architecture.md` still describe the earlier Gemini-only, single-recording design. The following
tasks supersede the stale Gemini-specific portions of this document. Execute them in order, keep
each task reviewable, and update the architecture and plan evidence as implementation lands.

### Audit findings

- `offscreen.js` already rotates the recorder every 10 minutes and writes each WebM segment to
  IndexedDB. The side panel transcribes the saved segments sequentially and shows segment progress.
- `fetchWithRetry()` handles transient network/provider failures. DeepSeek notes use map-reduce over
  transcripts longer than 40,000 characters.
- A transcription retry currently starts at segment 1. Completed segment transcripts are not saved
  independently, so a failure late in a multi-hour meeting repeats paid requests.
- Recorder rotation is asynchronous. Track termination, failed IndexedDB writes, extension reload,
  and incomplete-recording recovery need an explicit lifecycle and visible states. History currently
  offers Retry for every status other than `done`, including a meeting that may still be recording.
- The settings and UI expose exactly two built-in note templates (`standard`, `standup`). The current
  notes prompts do not consistently distinguish decisions, proposals, owners, due dates, and open
  questions; long-note reduction uses one generic summarizer regardless of the selected template.
- `architecture.md` and earlier task descriptions still say Gemini, refer to an obsolete inline
  audio request path, and do not document the current segment store and retry pipeline.
- No code was intentionally changed during this audit. An initial uncommitted provider-switch attempt
  was reverted before planning; the implementation baseline remains unchanged.

### T18 — Pluggable transcription providers (planned)

**Goal:** replace Gemini with Whisper first, while making the transcription API provider selectable
and easy to extend or replace later.

**Files:** transcription provider modules/registry, `models.js`, settings and side panel,
`manifest.json`, architecture and task plans.

**Implementation points:** define a small common transcription interface and provider registry; ship
OpenAI Whisper as the first adapter; store each provider's key/settings separately from DeepSeek;
show only settings relevant to the selected provider; request any needed host permission; remove
Gemini from active UI/code. Keep the audio segments provider-neutral so changing provider never
requires re-recording. Make missing-key and HTTP errors actionable. Preserve legacy meetings.

The OpenAI transcription API accepts WebM and requires a file and model. Use the official
[Create transcription API reference](https://platform.openai.com/docs/api-reference/audio/createTranscription)
as the Whisper adapter authority. It documents a 25 MB upload limit; measure/guard each segment and
retain a margin under that limit. The existing 10-minute, 32 kbps segments are expected to be well
below it, but actual encoded size must be checked rather than assumed.

**Acceptance:** a short saved segment transcribes through Whisper; provider selection and settings
work; adding another adapter does not require changes to recording/storage; invalid/missing key
errors are visible; DeepSeek settings and existing history remain.

### T19 — Multi-hour recording durability and resumable transcription (planned)

**Goal:** record and process several hours without losing audio or repeating completed transcription
work after a recoverable failure.

**Files:** `offscreen.js`, `store.js`, `sidepanel.js`, `service-worker.js`, messages, architecture.

**Implementation points:** persist each finished segment before reporting it complete; persist each
transcript segment and its progress on the meeting record (or a dedicated IndexedDB store); resume
from the first missing/failed segment; maintain deterministic ordering and global timestamp offsets;
handle recorder errors, stopped tab tracks, and IndexedDB quota errors by stopping safely and showing
which audio was retained. Distinguish `recording`, `recorded`, `transcribing`, `generating`, `done`,
and `error` in controls and history. Do not offer Retry for active recordings. Add explicit recovery
for meetings left in `recording` by a panel/extension reload. Keep sequential provider calls to avoid
rate-limit bursts.

Before changing segment duration or introducing a hard recording limit, inspect actual encoded sizes,
IndexedDB quota behavior, and Chrome offscreen-document lifecycle. Add a user-visible duration and
segment count so a multi-hour session can be monitored. Keep captured audio until notes succeed or
the user deletes the meeting. Persist the completed transcript and notes with the meeting, independent
of audio retention. Add export for transcript and notes (Markdown/text); deleting a meeting must also
delete its segments and saved derived data. Document that retryable recordings consume local disk
space.

**Acceptance:** multi-hour capture creates ordered, non-empty segments; progress and duration remain
visible; retry sends only missing segments; transcript and notes persist after reload and can be
exported; storage/track errors stop cleanly and leave a recoverable record.

### T20 — Optional templates and better notes (planned)

**Goal:** improve note quality without forcing the user to pick a template.

**Files:** `templates.js`, `notes.deepseek.js`, side panel UI, architecture.

Add a "General notes" option that generates useful notes without a fixed section template, plus
optional built-in choices such as Standard meeting, Standup, Project review, Interview, Lecture/training,
and Action items. Allow a user prompt/instructions field to customize General notes. Each choice must
work with long-transcript reduction. Preserve the transcript as source of truth; distinguish decisions
from proposals; never invent owners/dates; state when information is missing; retain risks,
dependencies, disagreements, and open questions. Split long transcripts on paragraph or timestamp
boundaries with overlap, persist partial summaries, and make reduction match the chosen mode.

**Acceptance:** General notes works without a template; optional formats and custom instructions
persist across reload; long and short outputs preserve facts and do not invent owners/dates; retries
do not redo completed reduction chunks; rendered output remains escaped.

### T21 — Usable UI and operating guide (planned)

**Goal:** make everyday recording and finding saved work simple, with clear recovery states.

Keep the side panel compact and add an expanded full-page workspace in an extension tab; carry the
originating meeting-tab ID into that page so capture stays on the correct tab. Use a responsive
two-column layout on wide screens. Simplify the main view around Start/Stop, elapsed time, and status.
Move infrequent settings behind a clearly labeled settings area; group provider/key and notes options;
use clear labels, defaults, and help text. Make saved meetings easy to browse, search/open, rename,
export, and delete. Explain OpenAI quota errors with billing/credit guidance. Show microphone
availability and actionable capture/provider errors. Add a concise README covering installation, API
keys, permissions, processing, local retention, and common errors.
Update architecture/task plans to describe the actual implementation.

**Acceptance:** a new user can configure providers and notes behavior, record a multi-hour session,
understand progress/errors, reopen/export/delete transcript and notes, and understand where audio is kept.

### Execution order

`T18 → T19 → T20 → T21`. Update the task tables when each task is implemented and reviewed. This
roadmap is planning only; no T18–T21 implementation has begun.
