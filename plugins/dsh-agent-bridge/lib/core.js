// ---------------------------------------------------------------------------
// dsh-agent-bridge/lib/core.js
//
// OrchestratorCore：插件的中枢。
//  - 监听 DSH Host 的 session/agent/workspace 事件
//  - 维护「子会话 → 父会话」编排关系
//  - 判定会话完成（turn/end + agent 空闲）并派发三类实时通知：
//      1) SSE 事件流（第三方工具 / 页面）
//      2) Webhook POST 回调（第三方工具）
//      3) followup 通知父会话（dsh 内部主会话，唤醒并注入结果）
//  - 提供工作区 / 会话的读写操作，供 HTTP 与 Agent 工具两层复用
// ---------------------------------------------------------------------------

import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
	classifyTurnEnd,
	clip,
	eventsOf,
	errorInfo,
	newRequestId,
	pageView,
	raceAbort,
	sessionTitle,
	sleep,
	summarizeTurn,
	textOf,
} from './util.js';

const HOUR_MS = 3_600_000;

export class OrchestratorCore {
	/** @param {any} ctx Host Cordis 上下文（已注入 sessions/agents/workspaceRegistry/sessionController） */
	/** @param {any} config 已解析的插件配置 */
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		/** SSE 客户端集合（ServerResponse） */
		this.sseClients = new Set();
		/** childSessionId → { parentSessionId, createdVia, title } */
		this.parents = new Map();
		/** sessionId → { turn, reason, outcome, startedAt, endedAt, summary }（最近一个已结束的 turn） */
		this.turnEnds = new Map();
		/** sessionId → 进行中的完成检查 Promise（防抖） */
		this.pendingChecks = new Map();
		/** sessionId → turn/start 时间（用于时长统计） */
		this.turnStarts = new Map();
		/** sessionId → 已接受但尚未跑完一轮的 prompt 时间戳（wait 竞态防护） */
		this.expectWork = new Map();
		/** workspace 事件去抖计时器 */
		this.workspaceEmitTimer = null;
		/** 会话级 webhook：sessionId → Set<url> */
		this.sessionHooks = new Map();
		/** 全局 webhook：Set<url> */
		this.globalHooks = new Set();
		/** 是否已 dispose */
		this.disposed = false;
		/** 已注册的模型工具名 */
		this.toolNames = [];
		this.listeners = [];
		this.registerListeners();
		// 定期清理陈旧跟踪状态，防内存泄漏
		this.gcTimer = setInterval(() => this.gc(), HOUR_MS);
		this.gcTimer.unref?.();
	}

	dispose() {
		this.disposed = true;
		clearInterval(this.gcTimer);
		clearTimeout(this.workspaceEmitTimer);
		for (const off of this.listeners) {
			try { off(); } catch { /* ignore */ }
		}
		this.listeners = [];
		for (const res of this.sseClients) {
			try { res.end(); } catch { /* ignore */ }
		}
		this.sseClients.clear();
		this.parents.clear();
		this.turnEnds.clear();
		this.pendingChecks.clear();
		this.turnStarts.clear();
		this.expectWork.clear();
		this.sessionHooks.clear();
		this.globalHooks.clear();
	}

	gc() {
		const cutoff = Date.now() - 24 * HOUR_MS;
		for (const [id, at] of this.turnStarts) if (at < cutoff) this.turnStarts.delete(id);
		for (const [id, info] of this.turnEnds) if (info.endedAt < cutoff) this.turnEnds.delete(id);
		// 未完成轮次超过 10 分钟视为失效（例如模型请求卡死/进程重启）
		const expectCutoff = Date.now() - 10 * 60_000;
		for (const [id, at] of this.expectWork) if (at < expectCutoff) this.expectWork.delete(id);
	}

	// -----------------------------------------------------------------------
	// 事件监听
	// -----------------------------------------------------------------------

	on(name, handler) {
		const off = this.ctx.on(name, handler);
		this.listeners.push(() => {
			try { off(); } catch { /* ignore */ }
		});
	}

	registerListeners() {
		this.on('session/created', (session) => {
			this.emit('session.created', {
				sessionId: String(session.id),
				title: sessionTitle(session),
				cwd: session.header?.cwd,
			});
		});

		this.on('session/disposed', (session) => {
			const sessionId = String(session.id);
			this.parents.delete(sessionId);
			this.sessionHooks.delete(sessionId);
			this.emit('session.removed', { sessionId });
		});

		this.on('agent/status', ({ agent, status }) => {
			if (!agent) return;
			this.emit('session.status', {
				sessionId: String(agent.id),
				status,
				running: status === 'running',
			});
		});

		this.on('agent/error', ({ agent, error }) => {
			if (!agent) return;
			const sessionId = String(agent.id);
			const info = errorInfo(error);
			this.emit('session.failed', { sessionId, reason: 'error', error: info });
			this.dispatchWebhooks('session.failed', {
				sessionId,
				reason: 'error',
				error: info,
				timestamp: Date.now(),
			});
		});

		this.on('session/event', (session, event) => {
			const sessionId = String(session.id);
			switch (event.type) {
				case 'turn/start':
					this.turnStarts.set(sessionId, Date.now());
					this.emit('session.turn-start', { sessionId, turn: event.data.turn });
					break;
				case 'turn/end': {
					const startedAt = this.turnStarts.get(sessionId) ?? Date.now();
					this.turnStarts.delete(sessionId);
					this.expectWork.delete(sessionId);
					const outcome = classifyTurnEnd(event.data.reason);
					const summary = summarizeTurn(eventsOf(session), event.data.turn);
					const info = {
						sessionId,
						turn: event.data.turn,
						reason: event.data.reason?.kind ?? null,
						outcome,
						startedAt,
						endedAt: Date.now(),
						durationMs: Date.now() - startedAt,
						summary,
					};
					this.turnEnds.set(sessionId, info);
					this.emit('session.turn-end', {
						sessionId,
						turn: info.turn,
						reason: info.reason,
						outcome: info.outcome,
						durationMs: info.durationMs,
					});
					// turn 结束后安排一次完成检查（等 agent 空闲再通知）
					this.scheduleCompletionCheck(sessionId);
					break;
				}
				default:
					break;
			}
		});

		this.on('domain/changed', () => {
			// workspace 注册表变化：短去抖合并一次性广播（attach/session 操作常连续触发）
			if (this.workspaceEmitTimer !== null) return;
			this.workspaceEmitTimer = setTimeout(() => {
				this.workspaceEmitTimer = null;
				this.emit('workspace.changed', {});
			}, 120);
			this.workspaceEmitTimer.unref?.();
		});
	}

	// -----------------------------------------------------------------------
	// 完成判定与通知
	// -----------------------------------------------------------------------

	/**
	 * turn/end 之后等待 Agent 真正空闲（可能还有排队的下一轮），再发完成通知。
	 * 同一会话同时只有一个检查在跑；新的 turn/end 会更新 turnEnds，旧的
	 * 检查 resolve 时自然读取最新结果。
	 */
	scheduleCompletionCheck(sessionId) {
		if (this.pendingChecks.has(sessionId)) return;
		const check = (async () => {
			try {
				// 小延迟：让 driver 完成 turn 收尾（phase 迁移）
				await sleep(150);
				for (let attempt = 0; attempt < 3; attempt += 1) {
					if (this.disposed) return;
					const agent = this.ctx.agents.get(sessionId);
					if (agent === undefined) break; // 会话已关闭/冷却：用已记录结果直接通知
					if (agent.status === 'running') {
						// 还有工作（下一轮或收尾中），继续等空闲
						await raceAbort(undefined, 60_000, agent.whenIdle());
						continue;
					}
					break;
				}
				if (this.disposed) return;
				this.notifyCompletion(sessionId);
			} catch { /* 通知失败不影响宿主 */ }
			finally {
				this.pendingChecks.delete(sessionId);
			}
		})();
		this.pendingChecks.set(sessionId, check);
	}

	/** 会话到达空闲态：广播 SSE、派发 webhook、通知父会话。 */
	notifyCompletion(sessionId) {
		const info = this.turnEnds.get(sessionId);
		if (info === undefined) return;
		const session = this.ctx.sessions.get(sessionId);
		const payload = {
			sessionId,
			title: session ? sessionTitle(session) : undefined,
			turn: info.turn,
			outcome: info.outcome,
			reason: info.reason,
			durationMs: info.durationMs,
			summary: info.summary.text ? clip(info.summary.text, this.config.maxSummaryChars) : '',
			toolCalls: info.summary.toolCalls,
			timestamp: info.endedAt,
		};
		// 1) SSE（区分成功完成与非成功终态）
		const eventName = info.outcome === 'completed' ? 'session.completed' : 'session.interrupted';
		this.emit(eventName, payload);
		// 2) webhook（完成/中断都发，第三方按 outcome 区分）
		this.dispatchWebhooks(eventName, payload);
		// 3) 父会话 followup 通知（dsh 内部编排回路）
		this.notifyParent(sessionId, payload);
	}

	notifyParent(sessionId, payload) {
		if (!this.config.notifyParentSession) return;
		const parent = this.parents.get(sessionId);
		if (parent === undefined) return;
		if (payload.outcome !== 'completed' && !this.config.parentNotifyOnInterrupted) return;
		const agent = this.ctx.agents.get(parent.parentSessionId);
		if (agent === undefined) {
			// 父会话已不在内存（用户关闭）。保留映射以免误唤醒冷会话。
			this.log(`parent session ${parent.parentSessionId} of ${sessionId} is not live; notification dropped`);
			return;
		}
		if (agent.status === 'running') {
			// 父会话正忙（例如正在 orchestrator_wait_sessions 中等待）：
			// followup 排队 next-turn，turn 结束后送达 —— 正是期望语义。
		}
		const lines = [
			`[orchestrator] 子会话已完成（${payload.outcome}${payload.reason ? `, reason=${payload.reason}` : ''}）。`,
			`- 子会话: ${payload.title ?? sessionId} (id: ${sessionId})`,
			`- 轮次: ${payload.turn}${payload.durationMs !== undefined ? `，耗时 ${Math.round(payload.durationMs / 100) / 10}s` : ''}`,
		];
		if (payload.summary) lines.push(`- 最后回复:\n${clip(payload.summary, this.config.maxSummaryChars)}`);
		lines.push('', '可用 orchestrator_read_result 获取完整结果，或继续编排其他子会话。');
		try {
			const message = createUserMessage({
				content: [{ type: 'text', text: lines.join('\n') }],
				source: {
					kind: 'orchestrator',
					form: 'session-completed',
					childSessionId: sessionId,
				},
			});
			agent.followup(message);
		} catch (error) {
			this.log(`failed to notify parent ${parent.parentSessionId}: ${String(error)}`);
		}
	}

	// -----------------------------------------------------------------------
	// SSE 广播与 webhook 派发
	// -----------------------------------------------------------------------

	emit(type, payload) {
		if (this.sseClients.size === 0) return 0;
		const frame = `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
		let sent = 0;
		for (const res of this.sseClients) {
			try {
				res.write(frame);
				sent += 1;
			} catch {
				this.sseClients.delete(res);
			}
		}
		return sent;
	}

	heartbeat() {
		if (this.sseClients.size === 0) return 0;
		let sent = 0;
		for (const res of this.sseClients) {
			try {
				res.write(': ping\n\n');
				sent += 1;
			} catch {
				this.sseClients.delete(res);
			}
		}
		return sent;
	}

	registerSessionHook(sessionId, url) {
		if (typeof url !== 'string' || url.length === 0) return;
		if (!/^https?:\/\//i.test(url)) return;
		let set = this.sessionHooks.get(sessionId);
		if (set === undefined) {
			set = new Set();
			this.sessionHooks.set(sessionId, set);
		}
		set.add(url);
	}

	registerGlobalHook(url) {
		if (typeof url === 'string' && /^https?:\/\//i.test(url)) this.globalHooks.add(url);
	}

	dispatchWebhooks(eventName, payload) {
		const urls = [
			...this.globalHooks,
			...(this.sessionHooks.get(payload.sessionId) ?? []),
		];
		if (urls.length === 0) return;
		const body = JSON.stringify({ event: eventName, ...payload });
		for (const url of urls) {
			fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-dsh-orchestrator-event': eventName,
				},
				body,
				signal: AbortSignal.timeout(this.config.webhookTimeoutMs),
			}).catch((error) => {
				this.log(`webhook POST ${url} failed: ${String(error)}`);
			});
		}
	}

	log(message) {
		try {
			this.ctx?.logger?.warn?.(`[orchestrator] ${message}`);
		} catch { /* ignore */ }
	}

	// -----------------------------------------------------------------------
	// 工作区操作
	// -----------------------------------------------------------------------

	listWorkspaces() {
		return this.ctx.workspaceRegistry.list().map((entity) => ({
			workspaceId: String(entity.id),
			path: entity.path,
			title: entity.title,
			sessionIds: [...entity.sessionIds],
			createdAt: entity.createdAt,
			updatedAt: entity.updatedAt,
		}));
	}

	getWorkspace(workspaceId) {
		const entity = this.ctx.workspaceRegistry.get(workspaceId);
		if (entity === undefined) return undefined;
		return {
			workspaceId: String(entity.id),
			path: entity.path,
			title: entity.title,
			sessionIds: [...entity.sessionIds],
			createdAt: entity.createdAt,
			updatedAt: entity.updatedAt,
		};
	}

	async createWorkspace({ path, title, createDirectory = true }) {
		if (typeof path !== 'string' || path.length === 0) {
			throw Object.assign(new Error('path is required'), { code: 'gateway/bad-request' });
		}
		const absolute = isAbsolute(path) ? path : resolvePath(path);
		if (createDirectory) {
			try {
				await mkdir(absolute, { recursive: true });
			} catch (error) {
				throw Object.assign(new Error(`failed to create directory '${absolute}': ${String(error)}`), { code: 'workspace/create-failed' });
			}
		}
		const entity = await this.ctx.workspaceRegistry.create(absolute, title ?? absolute.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace');
		return {
			workspaceId: String(entity.id),
			path: entity.path,
			title: entity.title,
			sessionIds: [...entity.sessionIds],
			createdAt: entity.createdAt,
			updatedAt: entity.updatedAt,
		};
	}

	/** 删除工作区登记（保留目录与会话日志）；未知 id 幂等返回 false。 */
	async deleteWorkspace(workspaceId) {
		const registry = this.ctx.workspaceRegistry;
		if (typeof registry.delete !== 'function') {
			throw Object.assign(new Error('workspaceRegistry.delete is not available'), { code: 'internal' });
		}
		const wid = String(workspaceId ?? '');
		if (wid.length === 0) {
			throw Object.assign(new Error('workspaceId is required'), { code: 'gateway/bad-request' });
		}
		let deleted = false;
		try {
			deleted = await registry.delete(wid);
		} catch (error) {
			throw Object.assign(new Error(`workspace delete failed: ${String(error?.message ?? error)}`), { code: 'workspace/delete-failed' });
		}
		return { workspaceId: wid, deleted };
	}

	/** 把既有会话挂靠进工作区（补 cwd 建会话时缺失的 workspace 归组）。 */
	async attachSession(workspaceId, sessionId) {
		const entity = this.ctx.workspaceRegistry.get(workspaceId);
		if (entity === undefined) {
			throw Object.assign(new Error(`workspace "${workspaceId}" not found`), { code: 'workspace/not-found' });
		}
		const sid = String(sessionId ?? '');
		if (sid.length === 0) {
			throw Object.assign(new Error('sessionId is required'), { code: 'gateway/bad-request' });
		}
		try {
			await entity.attachSession(sid);
		} catch (error) {
			const message = String(error?.message ?? error);
			if (/not[- ]?found|unknown session/i.test(message)) {
				throw Object.assign(new Error(`session "${sid}" not found`), { code: 'session/not-found' });
			}
			throw Object.assign(new Error(`attachSession failed: ${message}`), { code: 'workspace/attach-failed' });
		}
		return { workspaceId: String(entity.id), sessionId: sid, attached: true, sessionIds: [...entity.sessionIds].map(String) };
	}

	/** 归档会话（workspaceRegistry.archiveSession；archived 后 list 不再返回、可重建同名）。 */
	async archiveSession(sessionId) {
		const registry = this.ctx.workspaceRegistry;
		if (typeof registry.archiveSession !== 'function') {
			throw Object.assign(new Error('workspaceRegistry.archiveSession is not available'), { code: 'internal' });
		}
		const sid = String(sessionId ?? '');
		try {
			await registry.archiveSession(sid, { stopActivity: true });
		} catch (error) {
			const message = String(error?.message ?? error);
			if (/not[- ]?found|unknown session/i.test(message)) {
				throw Object.assign(new Error(`session "${sid}" not found`), { code: 'session/not-found' });
			}
			throw Object.assign(new Error(`archiveSession failed: ${message}`), { code: 'session/archive-failed' });
		}
		return { sessionId: sid, archived: true };
	}

	/** 登记/恢复「子会话 → 父会话」通知关系（宿主重启后内存映射丢失，用本方法重建）。 */
	setRelation({ childSessionId, parentSessionId }) {
		const child = String(childSessionId ?? '');
		const parent = String(parentSessionId ?? '');
		if (child.length === 0 || parent.length === 0) {
			throw Object.assign(new Error('childSessionId and parentSessionId are required'), { code: 'gateway/bad-request' });
		}
		this.parents.set(child, { parentSessionId: parent, createdVia: 'api-restore' });
		return { childSessionId: child, parentSessionId: parent, registered: true };
	}

	listRelations() {
		return [...this.parents.entries()].map(([childSessionId, rel]) => ({
			childSessionId,
			parentSessionId: rel.parentSessionId,
			createdVia: rel.createdVia,
		}));
	}

	// -----------------------------------------------------------------------
	// 会话操作
	// -----------------------------------------------------------------------

	/**
	 * 创建会话（可选绑定工作区、发首条 prompt、登记回调与父会话）。
	 * @returns {Promise<{sessionId: string, agentPreset?: string, promptAccepted?: boolean}>}
	 */
	async createSession(request) {
		const { workspaceId, cwd, agentPreset, prompt, title, callbackUrl, notifySessionId, parentSessionId, requestId } = request ?? {};
		if (workspaceId !== undefined && cwd !== undefined) {
			throw Object.assign(new Error('accepts workspaceId or cwd, not both'), { code: 'gateway/bad-request' });
		}
		if (workspaceId !== undefined && this.ctx.workspaceRegistry.get(workspaceId) === undefined) {
			throw Object.assign(new Error(`workspace "${workspaceId}" not found`), { code: 'workspace/not-found' });
		}
		const created = await this.ctx.sessionController.create({
			...(workspaceId === undefined ? {} : { workspaceId }),
			...(cwd === undefined ? {} : { cwd: isAbsolute(cwd) ? cwd : resolvePath(cwd) }),
			...(agentPreset === undefined ? {} : { agentPreset }),
		});
		const sessionId = created.sessionId;
		// 编排关系：完成时通知谁
		const parent = notifySessionId ?? parentSessionId;
		if (parent !== undefined) {
			this.parents.set(sessionId, { parentSessionId: String(parent), createdVia: request?.createdVia ?? 'api' });
		}
		if (callbackUrl !== undefined) this.registerSessionHook(sessionId, callbackUrl);
		if (typeof title === 'string' && title.trim()) {
			try {
				await this.ctx.sessionController.rename({ sessionId, title: title.trim() });
			} catch (error) {
				this.log(`rename of new session ${sessionId} failed: ${String(error)}`);
			}
		}
		let promptAccepted;
		if (typeof prompt === 'string' && prompt.trim()) {
			promptAccepted = await this.promptSession(sessionId, prompt, requestId);
		}
		return {
			sessionId,
			...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
			...(promptAccepted === undefined ? {} : { promptAccepted }),
		};
	}

	/** 为会话选择模型（走 sessionController.selectModel：对下一次请求生效，并回存默认）。 */
	async selectSessionModel({ sessionId, provider, model, reasoningEffort }) {
		const sid = String(sessionId ?? '');
		if (sid.length === 0) throw Object.assign(new Error('sessionId is required'), { code: 'gateway/bad-request' });
		if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
			throw Object.assign(new Error('provider and model are required'), { code: 'gateway/bad-request' });
		}
		const controller = this.ctx.sessionController;
		if (typeof controller.selectModel !== 'function') {
			throw Object.assign(new Error('host sessionController does not expose selectModel'), { code: 'internal' });
		}
		const request = { sessionId: sid, provider, model };
		if (reasoningEffort !== undefined && reasoningEffort !== null && String(reasoningEffort).length > 0) {
			request.reasoningEffort = String(reasoningEffort);
		}
		const result = await controller.selectModel(request);
		return { sessionId: sid, selected: result?.selected ?? null };
	}

	/** 向会话发送一条用户消息（走 sessionController.prompt 正规通道）。 */
	async promptSession(sessionId, text, requestId, mode) {
		const content = [{ type: 'text', text: String(text ?? '') }];
		// Host 内直接调用 Remote 方法需自带 signal（包装层首行 throwIfAborted）
		const signal = new AbortController().signal;
		const result = await this.ctx.sessionController.prompt({
			sessionId,
			content,
			requestId: requestId ?? newRequestId(),
			...(mode === 'steer' ? { mode } : {}),
		}, signal);
		const accepted = result?.accepted === true;
		// 登记"已接受但尚未跑完一轮"：wait 在 agent 尚未转 running 时不能误判为空闲
		if (accepted) this.expectWork.set(sessionId, Date.now());
		return accepted;
	}

	/** 会话运行状态快照。 */
	async sessionStatus(sessionId) {
		const agent = this.ctx.agents.get(sessionId);
		const live = this.ctx.sessions.get(sessionId);
		const turnEnd = this.turnEnds.get(sessionId);
		const base = {
			sessionId,
			agentAvailable: agent !== undefined,
			status: agent === undefined ? (live === undefined ? 'unknown' : 'idle') : agent.status,
			running: agent?.status === 'running',
		};
		if (live !== undefined) {
			return {
				...base,
				title: sessionTitle(live),
				cwd: live.header?.cwd,
				parentSessionId: this.parents.get(sessionId)?.parentSessionId,
				lastTurn: turnEnd ? this.turnEndView(turnEnd) : undefined,
			};
		}
		// 冷会话：inspect 不激活 Agent
		try {
			const inspected = await this.ctx.sessionController.inspect(sessionId);
			if (inspected === undefined || inspected === null) {
				return { ...base, status: 'not-found', running: false, agentAvailable: false };
			}
			return {
				...base,
				title: sessionTitle({ id: sessionId, header: inspected.meta }),
				cwd: inspected.meta?.cwd,
				parentSessionId: this.parents.get(sessionId)?.parentSessionId,
				eventCount: Array.isArray(inspected.events) ? inspected.events.length : undefined,
			};
		} catch {
			return { ...base, status: 'not-found', running: false, agentAvailable: false };
		}
	}

	turnEndView(info) {
		return {
			turn: info.turn,
			outcome: info.outcome,
			reason: info.reason,
			durationMs: info.durationMs,
			endedAt: new Date(info.endedAt).toISOString(),
		};
	}

	/** 读取会话消息视图（user / assistant 文本）。 */
	async sessionMessages(sessionId, { limit = 50 } = {}) {
		const live = this.ctx.sessions.get(sessionId);
		let events;
		let title;
		if (live !== undefined) {
			events = eventsOf(live);
			title = sessionTitle(live);
		} else {
			const inspected = await this.ctx.sessionController.inspect(sessionId);
			if (inspected === undefined || inspected === null) return undefined;
			events = inspected.events;
			title = sessionTitle({ id: sessionId, header: inspected.meta });
		}
		if (!Array.isArray(events)) return { sessionId, title, messages: [] };
		const messages = [];
		for (const event of events) {
			if (event?.type === 'user/message' && event.surfaceOp === 'append') {
				messages.push({ role: 'user', text: textOf(event.data?.content), turn: event.data?.turn, seq: event.seq });
			} else if (event?.type === 'assistant/message' && event.surfaceOp === 'append') {
				messages.push({ role: 'assistant', text: textOf(event.data?.message?.content), turn: event.data?.turn, seq: event.seq });
			}
		}
		const trimmed = limit > 0 ? messages.slice(-limit) : messages;
		return { sessionId, title, messages: trimmed };
	}

	/** 最后一条 assistant 回复文本。 */
	async lastAssistantText(sessionId) {
		const view = await this.sessionMessages(sessionId, { limit: 0 });
		if (view === undefined) return undefined;
		for (let i = view.messages.length - 1; i >= 0; i -= 1) {
			const m = view.messages[i];
			if (m.role === 'assistant' && m.text.trim()) return m.text;
		}
		return '';
	}

	/**
	 * 等待会话到达空闲（完成）。
	 *
	 * 处理两种竞态：
	 *  - agent 尚未转 running（prompt 刚被接受）→ 不能立即判为空闲，需等其启动；
	 *  - 一轮结束后又排起了下一轮 → 继续等待，直到真正空闲或超时。
	 *
	 * 冷会话（无 agent）立即返回 idle。
	 * @returns {Promise<{idle: boolean, agentAvailable: boolean, status: string}>}
	 */
	async waitIdle(sessionId, timeoutMs = 60_000, signal) {
		const bounded = Math.min(Math.max(0, timeoutMs), 900_000);
		const deadline = Date.now() + bounded;
		for (;;) {
			if (signal?.aborted) {
				return { idle: false, agentAvailable: true, status: 'aborted', aborted: true };
			}
			const agent = this.ctx.agents.get(sessionId);
			if (agent === undefined) {
				return { idle: true, agentAvailable: false, status: 'idle' };
			}
			if (agent.status === 'running') {
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					return { idle: false, agentAvailable: true, status: agent.status, timedOut: true };
				}
				await raceAbort(signal, remaining, agent.whenIdle());
				continue;
			}
			// agent 当前 idle：若还有已接受但未跑完的 prompt（driver 尚未醒来），短轮询等待
			if (this.expectWork.has(sessionId)) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					return { idle: true, agentAvailable: true, status: 'idle', timedOut: true };
				}
				await sleep(Math.min(100, remaining));
				continue;
			}
			return { idle: true, agentAvailable: true, status: 'idle' };
		}
	}

	/** 取消会话当前活动。 */
	async cancelSession(sessionId) {
		await this.ctx.sessionController.cancel({ sessionId });
		return true;
	}

	/** 工作区会话列表（含运行状态）。 */
	async listSessions(workspaceId) {
		let workspace;
		if (workspaceId !== undefined) {
			workspace = this.ctx.workspaceRegistry.get(workspaceId);
			if (workspace === undefined) {
				throw Object.assign(new Error(`workspace "${workspaceId}" not found`), { code: 'workspace/not-found' });
			}
		}
		const listed = await this.ctx.sessionController.list({});
		let items = listed.items ?? [];
		if (workspace !== undefined) {
			const ids = new Set(workspace.sessionIds.map(String));
			items = items.filter((item) => ids.has(String(item.sessionId)));
		}
		return items.map((item) => ({
			sessionId: String(item.sessionId),
			title: item.title,
			updatedAt: item.updatedAt,
			running: item.running === true,
			agentAvailable: item.agentAvailable === true,
			blank: item.blank === true,
			cwd: item.cwd,
			parentSessionId: item.parentSessionId ?? this.parents.get(String(item.sessionId))?.parentSessionId,
		}));
	}

	/** 按 id / 标题 / 目录名解析工作区（/sessions?workspaceName= 与批量归档用）。 */
	resolveWorkspaceRef(nameOrId) {
		if (typeof nameOrId !== 'string' || nameOrId === '') return undefined;
		const workspaces = this.listWorkspaces();
		const byId = workspaces.find((w) => w.workspaceId === nameOrId);
		if (byId !== undefined) return byId;
		const byTitle = workspaces.find((w) => w.title === nameOrId);
		if (byTitle !== undefined) return byTitle;
		const base = (p) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
		return workspaces.find((w) => typeof w.path === 'string' && base(w.path) === nameOrId);
	}

	/** 归档工作区内全部未归档会话（/sessions/archive-all）。 */
	async archiveAllSessions({ workspaceName } = {}) {
		let workspaceId;
		if (workspaceName !== undefined && workspaceName !== null && workspaceName !== '') {
			const workspace = this.resolveWorkspaceRef(workspaceName);
			if (workspace === undefined) {
				throw Object.assign(new Error(`workspace "${workspaceName}" not found`), { code: 'workspace/not-found' });
			}
			workspaceId = workspace.workspaceId;
		}
		const sessions = await this.listSessions(workspaceId);
		const archived = [];
		const errors = [];
		for (const session of sessions) {
			try {
				await this.archiveSession(session.sessionId);
				archived.push(session.sessionId);
			} catch (error) {
				errors.push({ sessionId: session.sessionId, code: error?.code ?? 'archive-failed' });
			}
		}
		return { workspaceId, archived, errors };
	}

	/** 会话分页视图：assistant/message + turn/end（/sessions/:id/page）。 */
	async page(sessionId, { limit, turn } = {}) {
		const id = String(sessionId ?? '');
		const live = typeof this.ctx.sessions?.get === 'function' ? this.ctx.sessions.get(id) : undefined;
		let events;
		let title;
		if (live !== undefined && live !== null) {
			events = eventsOf(live);
			title = sessionTitle(live);
		} else {
			let inspected;
			try {
				inspected = await this.ctx.sessionController.inspect(id);
			} catch (error) {
				const message = String(error?.message ?? error);
				if (/not[- ]?found|unknown session/i.test(message)) {
					throw Object.assign(new Error(`session "${id}" not found`), { code: 'session/not-found' });
				}
				throw Object.assign(new Error(`sessionController.inspect failed: ${message}`), { code: 'internal' });
			}
			if (inspected === undefined || inspected === null) {
				throw Object.assign(new Error(`session "${id}" not found`), { code: 'session/not-found' });
			}
			events = Array.isArray(inspected) ? inspected : inspected.events;
			title = sessionTitle({ id, header: inspected?.meta });
		}
		const view = pageView(events, { limit, turn });
		const agent = typeof this.ctx.agents?.get === 'function' ? this.ctx.agents.get(id) : undefined;
		return {
			sessionId: id,
			title,
			running: agent?.status === 'running',
			agentAvailable: agent !== undefined && agent !== null,
			...view,
		};
	}
}
