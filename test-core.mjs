// Pure-logic self test. No SillyTavern, no browser, no dependencies:
//   node test-core.mjs
import assert from 'node:assert/strict';
import { normalizeVoiceConfig, resolveVoice, voiceFor, VOICE_LANGUAGES } from './core.mjs';
import { normalizeLanguage, normalizeLanguages, normalizeVoiceEntry, mergeVoiceEntries, voiceLibraryRequest, fetchVoiceLibrary } from './voice-library.mjs';
import { voicePreview } from './preview.mjs';

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('  ok  ' + name); };

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

console.log('— core: voiceFor —');
const settings = { voices: { 林遥: { zh: 'CHAR-ZH', ja: 'CHAR-JA' } }, defaultVoice: { zh: 'DEF-ZH', ja: 'DEF-JA', en: 'DEF-EN' } };
t('聊天覆盖 > 角色绑定', () => assert.equal(voiceFor({ speaker: '林遥', language: 'zh' }, settings, { zh: 'CHAT-ZH' }), 'CHAT-ZH'));
t('聊天未设该语言 → 回落角色绑定', () => assert.equal(voiceFor({ speaker: '林遥', language: 'ja' }, settings, { zh: 'CHAT-ZH' }), 'CHAR-JA'));
t('角色未绑该语言 → 回落全局默认', () => assert.equal(voiceFor({ speaker: '林遥', language: 'en' }, settings, {}), 'DEF-EN'));
t('未绑定角色走全局默认', () => assert.equal(voiceFor({ speaker: '路人', language: 'en' }, settings, {}), 'DEF-EN'));
t('聊天 default 覆盖任意语言', () => assert.equal(voiceFor({ speaker: '林遥', language: 'ja' }, settings, { default: 'ALL' }), 'ALL'));
t('老字符串配置仍然可用', () => assert.equal(voiceFor({ speaker: '陈锋', language: 'ja' }, { voices: { 陈锋: 'LEGACY' }, defaultVoice: '' }, {}), 'LEGACY'));
t('orig 语言回落 default', () => assert.equal(voiceFor({ speaker: '林遥', language: 'orig' }, { voices: {}, defaultVoice: 'D' }, {}), 'D'));
t('完全无配置返回空串（enqueue 会据此报错）', () => assert.equal(voiceFor({ speaker: '林遥', language: 'zh' }, { voices: {}, defaultVoice: '' }, {}), ''));

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

console.log('— voice-library: 同步流程（假 fetcher）—');
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const run = async () => {
    const pages = {
        1: { total: 3, has_more: true, items: [{ _id: 'a', title: '甲', languages: ['zh'] }, { _id: 'b', title: '乙', languages: ['ja'] }] },
        2: { total: 3, has_more: false, items: [{ id: 'c', title: '丙' }] },
    };
    const seen = [];
    const fetcher = async (url, opts) => {
        seen.push(url);
        assert.equal(opts.method, 'GET');
        assert.equal(opts.headers.Authorization, 'Bearer KEY');
        const page = Number(new URL(url.replace('/proxy/', '')).searchParams.get('page_number'));
        return jsonResponse(pages[page]);
    };
    const entries = await fetchVoiceLibrary({ baseUrl: 'https://api.fish.audio', apiKey: 'KEY', fetcher });
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map(e => e.name), ['甲', '乙', '丙']);
    assert.deepEqual(entries[2].languages, []);
    assert.equal(seen.length, 2, '应在 has_more=false 时停止翻页');
    console.log('  ok  两页合并 + has_more 停止');

    let calls = 0;
    const single = await fetchVoiceLibrary({ apiKey: 'KEY', fetcher: async () => { calls++; return jsonResponse({ total: 1, has_more: true, items: [{ _id: 'x' }] }); } });
    assert.equal(calls, 1, 'collected 已达 total 时应停止');
    assert.equal(single.length, 1);
    console.log('  ok  total 达成即停止');

    let shortPageCalls = 0;
    const shortPage = await fetchVoiceLibrary({ apiKey: 'KEY', pageSize: 50, fetcher: async () => { shortPageCalls++; return jsonResponse({ has_more: true, items: [{ _id: 'only' }] }); } });
    assert.equal(shortPageCalls, 2, '重复页不产生新音色时应停止，而不是空转到 maxPages');
    assert.equal(shortPage.length, 1);
    console.log('  ok  无新条目即停止');

    // has_more=true 必须压过「页短即结束」的猜测，否则音色库会被静默截断。
    const capped = await fetchVoiceLibrary({ apiKey: 'KEY', pageSize: 1, maxPages: 3, fetcher: async () => jsonResponse({ total: 999, has_more: true, items: [{ _id: 'p' + Math.random() }] }) });
    assert.equal(capped.length, 3, 'maxPages 上限生效');
    console.log('  ok  maxPages 封顶');

    await assert.rejects(fetchVoiceLibrary({ apiKey: '', fetcher }), /API Key/);
    await assert.rejects(fetchVoiceLibrary({ apiKey: 'KEY', fetcher: async () => jsonResponse({}, 401) }), /HTTP 401/);
    await assert.rejects(fetchVoiceLibrary({ apiKey: 'KEY', fetcher: async () => jsonResponse({}, 404) }), /enableCorsProxy/);
    await assert.rejects(fetchVoiceLibrary({ apiKey: 'KEY', fetcher: async () => jsonResponse({ total: 0, items: [] }) }), /没有拉取到音色/);
    console.log('  ok  错误分支');
};
await run();

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

console.log('\n全部通过：' + pass + ' 项');
