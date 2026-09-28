const DB_NAME = 'meeting-notes';
const DB_VERSION = 2;
const STORE = 'meetings';
const SEGMENTS = 'segments';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SEGMENTS)) {
        const seg = db.createObjectStore(SEGMENTS, { keyPath: 'key' });
        seg.createIndex('meetingId', 'meetingId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveMeeting(meeting) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(meeting);
    tx.oncomplete = () => resolve(meeting.id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listMeetings() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.startedAt - a.startedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function getMeeting(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteMeeting(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveSegment(meetingId, index, blob) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEGMENTS, 'readwrite');
    tx.objectStore(SEGMENTS).put({ key: `${meetingId}:${index}`, meetingId, index, blob });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listSegments(meetingId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEGMENTS, 'readonly');
    const req = tx.objectStore(SEGMENTS).index('meetingId').getAll(IDBKeyRange.only(meetingId));
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.index - b.index));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSegments(meetingId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEGMENTS, 'readwrite');
    const store = tx.objectStore(SEGMENTS);
    const req = store.index('meetingId').openKeyCursor(IDBKeyRange.only(meetingId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
