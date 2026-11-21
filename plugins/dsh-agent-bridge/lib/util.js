// ---------------------------------------------------------------------------
// dsh-agent-bridge/lib/util.js
//
// 无副作用的纯工具函数：文本提取、会话标题、turn 摘要、Promise 辅助。
// 不 import 任何 node: 唯一 API 之外的运行时服务，方便单测与静态检查。
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';

/** 从消息 content（块数组或字符串）中拼接纯文本。 */
export function textOf(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	let out = '';
	for (const block of content) {
		if (typeof block === 'string') {
			out += block;
		} else if (block !== null && typeof block === 'object' && block.type === 'text') {
			if (typeof block.text === 'string') out += block.text;
		}
	}
	return out;
}

/** 兼容多种 Session 实现的事件快照读取；返回数组或 null。 */
export function eventsOf(session) {
	if (!session || typeof session !== 'object') return null;
	if (typeof session.snapshotEvents === 'function') {
		try {
			const events = session.snapshotEvents();
			if (Array.isArray(events)) return events;
		} catch { /* fallthrough */ }
	}
	const pick = (v) => (Array.isArray(v) ? v : null);
	for (const key of ['events', 'log', 'eventsSnapshot', 'history']) {
		const raw = session[key];
		const direct = pick(raw);
		if (direct) return direct;
		if (typeof raw === 'function') {
			const got = pick(raw.call(session));
			if (got) return got;
		}
	}
	return null;
}

/**
 * 从 Session 事件流推断显示标题：header.title → 最后一条 session/title →
 * 第一条 user/message 文本 → sessionId。
 */
export function sessionTitle(session) {
	if (!session) return 'session';
	const headerTitle = session.header?.title;
	if (typeof headerTitle === 'string' && headerTitle.trim()) return headerTitle.trim();
	if (headerTitle && typeof headerTitle.val === 'string' && headerTitle.val.trim()) {
		return headerTitle.val.trim();
	}
	const events = eventsOf(session);
	if (events) {
		for (const event of events) {
			if (event?.type === 'session/title' && event.data?.title) {
				const t = String(event.data.title).replace(/\s+/g, ' ').trim();
				if (t) return clip(t, 60);
			}
		}
		for (const event of events) {
			if (event?.type === 'user/message') {
				const text = textOf(event.data?.content).replace(/\s+/g, ' ').trim();
				if (text) return clip(text, 60);
			}
		}
	}
	return String(session.id ?? 'session');
}

/** 截断文本并加省略号。 */
export function clip(text, max) {
	const t = String(text ?? '');
	if (t.length <= max) return t;
	return `${t.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 提取一个 turn 的完成摘要：最后一条 assistant 文本 + 工具调用计数。
 * @param {any[]} events 会话事件快照（顺序）
 * @param {number} turn 目标 turn 序号
 */
export function summarizeTurn(events, turn) {
	let toolCalls = 0;
	let lastText = '';
	if (Array.isArray(events)) {
		for (const event of events) {
			if (!event || !event.data) continue;
			const t = event.data.turn;
			if (typeof t === 'number' && t < turn) break;
			if (t !== turn) continue;
			if (event.type === 'tool/call') toolCalls += 1;
			if (event.type === 'assistant/message' && !lastText) {
				const text = textOf(event.data.message?.content).trim();
				if (text) lastText = text;
			}
		}
	}
	return { text: lastText, toolCalls };
}

/** turn/end reason 的稳定归类：completed / blocked / max-tokens / interrupted / unknown。 */
export function classifyTurnEnd(reason) {
	const kind = reason?.kind;
	switch (kind) {
		case 'completed':
		case 'blocked':
		case 'max-tokens':
			return kind;
		case 'user':
		case 'parent':
		case 'disposed':
		case 'hook':
		case 'cancelled':
			return 'interrupted';
		default:
			return kind ? 'interrupted' : 'unknown';
	}
}

/** 提取 assistant 消息中的 reasoning/thinking 块文本。 */
export function reasoningOf(content) {
	if (!Array.isArray(content)) return [];
	const blocks = [];
	for (const block of content) {
		if (block === null || typeof block !== 'object') continue;
		if (block.type !== 'reasoning' && block.type !== 'thinking') continue;
		const text = typeof block.text === 'string' ? block.text : typeof block.reasoning === 'string' ? block.reasoning : '';
		if (text) blocks.push(text);
	}
	return blocks;
}

/**
 * 会话事件流 → 分页视图（GET /sessions/:id/page 的响应片段）。
 *
 * @param {any[] | null | undefined} events 会话事件快照（顺序）
 * @param {{limit?: number, turn?: number}} [options]
 */
export function pageView(events, options = {}) {
	const source = Array.isArray(events) ? events : [];
	const requestedLimit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50;
	const limit = Math.min(requestedLimit, 500);
	const wantedTurn = Number.isInteger(options.turn) && options.turn >= 0 ? options.turn : undefined;
	const records = [];
	let assistantText = '';
	let reasoningBlocks = [];
	let turnEnd = null;
	let lastUserText = '';
	let asOfSeq = 0;
	for (const event of source) {
		const seq = Number(event?.seq);
		if (Number.isFinite(seq) && seq > asOfSeq) asOfSeq = seq;
		const data = event?.data;
		if (data === null || typeof data !== 'object') continue;
		const turn = Number.isInteger(data.turn) ? data.turn : undefined;
		if (wantedTurn !== undefined && turn !== undefined && turn !== wantedTurn) continue;
		if (event.type === 'user/message' && event.surfaceOp === 'append') {
			const text = textOf(data.content).trim();
			if (text) lastUserText = text;
			continue;
		}
		if (event.type === 'assistant/message' && event.surfaceOp === 'append') {
			const text = textOf(data.message?.content);
			const reasoning = reasoningOf(data.message?.content);
			records.push({ type: 'assistant/message', seq, turn, text, reasoning });
			if (text.trim()) assistantText = text;
			if (reasoning.length > 0) reasoningBlocks = reasoning;
			continue;
		}
		if (event.type === 'turn/end') {
			const kind = classifyTurnEnd(data.reason);
			const record = {
				type: 'turn/end',
				seq,
				turn,
				reason: data.reason ?? null,
				kind,
				completed: kind === 'completed',
			};
			records.push(record);
			turnEnd = record;
		}
	}
	const trimmed = records.length > limit ? records.slice(-limit) : records;
	return { records: trimmed, assistantText, reasoningBlocks, turnEnd, lastUserText, asOfSeq };
}

/** 生成一个插件命名空间的请求 id。 */
export function newRequestId(prefix = 'orc') {
	return `${prefix}-${randomUUID()}`;
}

/** 始终 resolve 的 sleep；返回 timer 句柄用于取消。 */
export function sleep(ms) {
	let timer;
	const promise = new Promise((resolve) => {
		timer = setTimeout(resolve, Math.max(0, ms));
		timer?.unref?.();
	});
	promise.timer = timer;
	return promise;
}

/**
 * 等待一组信号量中任一 settle，或超时。
 * @returns {'signal'|'timeout'|'done'}
 */
export async function raceAbort(signal, ms, promise) {
	const racers = [];
	if (promise !== undefined && promise !== null) racers.push(Promise.resolve(promise).then(() => 'done'));
	let timer;
	if (Number.isFinite(ms) && ms >= 0) {
		racers.push(sleep(ms).then(() => 'timeout'));
	}
	if (signal !== undefined && signal !== null) {
		racers.push(new Promise((resolve) => {
			const onAbort = () => resolve('signal');
			if (signal.aborted) {
				resolve('signal');
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
			// settle 后移除监听，避免泄漏
			Promise.race(racers).finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
		}));
	}
	const first = await Promise.race(racers);
	if (timer) clearTimeout(timer);
	return first;
}

/** 把任意 thrown 值折叠为 {code, message}。RemoteError 带 code。 */
export function errorInfo(error) {
	return {
		code: typeof error?.code === 'string' && error.code ? error.code : 'internal',
		message: error instanceof Error ? error.message : String(error),
	};
}

/** 安全 JSON 序列化（截断超长字符串字段由调用方控制）。 */
export function jsonSafe(value) {
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return { error: 'not-serializable' };
	}
}
