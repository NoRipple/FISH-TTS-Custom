import { BrowserAudioStore, synthesizeBrowser } from './browser-audio.mjs';
import { DEFAULTS, VOICE_LANGUAGES, extract, voiceFor, resolveVoice, normalizeVoiceConfig, selectLanguage, upgradeWorldbook, blocks, dialogueRecords, segmentFromBlock, buildRosterSection, replaceRosterBlock, BOOK_LANGUAGES } from './core.mjs';
import { SpeechQueue } from './player.mjs';
import { SynthesisQueue } from './synthesis.mjs';
import { installInline } from './inline.mjs';
import { installPromptRegex } from './prompt-regex.mjs';
import { voicePreview } from './preview.mjs';
import { fetchVoiceLibrary, searchVoices, mergeSyncedLibrary, normalizeVoiceEntry } from './voice-library.mjs';
import { RefAudioStore, normalizeRefAudio, formatBytes, pruneRefAudio } from './ref-audio.mjs';
import { installVoicePanel } from './voice-panel.mjs';
import { installDock } from './quick-dock.mjs';
import { assignGroup } from './voice-groups.mjs';
import { DEFAULT_GROUP_NAMES, defaultGroupFor } from './voice-presets.mjs';
import { transcribeAudio, describeVoice, audioFormat } from './ai-voice.mjs';

const ctx = () => SillyTavern.getContext();
const KEY = 'fish_dialogue_v1';
const settings = ctx().extensionSettings[KEY] = { ...structuredClone(DEFAULTS), ...ctx().extensionSettings[KEY] };
if (settings.schemaVersion !== 120) {
    settings.fallback = false;
    settings.autoVoice = settings.autoVoice !== false;
    settings.autoMulti = settings.autoMulti !== false;
    settings.schemaVersion = 120;
    ctx().saveSettingsDebounced();
}
settings.browserLibraryId ||= crypto.randomUUID();
ctx().saveSettingsDebounced();
const browserStore = new BrowserAudioStore(settings.browserLibraryId);
const refStore = new RefAudioStore();
let apiKey = settings.savedApiKey || ''; // Saved only on explicit user action.
const audio = new Audio(); audio.preload = 'auto';
const logs = [], seen = new Map();
let worldModule;
let inline, libraryEntries = [];
// Rendered on demand: the form binds by id at module load, and every lookup has
// to find its control then, so it cannot wait for a caller to build it.
export function renderSettingsMarkup(host) {
    if (!host.innerHTML.trim()) host.innerHTML = SETTINGS_MARKUP;
    return host;
}

export const SETTINGS_MARKUP = `
<div class="fa-statusbar" role="status" aria-live="polite"><span class="fa-chip fa-chip-ver">v1.7.0</span><span class="fa-chip" id="fa-status">就绪</span><span class="fa-chip" id="fa-chip-active" title="已激活、会写入名册的音色数量">音色 —</span><span class="fa-chip" id="fa-chip-default" title="按语言的默认音色填充情况">默认音色 —</span></div>
<details open class="fa-sec"><summary><i class="fa-solid fa-bolt"></i><span>快速开始</span></summary>
<label class="checkbox_label"><input id="fa-auto" type="checkbox"> 新回复自动配音</label>
<small class="fa-hint">按顺序生成对白并保存到本地，不自动播放。</small>
<div class="fa-row"><button id="fa-latest">聊天序号音频生成</button></div>
<label>聊天文本序号（留空为最新回复）<input id="fa-message" type="number" min="0" class="text_pole"></label>
<div class="fa-sub"><div class="fa-subhead">默认音色（按语言）</div>
<div class="fa-row"><button id="fa-preview-default" type="button">试听默认音色</button></div>
<small class="fa-hint">聊天页输入框上方的音色选择器已移除，默认音色只在这里设置。</small>
<div id="fa-default"></div></div>
<div class="fa-sub"><div class="fa-subhead">聊天页显示</div>
<label class="checkbox_label"><input id="fa-show-lines" type="checkbox"> 在前端显示台词</label>
<small class="fa-hint">开启后，语音段在聊天页按“角色名：「台词」”显示，并带同行的播放按钮；关闭时只显示按钮和序号。仅影响显示，不改动聊天原文。</small></div>
<div class="fa-sub"><div class="fa-subhead">自动匹配策略</div>
<label class="checkbox_label"><input id="fa-auto-voice" type="checkbox"> 自动选择音色</label>
<small class="fa-hint">未手动绑定的角色，优先用模型第三字段的音色名，其次按角色名匹配音色库。</small>
<label class="checkbox_label"><input id="fa-auto-multi" type="checkbox"> 自动多人配音</label>
<small class="fa-hint">开启后逐句按各角色音色合成；关闭则所有句子都用当前语言的默认音色。</small></div>
</details>
<details class="fa-sec"><summary><i class="fa-solid fa-microphone-lines"></i><span>音色与角色绑定</span><span class="fa-badge" id="fa-badge-voices"></span></summary>
<div class="fa-row"><small id="fa-voicecount">未同步</small></div>
<div class="fa-row"><button id="fa-library-sync">从 Fish 同步</button><button id="fa-import-roster">导入内置音色（28）</button></div>
<small class="fa-hint">分组、批量启停、修改音色 ID、搜索 Fish 公开音色、一次性克隆都在音色管理弹窗里。也可以从顶栏的魔法棒菜单打开。</small>
<div class="fa-sub"><div class="fa-subhead">角色绑定</div>
<div id="fa-voices"></div>
<div class="fa-row"><button id="fa-add">添加角色</button><button id="fa-save-voices">保存角色绑定</button></div>
<small class="fa-hint">角色名须与世界书输出完全一致；某语言留空即使用默认音色。</small>
</div>
</details>
<details class="fa-sec"><summary><i class="fa-solid fa-book"></i><span>世界书与语言</span></summary>
<label>输出语言<select id="fa-language"><option value="orig">原文（关闭配音世界书）</option><option value="zh">中文</option><option value="en">英语</option><option value="ja">日语</option></select></label>
<small class="fa-hint">语言选择在“应用”成功后生效；只改变下一次聊天生成的提示词，旧消息不会自动翻译。</small>
<div class="fa-row"><button id="fa-apply-language">应用语言</button><button id="fa-add-regex">添加正则</button></div>
<label>专用世界书名称<input id="fa-book" class="text_pole"></label>
<div class="fa-row"><button id="fa-install-book">安装 / 挂载世界书</button><button id="fa-upgrade-book" class="fa-btn-danger">升级世界书</button></div>
<div class="fa-row"><button id="fa-sync-roster">同步音色名册到世界书</button></div>
<small class="fa-hint">名册按中日英分别写入世界书三条语言条目，只含“已激活”的音色；取消激活后再次同步即从世界书移除。挂载为全局世界书，语言条目为该账户所有聊天共享。</small>
<label class="checkbox_label"><input id="fa-fallback" type="checkbox"> 无标记时兼容普通双引号</label>
</details>
<details class="fa-sec"><summary><i class="fa-solid fa-gauge-high"></i><span>运行与存储</span><span class="fa-badge" id="fa-badge-jobs"></span></summary>
<div class="fa-sub"><div class="fa-subhead">合成进度</div>
<div id="fa-progress-summary" role="status">尚无合成任务</div>
<progress id="fa-progress-bar" max="1" value="0"></progress>
<div class="fa-row"><button id="fa-cancel-generation" class="fa-btn-danger">取消合成队列</button></div>
<label>最大并发请求数（1–10）<input id="fa-concurrency" type="number" min="1" max="10" step="1" class="text_pole"></label>
<small class="fa-hint">并发越高出音越快。Fish 有速率上限，日志出现 HTTP 429 时请调低；酒馆的 CorsProxy 同样按并发出站，数值过高可能触发服务端连接数告警。</small>
<small class="fa-hint">字节数来自浏览器实际接收量。上游不提供总长度时不显示虚构百分比。</small>
<div id="fa-progress-list"></div>
</div>
<div class="fa-sub"><div class="fa-subhead">已生成语音（本地保存）</div>
<div class="fa-row"><button id="fa-library-refresh">刷新语音列表</button></div>
<small class="fa-hint" id="fa-library-path">保存在当前浏览器中；清除网站数据会删除音频。可逐条下载。</small>
<label>最大保留数量（1–10000）<input id="fa-limit" type="number" min="1" max="10000" value="200" class="text_pole"></label>
<button id="fa-limit-save" class="fa-btn-danger">保存数量并清理超出的最旧音频</button>
<small class="fa-hint">只清理本插件保存的文件。被清理的句子再次点击时可重新生成。</small>
<div id="fa-library-list"></div>
</div>
</details>
<details class="fa-sec"><summary><i class="fa-solid fa-plug"></i><span>连接</span></summary>
<label>Base URL（服务根地址，末尾 /v1 也可）<input id="fa-base" class="text_pole"></label>
<label>API Key<input id="fa-key" class="text_pole" type="password" autocomplete="off"></label>
<button id="fa-key-save">保存API KEY</button><small class="fa-hint">保存到账户设置；留空保存可清除。账户设置备份可能包含此密钥。</small>
<label>语音引擎<input id="fa-model" class="text_pole" type="text" placeholder="s2.1-pro-free"></label>
<small class="fa-hint">需启用酒馆 enableCorsProxy 并重启；用试听验证连接。</small>
<div class="fa-sub"><div class="fa-subhead">音色描述（用酒馆默认模型）</div>
<small class="fa-hint">「✨ 生成描述」和「一键补充」直接用酒馆当前选中的聊天补全来源、Base URL 和密钥，插件不保存这些凭据。当前来源会在点击时读取，换模型后立刻生效。</small>
<div id="fa-model-hint" class="fa-row"><small class="fa-hint">当前来源：读取中…</small></div>
</div>
<div class="fa-sub"><div class="fa-subhead">逐字稿识别（阿里百炼）</div>
<label>百炼中转地址<input id="fa-asr-host" class="text_pole" type="text" placeholder="llm-xxxx.cn-beijing.maas.aliyuncs.com"></label>
<label>识别模型<input id="fa-asr-model" class="text_pole" type="text" placeholder="qwen-audio-3.1-asr-flash"></label>
<label>百炼 API Key<input id="fa-asr-key" class="text_pole" type="password" autocomplete="off"></label>
<button id="fa-asr-key-save">保存 ASR 密钥</button>
<small class="fa-hint">模型名要写 qwen-audio-3.1-asr-flash；控制台示例里的 -message 后缀会报 url error。密钥只保存在账户设置里，账户备份可能包含它。密钥无效或额度用尽时会返回对应提示，不会静默失败。</small>
</div>
</details>
<details class="fa-sec"><summary><i class="fa-solid fa-screwdriver-wrench"></i><span>高级 · 维护</span></summary>
<div class="fa-row"><button id="fa-log-export">导出日志</button><button id="fa-log-clear" class="fa-btn-danger">清空日志</button></div>
<pre id="fa-logs"></pre>
</details>
`;
// The settings no longer live in the extension-settings drawer: every control
// sits in the "Fish 配音管理" dialog's 设置 tab. This host is detached (never
// appended), so the controls can be queried and bound before the dialog exists
// and move into the real tab when it is built.
const settingsHost = document.createElement('div');
settingsHost.className = 'fa-settings';
settingsHost.id = 'fa-settings-host';
// Parked inside the host page rather than detached: the form runs its own setup on
// load, and the plugin's error dialog needs a parent. It is hidden until the
// dialog adopts it.
settingsHost.hidden = true;
document.body.append(settingsHost);
renderSettingsMarkup(settingsHost);
const $ = id => id === 'audio' ? audio : settingsHost.querySelector('#fa-' + id);
// The wand menu is the only entry point now that the settings drawer is gone.
// SillyTavern renders these into #extensionsMenu.
function mountWandMenu() {
    const host = document.querySelector('#extensionsMenu');
    if (!host || host.querySelector('#fa-wand-voices')) return;
    const item = document.createElement('div');
    item.id = 'fa-wand-voices';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.title = 'Fish 对话音声：Fish 配音管理';
    const icon = document.createElement('div'); icon.className = 'fa-solid fa-microphone-lines extensionsMenuExtensionButton';
    const label = document.createElement('span'); label.textContent = 'Fish 配音管理';
    item.append(icon, label);
    item.addEventListener('click', () => voicePanel?.open('library'));
    item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); voicePanel?.open('library'); } });
    host.append(item);
}
// The panel installer runs later in module order; the click handler only fires
// after the module finished loading, so the optional chain is the guard.
mountWandMenu();
const c0 = ctx();
if (c0.eventTypes?.APP_READY) c0.eventSource.on(c0.eventTypes.APP_READY, mountWandMenu);

// Chat-page dock: language cycle / plugin on-off / voice manager.
const dock = installDock({
    settings, save, log,
    setLanguage: language => applyLanguage(language),
    mountBook: language => mountBook(language),
    unmountBook: () => unmountBook(),
    syncRoster: () => syncRosterToBook(),
    openVoices: () => voicePanel?.open('library'),
    enabled: () => settings.enabled !== false,
    setEnabled: on => { settings.enabled = on; },
});
function mountDock() { dock.mount(); }
mountDock();
if (c0.eventTypes?.APP_READY) c0.eventSource.on(c0.eventTypes.APP_READY, mountDock);

function save() { ctx().saveSettingsDebounced(); }
function log(level, text) {
    let safe = String(text);
    for (const key of [apiKey,settings.savedApiKey]) if(key) safe = safe.replaceAll(key, '[REDACTED]');
    safe = safe.replace(/sk-fish-[A-Za-z0-9_-]+/g,'[REDACTED]');
    logs.push(`${new Date().toISOString()} ${level} ${safe}`);
    if (logs.length > 300) logs.shift();
    $('logs').textContent = logs.join('\n');
    if (level === 'ERROR' || level === 'WARN') $('status').textContent = safe;
    if (level === 'ERROR') showError(safe);
}
let lastError = '', lastErrorAt = 0;
function showError(message) {
    if (message === lastError && Date.now()-lastErrorAt < 4000) return;
    lastError=message; lastErrorAt=Date.now();
    const dialog=document.createElement('dialog'); dialog.className='fa-error-dialog';
    const title=document.createElement('h3'); title.textContent='Fish 对话音声：出错了';
    const body=document.createElement('p'); body.textContent=message;
    const close=document.createElement('button'); close.className='menu_button'; close.textContent='关闭'; close.onclick=()=>dialog.close();
    dialog.append(title,body,close); document.body.append(dialog);
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
}
function click(id, fn) {
    const node = $(id);
    // A missing control must never abort module evaluation: everything below it
    // (the wand menu entry, the chat-page dock, the voice panel) would be lost.
    if (!node) { console.warn('[Fish] 找不到控件 #fa-' + id + '，已跳过绑定'); return; }
    node.addEventListener('click', async () => {
        const target = $(id);
        if (target) target.disabled = true;
        try { await fn(); } catch (e) { log('ERROR', e.message); }
        finally { const back = $(id); if (back) back.disabled = false; }
    });
}
async function api(action,input={},signal,update) {
    if(action==='tts')return synthesizeBrowser(input,apiKey,browserStore,signal,update,fetch,loadRefAudio);
    if(action==='library')return browserStore.list();
    if(action==='library/limit')return browserStore.setLimit(input.maxFiles);
    if(action==='audio'){
        const blob=await browserStore.read(input.id);
        if(!blob)throw Error('音频已清理；请点击对应对白重新生成');
        return blob;
    }
    throw Error('不支持的本地操作');
}
// A pool of ten requests reports progress on every streamed chunk; without this
// the panel would rebuild its task list thousands of times per reply.
const PROGRESS_INTERVAL_MS = 150;
let progressTimerId = null, lastProgressAt = 0;
function requestProgress() {
    if (progressTimerId !== null) return;
    progressTimerId = setTimeout(() => {
        progressTimerId = null; lastProgressAt = Date.now();
        try { renderProgress(); } catch (e) { log('ERROR', e.message); }
    }, Math.max(0, PROGRESS_INTERVAL_MS - (Date.now() - lastProgressAt)));
}
const generator = new SynthesisQueue({synthesize:synthesizeRaw, changed:requestProgress, concurrency:settings.concurrency});
function renderProgress() {
    const tasks = generator.tasks;
    for(const task of tasks) if(task.status==='failed' && !task.errorReported){task.errorReported=true;log('ERROR',task.error);}
    const counts = {ready:0,failed:0,canceled:0};
    for(const t of tasks) if(t.status in counts) counts[t.status]++;
    $('badge-jobs').textContent = tasks.length ? (counts.ready + '/' + tasks.length) : '';
    $('progress-summary').textContent = tasks.length ? '已就绪 '+counts.ready+' / '+tasks.length+' · 失败 '+counts.failed+' · 取消 '+counts.canceled+(generator.memoryPaused?' · 缓冲已满，播放后继续合成':'') : '尚无合成任务';
    $('progress-bar').max=Math.max(1,tasks.length); $('progress-bar').value=counts.ready+counts.failed+counts.canceled;
    const rows=tasks.slice(-100).map(t=>{
        const row=document.createElement('div');row.className='fa-job';
        const title=document.createElement('span');title.textContent=(t.item.speaker||'默认')+' · 第 '+((t.item.block||0)+1)+' 段';
        const state=document.createElement('small');
        const labels={queued:'等待请求',requesting:'等待 API 响应',receiving:'接收音频',saving:'保存音频',ready:t.cacheSource==='disk'?'本地命中':'音频就绪',failed:'失败',canceled:'已取消'};
        const elapsed=t.startedAt?Math.max(0,Math.round(((t.finishedAt||Date.now())-t.startedAt)/1000)):0;
        const bytes=t.receivedBytes ? ' · '+(t.receivedBytes/1024).toFixed(1)+' KB'+(t.totalBytes?' / '+(t.totalBytes/1024).toFixed(1)+' KB':'（总大小未知）'):'';
        state.textContent=labels[t.status]+' · '+elapsed+' 秒'+bytes+(t.error?' · '+t.error:'');
        row.append(title,state);return row;
    });
    $('progress-list').replaceChildren(...rows);inline?.schedule();
}
function stopAll() { generator.cancel(); queue.stop(); }
click('cancel-generation',()=>generator.cancel());
const progressTimer=setInterval(()=>{if(generator.running)renderProgress();},1000);
$('concurrency').value = String(generator.concurrency);
$('concurrency').addEventListener('change', () => {
    const applied = generator.setConcurrency($('concurrency').value);
    $('concurrency').value = String(applied); settings.concurrency = applied; save();
    log('INFO', '最大并发请求数已设为 ' + applied);
});
const queue = new SpeechQueue({
    audio: $('audio'), log,
    changed(q) {
        $('status').textContent = q.error || (q.running ? `角色：${q.current?.speaker || '默认'} · 剩余 ${q.items.length} 句${q.paused ? ' · 已暂停' : ''}` : '就绪 / 队列结束');
        $('preview-default').textContent=q.running && q.current?.preview?'停止试听':'试听默认音色';
        inline?.schedule();
    },
    async synthesize(item, signal) {
        if (item.libraryId) return api('audio', {id:item.libraryId}, signal);
        item.task ||= generator.submit(item);
        return generator.take(item.task, signal);
    },
});
let voiceLibrary = Array.isArray(settings.voiceLibrary) ? settings.voiceLibrary : [];
// The reference bytes are stored under the voice id, so a lookup only has to ask
// whether this voice is a clone and then attach the blob to the request.
async function loadRefAudio(voiceId) {
    const entry = voiceLibrary.find(item => item.id === voiceId);
    if (!entry?.refAudio) return null;
    const record = await refStore.get(voiceId);
    if (!record?.blob) throw new Error(`参考音频已丢失（${entry.name || voiceId}）：请到“音色管理 → 快速克隆”重新导入`);
    return { blob: record.blob, transcript: entry.refAudio.transcript, key: 'ref:' + voiceId };
}
function languageLabel(code) { return { zh: '中文', ja: '日语', en: '英语' }[code] || code; }
// No declared language means "usable anywhere": most clones carry no language
// metadata, and hiding them would empty the selector for those users.
function entryMatches(entry, language) { return !entry.languages.length || entry.languages.includes(language); }
// The chat-page switcher and the settings panel edit the same value, so there is
// one source of truth and no override layer to explain away. Segment language
// still comes from the Talk-Emo protocol, so each line picks its own slot.
function setDefaultVoice(language, value) {
    const next = normalizeVoiceConfig(settings.defaultVoice);
    if (value) next[language] = value; else delete next[language];
    settings.defaultVoice = next;
    save(); stopAll();
    renderDefaultVoiceSelects();
}
function fillSelect(select, language, current) {
    const options = [{ value: '', label: '— 默认 —' }], seen = new Set(['']);
    for (const entry of voiceLibrary) {
        if (!entryMatches(entry, language) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        options.push({ value: entry.id, label: (entry.languages.length ? entry.name : entry.name + '（通用）') + (entry.active === false ? ' · 未激活' : '') });
    }
    // A configured id absent from the library stays selectable; otherwise merely
    // opening the panel would silently drop an existing binding.
    if (current && !seen.has(current)) options.push({ value: current, label: '库外：' + current.slice(0, 10) + '…' });
    select.replaceChildren(...options.map(item => {
        const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; return option;
    }));
    select.value = current || '';
}
function renderVoiceLibrary() {
    // The list itself lives in the voice management dialog; this panel only keeps
    // the counters so the settings page stays short.
    const activeCount = voiceLibrary.filter(e => e.active !== false).length;
    $('voicecount').textContent = voiceLibrary.length ? activeCount + '/' + voiceLibrary.length + ' 个音色' : '未同步';
    $('badge-voices').textContent = voiceLibrary.length ? activeCount + '/' + voiceLibrary.length : '';
    $('chip-active').textContent = voiceLibrary.length ? '音色 ' + activeCount + '/' + voiceLibrary.length : '音色 —';
}
function renderDefaultVoiceSelects() {
    const host = $('default'); if (!host) return; host.replaceChildren();
    const config = normalizeVoiceConfig(settings.defaultVoice);
    for (const language of VOICE_LANGUAGES) {
        const wrap = document.createElement('label'); wrap.className = 'fa-lang-select';
        const caption = document.createElement('span'); caption.textContent = languageLabel(language);
        const select = document.createElement('select'); select.className = 'text_pole';
        // A legacy plain-id binding has no per-language key. Showing it in every
        // slot mirrors how it actually resolves, and stops "保存" from wiping it.
        fillSelect(select, language, config[language] || config.default || '');
        select.addEventListener('change', () => setDefaultVoice(language, select.value));
        wrap.append(caption, select); host.append(wrap);
    }
    const filled = VOICE_LANGUAGES.filter(l => config[l] || config.default).length;
    const chip = $('chip-default');
    if (chip) chip.textContent = '默认音色 ' + filled + '/' + VOICE_LANGUAGES.length;
}
function addVoice(name = '', langs = {}) {
    const row = document.createElement('div'); row.className = 'fa-voice';
    const nameInput = document.createElement('input'); nameInput.placeholder = '角色名'; nameInput.value = name;
    row.append(nameInput);
    for (const language of VOICE_LANGUAGES) {
        const select = document.createElement('select'); select.className = 'text_pole'; select.dataset.lang = language;
        fillSelect(select, language, langs[language] || langs.default || '');
        row.append(select);
    }
    const remove = document.createElement('button'); remove.textContent = '删除'; remove.onclick = () => row.remove();
    row.append(remove); $('voices')?.append(row);
}
function collectVoiceRows() {
    const rows = [];
    for (const row of $('voices')?.children || []) {
        const name = row.querySelector('input').value.trim(), langs = {};
        for (const select of row.querySelectorAll('select')) if (select.value) langs[select.dataset.lang] = select.value;
        rows.push({ name, langs });
    }
    return rows;
}
function renderVoiceRows(rows) { $('voices')?.replaceChildren(); for (const row of rows) addVoice(row.name, row.langs); }
// Rebuild every selector from the library. Character rows are carried across so
// adding or removing a library voice never discards in-progress edits.
function refreshAll() {
    const rows = collectVoiceRows();
    renderVoiceLibrary(); renderDefaultVoiceSelects(); renderVoiceRows(rows);
    renderModelHint();
    voicePanel?.refresh();
}
// Which chat backend the description buttons will use. Re-read on every rebuild
// because the user can switch model inside SillyTavern at any time; showing the
// answer up front beats a confusing failure after the click.
function renderModelHint() {
    const node = $('model-hint');
    if (!node) return;
    const source = ctx();
    const name = source.chatCompletionSettings?.chat_completion_source || '';
    const model = source.model || '';
    const small = document.createElement('small');
    small.className = 'fa-hint';
    small.textContent = (name || model)
        ? `当前来源：${name || '（未设置）'} · 模型 ${model || '（跟随来源默认）'}`
        : '还没有选择聊天补全来源，生成描述会失败；请先在酒馆的 API 设置里选一个支持多模态的模型。';
    node.replaceChildren(small);
}
// Declared with var on purpose: mountWandMenu() and installDock() run during module
// evaluation, long before this line. `let` would leave the binding in its temporal
// dead zone and every early `voicePanel?.open()` would throw ReferenceError.
var voicePanel = null;
voicePanel = installVoicePanel({
    context: ctx, settings, log, save,
    settingsHost: settingsHost,
    adoptSettings: () => { settingsHost.hidden = false; renderSettingsMarkup(settingsHost); },
    library: () => voiceLibrary,
    setLibrary: next => { voiceLibrary = next; settings.voiceLibrary = next; save(); },
    refresh,
    preview: entry => playPreview(entry),
    search: ({ title }) => searchVoices({ baseUrl: settings.baseUrl, apiKey, title }),
    addClone,
    transcribe: ({ file, language }) => transcribeRefAudio({ file, language }),
    describe: args => describeVoice({ ...args, log }),
    previewAudio: entry => previewAudioBlob(entry),
    removeRef: id => refStore.delete(id),
    renameRef: (fromId, toId) => refStore.renameRef(fromId, toId),
    syncRoster: () => syncRosterToBook(),
    clearRefs: async () => { const usage = await refStore.usage(); await refStore.clear(); return usage.count; },
    refUsage: () => refStore.usage(),
});
// Called by the panel after each render to keep the status chips current. It
// deliberately skips the panel itself; re-entering it from inside a render would
// never terminate.
function refresh() {
    renderVoiceLibrary();
    renderDefaultVoiceSelects();
    renderVoiceRows(collectVoiceRows());
}
click('library-sync', async () => {
    const entries = await fetchVoiceLibrary({ baseUrl: settings.baseUrl, apiKey });
    // Groups, clone markers and edited names are plugin-side only; a sync that
    // dropped them would reorganise the user's library behind their back.
    voiceLibrary = mergeSyncedLibrary(entries, voiceLibrary);
    settings.voiceLibrary = voiceLibrary; save();
    refreshAll();
    log('INFO', '音色库已同步：' + voiceLibrary.length + ' 个音色');
    $('status').textContent = '音色库已同步 ' + voiceLibrary.length + ' 个音色';
});
function playPreview(entry) {
    if (queue.running && queue.current?.preview) { queue.stop(); return; }
    const language = entry.languages?.[0] || (settings.language === 'orig' ? 'zh' : settings.language);
    queue.stop();
    queue.enqueue([voicePreview({ voice: entry.id, language, settings })]);
}
// The clone tab's transcript button. Only the transport lives here; the request
// shape and every error message come from ai-voice.mjs.
async function transcribeRefAudio({ file, language }) {
    if (!file) throw new Error('请先选择参考音频文件');
    const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'audio/mpeg' });
    const result = await transcribeAudio(blob, {
        apiKey: settings.asrKey || '',
        language: language || '',
        host: settings.asrHost || DEFAULTS.asrHost,
        model: settings.asrModel || DEFAULTS.asrModel,
    });
    // Unchecked on purpose: speech recognition mishears names and punctuation, and
    // a Fish clone with the wrong transcript sounds noticeably worse. The text goes
    // into the editable box, never straight into a saved clone.
    return result.text;
}

// Preview audio for the description prompt, as base64 (what the chat backends
// accept). Follows the same path as the 试听 button so the clip is the one the
// user would actually hear, and the cache makes repeat calls free.
async function previewAudioBlob(entry) {
    const language = entry.languages?.[0] || (settings.language === 'orig' ? 'zh' : settings.language);
    const input = voicePreview({ voice: entry.id, language, settings });
    const blob = await synthesizeBrowser(input, apiKey, browserStore, undefined, () => {}, fetch, loadRefAudio);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return { base64: btoa(binary), format: audioFormat(blob.type || '', '') };
}

async function addClone({ file, name, language, transcript }) {
    if (!file) throw new Error('请先选择参考音频文件');
    const meta = normalizeRefAudio({ name, transcript, language, bytes: file.size, type: file.type });
    const entryName = meta.name || (file.name || '').replace(/\.[^.]+$/, '') || '克隆音色';
    const id = globalThis.crypto?.randomUUID?.() || ctx().uuidv4();
    await refStore.put(id, file, meta);
    const entry = normalizeVoiceEntry({
        id, title: entryName, languages: meta.language ? [meta.language] : [],
        guide: '', active: true,
        refAudio: { transcript: meta.transcript, bytes: meta.bytes, type: meta.type, savedAt: Date.now() },
    });
    entry.group = '';
    voiceLibrary = voiceLibrary.concat([entry]);
    settings.voiceLibrary = voiceLibrary; save();
    refreshAll();
    log('INFO', `已保存克隆音色「${entryName}」（${formatBytes(meta.bytes)}）`);
}
// Orphaned reference audio (voice deleted from the library, or bytes lost) is
// reported once at startup instead of failing silently at synthesis time.
(async function settleRefAudio() {
    try {
        const { removed, missing } = await pruneRefAudio(refStore, voiceLibrary);
        if (removed) log('INFO', `已清理 ${removed} 段无主参考音频`);
        if (missing.length) {
            voiceLibrary = voiceLibrary.filter(entry => !missing.includes(entry.id));
            settings.voiceLibrary = voiceLibrary;
            for (const name of missing) log('ERROR', `参考音频丢失，已移除克隆音色 ${name}`);
            save(); refreshAll();
        }
    } catch (e) { log('WARN', '参考音频自检失败：' + e.message); }
})();
function importRosterEntries(roster) {
    let added = 0;
    const byId = new Map(voiceLibrary.map(entry => [entry.id, entry]));
    for (const item of Array.isArray(roster) ? roster : []) {
        if (!item || !item.id) continue;
        const existing = byId.get(item.id);
        if (existing) {
            if (!existing.guide && item.guide) existing.guide = item.guide;
            if (item.names) existing.names = { ...item.names, ...(existing.names || {}) };
            if (existing.active === undefined) existing.active = item.active !== false;
            if (Array.isArray(item.languages) && item.languages.length) existing.languages = item.languages.slice();
        } else {
            byId.set(item.id, { id: item.id, name: item.name || item.id, names: item.names || {},
                languages: Array.isArray(item.languages) ? item.languages : [], state: '',
                guide: item.guide || '', active: item.active !== false });
            added++;
        }
    }
    voiceLibrary = [...byId.values()]; settings.voiceLibrary = voiceLibrary; save(); refreshAll();
    return added;
}
async function loadRoster() {
    const r = await fetch(new URL('./fish-roster.json', import.meta.url));
    if (!r.ok) throw new Error('扩展目录缺少 fish-roster.json');
    return r.json();
}
click('import-roster', async () => {
    const added = importRosterEntries(await loadRoster());
    refreshAll();
    log('INFO', `已导入内置音色 ${added} 个（已存在的仅补全信息）`);
    $('status').textContent = `内置音色导入完成，新增 ${added} 个`;
});
function pluginEnabled() { return settings.enabled !== false; }
async function syncRosterToBook() {
    const w = await world(), name = settings.book;
    if (!w.world_names.includes(name)) throw new Error('请先安装世界书');
    const data = await w.loadWorldInfo(name);
    let updated = 0;
    for (const [language, comment] of Object.entries(BOOK_LANGUAGES)) {
        const entry = Object.values(data.entries || {}).find(e => e.comment === comment);
        if (!entry) continue;
        entry.content = replaceRosterBlock(entry.content, buildRosterSection(voiceLibrary, language));
        updated++;
    }
    if (!updated) throw new Error('世界书缺少 FA_FORMAT 语言条目，请先安装或升级世界书');
    await writeBook(name, data);
    const active = voiceLibrary.filter(e => e.active !== false).length;
    $('status').textContent = '音色名册已同步到世界书';
    return `音色名册已写入世界书（${updated} 条 · 激活音色 ${active} 个）`;
}
click('sync-roster', async () => {
    try { log('INFO', await syncRosterToBook()); }
    catch (e) { log('ERROR', e.message); }
});
async function applyVoiceGuides() {
    try {
        const r = await fetch(new URL('./voice-guides.json', import.meta.url));
        if (!r.ok) return;
        const map = await r.json();
        let filled = 0;
        for (const entry of voiceLibrary) if (!entry.guide && map[entry.id]) { entry.guide = map[entry.id]; filled++; }
        if (filled) { settings.voiceLibrary = voiceLibrary; save(); renderVoiceLibrary(); log('INFO', '已补全 ' + filled + ' 条音色指南'); }
    } catch (e) { log('WARN', '音色指南加载失败：' + e.message); }
}
click('preview-default', () => {
    if (queue.running && queue.current?.preview) { queue.stop(); return; }
    const language = settings.language === 'orig' ? 'zh' : settings.language;
    const voice = resolveVoice(language, settings.defaultVoice);
    const item = voicePreview({ voice, language, settings });
    queue.stop(); queue.enqueue([item]);
});
// Older builds kept a per-chat override. Fold it into the global default once,
// otherwise merging the two controls would silently change the user's voice.
(function adoptLegacyChatVoice() {
    const legacy = ctx().chatMetadata?.fish_dialogue?.voice;
    if (!legacy || typeof legacy !== 'object') return;
    const merged = normalizeVoiceConfig(settings.defaultVoice), adopted = [];
    for (const language of VOICE_LANGUAGES) {
        const value = legacy[language];
        if (typeof value === 'string' && value.trim() && !merged[language]) { merged[language] = value.trim(); adopted.push(language); }
    }
    if (!adopted.length) return;
    settings.defaultVoice = merged; save();
    log('INFO', '已把本聊天的音色选择并入全局默认音色：' + adopted.map(languageLabel).join('、'));
})();
renderVoiceLibrary(); renderDefaultVoiceSelects();
renderVoiceRows(Object.entries(settings.voices).map(([name, config]) => ({ name, langs: normalizeVoiceConfig(config) })));
refreshAll();
// A full set of work groups ships with the plugin so the built-in voices are
// filed by franchise out of the box. Merging them in by name (rather than only
// seeding an empty list) is what lets an install that already carries the old
// two-group list pick up the new ones. Groups the user renamed or deleted are
// simply absent, so it is safe to run on every start.
if (!Array.isArray(settings.voiceGroups)) settings.voiceGroups = [];
let groupsAdded = 0;
for (const name of DEFAULT_GROUP_NAMES) {
    if (settings.voiceGroups.includes(name)) continue;
    settings.voiceGroups.push(name);
    groupsAdded++;
}
if (groupsAdded) save();
// Shipped voices are re-filed on every start, not only on first import: a library
// imported by an older version has the same entries but no group yet, and the
// import flag would otherwise freeze them as "未分组" forever. Only entries that
// are still group-less are touched, so a voice the user filed elsewhere stays put,
// and a default group the user deleted is not resurrected for its members.
function filePresetGroups() {
    let moved = 0;
    const known = new Set(settings.voiceGroups || []);
    for (const entry of voiceLibrary) {
        if (!entry || entry.group) continue;
        const group = defaultGroupFor(entry.id);
        if (group && known.has(group) && assignGroup(voiceLibrary, [entry.id], group)) moved++;
    }
    if (moved) { settings.voiceLibrary = voiceLibrary; save(); }
    return moved;
}
(async function bootstrapRoster() {
    try {
        const roster = await loadRoster();
        const added = importRosterEntries(roster);
        if ((settings.rosterImported || 0) < 2) {
            settings.rosterImported = 2; save();
            log('INFO', `已自动导入内置音色 ${added} 个`);
        }
        const moved = filePresetGroups();
        if (moved) log('INFO', `已按作品把 ${moved} 个内置音色归入分组`);
    } catch (e) { log('WARN', '内置音色自动导入失败：' + e.message); }
    await applyVoiceGuides();
    refreshAll();
})();
async function synthesizeRaw(item, signal, update) {
        // Message identities are persisted only when audio is requested, not during rendering.
        if (item.messageRef) {
            const c = ctx();
            if (!c.chat.includes(item.messageRef)) throw new Error('消息已切换，取消生成');
            const needsSave = !c.chatMetadata.fish_dialogue_chat_id || !item.messageRef.extra?.fish_dialogue?.id;
            c.chatMetadata.fish_dialogue_chat_id ||= (globalThis.crypto?.randomUUID?.() || c.uuidv4());
            item.messageRef.extra ||= {};
            item.messageRef.extra.fish_dialogue ||= {};
            item.messageRef.extra.fish_dialogue.id ||= (globalThis.crypto?.randomUUID?.() || c.uuidv4());
            item.messageRef.extra.fish_dialogue.language ||= item.language;
            const revision = await digest(item.messageRef.mes);
            item.link = { chat: c.chatMetadata.fish_dialogue_chat_id, message: item.messageRef.extra.fish_dialogue.id, revision, block: item.block };
            if (needsSave) await c.saveChat();
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        }
        const payload = { text: item.text, speaker: item.speaker, language: item.language, voice: item.voice,
            model: item.model, baseUrl: item.baseUrl, link: item.link, persist: true, jobId: globalThis.crypto?.randomUUID?.() || ctx().uuidv4() };
        // Disk is authoritative for retention; local cache is not used to recreate a deleted file.
        const start = performance.now();
        log('INFO', `读取或合成：${item.model}，${Array.from(item.text).length} 字符`);
        const blob = await api('tts', payload, signal, update);
        update({cacheSource:payload.cacheSource});
        item.assetId = payload.assetId;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        log('INFO', `${payload.cacheSource === 'disk' ? '本地音频命中' : '合成并保存完成'}：${Math.round(performance.now() - start)} ms，${blob.size} 字节`);
        return blob;
}

function source() {
    const chat = ctx().chat;
    const val = $('message').value;
    const id = val === '' ? chat.findLastIndex(m => !m.is_user && !m.is_system) : Number(val);
    const message = chat[id];
    if (!Number.isInteger(id) || !message || message.is_user || message.is_system) throw new Error('没有可播放的 AI 消息');
    return { id, message };
}
async function digest(text) {
    if (globalThis.crypto?.subtle) return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, '0')).join('');
    // LAN HTTP can lack WebCrypto. This is only a revision hint; the server hashes exact speech and identity.
    let a = 2166136261, b = 5381;
    for (const ch of String(text)) { a = Math.imul(a ^ ch.codePointAt(0), 16777619); b = Math.imul(b, 33) ^ ch.codePointAt(0); }
    return `local-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}-${text.length}`;
}
function parsed(text, speaker, language = settings.language) {
    const result = extract(text, { ...settings, language, speaker });
    result.warnings.forEach(w => log('WARN', w));
    log('INFO', `提取到 ${result.segments.length} 段 ${settings.language} 对话`);
    return result.segments;
}
function enqueue(segments, replace = false, eager = false) {
    const items = segments.map(s => ({ ...s, voice: voiceFor(s, settings), model: settings.model, baseUrl: settings.baseUrl }));
    if (items.some(x => !x.voice)) throw new Error('缺少音色：请先在“音色库”同步或添加音色，再在“角色音色”或聊天页选择');
    if (!items.length) return;
    if (queue.items.length + items.length > 100 && !replace) throw new Error('等待队列超过 100 句，请先播放或停止');
    if (replace) queue.stop();
    if (eager) for (const item of items) item.task = generator.submit(item);
    queue.enqueue(items);
}
function bind(id, name, checkbox = false) {
    const node = $(id);
    if (!node) { console.warn('[Fish] 找不到控件 #fa-' + id + '，已跳过绑定'); return; }
    node[checkbox ? 'checked' : 'value'] = settings[name];
    node.addEventListener(checkbox ? 'change' : 'input', () => {
        const value = checkbox ? $(id).checked : $(id).value.trim();
        settings[name] = value; save();
        if (['baseUrl', 'model'].includes(name)) stopAll();
        if (name === 'auto' && !value) stopAll();
        if (name === 'fallback' || name === 'autoVoice' || name === 'autoMulti') { stopAll(); inline?.schedule(); }
        if (name === 'showLines') inline?.refresh();
    });
}
bind('auto', 'auto', true); bind('fallback', 'fallback', true);
bind('auto-voice', 'autoVoice', true); bind('auto-multi', 'autoMulti', true);
bind('show-lines', 'showLines', true);
if (typeof settings.model !== 'string' || !settings.model.trim()) { settings.model=DEFAULTS.model; save(); }
bind('base', 'baseUrl'); bind('model', 'model'); bind('book', 'book');
$('language').value = settings.language;
$('key').value=apiKey;
$('asr-host').value=settings.asrHost || DEFAULTS.asrHost;
$('asr-model').value=settings.asrModel || DEFAULTS.asrModel;
$('asr-key').value=settings.asrKey || '';
bind('asr-host','asrHost'); bind('asr-model','asrModel');
$('asr-key').addEventListener('input', () => { settings.asrKey = $('asr-key').value.trim(); });
click('asr-key-save',()=>{settings.asrKey=$('asr-key').value.trim();save();log('INFO',settings.asrKey?'百炼 ASR 密钥已保存':'已清除百炼 ASR 密钥');});
$('key').addEventListener('input', () => { stopAll(); apiKey = $('key').value.trim(); });
click('key-save',()=>{settings.savedApiKey=apiKey;save();log('INFO',apiKey?'API Key 已保存到账户设置':'已清除保存的 API Key');});
click('add-regex',async()=>{await installPromptRegex(ctx());log('INFO','已添加 Talk-Emo 提示词过滤正则；立即生效，刷新后可在酒馆正则列表查看。');$('status').textContent='已添加正则：音声段不再发送给 LLM，聊天原文和播放保留';});
click('add', () => addVoice());
click('save-voices', () => {
    const voices = Object.create(null);
    for (const { name, langs } of collectVoiceRows()) {
        if (!name && !Object.keys(langs).length) continue;
        if (!name) throw new Error('角色名不能为空');
        if (Object.hasOwn(voices, name)) throw new Error('角色名不能重复');
        voices[name] = langs;
    }
    stopAll(); settings.voices = voices; save(); log('INFO', '角色绑定已保存');
});
function generateMessage(message) {
    if (!pluginEnabled()) throw new Error('Fish 对话音声已关闭；请在聊天页右下角的开关里重新启用');
    const id=ctx().chat.indexOf(message);
    const items=parsed(message.mes,message.name || ctx().name2,message.extra?.fish_dialogue?.language || settings.language)
        .map(s=>({...s,messageRef:message,uiKey:id+':'+s.block,voice:voiceFor(s,settings),model:settings.model,baseUrl:settings.baseUrl}));
    if(items.some(x=>!x.voice)) throw new Error('缺少音色：请先在“音色库”同步或添加音色，再在“角色音色”或聊天页选择');
    for(const item of items) generator.submit(item,{retainAudio:false});
}
click('latest',()=>generateMessage(source().message));
$('audio').addEventListener('play',()=>{queue.paused=false;});
async function world() { return worldModule ||= await import('/scripts/world-info.js'); }
async function writeBook(name, data) {
    const w = await world();
    const r = await fetch('/api/worldinfo/edit', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name, data }) });
    if (!r.ok) throw new Error(`世界书保存失败：HTTP ${r.status}`);
    w.worldInfoCache.set(name, data);
    await ctx().eventSource.emit(ctx().eventTypes.WORLDINFO_UPDATED, name, data);
    w.reloadEditor(name);
}
async function applyLanguage(language = $('language').value) {
    const w = await world(), name = settings.book;
    if (!w.world_names.includes(name)) throw new Error('请先安装世界书');
    const data = await w.loadWorldInfo(name);
    await writeBook(name, selectLanguage(data, language));
    stopAll(); settings.language = language; save();
    const select = $('language');
    if (select) select.value = language;
    inline?.refresh();
    log('INFO', `世界书语言已切换为 ${settings.language}；对后续聊天生成生效`);
}
click('apply-language', () => applyLanguage());

// Mount (or re-mount) the plugin's worldbook in SillyTavern's world-info list
// without unselecting anything the user already had selected.
async function mountBook(language = settings.language) {
    const w = await world(), name = settings.book;
    const options = [...document.querySelectorAll('#world_info option')];
    const option = options.find(o => o.textContent === name);
    if (!option) throw new Error('未找到世界书挂载控件；请在世界书页面手动选择它');
    option.selected = true;
    window.jQuery('#world_info').trigger('change');
    settings.language = language; save();
    inline?.refresh();
    return name;
}
async function unmountBook() {
    const name = settings.book;
    const option = [...document.querySelectorAll('#world_info option')].find(o => o.textContent === name);
    if (!option || !option.selected) return false;
    option.selected = false;
    window.jQuery('#world_info').trigger('change');
    return true;
}
click('install-book', async () => {
    const w = await world(), name = settings.book;
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('请填写合法世界书名称');
    if (!w.world_names.includes(name)) {
        const r = await fetch(new URL('./Fish-Dialogue.json', import.meta.url));
        if (!r.ok) throw new Error('扩展目录缺少 Fish-Dialogue.json');
        await writeBook(name, selectLanguage(await r.json(), $('language').value));
        await w.updateWorldInfoList();
    } else await applyLanguage();
    const options = [...document.querySelectorAll('#world_info option')];
    const option = options.find(o => o.textContent === name);
    if (!option) throw new Error('世界书已保存，但未找到挂载控件；请手动在世界书页面选择它');
    option.selected = true; window.jQuery('#world_info').trigger('change');
    settings.language = $('language').value; save();
    log('INFO', `已挂载世界书 ${name}；其他世界书保持原有选择`);
});
click('upgrade-book', async () => {
    const w = await world(), name = settings.book;
    if (!w.world_names.includes(name)) throw new Error('请先安装世界书');
    const old = await w.loadWorldInfo(name);
    const r = await fetch(new URL('./Fish-Dialogue.json', import.meta.url));
    if (!r.ok) throw new Error('新版世界书文件缺失');
    const template = await r.json();
    const upgraded = upgradeWorldbook(old, template, $('language').value);
    const backup = `${name}-backup-${Date.now()}`;
    await writeBook(backup, structuredClone(old));
    await writeBook(name, selectLanguage(upgraded, $('language').value));
    await w.updateWorldInfoList();
    stopAll(); settings.language = $('language').value; save(); inline?.refresh();
    log('INFO', `世界书已升级为中文展示 + 隐藏音声格式。旧书备份：${backup}`);
    $('status').textContent = '世界书已升级并备份；请生成一条新回复测试';
});
function download(blob, filename) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
click('log-export', () => download(new Blob([logs.join('\n')], { type: 'text/plain;charset=utf-8' }), 'fish-dialogue-log.txt'));
click('log-clear', () => { logs.length = 0; $('logs').textContent = ''; });
async function refreshLibrary() {
    const data = await api('library'); libraryEntries = data.entries;
    $('library-path').textContent = `${data.path} · ${data.entries.length} / ${data.maxFiles} 个音频`;
    $('limit').value = data.maxFiles;
    const list = $('library-list'); list.replaceChildren();
    for (const entry of data.entries) {
        const row = document.createElement('div'); row.className = 'fa-library-item';
        const info = document.createElement('span');
        info.textContent = `${entry.speaker} · 第 ${(entry.link?.block || 0) + 1} 段 · ${entry.language} · ${new Date(entry.createdAt).toLocaleString()} · ${Math.round(entry.bytes / 1024)} KB`;
        const down = document.createElement('button'); down.textContent = '下载';
        down.onclick = async () => { try { download(await api('audio', { id: entry.id }), `${entry.id}.mp3`); } catch (e) { log('ERROR', e.message); } };
        const filename = document.createElement('small'); filename.textContent = `${entry.id}.mp3`;
        row.append(info, down, filename); list.append(row);
    }
    if (data.entries.length > 100) { const note = document.createElement('small'); note.textContent = '面板展示全部已保存音频。'; list.append(note); }
    log('INFO', `语音库：${data.entries.length} 个文件，上限 ${data.maxFiles}`);
}
click('library-refresh', refreshLibrary);
click('limit-save', async () => {
    stopAll();
    const result = await api('library/limit', { maxFiles: Number($('limit').value) });
    await refreshLibrary(); log('INFO', `保留上限已保存，清理 ${result.removed} 个最旧音频`);
});

inline = installInline({ context: ctx, settings, log, progress: key => generator.tasks.findLast(t => t.item.uiKey === key), pause: () => queue.pause(), resume: () => queue.resume(),
    current: () => ({ uiKey: queue.current?.uiKey, running: queue.running, paused: queue.paused, phase: queue.phase }),
    async play(id, ordinal) {
        const message = ctx().chat[id];
        const segment = segmentFromBlock(dialogueRecords(message.mes,{...settings,speaker:message.name || ctx().name2})[ordinal], message.extra?.fish_dialogue?.language || settings.language);
        if (!segment) return;
        enqueue([{ ...segment, messageRef: message, uiKey: `${id}:${ordinal}` }], true);
    },
});

const c = ctx();
let generationLanguage = settings.language;
if (c.eventTypes.GENERATION_STARTED) c.eventSource.on(c.eventTypes.GENERATION_STARTED, () => { generationLanguage = settings.language; });
c.eventSource.on(c.eventTypes.CHARACTER_MESSAGE_RENDERED, async (id, type) => {
    const message = ctx().chat[id];
    if (!message || message.is_user || message.is_system) return;
    if (type !== 'first_message' && type !== 'quiet' && blocks(message.mes).some(b => b.paired)) {
        message.extra ||= {}; message.extra.fish_dialogue ||= {};
        message.extra.fish_dialogue.language = generationLanguage;
        try { await ctx().saveChat(); } catch { log('WARN', '消息语言元数据保存失败'); }
    }
    inline.schedule();
    if (!settings.auto || type === 'first_message' || type === 'quiet') return;
    const fingerprint = JSON.stringify([message.swipe_id, message.mes, settings.language]);
    if (seen.get(id) === fingerprint) return;
    seen.set(id, fingerprint); if (seen.size > 100) seen.delete(seen.keys().next().value);
    try { generateMessage(message); } catch (e) { log('ERROR', e.message); }
});
for (const event of ['CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED']) {
    if (c.eventTypes[event]) c.eventSource.on(c.eventTypes[event], () => { stopAll(); seen.clear(); inline.schedule(); });
}
for (const event of ['MORE_MESSAGES_LOADED', 'CHAT_LOADED', 'APP_READY']) if (c.eventTypes[event]) c.eventSource.on(c.eventTypes[event], () => { inline.schedule(); });
$('audio').addEventListener('pause', () => inline.schedule());
window.addEventListener('pagehide', () => { stopAll(); clearInterval(progressTimer); inline.disconnect(); apiKey = ''; });
log('INFO', '1.7.0 已加载；已启用第三字段音色协议，请点“升级世界书”和“同步名册到世界书”。');
