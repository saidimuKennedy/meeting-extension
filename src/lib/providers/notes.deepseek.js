import { fetchWithRetry } from '../net.js';
import { DEFAULT_DEEPSEEK_MODEL } from '../models.js';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const CHUNK_CHARS = 40000;

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

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

export async function generateNotes({ transcript, template, apiKey, models }) {
  if (transcript.length <= CHUNK_CHARS) {
    return chat({
      apiKey,
      models,
      messages: [
        { role: 'system', content: template.system },
        { role: 'user', content: template.user(transcript) }
      ]
    });
  }

  const chunks = chunkText(transcript, CHUNK_CHARS);
  const summaries = [];
  for (let i = 0; i < chunks.length; i++) {
    const summary = await chat({
      apiKey,
      models,
      messages: [
        {
          role: 'system',
          content: 'You are an executive assistant. Summarize the transcript chunk faithfully. Capture decisions, action items (with owners), and key points. Do not invent facts.'
        },
        { role: 'user', content: `Chunk ${i + 1} of ${chunks.length}:\n"""\n${chunks[i]}\n"""` }
      ]
    });
    summaries.push(`### Chunk ${i + 1}\n${summary}`);
  }

  return chat({
    apiKey,
    models,
    messages: [
      { role: 'system', content: template.system },
      { role: 'user', content: template.user(summaries.join('\n\n')) }
    ]
  });
}
