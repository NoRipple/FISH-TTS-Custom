// The voice management dialog. It is a presentation layer only: every rule about
// groups, bulk activation, search and reference audio lives in voice-groups.mjs,
// ref-audio.mjs and voice-library.mjs so the same code can be tested in node.
//
// Design note. The host lets a theme restyle every `.menu_button` (this instance
// paints them as bare blue links) and the dialog inherits the theme tint, which is
// a warm cream here. So the dialog defines its own ink-on-washi palette and never
// dresses controls in `menu_button`: it reads as a printed voice booklet instead of
// a stack of link rows. All colours are scoped to #fa-voice-dialog in style.css.
import { collectGroupNames, groupEntries, addGroup, renameGroup, deleteGroup, assignGroup, toggleAll, removeEntries, setActive } from './voice-groups.mjs';
import { formatBytes } from './ref-audio.mjs';
import { searchVoices } from './voice-library.mjs';

const UNGROUPED = '未分组';
const TABS = [
    ['library', '音色库', '按作品分组的全部音色'],
    ['search', '搜索音色', '从 Fish 公开库添加'],
    ['clone', '快速克隆', '上传音频做一次性克隆'],
    ['settings', '设置', '连接、语言、运行与维护'],
];
// Titles are optional so callers that predate them keep working.
const TITLE = 'Fish 配音管理';

export function installVoicePanel(deps) {
    const {
        context, settings, log, save, library, setLibrary, refresh,
        preview, search, addClone, removeRef, clearRefs, refUsage,
        settingsHost = null, adoptSettings = null, title = TITLE,
    } = deps;
    let dialog = null, tab = 'library', selection = new Set(), results = [], lastQuery = '';
    let filter = '';
    // Collapsed groups survive a re-render, so ticking a voice does not spring a
    // group the user folded away back open.
    const collapsed = new Set();
    // The confirm/ask overlays live in the top layer next to the dialog.
    let askDialog = null, confirmDialog = null, formDialog = null;

    function groups() { return collectGroupNames(library(), Array.isArray(settings.voiceGroups) ? settings.voiceGroups : []); }
    function persistGroups(next) { settings.voiceGroups = next; save(); }

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
            else if (value !== undefined && value !== null) node.setAttribute(key, value);
        }
        node.append(...children.filter(Boolean));
        return node;
    }
    // The host treats a bare <button> in the settings drawer as a .menu_button, so
    // the dialog's own buttons are created already labelled with the -menu_button
    // class the stylesheet refuses to style.
    function button(label, onClick, extra = '') {
        return el('button', { class: 'fa-menu_button ' + extra, type: 'button', text: label, onclick: onClick });
    }
    function quiet(label, onClick, extra = '') {
        return el('button', { class: 'fa-menu_button fa-quiet ' + extra, type: 'button', text: label, onclick: onClick });
    }
    // A themed replacement for prompt() that carries several labelled fields at
    // once. `fields` is [{ key, label, value, multiline, hint }]; resolves to an
    // object keyed the same way, or null when cancelled.
    function askForm(title, fields, okLabel = '保存') {
        return new Promise(resolve => {
            formDialog?.remove();
            const inputs = {};
            const body = el('form', { method: 'dialog', class: 'fa-subdialog-body' });
            const head = el('div', { class: 'fa-subdialog-head' }, el('h4', { text: title }),
                quiet('取消', () => formDialog.close()));
            body.append(head);
            for (const field of fields) {
                const control = field.multiline
                    ? el('textarea', { class: 'fa-input', rows: '4' })
                    : el('input', { class: 'fa-input', type: 'text' });
                control.value = field.value ?? '';
                inputs[field.key] = control;
                body.append(el('div', { class: 'fa-field' },
                    el('label', { class: 'fa-field-label', text: field.label }), control,
                    field.hint ? hint(field.hint) : null));
            }
            let settled = false;
            body.append(el('div', { class: 'fa-actions fa-actions-end' },
                button(okLabel, () => {
                    settled = true;
                    const out = {};
                    for (const key of Object.keys(inputs)) out[key] = inputs[key].value;
                    resolve(out);
                    formDialog.close();
                }, 'fa-primary')));
            formDialog = el('dialog', { class: 'fa-subdialog fa-subdialog-wide', id: 'fa-subdialog-form' }, body);
            formDialog.addEventListener('close', () => { if (!settled) resolve(null); formDialog.remove(); });
            document.body.append(formDialog);
            formDialog.showModal();
            inputs[fields[0].key]?.focus();
            inputs[fields[0].key]?.select?.();
        });
    }

    // Group choice for the search tab. Typing a group name by hand was the
    // complaint; the plugin already knows every group, so offer them as a list
    // and keep a free-text box only as the "make a new group" escape hatch.
    function pickGroup(names, voiceName) {
        return new Promise(resolve => {
            formDialog?.remove();
            const select = el('select', { class: 'fa-input fa-select', id: 'fa-pick-group' },
                el('option', { value: '', text: UNGROUPED }),
                ...names.map(name => el('option', { value: name, text: name })));
            const fresh = el('input', { class: 'fa-input', type: 'text', placeholder: '或者输入一个新组名' });
            let settled = false;
            const body = el('form', { method: 'dialog', class: 'fa-subdialog-body' },
                el('div', { class: 'fa-subdialog-head' }, el('h4', { text: `把「${voiceName}」放到哪个组？` }),
                    quiet('取消', () => formDialog.close())),
                el('div', { class: 'fa-field' }, el('label', { class: 'fa-field-label', text: '已有分组' }), select),
                el('div', { class: 'fa-field' }, el('label', { class: 'fa-field-label', text: '新建分组' }), fresh,
                    hint('留空就是不加新组；选了上面的分组会忽略这里。')),
                el('div', { class: 'fa-actions fa-actions-end' },
                    button('确定', () => {
                        const typed = fresh.value.trim();
                        const chosen = typed || select.value;
                        if (typed && !names.includes(typed)) {
                            try { persistGroups(addGroup(settings.voiceGroups || [], typed)); }
                            catch (e) { log('ERROR', e.message); return; }
                        }
                        settled = true; resolve(chosen); formDialog.close();
                    }, 'fa-primary')));
            formDialog = el('dialog', { class: 'fa-subdialog', id: 'fa-subdialog-pick' }, body);
            formDialog.addEventListener('close', () => { if (!settled) resolve(null); formDialog.remove(); });
            document.body.append(formDialog);
            formDialog.showModal();
            select.focus();
        });
    }

    const renameRef = deps.renameRef || (async () => { throw new Error('当前构建不支持迁移参考音频'); });
    function hint(text) { return el('small', { class: 'fa-hint', text }); }
    function icon(name) { return el('i', { class: 'fa-solid ' + name, 'aria-hidden': 'true' }); }

    // A themed replacement for prompt(), which would paint the browser's own grey
    // box over a carefully styled dialog.
    function ask(title, defaultValue, multiline = false) {
        return new Promise(resolve => {
            askDialog?.remove();
            const input = multiline
                ? el('textarea', { class: 'fa-input', rows: '3' })
                : el('input', { class: 'fa-input', type: 'text' });
            input.value = defaultValue || '';
            const head = el('div', { class: 'fa-subdialog-head' }, el('h4', { text: title }), quiet('取消', () => askDialog.close()));
            let settled = false;
            askDialog = el('dialog', { class: 'fa-subdialog', id: 'fa-subdialog-ask' },
                el('form', { method: 'dialog', class: 'fa-subdialog-body' },
                    head, input,
                    el('div', { class: 'fa-actions fa-actions-end' },
                        button('确定', () => { settled = true; resolve(input.value); askDialog.close(); }))));
            askDialog.addEventListener('close', () => { if (!settled) resolve(null); askDialog.remove(); });
            document.body.append(askDialog);
            askDialog.showModal();
            input.focus();
            input.select?.();
        });
    }
    function confirmAction(title, detail) {
        return new Promise(resolve => {
            confirmDialog?.remove();
            const head = el('div', { class: 'fa-subdialog-head' }, el('h4', { text: title }), quiet('取消', () => confirmDialog.close()));
            let settled = false;
            confirmDialog = el('dialog', { class: 'fa-subdialog', id: 'fa-subdialog-confirm' },
                el('form', { method: 'dialog', class: 'fa-subdialog-body' },
                    head, el('p', { class: 'fa-subdialog-text', text: detail }),
                    el('div', { class: 'fa-actions fa-actions-end' },
                        button('确定', () => { settled = true; resolve(true); confirmDialog.close(); }, 'fa-danger'))));
            confirmDialog.addEventListener('close', () => { if (!settled) resolve(false); confirmDialog.remove(); });
            document.body.append(confirmDialog);
            confirmDialog.showModal();
        });
    }

    function ensureDialog() {
        if (dialog) return dialog;
        dialog = el('dialog', { class: 'fa-voice-dialog', id: 'fa-voice-dialog' });
        const title = el('div', { class: 'fa-head-titles' },
            el('span', { class: 'fa-head-kicker', text: 'FISH TTS' }),
            el('h3', { class: 'fa-head-title', text: title }));
        const syncBtn = deps.syncRoster
            ? el('button', {
                class: 'fa-menu_button fa-head-sync', type: 'button', title: '把当前音色库写入世界书的三语言名册条目',
                onclick: async () => {
                    try { const msg = await deps.syncRoster(); log('INFO', msg); }
                    catch (e) { log('ERROR', e.message); }
                },
            }, icon('fa-rotate'), el('span', { text: '同步名册到世界书' }))
            : null;
        const head = el('div', { class: 'fa-voice-dialog-head' }, title,
            el('div', { class: 'fa-head-tools' }, syncBtn,
                el('button', { class: 'fa-menu_button fa-head-close', type: 'button', title: '关闭（Esc）', text: '×', onclick: () => dialog.close() })));
        const tabs = el('div', { class: 'fa-voice-tabs', role: 'tablist' });
        for (const [key, label, blurb] of TABS) {
            const node = el('button', { class: 'fa-menu_button fa-tab', type: 'button', 'data-tab': key, title: blurb,
                onclick: () => { tab = key; render(); } },
                el('span', { class: 'fa-tab-label', text: label }),
                el('span', { class: 'fa-tab-blurb', text: blurb }));
            tabs.append(node);
        }
        dialog.append(head, tabs, el('div', { class: 'fa-voice-body' }), el('div', { class: 'fa-voice-foot' },
            el('span', { class: 'fa-foot-hint', text: 'Esc 关闭 · 点组名折叠 · 改动即时保存' })));
        document.body.append(dialog);
        return dialog;
    }

    function body() { return dialog.querySelector('.fa-voice-body'); }
    function footer() { return dialog.querySelector('.fa-voice-foot'); }

    function render() {
        if (!dialog) return;
        for (const node of dialog.querySelectorAll('.fa-voice-tabs .fa-tab')) node.classList.toggle('fa-tab-active', node.dataset.tab === tab);
        const host = body(); host.replaceChildren();
        footer().querySelector('.fa-foot-hint').textContent = tab === 'library'
            ? `${library().length} 个音色 · 点组名折叠 · 改动即时保存`
            : tab === 'search' ? '搜索走 Fish 公开库 · 添加只进本地库'
                : tab === 'clone' ? '一次性克隆 · 音频存在本浏览器 IndexedDB'
                    : '全部设置都在这里 · 改动即时保存';
        if (tab === 'library') renderLibrary(host);
        else if (tab === 'search') renderSearch(host);
        else if (tab === 'settings') renderSettings(host);
        else renderClone(host);
        // The settings tab owns the live controls, so the status chips only read
        // correctly once they live inside a rendered tab.
        deps.refresh?.();
    }

    // The whole settings form used to sit in SillyTavern's extension drawer. The
    // markup is still owned by index.js (its handlers bind by id at module load),
    // but the nodes are re-parented here, so the dialog is the only place to see
    // them. Moving nodes keeps every listener and every in-progress edit intact.
    function renderSettings(host) {
        if (!settingsHost) {
            host.append(hint('设置表单尚未就绪；请刷新页面后重试。'));
            return;
        }
        // The host builds its controls the first time it is shown; doing it here
        // keeps that work off the module-load path.
        if (!settingsHost.innerHTML.trim()) adoptSettings?.();
        host.append(settingsHost);
    }

    function renderLibrary(host) {
        const list = library();
        const names = collectGroupNames(list, settings.voiceGroups || []);
        const total = list.filter(Boolean).length;
        const activeCount = list.filter(e => e && e.active !== false).length;
        const shown = selection.size;

        // Toolbar: a search field, a selection readout and the bulk actions that
        // only make sense once something is ticked.
        // Filtering fires on submit (Enter or the button), never per keystroke:
        // re-rendering while typing stole the caret and made the field unusable.
        const searchBox = el('input', { class: 'fa-input fa-vsearch', type: 'search', placeholder: '按名字筛选，回车执行…', 'aria-label': '按名字筛选音色' });
        searchBox.value = filter;
        const runFilter = () => { filter = searchBox.value.trim(); selection = new Set(); render(); };
        searchBox.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); runFilter(); }
            if (event.key === 'Escape') { event.stopPropagation(); searchBox.value = ''; }
        });
        const clearFilter = quiet('清空', () => { filter = ''; selection = new Set(); render(); });
        const meta = el('div', { class: 'fa-toolbar-meta' },
            el('span', { class: 'fa-stat', text: `共 ${total} 个音色` }),
            el('span', { class: 'fa-stat', text: `已激活 ${activeCount}` }),
            shown ? el('span', { class: 'fa-stat fa-stat-on', text: `已勾选 ${shown}` }) : null);
        host.append(el('div', { class: 'fa-toolbar' }, searchBox, button('筛选', runFilter), filter ? clearFilter : null, meta));

        if (shown) {
            const target = el('select', { class: 'fa-input fa-select', id: 'fa-bulk-target' },
                ...[...names, ''].map(name => el('option', { value: name, text: name || UNGROUPED })));
            host.append(el('div', { class: 'fa-bulk' },
                el('div', { class: 'fa-bulk-head' }, icon('fa-check-double'), el('span', { text: `已勾选 ${shown} 个` }),
                    quiet('清空勾选', () => { selection = new Set(); render(); })),
                el('div', { class: 'fa-bulk-row' },
                    el('label', { class: 'fa-bulk-label' }, el('span', { text: '移动到' }), target),
                    button('移动', () => {
                        const chosen = dialog.querySelector('#fa-bulk-target').value;
                        const changed = assignGroup(list, [...selection], chosen);
                        setLibrary(list); log('INFO', `已移动 ${changed} 条音色到「${chosen || UNGROUPED}」`); refresh(); render();
                    }, 'fa-primary'),
                    quiet('批量启用', () => { setActive(list, [...selection], true); setLibrary(list); refresh(); render(); }),
                    quiet('批量禁用', () => { setActive(list, [...selection], false); setLibrary(list); refresh(); render(); }))));
        }

        const needle = filter.toLowerCase();
        const match = entry => !needle || (entry.name || '').toLowerCase().includes(needle) || (entry.id || '').toLowerCase().includes(needle);
        const { buckets, loose } = groupEntries(list, names);
        for (const bucket of buckets) {
            const entries = bucket.entries.filter(match);
            if (needle && !entries.length) continue;
            host.append(groupSection(bucket.name, entries, list));
        }
        host.append(groupSection(UNGROUPED, loose.filter(match), list, { loose: true }));
        if (needle && !list.some(match)) host.append(el('div', { class: 'fa-empty', text: `没有名字包含「${filter}」的音色。` }));
        if (!total) host.append(el('div', { class: 'fa-empty', text: '音色库是空的：可以点“导入内置音色（28）”或“从 Fish 同步”，也可以在“搜索音色”里找。' }));

        const nameInput = el('input', { class: 'fa-input', id: 'fa-group-name', placeholder: '新组名称，例如 鸣潮' });
        nameInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addGroupRow(); } });
        function addGroupRow() {
            try {
                persistGroups(addGroup(settings.voiceGroups || [], nameInput.value));
                nameInput.value = ''; render();
            } catch (e) { log('ERROR', e.message); }
        }
        host.append(el('div', { class: 'fa-newgroup' }, icon('fa-folder-plus'), nameInput, button('新建组', addGroupRow)));
    }

    function groupSection(name, entries, list, options = {}) {
        const folded = collapsed.has(name);
        const section = el('section', { class: 'fa-group' + (folded ? ' fa-group-folded' : '') });
        const activeInside = entries.filter(e => e.active !== false).length;
        const toggle = el('button', { class: 'fa-menu_button fa-group-toggle', type: 'button', title: folded ? '展开' : '折叠', 'aria-expanded': String(!folded) },
            icon('fa-chevron-down'));
        toggle.addEventListener('click', () => {
            if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name);
            render();
        });
        const ids = entries.map(e => e.id);
        const actions = el('div', { class: 'fa-group-actions' },
            quiet('全选', () => { for (const id of entries.map(e => e.id)) selection.add(id); render(); }),
            options.loose ? null : quiet('全部启用', () => { toggleAll(list, ids, 'enable'); setLibrary(list); refresh(); render(); }),
            options.loose ? null : quiet('全部禁用', () => { toggleAll(list, ids, 'disable'); setLibrary(list); refresh(); render(); }),
            options.loose ? null : quiet('改名', async () => {
                const next = await ask('新的组名', name);
                if (next == null) return;
                try {
                    const result = renameGroup(list, settings.voiceGroups || [], name, next);
                    collapsed.delete(name);
                    persistGroups(result.groups); setLibrary(list); refresh(); render();
                } catch (e) { log('ERROR', e.message); }
            }),
            options.loose ? null : quiet('删除组', async () => {
                if (!await confirmAction(`删除「${name}」？`, `组内 ${entries.length} 个音色会移到未分组，不会被删除。`)) return;
                const result = deleteGroup(list, settings.voiceGroups || [], name);
                persistGroups(result.groups); setLibrary(list); refresh(); render();
                log('INFO', `已删除组「${name}」，${result.moved} 条音色移至未分组`);
            }, 'fa-danger'));
        const head = el('div', { class: 'fa-group-head' },
            toggle,
            el('div', { class: 'fa-group-name', title: '点击折叠/展开', onclick: () => toggle.click() },
                el('span', { class: 'fa-group-title', text: name }),
                el('span', { class: 'fa-group-count', text: `${activeInside}/${entries.length}` })),
            actions);
        section.append(head);
        if (folded) return section;
        if (!entries.length) section.append(el('div', { class: 'fa-empty', text: options.loose ? '没有未分组的音色。' : '这个组还没有音色。可以从“搜索音色”添加，或勾选已有音色后移动过来。' }));
        for (const entry of entries) section.append(entryRow(entry, list));
        return section;
    }

    function entryRow(entry, list) {
        const row = el('div', { class: 'fa-voice-row' + (entry.active === false ? ' fa-row-off' : '') });
        const check = el('input', { type: 'checkbox', class: 'fa-tick', 'aria-label': '勾选' });
        check.checked = selection.has(entry.id);
        check.addEventListener('change', () => { if (check.checked) selection.add(entry.id); else selection.delete(entry.id); render(); });
        const active = el('input', { type: 'checkbox', class: 'fa-switch-input', title: '激活后才会同步到世界书名册并参与自动匹配', 'aria-label': '激活' });
        active.checked = entry.active !== false;
        active.addEventListener('change', () => { setActive(list, [entry.id], active.checked); setLibrary(list); refresh(); render(); });
        const name = el('input', { class: 'fa-input fa-name', 'aria-label': '音色名称' });
        name.value = entry.name || entry.id;
        name.addEventListener('change', () => {
            const value = name.value.trim();
            if (value) { entry.name = value; setLibrary(list); refresh(); } else name.value = entry.name || entry.id;
        });
        const tags = el('div', { class: 'fa-vtags' },
            ...(entry.languages?.length ? entry.languages : ['通用']).map(lang => el('span', { class: 'fa-vtag', text: lang })),
            entry.refAudio ? el('span', { class: 'fa-vtag fa-vtag-clone', text: '克隆 ' + formatBytes(entry.refAudio.bytes) }) : null,
            entry.active === false ? el('span', { class: 'fa-vtag fa-vtag-off', text: '未激活' }) : null);
        const tools = el('div', { class: 'fa-row-tools' },
            quiet('试听', () => { try { preview(entry); } catch (e) { log('ERROR', e.message); } }),
            quiet('编辑', async () => {
                const answer = await askForm(`编辑「${entry.name || entry.id}」`, [
                    { key: 'name', label: '音色名称', value: entry.name || entry.id },
                    { key: 'id', label: '音色 ID', value: entry.id, hint: '改成别的音频 ID 等于换成另一个音色；克隆音色的 ID 与本地参考音频绑定，改 ID 后需要重新导入音频。' },
                    { key: 'guide', label: '音色描述 / 使用指南', value: entry.guide || '', multiline: true,
                      hint: '这段说明会写进世界书名册，帮助模型挑对音色。' },
                ]);
                if (!answer) return;
                const nextName = answer.name.trim() || entry.id;
                const nextId = answer.id.trim();
                if (!nextId) { log('ERROR', '音色 ID 不能为空'); return; }
                if (nextId !== entry.id && list.some(e => e && e !== entry && e.id === nextId)) {
                    log('ERROR', `音色 ID「${nextId}」已被占用`); return;
                }
                entry.name = nextName;
                entry.guide = answer.guide.trim();
                if (nextId !== entry.id) {
                    if (entry.refAudio) {
                        // The audio blob is keyed by the old id; move it so the clone
                        // keeps working instead of silently losing its reference.
                        try { await renameRef(entry.id, nextId); }
                        catch (e) { log('ERROR', '参考音频迁移失败：' + e.message); return; }
                    }
                    entry.id = nextId;
                }
                setLibrary(list); refresh(); render();
                log('INFO', `已更新音色「${entry.name}」`);
            }),
            entry.refAudio ? quiet('逐字稿', async () => {
                const next = await ask('逐字稿（必须与音频里说的一字不差，含标点）', entry.refAudio.transcript || '', true);
                if (next == null) return;
                if (!next.trim()) { log('ERROR', '逐字稿不能为空'); return; }
                entry.refAudio.transcript = next.trim(); setLibrary(list); refresh(); log('INFO', '逐字稿已更新');
            }) : null,
            quiet('删除', async () => {
                if (!await confirmAction(`从音色库移除「${entry.name || entry.id}」？`, '只会从本地音色库移除，不会影响 Fish 账号。')) return;
                const next = removeEntries(list, [entry.id]);
                setLibrary(next);
                if (entry.refAudio) removeRef(entry.id).catch(e => log('ERROR', e.message));
                selection.delete(entry.id);
                refresh(); render();
            }, 'fa-danger'));
        row.append(el('label', { class: 'fa-pick' }, check), el('label', { class: 'fa-switch' }, active, el('span', { class: 'fa-switch-track' })), name, tags, tools);
        return row;
    }

    function renderSearch(host) {
        host.append(el('div', { class: 'fa-lead' },
            el('div', { class: 'fa-lead-title', text: '从 Fish 公开库取音' }),
            hint('搜的是全站公开音色，按相关度排序；添加后只进本地库，不会写进 Fish 账号。')));
        const input = el('input', { class: 'fa-input fa-vsearch', id: 'fa-search-title', type: 'search', placeholder: '关键词，例如 星穹铁道 / 少女' });
        input.value = lastQuery;
        const status = el('div', { class: 'fa-search-status' });
        const doSearch = async () => {
            lastQuery = input.value.trim();
            if (!lastQuery) { log('WARN', '请输入搜索关键词'); return; }
            input.value = lastQuery;
            status.textContent = '搜索中…';
            status.classList.add('fa-busy');
            try {
                const data = await search({ title: lastQuery });
                results = data.entries;
                status.classList.remove('fa-busy');
                status.textContent = `共 ${data.total} 个结果，显示前 ${results.length} 个`;
                renderResults();
            } catch (e) { status.classList.remove('fa-busy'); status.textContent = ''; log('ERROR', e.message); }
        };
        input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); doSearch(); } });
        host.append(el('div', { class: 'fa-vsearchbar' }, input, button('搜索', doSearch, 'fa-primary')));
        host.append(status);
        const listHost = el('div', { class: 'fa-search-results' }); host.append(listHost);
        function renderResults() {
            listHost.replaceChildren();
            if (!results.length) { listHost.append(el('div', { class: 'fa-empty', text: '没有结果，换个关键词试试。' })); return; }
            for (const item of results) {
                const head = el('div', { class: 'fa-search-head' },
                    el('span', { class: 'fa-search-name', text: item.name }),
                    el('span', { class: 'fa-vtags' },
                        ...(item.languages?.length ? item.languages : ['未标注']).map(lang => el('span', { class: 'fa-vtag', text: lang })),
                        item.taskCount ? el('span', { class: 'fa-vtag fa-vtag-count', text: '使用 ' + item.taskCount }) : null),
                    el('div', { class: 'fa-row-tools' },
                        quiet('试听', () => { try { preview({ id: item.id, name: item.name, languages: item.languages }); } catch (e) { log('ERROR', e.message); } }),
                        button('添加', async () => {
                            const names = groups();
                            const target = await pickGroup(names, item.name);
                            if (target == null) return;
                            const list = library();
                            const existing = list.find(entry => entry.id === item.id);
                            if (existing) existing.group = target;
                            else list.push({ ...item, group: target });
                            setLibrary(list); refresh(); log('INFO', `已添加音色「${item.name}」到「${target || UNGROUPED}」`);
                            render();
                        }, 'fa-primary')));
                listHost.append(el('div', { class: 'fa-search-row' }, head));
            }
        }
        if (results.length) { status.textContent = `上次结果 ${results.length} 个`; renderResults(); }
    }

    function renderClone(host) {
        host.append(el('div', { class: 'fa-lead' },
            el('div', { class: 'fa-lead-title', text: '用一段录音克隆音色' }),
            hint('一次性克隆：10–30 秒参考音频 + 逐字稿。服务器不保存任何东西，每次合成都随请求重新上传这段音频。')));
        // The native file input is kept for its picker but visually hidden: on a
        // themed chat an unstyled <input type=file> is a grey bar nobody notices.
        const file = el('input', { type: 'file', accept: 'audio/*', id: 'fa-clone-file', class: 'fa-file-input' });
        const name = el('input', { class: 'fa-input', id: 'fa-clone-name', placeholder: '名称（例如 丹恒）' });
        const language = el('select', { class: 'fa-input fa-select', id: 'fa-clone-lang' },
            el('option', { value: '', text: '通用' }), el('option', { value: 'zh', text: '中文' }),
            el('option', { value: 'ja', text: '日语' }), el('option', { value: 'en', text: '英语' }));
        const transcript = el('textarea', { class: 'fa-input fa-textarea', id: 'fa-clone-transcript', rows: '3', placeholder: '参考音频里说的原话，必须一字不差（含标点）' });
        const info = el('span', { class: 'fa-file-name', id: 'fa-clone-info', text: '尚未选择文件' });
        const pick = button('选择音频文件', () => file.click());
        file.addEventListener('change', () => {
            const picked = file.files?.[0];
            info.textContent = picked ? `${picked.name} · ${formatBytes(picked.size)}` : '尚未选择文件';
            info.classList.toggle('fa-file-picked', Boolean(picked));
        });
        host.append(el('div', { class: 'fa-card' },
            el('div', { class: 'fa-field' },
                el('label', { class: 'fa-field-label', text: '参考音频文件' }),
                el('div', { class: 'fa-file-row' }, icon('fa-waveform'), file, pick, info)),
            el('div', { class: 'fa-field' }, el('label', { class: 'fa-field-label', text: '名称' }), name),
            el('div', { class: 'fa-field' }, el('label', { class: 'fa-field-label', text: '语言' }), language),
            el('div', { class: 'fa-field' },
                el('label', { class: 'fa-field-label', text: '逐字稿（必填）' }), transcript,
                hint('必须和音频内容完全一致，包括标点。不一致会明显降低克隆音质——这是 Fish 的要求，不是本插件的限制。')),
            el('div', { class: 'fa-actions' },
                button('保存到音色库', async () => {
                    const picked = file.files?.[0];
                    try {
                        await addClone({ file: picked, name: name.value, language: language.value, transcript: transcript.value });
                        file.value = ''; transcript.value = ''; name.value = '';
                        info.textContent = '尚未选择文件'; info.classList.remove('fa-file-picked'); render();
                    } catch (e) { log('ERROR', e.message); }
                }, 'fa-primary'))));

        const usageHost = el('div', { class: 'fa-usage' });
        const cleanup = quiet('清理全部参考音频', async () => {
            if (!await confirmAction('清理全部参考音频？', '音色库条目会保留，但这些克隆音色将无法再合成，需要重新导入音频。')) return;
            try { const removed = await clearRefs(); log('INFO', `已清理 ${removed} 段参考音频`); render(); }
            catch (e) { log('ERROR', e.message); }
        }, 'fa-danger');
        host.append(el('div', { class: 'fa-card fa-card-muted' },
            el('div', { class: 'fa-card-head' }, icon('fa-vdatabase'), el('span', { class: 'fa-card-title', text: '存储与清理' })),
            usageHost, el('div', { class: 'fa-actions' }, cleanup),
            hint('参考音频存在当前浏览器的 IndexedDB 里，扩展无法写磁盘；清除站点数据会一并删除，换浏览器需要重新导入。')));
        refUsage().then(usage => {
            usageHost.replaceChildren(
                el('div', { class: 'fa-usage-num', text: formatBytes(usage.bytes) }),
                el('div', { class: 'fa-usage-label', text: `已存 ${usage.count} 段参考音频` }));
        }).catch(() => {});
    }

    return {
        open(startTab = 'library') { tab = startTab; const node = ensureDialog(); render(); if (!node.open) node.showModal(); },
        close() { dialog?.close(); },
        refresh() { if (dialog && dialog.open) render(); },
    };
}
