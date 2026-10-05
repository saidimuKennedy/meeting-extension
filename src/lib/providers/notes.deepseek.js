import { fetchWithRetry } from '../net.js';
import { DEFAULT_DEEPSEEK_MODEL } from '../models.js';
import { buildNoteMessages, buildReductionMessages } from '../templates.js';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const CHUNK_CHARS = 24000;
const OVERLAP_CHARS = 800;

async function chat({ messages, apiKey, models }) {
  const chain = models?.length ? models : [DEFAULT_DEEPSEEK_MODEL];
  let lastError;

  for (const model of chain) {
    const res = await fetchWithRetry(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, temperature: 0.2, messages })
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      lastError = new Error(`DeepSeek ${res.status} (${model}): ${detail}`);
      if (res.status === 404 || res.status >= 500) continue;
      throw lastError;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  }

  throw lastError || new Error('No DeepSeek model available.');
}

function splitIntoChunks(text, size, overlap) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n\n', end);
      if (boundary > start + size * 0.5) end = boundary;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

export async function generateNotes({
  transcript,
  formatId = 'general',
  customInstructions = '',
  apiKey,
  models,
  onProgress,
  getCachedReduction,
  saveReduction
}) {
  if (transcript.length <= CHUNK_CHARS) {
    return chat({ apiKey, models, messages: buildNoteMessages({ formatId, transcript, customInstructions }) });
  }

  const chunks = splitIntoChunks(transcript, CHUNK_CHARS, OVERLAP_CHARS);
  const summaries = [];

  for (let index = 0; index < chunks.length; index++) {
    onProgress?.(index, chunks.length);
    let summary = getCachedReduction ? await getCachedReduction(index) : null;
    if (!summary) {
      summary = await chat({
        apiKey,
        models,
        messages: buildReductionMessages({ formatId, chunk: chunks[index], index, total: chunks.length, customInstructions })
      });
      if (saveReduction && summary) await saveReduction(index, summary);
    }
    if (summary) summaries.push(`### Part ${index + 1} of ${chunks.length}\n${summary}`);
  }

  return chat({
    apiKey,
    models,
    messages: buildNoteMessages({
      formatId,
      transcript: summaries.join('\n\n'),
      customInstructions
    })
  });
}
