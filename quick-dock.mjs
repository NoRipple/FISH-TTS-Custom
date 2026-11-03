// Floating quick switch for the chat page.
//
// Three controls, mirroring the dock the user referenced:
//   · small round button — cycles 中 → 日 → 英. Each switch does three things at
//     once: set the synthesis language, mount the worldbook for that language and
//     push the voice roster into it.
//   · toggle — enables the plugin. Turning it off also unmounts the worldbook, so
//     a disabled plugin does not keep injecting its prompt entries.
//   · large round button — opens the voice manager dialog.
//
// Everything is injected (mount/unmount/language/sync) so this module never
// touches SillyTavern internals directly and stays testable.

const ORDER = ['zh', 'ja', 'en'];
export const LANG_LABEL = Object.freeze({ zh: '中', ja: '日', en: '英' });
export const LANG_NAME = Object.freeze({ zh: '中文', ja: '日语', en: '英语' });

// zh -> ja -> en -> zh
export function nextLanguage(current) {
    const index = ORDER.indexOf(current);
    return ORDER[index < 0 ? 0 : (index + 1) % ORDER.length];
}

// The dock stores the click position so it survives a reload on the same foot.
export function clampPosition(x, y, width, height, viewportWidth, viewportHeight, margin = 8) {
    const maxX = Math.max(margin, viewportWidth - width - margin);
    const maxY = Math.max(margin, viewportHeight - height - margin);
    return { x: Math.min(Math.max(margin, Number(x) || 0), maxX), y: Math.min(Math.max(margin, Number(y) || 0), maxY) };
}

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children) if (child != null) node.append(child);
    return node;
}

export function installDock(deps) {
    const {
        settings, save, log,
        setLanguage, // (language) => Promise<string>  applyLanguage
        mountBook, // (language) => Promise<string>
        unmountBook, // () => Promise<boolean>
        syncRoster, // () => Promise<string>
        openVoices, // () => void
        enabled = () => true, // () => boolean
        setEnabled = () => {}, // (boolean) => void
    } = deps;

    let dock = null, small, big, toggle;

    function paint() {
        if (!dock) return;
        const on = enabled();
        const language = ORDER.includes(settings.language) ? settings.language : 'zh';
        dock.classList.toggle('fa-dock-off', !on);
        small.textContent = LANG_LABEL[language];
        small.title = `当前：${LANG_NAME[language]} · 点击切换到${LANG_NAME[nextLanguage(language)]}`;
        small.disabled = !on;
        big.disabled = !on;
        toggle.checked = on;
        toggle.title = on ? 'Fish 对话音声：已开启（关闭会同时禁用世界书）' : 'Fish 对话音声：已关闭';
    }

    async function apply(next, reason) {
        try {
            await setLanguage(next);
            await mountBook(next);
            const msg = await syncRoster();
            log('INFO', `${reason}：${LANG_NAME[next]} · ${msg}`);
        } catch (error) {
            log('ERROR', `${reason}失败：${error.message}`);
        }
        paint();
    }

    async function build() {
        if (dock) return dock;
        small = el('button', {
            class: 'fa-dock-btn fa-dock-lang', type: 'button',
            onclick: async () => {
                const next = nextLanguage(ORDER.includes(settings.language) ? settings.language : 'zh');
                await apply(next, '切换到');
            },
        });
        toggle = el('input', { type: 'checkbox', class: 'fa-dock-toggle', id: 'fa-dock-enabled', 'aria-label': '启用 Fish 对话音声' });
        toggle.addEventListener('change', async () => {
            const on = toggle.checked;
            setEnabled(on);
            save();
            paint();
            try {
                if (on) {
                    await apply(ORDER.includes(settings.language) ? settings.language : 'zh', '启用并切到');
                } else {
                    const hidden = await unmountBook();
                    log('INFO', hidden ? 'Fish 已关闭，世界书已同时禁用' : 'Fish 已关闭；世界书本来就未挂载');
                }
            } catch (error) { log('ERROR', '切换启用状态失败：' + error.message); }
        });
        big = el('button', {
            class: 'fa-dock-btn fa-dock-open', type: 'button', text: '音', title: '打开音色管理',
            onclick: () => openVoices(),
        });
        dock = el('div', { class: 'fa-dock', id: 'fa-quick-dock' },
            small,
            el('label', { class: 'fa-dock-switch' }, toggle, el('span', { class: 'fa-dock-track' })),
            big);
        document.body.append(dock);
        paint();
        return dock;
    }

    return {
        mount() { build(); paint(); },
        refresh() { paint(); },
        destroy() { dock?.remove(); dock = null; },
    };
}
