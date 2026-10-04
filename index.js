import { BrowserAudioStore, synthesizeBrowser } from './browser-audio.mjs';
import { DEFAULTS, VOICE_LANGUAGES, extract, voiceFor, resolveVoice, normalizeVoiceConfig, selectLanguage, upgradeWorldbook, blocks, dialogueRecords, segmentFromBlock, isBlocked } from './core.mjs';
import { SpeechQueue } from './player.mjs';
import { SynthesisQueue } from './synthesis.mjs';
import { installInline } from './inline.mjs';
import { installPromptRegex } from './prompt-regex.mjs';
import { voicePreview } from './preview.mjs';
import { fetchVoiceLibrary } from './voice-library.mjs';

const ctx = () => SillyTavern.getContext();
const KEY = 'fish_dialogue_v1';
const settings = ctx().extensionSettings[KEY] = { ...structuredClone(DEFAULTS), ...ctx().extensionSettings[KEY] };
if (settings.schemaVersion !== 110) {
    settings.fallback = false;
    settings.schemaVersion = 110;
    ctx().saveSettingsDebounced();
}
settings.browserLibraryId ||= crypto.randomUUID();
ctx().saveSettingsDebounced();
const browserStore = new BrowserAudioStore(settings.browserLibraryId);
let apiKey = settings.savedApiKey || ''; // Saved only on explicit user action.
const audio = new Audio(); audio.preload = 'auto';
const logs = [], seen = new Map();
let worldModule;
let inline, libraryEntries = [];
const root = document.createElement('section'); root.id = 'fish-dialogue';
root.innerHTML = `
<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header" role="button" tabindex="0"><b>Fish 对话音声</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><small>版本 1.4.7</small>
<div class="fa-status" id="fa-status">就绪</div>
<label class="checkbox_label"><input id="fa-auto" type="checkbox"> 新回复自动配音</label><small>按顺序生成对白并保存到本地，不自动播放。</small>
<div class="fa-row"><button id="fa-latest">聊天序号音频生成</button></div>
<label>聊天文本序号（留空为最新回复）<input id="fa-message" type="number" min="0" class="text_pole"></label>
<details open><summary>连接设置</summary>
<label>Base URL（服务根地址，末尾 /v1 也可）<input id="fa-base" class="text_pole"></label>
<label>API Key<input id="fa-key" class="text_pole" type="password" autocomplete="off"></label>
<button id="fa-key-save">保存API KEY</button><small>保存到账户设置；留空保存可清除。账户设置备份可能包含此密钥。</small>
<label>语音引擎<input id="fa-model" class="text_pole" type="text" placeholder="s2.1-pro-free"></label>
<small>需启用酒馆 enableCorsProxy 并重启；用试听验证连接。</small>
</details>
<details open><summary>语言与世界书</summary>
<label>专用世界书名称<input id="fa-book" class="text_pole"></label>
<label>输出语言<select id="fa-language"><option value="orig">原文（关闭配音世界书）</option><option value="zh">中文</option><option value="en">英语</option><option value="ja">日语</option></select></label>
<div class="fa-row"><button id="fa-apply-language">应用语言</button><button id="fa-install-book">安装 / 挂载世界书</button><button id="fa-upgrade-book">升级世界书</button><button id="fa-add-regex">添加正则</button></div>
<small>语言选择在“应用”成功后生效；只改变下一次聊天生成的提示词，旧消息不会自动翻译。挂载为全局世界书，语言条目为该账户所有聊天共享。</small>
<label class="checkbox_label"><input id="fa-fallback" type="checkbox"> 无标记时兼容普通双引号</label>
</details>
<details open><summary>音色库 <span class="fa-version">Fish 收藏</span></summary>
<div class="fa-row"><button id="fa-library-sync">从 Fish 同步</button><small id="fa-voicecount">未同步</small></div>
<small>同步只读取你 Fish 账号中已创建或已收藏的音色；语言按音色自带标记归类，未标注语言的音色在三种语言下都可选。库只影响选择列表，不会修改 Fish 上的任何音色。</small>
<div id="fa-voicelib"></div>
<div class="fa-lib-add"><input id="fa-lib-name" class="text_pole" placeholder="名称（可留空）"><input id="fa-lib-id" class="text_pole" placeholder="音色 ID"><select id="fa-lib-lang" class="text_pole"><option value="">通用</option><option value="zh">中文</option><option value="ja">日语</option><option value="en">英语</option></select><button id="fa-lib-add">手动添加</button></div>
</details>
<details open><summary>角色音色</summary>
<div class="fa-default-heading"><span>默认音色（按语言）</span><button id="fa-preview-default" type="button">试听默认音色</button></div>
<div id="fa-default"></div>
<label class="checkbox_label"><input id="fa-block-enabled" type="checkbox"> 启用角色屏蔽</label>
<label>屏蔽角色名字（每行一个，精确匹配）<textarea id="fa-block-names" class="text_pole" rows="2" placeholder="例如：屏蔽角色名字"></textarea></label>
<small>屏蔽只影响语音，中文对白照常显示。修改后立即停止当前队列。</small>
<small>角色名须与世界书输出完全一致；某语言留空即回落到默认音色，聊天页的切换优先于这里。</small>
<div id="fa-voices"></div><button id="fa-add">添加角色</button><button id="fa-save-voices">保存角色绑定</button>
</details>
<details><summary>合成进度 / 已生成语音 <span class="fa-version">本地保存</span></summary>
<div id="fa-progress-summary" role="status">尚无合成任务</div><progress id="fa-progress-bar" max="1" value="0"></progress>
<div class="fa-row"><button id="fa-cancel-generation">取消合成队列</button></div>
<small>字节数来自浏览器实际接收量。上游不提供总长度时不显示虚构百分比。</small><div id="fa-progress-list"></div>
<div class="fa-row"><button id="fa-library-refresh">刷新语音列表</button></div>
<small id="fa-library-path">保存在当前浏览器中；清除网站数据会删除音频。可逐条下载。</small>
<label>最大保留数量（1–10000）<input id="fa-limit" type="number" min="1" max="10000" value="200" class="text_pole"></label>
<button id="fa-limit-save">保存数量并清理超出的最旧音频</button>
<small>只清理本插件保存的文件。被清理的句子再次点击时可重新生成。</small>
<div id="fa-library-list"></div>
</details>
<details><summary>日志</summary><div class="fa-row"><button id="fa-log-export">导出日志</button><button id="fa-log-clear">清空日志</button></div><pre id="fa-logs"></pre></details>
</div></div>`;
(document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings') || document.body).append(root);
for (const button of root.querySelectorAll('button')) button.classList.add('menu_button');
root.querySelector('.inline-drawer-header').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.currentTarget.click();}});
const $ = id => id === 'audio' ? audio : root.querySelector('#fa-' + id);
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
    $(id).addEventListener('click', async () => {
        $(id).disabled = true;
        try { await fn(); } catch (e) { log('ERROR', e.message); }
        finally { $(id).disabled = false; }
    });
}
async function api(action,input={},signal,update) {
    if(action==='tts')return synthesizeBrowser(input,apiKey,browserStore,signal,update);
    if(action==='library')return browserStore.list();
    if(action==='library/limit')return browserStore.setLimit(input.maxFiles);
    if(action==='audio'){
        const blob=await browserStore.read(input.id);
        if(!blob)throw Error('音频已清理；请点击对应对白重新生成');
        return blob;
    }
    throw Error('不支持的本地操作');
}
const generator = new SynthesisQueue({synthesize:synthesizeRaw, changed:renderProgress});
function renderProgress() {
    const tasks = generator.tasks;
    for(const task of tasks) if(task.status==='failed' && !task.errorReported){task.errorReported=true;log('ERROR',task.error);}
    const counts = {ready:0,failed:0,canceled:0};
    for(const t of tasks) if(t.status in counts) counts[t.status]++;
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
const queue = new SpeechQueue({
    audio: $('audio'), log,
    changed(q) {
        $('status').textContent = q.error || (q.running ? `角色：${q.current?.speaker || '默认'} · 剩余 ${q.items.length} 句${q.paused ? ' · 已暂停' : ''}` : '就绪 / 队列结束');
        $('preview-default').textContent=q.running && q.current?.preview?'停止试听':'试听默认音色';
        inline?.schedule();
    },
    async synthesize(item, signal) {
        if (isBlocked(item.speaker, settings)) throw new Error('该角色已屏蔽');
        if (item.libraryId) return api('audio', {id:item.libraryId}, signal);
        item.task ||= generator.submit(item);
        return generator.take(item.task, signal);
    },
});
let voiceLibrary = Array.isArray(settings.voiceLibrary) ? settings.voiceLibrary : [];
function languageLabel(code) { return { zh: '中文', ja: '日语', en: '英语' }[code] || code; }
// No declared language means "usable anywhere": most clones carry no language
// metadata, and hiding them would empty the selector for those users.
function entryMatches(entry, language) { return !entry.languages.length || entry.languages.includes(language); }
// Chat-scoped override written by the switcher above the input box. Segment
// language comes from the Talk-Emo protocol, so each line picks its own slot.
function chatVoiceConfig() {
    const voice = ctx().chatMetadata?.fish_dialogue?.voice;
    return voice && typeof voice === 'object' ? voice : {};
}
async function saveChatMetadata() {
    const c = ctx();
    try {
        if (typeof c.saveMetadata === 'function') await c.saveMetadata();
        else if (typeof c.saveChat === 'function') await c.saveChat();
    } catch (e) { log('WARN', '聊天音色设置保存失败：' + e.message); }
}
function fillSelect(select, language, current) {
    const options = [{ value: '', label: '— 默认 —' }], seen = new Set(['']);
    for (const entry of voiceLibrary) {
        if (!entryMatches(entry, language) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        options.push({ value: entry.id, label: entry.languages.length ? entry.name : entry.name + '（通用）' });
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
    $('voicelib').replaceChildren();
    $('voicecount').textContent = voiceLibrary.length ? voiceLibrary.length + ' 个音色' : '未同步';
    for (const entry of voiceLibrary) {
        const row = document.createElement('div'); row.className = 'fa-lib-item';
        const name = document.createElement('span'); name.textContent = entry.name;
        const meta = document.createElement('small');
        meta.textContent = (entry.languages.length ? entry.languages.map(languageLabel).join('/') : '通用') + (entry.state && entry.state !== 'trained' ? ' · ' + entry.state : '');
        const play = document.createElement('button'); play.type = 'button'; play.textContent = '▶ 试听';
        play.onclick = () => {
            try {
                if (queue.running && queue.current?.preview) { queue.stop(); return; }
                queue.stop();
                queue.enqueue([voicePreview({ voice: entry.id, language: entry.languages[0] || settings.language, settings })]);
            } catch (e) { log('ERROR', e.message); }
        };
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '删除';
        remove.onclick = () => {
            voiceLibrary = voiceLibrary.filter(x => x.id !== entry.id);
            settings.voiceLibrary = voiceLibrary; save(); refreshVoiceSelectors();
            log('INFO', '已从音色库移除 ' + entry.name);
        };
        row.append(name, meta, play, remove); $('voicelib').append(row);
    }
}
function renderDefaultVoices() {
    const host = $('default'); host.replaceChildren();
    const config = normalizeVoiceConfig(settings.defaultVoice);
    for (const language of VOICE_LANGUAGES) {
        const wrap = document.createElement('label'); wrap.className = 'fa-lang-select';
        const caption = document.createElement('span'); caption.textContent = languageLabel(language);
        const select = document.createElement('select'); select.className = 'text_pole';
        // A legacy plain-id binding has no per-language key. Showing it in every
        // slot mirrors how it actually resolves, and stops "保存" from wiping it.
        fillSelect(select, language, config[language] || config.default || '');
        select.addEventListener('change', () => {
            const next = normalizeVoiceConfig(settings.defaultVoice);
            if (select.value) next[language] = select.value; else delete next[language];
            settings.defaultVoice = next; save(); stopAll();
        });
        wrap.append(caption, select); host.append(wrap);
    }
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
    row.append(remove); $('voices').append(row);
}
function collectVoiceRows() {
    const rows = [];
    for (const row of $('voices').children) {
        const name = row.querySelector('input').value.trim(), langs = {};
        for (const select of row.querySelectorAll('select')) if (select.value) langs[select.dataset.lang] = select.value;
        rows.push({ name, langs });
    }
    return rows;
}
function renderVoiceRows(rows) { $('voices').replaceChildren(); for (const row of rows) addVoice(row.name, row.langs); }
// Rebuild every selector from the library. Character rows are carried across so
// adding or removing a library voice never discards in-progress edits.
function refreshVoiceSelectors() {
    const rows = collectVoiceRows();
    renderVoiceLibrary(); renderDefaultVoices(); renderVoiceRows(rows); renderChatSwitcher();
}
click('library-sync', async () => {
    const entries = await fetchVoiceLibrary({ baseUrl: settings.baseUrl, apiKey });
    voiceLibrary = entries; settings.voiceLibrary = entries; save();
    refreshVoiceSelectors();
    log('INFO', '音色库已同步：' + entries.length + ' 个音色');
    $('status').textContent = '音色库已同步 ' + entries.length + ' 个音色';
});
click('lib-add', () => {
    const name = $('lib-name').value.trim(), id = $('lib-id').value.trim(), language = $('lib-lang').value;
    if (!id) throw new Error('请填写音色 ID');
    if (voiceLibrary.some(entry => entry.id === id)) throw new Error('该音色已在音色库中');
    voiceLibrary = voiceLibrary.concat([{ id, name: name || id, languages: language ? [language] : [], state: '' }]);
    settings.voiceLibrary = voiceLibrary; save();
    $('lib-name').value = ''; $('lib-id').value = ''; $('lib-lang').value = '';
    refreshVoiceSelectors(); log('INFO', '已添加音色 ' + (name || id));
});
click('preview-default', () => {
    if (queue.running && queue.current?.preview) { queue.stop(); return; }
    const language = settings.language === 'orig' ? 'zh' : settings.language;
    const voice = resolveVoice(language, settings.defaultVoice);
    const item = voicePreview({ voice, language, settings });
    queue.stop(); queue.enqueue([item]);
});
const chatSwitcher = document.createElement('div');
chatSwitcher.id = 'fa-chat-switcher';
function mountChatSwitcher() {
    const anchor = document.querySelector('#send_form');
    if (!anchor || chatSwitcher.isConnected) return;
    const label = document.createElement('span'); label.className = 'fa-switch-label'; label.textContent = '音色';
    chatSwitcher.replaceChildren(label);
    for (const language of VOICE_LANGUAGES) {
        const select = document.createElement('select'); select.className = 'text_pole fa-switch-select';
        select.dataset.lang = language; select.title = languageLabel(language) + '音色（仅本聊天生效）';
        select.addEventListener('change', async () => {
            select.disabled = true;
            try {
                const c = ctx();
                if (!c.chatMetadata) throw new Error('聊天元数据尚未加载，请稍后重试');
                c.chatMetadata.fish_dialogue ||= {};
                const config = c.chatMetadata.fish_dialogue.voice ||= {};
                if (select.value) config[language] = select.value; else delete config[language];
                stopAll(); await saveChatMetadata();
                log('INFO', languageLabel(language) + '音色已切换为 ' + (select.value || '角色默认'));
            } catch (e) { log('ERROR', e.message); }
            finally { select.disabled = false; renderChatSwitcher(); }
        });
        chatSwitcher.append(select);
    }
    anchor.before(chatSwitcher);
}
function renderChatSwitcher() {
    if (!chatSwitcher.isConnected) return;
    const config = chatVoiceConfig();
    for (const select of chatSwitcher.querySelectorAll('select')) fillSelect(select, select.dataset.lang, config[select.dataset.lang] || '');
}
renderVoiceLibrary(); renderDefaultVoices();
renderVoiceRows(Object.entries(settings.voices).map(([name, config]) => ({ name, langs: normalizeVoiceConfig(config) })));
mountChatSwitcher(); renderChatSwitcher();
async function synthesizeRaw(item, signal, update) {
        if (isBlocked(item.speaker, settings)) throw new Error('该角色已屏蔽，不会向 API 发送对白');
        
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
    const allowed = result.segments.filter(s => !isBlocked(s.speaker, settings));
    if (allowed.length !== result.segments.length) log('INFO', `角色屏蔽：跳过 ${result.segments.length - allowed.length} 段，不发送 API`);
    return allowed;
}
function enqueue(segments, replace = false, eager = false) {
    const items = segments.filter(s => !isBlocked(s.speaker, settings)).map(s => ({ ...s, voice: voiceFor(s, settings, chatVoiceConfig()), model: settings.model, baseUrl: settings.baseUrl }));
    if (items.some(x => !x.voice)) throw new Error('缺少音色：请先在“音色库”同步或添加音色，再在“角色音色”或聊天页选择');
    if (!items.length) return;
    if (queue.items.length + items.length > 100 && !replace) throw new Error('等待队列超过 100 句，请先播放或停止');
    if (replace) queue.stop();
    if (eager) for (const item of items) item.task = generator.submit(item);
    queue.enqueue(items);
}
function bind(id, name, checkbox = false) {
    $(id)[checkbox ? 'checked' : 'value'] = settings[name];
    $(id).addEventListener(checkbox ? 'change' : 'input', () => {
        const value = checkbox ? $(id).checked : $(id).value.trim();
        settings[name] = value; save();
        if (['baseUrl', 'model'].includes(name)) stopAll();
        if (name === 'auto' && !value) stopAll();
        if (name === 'blockEnabled' || name === 'blockedNames' || name === 'fallback') { stopAll(); inline?.schedule(); }
    });
}
bind('auto', 'auto', true); bind('fallback', 'fallback', true);
bind('block-enabled', 'blockEnabled', true); bind('block-names', 'blockedNames');
if (typeof settings.model !== 'string' || !settings.model.trim()) { settings.model=DEFAULTS.model; save(); }
bind('base', 'baseUrl'); bind('model', 'model'); bind('book', 'book');
$('language').value = settings.language;
$('key').value=apiKey;
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
    const id=ctx().chat.indexOf(message);
    const items=parsed(message.mes,message.name || ctx().name2,message.extra?.fish_dialogue?.language || settings.language)
        .map(s=>({...s,messageRef:message,uiKey:id+':'+s.block,voice:voiceFor(s,settings,chatVoiceConfig()),model:settings.model,baseUrl:settings.baseUrl}));
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
async function applyLanguage() {
    const w = await world(), name = settings.book;
    if (!w.world_names.includes(name)) throw new Error('请先安装世界书');
    const data = await w.loadWorldInfo(name);
    await writeBook(name, selectLanguage(data, $('language').value));
    stopAll(); settings.language = $('language').value; save();
    inline?.refresh();
    log('INFO', `世界书语言已切换为 ${settings.language}；对后续聊天生成生效`);
}
click('apply-language', applyLanguage);
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
        if (!segment || isBlocked(segment.speaker, settings)) return;
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
    if (c.eventTypes[event]) c.eventSource.on(c.eventTypes[event], () => { stopAll(); seen.clear(); inline.schedule(); renderChatSwitcher(); });
}
for (const event of ['MORE_MESSAGES_LOADED', 'CHAT_LOADED', 'APP_READY']) if (c.eventTypes[event]) c.eventSource.on(c.eventTypes[event], () => { inline.schedule(); mountChatSwitcher(); renderChatSwitcher(); });
$('audio').addEventListener('pause', () => inline.schedule());
window.addEventListener('pagehide', () => { stopAll(); clearInterval(progressTimer); inline.disconnect(); apiKey = ''; });
log('INFO', '1.4.7 已加载；请点“升级世界书”和“添加正则”，启用 Talk-Emo 协议。');
