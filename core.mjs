export const DEFAULTS = Object.freeze({ baseUrl: 'https://api.fish.audio', model: 's2.1-pro-free', language: 'zh', book: 'Fish-Dialogue', defaultVoice: '', voices: {}, voiceLibrary: [], concurrency: 10, auto: false, fallback: false, blockEnabled: false, blockedNames: '' });
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

export function blocks(text) {
    const source = stripExcluded(text), result = [];
    for (const m of source.matchAll(/<talk-emo\s*>([\s\S]*?)<\/talk-emo\s*>/gi)) {
        const parts = /^\s*([^|<>\r\n]+)\|(orig|zh|en|ja)\|([\s\S]*)$/.exec(m[1]);
        const body = parts?.[3]?.trim() || '', values = quotes(body);
        const valid = Boolean(parts && /^(?:"(?:\\.|[^"\\])*"|“[^”]*”)$/.test(body) && values.length === 1 && !/<\/?talk-emo\b/i.test(body));
        result.push({ start:m.index, end:m.index + m[0].length, raw:m[0], speaker:parts?.[1]?.trim() || '', tag:parts?.[2] || '',
            text:valid ? values[0] : '', valid, paired:true, protocol:'talk-emo', visible:'' });
    }
    result.sort((a,b) => a.start - b.start);
    result.forEach((b,i) => { b.block = i; });
    return result;
}

export function segmentFromBlock(b, language) {
    if (b?.protocol === 'talk-emo' || b?.protocol === 'plain') return b.valid ? { speaker:b.speaker, language:b.tag, text:b.text, block:b.block, paired:b.protocol==='talk-emo', protocol:b.protocol } : null;
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
        for (const value of quotes(source)) segments.push({ speaker, language, text: value, block: segments.length, paired: false });
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

// Exactly two levels: a per-character binding, then the global default. The
// chat-page switcher edits the global default, so both entry points always
// show and write the same value.
export function voiceFor(segment, settings) {
    const row = Object.hasOwn(settings.voices, segment.speaker) ? settings.voices[segment.speaker] : null;
    return resolveVoice(segment.language, row, settings.defaultVoice);
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
