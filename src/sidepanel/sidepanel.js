import { MSG } from '../lib/messages.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { noteFormats } from '../lib/templates.js';
import { DEFAULT_TRANSCRIPTION_PROVIDER_ID, DEFAULT_OPENAI_TRANSCRIPTION_MODEL, DEFAULT_DEEPSEEK_MODEL } from '../lib/models.js';
import { getTranscriptionProvider, listTranscriptionProviders } from '../lib/providers/transcription/index.js';
import { generateNotes } from '../lib/providers/notes.deepseek.js';
import {
  saveMeeting,
  listMeetings,
  getMeeting,
  deleteMeeting,
  listSegments,
  deleteSegments,
  saveSegmentTranscript,
  listSegmentTranscripts,
  listReductions,
  saveReduction,
  deleteReductions
} from '../lib/store.js';

const $ = (id) => document.getElementById(id);
const els = {
  dot: $('status-dot'),
  status: $('status-text'),
  elapsed: $('elapsed-text'),
  segmentCount: $('segment-count'),
  transcriptionOnlyTest: $('transcription-only-test'),
  speakerLabelTest: $('speaker-label-test'),
  start: $('start'),
  stop: $('stop'),
  settingsToggle: $('settings-toggle'),
  settings: $('settings'),
  providerRow: $('provider-row'),
  transcriptionProvider: $('transcription-provider'),
  openaiKey: $('openai-key'),
  openaiModel: $('openai-model'),
  deepseekKey: $('deepseek-key'),
  noteFormat: $('note-format'),
  customInstructions: $('custom-instructions'),
  deepseekModel: $('deepseek-model'),
  saveSettings: $('save-settings'),
  notes: $('notes'),
  transcript: $('transcript'),
  exportTranscript: $('export-transcript'),
  exportNotes: $('export-notes'),
  regenerateNotes: $('regenerate-notes'),
  history: $('history-list')
};

let activeMeetingId = null;
let activeStartedAt = 0;
let activeSegmentCount = 0;
let elapsedTimer = null;
let currentMeeting = null;

init();

async function init() {
  noteFormats.forEach((format) => {
    const opt = document.createElement('option');
    opt.value = format.id;
    opt.textContent = format.name;
    els.noteFormat.appendChild(opt);
  });

  const providers = listTranscriptionProviders();
  providers.forEach((provider) => {
    const opt = document.createElement('option');
    opt.value = provider.id;
    opt.textContent = provider.label;
    els.transcriptionProvider.appendChild(opt);
  });

  const settings = await getSettings();
  els.providerRow.classList.toggle('hidden', providers.length < 2);
  els.transcriptionProvider.value = settings.transcriptionProviderId || DEFAULT_TRANSCRIPTION_PROVIDER_ID;
  els.openaiKey.value = settings.openaiApiKey || '';
  populateTranscriptionModels(getTranscriptionProvider(els.transcriptionProvider.value));
  els.openaiModel.value = settings.openaiTranscriptionModel || DEFAULT_OPENAI_TRANSCRIPTION_MODEL;
  els.deepseekKey.value = settings.deepseekKey || '';
  els.noteFormat.value = settings.noteFormatId || noteFormats[0].id;
  els.customInstructions.value = settings.customInstructions || '';
  els.deepseekModel.value = settings.deepseekModel || DEFAULT_DEEPSEEK_MODEL;

  els.settingsToggle.onclick = () => {
    const opening = els.settings.classList.contains('hidden');
    els.settings.classList.toggle('hidden', !opening);
    els.settingsToggle.setAttribute('aria-expanded', String(opening));
    els.settingsToggle.textContent = opening ? 'Close settings' : 'Settings';
  };
  els.transcriptionProvider.onchange = () => {
    const provider = getTranscriptionProvider(els.transcriptionProvider.value);
    populateTranscriptionModels(provider);
    els.openaiModel.value = provider.defaultModel;
  };
  els.transcriptionOnlyTest.onchange = () => {
    if (els.transcriptionOnlyTest.checked) els.speakerLabelTest.checked = false;
  };
  els.speakerLabelTest.onchange = () => {
    if (els.speakerLabelTest.checked) els.transcriptionOnlyTest.checked = false;
  };
  els.saveSettings.onclick = onSaveSettings;
  els.start.onclick = onStart;
  els.stop.onclick = onStop;
  els.exportTranscript.onclick = () => exportMeetingText('transcript');
  els.exportNotes.onclick = () => exportMeetingText('notes');
  els.regenerateNotes.onclick = onRegenerateNotes;

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => switchView(tab.dataset.view);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.RECORDING_DONE) onRecordingDone(msg);
    if (msg.type === MSG.SEGMENT_SAVED) onSegmentSaved(msg);
    if (msg.type === MSG.CAPTURE_INTERRUPTED) onCaptureInterrupted(msg);
    if (msg.type === MSG.CAPTURE_ERROR && msg.meetingId) onCaptureInterrupted(msg);
  });

  await reconcileInterruptedMeetings();
  renderHistory();
}

function populateTranscriptionModels(provider) {
  const labels = {
    'gpt-transcribe': 'gpt-transcribe (recommended)',
    'whisper-1': 'whisper-1 (timestamps)',
    'gpt-4o-transcribe-diarize': 'gpt-4o-transcribe-diarize (speaker labels)'
  };
  els.openaiModel.replaceChildren();
  provider.models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = labels[model] || model;
    els.openaiModel.appendChild(option);
  });
}

async function onSaveSettings() {
  const provider = getTranscriptionProvider(els.transcriptionProvider.value);
  await saveSettings({
    transcriptionProviderId: provider.id,
    openaiApiKey: els.openaiKey.value.trim(),
    openaiTranscriptionModel: els.openaiModel.value.trim() || provider.defaultModel,
    deepseekKey: els.deepseekKey.value.trim(),
    noteFormatId: els.noteFormat.value || noteFormats[0].id,
    customInstructions: els.customInstructions.value.trim(),
    deepseekModel: els.deepseekModel.value.trim() || DEFAULT_DEEPSEEK_MODEL
  });
  els.settings.classList.add('hidden');
  setStatus('Settings saved');
}

async function onStart() {
  const settings = await getSettings();
  const testOnly = els.transcriptionOnlyTest.checked || els.speakerLabelTest.checked;
  if (!settings.openaiApiKey || (!testOnly && !settings.deepseekKey)) {
    els.settings.classList.remove('hidden');
    setStatus(testOnly ? 'Add your OpenAI API key first' : 'Add your OpenAI and DeepSeek API keys first');
    return;
  }

  let micOk = true;
  try {
    await primeMicrophone();
  } catch (err) {
    micOk = false;
  }

  const meetingId = crypto.randomUUID();
  const meeting = {
    id: meetingId,
    title: 'Meeting',
    source: 'tab',
    startedAt: Date.now(),
    durationSec: 0,
    segmentCount: 0,
    transcriptionOnly: testOnly,
    transcriptionModel: els.speakerLabelTest.checked
      ? 'gpt-4o-transcribe-diarize'
      : els.transcriptionOnlyTest.checked
        ? 'whisper-1'
        : (settings.openaiTranscriptionModel || DEFAULT_OPENAI_TRANSCRIPTION_MODEL),
    participants: [],
    transcript: '',
    transcriptTimed: '',
    noteFormatId: settings.noteFormatId || noteFormats[0].id,
    customInstructions: settings.customInstructions || '',
    notesMarkdown: '',
    status: 'recording',
    error: null
  };
  await saveMeeting(meeting);
  setCurrentMeeting(meeting);
  activeMeetingId = meetingId;
  activeStartedAt = meeting.startedAt;
  activeSegmentCount = 0;
  startElapsedTimer();
  updateSegmentDisplay(0);
  renderHistory();

  setStatus('Starting...');
  const requestedTabId = Number(new URLSearchParams(location.search).get('targetTabId'));
  const targetTabId = Number.isInteger(requestedTabId) && requestedTabId > 0 ? requestedTabId : undefined;
  const res = await chrome.runtime.sendMessage({
    type: MSG.START_CAPTURE,
    meetingId,
    targetTabId,
    maxDurationSec: meeting.transcriptionOnly ? 240 : undefined
  });
  if (!res?.ok) {
    const failed = await getMeeting(meetingId);
    if (failed && failed.status === 'recording') {
      failed.status = 'error';
      failed.error = res?.error || 'Failed to start';
      await saveMeeting(failed);
    }
    clearActiveCapture();
    renderHistory();
    setStatus(res?.error || 'Failed to start');
    return;
  }

  setRecording(true);
  if (!micOk) setStatus('Recording (microphone blocked — tab audio only)');
}

async function onStop() {
  setStatus('Stopping...');
  await chrome.runtime.sendMessage({ type: MSG.STOP_CAPTURE });
}

async function onRecordingDone({ meetingId, segmentCount, durationSec }) {
  const existing = await getMeeting(meetingId);
  const settings = await getSettings();
  const meeting = existing || {
    id: meetingId,
    title: 'Meeting',
    source: 'tab',
    startedAt: Date.now() - durationSec * 1000,
    participants: [],
    transcript: '',
    transcriptTimed: '',
    noteFormatId: settings.noteFormatId || noteFormats[0].id,
    customInstructions: settings.customInstructions || '',
    notesMarkdown: ''
  };

  meeting.durationSec = durationSec;
  meeting.segmentCount = Number.isFinite(segmentCount) ? segmentCount : meeting.segmentCount || 0;
  meeting.status = 'recorded';
  meeting.error = null;
  await saveMeeting(meeting);
  clearActiveCapture();
  setRecording(false);
  setCurrentMeeting(meeting);

  await processMeeting(meeting);
}

async function processMeeting(meeting, { regenerateNotes = false } = {}) {
  const savedSettings = await getSettings();
  const settings = meeting.transcriptionModel
    ? { ...savedSettings, openaiTranscriptionModel: meeting.transcriptionModel }
    : savedSettings;
  const formatId = meeting.noteFormatId || settings.noteFormatId || noteFormats[0].id;
  const customInstructions = meeting.customInstructions || '';
  setCurrentMeeting(meeting);

  try {
    if (!meeting.transcriptTimed) {
      meeting.status = 'transcribing';
      await saveMeeting(meeting);
      const result = await transcribeSegmentsWithResume(meeting, settings);
      meeting.transcript = result.plainText;
      meeting.transcriptTimed = result.timedText;
      meeting.status = 'transcribed';
      meeting.error = null;
      await saveMeeting(meeting);
    }

    if (meeting.transcriptionOnly && !regenerateNotes) {
      meeting.status = 'transcribed';
      meeting.error = null;
      await saveMeeting(meeting);
      renderMeeting(meeting);
      switchView('transcript');
      await renderHistory();
      setStatus(meeting.transcriptionModel === 'gpt-4o-transcribe-diarize'
        ? 'Speaker-labeled transcript ready. Notes were skipped.'
        : 'Whisper transcript ready. Notes were skipped.');
      return;
    }

    if (regenerateNotes && meeting.notesMarkdown) {
      meeting.notesMarkdown = '';
      await deleteReductions(meeting.id);
    }

    if (!meeting.notesMarkdown) {
      meeting.status = 'generating';
      await saveMeeting(meeting);
      const cached = new Map((await listReductions(meeting.id)).map((item) => [item.index, item.text]));
      meeting.notesMarkdown = await generateNotes({
        transcript: meeting.transcript,
        formatId,
        customInstructions,
        apiKey: settings.deepseekKey,
        models: [settings.deepseekModel || DEFAULT_DEEPSEEK_MODEL],
        onProgress: (index, total) => setStatus(`Writing notes ${index + 1}/${total}...`),
        getCachedReduction: async (index) => cached.get(index) || null,
        saveReduction: async (index, text) => {
          cached.set(index, text);
          await saveReduction(meeting.id, index, text);
        }
      });
      meeting.status = 'done';
      meeting.error = null;
      await saveMeeting(meeting);
      await deleteSegments(meeting.id);
      await deleteReductions(meeting.id);
    }

    renderMeeting(meeting);
    switchView('notes');
    await renderHistory();
    setStatus('Notes ready');
  } catch (err) {
    console.error(err);
    meeting.status = 'error';
    meeting.error = String(err?.message || err);
    await saveMeeting(meeting);
    renderMeeting(meeting);
    await renderHistory();
    setStatus('Error: ' + meeting.error);
  }
}

async function onRegenerateNotes() {
  if (!currentMeeting) {
    setStatus('Open a meeting first.');
    return;
  }
  if (currentMeeting.id === activeMeetingId) {
    setStatus('Stop the recording before regenerating.');
    return;
  }
  const meeting = await getMeeting(currentMeeting.id);
  if (!meeting || !meeting.transcript) {
    setStatus('There is no transcript to regenerate notes from.');
    return;
  }
  meeting.noteFormatId = els.noteFormat.value || meeting.noteFormatId;
  meeting.customInstructions = els.customInstructions.value.trim();
  await saveMeeting(meeting);
  setStatus('Regenerating notes...');
  await processMeeting(meeting, { regenerateNotes: true });
}

async function transcribeSegmentsWithResume(meeting, settings) {
  const segments = await listSegments(meeting.id);
  if (!segments.length) throw new Error('No audio segments found for this meeting.');

  const provider = getTranscriptionProvider(settings.transcriptionProviderId);
  const model = settings.openaiTranscriptionModel || provider.defaultModel;
  const stored = await listSegmentTranscripts(meeting.id);
  const storedByIndex = new Map(stored.filter((item) => item.status === 'complete').map((item) => [item.index, item]));
  const plainParts = [];
  const timedParts = [];

  for (let position = 0; position < segments.length; position++) {
    const segment = segments[position];
    const baseSeconds = segment.startOffsetSec ?? position * 600;
    let record = storedByIndex.get(segment.index);

    if (!record) {
      setStatus(`Transcribing ${position + 1}/${segments.length}...`);
      try {
        const result = await provider.transcribe({
          blob: segment.blob,
          index: segment.index,
          baseSeconds,
          apiKey: settings.openaiApiKey,
          model
        });
        record = {
          meetingId: meeting.id,
          index: segment.index,
          providerId: result.providerId || provider.id,
          model: result.model || model,
          text: result.text || '',
          words: Array.isArray(result.segments) ? result.segments : [],
          startOffsetSec: baseSeconds,
          endOffsetSec: result.segments?.length ? result.segments[result.segments.length - 1].end : baseSeconds + (segment.durationSec || 0),
          audioBytes: result.audioBytes ?? segment.byteSize ?? segment.blob?.size ?? 0,
          attempts: 1,
          status: 'complete',
          error: null
        };
        await saveSegmentTranscript(record);
      } catch (err) {
        await saveSegmentTranscript({
          meetingId: meeting.id,
          index: segment.index,
          providerId: provider.id,
          model,
          text: '',
          words: [],
          startOffsetSec: baseSeconds,
          endOffsetSec: baseSeconds,
          audioBytes: segment.byteSize ?? segment.blob?.size ?? 0,
          attempts: 1,
          status: 'error',
          error: String(err?.message || err)
        });
        throw err;
      }
    }

    if (record.text) {
      const speakerLines = (record.words || []).filter((item) => item?.speaker && item?.text);
      plainParts.push(speakerLines.length
        ? speakerLines.map((item) => `${item.speaker}: ${item.text}`).join('\n')
        : record.text);
    }
    timedParts.push(formatTranscriptBlock(record, baseSeconds, segment.durationSec));
  }

  return { plainText: plainParts.join('\n\n'), timedText: timedParts.filter(Boolean).join('\n\n') };
}

async function primeMicrophone() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((t) => t.stop());
}

function setRecording(on) {
  els.start.disabled = on;
  els.stop.disabled = !on;
  els.dot.classList.toggle('recording', on);
  if (on) setStatus('Recording');
  else stopElapsedTimer();
}

function setStatus(text) { els.status.textContent = text; }

function switchView(view) {
  document.querySelectorAll('.tab').forEach((t) => {
    const active = t.dataset.view === view;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  els.notes.classList.toggle('hidden', view !== 'notes');
  els.transcript.classList.toggle('hidden', view !== 'transcript');
}

function setCurrentMeeting(meeting) {
  currentMeeting = meeting ? { ...meeting } : null;
}

function renderMeeting(m) {
  setCurrentMeeting(m);
  const timed = m.transcriptTimed || m.transcript || '';
  els.transcript.textContent = timed;
  if (m.notesMarkdown) {
    renderMarkdown(m.notesMarkdown);
  } else {
    els.notes.classList.add('empty');
    els.notes.textContent = 'No notes yet.';
  }
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

function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function formatTimestamp(totalSeconds) {
  const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const padded = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${padded(minutes)}:${padded(seconds)}` : `${padded(minutes)}:${padded(seconds)}`;
}

function formatTranscriptBlock(record, baseSeconds, fallbackDurationSec) {
  const words = Array.isArray(record.words) ? record.words.filter((word) => word?.text) : [];
  if (words.length) {
    return words.map((word) => `[${formatTimestamp(word.start ?? baseSeconds)}] ${word.speaker ? `${word.speaker}: ` : ''}${word.text}`).join('\n');
  }
  if (!record.text) return '';
  return `[${formatTimestamp(baseSeconds)}] ${record.text}`;
}

function formatElapsed(milliseconds) {
  return formatTimestamp(milliseconds / 1000);
}

function startElapsedTimer() {
  stopElapsedTimer();
  updateElapsed();
  elapsedTimer = setInterval(updateElapsed, 1000);
}

function updateElapsed() {
  if (!activeStartedAt) {
    els.elapsed.textContent = '00:00';
    return;
  }
  els.elapsed.textContent = formatElapsed(Date.now() - activeStartedAt);
}

function stopElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
  if (els.elapsed) els.elapsed.textContent = '00:00';
}

function updateSegmentDisplay(count) {
  activeSegmentCount = count;
  if (els.segmentCount) els.segmentCount.textContent = `${count} segment${count === 1 ? '' : 's'}`;
}

function clearActiveCapture() {
  activeMeetingId = null;
  activeStartedAt = 0;
  updateSegmentDisplay(0);
  stopElapsedTimer();
}

async function onSegmentSaved(msg) {
  if (!msg || msg.meetingId !== activeMeetingId) return;
  updateSegmentDisplay(msg.segmentCount || 0);
  setStatus(`Recording ${formatElapsed(Date.now() - activeStartedAt)} · ${msg.segmentCount || 0} saved`);
}

async function onCaptureInterrupted(msg) {
  if (msg.meetingId && msg.meetingId !== activeMeetingId) {
    const other = await getMeeting(msg.meetingId);
    if (other && other.status === 'recording') {
      other.status = 'interrupted';
      other.error = msg.error || 'Recording was interrupted.';
      await saveMeeting(other);
      renderHistory();
    }
    return;
  }

  if (activeMeetingId) {
    const meeting = await getMeeting(activeMeetingId);
    if (meeting) {
      meeting.status = 'interrupted';
      meeting.error = msg.error || 'Recording was interrupted.';
      await saveMeeting(meeting);
      setCurrentMeeting(meeting);
    }
  }

  clearActiveCapture();
  setRecording(false);
  renderHistory();
  setStatus('Recording interrupted: ' + (msg.error || 'capture stopped before Stop was pressed.'));
}

async function onCaptureFailure(error, meetingId = activeMeetingId) {
  if (meetingId) {
    const meeting = await getMeeting(meetingId);
    if (meeting && meeting.status === 'recording') {
      meeting.status = 'interrupted';
      meeting.error = error || 'Recording was interrupted.';
      await saveMeeting(meeting);
    }
  }
  clearActiveCapture();
  setRecording(false);
  renderHistory();
  setStatus('Error: ' + (error || 'Recording was interrupted.'));
}

async function reconcileInterruptedMeetings() {
  const meetings = await listMeetings();
  const incomplete = meetings.filter((meeting) => meeting.status === 'recording');
  if (!incomplete.length) return;

  for (const meeting of incomplete) {
    const live = await chrome.runtime.sendMessage({ type: MSG.GET_CAPTURE_STATUS }).catch(() => null);
    if (live?.active && live.meetingId === meeting.id) {
      activeMeetingId = meeting.id;
      activeStartedAt = live.startedAt || meeting.startedAt;
      updateSegmentDisplay(live.segmentCount || meeting.segmentCount || 0);
      setRecording(true);
      startElapsedTimer();
      setStatus('Recording');
      continue;
    }
    if (live?.active && live.meetingId && live.meetingId !== meeting.id) {
      meeting.status = 'interrupted';
      meeting.error = 'Another recording is currently using this extension.';
      await saveMeeting(meeting);
      continue;
    }

    const segments = await listSegments(meeting.id);
    if (segments.length) {
      meeting.status = 'recorded';
      meeting.segmentCount = segments.length;
      meeting.error = null;
      await saveMeeting(meeting);
      await processMeeting(meeting);
      continue;
    }

    meeting.status = 'interrupted';
    meeting.error = 'Recording was interrupted before any audio could be retained.';
    await saveMeeting(meeting);
  }
}

async function openMeeting(m) {
  const full = await getMeeting(m.id);
  if (full) {
    renderMeeting(full);
    switchView('notes');
  }
}

async function retryMeeting(id) {
  const m = await getMeeting(id);
  if (!m || (m.status !== 'done' && id === activeMeetingId)) return;
  setStatus('Retrying...');
  await processMeeting(m);
}

async function deleteCurrentMeeting(id) {
  const meeting = await getMeeting(id);
  if (!meeting) return;
  if (!confirm(`Delete “${meeting.title || 'Meeting'}” and its saved audio, transcript, and notes?`)) return;
  await deleteMeeting(id);
  if (currentMeeting?.id === id) {
    setCurrentMeeting(null);
    els.transcript.textContent = '';
    els.notes.classList.add('empty');
    els.notes.textContent = 'No notes yet.';
  }
  renderHistory();
  setStatus('Meeting deleted.');
}

async function renameMeeting(id) {
  const meeting = await getMeeting(id);
  if (!meeting) return;
  const title = prompt('Rename meeting', meeting.title || 'Meeting');
  if (title === null) return;
  const nextTitle = title.trim();
  if (!nextTitle) {
    setStatus('Meeting name cannot be empty.');
    return;
  }
  meeting.title = nextTitle;
  await saveMeeting(meeting);
  if (currentMeeting?.id === id) setCurrentMeeting(meeting);
  await renderHistory();
  setStatus('Meeting renamed.');
}

async function renderHistory() {
  const meetings = await listMeetings();
  els.history.innerHTML = '';
  if (meetings.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="meta">No meetings yet.</div>';
    els.history.appendChild(li);
    return;
  }

  for (const m of meetings) {
    const li = document.createElement('li');
    const date = new Date(m.startedAt).toLocaleString();
    const badge = m.status && m.status !== 'done' ? ` <span class="meta">[${escapeHtml(m.status)}]</span>` : '';
    const segments = m.segmentCount ? ` · ${m.segmentCount} segment${m.segmentCount === 1 ? '' : 's'}` : '';
    li.innerHTML = `<div>${escapeHtml(m.title)}${badge}</div><div class="meta">${date} · ${Math.round((m.durationSec || 0) / 60)} min${segments}</div>`;
    li.onclick = () => openMeeting(m);
    const actions = document.createElement('div');
    actions.className = 'meeting-actions';

    const rename = document.createElement('button');
    rename.textContent = 'Rename';
    rename.className = 'secondary';
    rename.onclick = (e) => { e.stopPropagation(); renameMeeting(m.id); };
    actions.appendChild(rename);

    if (m.status && m.status !== 'done' && m.id !== activeMeetingId) {
      const btn = document.createElement('button');
      const isTranscriptOnly = m.transcriptionOnly && m.status === 'transcribed';
      btn.textContent = isTranscriptOnly ? 'Generate notes' : 'Retry';
      btn.className = 'secondary';
      btn.onclick = (e) => {
        e.stopPropagation();
        if (isTranscriptOnly) {
          getMeeting(m.id).then((meeting) => meeting && processMeeting({ ...meeting, transcriptionOnly: false }));
        } else {
          retryMeeting(m.id);
        }
      };
      actions.appendChild(btn);
    }

    if (m.id !== activeMeetingId) {
      const remove = document.createElement('button');
      remove.textContent = 'Delete';
      remove.className = 'secondary danger';
      remove.onclick = (e) => { e.stopPropagation(); deleteCurrentMeeting(m.id); };
      actions.appendChild(remove);
    }

    li.appendChild(actions);
    els.history.appendChild(li);
  }
}

function sanitizeFilename(value, fallback = 'meeting') {
  const text = String(value || fallback).toLowerCase();
  const cleaned = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function downloadTextFile({ filename, contents, mimeType }) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMeetingText(kind) {
  if (!currentMeeting) {
    setStatus('Open a meeting before exporting it.');
    return;
  }
  const date = new Date(currentMeeting.startedAt || Date.now()).toISOString().slice(0, 10);
  const name = sanitizeFilename(currentMeeting.title);
  if (kind === 'transcript') {
    const transcript = currentMeeting.transcriptTimed || currentMeeting.transcript || '';
    if (!transcript) {
      setStatus('There is no transcript to export yet.');
      return;
    }
    downloadTextFile({ filename: `${name}-${date}-transcript.txt`, contents: transcript, mimeType: 'text/plain' });
    setStatus('Transcript exported.');
  } else {
    if (!currentMeeting.notesMarkdown) {
      setStatus('There are no notes to export yet.');
      return;
    }
    downloadTextFile({ filename: `${name}-${date}-notes.md`, contents: currentMeeting.notesMarkdown, mimeType: 'text/markdown' });
    setStatus('Notes exported.');
  }
}
