// ---------------------------------------------------------------------------
// dsh-agent-bridge/lib/tools.js
//
// 模型可用的 orchestrator_* 工具集（dsh 内部主会话编排子会话）。
// 注册到 ctx.tools 后自动进入系统提示，任何 Agent 都能调用。
// ---------------------------------------------------------------------------

import { defineTool } from '@deepseek-ai/dsh-tools';
import { clip, newRequestId } from './util.js';

const JSON_OUTPUT = {
	// dsh-tools 的 raw JSON Schema 子集要求 object 显式声明 additionalProperties
	schema: { type: 'object', additionalProperties: true },
	render: (args, value) => [{
		type: 'text',
		text: JSON.stringify(value, null, 2),
	}],
};

export function mountTools(core, ctx) {
	const disposers = [];
	const register = (tool) => {
		disposers.push(ctx.tools.register(tool));
		core.toolNames.push(tool.name);
	};

	const requireSelf = (exec) => {
		const agent = exec?.agent;
		if (agent === undefined) throw new Error('orchestrator tools require an owning agent session');
		return agent;
	};

	register(defineTool({
		name: 'orchestrator_list_workspaces',
		description: 'List all workspaces (id, path, title, session count).',
		parameters: {},
		output: JSON_OUTPUT,
		isConcurrencySafe: () => true,
		execute: async () => ({ workspaces: core.listWorkspaces() }),
	}));

	register(defineTool({
		name: 'orchestrator_create_workspace',
		description: 'Create (or reuse) a workspace for an existing or newly created directory.',
		parameters: {
			path: { type: 'string', required: true, description: 'Absolute directory path for the workspace.' },
			title: { type: 'string', description: 'Display title; defaults to the directory name.' },
			create_directory: { type: 'boolean', description: 'Create the directory when missing (default true).' },
		},
		output: JSON_OUTPUT,
		execute: async (args) => ({ workspace: await core.createWorkspace({
			path: args.path,
			title: args.title,
			createDirectory: args.create_directory !== false,
		}) }),
	}));

	register(defineTool({
		name: 'orchestrator_list_sessions',
		description: 'List sessions in a workspace (or all sessions), with live running status.',
		parameters: {
			workspace_id: { type: 'string', description: 'Optional workspace id to filter by.' },
		},
		output: JSON_OUTPUT,
		isConcurrencySafe: () => true,
		execute: async (args) => ({ sessions: await core.listSessions(args.workspace_id) }),
	}));

	register(defineTool({
		name: 'orchestrator_create_session',
		description: 'Create a new child conversation in a workspace or directory and optionally send its first prompt. When it finishes, you (the parent session) are notified automatically with the result summary — do not poll.',
		parameters: {
			prompt: { type: 'string', required: true, description: 'First task prompt for the new session.' },
			workspace_id: { type: 'string', description: 'Workspace to create the session in.' },
			cwd: { type: 'string', description: 'Working directory (alternative to workspace_id).' },
			title: { type: 'string', description: 'Optional session title.' },
			agent_preset: { type: 'string', description: 'Optional agent preset id.' },
			notify: { type: 'boolean', description: 'Notify this session on completion (default true).' },
		},
		output: JSON_OUTPUT,
		execute: async (args, exec) => {
			const self = requireSelf(exec);
			const result = await core.createSession({
				...(args.workspace_id === undefined ? {} : { workspaceId: args.workspace_id }),
				...(args.cwd === undefined ? {} : { cwd: args.cwd }),
				...(args.agent_preset === undefined ? {} : { agentPreset: args.agent_preset }),
				...(args.title === undefined ? {} : { title: args.title }),
				prompt: args.prompt,
				requestId: newRequestId(),
				...(args.notify === false ? {} : { parentSessionId: String(self.id) }),
				createdVia: 'tool',
			});
			return {
				sessionId: result.sessionId,
				promptAccepted: result.promptAccepted === true,
				notify: args.notify !== false,
				hint: 'You will be notified in-session when this child session completes. Continue other work meanwhile.',
			};
		},
	}));

	register(defineTool({
		name: 'orchestrator_session_status',
		description: 'Read the current run status of one session.',
		parameters: {
			session_id: { type: 'string', required: true, description: 'Session id.' },
		},
		output: JSON_OUTPUT,
		isConcurrencySafe: () => true,
		execute: async (args) => ({ status: await core.sessionStatus(args.session_id) }),
	}));

	register(defineTool({
		name: 'orchestrator_read_result',
		description: 'Read the final result (last assistant text) of a finished session.',
		parameters: {
			session_id: { type: 'string', required: true, description: 'Session id.' },
		},
		output: JSON_OUTPUT,
		isConcurrencySafe: () => true,
		execute: async (args) => {
			const text = await core.lastAssistantText(args.session_id);
			if (text === undefined) return { error: `session "${args.session_id}" not found` };
			return { sessionId: args.session_id, result: text };
		},
	}));

	register(defineTool({
		name: 'orchestrator_prompt_session',
		description: 'Send a follow-up message to another session.',
		parameters: {
			session_id: { type: 'string', required: true, description: 'Target session id.' },
			text: { type: 'string', required: true, description: 'Message text.' },
		},
		output: JSON_OUTPUT,
		execute: async (args) => ({ accepted: await core.promptSession(args.session_id, args.text, newRequestId()) }),
	}));

	register(defineTool({
		name: 'orchestrator_wait_sessions',
		description: 'Block until the named sessions finish (idle) or the timeout expires. Use only when genuinely blocked on them; completion notifications normally arrive on their own.',
		parameters: {
			session_ids: { type: 'array', items: { type: 'string' }, required: true, description: 'Session ids to wait for.' },
			timeout_ms: { type: 'integer', description: 'Overall timeout in milliseconds (default 300000, max 900000).' },
		},
		output: JSON_OUTPUT,
		execute: async (args, exec) => {
			const timeoutMs = Math.min(Math.max(1, args.timeout_ms ?? 300_000), 900_000);
			const deadline = Date.now() + timeoutMs;
			const results = {};
			for (const sessionId of args.session_ids) {
				const remaining = Math.max(0, deadline - Date.now());
				if (remaining === 0) {
					results[sessionId] = 'timeout';
					continue;
				}
				const outcome = await core.waitIdle(sessionId, remaining, exec.signal);
				results[sessionId] = outcome.idle ? 'idle' : (outcome.timedOut ? 'timeout' : outcome.status);
			}
			return { results };
		},
	}));

	register(defineTool({
		name: 'orchestrator_cancel_session',
		description: 'Cancel the running turn of one session.',
		parameters: {
			session_id: { type: 'string', required: true, description: 'Session id.' },
		},
		output: JSON_OUTPUT,
		execute: async (args) => ({ cancelled: await core.cancelSession(args.session_id) }),
	}));

	register(defineTool({
		name: 'orchestrator_set_webhook',
		description: 'Register an HTTP webhook URL that receives session completion notifications as JSON POST callbacks (for external tools).',
		parameters: {
			url: { type: 'string', required: true, description: 'http(s) URL to POST completion events to.' },
			session_id: { type: 'string', description: 'Optional: scope to one session; omit for global.' },
		},
		output: JSON_OUTPUT,
		execute: async (args) => {
			if (!/^https?:\/\//i.test(args.url)) return { error: 'url must be an http(s) URL' };
			if (args.session_id === undefined) {
				core.registerGlobalHook(args.url);
				return { url: args.url, scope: 'global' };
			}
			core.registerSessionHook(args.session_id, args.url);
			return { url: args.url, scope: 'session', sessionId: args.session_id };
		},
	}));

	// 模型引导：告诉它这套编排工具的存在与回调语义。
	if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
		try {
			ctx.systemPrompt.section({
				name: 'tool:orchestrator',
				order: ctx.systemPrompt.getSectionOrder?.('TOOL_ORCHESTRATOR') ?? undefined,
				text: 'Orchestration: use orchestrator_create_session to run parallel tasks in child sessions (optionally inside a workspace created with orchestrator_create_workspace). Track every child session id you start. When a child session finishes, you are notified in-session with its result summary — do not busy-poll or sleep; keep working on independent steps. Use orchestrator_read_result for a full result, orchestrator_session_status for live status, orchestrator_prompt_session to send follow-ups, and orchestrator_wait_sessions only when genuinely blocked. External tools can be wired in through orchestrator_set_webhook.',
			});
			disposers.push(() => { try { ctx.systemPrompt.remove?.('tool:orchestrator'); } catch { /* ignore */ } });
		} catch { /* systemPrompt 可选 */ }
	}

	return () => {
		for (const off of disposers.splice(0)) {
			try { off(); } catch { /* ignore */ }
		}
	};
}
