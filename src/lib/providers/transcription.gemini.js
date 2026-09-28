import { fetchWithRetry } from '../net.js';
import { DEFAULT_GEMINI_MODELS } from '../models.js';

const PROMPT = [
  'Transcribe this meeting audio verbatim.',
  'Label distinct speakers as Speaker 1, Speaker 2, etc. Do not guess names.',
  'Insert a timestamp [mm:ss] every ~30 seconds.',
  'Output plain text only, no commentary.'
].join(' ');

function endpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export async function transcribe({ base64, mimeType, apiKey, models = DEFAULT_GEMINI_MODELS }) {
  const chain = models?.length ? models : DEFAULT_GEMINI_MODELS;
  let lastError;

  for (const model of chain) {
    const res = await fetchWithRetry(`${endpoint(model)}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: PROMPT },
            { inlineData: { mimeType, data: base64 } }
          ]
        }],
        generationConfig: { temperature: 0 }
      })
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      lastError = new Error(`Gemini ${res.status} (${model}): ${detail}`);
      if (res.status === 404 || res.status >= 500) continue;
      throw lastError;
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  }

  throw lastError || new Error('No Gemini model available.');
}
