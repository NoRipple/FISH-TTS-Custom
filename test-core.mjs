// Pure-logic self test. No SillyTavern, no browser, no dependencies:
//   node test-core.mjs
import assert from 'node:assert/strict';
import { normalizeVoiceConfig, resolveVoice, voiceFor, VOICE_LANGUAGES } from './core.mjs';
import { normalizeLanguage, normalizeLanguages, normalizeVoiceEntry, mergeVoiceEntries, voiceLibraryRequest, fetchVoiceLibrary } from './voice-library.mjs';
import { voicePreview } from './preview.mjs';
import { SynthesisQueue, clampConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from './synthesis.mjs';
import { synthesizeBrowser, parseRetryAfter, MAX_RETRIES, MAX_RETRY_DELAY_MS } from './browser-audio.mjs';

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

console.log('\n全部通过：' + pass + ' 项');
