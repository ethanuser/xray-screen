// Sounds the user picks on this device (Sounds panel), kept in the browser's IndexedDB. They never
// leave the device, so copyrighted songs can be used without being published with the site.
const DB = 'xray-sounds', STORE = 'files';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Sound storage unavailable', err);
    return undefined;
  }
}

// { blob, name } or undefined.
export const getSound = (key) => run('readonly', (s) => s.get(key));
export const putSound = (key, blob, name) => run('readwrite', (s) => s.put({ blob, name }, key));
export const deleteSound = (key) => run('readwrite', (s) => s.delete(key));
export const listSounds = () => run('readonly', (s) => s.getAllKeys());

// Key for a pose or move's own sound.
export const poseKey = (name) => `pose:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
