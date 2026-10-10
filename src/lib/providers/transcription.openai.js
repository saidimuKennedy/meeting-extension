import { fetchWithRetry } from '../net.js';

export const OPENAI_TRANSCRIPTIONS_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
// gpt-transcribe is recommended for recorded speech; Whisper remains available
// for users who need timestamped segments.
export const OPENAI_TRANSCRIPTION_MODELS = ['gpt-transcribe', 'whisper-1', 'gpt-4o-transcribe-diarize'];
export const OPENAI_MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

export const OPENAI_TRANSCRIPTION_PROVIDER = {
  id: 'openai-whisper',
  label: 'OpenAI',
  defaultModel: OPENAI_TRANSCRIPTION_MODELS[0],
  models: [...OPENAI_TRANSCRIPTION_MODELS],
  maxUploadBytes: OPENAI_MAX_UPLOAD_BYTES,
  transcribe: transcribeOpenAISegment
};

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function normalizeTimestamp(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export async function transcribeOpenAISegment({
  blob,
  index = 0,
  baseSeconds = 0,
  mimeType = 'audio/webm',
  apiKey = '',
  model = OPENAI_TRANSCRIPTION_MODELS[0]
} = {}) {
  const normalizedKey = String(apiKey || '').trim();
  if (!normalizedKey) {
    throw new Error('An OpenAI API key is required before transcription can start.');
  }
  if (!(blob instanceof Blob)) {
    throw new TypeError('Transcription requires a saved audio Blob.');
  }
  if (blob.size === 0) {
    throw new Error(`Audio segment ${index + 1} is empty and cannot be transcribed.`);
  }
  if (blob.size > OPENAI_MAX_UPLOAD_BYTES) {
    throw new Error(
      `Audio segment ${index + 1} is ${formatBytes(blob.size)}; the upload limit is ${formatBytes(OPENAI_MAX_UPLOAD_BYTES)}.`
    );
  }
  if (!OPENAI_TRANSCRIPTION_MODELS.includes(model)) {
    throw new Error(`Unsupported OpenAI transcription model: ${model || '(missing)'}.`);
  }

  const form = new FormData();
  form.append('file', blob, `meeting-segment-${String(index + 1).padStart(2, '0')}.webm`);
  form.append('model', model);
  if (model === 'whisper-1') {
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
  } else if (model === 'gpt-4o-transcribe-diarize') {
    form.append('response_format', 'diarized_json');
    form.append('chunking_strategy', 'auto');
  } else {
    form.append('response_format', 'json');
  }

  const response = await fetchWithRetry(OPENAI_TRANSCRIPTIONS_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${normalizedKey}` },
    body: form
  });

  if (!response.ok) {
    const raw = (await response.text()).slice(0, 1000);
    let detail = raw;
    try {
      const payload = JSON.parse(raw);
      const code = payload?.error?.code || payload?.error?.type || '';
      const message = payload?.error?.message || '';
      if (/insufficient_quota|credit_balance_exceeded|billing_hard_limit_reached/i.test(`${code} ${message}`)) {
        throw new Error('OpenAI API quota is exhausted. Add API credits or increase the project spending limit in your OpenAI billing settings, then retry.');
      }
      detail = message || code || raw;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('OpenAI API quota')) throw error;
    }
    throw new Error(`OpenAI transcription failed (${response.status}): ${detail}`.trim());
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('OpenAI returned an unreadable transcription response.');
  }
  if (typeof payload?.text !== 'string') {
    throw new Error('OpenAI returned a transcription response without text.');
  }

  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  return {
    providerId: OPENAI_TRANSCRIPTION_PROVIDER.id,
    model,
    text: payload.text.trim(),
    segments: segments
      .map((segment, segmentNumber) => {
        const start = normalizeTimestamp(segment?.start, 0);
        const end = normalizeTimestamp(segment?.end, start);
        const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
        const speaker = typeof segment?.speaker === 'string' ? segment.speaker.trim() : '';
        return { start: baseSeconds + start, end: baseSeconds + end, text, ...(speaker ? { speaker } : {}) };
      })
      .filter((segment) => segment.text),
    audioBytes: blob.size,
    mimeType: blob.type || mimeType
  };
}
