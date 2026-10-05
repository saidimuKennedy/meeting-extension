import { DEFAULT_TRANSCRIPTION_PROVIDER_ID } from '../../models.js';
import { OPENAI_TRANSCRIPTION_PROVIDER } from '../transcription.openai.js';

export const TRANSCRIPTION_PROVIDERS = Object.freeze({
  [OPENAI_TRANSCRIPTION_PROVIDER.id]: OPENAI_TRANSCRIPTION_PROVIDER
});

export function listTranscriptionProviders() {
  return Object.values(TRANSCRIPTION_PROVIDERS);
}

export function getTranscriptionProvider(providerId = DEFAULT_TRANSCRIPTION_PROVIDER_ID) {
  const normalizedId = providerId || DEFAULT_TRANSCRIPTION_PROVIDER_ID;
  const provider = TRANSCRIPTION_PROVIDERS[normalizedId];
  if (!provider) {
    throw new Error(`Unsupported transcription provider: ${normalizedId}.`);
  }
  return provider;
}
