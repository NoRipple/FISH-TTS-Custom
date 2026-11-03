// Reads the account's own Fish Audio voice models through the documented
// GET /model?self=true endpoint. The API has no favourites filter: `self=true`
// covers everything you created OR saved, which is the user's curated set.
// Only public REST endpoints are used, always through SillyTavern's CorsProxy.

const LANGUAGE_ALIASES = Object.freeze({
    chinese: 'zh', mandarin: 'zh', cantonese: 'zh', 'zh-cn': 'zh', 'zh-tw': 'zh', 'zh-hans': 'zh', 'zh-hant': 'zh',
    japanese: 'ja', 'ja-jp': 'ja', nihongo: 'ja',
    english: 'en', 'en-us': 'en', 'en-gb': 'en',
});

// "ja-JP" / "Japanese" / "ja" all collapse to "ja". Unknown codes keep their
// first subtag so a voice tagged "de-DE" is still usable, just not in the
// three language slots.
export function normalizeLanguage(value) {
    if (typeof value !== 'string') return '';
    const raw = value.trim().toLowerCase();
    if (!raw) return '';
    return LANGUAGE_ALIASES[raw] || raw.split(/[-_]/)[0];
}

export function normalizeLanguages(value) {
    const list = Array.isArray(value) ? value : value == null ? [] : [value];
    const out = [];
    for (const item of list) {
        const code = normalizeLanguage(item);
        if (code && !out.includes(code)) out.push(code);
    }
    return out;
}

// A missing/empty language list means "not declared", which the UI treats as
// usable in every language slot. Filtering those out would hide most clones.
function cleanName(value) { return typeof value === 'string' ? value.trim() : ''; }

// Extra names (zh/ja/en/alias) and the human-written guide are plugin-side
// metadata, absent from the Fish API, so they are preserved if an entry already
// carries them and defaulted to empty/false otherwise.
function normalizeNames(value) {
    const source = value && typeof value === 'object' ? value : {};
    const names = {};
    for (const key of ['zh', 'ja', 'en', 'alias']) {
        const name = cleanName(source[key]);
        if (name) names[key] = name;
    }
    return names;
}

export function normalizeVoiceEntry(item) {
    if (!item || typeof item !== 'object') return null;
    const rawId = item._id ?? item.id;
    if (typeof rawId !== 'string' || !rawId.trim()) return null;
    const id = rawId.trim();
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const entry = {
        id,
        name: title || id,
        names: normalizeNames(item.names),
        languages: normalizeLanguages(item.languages ?? item.language),
        state: typeof item.state === 'string' ? item.state : '',
        guide: typeof item.guide === 'string' ? item.guide : '',
        active: item.active !== false,
        group: typeof item.group === 'string' ? item.group.trim() : '',
    };
    // Only present on entries created by one-shot cloning. A library entry with
    // refAudio has no voice id of its own to send: its bytes are resent instead.
    if (item.refAudio && typeof item.refAudio === 'object') entry.refAudio = normalizeRefMeta(item.refAudio);
    if (item.task_count !== undefined) entry.taskCount = Number(item.task_count) || 0;
    return entry;
}

function normalizeRefMeta(value) {
    const transcript = typeof value.transcript === 'string' ? value.transcript : '';
    return {
        transcript,
        bytes: Number(value.bytes) || 0,
        type: typeof value.type === 'string' ? value.type : '',
        savedAt: Number(value.savedAt) || 0,
    };
}

export function mergeVoiceEntries(entries) {
    const byId = new Map();
    for (const entry of entries) if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
    return [...byId.values()];
}

// Syncing replaces the library wholesale, so anything the API does not know about
// must be carried across or it silently disappears: the manual group, the
// one-shot clone marker, and a name the user edited away from the API title.
const PRESERVED_ON_SYNC = ['group', 'refAudio', 'active', 'guide', 'names'];

export function mergeSyncedLibrary(next, previous) {
    const before = new Map((Array.isArray(previous) ? previous : []).map(entry => [entry?.id, entry]));
    return (Array.isArray(next) ? next : []).map(entry => {
        const old = before.get(entry?.id);
        if (!old) return entry && entry.group === undefined ? { ...entry, group: '' } : entry;
        const merged = { ...entry };
        for (const key of PRESERVED_ON_SYNC) {
            // A sync response carries no grouping/clone data at all, so a local
            // value wins whenever the incoming one is empty or missing. `active`
            // is the exception: the API is authoritative for it, while a local
            // `false` only means the user muted the voice inside the extension.
            const incoming = merged[key];
            if (key === 'active') {
                if (incoming === undefined && old[key] !== undefined) merged[key] = old[key];
                continue;
            }
            const empty = incoming === undefined || incoming === '' || (Array.isArray(incoming) && incoming.length === 0);
            if (old[key] !== undefined && old[key] !== '' && empty) merged[key] = old[key];
        }
        if (typeof old.name === 'string' && old.name.trim() && old.name !== old.id) merged.name = old.name;
        return merged;
    });
}

export function voiceLibraryRequest(baseUrl, { pageSize = 50, page = 1 } = {}) {
    const base = new URL(baseUrl || 'https://api.fish.audio');
    if (base.protocol !== 'https:') throw new Error('同步音色库需要 HTTPS 的 Base URL');
    if (base.username || base.password || base.search || base.hash) throw new Error('Base URL 不能包含账号或查询参数');
    base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/';
    const target = new URL(`model?self=true&page_size=${pageSize}&page_number=${page}`, base);
    return '/proxy/' + target.href;
}

// Public search: same GET /model endpoint WITHOUT self=true, which is what makes
// it the whole public catalogue instead of the account's own voices. Only page
// one is fetched per query: results are sorted by usage, so deeper pages rarely
// beat what the user can reach by refining the keyword.
export function voiceSearchRequest(baseUrl, { title = '', pageSize = 20, page = 1, language = '', sortBy = '' } = {}) {
    const base = new URL(baseUrl || 'https://api.fish.audio');
    if (base.protocol !== 'https:') throw new Error('搜索需要 HTTPS 的 Base URL');
    if (base.username || base.password || base.search || base.hash) throw new Error('Base URL 不能包含账号或查询参数');
    base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/';
    const target = new URL('model', base);
    const query = String(title ?? '').trim();
    if (query) target.searchParams.set('title', query);
    target.searchParams.set('page_size', String(Math.min(100, Math.max(1, Number(pageSize) || 20))));
    target.searchParams.set('page_number', String(Math.max(1, Number(page) || 1)));
    if (language) target.searchParams.set('language', String(language));
    if (sortBy) target.searchParams.set('sort_by', String(sortBy));
    return '/proxy/' + target.href;
}

export async function searchVoices({ baseUrl, apiKey, title, pageSize = 20, page = 1, language = '', sortBy = '', signal, fetcher = fetch } = {}) {
    if (!apiKey?.trim() || /[\r\n]/.test(apiKey)) throw new Error('请先填写有效的 API Key，再搜索音色');
    const response = await fetcher(voiceSearchRequest(baseUrl, { title, pageSize, page, language, sortBy }), {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + apiKey.trim() },
        redirect: 'error',
        signal,
    });
    if (response.status === 404) throw new Error('HTTP 404：请启用 enableCorsProxy: true 并重启酒馆；自定义 Base URL 需支持 /model 接口');
    if (!response.ok) throw new Error(`音色搜索失败：HTTP ${response.status}；请检查 API Key 和额度`);
    const data = await response.json().catch(() => null);
    const items = Array.isArray(data?.items) ? data.items : [];
    const entries = [];
    const seen = new Set();
    for (const item of items) {
        const entry = normalizeVoiceEntry(item);
        if (entry && !seen.has(entry.id)) { seen.add(entry.id); entries.push(entry); }
    }
    return { total: Number(data?.total) || entries.length, entries };
}

export async function fetchVoiceLibrary({ baseUrl, apiKey, signal, pageSize = 50, maxPages = 20, fetcher = fetch } = {}) {
    if (!apiKey?.trim() || /[\r\n]/.test(apiKey)) throw new Error('请先填写有效的 API Key，再同步音色库');
    const collected = [], seen = new Set();
    for (let page = 1; page <= maxPages; page++) {
        const response = await fetcher(voiceLibraryRequest(baseUrl, { pageSize, page }), {
            method: 'GET',
            headers: { Authorization: 'Bearer ' + apiKey.trim() },
            redirect: 'error',
            signal,
        });
        if (response.status === 404) throw new Error('HTTP 404：请启用 enableCorsProxy: true 并重启酒馆；自定义 Base URL 需支持 /model 接口');
        if (!response.ok) throw new Error(`音色库同步失败：HTTP ${response.status}；请检查 API Key 和额度`);
        const data = await response.json().catch(() => null);
        const items = Array.isArray(data?.items) ? data.items : [];
        if (!items.length) break;
        const before = seen.size;
        for (const item of items) {
            const entry = normalizeVoiceEntry(item);
            if (entry && !seen.has(entry.id)) { seen.add(entry.id); collected.push(entry); }
        }
        const total = Number(data?.total);
        // Explicit server signals outrank the short-page guess: a page may be
        // shorter than pageSize while more pages still exist, and trusting the
        // guess there would silently truncate the library.
        if (data?.has_more === false) break;
        if (Number.isFinite(total) && collected.length >= total) break;
        // No new voices means further pages cannot add anything; stop instead of
        // walking to maxPages against a server that always claims has_more.
        if (seen.size === before) break;
        if (data?.has_more !== true && items.length < pageSize) break;
    }
    if (!collected.length) throw new Error('没有拉取到音色；请确认 Fish 账号里已收藏或创建音色');
    return collected;
}
