export const DEFAULTS = Object.freeze({ baseUrl: 'https://api.fish.audio', model: 's2.1-pro-free', language: 'zh', book: 'Fish-Dialogue', defaultVoice: '', voices: {}, voiceLibrary: [], concurrency: 10, auto: false, fallback: false, blockEnabled: false, blockedNames: '', autoVoice: true, autoMulti: true, rosterImported: 0 });
export const VOICE_LANGUAGES = Object.freeze(['zh', 'ja', 'en']);
export const ENGINES = ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1', 'drama-3-preview'];

export function stripExcluded(text) {
    const mask = value => value.replace(/[^\r\n]/g, ' ');
    return String(text ?? '').replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, mask)
        .replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, mask)
        .replace(/<(script|style|pre|code|iframe|html)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, mask);
}

export function isBlocked(speaker, settings) {
    if (!settings.blockEnabled) return false;
    const names = String(settings.blockedNames || '').split(/[\n,，]/).map(x => x.trim()).filter(Boolean);
    return names.includes(String(speaker || '').trim());
}

// <Talk-Emo>speaker|lang|"text"</Talk-Emo> — the legacy form — or the extended
// form <Talk-Emo>speaker|lang|VoiceName"text"</Talk-Emo> where an optional voice
// name sits immediately before the opening quote. Still exactly two pipe
// separators, so a line without a voice parses exactly as before.
export function parseTalkEmo(inner) {
    const parts = /^\s*([^|<>\r\n]+)\|(orig|zh|en|ja)\|([\s\S]*)$/.exec(inner);
    if (!parts) return null;
    let body = parts[3].trim(), voice = '';
    const firstQuote = body.search(/["“]/);
    if (firstQuote > 0) {
        const prefix = body.slice(0, firstQuote).trim();
        // A stray pipe/tag in the prefix means it is not a voice name; keep the
        // legacy interpretation instead of silently swallowing it as a voice.
        if (!/[<>|]/.test(prefix)) { voice = prefix; body = body.slice(firstQuote); }
    }
    const values = quotes(body);
    const valid = /^(?:"(?:\\.|[^"\\])*"|“[^”]*”)$/.test(body) && values.length === 1 && !/<\/?talk-emo\b/i.test(body);
    return { speaker: parts[1].trim(), tag: parts[2], voice, text: valid ? values[0] : '', valid, body };
}

export function blocks(text) {
    const source = stripExcluded(text), result = [];
    for (const m of source.matchAll(/<talk-emo\s*>([\s\S]*?)<\/talk-emo\s*>/gi)) {
        const parsed = parseTalkEmo(m[1]);
        result.push({ start:m.index, end:m.index + m[0].length, raw:m[0], speaker:parsed?.speaker || '', tag:parsed?.tag || '',
            voice:parsed?.voice || '', text:parsed?.text || '', valid:Boolean(parsed?.valid), paired:true, protocol:'talk-emo', visible:'' });
    }
    result.sort((a,b) => a.start - b.start);
    result.forEach((b,i) => { b.block = i; });
    return result;
}

export function segmentFromBlock(b, language) {
    if (b?.protocol === 'talk-emo' || b?.protocol === 'plain') return b.valid ? { speaker:b.speaker, language:b.tag, text:b.text, voice:b.voice || '', block:b.block, paired:b.protocol==='talk-emo', protocol:b.protocol } : null;
    return null;
}

export function quotes(text) {
    const out = [];
    // A quote must close with its matching delimiter. Escaped ASCII quotes stay in the dialogue.
    const pattern = /"((?:\\.|[^"\\])*)"|“([^”]*)”/g;
    for (const m of text.matchAll(pattern)) {
        const value = (m[1] ?? m[2]).replace(/\\(["\\])/g, '$1').trim();
        if (value) out.push(value);
    }
    return out;
}

export function extract(text, { language = 'orig', speaker = '', fallback = true } = {}) {
    if (!['orig', 'zh', 'en', 'ja'].includes(language)) throw new Error('不支持的语言');
    const source = stripExcluded(text);
    const segments = [], warnings = [];
    const hasMarkers = /<\/?talk-emo\b/i.test(source);
    if (/\[\[\/?FA(?:\||\]\])/.test(source) && !hasMarkers) return {segments:[],warnings:['旧 FA 格式已停用，请使用 talk-emo 格式。']};
    if (/<\/?talk\s*>/i.test(source) && !hasMarkers) return {segments:[],warnings:['旧 talk 标签已停用，请升级世界书后生成新回复。']};
    const records = blocks(text);
    if (hasMarkers) {
        const starts = (source.match(/<talk-emo\s*>/gi) || []).length;
        if (starts !== records.length) warnings.push('存在未闭合或格式错误的 talk-emo 段，已跳过；不会退回全文提取。');
        for (const b of records) {
            if (!b.valid) {
                warnings.push('一个 talk-emo 段必须恰好包含一组完整双引号，已跳过。'); continue;
            }
            const segment = segmentFromBlock(b, language);
            if (segment) segments.push(segment);
        }
    } else if (fallback && language === 'orig') {
        for (const value of quotes(source)) segments.push({ speaker, language, text: value, voice: '', block: segments.length, paired: false });
        if (segments.length) warnings.push('普通双引号兼容模式：所有对话使用当前消息角色，无法推断其他人物。');
    }
    if (!segments.length) warnings.push('没有可播放的目标语言对话；译文必须由聊天生成模型通过世界书输出。');
    if (segments.length > 100) throw new Error('一条消息超过 100 个对话段，请拆分消息');
    if (segments.some(x => Array.from(x.text).length > 2000)) throw new Error('单句超过 2000 字符，请让世界书将长对话拆成多个段');
    return { segments, warnings };
}

// A voice binding is either a legacy plain id ("abc") or a per-language map
// ({zh,ja,en,default}). Both shapes are read here; callers never branch on it.
export function normalizeVoiceConfig(value) {
    if (!value) return {};
    if (typeof value === 'string') return value.trim() ? { default: value.trim() } : {};
    if (typeof value !== 'object') return {};
    const config = {};
    for (const key of [...VOICE_LANGUAGES, 'default']) {
        const voice = value[key];
        if (typeof voice === 'string' && voice.trim()) config[key] = voice.trim();
    }
    return config;
}

// First source that resolves for this language wins. An unset language falls
// back to that source's language-agnostic default, then to the next source.
export function resolveVoice(language, ...sources) {
    for (const source of sources) {
        const config = normalizeVoiceConfig(source);
        const voice = config[language] || config.default;
        if (voice) return voice;
    }
    return '';
}

// Comparison key for a voice/spoiler name: full-width and half-width fold
// together, whitespace and common punctuation are ignored, so "中野二乃",
// "中野 二乃" and "Nakano Nino" style labels can still be matched by the raw
// Chinese/Japanese name that appears in the roster.
function voiceKey(value) {
    return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\u3000·・_\-()（）\[\]【】「」『』"'“”‘’]/g, '');
}

export function voiceAliases(entry) {
    if (!entry || typeof entry !== 'object') return [];
    const names = entry.names || {};
    return [entry.id, entry.name, names.zh, names.ja, names.en, names.alias].filter(v => typeof v === 'string' && v.trim());
}

// Resolve a voice name written by the model (the third Talk-Emo field) against
// the library. Only active voices are eligible. Any alias (id, display name,
// zh/ja/en name, romaji) matches.
export function findVoiceByToken(token, library) {
    const key = voiceKey(token);
    if (!key) return '';
    for (const entry of library || []) {
        if (!entry || entry.active === false) continue;
        if (voiceAliases(entry).some(alias => voiceKey(alias) === key)) return entry.id;
    }
    return '';
}

// Match a Talk-Emo speaker name to a library voice by name. This is the
// "automatic selection" fallback, so a character called the same as an imported
// voice gets that voice without any manual binding.
export function matchSpeakerVoice(speaker, library, language) {
    const key = voiceKey(speaker);
    if (!key) return '';
    for (const entry of library || []) {
        if (!entry || entry.active === false) continue;
        if (language && Array.isArray(entry.languages) && entry.languages.length && !entry.languages.includes(language)) continue;
        const names = entry.names || {};
        const candidates = [entry.name, names.zh, names.ja, names.en, names.alias].filter(v => typeof v === 'string' && v.trim());
        if (candidates.some(c => voiceKey(c) === key)) return entry.id;
    }
    return '';
}

// Voice resolution precedence (highest first):
//   1. voice name written by the model in the Talk-Emo third field
//   2. a manual per-character binding in the settings panel
//   3. the speaker's name matched against the voice library
//   4. the per-language default voice
// autoVoice turns steps 1 & 3 off; autoMulti (off) collapses everything to the
// per-language default (single-voice read), which is what the "自动多人配音"
// switch controls.
export function voiceFor(segment, settings) {
    const library = Array.isArray(settings.voiceLibrary) ? settings.voiceLibrary : [];
    if (settings.autoMulti === false) return resolveVoice(segment.language, settings.defaultVoice);
    if (settings.autoVoice !== false && segment.voice) {
        const byToken = findVoiceByToken(segment.voice, library);
        if (byToken) return byToken;
    }
    const row = Object.hasOwn(settings.voices, segment.speaker) ? settings.voices[segment.speaker] : null;
    const manual = resolveVoice(segment.language, row);
    if (manual) return manual;
    if (settings.autoVoice !== false) {
        const byName = matchSpeakerVoice(segment.speaker, library, segment.language);
        if (byName) return byName;
    }
    return resolveVoice(segment.language, settings.defaultVoice);
}

export function dialogueRecords(text, settings) {
    const records=blocks(text);
    if(records.length || !settings.fallback) return records;
    return extract(text,settings).segments.map(s=>({...s,tag:s.language,valid:true,protocol:'plain'}));
}

export function selectLanguage(book, language) {
    if (!['orig', 'zh', 'en', 'ja'].includes(language)) throw new Error('不支持的语言');
    const data = structuredClone(book);
    const entries = Object.values(data?.entries || {});
    if (entries.some(e => Object.values(BOOK_LANGUAGES).includes(e.comment))) {
        for (const name of Object.values(BOOK_LANGUAGES)) {
            if (entries.filter(e => e.comment === name).length !== 1) throw new Error(`世界书缺少或重复条目：${name}`);
        }
        for (const e of entries) if (Object.values(BOOK_LANGUAGES).includes(e.comment)) e.disable = e.comment !== BOOK_LANGUAGES[language];
        return data;
    }
    for (const name of ['FA_FORMAT', 'FA_LANG_orig', 'FA_LANG_zh', 'FA_LANG_en', 'FA_LANG_ja']) {
        if (entries.filter(e => e.comment === name).length !== 1) throw new Error(`世界书缺少或重复条目：${name}`);
    }
    for (const e of entries) {
        if (e.comment === 'FA_FORMAT') e.disable = false;
        if (/^FA_LANG_(orig|zh|en|ja)$/.test(e.comment)) e.disable = e.comment !== `FA_LANG_${language}`;
    }
    return data;
}

export const BOOK_LANGUAGES = Object.freeze({ zh: 'FA_FORMAT · 中文', ja: 'FA_FORMAT · 日语', en: 'FA_FORMAT · 英语' });

export function upgradeWorldbook(old, template, language) {
    selectLanguage(template, language);
    if (!old?.entries || typeof old.entries !== 'object') throw new Error('旧世界书格式错误');
    const data = structuredClone(old);
    const managed = name => Object.values(BOOK_LANGUAGES).includes(name) || /^(FA_FORMAT|FA_LANG_(orig|zh|en|ja))$/.test(name);
    for (const [key, entry] of Object.entries(data.entries)) if (managed(entry.comment)) delete data.entries[key];
    for (const entry of Object.values(template.entries)) {
        let uid = 0;
        while (Object.hasOwn(data.entries, uid) || Object.values(data.entries).some(e => e.uid === uid)) uid++;
        data.entries[uid] = { ...structuredClone(entry), uid };
    }
    return selectLanguage(data, language);
}

export const ROSTER_MARKERS = Object.freeze({ start: '<!-- FISH_VOICE_ROSTER_START -->', end: '<!-- FISH_VOICE_ROSTER_END -->' });

export function rosterDisplayName(entry, language) {
    const names = entry?.names || {};
    const preferred = language === 'ja' ? [names.ja, entry?.name] : language === 'en' ? [names.en, names.alias, entry?.name] : [names.zh, entry?.name];
    return preferred.find(value => typeof value === 'string' && value.trim()) || entry?.name || entry?.id || '';
}

// Renders the managed roster block appended to each language worldbook entry.
// Only active voices usable in this language are listed. The model reads this to
// choose the third-field name; no per-voice request happens at render time.
export function buildRosterSection(entries, language) {
    const list = (entries || []).filter(entry => entry && entry.active !== false
        && (!Array.isArray(entry.languages) || !entry.languages.length || entry.languages.includes(language)));
    const header = language === 'en' ? '## Voice Roster (third field)' : '## 音色名册（第三字段）';
    const rule = language === 'en'
        ? 'Fill the third field with a voice name, e.g. <Talk-Emo>Name|en|VoiceName"line"</Talk-Emo>; leave it empty when none fits.'
        : `在各 <Talk-Emo> 行第三字段（语言后、左引号前）填写音色名，例：<Talk-Emo>角色|${language}|音色名"台词"</Talk-Emo>；下方无合适音色时第三字段留空。`;
    const lines = list.map(entry => {
        const display = rosterDisplayName(entry, language);
        const names = entry.names || {};
        const aliases = [names.ja, names.alias].filter(alias => alias && alias !== display);
        const aliasText = aliases.length ? '（' + aliases.join(' / ') + '）' : '';
        const guide = typeof entry.guide === 'string' && entry.guide.trim() ? '：' + entry.guide.trim() : '';
        return '- ' + display + aliasText + guide;
    });
    return [ROSTER_MARKERS.start, header, rule, ...lines, ROSTER_MARKERS.end].join('\n');
}

export function replaceRosterBlock(content, section) {
    const text = String(content ?? '');
    const start = text.indexOf(ROSTER_MARKERS.start), end = text.indexOf(ROSTER_MARKERS.end);
    if (start >= 0 && end > start) return text.slice(0, start) + section + text.slice(end + ROSTER_MARKERS.end.length);
    const separator = text && !text.endsWith('\n') ? '\n\n' : '';
    return text + separator + section + '\n';
}
