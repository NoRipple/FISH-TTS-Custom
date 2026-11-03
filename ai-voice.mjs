// Two providers that have nothing in common except being "call an AI with audio":
// Ali's speech recognition (turns a clone's reference audio into a transcript) and
// SillyTavern's own chat backend (writes a voice description). No DOM in here, so
// node can test the request shapes without a browser.

// ---- 逐字稿：阿里百炼 qwen-audio-3.1-asr-flash -------------------------------
// The name in the console's sample (qwen-audio-3.1-asr-flash-message) does not
// exist; every attempt answers {"code":"InvalidParameter","message":"url error,
// please check url！"}. The working one is the non -message model below.
export const ASR_MODEL = 'qwen-audio-3.1-asr-flash';
export const ASR_HOST = 'llm-eh6pmwfsrdyx9qxw.cn-beijing.maas.aliyuncs.com';
const ASR_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

const MIME_BY_EXT = {
    mp3: 'audio/mpeg', mpeg: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    oga: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'audio/mp4',
    webm: 'audio/webm', aac: 'audio/aac',
};
const FORMAT_BY_MIME = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
    'audio/mp4': 'mp4', 'audio/m4a': 'mp4', 'audio/x-m4a': 'mp4', 'audio/aac': 'aac',
    'audio/webm': 'webm', 'audio/amr': 'amr',
};
// Bailian takes hints, not a hard switch; anything outside this set is dropped.
const ASR_HINTS = ['zh', 'en', 'ja', 'yue', 'ko'];

export function audioFormat(type, name = '') {
    const clean = String(type || '').toLowerCase().split(';')[0].trim();
    if (FORMAT_BY_MIME[clean]) return FORMAT_BY_MIME[clean];
    const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    return (ext && MIME_BY_EXT[ext]) ? (FORMAT_BY_MIME[MIME_BY_EXT[ext]] || ext) : 'mp3';
}

export function mimeFor(format) {
    for (const [mime, fmt] of Object.entries(FORMAT_BY_MIME)) if (fmt === format) return mime;
    return 'audio/mpeg';
}

// '通用' has no hint of its own: announcing "this is Chinese" for an English clip
// makes the model hallucinate a translation. An unknown tag falls back to zh,
// which matches how the rest of the plugin treats a blank language.
export function languageHints(language) {
    const value = String(language || '').trim();
    if (!value) return [];
    const tag = value === 'orig' ? 'zh' : value;
    return ASR_HINTS.includes(tag) ? [tag] : ['zh'];
}

export function asrEndpoint(host) {
    return 'https://' + String(host || ASR_HOST).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') + ASR_PATH;
}

export function asrRequest({ base64, mime = 'audio/mpeg', language = '', vocabulary = [], host = ASR_HOST, model = ASR_MODEL }) {
    const data = String(base64 || '');
    if (!data) throw new Error('参考音频是空的，请重新选择文件');
    const parameters = { format: audioFormat(mime) };
    const hints = languageHints(language);
    if (hints.length) parameters.language_hints = hints;
    // An explicit word list is honoured; an empty one is left out entirely so the
    // model is not nudged towards a blank vocabulary.
    const words = (Array.isArray(vocabulary) ? vocabulary : []).map(w => String(w).trim()).filter(Boolean);
    if (words.length) parameters.vocabulary = words.slice(0, 100);
    return {
        url: asrEndpoint(host),
        options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: '' },
            body: JSON.stringify({
                model: String(model || ASR_MODEL).trim(),
                input: {
                    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:' + mime + ';base64,' + data } }] }],
                },
                parameters,
            }),
        },
    };
}

export function asrText(payload) {
    const text = payload?.output?.text ?? payload?.output?.output?.text ?? payload?.output?.sentence?.text ?? '';
    return typeof text === 'string' ? text.trim() : '';
}

export function asrErrorText(status, payload) {
    const code = payload?.code || payload?.output?.code || '';
    const message = payload?.message || payload?.output?.message || '';
    if (code === 'InvalidApiKey' || status === 401 || status === 403) return '百炼密钥无效或没有权限（HTTP ' + status + '）：请到设置页「连接」里检查 ASR 密钥';
    if (status === 429 || /Throttling|limit/i.test(code)) return '百炼调用超额或太频繁（HTTP 429），请稍后再试';
    if (status === 404 || /url error/i.test(message)) return '百炼接口地址或模型名不对（HTTP ' + status + '）：' + (message || '请检查模型名 ' + ASR_MODEL);
    return '逐字稿识别失败：HTTP ' + status + ' ' + (message || code || '');
}

// Everything expensive happens here: read the blob, base64 it, post it. The
// caller only decides where the text lands.
export async function transcribeAudio(blob, { apiKey, language = '', host = ASR_HOST, model = ASR_MODEL, vocabulary = [], fetcher = fetch, signal = null } = {}) {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error('还没有填写百炼 ASR 密钥，请到设置页「连接」里填写后重试');
    if (!blob || !blob.size) throw new Error('参考音频是空的，请重新选择文件');
    if (blob.size > 20 * 1024 * 1024) throw new Error('音频超过 20 MB，百炼不接受这么大的底座音频，请换一段更短的');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    signal?.throwIfAborted?.();
    const base64 = await bytesToBase64(bytes);
    const request = asrRequest({ base64, mime: blob.type || mimeFor(audioFormat('', '')), language, vocabulary, host, model });
    request.options.headers.Authorization = 'Bearer ' + key;
    const response = await fetcher(request.url, { ...request.options, signal });
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok) throw new Error(asrErrorText(response.status, payload));
    const text = asrText(payload);
    if (!text) throw new Error('百炼没有返回转写结果（响应里没有 output.text），请换一段更清晰的音频再试');
    return { text, raw: payload };
}

async function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') return Buffer.from(bytes).toString('base64');
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
}

// ---- 音色描述：酒馆自己的聊天后端 --------------------------------------------
// Deliberately not generateRaw: createRawPrompt() coerces message.content to a
// string, so an audio part cannot survive that call. This endpoint forwards the
// messages verbatim and fills in the key from the user's saved settings, which is
// exactly "用酒馆目前的 baseurl 和 key" without this plugin ever holding them.
export const DESCRIBE_QUESTIONS = [
    '1、该音色属于哪一部作品？',
    '2、该音色属于哪一个人物？',
    '3、该音色原作角色的人设是什么？请分析其性格，得出此音色适用的模式。',
    '4、该音色音频的听感如何？请根据音频文件分析，若无则根据人设推断。',
];
export const DESCRIBE_EXAMPLE = '本音色属于崩坏星穹铁道中的黑天鹅，适用于神秘的占卜家、温柔的大姐姐和亲和的上位者，声音磁性有韵味，魅惑而不失沉稳。';
// The host writes all three dot variants at different times, so a model that
// answers anyway still lands in the same field instead of being thrown away.
const COT_TAIL = /(?:<\|(?:im_start|im_end|endoftext|eot_id|eom_id)\|>|<\/?s>|<\|[a-z_]+\|>)/gi;

export function describePrompt({ name, group = '', guide = '' }) {
    const lines = [
        '你是配音音色库的目录编辑。下面给你一个音色，请为它写一段音色描述。',
        '这段描述会放进音色名册，别人挑配音时靠它判断这个音色适不适合自己的角色，所以要具体、好判断。',
        '',
        '音色名：' + String(name || '（未命名）'),
        '所属分组：' + (String(group || '').trim() || '未分组'),
        '已有描述：' + (String(guide || '').trim() || '（无）'),
        '',
        '请回答以下问题，然后把答案收成一段话：',
        ...DESCRIBE_QUESTIONS,
        '',
        '输出要求：只输出一段中文描述，40 到 100 字，按下面的格式，不要回答问题本身，不要分点，不要标题，不要引号，不要解释你在做什么。',
        '格式：本音色属于〈作品〉中的〈人物〉，适用于〈适合的角色类型、性格或场景〉，声音〈音色与听感〉。',
        '示例：' + DESCRIBE_EXAMPLE,
    ];
    return lines.join('\n');
}

export function cleanDescription(text) {
    return String(text ?? '')
        .replace(COT_TAIL, '')
        .replace(/^\s*(?:音色描述|描述|回答|答案)\s*[:：]\s*/, '')
        .trim()
        .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '')
        .trim()
        .replace(/\s*\n+\s*/g, '');
}

// Voice descriptions are only ever filled in when empty — a hand-written one is
// the user's work, not a draft.
export function needsDescription(entry) {
    return Boolean(entry) && !String(entry.guide || '').trim();
}

// The frontend never sees the key: it only tells the host which backend and which
// endpoint to use. An empty customUrl means "the address the user configured".
export function chatRequest({ messages, model, source = 'openai', reverseProxy = '', customUrl = '', maxTokens = 400, headers = null }) {
    if (!Array.isArray(messages) || !messages.length) throw new Error('聊天请求没有内容');
    if (!source) throw new Error('还没有在酒馆里选择聊天补全来源，无法使用酒馆默认模型');
    const body = { chat_completion_source: source, messages, max_tokens: maxTokens };
    if (model) body.model = model;
    if (reverseProxy) body.reverse_proxy = reverseProxy;
    if (customUrl) body.custom_url = customUrl;
    // The host rejects a bare POST with 403: it wants its own CSRF token, which only
    // the page's getRequestHeaders() knows. The caller passes that in.
    const requestHeaders = headers || { 'Content-Type': 'application/json' };
    return { url: '/api/backends/chat-completions/generate', options: { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) } };
}

export function audioContentPart({ base64, format = 'mp3' }) {
    const data = String(base64 || '');
    if (!data) throw new Error('试听音频是空的');
    return { type: 'input_audio', input_audio: { data, format } };
}

export function chatText(payload) {
    const direct = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? payload?.output?.text ?? '';
    if (typeof direct === 'string') return direct;
    if (Array.isArray(direct)) return direct.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
    return '';
}

// Some backends refuse audio outright ("audio is not supported"). That is worth
// telling apart from a normal failure: the description can still be written from
// the name and group alone, so retry the same prompt as text.
export function audioRejection(status, message) {
    if (status === 413) return true;
    return /audio|input_audio|modality|unsupported|not support|不支持/i.test(String(message || ''));
}

export async function describeVoice({ name, group = '', guide = '', audio = null, settings = {}, fetcher = fetch, signal = null, log = () => {} }) {
    const prompt = describePrompt({ name, group, guide });
    const target = {
        model: settings.model || '', source: settings.source || 'openai',
        reverseProxy: settings.reverseProxy || '', customUrl: settings.customUrl || '',
        headers: settings.headers || null,
    };
    const attempt = async withAudio => {
        const parts = [{ type: 'text', text: prompt }];
        if (withAudio && audio) parts.push(audioContentPart(audio));
        const request = chatRequest({ messages: [{ role: 'user', content: parts }], ...target });
        return fetcher(request.url, { ...request.options, signal });
    };
    let response = await attempt(Boolean(audio));
    if (!response.ok && audio) {
        let detail = '';
        try { const payload = await response.json(); detail = payload?.error?.message || payload?.message || JSON.stringify(payload).slice(0, 200); } catch { detail = ''; }
        if (audioRejection(response.status, detail)) {
            log('WARN', '酒馆当前模型不接受音频输入，改为只用名称和分组推断：' + detail);
            response = await attempt(false);
        } else {
            throw new Error('酒馆后端拒绝请求：HTTP ' + response.status + (detail ? ' ' + detail : ''));
        }
    }
    if (!response.ok) {
        let detail = '';
        try { const payload = await response.json(); detail = payload?.error?.message || payload?.message || ''; } catch { detail = ''; }
        throw new Error('调用酒馆默认模型失败：HTTP ' + response.status + (detail ? ' ' + detail : ''));
    }
    const payload = await response.json().catch(() => null);
    const text = cleanDescription(chatText(payload));
    if (!text) throw new Error('模型没有返回内容，请换个模型或稍后再试');
    return { text, usedAudio: Boolean(audio), raw: payload };
}

// Batches run one at a time: a wall of parallel requests against the user's own
// chat backend is how an account gets rate limited.
export function fillQueue(entries, { overwrite = false } = {}) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    return list.filter(entry => overwrite || needsDescription(entry));
}
