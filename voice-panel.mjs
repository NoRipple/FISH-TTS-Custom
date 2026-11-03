// The voice management dialog. It is a presentation layer only: every rule about
// groups, bulk activation, search and reference audio lives in voice-groups.mjs,
// ref-audio.mjs and voice-library.mjs so the same code can be tested in node.
import { collectGroupNames, groupEntries, addGroup, renameGroup, deleteGroup, assignGroup, toggleAll, removeEntries, setActive } from './voice-groups.mjs';
import { formatBytes } from './ref-audio.mjs';
import { searchVoices } from './voice-library.mjs';

const UNGROUPED = '未分组';

export function installVoicePanel(deps) {
    const {
        context, settings, log, save, library, setLibrary, refresh,
        preview, search, addClone, removeRef, clearRefs, refUsage,
    } = deps;
    let dialog = null, tab = 'library', selection = new Set(), results = [], lastQuery = '';
    // Collapsed groups survive a re-render, so ticking a voice does not spring a
    // group the user folded away back open.
    const collapsed = new Set();

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
    function button(label, onClick, extra = '') {
        return el('button', { class: 'menu_button ' + extra, type: 'button', text: label, onclick: onClick });
    }
    function hint(text) { return el('small', { class: 'fa-hint', text }); }

    function ensureDialog() {
        if (dialog) return dialog;
        dialog = el('dialog', { class: 'fa-voice-dialog', id: 'fa-voice-dialog' });
        const header = el('div', { class: 'fa-voice-dialog-head' },
            el('h3', { text: '音色管理' }),
            button('关闭', () => dialog.close()));
        const tabs = el('div', { class: 'fa-voice-tabs' });
        for (const [key, label] of [['library', '音色库'], ['search', '搜索音色'], ['clone', '快速克隆']]) {
            const node = el('button', { class: 'menu_button', type: 'button', text: label, 'data-tab': key, onclick: () => { tab = key; render(); } });
            tabs.append(node);
        }
        dialog.append(header, tabs, el('div', { class: 'fa-voice-body' }));
        document.body.append(dialog);
        return dialog;
    }

    function body() { return dialog.querySelector('.fa-voice-body'); }

    function render() {
        if (!dialog) return;
        for (const node of dialog.querySelectorAll('.fa-voice-tabs button')) node.classList.toggle('fa-tab-active', node.dataset.tab === tab);
        const host = body(); host.replaceChildren();
        if (tab === 'library') renderLibrary(host);
        else if (tab === 'search') renderSearch(host);
        else renderClone(host);
    }

    function renderLibrary(host) {
        const list = library();
        const names = collectGroupNames(list, settings.voiceGroups || []);
        const { buckets, loose } = groupEntries(list, names);
        host.append(hint('勾选后可批量移动到某个组或批量启用/禁用。点组名可以折叠/展开。删除组只把成员移到未分组，不会删除音色。'));
        const bulk = el('div', { class: 'fa-row fa-bulk' },
            button('全选本页', () => { selection = new Set(list.filter(Boolean).map(e => e.id)); render(); }),
            button('清空勾选', () => { selection = new Set(); render(); }),
            el('select', { class: 'text_pole', id: 'fa-bulk-target' },
                ...[...names, ''].map(name => el('option', { value: name, text: name || UNGROUPED }))),
            button('移动到所选组', () => {
                const target = dialog.querySelector('#fa-bulk-target').value;
                if (!selection.size) { log('WARN', '请先勾选音色'); return; }
                const changed = assignGroup(list, [...selection], target);
                setLibrary(list); log('INFO', `已移动 ${changed} 条音色到「${target || UNGROUPED}」`); refresh(); render();
            }),
            button('批量启用', () => { setActive(list, [...selection], true); setLibrary(list); refresh(); render(); }),
            button('批量禁用', () => { setActive(list, [...selection], false); setLibrary(list); refresh(); render(); }));
        host.append(bulk);

        for (const bucket of buckets) {
            const section = el('div', { class: 'fa-group' });
            const ids = bucket.entries.map(e => e.id);
            const folded = collapsed.has(bucket.name);
            if (folded) section.classList.add('fa-group-folded');
            const toggle = el('button', { class: 'fa-group-toggle', type: 'button', title: folded ? '展开这个组' : '折叠这个组', text: folded ? '▶' : '▼' });
            toggle.addEventListener('click', () => {
                if (collapsed.has(bucket.name)) collapsed.delete(bucket.name); else collapsed.add(bucket.name);
                render();
            });
            const head = el('div', { class: 'fa-group-head' },
                toggle,
                el('b', { class: 'fa-group-name', text: bucket.name, title: '点击折叠/展开', onclick: () => { toggle.click(); } }),
                el('small', { class: 'fa-group-count', text: `${bucket.entries.filter(e => e.active !== false).length}/${bucket.entries.length}` }),
                button('全选', () => { for (const id of ids) selection.add(id); render(); }),
                button('全部启用', () => { toggleAll(list, ids, 'enable'); setLibrary(list); refresh(); render(); }),
                button('全部禁用', () => { toggleAll(list, ids, 'disable'); setLibrary(list); refresh(); render(); }),
                button('改名', () => {
                    const next = prompt('新的组名', bucket.name);
                    if (next == null) return;
                    try {
                        const result = renameGroup(list, settings.voiceGroups || [], bucket.name, next);
                        persistGroups(result.groups); setLibrary(list); refresh(); render();
                    } catch (e) { log('ERROR', e.message); }
                }),
                button('删除组', () => {
                    if (!confirm(`删除「${bucket.name}」？组内 ${bucket.entries.length} 个音色会移到未分组，不会被删除。`)) return;
                    const result = deleteGroup(list, settings.voiceGroups || [], bucket.name);
                    persistGroups(result.groups); setLibrary(list); refresh(); render();
                    log('INFO', `已删除组「${bucket.name}」，${result.moved} 条音色移至未分组`);
                }, 'fa-btn-danger'));
            section.append(head);
            if (folded) { host.append(section); continue; }
            if (!bucket.entries.length) section.append(el('div', { class: 'fa-empty', text: '这个组还没有音色。可以从“搜索音色”添加，或勾选已有音色后移动过来。' }));
            for (const entry of bucket.entries) section.append(entryRow(entry, list));
            host.append(section);
        }

        const looseFolded = collapsed.has(UNGROUPED);
        const looseSection = el('div', { class: 'fa-group' + (looseFolded ? ' fa-group-folded' : '') });
        const looseToggle = el('button', { class: 'fa-group-toggle', type: 'button', title: looseFolded ? '展开这个组' : '折叠这个组', text: looseFolded ? '▶' : '▼' });
        looseToggle.addEventListener('click', () => {
            if (collapsed.has(UNGROUPED)) collapsed.delete(UNGROUPED); else collapsed.add(UNGROUPED);
            render();
        });
        looseSection.append(el('div', { class: 'fa-group-head' }, looseToggle,
            el('b', { class: 'fa-group-name', text: UNGROUPED, title: '点击折叠/展开', onclick: () => { looseToggle.click(); } }),
            el('small', { class: 'fa-group-count', text: String(loose.length) })));
        if (!looseFolded) {
            for (const entry of loose) looseSection.append(entryRow(entry, list));
            if (!loose.length) looseSection.append(el('div', { class: 'fa-empty', text: '没有未分组的音色。' }));
        }
        host.append(looseSection);

        const adder = el('div', { class: 'fa-row' },
            el('input', { class: 'text_pole', id: 'fa-group-name', placeholder: '新组名称' }),
            button('新建组', () => {
                const input = dialog.querySelector('#fa-group-name');
                try {
                    persistGroups(addGroup(settings.voiceGroups || [], input.value));
                    input.value = ''; render();
                } catch (e) { log('ERROR', e.message); }
            }));
        host.append(adder);

        if (!list.length) host.append(el('div', { class: 'fa-empty', text: '音色库是空的：可以点“导入内置音色（28）”或“从 Fish 同步”，也可以在“搜索音色”里找。' }));
    }

    function entryRow(entry, list) {
        const row = el('div', { class: 'fa-lib-item' + (entry.active === false ? ' fa-inactive' : '') });
        const head = el('div', { class: 'fa-lib-head' });
        const check = el('input', { type: 'checkbox' });
        check.checked = selection.has(entry.id);
        check.addEventListener('change', () => { if (check.checked) selection.add(entry.id); else selection.delete(entry.id); });
        const active = el('input', { type: 'checkbox', title: '激活后才会同步到世界书名册并参与自动匹配' });
        active.checked = entry.active !== false;
        active.addEventListener('change', () => { setActive(list, [entry.id], active.checked); setLibrary(list); refresh(); });
        const name = el('input', { class: 'text_pole fa-lib-name' });
        name.value = entry.name || entry.id;
        name.addEventListener('change', () => {
            const value = name.value.trim();
            if (value) { entry.name = value; setLibrary(list); refresh(); } else name.value = entry.name || entry.id;
        });
        const meta = el('small', {
            text: (entry.languages?.length ? entry.languages.join('/') : '通用')
                + (entry.refAudio ? ' · 一次性克隆 ' + formatBytes(entry.refAudio.bytes) : '')
                + (entry.active === false ? ' · 未激活' : ''),
        });
        head.append(check, active, name, meta);
        head.append(button('试听', () => { try { preview(entry); } catch (e) { log('ERROR', e.message); } }));
        if (entry.refAudio) {
            head.append(button('重填逐字稿', () => {
                const next = prompt('逐字稿（必须与参考音频里说的一字不差，含标点）', entry.refAudio.transcript || '');
                if (next == null) return;
                if (!next.trim()) { log('ERROR', '逐字稿不能为空'); return; }
                entry.refAudio.transcript = next.trim(); setLibrary(list); refresh(); log('INFO', '逐字稿已更新');
            }));
        }
        head.append(button('删除', () => {
            if (!confirm(`从音色库移除「${entry.name || entry.id}」？`)) return;
            const next = removeEntries(list, [entry.id]);
            setLibrary(next);
            if (entry.refAudio) removeRef(entry.id).catch(e => log('ERROR', e.message));
            refresh(); render();
        }, 'fa-btn-danger'));
        row.append(head);
        return row;
    }

    function renderSearch(host) {
        host.append(hint('搜索 Fish 公开音色库（不传 self，即全站公开音色），按使用量排序。添加后只进入你的本地库，不会写入 Fish 账号。'));
        const input = el('input', { class: 'text_pole', id: 'fa-search-title', placeholder: '关键词，例如 星穹铁道 / 少女' });
        input.value = lastQuery;
        const doSearch = async () => {
            lastQuery = input.value.trim();
            if (!lastQuery) { log('WARN', '请输入搜索关键词'); return; }
            const status = dialog.querySelector('#fa-search-status');
            status.textContent = '搜索中…';
            try {
                const data = await search({ title: lastQuery });
                results = data.entries;
                status.textContent = `共 ${data.total} 个结果，显示前 ${results.length} 个`;
                renderResults();
            } catch (e) { status.textContent = ''; log('ERROR', e.message); }
        };
        input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); doSearch(); } });
        host.append(el('div', { class: 'fa-row' }, input, button('搜索', doSearch)));
        host.append(el('small', { class: 'fa-hint', id: 'fa-search-status', text: results.length ? `上次结果 ${results.length} 个` : '' }));
        const listHost = el('div', { id: 'fa-search-results' }); host.append(listHost);
        function renderResults() {
            listHost.replaceChildren();
            if (!results.length) { listHost.append(el('div', { class: 'fa-empty', text: '没有结果，换个关键词试试。' })); return; }
            for (const item of results) {
                const row = el('div', { class: 'fa-lib-item' });
                const head = el('div', { class: 'fa-lib-head' },
                    el('span', { class: 'fa-search-name', text: item.name }),
                    el('small', { text: (item.languages?.length ? item.languages.join('/') : '未标注语言') + (item.taskCount ? ' · 使用 ' + item.taskCount : '') }));
                head.append(button('试听', () => { try { preview({ id: item.id, name: item.name, languages: item.languages }); } catch (e) { log('ERROR', e.message); } }));
                head.append(button('添加', () => {
                    const names = groups();
                    const answer = prompt('添加到哪个组？（留空 = 未分组）\n可选：' + [...names].join(' / '), names[0] || '');
                    if (answer == null) return;
                    const target = answer.trim();
                    if (target && !names.includes(target)) {
                        try { persistGroups(addGroup(settings.voiceGroups || [], target)); } catch (e) { log('ERROR', e.message); return; }
                    }
                    const list = library();
                    const existing = list.find(entry => entry.id === item.id);
                    if (existing) existing.group = target;
                    else list.push({ ...item, group: target });
                    setLibrary(list); refresh(); log('INFO', `已添加音色「${item.name}」到「${target || UNGROUPED}」`);
                    render();
                }));
                row.append(head);
                listHost.append(row);
            }
        }
        if (results.length) renderResults();
    }

    function renderClone(host) {
        host.append(hint('一次性克隆：上传一段 10–30 秒的参考音频并填写逐字稿。参照 Fish 的 one-shot 模式，服务器不保存任何东西，每次合成都会随请求重新上传这段音频。'));
        // The native file input is kept for its file picker but hidden by CSS: on a
        // dark theme an unstyled <input type=file> shows only the browser's default
        // grey text, which reads as "there is no way to pick a file".
        const file = el('input', { type: 'file', accept: 'audio/*', id: 'fa-clone-file', class: 'fa-file-input' });
        const name = el('input', { class: 'text_pole', id: 'fa-clone-name', placeholder: '名称（例如 丹恒）' });
        const language = el('select', { class: 'text_pole', id: 'fa-clone-lang' },
            el('option', { value: '', text: '通用' }), el('option', { value: 'zh', text: '中文' }),
            el('option', { value: 'ja', text: '日语' }), el('option', { value: 'en', text: '英语' }));
        const transcript = el('textarea', { class: 'text_pole', id: 'fa-clone-transcript', rows: '3', placeholder: '逐字稿：参考音频里说的原话，必须一字不差（含标点）' });
        const info = el('span', { class: 'fa-file-name', id: 'fa-clone-info', text: '尚未选择文件' });
        const pick = button('选择音频文件', () => file.click());
        file.addEventListener('change', () => {
            const picked = file.files?.[0];
            info.textContent = picked ? `${picked.name} · ${formatBytes(picked.size)}` : '尚未选择文件';
            info.classList.toggle('fa-file-picked', Boolean(picked));
        });
        host.append(el('div', { class: 'fa-field' },
            el('label', { class: 'fa-field-label', text: '参考音频文件' }),
            el('div', { class: 'fa-file-row' }, file, pick, info)));
        host.append(el('div', { class: 'fa-field' },
            el('label', { class: 'fa-field-label', text: '名称' }), name));
        host.append(el('div', { class: 'fa-field' },
            el('label', { class: 'fa-field-label', text: '语言' }), language));
        host.append(el('div', { class: 'fa-field' },
            el('label', { class: 'fa-field-label', text: '逐字稿（必填）' }), transcript));
        host.append(hint('逐字稿必须和音频内容完全一致，包括标点。不一致会明显降低克隆音质——这是 Fish 的要求，不是本插件的限制。'));
        host.append(el('div', { class: 'fa-row' },
            button('保存到音色库', async () => {
                const picked = file.files?.[0];
                try { await addClone({ file: picked, name: name.value, language: language.value, transcript: transcript.value }); file.value = ''; transcript.value = ''; name.value = ''; info.textContent = '尚未选择文件'; info.classList.remove('fa-file-picked'); render(); }
                catch (e) { log('ERROR', e.message); }
            })));
        const usageHost = el('div', { class: 'fa-row', id: 'fa-ref-usage' });
        const cleanup = button('清理全部参考音频', async () => {
            if (!confirm('删除所有已保存的参考音频？音色库条目会保留，但这些克隆音色将无法再合成，需要重新导入音频。')) return;
            try { const removed = await clearRefs(); log('INFO', `已清理 ${removed} 段参考音频`); render(); }
            catch (e) { log('ERROR', e.message); }
        }, 'fa-btn-danger');
        host.append(el('div', { class: 'fa-sub' }, el('div', { class: 'fa-subhead', text: '存储与清理' }), usageHost, el('div', { class: 'fa-row' }, cleanup),
            hint('参考音频保存在当前浏览器的 IndexedDB 中，扩展无法写入磁盘。清除网站数据会一并删除；换浏览器需要重新导入。')));
        refUsage().then(usage => { usageHost.textContent = `已存 ${usage.count} 段，占用 ${formatBytes(usage.bytes)}`; }).catch(() => {});
    }

    return {
        open(startTab = 'library') { tab = startTab; const node = ensureDialog(); render(); if (!node.open) node.showModal(); },
        close() { dialog?.close(); },
        refresh() { if (dialog) render(); },
    };
}
