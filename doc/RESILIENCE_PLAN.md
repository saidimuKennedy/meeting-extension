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
