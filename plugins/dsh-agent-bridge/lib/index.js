// ---------------------------------------------------------------------------
// dsh-agent-bridge/lib/index.js
//
// 插件入口：组装 core（编排中枢）+ http（REST/SSE 网关）+ tools（模型工具）。
//
// 提供能力：
//   1. dsh 内部（Agent 工具层）：orchestrator_* 工具集
//   2. dsh 外部（第三方工具）：HTTP REST API + SSE 实时事件流 + Webhook
//   3. 会话完成 → 实时通知：SSE / Webhook / 父会话 followup 唤醒
// ---------------------------------------------------------------------------

import Schema from '@deepseek-ai/schemastery';
import { OrchestratorCore } from './core.js';
import { startHttpServer } from './http.js';
import { mountTools } from './tools.js';

export const name = 'dsh-agent-bridge';
/** cordis.patch.yml 中的 entry id */
export const ENTRY_ID = name;

// 依赖注入：sessions/agents（事件流）→ 必需；workspaceRegistry/sessionController
//（读写 API）→ 必需。HTTP 为插件自建的独立回环服务，不依赖宿主 webServer。
export const inject = ['sessions', 'agents', 'workspaceRegistry', 'sessionController'];

export const Config = Schema.object({
	enableHttp: Schema.boolean().default(true).description('Start the standalone loopback HTTP gateway (REST + SSE)'),
	host: Schema.string().default('127.0.0.1').description('Listen host (loopback only: 127.0.0.1 / ::1)'),
	port: Schema.natural().max(65535).default(49301).description('Listen port for the standalone HTTP gateway'),
	enableTools: Schema.boolean().default(true).description('Register model-facing orchestrator_* tools'),
	apiToken: Schema.string().default('').description('Optional shared secret for non-browser tools: accept requests carrying x-api-token / Authorization: Bearer <token> / ?token=; empty disables token auth'),
	notifyParentSession: Schema.boolean().default(true).description('Notify the parent session in-conversation when a child session completes'),
	parentNotifyOnInterrupted: Schema.boolean().default(true).description('Also notify the parent when a child session ends interrupted/blocked'),
	maxSummaryChars: Schema.number().default(4000).description('Maximum characters of the result summary sent in notifications'),
	webhookTimeoutMs: Schema.number().default(8000).description('Webhook POST timeout in milliseconds'),
	heartbeatMs: Schema.number().default(25000).description('SSE heartbeat interval in milliseconds'),
}).description('Workspace & session orchestration for agents and external tools');

/** 解包 cordis volatile 配置盒（设置面板热更新写入的是盒装值）。 */
export function unwrapConfig(value) {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(unwrapConfig);
	if (typeof value.get === 'function') return unwrapConfig(value.get());
	return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unwrapConfig(v)]));
}

export function apply(ctx, config = {}) {
	const resolved = unwrapConfig(config ?? {});
	const core = new OrchestratorCore(ctx, resolved);

	let stopHttp = null;
	let unmountTools = null;

	const disposeAll = () => {
		if (stopHttp) { try { void stopHttp(); } catch { /* ignore */ } stopHttp = null; }
		if (unmountTools) { try { unmountTools(); } catch { /* ignore */ } unmountTools = null; }
		try { core.dispose(); } catch { /* ignore */ }
	};

	if (typeof ctx.effect === 'function') {
		ctx.effect(() => () => disposeAll(), 'orchestrator: lifecycle');
	}
	if (typeof ctx.on === 'function') ctx.on('dispose', disposeAll);

	// 模型工具：与 Host 服务同 Context 注册（tools 服务全局可见）
	if (resolved.enableTools !== false) {
		ctx.inject(['tools'], (toolCtx) => {
			try {
				unmountTools = mountTools(core, toolCtx);
				ctx.logger?.info?.('[orchestrator] tools mounted');
			} catch (error) {
				ctx.logger?.error?.(`[orchestrator] tools mount failed: ${error instanceof Error ? error.stack : String(error)}`);
				throw error;
			}
		});
	}

	// HTTP 网关：独立回环服务（固定端口 49301，不注册到宿主 webServer）
	if (resolved.enableHttp !== false) {
		void startHttpServer({
			core,
			host: resolved.host ?? '127.0.0.1',
			port: resolved.port ?? 49301,
			logger: ctx.logger,
		})
			.then((handle) => {
				stopHttp = handle.close;
				ctx.logger?.info?.(`[orchestrator] http listening on ${handle.url}`);
			})
			.catch((error) => {
				ctx.logger?.error?.(
					`[orchestrator] http listen failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
	}

	ctx.logger?.info?.('[orchestrator] plugin active: tools='
		+ String(resolved.enableTools !== false)
		+ ' http=' + String(resolved.enableHttp !== false));
}
