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
export function normalizeVoiceEntry(item) {
    if (!item || typeof item !== 'object') return null;
    const rawId = item._id ?? item.id;
    if (typeof rawId !== 'string' || !rawId.trim()) return null;
    const id = rawId.trim();
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    return {
        id,
        name: title || id,
        languages: normalizeLanguages(item.languages ?? item.language),
        state: typeof item.state === 'string' ? item.state : '',
    };
}

export function mergeVoiceEntries(entries) {
    const byId = new Map();
    for (const entry of entries) if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
    return [...byId.values()];
}

export function voiceLibraryRequest(baseUrl, { pageSize = 50, page = 1 } = {}) {
    const base = new URL(baseUrl || 'https://api.fish.audio');
    if (base.protocol !== 'https:') throw new Error('同步音色库需要 HTTPS 的 Base URL');
    if (base.username || base.password || base.search || base.hash) throw new Error('Base URL 不能包含账号或查询参数');
    base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/';
    const target = new URL(`model?self=true&page_size=${pageSize}&page_number=${page}`, base);
    return '/proxy/' + target.href;
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
