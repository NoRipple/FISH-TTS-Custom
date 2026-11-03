// ── Fish 对话音声 · 服务端一次性克隆 ─────────────────────
// SillyTavern server plugin — zero-shot cloning without a saved voice model.
//
// Why this file has to exist:
//   POST /v1/tts accepts application/json and application/msgpack only, and
//   inline `references` are explicitly MessagePack-only. A browser can neither
//   reach api.fish.audio directly (no CORS headers) nor hand raw bytes to
//   SillyTavern's /proxy/ (it calls JSON.stringify on the parsed body). SillyTavern
//   itself runs on Node, where neither restriction exists, so the conversion is
//   done here with the official SDK.
//
// Routes (mounted at /api/plugins/fish-voice-server/):
//   GET  /status   health probe + version
//   POST /clone    { apiKey, model, text, format?, audio: base64, transcript, mime? }
//                  → audio/mpeg body, or { error } with a non-200 status

'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN_ID = 'fish-voice-server';
const PLUGIN_VERSION = '1.0.0';

// Keep the same guard rails the browser side already applies.
const MAX_TEXT_CHARS = 2000;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const OFFICIAL_MODELS = ['s2.1-pro-free', 's2.1-pro', 's2-pro', 's1', 'drama-3-preview'];

const info = {
    id: PLUGIN_ID,
    name: 'Fish Dialogue Voice Server',
    description: 'Server-side zero-shot cloning bridge for the Fish Dialogue extension.',
    version: PLUGIN_VERSION,
};

let FishAudioClient = null;
let sdkLoadError = null;

// The SDK is an optional import: when it is missing the route still answers so
// the extension can show a clear "run npm install" message instead of a 404.
// It is resolved relative to THIS file so the plugin keeps working even when
// SillyTavern reinstalls its own node_modules.
async function loadSdk() {
    if (FishAudioClient || sdkLoadError) return;
    try {
        const mod = await import('fish-audio');
        FishAudioClient = mod.FishAudioClient;
    } catch (firstError) {
        // Fall back to the copy shipped next to this plugin: SillyTavern's own
        // node_modules may have been reinstalled without our dependency.
        try {
            const local = pathToFileURL(path.join(__dirname, 'node_modules', 'fish-audio', 'dist', 'esm', 'index.js')).href;
            const mod = await import(local);
            FishAudioClient = mod.FishAudioClient;
        } catch {
            sdkLoadError = firstError;
        }
    }
    if (!FishAudioClient) sdkLoadError ||= Error('fish-audio 未安装');
}

function fail(res, status, message) {
    return res.status(status).json({ error: message });
}

function normalizeBase(value) {
    const raw = String(value || 'https://api.fish.audio').trim();
    const url = new URL(raw);
    if (url.protocol !== 'https:') throw Error('Base URL 必须是 HTTPS 地址');
    if (url.username || url.password || url.search || url.hash) throw Error('Base URL 不能带账号或查询参数');
    return url.origin + url.pathname.replace(/\/+$/, '');
}

function decodeAudio(value) {
    const text = String(value || '');
    if (!text) throw Error('缺少参考音频数据');
    const comma = text.indexOf(',');
    const payload = text.startsWith('data:') && comma >= 0 ? text.slice(comma + 1) : text;
    const bytes = Buffer.from(payload, 'base64');
    if (!bytes.length) throw Error('参考音频数据为空');
    if (bytes.length > MAX_AUDIO_BYTES) throw Error('参考音频超过 20 MB，请换一段更短的录音');
    return bytes;
}

async function toBuffer(stream) {
    if (stream instanceof Uint8Array) return Buffer.from(stream);
    if (stream?.getReader) {
        const reader = stream.getReader();
        const parts = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(Buffer.from(value));
        }
        return Buffer.concat(parts);
    }
    const parts = [];
    for await (const chunk of stream) parts.push(Buffer.from(chunk));
    return Buffer.concat(parts);
}

function init(router) {
    router.get('/status', async (req, res) => {
        await loadSdk();
        res.json({
            ok: true,
            version: PLUGIN_VERSION,
            sdk: FishAudioClient ? 'ready' : 'missing',
            sdkError: sdkLoadError ? String(sdkLoadError.message || sdkLoadError) : null,
        });
    });

    router.post('/clone', async (req, res) => {
        await loadSdk();
        if (!FishAudioClient) {
            return fail(res, 503, `服务端缺少 fish-audio 依赖，请在 SillyTavern 目录执行 npm install fish-audio（${sdkLoadError?.message || '未知原因'}）`);
        }

        const body = req.body || {};
        const apiKey = String(body.apiKey || '').trim();
        const text = String(body.text || '').trim();
        const transcript = String(body.transcript || '').trim();
        const model = String(body.model || 's2.1-pro-free').trim();
        const format = String(body.format || 'mp3').trim();

        if (!apiKey) return fail(res, 400, '缺少 API Key');
        if (!text) return fail(res, 400, '缺少要合成的文本');
        if (Array.from(text).length > MAX_TEXT_CHARS) return fail(res, 400, '语音文本须为 1–2000 字符');
        if (!transcript) return fail(res, 400, '缺少逐字稿：必须与参考音频里说的一字不差');
        if (!['mp3', 'wav', 'opus', 'pcm'].includes(format)) return fail(res, 400, '不支持的输出格式');

        let baseUrl;
        try {
            baseUrl = normalizeBase(body.baseUrl);
        } catch (error) {
            return fail(res, 400, error.message);
        }
        if (new URL(baseUrl).hostname === 'api.fish.audio' && !OFFICIAL_MODELS.includes(model)) {
            return fail(res, 400, '未知官方模型，请确认模型名称');
        }

        let audio;
        try {
            audio = decodeAudio(body.audio);
        } catch (error) {
            return fail(res, 400, error.message);
        }

        try {
            const client = new FishAudioClient({ apiKey, baseUrl });
            const reference = new File([audio], body.filename || 'reference.wav', {
                type: String(body.mime || 'audio/wav'),
            });
            const stream = await client.textToSpeech.convert({
                text,
                references: [{ audio: reference, text: transcript }],
                format,
            }, model);
            const out = await toBuffer(stream);
            if (!out.length) return fail(res, 502, 'Fish 返回了空音频');
            res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : `audio/${format}`);
            res.setHeader('Content-Length', String(out.length));
            res.setHeader('Cache-Control', 'no-store');
            return res.end(out);
        } catch (error) {
            const status = Number(error?.statusCode) || 502;
            const detail = String(error?.message || error);
            console.error(`[${PLUGIN_ID}] clone failed: ${detail}`);
            return fail(res, status >= 400 && status < 600 ? status : 502, `Fish 调用失败：${detail}`);
        }
    });
}

function exit() {
    // Nothing to release: the SDK client is created per request.
}

module.exports = { init, exit, info };
