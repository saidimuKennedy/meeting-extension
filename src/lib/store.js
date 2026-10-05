const DB_NAME = 'meeting-notes';
const DB_VERSION = 4;
const STORE = 'meetings';
const SEGMENTS = 'segments';
const SEGMENT_TRANSCRIPTS = 'segmentTranscripts';
const CAPTURE_RUNS = 'captureRuns';
const REDUCTIONS = 'reductions';
const EXPECTED_SEGMENT_SECONDS = 10 * 60;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const transaction = req.transaction;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SEGMENTS)) {
        const seg = db.createObjectStore(SEGMENTS, { keyPath: 'key' });
        seg.createIndex('meetingId', 'meetingId', { unique: false });
      } else {
        const seg = transaction.objectStore(SEGMENTS);
        if (!seg.indexNames.contains('meetingId')) {
          seg.createIndex('meetingId', 'meetingId', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(SEGMENT_TRANSCRIPTS)) {
        const transcripts = db.createObjectStore(SEGMENT_TRANSCRIPTS, { keyPath: 'key' });
        transcripts.createIndex('meetingId', 'meetingId', { unique: false });
      }
      if (!db.objectStoreNames.contains(CAPTURE_RUNS)) {
        db.createObjectStore(CAPTURE_RUNS, { keyPath: 'meetingId' });
      }
      if (!db.objectStoreNames.contains(REDUCTIONS)) {
        const reductions = db.createObjectStore(REDUCTIONS, { keyPath: 'key' });
        reductions.createIndex('meetingId', 'meetingId', { unique: false });
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
    const tx = db.transaction([STORE, SEGMENTS, SEGMENT_TRANSCRIPTS, CAPTURE_RUNS, REDUCTIONS], 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.objectStore(CAPTURE_RUNS).delete(id);

    for (const storeName of [SEGMENTS, SEGMENT_TRANSCRIPTS, REDUCTIONS]) {
      const store = tx.objectStore(storeName);
      const request = store.index('meetingId').openKeyCursor(IDBKeyRange.only(id));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        }
      };
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveSegment(meetingId, index, blob, metadata = {}) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEGMENTS, 'readwrite');
    tx.objectStore(SEGMENTS).put({
      key: `${meetingId}:${index}`,
      meetingId,
      index,
      blob,
      byteSize: metadata.byteSize ?? blob?.size ?? 0,
      startOffsetSec: metadata.startOffsetSec ?? index * EXPECTED_SEGMENT_SECONDS,
      durationSec: metadata.durationSec ?? null,
      recordedAt: metadata.recordedAt ?? Date.now(),
      status: metadata.status || 'complete'
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listSegments(meetingId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEGMENTS, 'readonly');
    const req = tx.objectStore(SEGMENTS).index('meetingId').getAll(IDBKeyRange.only(meetingId));
    req.onsuccess = () => resolve(req.result
      .map((segment) => ({
        ...segment,
        byteSize: segment.byteSize ?? segment.blob?.size ?? 0,
        startOffsetSec: segment.startOffsetSec ?? segment.index * EXPECTED_SEGMENT_SECONDS,
        durationSec: segment.durationSec ?? null,
        status: segment.status || 'complete'
      }))
      .sort((a, b) => a.index - b.index));
    req.onerror = () => reject(req.error);
  });
}

export async function saveSegmentTranscript(record) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEGMENT_TRANSCRIPTS, 'readwrite');
    tx.objectStore(SEGMENT_TRANSCRIPTS).put({
      updatedAt: Date.now(),
      status: 'complete',
      attempts: 1,
      error: null,
      ...record,
      key: `${record.meetingId}:${record.index}`
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listSegmentTranscripts(meetingId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEGMENT_TRANSCRIPTS, 'readonly');
    const req = tx.objectStore(SEGMENT_TRANSCRIPTS).index('meetingId').getAll(IDBKeyRange.only(meetingId));
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.index - b.index));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSegmentTranscripts(meetingId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEGMENT_TRANSCRIPTS, 'readwrite');
    const store = tx.objectStore(SEGMENT_TRANSCRIPTS);
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

export async function saveCaptureRun(run) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CAPTURE_RUNS, 'readwrite');
    tx.objectStore(CAPTURE_RUNS).put({ updatedAt: Date.now(), ...run });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCaptureRun(meetingId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CAPTURE_RUNS, 'readonly');
    const req = tx.objectStore(CAPTURE_RUNS).get(meetingId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveReduction(meetingId, index, text) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REDUCTIONS, 'readwrite');
    tx.objectStore(REDUCTIONS).put({ key: `${meetingId}:${index}`, meetingId, index, text, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listReductions(meetingId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REDUCTIONS, 'readonly');
    const req = tx.objectStore(REDUCTIONS).index('meetingId').getAll(IDBKeyRange.only(meetingId));
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.index - b.index));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteReductions(meetingId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REDUCTIONS, 'readwrite');
    const store = tx.objectStore(REDUCTIONS);
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
