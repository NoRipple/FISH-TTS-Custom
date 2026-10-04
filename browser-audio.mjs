export function ttsRequest(input, apiKey) {
    const base=new URL(input.baseUrl || 'https://api.fish.audio');
    if(base.protocol!=='https:' || base.username || base.password || base.search || base.hash) throw Error('Base URL 必须为不含账号、查询参数的 HTTPS 地址');
    base.pathname=base.pathname.replace(/\/+$/,'').replace(/\/v1$/,'')+'/';
    if(!apiKey?.trim() || /[\r\n]/.test(apiKey)) throw Error('请填写有效 API Key');
    if(!input.voice?.trim()) throw Error('请填写音色 ID');
    if(!input.text?.trim() || Array.from(input.text).length>2000) throw Error('语音文本须为 1–2000 字符');
    const model=input.model?.trim() || 's2.1-pro-free';
    if(/[\r\n]/.test(model)) throw Error('模型名称无效');
    if(base.hostname==='api.fish.audio' && !['s2.1-pro-free','s2.1-pro','s2-pro','s1','drama-3-preview'].includes(model)) throw Error('未知官方模型，请确认模型名称');
    return {url:'/proxy/'+new URL('v1/tts',base).href,baseUrl:base.href,model,
        options:{method:'POST',headers:{Authorization:'Bearer '+apiKey.trim(),model,'Content-Type':'application/json'},body:JSON.stringify({text:input.text,reference_id:input.voice.trim(),format:'mp3',latency:'normal'})}};
}
export async function audioKey(input) {
    const data=JSON.stringify([input.baseUrl,input.model,input.voice,input.language,input.speaker,input.text,input.link || null]);
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data));
    return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export class BrowserAudioStore {
    constructor(scope) { this.name='fish-dialogue-audio-'+scope; }
    open() {
        return this.ready ||= new Promise((resolve,reject)=>{
            const r=indexedDB.open(this.name,1);
            r.onupgradeneeded=()=>{for(const name of ['meta','audio','settings'])r.result.createObjectStore(name);};
            r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};
            r.onerror=()=>{this.ready=null;reject(Error('浏览器音频库无法打开：'+r.error?.name));};
        });
    }
    async transaction(mode, fn, signal) {
        signal?.throwIfAborted();const db=await this.open();signal?.throwIfAborted();
        return new Promise((resolve,reject)=>{
            const tx=db.transaction(['meta','audio','settings'],mode);let value;
            const abort=()=>{try{tx.abort();}catch{}};signal?.addEventListener('abort',abort,{once:true});
            const done=()=>signal?.removeEventListener('abort',abort);
            tx.oncomplete=()=>{done();resolve(value);};
            tx.onerror=()=>{};
            tx.onabort=()=>{done();reject(signal?.aborted?new DOMException('Aborted','AbortError'):Error('音频库操作失败：'+(tx.error?.name || '事务取消')));};
            try {fn(tx,x=>value=x);}catch(e){abort();done();reject(e);}
        });
    }
    read(id) {return this.transaction('readonly',(tx,set)=>{tx.objectStore('audio').get(id).onsuccess=e=>set(e.target.result);});}
    list() {return this.transaction('readonly',(tx,set)=>{
        const all=tx.objectStore('meta').getAll(), limit=tx.objectStore('settings').get('limit');
        limit.onsuccess=()=>set({entries:all.result.sort((a,b)=>b.createdAt-a.createdAt),maxFiles:limit.result || 200,path:'当前浏览器音频库'});
    });}
    async write(input, blob, id, signal) {return this.mutate({input,blob,id},signal);}
    async setLimit(limit) {
        if(!Number.isInteger(limit)||limit<1||limit>10000)throw Error('保留数量须为 1–10000 的整数');
        return this.mutate({limit});
    }
    mutate({input,blob,id,limit},signal) {return this.transaction('readwrite',(tx,set)=>{
        const meta=tx.objectStore('meta'), audio=tx.objectStore('audio'), settings=tx.objectStore('settings');
        if(limit!==undefined)settings.put(limit,'limit');
        if(blob){audio.put(blob,id);meta.put({id,speaker:input.speaker || '',language:input.language,link:input.link || null,createdAt:Date.now(),bytes:blob.size},id);}
        const all=meta.getAll(), cap=settings.get('limit');
        cap.onsuccess=()=>{
            const entries=all.result.sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id));
            const remove=entries.slice(0,Math.max(0,entries.length-(cap.result || 200)));
            for(const row of remove){meta.delete(row.id);audio.delete(row.id);}
            set({removed:remove.length});
        };
    },signal);}
}
export function detectAudioType(bytes) {
    const text=(start,end)=>String.fromCharCode(...bytes.slice(start,end));
    if(bytes.length>=10 && text(0,3)==='ID3' && bytes[3]>=2 && bytes[3]<=4 && bytes.slice(6,10).every(x=>x<128))return 'audio/mpeg';
    if(bytes.length>=4 && bytes[0]===255 && (bytes[1]&224)===224 && (bytes[1]&24)!==8 && (bytes[1]&6)!==0 && (bytes[2]&240)!==0 && (bytes[2]&240)!==240 && (bytes[2]&12)!==12)return 'audio/mpeg';
    if(bytes.length>=12 && text(0,4)==='RIFF' && text(8,12)==='WAVE')return 'audio/wav';
    if(bytes.length>=27 && text(0,4)==='OggS' && bytes[4]===0)return 'audio/ogg';
    if(bytes.length>=8 && text(0,4)==='fLaC')return 'audio/flac';
    return null;
}

// A saturated account answers 429; with a pool of requests in flight that is
// transient rather than a reason to drop the whole queue, so those are retried.
export const MAX_RETRIES = 2;
export const MAX_RETRY_DELAY_MS = 10000;
const RETRYABLE_STATUS = new Set([429, 503]);

export function parseRetryAfter(value, now = Date.now()) {
    if (value === null || value === undefined || value === '') return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    const date = Date.parse(String(value));
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - now, MAX_RETRY_DELAY_MS));
    return null;
}

function httpError(response) {
    const status = response.status;
    if (status === 404) return Error('HTTP 404：请启用 enableCorsProxy: true 并重启酒馆；若已开启，请检查 Base URL 和 Fish 接口。');
    const error = Error(RETRYABLE_STATUS.has(status)
        ? `Fish 返回 HTTP ${status}：请求过于频繁或服务繁忙，已自动重试仍失败；请调低并发数后重试。`
        : `Fish / CorsProxy HTTP ${status}；未自动重试，请检查 Key、额度和网络。`);
    error.status = status;
    error.retryable = RETRYABLE_STATUS.has(status);
    error.retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
    return error;
}

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
        const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        signal?.addEventListener('abort', abort, { once: true });
    });
}

// One attempt: fetch, stream the body down, verify it really is audio.
async function fetchAudio(request, signal, update, fetcher) {
    const controller=new AbortController();let timedOut=false;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},120000);
    let reader;
    try {
        signal?.throwIfAborted();update({status:'requesting'});
        const response=await fetcher(request.url,{...request.options,signal:controller.signal,redirect:'error'});
        if(!response.ok)throw httpError(response);
        const type=response.headers.get('content-type') || '';
        // Some SillyTavern versions forward the body but omit upstream Content-Type.
        // Validate headerless/generic bodies by their file signature after reading.
        reader=response.body.getReader();const chunks=[];let size=0;
        const total=Number(response.headers.get('content-length')) || null;
        for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
            if(size>25*1024*1024)throw Error('音频超过 25 MB 限制');
            chunks.push(value);update({status:'receiving',receivedBytes:size,totalBytes:total});}
        if(!size)throw Error('API 返回空音频');
        signal?.throwIfAborted();
        const received=new Blob(chunks);
        const signature=detectAudioType(new Uint8Array(await received.slice(0,32).arrayBuffer()));
        const mime=signature || (/^audio\//i.test(type)?type:null);
        if(!mime)throw Error('返回内容无法识别为音频（可能是登录页或接口错误文本）；请检查登录状态、Base URL 和模型。无需修改 cors.origin。');
        return new Blob([received],{type:mime});
    } catch(e) {
        if(signal?.aborted)throw new DOMException('Aborted','AbortError');
        if(timedOut)throw Error('Fish 请求超时（120 秒）');
        if(e instanceof TypeError)throw Error('请求失败：请检查酒馆网络、VPN 和内置 CorsProxy');
        throw e;
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);try{await reader?.cancel();}catch{}}
}

export async function synthesizeBrowser(input,key,store,signal,update=()=>{},fetcher=fetch) {
    const request=ttsRequest(input,key);
    const normalized={...input,baseUrl:request.baseUrl,model:request.model,voice:input.voice.trim()};
    const id=await audioKey(normalized);signal?.throwIfAborted();
    const cached=await store.read(id);signal?.throwIfAborted();
    input.assetId=id;
    if(cached){input.cacheSource='disk';return cached;}
    for(let attempt=0;;attempt++){
        try {
            const blob=await fetchAudio(request,signal,update,fetcher);
            update({status:'saving'});
            await store.write(normalized,blob,id,signal);signal?.throwIfAborted();
            input.cacheSource='generated';return blob;
        } catch(e) {
            if(!e?.retryable || attempt >= MAX_RETRIES) throw e;
            // Exponential backoff, but an explicit Retry-After wins over it.
            await delay(e.retryAfterMs ?? Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS), signal);
        }
    }
}
