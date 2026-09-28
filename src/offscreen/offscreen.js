import { MSG } from '../lib/messages.js';
import { saveSegment } from '../lib/store.js';

const SEGMENT_MS = 10 * 60 * 1000;

let audioCtx = null;
let tabStream = null;
let micStream = null;
let dest = null;
let meetingId = null;
let segmentIndex = 0;
let startedAt = 0;
let currentRec = null;
let parts = [];
let rotateTimer = null;
let stopping = false;
let finished = false;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.OFFSCREEN_START) start(msg.streamId, msg.meetingId);
  if (msg.type === MSG.OFFSCREEN_STOP) stop();
});

chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_READY });

async function start(streamId, mid) {
  try {
    meetingId = mid;
    segmentIndex = 0;
    stopping = false;
    finished = false;

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

    startedAt = Date.now();
    beginSegment();
  } catch (err) {
    cleanup();
    await chrome.runtime.sendMessage({
      type: MSG.CAPTURE_ERROR,
      error: String(err?.message || err)
    });
  }
}

function beginSegment() {
  parts = [];
  currentRec = new MediaRecorder(dest.stream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 32000
  });

  currentRec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };

  currentRec.onstop = async () => {
    const blob = new Blob(parts, { type: 'audio/webm' });
    const index = segmentIndex++;
    currentRec = null;

    if (blob.size && meetingId) {
      try {
        await saveSegment(meetingId, index, blob);
      } catch (err) {
        console.error('Failed to persist audio segment', err);
      }
    }

    if (stopping) await finish();
    else beginSegment();
  };

  currentRec.start();
  rotateTimer = setTimeout(() => { if (currentRec) currentRec.stop(); }, SEGMENT_MS);
}

async function stop() {
  stopping = true;
  clearTimeout(rotateTimer);
  if (currentRec) currentRec.stop();
  else await finish();
}

async function finish() {
  if (finished) return;
  finished = true;
  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  const segmentCount = segmentIndex;
  cleanup();
  await chrome.runtime.sendMessage({
    type: MSG.RECORDING_DONE,
    meetingId,
    segmentCount,
    durationSec
  });
}

function cleanup() {
  clearTimeout(rotateTimer);
  tabStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  tabStream = micStream = audioCtx = dest = currentRec = null;
  parts = [];
}
