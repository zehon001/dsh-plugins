// ---------------------------------------------------------------------------
// dsh-agent-bridge/lib/http.js
//
// 独立回环 HTTP 服务（默认 127.0.0.1:49301）：
//   - 不注册到 DSH 原生 webServer，自建 node:http 监听器；
//   - 端口固定，外部工具直接访问，无需发现文件/端口探测。
//
// 安全模型：
//   1. 只允许回环地址监听（127.0.0.1 / ::1）；
//   2. 每个请求校验 remoteAddress 必须是回环，否则 403；
//   3. /livez 公开；其余端点要求插件 apiToken（x-api-token / Authorization: Bearer / ?token=，
//      恒定时间比较；apiToken 为空时仅允许回环访问）；
//   4. 请求体上限 1 MiB。
//
// 路由（前缀 /api/orchestrator）：
//   GET  /livez                          最小存活检查（无 token）
//   GET  /health                         健康检查 + 监听信息 + 工具名
//   GET  /capabilities                   能力目录（模型 / 思考强度 / 权限预设 / 默认值）
//   GET  /workspaces                     列出工作区
//   POST /workspaces                     创建工作区 {path,title,createDirectory}
//   GET  /workspaces/:id                 读取单个工作区
//   DELETE /workspaces/:id               删除工作区登记（保留目录与会话日志）
//   POST /workspaces/:id/attach          挂靠既有会话进工作区 {sessionId}
//   GET  /workspaces/:id/sessions        工作区会话列表
//   GET  /sessions                       全部会话列表（?workspaceId= / ?workspaceName= 过滤）
//   POST /sessions                       创建会话 {workspaceId|cwd,prompt,...}
//   POST /sessions/archive-all           归档全部（可 ?workspaceName=）{workspaceName?}
//   GET  /sessions/:id                   会话运行状态
//   GET  /sessions/:id/messages          会话消息视图
//   GET  /sessions/:id/result            最后一条 assistant 回复
//   GET  /sessions/:id/page              assistant/message + turn/end 分页视图
//   POST /sessions/:id/prompt            发送消息 {text, requestId, mode}
//   POST /sessions/:id/model             选择模型 {provider, model, reasoningEffort}
//   POST /sessions/:id/cancel            取消当前活动
//   POST /sessions/:id/archive           归档会话
//   POST /sessions/:id/wait              等待完成 {timeoutMs}
//   POST|GET /relations                  登记/列出「子→父」通知关系
//   POST /hooks                          注册全局 webhook {url}
//   DELETE /hooks                        清空全局 webhook
//   GET  /events                         SSE 事件流
// ---------------------------------------------------------------------------

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readCapabilityCatalog } from './catalog.js';

const PREFIX = '/api/orchestrator';
const VERSION = '0.2.0';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 49301;
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 25_000;

/** 回环地址判定（IPv4 / IPv6 / IPv4-mapped）。 */
function isLoopbackAddress(address) {
	if (typeof address !== 'string' || address === '') return false;
	if (address === '::1') return true;
	const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
	return /^127(?:\.\d{1,3}){3}$/.test(ipv4);
}

/** 恒定时间 token 比较。 */
function tokensEqual(presented, expected) {
	if (typeof presented !== 'string' || typeof expected !== 'string') return false;
	const a = Buffer.from(presented, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	if (a.length !== b.length) return false;
	try {
		return timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

/** 监听地址归一：只允许回环。 */
function normalizeListenHost(host) {
	const value = typeof host === 'string' && host.trim() !== '' ? host.trim() : DEFAULT_HOST;
	if (value === 'localhost' || value === '127.0.0.1') return '127.0.0.1';
	if (value === '::1') return '::1';
	throw new Error(`orchestrator http: host ${JSON.stringify(value)} is not a loopback address`);
}

function headerValue(req, name) {
	const raw = req.headers?.[name];
	return Array.isArray(raw) ? raw[0] : raw;
}

/** 从 x-api-token / Authorization: Bearer / ?token= 提取凭证。 */
function presentedToken(req) {
	const direct = headerValue(req, 'x-api-token');
	if (typeof direct === 'string' && direct.length > 0) return direct;
	const auth = headerValue(req, 'authorization');
	if (typeof auth === 'string') {
		const match = /^Bearer[ \t]+(.+)$/i.exec(auth.trim());
		if (match !== null) return match[1].trim();
	}
	try {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const query = url.searchParams.get('token');
		if (query !== null && query !== '') return query;
	} catch {
		/* ignore */
	}
	return undefined;
}

/**
 * 构造请求处理器。
 * @param {import('./core.js').OrchestratorCore} core
 * @param {{ getInfo?: () => {host?: string, port?: number, url?: string}, startedAt?: number, logger?: any }} [options]
 */
export function createHttpHandler(core, options = {}) {
	const clients = new Set();
	const startedAt = options.startedAt ?? Date.now();
	const getInfo = options.getInfo ?? (() => ({}));
	const logger = options.logger;

	const respond = (res, status, body) => {
		if (res.writableEnded) return;
		const payload = JSON.stringify(body);
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'content-length': Buffer.byteLength(payload),
			'x-content-type-options': 'nosniff',
		});
		res.end(payload);
	};
	const ok = (res, body) => respond(res, 200, body ?? { ok: true });
	const fail = (res, status, code, message, extra) =>
		respond(res, status, { ok: false, error: { code, message, ...extra } });

	const errorStatusOf = (code) => {
		if (code === 'workspace/not-found' || code === 'session/not-found') return 404;
		if (code === 'gateway/bad-request') return 400;
		if (code === 'session/agent-busy' || code === 'session/steer-unavailable') return 409;
		if (code === 'unauthorized') return 401;
		if (code === 'forbidden') return 403;
		return 500;
	};

	/** 认证（不读 body）。通过返回 true；失败已写响应并返回 false。 */
	const authenticate = (req, res) => {
		if (!isLoopbackAddress(req.socket?.remoteAddress)) {
			fail(res, 403, 'forbidden', 'remote address is not loopback');
			return false;
		}
		const expected = typeof core.config.apiToken === 'string' ? core.config.apiToken : '';
		if (expected === '') return true; // 仅回环监听；未配置 token 时信任本机
		const presented = presentedToken(req);
		if (presented === undefined || !tokensEqual(presented, expected)) {
			fail(res, 401, 'unauthorized', 'missing or invalid api token');
			return false;
		}
		return true;
	};

	const readBody = async (req, res) => {
		if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return {};
		const chunks = [];
		let size = 0;
		let tooLarge = false;
		for await (const chunk of req) {
			size += chunk.length;
			if (size > DEFAULT_BODY_LIMIT_BYTES) {
				tooLarge = true;
				req.resume();
				break;
			}
			chunks.push(chunk);
		}
		if (tooLarge) {
			fail(res, 413, 'body-too-large', `request body exceeds ${DEFAULT_BODY_LIMIT_BYTES} bytes`);
			return undefined;
		}
		try {
			const raw = Buffer.concat(chunks).toString('utf8');
			if (!raw) return {};
			const parsed = JSON.parse(raw);
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				fail(res, 400, 'gateway/bad-request', 'request body must be a JSON object');
				return undefined;
			}
			return parsed;
		} catch {
			fail(res, 400, 'gateway/bad-request', 'request body must be valid JSON');
			return undefined;
		}
	};

	const asyncHandler = (handler) => (req, res) => {
		Promise.resolve(handler(req, res)).catch((error) => {
			const info = { code: error?.code, message: error instanceof Error ? error.message : String(error) };
			try {
				logger?.warn?.(`[orchestrator] http handler failure: ${info.message}`);
			} catch { /* ignore */ }
			if (!res.writableEnded) fail(res, errorStatusOf(info.code), info.code ?? 'internal', info.message);
		});
	};

	/** SSE 握手。 */
	const handleEvents = (req, res) => {
		if (req.method !== 'GET') {
			fail(res, 405, 'method-not-allowed', 'use GET');
			return;
		}
		res.writeHead(200, {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
		});
		res.write(': connected\n\n');
		res.write(`event: ready\ndata: ${JSON.stringify({ type: 'ready', clients: core.sseClients.size + 1 })}\n\n`);
		core.sseClients.add(res);
		clients.add(res);
		const onEnd = () => {
			core.sseClients.delete(res);
			clients.delete(res);
		};
		req.on('close', onEnd);
		res.on('close', onEnd);
		res.on('error', onEnd);
	};

	const route = (method, subpath, handler) => ({ method, subpath, handler });

	const routes = [
		route('GET', /^\/workspaces$/, async (req, res) => {
			ok(res, { ok: true, workspaces: core.listWorkspaces() });
		}),
		route('POST', /^\/workspaces$/, async (req, res, _match, body) => {
			if (typeof body.path !== 'string' || body.path.length === 0) {
				fail(res, 400, 'gateway/bad-request', 'path is required');
				return;
			}
			const workspace = await core.createWorkspace({
				path: body.path,
				title: body.title,
				createDirectory: body.createDirectory !== false,
			});
			ok(res, { ok: true, workspace });
		}),
		route('GET', /^\/workspaces\/([^/]+)$/, async (req, res, match) => {
			const workspace = core.getWorkspace(decodeURIComponent(match[1]));
			if (workspace === undefined) {
				fail(res, 404, 'workspace/not-found', 'unknown workspace id');
				return;
			}
			ok(res, { ok: true, workspace });
		}),
		route('GET', /^\/workspaces\/([^/]+)\/sessions$/, async (req, res, match) => {
			const sessions = await core.listSessions(decodeURIComponent(match[1]));
			ok(res, { ok: true, sessions });
		}),
		route('DELETE', /^\/workspaces\/([^/]+)$/, async (req, res, match) => {
			const result = await core.deleteWorkspace(decodeURIComponent(match[1]));
			ok(res, { ok: true, ...result });
		}),
		route('POST', /^\/workspaces\/([^/]+)\/attach$/, async (req, res, match, body) => {
			const result = await core.attachSession(decodeURIComponent(match[1]), body.sessionId);
			ok(res, { ok: true, ...result });
		}),
		route('GET', /^\/sessions$/, async (req, res) => {
			const url = new URL(req.url, 'http://127.0.0.1');
			const name = url.searchParams.get('workspaceName');
			const id = url.searchParams.get('workspaceId');
			let workspaceId = id ?? undefined;
			if (name !== null && name !== '') {
				const workspace = core.resolveWorkspaceRef(name);
				if (workspace === undefined) {
					fail(res, 404, 'workspace/not-found', `workspace "${name}" not found`);
					return;
				}
				workspaceId = workspace.workspaceId;
			}
			const sessions = await core.listSessions(workspaceId);
			ok(res, { ok: true, sessions });
		}),
		route('POST', /^\/sessions$/, async (req, res, _match, body) => {
			const result = await core.createSession(body);
			ok(res, { ok: true, ...result });
		}),
		route('POST', /^\/sessions\/archive-all$/, async (req, res, _match, body) => {
			const result = await core.archiveAllSessions({ workspaceName: body.workspaceName });
			ok(res, { ok: true, ...result });
		}),
		route('GET', /^\/sessions\/([^/]+)$/, async (req, res, match) => {
			const sessionId = decodeURIComponent(match[1]);
			const status = await core.sessionStatus(sessionId);
			if (status.status === 'not-found') {
				fail(res, 404, 'session/not-found', `session "${sessionId}" not found`);
				return;
			}
			ok(res, { ok: true, status });
		}),
		route('GET', /^\/sessions\/([^/]+)\/messages$/, async (req, res, match) => {
			const url = new URL(req.url, 'http://127.0.0.1');
			const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
			const view = await core.sessionMessages(decodeURIComponent(match[1]), {
				limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
			});
			if (view === undefined) {
				fail(res, 404, 'session/not-found', 'session not found');
				return;
			}
			ok(res, { ok: true, ...view });
		}),
		route('GET', /^\/sessions\/([^/]+)\/page$/, async (req, res, match) => {
			const url = new URL(req.url, 'http://127.0.0.1');
			const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
			const turnRaw = url.searchParams.get('turn');
			const turn = turnRaw === null ? undefined : Number.parseInt(turnRaw, 10);
			const page = await core.page(decodeURIComponent(match[1]), {
				limit: Number.isFinite(limit) ? limit : 50,
				turn: Number.isFinite(turn) ? turn : undefined,
			});
			ok(res, { ok: true, ...page });
		}),
		route('GET', /^\/sessions\/([^/]+)\/result$/, async (req, res, match) => {
			const sessionId = decodeURIComponent(match[1]);
			const text = await core.lastAssistantText(sessionId);
			if (text === undefined) {
				fail(res, 404, 'session/not-found', 'session not found');
				return;
			}
			ok(res, { ok: true, sessionId, result: text });
		}),
		route('POST', /^\/sessions\/([^/]+)\/prompt$/, async (req, res, match, body) => {
			if (typeof body.text !== 'string' || body.text.trim().length === 0) {
				fail(res, 400, 'gateway/bad-request', 'text is required');
				return;
			}
			const accepted = await core.promptSession(
				decodeURIComponent(match[1]),
				body.text,
				body.requestId,
				body.mode === 'steer' ? 'steer' : undefined,
			);
			ok(res, { ok: true, accepted });
		}),
		route('POST', /^\/sessions\/([^/]+)\/model$/, async (req, res, match, body) => {
			const result = await core.selectSessionModel({
				sessionId: decodeURIComponent(match[1]),
				provider: body.provider,
				model: body.model,
				reasoningEffort: body.reasoningEffort,
			});
			ok(res, { ok: true, ...result });
		}),
		route('POST', /^\/sessions\/([^/]+)\/cancel$/, async (req, res, match) => {
			await core.cancelSession(decodeURIComponent(match[1]));
			ok(res, { ok: true, cancelled: true });
		}),
		route('POST', /^\/sessions\/([^/]+)\/wait$/, async (req, res, match, body) => {
			const url = new URL(req.url, 'http://127.0.0.1');
			const fromQuery = Number.parseInt(url.searchParams.get('timeoutMs') ?? '', 10);
			const timeoutMs = Number.isFinite(body.timeoutMs) ? body.timeoutMs : Number.isFinite(fromQuery) ? fromQuery : 60_000;
			const result = await core.waitIdle(decodeURIComponent(match[1]), timeoutMs);
			ok(res, { ok: true, sessionId: decodeURIComponent(match[1]), ...result });
		}),
		route('POST', /^\/sessions\/([^/]+)\/archive$/, async (req, res, match) => {
			const result = await core.archiveSession(decodeURIComponent(match[1]));
			ok(res, { ok: true, ...result });
		}),
		route('POST', /^\/relations$/, async (req, res, _match, body) => {
			const result = core.setRelation(body);
			ok(res, { ok: true, ...result });
		}),
		route('GET', /^\/relations$/, async (req, res) => {
			ok(res, { ok: true, relations: core.listRelations() });
		}),
		route('POST', /^\/hooks$/, async (req, res, _match, body) => {
			if (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url)) {
				fail(res, 400, 'gateway/bad-request', 'url must be an http(s) URL');
				return;
			}
			core.registerGlobalHook(body.url);
			ok(res, { ok: true, url: body.url });
		}),
		route('DELETE', /^\/hooks$/, async (req, res) => {
			core.globalHooks.clear();
			ok(res, { ok: true });
		}),
	];

	const dispatch = asyncHandler(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		// /livez 公开：最小存活检查（仍要求回环来源）
		if (url.pathname === `${PREFIX}/livez`) {
			if (!isLoopbackAddress(req.socket?.remoteAddress)) {
				fail(res, 403, 'forbidden', 'remote address is not loopback');
				return;
			}
			ok(res, { ok: true, plugin: 'dsh-agent-bridge', alive: true });
			return;
		}
		if (!authenticate(req, res)) return;
		if (url.pathname === `${PREFIX}/events`) {
			handleEvents(req, res);
			return;
		}
		if (url.pathname === `${PREFIX}/health`) {
			const info = getInfo();
			ok(res, {
				ok: true,
				plugin: 'dsh-agent-bridge',
				version: VERSION,
				pid: process.pid,
				host: info.host,
				port: info.port,
				url: info.url,
				uptimeSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
				toolsMounted: core.toolNames.length > 0,
				toolNames: [...core.toolNames],
				apiTokenConfigured: (core.config.apiToken ?? '').length > 0,
			});
			return;
		}
		if (url.pathname === `${PREFIX}/capabilities`) {
			const catalog = readCapabilityCatalog();
			ok(res, {
				ok: true,
				plugin: 'dsh-agent-bridge',
				version: VERSION,
				platform: 'dsh',
				connected: true,
				models: catalog.models,
				reasoningLevels: catalog.reasoningLevels,
				permissions: catalog.permissions,
				defaults: catalog.defaults,
				at: catalog.at,
			});
			return;
		}
		const subpath = url.pathname.slice(PREFIX.length) || '/';
		const body = await readBody(req, res);
		if (body === undefined) return;
		for (const entry of routes) {
			if (req.method !== entry.method) continue;
			const match = entry.subpath.exec(subpath);
			if (match === null) continue;
			await entry.handler(req, res, match, body);
			return;
		}
		fail(res, 404, 'not-found', `no orchestrator route for ${req.method} ${subpath}`);
	});

	const dispose = () => {
		for (const res of [...clients]) {
			try { res.end(); } catch { /* ignore */ }
		}
		clients.clear();
		core.sseClients.clear();
	};

	return { handler: dispatch, dispose };
}

/**
 * 启动独立回环 HTTP 服务（默认 127.0.0.1:49301）。
 * @returns {Promise<{server: import('node:http').Server, host: string, port: number, url: string, close: () => Promise<void>}>}
 */
export async function startHttpServer({ core, host = DEFAULT_HOST, port = DEFAULT_PORT, logger }) {
	const listenHost = normalizeListenHost(host);
	const info = { host: listenHost, port, url: '' };
	const { handler, dispose } = createHttpHandler(core, { getInfo: () => info, logger });
	const server = createServer(handler);
	server.requestTimeout = 30_000;
	server.headersTimeout = 10_000;
	server.keepAliveTimeout = 5_000;
	const heartbeat = setInterval(() => core.heartbeat(), DEFAULT_HEARTBEAT_MS);
	heartbeat.unref?.();
	await new Promise((resolvePromise, reject) => {
		const onError = (error) => {
			server.off('listening', onListening);
			clearInterval(heartbeat);
			reject(new Error(`orchestrator http: cannot listen on ${listenHost}:${port} (${error?.code ?? 'error'})`));
		};
		const onListening = () => {
			server.off('error', onError);
			resolvePromise();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(port, listenHost);
	});
	const address = server.address();
	const boundPort = address !== null && typeof address === 'object' ? address.port : port;
	const printable = listenHost.includes(':') ? `[${listenHost}]` : listenHost;
	info.port = boundPort;
	info.url = `http://${printable}:${boundPort}`;
	return {
		server,
		host: listenHost,
		port: boundPort,
		url: info.url,
		close: () =>
			new Promise((resolvePromise) => {
				clearInterval(heartbeat);
				dispose();
				try {
					server.close(() => resolvePromise());
					server.closeAllConnections?.();
				} catch {
					resolvePromise();
				}
			}),
	};
}
