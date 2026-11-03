// Floating quick switch for the chat page.
//
// Layout follows the Outfit-Manager FAB the user pointed at: one draggable round
// button pinned bottom-right, with its satellite buttons stacked to the LEFT of
// it. Styling is written inline with !important because SillyTavern themes ship
// high-specificity rules for button/label/input that win against stylesheets.
//
//   · satellite 1 (▶/⏸) — enables the plugin. Turning it off also unmounts the
//     worldbook, so a disabled plugin stops injecting its prompt entries.
//   · satellite 2 (中/日/英) — cycles the language. Each switch does three things
//     at once: set the synthesis language, mount that language's worldbook and
//     push the voice roster into it.
//   · main button — opens the Fish voice manager dialog.
//
// Everything is injected (mount/unmount/language/sync) so this module never
// touches SillyTavern internals directly and stays testable.

const ORDER = ['zh', 'ja', 'en'];
export const LANG_LABEL = Object.freeze({ zh: '中', ja: '日', en: '英' });
export const LANG_NAME = Object.freeze({ zh: '中文', ja: '日语', en: '英语' });

export const MAIN_SIZE = 38;
const ACCENT = 'var(--SmartThemeQuoteColor, #b0442c)';

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

// Default resting place, measured from the bottom-right corner.
export function defaultPosition(viewportWidth, viewportHeight, size = MAIN_SIZE) {
    return { x: Math.max(10, viewportWidth - 16 - size), y: Math.max(10, viewportHeight - 80 - size) };
}

// One round satellite that hugs the left edge of the main button.
function satelliteStyle(offset, size) {
    return [
        'position:absolute',
        `right:calc(100% + ${offset}px)`,
        'top:0',
        'bottom:0',
        'margin:auto 0',
        `width:${size}px`,
        `height:${size}px`,
        'border-radius:50%',
        'flex-shrink:0',
        'background:rgba(0,0,0,.42)',
        'border:1px solid rgba(255,255,255,.26)',
        'color:#fff',
        'cursor:pointer',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'box-shadow:0 2px 8px rgba(0,0,0,.3)',
        'pointer-events:auto',
        'transition:transform .15s ease, background .15s ease',
        'padding:0',
        'line-height:1',
        'touch-action:none',
    ].map((rule) => `${rule} !important`).join(';');
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

    let dock = null;
    let main = null;
    let langBtn = null;
    let powerBtn = null;
    let resizeBound = false;

    function language() {
        return ORDER.includes(settings.language) ? settings.language : 'zh';
    }

    function place(x, y) {
        const size = MAIN_SIZE;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const base = defaultPosition(vw, vh, size);
        const spot = clampPosition(
            Number.isFinite(x) ? x : base.x,
            Number.isFinite(y) ? y : base.y,
            size, size, vw, vh,
        );
        dock.style.setProperty('left', `${spot.x}px`, 'important');
        dock.style.setProperty('top', `${spot.y}px`, 'important');
        return spot;
    }

    function paint() {
        if (!dock) return;
        const on = enabled();
        const lang = language();
        powerBtn.innerHTML = `<i class="fa-solid ${on ? 'fa-toggle-on' : 'fa-toggle-off'}" style="pointer-events:none;font-size:13px;color:${on ? ACCENT : '#9a9a9a'};"></i>`;
        powerBtn.title = on ? 'Fish 对话音声：已开启 · 点击关闭（会同时禁用世界书）' : 'Fish 对话音声：已关闭 · 点击开启';
        powerBtn.style.setProperty('opacity', on ? '1' : '.75', 'important');
        langBtn.textContent = LANG_LABEL[lang];
        langBtn.title = `当前：${LANG_NAME[lang]} · 点击切换到${LANG_NAME[nextLanguage(lang)]}`;
        langBtn.style.setProperty('opacity', on ? '1' : '.45', 'important');
        langBtn.style.setProperty('cursor', on ? 'pointer' : 'not-allowed', 'important');
        main.title = 'Fish 配音管理';
        main.style.setProperty('opacity', on ? '.92' : '.6', 'important');
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

    // Drag with a 5px dead zone so a slightly shaky click is still a click.
    const drag = { active: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };
    function startDrag(x, y) {
        const rect = dock.getBoundingClientRect();
        drag.active = true; drag.moved = false;
        drag.sx = x; drag.sy = y; drag.ox = rect.left; drag.oy = rect.top;
    }
    function moveDrag(x, y) {
        if (!drag.active) return;
        const dx = x - drag.sx;
        const dy = y - drag.sy;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) drag.moved = true;
        if (!drag.moved) return;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const nx = Math.max(0, Math.min(drag.ox + dx, vw - MAIN_SIZE));
        const ny = Math.max(0, Math.min(drag.oy + dy, vh - MAIN_SIZE));
        dock.style.setProperty('left', `${nx}px`, 'important');
        dock.style.setProperty('top', `${ny}px`, 'important');
    }
    function endDrag() {
        if (!drag.active) return;
        drag.active = false;
        if (!drag.moved) return;
        const rect = dock.getBoundingClientRect();
        settings.dockPos = { top: Math.round(rect.top), left: Math.round(rect.left) };
        save();
    }

    function build() {
        if (dock) return dock;

        powerBtn = document.createElement('div');
        powerBtn.className = 'fa-dock-power';
        powerBtn.setAttribute('role', 'button');
        powerBtn.setAttribute('style', satelliteStyle(6, 22));
        powerBtn.addEventListener('click', async (event) => {
            event.stopPropagation();
            if (drag.moved) return;
            const on = !enabled();
            setEnabled(on);
            save();
            paint();
            try {
                if (on) await apply(language(), '启用并切到');
                else {
                    const hidden = await unmountBook();
                    log('INFO', hidden ? 'Fish 已关闭，世界书已同时禁用' : 'Fish 已关闭；世界书本来就未挂载');
                }
            } catch (error) { log('ERROR', `切换启用状态失败：${error.message}`); }
            paint();
        });

        langBtn = document.createElement('div');
        langBtn.className = 'fa-dock-lang';
        langBtn.setAttribute('role', 'button');
        langBtn.setAttribute('style', `${satelliteStyle(34, 22)};font-family:var(--monoFontFamily, ui-monospace, monospace) !important;font-size:11px !important;font-weight:600 !important;line-height:1 !important;`);
        langBtn.addEventListener('click', async (event) => {
            event.stopPropagation();
            if (drag.moved) return;
            if (!enabled()) { log('WARN', 'Fish 对话音声已关闭，先打开开关再切语言'); return; }
            await apply(nextLanguage(language()), '切换到');
        });

        main = document.createElement('div');
        main.className = 'fa-dock-main';
        main.id = 'fa-dock-main';
        main.innerHTML = '<i class="fa-solid fa-headphones" style="pointer-events:none;font-size:1em;"></i>';
        main.setAttribute('style', [
            `width:${MAIN_SIZE}px`, `height:${MAIN_SIZE}px`,
            'border-radius:50%',
            `background:${ACCENT}`,
            'color:#fff',
            'border:none',
            'cursor:pointer',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'box-shadow:0 4px 16px rgba(0,0,0,.35)',
            'pointer-events:auto',
            'touch-action:none',
            'font-size:.95em',
            'user-select:none',
        ].map((rule) => `${rule} !important`).join(';'));
        main.addEventListener('click', (event) => {
            event.stopPropagation();
            if (drag.moved) { drag.moved = false; return; }
            openVoices();
        });

        main.addEventListener('touchstart', (event) => {
            const touch = event.touches[0];
            if (touch) startDrag(touch.clientX, touch.clientY);
        }, { passive: true });
        main.addEventListener('touchmove', (event) => {
            const touch = event.touches[0];
            if (touch) moveDrag(touch.clientX, touch.clientY);
        }, { passive: true });
        main.addEventListener('touchend', endDrag);
        main.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            startDrag(event.clientX, event.clientY);
        });
        window.addEventListener('mousemove', (event) => moveDrag(event.clientX, event.clientY));
        window.addEventListener('mouseup', endDrag);

        dock = document.createElement('div');
        dock.id = 'fa-quick-dock';
        dock.className = 'fa-quick-dock';
        dock.setAttribute('style', [
            'position:fixed',
            'top:0', 'left:0',
            'z-index:2147483647',
            'display:flex',
            'align-items:center',
            'pointer-events:none',
            'margin:0',
            'padding:0',
        ].map((rule) => `${rule} !important`).join(';'));
        dock.append(langBtn, powerBtn, main);
        document.body.append(dock);

        const saved = settings.dockPos;
        place(saved?.left, saved?.top);
        paint();
        return dock;
    }

    return {
        mount() {
            build();
            // Re-place on resize so the ball never drifts off-screen.
            if (!resizeBound) {
                resizeBound = true;
                window.addEventListener('resize', () => { if (dock) place(...currentPos()); });
            }
            paint();
        },
        refresh() { paint(); },
        destroy() {
            dock?.remove();
            dock = null;
            main = null;
            langBtn = null;
            powerBtn = null;
        },
    };

    function currentPos() {
        const rect = dock.getBoundingClientRect();
        return [rect.left, rect.top];
    }
}
