import { MSG } from '../lib/messages.js';
import { saveCaptureRun, saveSegment } from '../lib/store.js';

const SEGMENT_MS = 10 * 60 * 1000;

let audioCtx = null;
let tabStream = null;
let micStream = null;
let tabTrack = null;
let dest = null;
let meetingId = null;
let segmentIndex = 0;
let segmentStartOffset = 0;
let segmentStartedAt = 0;
let recordedSeconds = 0;
let startedAt = 0;
let currentRec = null;
let parts = [];
let rotateTimer = null;
let captureLimitTimer = null;
let stopping = false;
let interrupted = false;
let interruptionNotified = false;
let finished = false;
let captureError = null;

chrome.runtime.onMessage.addListener((msg, sendResponse) => {
  if (msg.type === MSG.OFFSCREEN_START) start(msg.streamId, msg.meetingId, msg.maxDurationSec);
  if (msg.type === MSG.OFFSCREEN_STOP) stop();
  if (msg.type === MSG.GET_CAPTURE_STATUS) {
    sendResponse({
      active: Boolean(currentRec),
      meetingId,
      segmentCount: segmentIndex,
      startedAt,
      recordedSeconds
    });
    return true;
  }
  return false;
});

chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_READY }).catch(() => {});

async function setRun(status, patch = {}) {
  if (!meetingId) return;
  try {
    await saveCaptureRun({
      meetingId,
      status,
      segmentCount: segmentIndex,
      startedAt,
      finishedAt: status === 'complete' || status === 'interrupted' ? Date.now() : null,
      error: patch.error ?? null,
      updatedAt: Date.now(),
      ...patch
    });
  } catch (error) {
    console.error('Failed to persist capture progress', error);
  }
}

async function notify(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch (error) {
    // The side panel may be closed. Progress is already in IndexedDB.
  }
}

async function start(streamId, mid, maxDurationSec) {
  try {
    meetingId = mid;
    segmentIndex = 0;
    segmentStartOffset = 0;
    recordedSeconds = 0;
    stopping = false;
    interrupted = false;
    interruptionNotified = false;
    finished = false;
    captureError = null;

    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false
    });

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);

    audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    dest = audioCtx.createMediaStreamDestination();

    const tabSrc = audioCtx.createMediaStreamSource(tabStream);
    tabSrc.connect(dest);
    tabSrc.connect(audioCtx.destination); // keep the captured tab audible to the user

    if (micStream) {
      const micSrc = audioCtx.createMediaStreamSource(micStream);
      micSrc.connect(dest); // never route the mic to speakers (feedback)
    }

    tabTrack = tabStream.getAudioTracks()[0] || null;
    if (tabTrack) {
      tabTrack.onended = () => {
        if (!stopping && !interrupted) {
          void interruptCapture(new Error('Tab audio ended before recording was stopped.'));
        }
      };
    }

    startedAt = Date.now();
    if (Number.isFinite(maxDurationSec) && maxDurationSec > 0) {
      captureLimitTimer = setTimeout(() => { void stop(); }, maxDurationSec * 1000);
    }
    await setRun('active', { segmentCount: 0, error: null });
    beginSegment();
  } catch (err) {
    await interruptCapture(err);
  }
}

function beginSegment() {
  if (stopping || interrupted || !dest) return;
  parts = [];
  segmentStartedAt = audioCtx.currentTime;
  currentRec = new MediaRecorder(dest.stream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 32000
  });

  currentRec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  currentRec.onerror = (event) => {
    const reason = event?.error instanceof Error ? event.error.message : event?.message;
    void interruptCapture(new Error(reason || 'Audio recording failed unexpectedly.'));
  };

  currentRec.onstop = async () => {
    const blob = new Blob(parts, { type: 'audio/webm' });
    const index = segmentIndex;
    const durationSec = Math.max(0, audioCtx.currentTime - segmentStartedAt);
    currentRec = null;

    try {
      if (blob.size && meetingId) {
        await saveSegment(meetingId, index, blob, {
          byteSize: blob.size,
          startOffsetSec: segmentStartOffset,
          durationSec,
          recordedAt: Date.now(),
          status: 'complete'
        });
      }
      segmentIndex = index + 1;
      recordedSeconds = segmentStartOffset + durationSec;
      segmentStartOffset = recordedSeconds;

      if (!stopping && !interrupted) {
        await setRun('active', { segmentCount: segmentIndex });
        await notify({
          type: MSG.SEGMENT_SAVED,
          meetingId,
          index,
          segmentCount: segmentIndex,
          elapsedSec: Math.round((Date.now() - startedAt) / 1000)
        });
      }
    } catch (err) {
      await interruptCapture(err);
      return;
    }

    if (interrupted) {
      await notifyInterrupted();
      return;
    }
    if (stopping) {
      await finish();
      return;
    }
    beginSegment();
  };

  try {
    currentRec.start();
  } catch (err) {
    void interruptCapture(err);
    return;
  }
  rotateTimer = setTimeout(() => {
    if (currentRec && !interrupted) {
      try {
        currentRec.stop();
      } catch (err) {
        void interruptCapture(err);
      }
    }
  }, SEGMENT_MS);
}

async function stop() {
  if (interrupted) {
    await notifyInterrupted();
    return;
  }
  stopping = true;
  clearTimeout(captureLimitTimer);
  clearTimeout(rotateTimer);
  await setRun('finishing', { segmentCount: segmentIndex });
  if (currentRec) currentRec.stop();
  else await finish();
}

async function interruptCapture(error) {
  const reason = error instanceof Error ? error : new Error(String(error || 'Recording was interrupted.'));
  if (!captureError) captureError = reason;
  if (interrupted) {
    await notifyInterrupted();
    return;
  }
  interrupted = true;
  clearTimeout(rotateTimer);
  if (currentRec && currentRec.state !== 'inactive') {
    try {
      currentRec.stop();
    } catch (recorderError) {
      if (!captureError) captureError = recorderError;
    }
  } else {
    await notifyInterrupted();
  }
}

async function notifyInterrupted() {
  if (interruptionNotified) return;
  interruptionNotified = true;
  const reason = captureError || new Error('Recording was interrupted.');
  const segmentCount = segmentIndex;
  cleanup();
  await setRun('interrupted', { segmentCount, error: String(reason.message || reason) });
  await notify({
    type: MSG.CAPTURE_INTERRUPTED,
    meetingId,
    segmentCount,
    error: String(reason.message || reason)
  });
}

async function finish() {
  if (finished || interrupted) return;
  finished = true;
  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  const count = segmentIndex;
  const finishedMeetingId = meetingId;
  cleanup();
  await setRun('complete', { segmentCount: count });
  await notify({
    type: MSG.RECORDING_DONE,
    meetingId: finishedMeetingId,
    segmentCount: count,
    durationSec
  });
}

function cleanup() {
  clearTimeout(rotateTimer);
  clearTimeout(captureLimitTimer);
  if (tabTrack) tabTrack.onended = null;
  tabStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  tabStream = micStream = tabTrack = audioCtx = dest = currentRec = null;
  parts = [];
}
