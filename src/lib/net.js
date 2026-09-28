const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt, baseDelayMs, maxDelayMs) {
  const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * capped);
}

function retryAfterMs(res) {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.min(seconds * 1000, 60000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 60000));
  return null;
}

export async function fetchWithRetry(url, options = {}, opts = {}) {
  const { retries = 4, baseDelayMs = 1000, maxDelayMs = 30000 } = opts;
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, options);
      if (!RETRY_STATUS.has(res.status) || attempt >= retries) return res;
      await sleep(retryAfterMs(res) ?? backoffDelay(attempt, baseDelayMs, maxDelayMs));
      attempt++;
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
      attempt++;
    }
  }
}
