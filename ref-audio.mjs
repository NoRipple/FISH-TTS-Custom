// One-shot clone support: the reference audio bytes live in IndexedDB, the
// transcript/name/language metadata lives in the extension settings. Fish's
// one-shot mode stores nothing server-side, so every synthesised line must carry
// the reference bytes again — this module only owns storage, not transport.
const DB_NAME = 'fish-dialogue-ref-audio';
const DB_VERSION = 1;
const STORE = 'refs';

export const REF_AUDIO_LIMIT_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/webm', 'audio/mp4']);

export function refAudioKey(voiceId) {
    const id = String(voiceId ?? '').trim();
    if (!id) throw new Error('缺少音色 ID');
    return 'ref:' + id;
}

// The transcript must match the audio exactly, punctuation included; that is a
// Fish requirement, not a stylistic one, so an empty one is rejected here
// instead of failing at synthesis time.
export function normalizeRefAudio(input) {
    if (!input || typeof input !== 'object') throw new Error('参考音频配置无效');
    const transcript = typeof input.transcript === 'string' ? input.transcript.trim() : '';
    if (!transcript) throw new Error('逐字稿必填：必须与参考音频里说的一字不差（含标点）');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const language = typeof input.language === 'string' && input.language.trim() ? input.language.trim() : '';
    const bytes = Number(input.bytes);
    if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('参考音频为空');
    if (bytes > REF_AUDIO_LIMIT_BYTES) throw new Error('参考音频超过 20 MB，请换一段更短的录音');
    const type = typeof input.type === 'string' ? input.type.trim() : '';
    if (type && !ALLOWED_TYPES.has(type)) throw new Error('不支持的音频格式：' + type);
    return { name, transcript, language, bytes, type, savedAt: Number(input.savedAt) || Date.now() };
}

export function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0 KB';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    return (value / 1024 / 1024).toFixed(2) + ' MB';
}

function openDatabase(factory) {
    return new Promise((resolve, reject) => {
        const request = factory.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => db.close();
            resolve(db);
        };
        request.onerror = () => reject(new Error('参考音频库无法打开：' + (request.error?.name || '未知错误')));
    });
}

export class RefAudioStore {
    constructor(factory) {
        // Injected so node tests can drive the logic without a browser.
        this.factory = factory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    }
    open() {
        if (!this.factory) return Promise.reject(new Error('当前环境没有 IndexedDB，无法保存参考音频'));
        return this.ready ||= openDatabase(this.factory);
    }
    async run(mode, action) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            let value;
            tx.oncomplete = () => resolve(value);
            tx.onabort = () => reject(new Error('参考音频库操作失败：' + (tx.error?.name || '事务取消')));
            tx.onerror = () => {};
            try { action(tx.objectStore(STORE), next => { value = next; }); }
            catch (error) { try { tx.abort(); } catch {} reject(error); }
        });
    }
    // Stored as a Blob so synthesis can hand it straight to FormData; the
    // metadata copy is kept alongside for listing without reading the bytes.
    put(voiceId, blob, meta) {
        return this.run('readwrite', (store, done) => { store.put({ blob, meta, savedAt: Date.now() }, refAudioKey(voiceId)); done(true); });
    }
    get(voiceId) {
        return this.run('readonly', (store, done) => { store.get(refAudioKey(voiceId)).onsuccess = event => done(event.target.result || null); });
    }
    has(voiceId) {
        return this.run('readonly', (store, done) => {
            const request = store.getKey(refAudioKey(voiceId));
            request.onsuccess = () => done(Boolean(request.result));
        });
    }
    delete(voiceId) {
        return this.run('readwrite', (store, done) => { store.delete(refAudioKey(voiceId)); done(true); });
    }
    // Manual cleanup: deletes every stored reference, including orphans left by a
    // voice removed from settings while its audio stayed behind.
    clear() {
        return this.run('readwrite', (store, done) => { store.clear(); done(true); });
    }
    keys() {
        return this.run('readonly', (store, done) => { store.getAllKeys().onsuccess = event => done((event.target.result || []).map(String)); });
    }
    count() {
        return this.run('readonly', (store, done) => { store.count().onsuccess = event => done(event.target.result || 0); });
    }
    // The blob is keyed by the voice id, so renaming a cloned voice has to move
    // its audio too, or the clone silently loses its reference.
    async renameRef(fromId, toId) {
        if (!fromId || !toId || fromId === toId) return false;
        const db = await this.open();
        const fromKey = refAudioKey(fromId), toKey = refAudioKey(toId);
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const read = store.get(fromKey);
            read.onsuccess = () => {
                const record = read.result;
                if (!record) { resolve(false); return; }
                store.put({ ...record, id: toId }, toKey);
                store.delete(fromKey);
            };
            read.onerror = () => reject(read.error || new Error('读取参考音频失败'));
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error || new Error('迁移参考音频失败'));
        });
    }

    async usage() {
        const keys = await this.keys();
        let bytes = 0;
        for (const key of keys) {
            const row = await this.run('readonly', (store, done) => { store.get(key).onsuccess = event => done(event.target.result || null); });
            bytes += Number(row?.blob?.size) || 0;
        }
        return { count: keys.length, bytes };
    }
}

// Removes reference audio whose voice is no longer in the library, plus any id
// the settings still list but that has no stored bytes. Returns what was fixed.
export async function pruneRefAudio(store, library) {
    const wanted = new Set();
    for (const entry of Array.isArray(library) ? library : []) {
        if (entry && entry.refAudio && typeof entry.id === 'string') wanted.add(refAudioKey(entry.id));
    }
    const missing = [];
    for (const entry of Array.isArray(library) ? library : []) {
        if (!entry || !entry.refAudio) continue;
        if (!await store.has(entry.id)) missing.push(entry.id);
    }
    const keys = await store.keys();
    let removed = 0;
    for (const key of keys) {
        if (wanted.has(key)) continue;
        await store.delete(String(key).replace(/^ref:/, ''));
        removed++;
    }
    return { removed, missing };
}
