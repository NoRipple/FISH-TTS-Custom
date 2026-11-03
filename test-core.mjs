// Pure-logic self test. No SillyTavern, no browser, no dependencies:
//   node test-core.mjs
import assert from 'node:assert/strict';
import { normalizeVoiceConfig, resolveVoice, voiceFor, VOICE_LANGUAGES, blocks, segmentFromBlock, findVoiceByToken, matchSpeakerVoice, buildRosterSection, replaceRosterBlock, ROSTER_MARKERS } from './core.mjs';
import { normalizeLanguage, normalizeLanguages, normalizeVoiceEntry, mergeVoiceEntries, mergeSyncedLibrary, voiceLibraryRequest, voiceSearchRequest, searchVoices, fetchVoiceLibrary } from './voice-library.mjs';
import { collectGroupNames, normalizeGroups, groupEntries, addGroup, renameGroup, deleteGroup, assignGroup, setActive, toggleAll, removeEntries, groupSummary } from './voice-groups.mjs';
import { normalizeRefAudio, refAudioKey, formatBytes, pruneRefAudio, RefAudioStore, REF_AUDIO_LIMIT_BYTES } from './ref-audio.mjs';
import { voicePreview } from './preview.mjs';
import { SynthesisQueue, clampConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from './synthesis.mjs';
import { synthesizeBrowser, parseRetryAfter, MAX_RETRIES, MAX_RETRY_DELAY_MS } from './browser-audio.mjs';
import { lineText, displayText, patchTalkDom } from './inline.mjs';
import { DEFAULTS } from './core.mjs';
import { DEFAULT_GROUP_NAMES, DEFAULT_VOICE_GROUPS, defaultGroupFor } from './voice-presets.mjs';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const a = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };
const tick = (ms = 2) => new Promise(resolve => setTimeout(resolve, ms));

console.log('— core: 配置归一化 —');
t('老字符串 → {default}', () => assert.deepEqual(normalizeVoiceConfig('abc'), { default: 'abc' }));
t('空字符串 → {}', () => assert.deepEqual(normalizeVoiceConfig(''), {}));
t('undefined → {}', () => assert.deepEqual(normalizeVoiceConfig(undefined), {}));
t('按语言对象保留 zh/ja/en/default', () =>
    assert.deepEqual(normalizeVoiceConfig({ zh: 'a', ja: 'b', en: 'c', default: 'd', junk: 'x' }),
        { zh: 'a', ja: 'b', en: 'c', default: 'd' }));
t('空值被剔除', () => assert.deepEqual(normalizeVoiceConfig({ zh: 'a', ja: '  ', en: '' }), { zh: 'a' }));
t('非字符串值被忽略', () => assert.deepEqual(normalizeVoiceConfig({ zh: 123, ja: 'b' }), { ja: 'b' }));

console.log('— core: 优先级 —');
t('语言槽命中优先于 default', () => assert.equal(resolveVoice('ja', { default: 'D', ja: 'J' }), 'J'));
t('语言槽缺失回落 default', () => assert.equal(resolveVoice('ja', { default: 'D', zh: 'Z' }), 'D'));
t('前一来源缺失才用后一来源', () => assert.equal(resolveVoice('ja', { zh: 'Z' }, { ja: 'J2' }), 'J2'));
t('全空返回空串', () => assert.equal(resolveVoice('ja', {}, ''), ''));

console.log('— core: voiceFor（两级，无覆盖层）—');
const settings = { voices: { 林遥: { zh: 'CHAR-ZH', ja: 'CHAR-JA' } }, defaultVoice: { zh: 'DEF-ZH', ja: 'DEF-JA', en: 'DEF-EN' } };
t('角色绑定命中该语言', () => assert.equal(voiceFor({ speaker: '林遥', language: 'zh' }, settings), 'CHAR-ZH'));
t('角色绑定命中另一语言', () => assert.equal(voiceFor({ speaker: '林遥', language: 'ja' }, settings), 'CHAR-JA'));
t('角色未绑该语言 → 回落全局默认', () => assert.equal(voiceFor({ speaker: '林遥', language: 'en' }, settings), 'DEF-EN'));
t('未绑定角色走全局默认', () => assert.equal(voiceFor({ speaker: '路人', language: 'en' }, settings), 'DEF-EN'));
t('角色的 default 键对任意语言生效', () => assert.equal(voiceFor({ speaker: '甲', language: 'ja' }, { voices: { 甲: 'ONLY' }, defaultVoice: 'D' }), 'ONLY'));
t('角色绑定压过全局默认的 default 键', () => assert.equal(voiceFor({ speaker: '甲', language: 'en' }, { voices: { 甲: 'ONLY' }, defaultVoice: { default: 'D' } }), 'ONLY'));
t('老字符串配置仍然可用', () => assert.equal(voiceFor({ speaker: '陈锋', language: 'ja' }, { voices: { 陈锋: 'LEGACY' }, defaultVoice: '' }), 'LEGACY'));
t('orig 语言回落 default', () => assert.equal(voiceFor({ speaker: '林遥', language: 'orig' }, { voices: {}, defaultVoice: 'D' }), 'D'));
t('完全无配置返回空串（enqueue 会据此报错）', () => assert.equal(voiceFor({ speaker: '林遥', language: 'zh' }, { voices: {}, defaultVoice: '' }), ''));

console.log('— core: 第三字段音色解析 —');
t('带音色名：解析出 voice 与台词', () => {
    const [b] = blocks('<Talk-Emo>林遥|ja|早见沙织"[Trembling voice]先に教えて。"</Talk-Emo>');
    assert.equal(b.speaker, '林遥'); assert.equal(b.tag, 'ja'); assert.equal(b.voice, '早见沙织');
    assert.equal(b.text, '[Trembling voice]先に教えて。'); assert.equal(b.valid, true);
});
t('空音色名：完全兼容旧格式', () => {
    const [b] = blocks('<Talk-Emo>林遥|ja|"こんにちは"</Talk-Emo>');
    assert.equal(b.voice, ''); assert.equal(b.text, 'こんにちは'); assert.equal(b.valid, true);
});
t('音色名可含中文/空格/括号', () => {
    const [b] = blocks('<Talk-Emo>甲|zh|樱木 真乃（Shiny）"你好"</Talk-Emo>');
    assert.equal(b.voice, '樱木 真乃（Shiny）'); assert.equal(b.text, '你好'); assert.equal(b.valid, true);
});
t('正文无引号则非法', () => {
    const [b] = blocks('<Talk-Emo>甲|zh|音色名你好</Talk-Emo>');
    assert.equal(b.valid, false);
});
t('segmentFromBlock 带出 voice', () => {
    const [b] = blocks('<Talk-Emo>甲|zh|V"嗨"</Talk-Emo>');
    assert.equal(segmentFromBlock(b, {}).voice, 'V');
});

console.log('— core: 音色优先级（模型 > 手动 > 名字 > 默认）—');
const lib = [
    { id: 'id-mano', name: '樱木真乃', names: { zh: '樱木真乃', ja: '樱木真乃', alias: 'Sakuragi Mano' }, languages: ['ja'], active: true },
    { id: 'id-hiori', name: '风野灯织', names: { zh: '风野灯织', ja: '風野灯織', alias: 'Kazano Hiori' }, languages: ['ja'], active: true },
    { id: 'id-off', name: '冬优子', names: { zh: '冬优子', ja: '黛冬優子' }, languages: ['ja'], active: false },
];
const base = { voices: { 林遥: { ja: 'MANUAL' } }, defaultVoice: { ja: 'DEFAULT' }, voiceLibrary: lib, autoVoice: true, autoMulti: true };
t('1 模型音色名优先于手动绑定', () => assert.equal(voiceFor({ speaker: '林遥', language: 'ja', voice: '风野灯织' }, base), 'id-hiori'));
t('2 无模型名用手动绑定', () => assert.equal(voiceFor({ speaker: '林遥', language: 'ja', voice: '' }, base), 'MANUAL'));
t('3 无手动绑定按角色名匹配', () => assert.equal(voiceFor({ speaker: '樱木真乃', language: 'ja', voice: '' }, base), 'id-mano'));
t('3b 罗马音别名也匹配', () => assert.equal(voiceFor({ speaker: 'Sakuragi Mano', language: 'ja', voice: '' }, base), 'id-mano'));
t('4 都未命中回退默认', () => assert.equal(voiceFor({ speaker: '路人', language: 'ja', voice: '' }, base), 'DEFAULT'));
t('未激活音色不参与匹配', () => assert.equal(voiceFor({ speaker: '冬优子', language: 'ja', voice: '黛冬優子' }, base), 'DEFAULT'));
t('autoVoice=false 关闭模型名与名字匹配，仅手动', () => {
    const s = { ...base, autoVoice: false };
    assert.equal(voiceFor({ speaker: '林遥', language: 'ja', voice: '风野灯织' }, s), 'MANUAL');
    assert.equal(voiceFor({ speaker: '樱木真乃', language: 'ja', voice: '' }, s), 'DEFAULT');
});
t('autoMulti=false 全部用默认音色', () => {
    const s = { ...base, autoMulti: false };
    assert.equal(voiceFor({ speaker: '林遥', language: 'ja', voice: '风野灯织' }, s), 'DEFAULT');
});
t('findVoiceByToken 忽略大小写与标点', () => {
    assert.equal(findVoiceByToken('sakuragi-mano', lib), 'id-mano');
    assert.equal(findVoiceByToken(' 风野灯织 ', lib), 'id-hiori');
    assert.equal(findVoiceByToken('没人', lib), '');
});
t('matchSpeakerVoice 语言不匹配则跳过', () => {
    assert.equal(matchSpeakerVoice('樱木真乃', lib, 'zh'), '');
    assert.equal(matchSpeakerVoice('樱木真乃', lib, 'ja'), 'id-mano');
});

console.log('— core: 世界书名册 —');
t('只列激活且匹配语言的音色，含指南', () => {
    const section = buildRosterSection([
        { id: 'a', name: '甲', names: { zh: '甲', ja: '甲' }, languages: ['ja'], active: true, guide: '适合少女' },
        { id: 'b', name: '乙', names: { zh: '乙' }, languages: [], active: true },
        { id: 'c', name: '丙', languages: ['ja'], active: false },
        { id: 'd', name: '丁', languages: ['zh'], active: true },
    ], 'ja');
    assert.ok(section.startsWith(ROSTER_MARKERS.start));
    assert.ok(section.trim().endsWith(ROSTER_MARKERS.end));
    assert.ok(section.includes('甲') && section.includes('适合少女'));
    assert.ok(section.includes('乙'));
    assert.ok(!section.includes('丙'));
    assert.ok(!section.includes('丁'));
});
t('replaceRosterBlock 幂等替换且保留原文', () => {
    const original = '# 格式\n一些正文。';
    const s1 = replaceRosterBlock(original, buildRosterSection([], 'zh'));
    const s2 = replaceRosterBlock(s1, buildRosterSection([], 'zh'));
    assert.equal(s1, s2);
    assert.ok(s1.startsWith(original));
    assert.equal((s2.match(/FISH_VOICE_ROSTER_START/g) || []).length, 1);
});

console.log('— voice-library: 语言归一化 —');
t('ISO 短码', () => { assert.equal(normalizeLanguage('ja'), 'ja'); assert.equal(normalizeLanguage('ZH'), 'zh'); });
t('带地区后缀', () => { assert.equal(normalizeLanguage('ja-JP'), 'ja'); assert.equal(normalizeLanguage('en_US'), 'en'); });
t('英文全名', () => { assert.equal(normalizeLanguage('Japanese'), 'ja'); assert.equal(normalizeLanguage('Chinese'), 'zh'); });
t('未知语言保留首段', () => assert.equal(normalizeLanguage('de-DE'), 'de'));
t('非字符串安全', () => { assert.equal(normalizeLanguage(null), ''); assert.equal(normalizeLanguage(7), ''); });
t('数组去重', () => assert.deepEqual(normalizeLanguages(['zh', 'ZH-cn', 'ja']), ['zh', 'ja']));
t('缺失 → 空数组（UI 视为通用）', () => { assert.deepEqual(normalizeLanguages(undefined), []); assert.deepEqual(normalizeLanguages([]), []); });

console.log('— voice-library: 条目归一化 —');
t('REST 的 _id', () => assert.equal(normalizeVoiceEntry({ _id: 'v1', title: '林遥' }).id, 'v1'));
t('SDK 的 id', () => assert.equal(normalizeVoiceEntry({ id: 'v2', title: '林遥' }).id, 'v2'));
t('无 id → null', () => assert.equal(normalizeVoiceEntry({ title: 'x' }), null));
t('空标题回落为 id', () => assert.equal(normalizeVoiceEntry({ _id: 'v3', title: '  ' }).name, 'v3'));
t('language 单值也接受', () => assert.deepEqual(normalizeVoiceEntry({ _id: 'v4', language: 'ja' }).languages, ['ja']));
t('state 保留', () => assert.equal(normalizeVoiceEntry({ _id: 'v5', state: 'training' }).state, 'training'));
t('去重保留首条', () => assert.deepEqual(mergeVoiceEntries([{ id: 'a', name: '1' }, { id: 'a', name: '2' }, { id: 'b' }]).map(x => x.name), ['1', undefined]));

console.log('— voice-library: 请求构造 —');
t('默认 baseUrl 走 CorsProxy', () => assert.equal(voiceLibraryRequest(undefined), '/proxy/https://api.fish.audio/model?self=true&page_size=50&page_number=1'));
t('末尾 /v1 被剥掉', () => assert.equal(voiceLibraryRequest('https://api.fish.audio/v1'), '/proxy/https://api.fish.audio/model?self=true&page_size=50&page_number=1'));
t('带路径的 baseUrl 保留', () => assert.match(voiceLibraryRequest('https://example.com/fish/'), /^\/proxy\/https:\/\/example\.com\/fish\/model\?/));
t('http 被拒绝', () => assert.throws(() => voiceLibraryRequest('http://api.fish.audio'), /HTTPS/));
t('带查询参数被拒绝', () => assert.throws(() => voiceLibraryRequest('https://api.fish.audio/?x=1'), /查询参数/));

console.log('— browser-audio: Retry-After 解析 —');
t('秒数', () => assert.equal(parseRetryAfter('2'), 2000));
t('超过上限被截断', () => assert.equal(parseRetryAfter('999'), MAX_RETRY_DELAY_MS));
t('HTTP 日期', () => { const now = Date.parse('2026-01-01T00:00:00Z'); assert.equal(parseRetryAfter(new Date(now + 3000).toUTCString(), now), 3000); });
t('已过去的日期归零', () => { const now = Date.parse('2026-01-01T00:00:00Z'); assert.equal(parseRetryAfter(new Date(now - 5000).toUTCString(), now), 0); });
t('空值与非法值返回 null', () => { assert.equal(parseRetryAfter(null), null); assert.equal(parseRetryAfter(''), null); assert.equal(parseRetryAfter('soon'), null); });

console.log('— synthesis: 并发上限 —');
t('并发数被夹到 1..MAX', () => {
    assert.equal(clampConcurrency(0), 1);
    assert.equal(clampConcurrency(-5), 1);
    assert.equal(clampConcurrency(99), MAX_CONCURRENCY);
    assert.equal(clampConcurrency('abc'), DEFAULT_CONCURRENCY);
    assert.equal(clampConcurrency(3), 3);
    assert.equal(clampConcurrency('4'), 4);
});

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const MP3 = (() => { const bytes = new Uint8Array(64); bytes.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]); return bytes; })();
const audioResponse = (bytes = MP3, status = 200, headers = {}) => {
    let sent = false;
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => { const key = String(name).toLowerCase(); return key in headers ? headers[key] : (key === 'content-type' ? 'audio/mpeg' : null); } },
        body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })), cancel: async () => {} }) },
    };
};
const fakeStore = () => {
    const map = new Map();
    return { map, read: async id => map.get(id), write: async (input, blob, id) => { map.set(id, blob); } };
};
const ttsInput = () => ({ baseUrl: 'https://api.fish.audio', model: 's2.1-pro-free', voice: 'v1', text: '你好', language: 'zh', speaker: '林遥' });
const collectGates = () => { const gates = []; return { gates, open: async () => { await new Promise(r => gates.push(r)); } }; };

// ---------------------------------------------------------------------------
// 异步部分
// ---------------------------------------------------------------------------

console.log('— voice-library: 同步流程（假 fetcher）—');
{
    const pages = {
        1: { total: 3, has_more: true, items: [{ _id: 'a', title: '甲', languages: ['zh'] }, { _id: 'b', title: '乙', languages: ['ja'] }] },
        2: { total: 3, has_more: false, items: [{ id: 'c', title: '丙' }] },
    };
    const seen = [];
    const fetcher = async (url, opts) => {
        seen.push(url);
        assert.equal(opts.method, 'GET');
        assert.equal(opts.headers.Authorization, 'Bearer KEY');
        return jsonResponse(pages[Number(new URL(url.replace('/proxy/', '')).searchParams.get('page_number'))]);
    };
    const entries = await fetchVoiceLibrary({ baseUrl: 'https://api.fish.audio', apiKey: 'KEY', fetcher });
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map(e => e.name), ['甲', '乙', '丙']);
    assert.deepEqual(entries[2].languages, []);
    assert.equal(seen.length, 2, 'has_more=false 时应停止翻页');
    a('两页合并 + has_more 停止', () => {});

    let calls = 0;
    const single = await fetchVoiceLibrary({ apiKey: 'KEY', fetcher: async () => { calls++; return jsonResponse({ total: 1, has_more: true, items: [{ _id: 'x' }] }); } });
    assert.equal(calls, 1, 'collected 达到 total 时应停止');
    assert.equal(single.length, 1);
    a('total 达成即停止', () => {});

    let repeatCalls = 0;
    const repeat = await fetchVoiceLibrary({ apiKey: 'KEY', pageSize: 50, fetcher: async () => { repeatCalls++; return jsonResponse({ has_more: true, items: [{ _id: 'only' }] }); } });
    assert.equal(repeatCalls, 2, '重复页不产生新音色时应停止，而不是空转到 maxPages');
    assert.equal(repeat.length, 1);
    a('无新条目即停止', () => {});

    // has_more=true 必须压过「页短即结束」的猜测，否则音色库会被静默截断。
    const capped = await fetchVoiceLibrary({ apiKey: 'KEY', pageSize: 1, maxPages: 3, fetcher: async () => jsonResponse({ total: 999, has_more: true, items: [{ _id: 'p' + Math.random() }] }) });
    assert.equal(capped.length, 3, 'maxPages 上限生效');
    a('maxPages 封顶', () => {});

    await assert.rejects(fetchVoiceLibrary({ apiKey: '', fetcher }), /API Key/);
    await assert.rejects(fetchVoiceLibrary({ apiKey: 'KEY', fetcher: async () => jsonResponse({}, 401) }), /HTTP 401/);
    await assert.rejects(fetchVoiceLibrary({ apiKey: 'KEY', fetcher: async () => jsonResponse({}, 404) }), /enableCorsProxy/);
    await assert.rejects(fetchVoiceLibrary({ apiKey: 'KEY', fetcher: async () => jsonResponse({ total: 0, items: [] }) }), /没有拉取到音色/);
    a('错误分支', () => {});
}

console.log('— browser-audio: 合成与 429 重试 —');
{
    const store = fakeStore();
    let calls = 0;
    const first = await synthesizeBrowser(ttsInput(), 'K', store, undefined, () => {}, async () => { calls++; return audioResponse(); });
    assert.equal(calls, 1);
    assert.equal(first.type, 'audio/mpeg', 'MIME 应由魔数探测并保留');
    const second = await synthesizeBrowser(ttsInput(), 'K', store, undefined, () => {}, async () => { calls++; return audioResponse(); });
    assert.equal(calls, 1, '第二次应命中本地缓存');
    assert.equal(second.type, 'audio/mpeg');
    a('缓存命中不重复请求且保留 MIME', () => {});

    const statuses = [];
    const retryStore = fakeStore();
    let retryCalls = 0;
    const blob = await synthesizeBrowser(ttsInput(), 'K', retryStore, undefined, p => statuses.push(p.status), async () => {
        retryCalls++;
        return retryCalls === 1 ? audioResponse(MP3, 429, { 'retry-after': '0' }) : audioResponse();
    });
    assert.equal(retryCalls, 2, '429 应重试一次并成功');
    assert.equal(blob.type, 'audio/mpeg');
    assert.ok(statuses.includes('requesting'), '重试前应回到 requesting 状态');
    a('429 退避后重试成功', () => {});

    const exhaustedStore = fakeStore();
    let exhaustedCalls = 0;
    await assert.rejects(
        synthesizeBrowser(ttsInput(), 'K', exhaustedStore, undefined, () => {}, async () => { exhaustedCalls++; return audioResponse(MP3, 429, { 'retry-after': '0' }); }),
        /HTTP 429/);
    assert.equal(exhaustedCalls, MAX_RETRIES + 1, '总尝试次数应为 MAX_RETRIES + 1');
    a('429 重试耗尽后报错并提示调低并发', () => {});

    const authStore = fakeStore();
    let authCalls = 0;
    await assert.rejects(
        synthesizeBrowser(ttsInput(), 'K', authStore, undefined, () => {}, async () => { authCalls++; return audioResponse(MP3, 401); }),
        /HTTP 401/);
    assert.equal(authCalls, 1, '鉴权失败不应重试');
    a('非限流错误立即失败不重试', () => {});

    const abortStore = fakeStore();
    const controller = new AbortController();
    const pending = synthesizeBrowser(ttsInput(), 'K', abortStore, controller.signal, () => {}, async () => audioResponse(MP3, 429, { 'retry-after': '30' }));
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, e => e.name === 'AbortError');
    a('退避等待可被中止', () => {});

    const badStore = fakeStore();
    await assert.rejects(
        synthesizeBrowser(ttsInput(), 'K', badStore, undefined, () => {}, async () => audioResponse(new Uint8Array([1, 2, 3, 4]), 200, { 'content-type': 'text/html' })),
        /无法识别为音频/);
    a('返回非音频内容时报错', () => {});
}

console.log('— synthesis: 并发行为 —');
{
    let inFlight = 0, peak = 0, started = 0;
    const q = new SynthesisQueue({
        concurrency: 4,
        synthesize: async () => { inFlight++; started++; peak = Math.max(peak, inFlight); await tick(3); inFlight--; return { size: 10 }; },
    });
    const tasks = Array.from({ length: 24 }, (_, i) => q.submit({ i, uiKey: 'c' + i, text: 't' + i }));
    await Promise.all(tasks.map(task => task.done));
    assert.equal(peak, 4, '并发峰值应等于设定值');
    assert.equal(started, 24);
    assert.ok(tasks.every(task => task.status === 'ready'));
    q.cancel();
    a('并发峰值受限且全部完成', () => {});

    let serialPeak = 0, serialInFlight = 0;
    const serial = new SynthesisQueue({
        concurrency: 1,
        synthesize: async () => { serialInFlight++; serialPeak = Math.max(serialPeak, serialInFlight); await tick(1); serialInFlight--; return { size: 1 }; },
    });
    const serialTasks = Array.from({ length: 5 }, (_, i) => serial.submit({ i, uiKey: 's' + i, text: 't' + i }));
    await Promise.all(serialTasks.map(task => task.done));
    assert.equal(serialPeak, 1);
    serial.cancel();
    a('并发=1 时退化为串行', () => {});

    let growPeak = 0, growInFlight = 0;
    const grow = new SynthesisQueue({
        concurrency: 2,
        synthesize: async () => { growInFlight++; growPeak = Math.max(growPeak, growInFlight); await tick(4); growInFlight--; return { size: 1 }; },
    });
    const growTasks = Array.from({ length: 12 }, (_, i) => grow.submit({ i, uiKey: 'g' + i, text: 't' + i }));
    assert.equal(grow.setConcurrency(6), 6);
    await Promise.all(growTasks.map(task => task.done));
    assert.ok(growPeak > 2, '调高并发后应实际派出更多并行请求');
    assert.equal(grow.setConcurrency(99), MAX_CONCURRENCY, 'setConcurrency 也应夹取上限');
    grow.cancel();
    a('运行中调高并发立即生效', () => {});

    // 池满时新任务必须靠唤醒被拾起，否则会永久滞留。
    const gates = collectGates();
    const pooled = new SynthesisQueue({ concurrency: 2, synthesize: async () => { await gates.open(); return { size: 1 }; } });
    const pooledTasks = [0, 1, 2].map(i => pooled.submit({ i, uiKey: 'w' + i, text: 'x' + i }));
    await tick(5);
    assert.equal(pooled.activeTasks.size, 2, '池满时只应有 2 个在途');
    assert.equal(pooledTasks[2].status, 'queued', '第三个应排队');
    for (let guard = 0; guard < 60 && pooledTasks.some(task => task.status !== 'ready'); guard++) {
        while (gates.gates.length) gates.gates.shift()();
        await tick(2);
    }
    assert.ok(pooledTasks.every(task => task.status === 'ready'), '排队任务最终都应被唤醒并完成');
    pooled.cancel();
    a('池满时新任务排队，腾出名额后被唤醒', () => {});

    // 内存上限下必须仍有推进，且取走音频能唤醒被压住的调度。
    const memo = new SynthesisQueue({ concurrency: 3, maxBufferedBytes: 1000, synthesize: async () => ({ size: 600 }) });
    const memoTasks = Array.from({ length: 8 }, (_, i) => memo.submit({ i, uiKey: 'm' + i, text: 't' + i }));
    const signal = new AbortController().signal;
    const blobs = [];
    for (const task of memoTasks) blobs.push(await memo.take(task, signal));
    assert.equal(blobs.length, 8, '内存上限下不应死锁');
    assert.ok(blobs.every(blob => blob.size === 600));
    memo.cancel();
    a('内存上限下无死锁（唤醒所有等待者）', () => {});

    let failStarted = 0;
    const failing = new SynthesisQueue({
        concurrency: 3,
        synthesize: async item => { failStarted++; await tick(2); if (item.i === 0) throw new Error('boom'); return { size: 1 }; },
    });
    const failTasks = Array.from({ length: 20 }, (_, i) => failing.submit({ i, uiKey: 'f' + i, text: 't' + i }));
    await Promise.all(failTasks.map(task => task.done));
    assert.equal(failTasks.filter(task => task.status === 'failed').length, 1, '只应报告一个失败');
    assert.equal(failTasks.filter(task => task.status === 'canceled').length, 19, '其余应被取消而不是各报一次错');
    assert.ok(failStarted < 20, '失败后不应继续启动剩余任务');
    failing.cancel();
    a('失败即停，只报告一个错误', () => {});

    const cancelQ = new SynthesisQueue({ concurrency: 3, synthesize: async () => { await tick(50); return { size: 1 }; } });
    const cancelTasks = Array.from({ length: 6 }, (_, i) => cancelQ.submit({ i, uiKey: 'x' + i, text: 't' + i }));
    await tick(5);
    cancelQ.cancel();
    await Promise.all(cancelTasks.map(task => task.done));
    assert.ok(cancelTasks.every(task => task.status === 'canceled'), cancelTasks.map(task => task.status).join(','));
    a('cancel 让所有任务落定', () => {});

    let dedupeCalls = 0;
    const dedupe = new SynthesisQueue({ concurrency: 1, synthesize: async () => { dedupeCalls++; return { size: 1 }; } });
    const item = { i: 0, uiKey: 'd0', text: 'same', speaker: 'A', language: 'zh', voice: 'v', model: 'm', baseUrl: 'u' };
    const firstTask = dedupe.submit(item);
    assert.equal(dedupe.submit({ ...item }), firstTask, '同一句重复提交应复用任务');
    await firstTask.done;
    const changedTask = dedupe.submit({ ...item, text: 'different' });
    assert.notEqual(changedTask, firstTask, '台词变化应视为新任务');
    await changedTask.done;
    assert.equal(dedupeCalls, 2);
    dedupe.cancel();
    a('按内容去重（不含易变的消息全文）', () => {});
}

console.log('— preview —');
t('按语言选样本', () => {
    assert.equal(voicePreview({ voice: 'v', language: 'ja', settings: {} }).text.includes('こんにちは'), true);
    assert.equal(voicePreview({ voice: 'v', language: 'en', settings: {} }).text.startsWith('Hello'), true);
});
t('未知语言回落当前设置语言', () => assert.equal(voicePreview({ voice: 'v', language: 'orig', settings: { language: 'ja' } }).language, 'ja'));
t('无音色报错', () => assert.throws(() => voicePreview({ voice: '  ', language: 'zh', settings: {} }), /请先选择音色/));
t('preview 标记为 true 以便按钮切换文案', () => assert.equal(voicePreview({ voice: 'v', language: 'zh', settings: {} }).preview, true));

console.log('— 常量 —');
t('VOICE_LANGUAGES 为 zh/ja/en', () => assert.deepEqual([...VOICE_LANGUAGES], ['zh', 'ja', 'en']));
t('默认并发与上限', () => { assert.equal(DEFAULT_CONCURRENCY, 10); assert.equal(MAX_CONCURRENCY, 10); });

console.log('— 聊天页台词显示 —');
t('lineText 生成完整引号对', () => assert.equal(lineText({ speaker: '爱丽丝', text: '你好呀' }), '爱丽丝：「你好呀」'));
t('lineText 无角色名时省略前缀', () => assert.equal(lineText({ speaker: '  ', text: '你好呀' }), '「你好呀」'));
t('lineText 保留声音标签原样', () => assert.equal(lineText({ speaker: '鲍勃', text: '[happy] 走吧' }), '鲍勃：「[happy] 走吧」'));
t('displayText 仍把语音段替换为占位符', () => {
    const raw = '开头<Talk-Emo>爱丽丝|zh|"你好呀"</Talk-Emo>结尾';
    assert.equal(displayText(raw, 'zh', raw).includes('你好呀'), false);
});
t('showLines 默认关闭', () => assert.equal(DEFAULTS.showLines, false));
t('patchTalkDom 接受 showLines 参数', () => assert.equal(patchTalkDom.length, 3));

console.log('\n— voice-groups: 分组与批量 —');
const sampleLib = () => ([
    { id: 'a', name: '辻', group: '偶像大师·闪耀色彩', active: true },
    { id: 'b', name: '凛', group: '偶像大师·闪耀色彩', active: false },
    { id: 'c', name: '丹恒', group: '', active: true },
]);
t('组名去空白并去重', () => assert.deepEqual(normalizeGroups([' A ', 'A', '', 'B', null]), ['A', 'B']));
t('组名按首次出现排序，声明的空组在末尾', () => {
    const names = collectGroupNames([{ id: 'x', group: 'B' }, { id: 'y', group: 'A' }], ['A', '空组']);
    assert.deepEqual(names, ['A', '空组', 'B']);
});
t('分桶：未分组单独拎出来', () => {
    const { buckets, loose } = groupEntries(sampleLib(), ['偶像大师·闪耀色彩']);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].entries.length, 2);
    assert.deepEqual(loose.map(e => e.id), ['c']);
});
t('移动组：空组名即移入未分组', () => {
    const list = sampleLib();
    assert.equal(assignGroup(list, ['a', 'c'], ''), 1);
    assert.equal(list.find(e => e.id === 'a').group, '');
});
t('移动组：未变化的条目不计入改动数', () => {
    const list = sampleLib();
    assert.equal(assignGroup(list, ['a'], '偶像大师·闪耀色彩'), 0);
});
t('同一 id 的多条记录一起移动', () => {
    const list = [{ id: 'x', group: '' }, { id: 'x', group: 'old' }];
    assert.equal(assignGroup(list, ['x'], '新组'), 2);
    assert.deepEqual(list.map(e => e.group), ['新组', '新组']);
});
t('批量启用/禁用只算真正变化的条目', () => {
    const list = sampleLib();
    assert.equal(setActive(list, ['a', 'b'], true), 1);
    assert.equal(list.find(e => e.id === 'b').active, true);
    assert.equal(setActive(list, ['a', 'b'], true), 0);
});
t('组内 toggle：因有未启用成员，先全部启用', () => {
    const list = sampleLib();
    assert.equal(toggleAll(list, ['a', 'b'], 'toggle'), 1);
    assert.equal(list.filter(e => ['a', 'b'].includes(e.id)).every(e => e.active === true), true);
});
t('组内 toggle：全启用时再次点击全部禁用', () => {
    const list = sampleLib();
    assert.equal(toggleAll(list, ['a', 'b'], 'toggle'), 1);
    assert.equal(toggleAll(list, ['a', 'b'], 'toggle'), 2);
    assert.equal(list.filter(e => ['a', 'b'].includes(e.id)).every(e => e.active === false), true);
    assert.equal(list.find(e => e.id === 'c').active, true);
});
t('removeEntries 只删指定 id', () => assert.deepEqual(removeEntries(sampleLib(), ['b']).map(e => e.id), ['a', 'c']));
t('新建组拒绝空名与重名', () => {
    assert.throws(() => addGroup([], '  '), /组名不能为空/);
    assert.throws(() => addGroup(['A'], 'A'), /已存在/);
});
t('改名同时改写组列表与成员', () => {
    const list = sampleLib();
    const result = renameGroup(list, ['偶像大师·闪耀色彩'], '偶像大师·闪耀色彩', '闪彩');
    assert.deepEqual(result.groups, ['闪彩']);
    assert.equal(result.changed, 2);
    assert.equal(list.filter(e => e.group === '闪彩').length, 2);
});
t('改名为已存在的组被拒绝', () => {
    assert.throws(() => renameGroup([], ['A', 'B'], 'A', 'B'), /已存在/);
});
t('删除组把成员移到未分组而不是删掉音色', () => {
    const list = sampleLib();
    const result = deleteGroup(list, ['偶像大师·闪耀色彩'], '偶像大师·闪耀色彩');
    assert.deepEqual(result.groups, []);
    assert.equal(result.moved, 2);
    assert.equal(list.length, 3);
    assert.equal(list.every(e => !e.group), true);
});
t('汇总统计激活数', () => {
    const summary = groupSummary(sampleLib(), ['偶像大师·闪耀色彩', '空组']);
    assert.equal(summary.total, 3);
    assert.equal(summary.active, 2);
    assert.equal(summary.groups[0].active, 1);
    assert.equal(summary.groups[1].total, 0);
    assert.equal(summary.ungrouped.total, 1);
});

console.log('\n— voice-library: 搜索与同步合并 —');
t('搜索请求不带 self（否则会搜成自己的库）', () => {
    const url = voiceSearchRequest('https://api.fish.audio', { title: '星穹铁道' });
    assert.equal(url.includes('self='), false);
    assert.equal(url.includes('title=' + encodeURIComponent('星穹铁道')), true);
});
t('搜索请求带分页与语言', () => {
    const url = voiceSearchRequest('https://api.fish.audio/v1', { title: 'x', pageSize: 5, page: 2, language: 'ja' });
    assert.equal(url.includes('page_size=5'), true);
    assert.equal(url.includes('page_number=2'), true);
    assert.equal(url.includes('language=ja'), true);
    assert.equal(url.includes('/v1/model'), false);
});
t('page_size 被夹在 1–100', () => {
    assert.equal(voiceSearchRequest('https://api.fish.audio', { pageSize: 999 }).includes('page_size=100'), true);
    assert.equal(voiceSearchRequest('https://api.fish.audio', { pageSize: -3 }).includes('page_size=1'), true);
});
t('明文 http 的 Base URL 被拒绝', () => assert.throws(() => voiceSearchRequest('http://api.fish.audio'), /HTTPS/));
t('非 HTTP 协议同样被拒绝', () => assert.throws(() => voiceSearchRequest('ftp://api.fish.audio'), /HTTPS/));
t('空标题也能构造请求（拉全站第一页）', () => {
    const url = voiceSearchRequest('https://api.fish.audio', { title: '   ' });
    assert.equal(url.includes('title='), false);
});
t('搜索返回去重后的条目与总数', async () => {
    const fetcher = async () => ({ ok: true, status: 200, json: async () => ({ total: 42, items: [{ _id: 'v1', title: '甲' }, { _id: 'v1', title: '甲' }, { _id: 'v2', title: '乙' }] }) });
    const data = await searchVoices({ baseUrl: 'https://api.fish.audio', apiKey: 'k', title: 'x', fetcher });
    assert.equal(data.entries.length, 2);
    assert.equal(data.total, 42);
});
t('搜索无 Key 直接报错', async () => {
    await assert.rejects(() => searchVoices({ baseUrl: 'https://api.fish.audio', apiKey: '' }), /API Key/);
});
t('搜索 HTTP 错误转成中文提示', async () => {
    const fetcher = async () => ({ ok: false, status: 500, json: async () => null });
    await assert.rejects(() => searchVoices({ baseUrl: 'https://api.fish.audio', apiKey: 'k', fetcher }), /HTTP 500/);
});
t('同步保留分组、克隆标记与自定义名称', () => {
    const before = [{ id: 'v1', name: '我改的名字', group: 'HSR', active: false, refAudio: { transcript: 'hi', bytes: 10 }, guide: 'g' }];
    const after = mergeSyncedLibrary([{ id: 'v1', name: 'API 标题', group: '', active: true }], before);
    assert.equal(after[0].group, 'HSR');
    assert.equal(after[0].name, '我改的名字');
    assert.equal(after[0].refAudio.transcript, 'hi');
    assert.equal(after[0].guide, 'g');
});
t('同步以 API 为准更新激活状态', () => assert.equal(
    mergeSyncedLibrary([{ id: 'v1', active: true }], [{ id: 'v1', active: false }])[0].active, true));
t('同步新增的音色保持 API 原名', () => {
    const after = mergeSyncedLibrary([{ id: 'v9', name: '新音色' }], []);
    assert.equal(after[0].name, '新音色');
    assert.equal(after[0].group, '');
});
t('normalizeVoiceEntry 保留 group 与 refAudio', () => {
    const entry = normalizeVoiceEntry({ _id: 'x', title: 't', group: ' G ', refAudio: { transcript: 'a', bytes: 99 } });
    assert.equal(entry.group, 'G');
    assert.equal(entry.refAudio.bytes, 99);
});

console.log('\n— ref-audio: 参考音频元数据 —');
t('逐字稿必填', () => assert.throws(() => normalizeRefAudio({ bytes: 10, transcript: '   ' }), /逐字稿必填/));
t('超过 20MB 拒绝', () => assert.throws(() => normalizeRefAudio({ bytes: REF_AUDIO_LIMIT_BYTES + 1, transcript: 'x' }), /20 MB/));
t('空音频拒绝', () => assert.throws(() => normalizeRefAudio({ bytes: 0, transcript: 'x' }), /为空/));
t('不支持的格式拒绝', () => assert.throws(() => normalizeRefAudio({ bytes: 10, transcript: 'x', type: 'video/mp4' }), /不支持的音频格式/));
t('合法输入归一化并记时间', () => {
    const meta = normalizeRefAudio({ bytes: 2048, transcript: ' 你好 ', name: ' 甲 ', language: ' ja ', type: 'audio/wav' });
    assert.equal(meta.transcript, '你好');
    assert.equal(meta.name, '甲');
    assert.equal(meta.language, 'ja');
    assert.ok(meta.savedAt > 0);
});
t('refAudioKey 带前缀且拒绝空 id', () => {
    assert.equal(refAudioKey('abc'), 'ref:abc');
    assert.throws(() => refAudioKey('  '), /缺少音色 ID/);
});
t('字节格式化', () => {
    assert.equal(formatBytes(0), '0 KB');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
});

console.log('\n— ref-audio: IndexedDB 清理（内存桩） —');
// A minimal IndexedDB stand-in: enough for RefAudioStore's get/put/keys/count/clear.
function fakeIndexedDB() {
    const tables = new Map();
    const store = { tables };
    const request = value => { const r = { result: value }; setTimeout(() => r.onsuccess?.({ target: r }), 0); return r; };
    const tx = {
        objectStore: () => ({
            put(value, key) { tables.set(key, value); return request(undefined); },
            get(key) { return request(tables.get(key) ?? undefined); },
            getKey(key) { return request(tables.has(key) ? key : undefined); },
            delete(key) { tables.delete(key); return request(undefined); },
            clear() { tables.clear(); return request(undefined); },
            getAllKeys() { return request([...tables.keys()]); },
            count() { return request(tables.size); },
        }),
        abort() {},
    };
    store.open = () => { const r = { result: { objectStoreNames: { contains: () => true }, transaction: () => tx, close() {} } }; setTimeout(() => r.onsuccess?.(), 0); return r; };
    return store;
}
t('写入后可查、可读、可计数', async () => {
    const audio = new RefAudioStore(fakeIndexedDB());
    await audio.put('v1', { size: 100 }, { transcript: 'hi' });
    assert.equal(await audio.has('v1'), true);
    assert.equal((await audio.get('v1')).meta.transcript, 'hi');
    assert.equal(await audio.count(), 1);
    assert.deepEqual(await audio.usage().then(u => u.count), 1);
});
t('清理无主参考音频', async () => {
    const audio = new RefAudioStore(fakeIndexedDB());
    await audio.put('keep', { size: 10 }, {});
    await audio.put('orphan', { size: 20 }, {});
    const result = await pruneRefAudio(audio, [{ id: 'keep', refAudio: { transcript: 'x' } }]);
    assert.equal(result.removed, 1);
    assert.equal(await audio.has('orphan'), false);
    assert.equal(await audio.has('keep'), true);
});
t('报告元数据在但音频已丢的条目', async () => {
    const audio = new RefAudioStore(fakeIndexedDB());
    const result = await pruneRefAudio(audio, [{ id: 'ghost', refAudio: { transcript: 'x' } }]);
    assert.deepEqual(result.missing, ['ghost']);
});
t('全部清空后计数归零', async () => {
    const audio = new RefAudioStore(fakeIndexedDB());
    await audio.put('a', { size: 1 }, {});
    await audio.clear();
    assert.equal(await audio.count(), 0);
});
t('没有 IndexedDB 时给出明确错误', async () => {
    const audio = new RefAudioStore(null);
    // Constructor falls back to the global, which node does not provide.
    await assert.rejects(() => audio.count(), /IndexedDB/);
});

console.log('\n— voice-groups: 内置音色归类 —');
t('内置音色从未分组提升到指定的组', () => {
    // Mirrors fileRosterIntoGroup(): only ungrouped roster members move.
    const rosterIds = ['r1', 'r2', 'r3'];
    const list = [
        { id: 'r1', group: '' },
        { id: 'r2', group: '我自己分的组' },
        { id: 'r3' },
        { id: 'other', group: '' },
    ];
    const targets = rosterIds.filter(id => list.some(e => e.id === id && !e.group));
    assert.deepEqual(targets, ['r1', 'r3']);
    assert.equal(assignGroup(list, targets, '偶像大师·闪耀色彩'), 2);
    assert.equal(list.find(e => e.id === 'r2').group, '我自己分的组');
    assert.equal(list.find(e => e.id === 'other').group, '');
});
t('已归类的音色重复归类不再改动', () => {
    const list = [{ id: 'r1', group: '偶像大师·闪耀色彩' }];
    const targets = ['r1'].filter(id => list.some(e => e.id === id && !e.group));
    assert.deepEqual(targets, []);
    assert.equal(assignGroup(list, targets, '偶像大师·闪耀色彩'), 0);
});
t('组被删除后内置音色仍留在未分组，不会无限复活成组', () => {
    const list = [{ id: 'r1', group: '' }];
    const declared = [];
    // fileRosterIntoGroup bails out when the group is not declared any more.
    assert.equal(declared.includes('偶像大师·闪耀色彩'), false);
    assert.equal(list[0].group, '');
});


// --- 1.5.5 内置作品分组 ---
t('内置分组表覆盖全部 15 个作品组且组名不重复', () => {
    assert.equal(DEFAULT_GROUP_NAMES.length, DEFAULT_VOICE_GROUPS.length);
    assert.equal(new Set(DEFAULT_GROUP_NAMES).size, DEFAULT_GROUP_NAMES.length);
    for (const item of DEFAULT_VOICE_GROUPS) assert.ok(DEFAULT_GROUP_NAMES.includes(item.group));
});
t('每个内置音色 id 只属于一个组', () => {
    const all = DEFAULT_VOICE_GROUPS.flatMap(item => item.ids);
    assert.equal(new Set(all).size, all.length);
    assert.equal(all.length, 62);
});
t('defaultGroupFor 能按 id 找到作品，未知 id 返回空串', () => {
    assert.equal(defaultGroupFor('a1150f3d14ac46fb8ea59c7803cd8357'), '偶像大师·闪耀色彩');
    assert.equal(defaultGroupFor('f83297334ee44cdba67d1c49827fd9db'), '崩坏：星穹铁道');
    assert.equal(defaultGroupFor('nope'), '');
});
t('启动时只给仍未分组的音色归类，用户手动归组不会被覆盖', () => {
    // Mirrors filePresetGroups(): skip anything that already has a group, and skip
    // groups the user has deleted.
    const known = new Set(['偶像大师·闪耀色彩', '崩坏：星穹铁道']);
    const library = [
        { id: 'a1150f3d14ac46fb8ea59c7803cd8357', group: '' },
        { id: 'f83297334ee44cdba67d1c49827fd9db', group: '我的自定义组' },
        { id: 'ccfce7160c664853813988cea175d1ab' },
    ];
    let moved = 0;
    for (const entry of library) {
        if (!entry || entry.group) continue;
        const group = defaultGroupFor(entry.id);
        if (group && known.has(group) && assignGroup(library, [entry.id], group)) moved++;
    }
    assert.equal(moved, 2);
    assert.equal(library[0].group, '偶像大师·闪耀色彩');
    assert.equal(library[1].group, '我的自定义组');
    assert.equal(library[2].group, '偶像大师·闪耀色彩');
});
t('用户删掉的作品组不会在下次启动时复活成员', () => {
    const known = new Set(['崩坏：星穹铁道']);
    const entry = { id: 'a1150f3d14ac46fb8ea59c7803cd8357', group: '' };
    const group = defaultGroupFor(entry.id);
    if (group && known.has(group)) entry.group = group;
    assert.equal(entry.group, '');
});

console.log('\n全部通过：' + pass + ' 项');
