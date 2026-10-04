const SAMPLES = Object.freeze({
    zh: '你好，这是默认音色试听。',
    en: 'Hello, this is a preview of the default voice.',
    ja: 'こんにちは。これはデフォルト音声の試聴です。',
});

// A preview speaks a fixed sample in one language with one explicit voice, so
// it never goes through voiceFor(): the caller has already resolved the voice.
export function voicePreview({ voice, language, settings }) {
    const value = String(voice ?? '').trim();
    if (!value) throw new Error('请先选择音色');
    const requested = SAMPLES[language] ? language : (SAMPLES[settings?.language] ? settings.language : 'zh');
    return {
        text: SAMPLES[requested], speaker: '', language: requested,
        voice: value, model: settings?.model, baseUrl: settings?.baseUrl, preview: true,
    };
}

export function defaultVoicePreview(settings, voice) {
    return voicePreview({ voice, language: settings?.language === 'orig' ? 'zh' : settings?.language, settings });
}
