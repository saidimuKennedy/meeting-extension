const KEY = 'settings';

export async function getSettings() {
  const { [KEY]: settings = {} } = await chrome.storage.local.get(KEY);
  return settings;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
