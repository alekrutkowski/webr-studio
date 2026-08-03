const DB_NAME = 'webr-studio';
const DB_VERSION = 1;
const STORES = {
  KV: 'kv',
  FILES: 'files',
  SNAPSHOTS: 'snapshots'
};

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

export class WorkspaceDB {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORES.KV)) {
        database.createObjectStore(STORES.KV, { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains(STORES.FILES)) {
        const store = database.createObjectStore(STORES.FILES, { keyPath: 'path' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!database.objectStoreNames.contains(STORES.SNAPSHOTS)) {
        const store = database.createObjectStore(STORES.SNAPSHOTS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    this.db = await requestToPromise(request);
    this.db.onversionchange = () => {
      this.db.close();
      this.db = null;
    };
    return this.db;
  }

  async get(key, fallback = null) {
    const database = await this.open();
    const transaction = database.transaction(STORES.KV, 'readonly');
    const result = await requestToPromise(transaction.objectStore(STORES.KV).get(key));
    return result ? result.value : fallback;
  }

  async set(key, value) {
    const database = await this.open();
    const transaction = database.transaction(STORES.KV, 'readwrite');
    transaction.objectStore(STORES.KV).put({ key, value, updatedAt: Date.now() });
    await transactionDone(transaction);
    return value;
  }

  async setMany(entries) {
    const database = await this.open();
    const transaction = database.transaction(STORES.KV, 'readwrite');
    const store = transaction.objectStore(STORES.KV);
    for (const [key, value] of Object.entries(entries)) store.put({ key, value, updatedAt: Date.now() });
    await transactionDone(transaction);
  }

  async delete(key) {
    const database = await this.open();
    const transaction = database.transaction(STORES.KV, 'readwrite');
    transaction.objectStore(STORES.KV).delete(key);
    await transactionDone(transaction);
  }

  async getAllKV() {
    const database = await this.open();
    const transaction = database.transaction(STORES.KV, 'readonly');
    const records = await requestToPromise(transaction.objectStore(STORES.KV).getAll());
    return Object.fromEntries(records.map(record => [record.key, record.value]));
  }

  async listFiles() {
    const database = await this.open();
    const transaction = database.transaction(STORES.FILES, 'readonly');
    const files = await requestToPromise(transaction.objectStore(STORES.FILES).getAll());
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  async getFile(path) {
    const database = await this.open();
    const transaction = database.transaction(STORES.FILES, 'readonly');
    return requestToPromise(transaction.objectStore(STORES.FILES).get(path));
  }

  async putFile(file) {
    const database = await this.open();
    const transaction = database.transaction(STORES.FILES, 'readwrite');
    const record = {
      ...file,
      createdAt: file.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    transaction.objectStore(STORES.FILES).put(record);
    await transactionDone(transaction);
    return record;
  }

  async putFiles(files) {
    const database = await this.open();
    const transaction = database.transaction(STORES.FILES, 'readwrite');
    const store = transaction.objectStore(STORES.FILES);
    const now = Date.now();
    for (const file of files) {
      store.put({ ...file, createdAt: file.createdAt || now, updatedAt: now });
    }
    await transactionDone(transaction);
  }

  async deleteFile(path) {
    const database = await this.open();
    const transaction = database.transaction(STORES.FILES, 'readwrite');
    transaction.objectStore(STORES.FILES).delete(path);
    await transactionDone(transaction);
  }

  async clearFiles() {
    const database = await this.open();
    const transaction = database.transaction(STORES.FILES, 'readwrite');
    transaction.objectStore(STORES.FILES).clear();
    await transactionDone(transaction);
  }

  async listSnapshots() {
    const database = await this.open();
    const transaction = database.transaction(STORES.SNAPSHOTS, 'readonly');
    const snapshots = await requestToPromise(transaction.objectStore(STORES.SNAPSHOTS).getAll());
    return snapshots.sort((left, right) => right.createdAt - left.createdAt);
  }

  async putSnapshot(snapshot) {
    const database = await this.open();
    const transaction = database.transaction(STORES.SNAPSHOTS, 'readwrite');
    transaction.objectStore(STORES.SNAPSHOTS).put({ ...snapshot, createdAt: snapshot.createdAt || Date.now() });
    await transactionDone(transaction);
  }

  async deleteSnapshot(id) {
    const database = await this.open();
    const transaction = database.transaction(STORES.SNAPSHOTS, 'readwrite');
    transaction.objectStore(STORES.SNAPSHOTS).delete(id);
    await transactionDone(transaction);
  }

  async clearSnapshots() {
    const database = await this.open();
    const transaction = database.transaction(STORES.SNAPSHOTS, 'readwrite');
    transaction.objectStore(STORES.SNAPSHOTS).clear();
    await transactionDone(transaction);
  }

  async clearEverything() {
    const database = await this.open();
    const transaction = database.transaction([STORES.KV, STORES.FILES, STORES.SNAPSHOTS], 'readwrite');
    transaction.objectStore(STORES.KV).clear();
    transaction.objectStore(STORES.FILES).clear();
    transaction.objectStore(STORES.SNAPSHOTS).clear();
    await transactionDone(transaction);
  }

  async estimate() {
    if (!navigator.storage?.estimate) return { usage: 0, quota: 0 };
    return navigator.storage.estimate();
  }

  async persist() {
    if (!navigator.storage?.persist) return false;
    return navigator.storage.persist();
  }
}

export const workspaceDB = new WorkspaceDB();
