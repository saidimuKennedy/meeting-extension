import { MSG } from '../lib/messages.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { templates } from '../lib/templates.js';
import { DEFAULT_GEMINI_MODELS, DEFAULT_DEEPSEEK_MODEL } from '../lib/models.js';
import { transcribe } from '../lib/providers/transcription.gemini.js';
import { generateNotes } from '../lib/providers/notes.deepseek.js';
import { saveMeeting, listMeetings, getMeeting, listSegments, deleteSegments } from '../lib/store.js';

const $ = (id) => document.getElementById(id);
const els = {
  dot: $('status-dot'),
  status: $('status-text'),
  start: $('start'),
  stop: $('stop'),
  settingsToggle: $('settings-toggle'),
  settings: $('settings'),
  geminiKey: $('gemini-key'),
  deepseekKey: $('deepseek-key'),
  template: $('template'),
  geminiModels: $('gemini-models'),
  deepseekModel: $('deepseek-model'),
  saveSettings: $('save-settings'),
  notes: $('notes'),
  transcript: $('transcript'),
  history: $('history-list')
};

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
  els.geminiModels.value = (settings.geminiModels?.length ? settings.geminiModels : DEFAULT_GEMINI_MODELS).join(', ');
  els.deepseekModel.value = settings.deepseekModel || DEFAULT_DEEPSEEK_MODEL;

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
    if (msg.type === MSG.CAPTURE_ERROR) {
      setRecording(false);
      setStatus('Error: ' + msg.error);
    }
  });
}

async function onSaveSettings() {
  const geminiModels = els.geminiModels.value.split(',').map((s) => s.trim()).filter(Boolean);
  await saveSettings({
    geminiKey: els.geminiKey.value.trim(),
    deepseekKey: els.deepseekKey.value.trim(),
    templateId: els.template.value,
    geminiModels: geminiModels.length ? geminiModels : DEFAULT_GEMINI_MODELS,
    deepseekModel: els.deepseekModel.value.trim() || DEFAULT_DEEPSEEK_MODEL
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

  const meetingId = crypto.randomUUID();
  await saveMeeting({
    id: meetingId,
    title: 'Meeting',
    source: 'tab',
    startedAt: Date.now(),
    durationSec: 0,
    participants: [],
    transcript: '',
    templateId: settings.templateId || templates[0].id,
    notesMarkdown: '',
    status: 'recording',
    error: null
  });
  renderHistory();

  setStatus('Starting...');
  const res = await chrome.runtime.sendMessage({ type: MSG.START_CAPTURE, meetingId });
  if (!res?.ok) {
    const m = await getMeeting(meetingId);
    if (m) { m.status = 'error'; m.error = res?.error || 'Failed to start'; await saveMeeting(m); }
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

async function onRecordingDone({ meetingId, durationSec }) {
  setRecording(false);
  const existing = await getMeeting(meetingId);
  const settings = await getSettings();
  const meeting = existing || {
    id: meetingId,
    title: 'Meeting',
    source: 'tab',
    startedAt: Date.now() - durationSec * 1000,
    participants: [],
    transcript: '',
    templateId: settings.templateId || templates[0].id,
    notesMarkdown: ''
  };

  meeting.durationSec = durationSec;
  meeting.status = 'recorded';
  meeting.error = null;
  await saveMeeting(meeting);

  await processMeeting(meeting);
}

async function processMeeting(meeting) {
  const settings = await getSettings();
  const template = templates.find((t) => t.id === meeting.templateId) || templates[0];

  try {
    if (!meeting.transcript) {
      meeting.status = 'transcribing';
      await saveMeeting(meeting);
      meeting.transcript = await transcribeSegments(meeting.id, settings);
      meeting.status = 'transcribed';
      await saveMeeting(meeting);
    }

    if (!meeting.notesMarkdown) {
      meeting.status = 'generating';
      await saveMeeting(meeting);
      meeting.notesMarkdown = await generateNotes({
        transcript: meeting.transcript,
        template,
        apiKey: settings.deepseekKey,
        models: [settings.deepseekModel || DEFAULT_DEEPSEEK_MODEL]
      });
      meeting.status = 'done';
      meeting.error = null;
      await saveMeeting(meeting);
      await deleteSegments(meeting.id);
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

async function transcribeSegments(meetingId, settings) {
  const segments = await listSegments(meetingId);
  if (!segments.length) throw new Error('No audio segments found for this meeting.');

  const models = settings.geminiModels?.length ? settings.geminiModels : DEFAULT_GEMINI_MODELS;
  const parts = [];
  for (let i = 0; i < segments.length; i++) {
    setStatus(`Transcribing ${i + 1}/${segments.length}...`);
    const base64 = await blobToBase64(segments[i].blob);
    const text = await transcribe({ base64, mimeType: 'audio/webm', apiKey: settings.geminiKey, models });
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
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
}

function setStatus(text) { els.status.textContent = text; }

function switchView(view) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  els.notes.classList.toggle('hidden', view !== 'notes');
  els.transcript.classList.toggle('hidden', view !== 'transcript');
}

function renderMeeting(m) {
  els.transcript.textContent = m.transcript || '';
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

async function openMeeting(m) {
  const full = await getMeeting(m.id);
  if (full) {
    renderMeeting(full);
    switchView('notes');
  }
}

async function retryMeeting(id) {
  const m = await getMeeting(id);
  if (!m) return;
  setStatus('Retrying...');
  await processMeeting(m);
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
    li.innerHTML = `<div>${escapeHtml(m.title)}${badge}</div><div class="meta">${date} · ${Math.round((m.durationSec || 0) / 60)} min</div>`;
    li.onclick = () => openMeeting(m);

    if (m.status && m.status !== 'done') {
      const btn = document.createElement('button');
      btn.textContent = 'Retry';
      btn.className = 'secondary';
      btn.style.marginTop = '4px';
      btn.onclick = (e) => { e.stopPropagation(); retryMeeting(m.id); };
      li.appendChild(btn);
    }

    els.history.appendChild(li);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
