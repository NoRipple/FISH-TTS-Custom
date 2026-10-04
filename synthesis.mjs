// A concurrent producer independent of the audio player. A paused player does not
// hold up the next API request, except when bounded transient audio memory is full.
export const DEFAULT_CONCURRENCY = 10;
export const MAX_CONCURRENCY = 10;

export function clampConcurrency(value) {
    const parsed = Math.floor(Number(value));
    return Number.isFinite(parsed) ? Math.min(MAX_CONCURRENCY, Math.max(1, parsed)) : DEFAULT_CONCURRENCY;
}

export class SynthesisQueue {
    constructor({ synthesize, changed = () => {}, maxBufferedBytes = 32 * 1024 * 1024, concurrency = DEFAULT_CONCURRENCY }) {
        Object.assign(this, { synthesize, changed, maxBufferedBytes });
        this.tasks = []; this.pending = []; this.bufferedBytes = 0; this.epoch = 0;
        this.running = false; this.memoryPaused = false;
        this.concurrency = clampConcurrency(concurrency);
        this.activeTasks = new Set();
        this.waiters = [];
    }
    setConcurrency(value) {
        const next = clampConcurrency(value);
        const grew = next > this.concurrency;
        this.concurrency = next;
        // A running loop only refills between completions, so growing the pool
        // has to nudge it; shrinking simply lets the pool drain.
        if (grew) { this.wake(); void this.run(); }
        this.changed(this);
        return next;
    }
    // Every waiter is resolved, never just the first: with a pool of workers a
    // single stored resolve would strand the others forever.
    wake() {
        const waiters = this.waiters;
        this.waiters = [];
        for (const entry of waiters) entry.resolve();
    }
    hold(epoch) {
        if (epoch !== this.epoch) return null;
        let resolve;
        const promise = new Promise(r => { resolve = r; });
        const entry = { resolve };
        this.waiters.push(entry);
        return { entry, promise };
    }
    release(entry) {
        const index = this.waiters.indexOf(entry);
        if (index >= 0) this.waiters.splice(index, 1);
    }
    key(item) { return JSON.stringify([item.uiKey, item.text, item.speaker, item.language, item.voice, item.model, item.baseUrl]); }
    submit(item, { retainAudio = true } = {}) {
        const key = this.key(item);
        const existing = this.tasks.find(t => t.key === key && (['queued', 'requesting', 'receiving', 'saving'].includes(t.status) || t.blob));
        if (existing) { existing.retainAudio ||= retainAudio; return existing; }
        if (this.pending.length >= 100) throw new Error('合成等待队列已满（100 句）');
        const task = { key, item, retainAudio, status: 'queued', receivedBytes: 0, totalBytes: null, queuedAt: Date.now(), id: item.jobId, blob: null };
        task.done = new Promise(resolve => { task.resolve = resolve; });
        this.tasks.push(task); this.pending.push(task);
        // Keep only a bounded terminal history; pending promises and buffered audio remain alive.
        if (this.tasks.length > 300) this.tasks = this.tasks.filter(t => !['ready', 'failed', 'canceled'].includes(t.status) || t.blob || this.tasks.indexOf(t) >= this.tasks.length - 200);
        this.changed(this);
        this.wake();
        void this.run();
        return task;
    }
    cancelTask(task) {
        if (!task || ['failed', 'canceled'].includes(task.status)) return;
        task.controller?.abort(); task.status = 'canceled'; task.error = '已取消'; task.finishedAt = Date.now();
        if (task.blob) { this.bufferedBytes -= task.blob.size; task.blob = null; }
        task.resolve(); this.wake(); this.changed(this);
    }
    cancel() {
        this.epoch++; this.pending = [];
        for (const task of this.tasks) if (task.status !== 'ready' || task.blob) this.cancelTask(task);
        this.wake(); this.changed(this);
    }
    async take(task, signal) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        task.retainAudio = true;
        let abort;
        const aborted = new Promise((_, reject) => { abort = () => { this.cancelTask(task); reject(new DOMException('Aborted', 'AbortError')); }; signal.addEventListener('abort', abort, { once: true }); });
        try { await Promise.race([task.done, aborted]); }
        finally { signal.removeEventListener('abort', abort); }
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (task.status !== 'ready') throw new Error(task.error || '合成未完成');
        const blob = task.blob;
        if (!blob) throw new Error('音频已播放或释放，请重新点击播放');
        task.blob = null; this.bufferedBytes -= blob.size; this.wake(); this.changed(this);
        return blob;
    }
    async execute(task, epoch) {
        task.controller = new AbortController();
        task.startedAt = Date.now(); task.status = 'requesting';
        this.activeTasks.add(task); this.changed(this);
        try {
            const blob = await this.synthesize(task.item, task.controller.signal, patch => {
                if (epoch !== this.epoch || task.status === 'canceled') return;
                // Never let a late poll downgrade the local terminal state.
                Object.assign(task, patch); this.changed(this);
            });
            if (epoch !== this.epoch || task.controller.signal.aborted) { this.cancelTask(task); return; }
            if (task.retainAudio) { task.blob = blob; this.bufferedBytes += blob.size; }
            task.status = 'ready'; task.receivedBytes = blob.size; task.finishedAt = Date.now(); task.resolve();
        } catch (e) {
            if (epoch !== this.epoch || task.controller.signal.aborted) { this.cancelTask(task); return; }
            task.status = 'failed'; task.error = e.message; task.finishedAt = Date.now(); task.resolve();
            // Auth, quota and network errors hit every request in flight, so stop the
            // batch instead of burning through it. One failure is reported, the rest
            // are cancelled rather than surfacing ten identical errors.
            for (const pending of this.pending) this.cancelTask(pending);
            this.pending = [];
            for (const other of this.activeTasks) if (other !== task && !other.controller?.signal.aborted) other.controller?.abort();
        } finally {
            this.activeTasks.delete(task);
            this.changed(this);
        }
    }
    async run() {
        if (this.running) return;
        this.running = true;
        const epoch = this.epoch;
        const active = new Set();
        while (epoch === this.epoch) {
            while (active.size < this.concurrency && this.pending.length && epoch === this.epoch) {
                // Buffer full means stop starting work; consuming audio via take()
                // wakes the loop. Starting "just one more" would grow the buffer
                // without bound instead.
                if (this.bufferedBytes >= this.maxBufferedBytes) { this.memoryPaused = true; break; }
                this.memoryPaused = false;
                const task = this.pending.shift();
                if (task.status === 'canceled') continue;
                let tracked;
                tracked = this.execute(task, epoch).finally(() => active.delete(tracked));
                active.add(tracked);
            }
            if (!active.size) {
                if (!this.pending.length) break;
                // Nothing can start (memory gate) or nothing is queued yet; wait for
                // a wake instead of spinning.
                const hold = this.hold(epoch);
                if (!hold) break;
                await hold.promise;
                continue;
            }
            const hold = this.hold(epoch);
            try { await Promise.race(hold ? [...active, hold.promise] : [...active]); }
            finally { if (hold) this.release(hold.entry); }
        }
        this.memoryPaused = false;
        this.running = false;
        // Tasks may have been queued while a superseded epoch was draining.
        if (this.pending.length) void this.run();
        this.changed(this);
    }
}
