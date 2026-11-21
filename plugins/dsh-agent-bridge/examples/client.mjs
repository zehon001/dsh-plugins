#!/usr/bin/env node
// ---------------------------------------------------------------------------
// dsh-agent-bridge —— 第三方 Node 客户端示例
//
// 用法：
//   node examples/client.mjs <api-token> [base-url] [workspace-dir]
//
// 演示：创建工作区、创建对话、订阅 SSE 完成事件、读取最终结果。
// ---------------------------------------------------------------------------

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = process.argv[2];
if (TOKEN === undefined) {
	console.error('usage: node client.mjs <api-token> [base-url] [workspace-dir]');
	process.exit(1);
}
const BASE = process.argv[3] ?? 'http://127.0.0.1:49301';
const WORKSPACE_DIR = process.argv[4] ?? await mkdtemp(join(tmpdir(), 'dsh-orch-'));
const PREFIX = `${BASE}/api/orchestrator`;

function client(token) {
	const call = async (method, path, body) => {
		const response = await fetch(`${PREFIX}${path}`, {
			method,
			headers: {
				'x-api-token': token,
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const json = await response.json();
		if (json.ok !== true) throw new Error(`${method} ${path} failed: ${json.error?.code} ${json.error?.message}`);
		return json;
	};
	return {
		health: () => call('GET', '/health'),
		listWorkspaces: () => call('GET', '/workspaces'),
		createWorkspace: (path, title) => call('POST', '/workspaces', { path, title }),
		createSession: (payload) => call('POST', '/sessions', payload),
		sessionStatus: (id) => call('GET', `/sessions/${encodeURIComponent(id)}`),
		sessionResult: (id) => call('GET', `/sessions/${encodeURIComponent(id)}/result`),
		listSessions: (workspaceId) => call('GET', `/workspaces/${encodeURIComponent(workspaceId)}/sessions`),
		wait: (id, timeoutMs) => call('POST', `/sessions/${encodeURIComponent(id)}/wait`, { timeoutMs }),
	};
}

/** 订阅 SSE，等待指定会话的完成事件。 */
function waitForCompletion(token, sessionId, timeoutMs = 180_000) {
	return new Promise((resolve, reject) => {
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort();
			reject(new Error('SSE timeout'));
		}, timeoutMs);
		(async () => {
			try {
				const response = await fetch(`${PREFIX}/events`, {
					headers: { 'x-api-token': token, accept: 'text/event-stream' },
					signal: controller.signal,
				});
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					let boundary;
					while ((boundary = buffer.indexOf('\n\n')) >= 0) {
						const frame = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);
						const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
						const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
						if (!eventLine || !dataLine) continue;
						const type = eventLine.slice(7).trim();
						const data = JSON.parse(dataLine.slice(6));
						if (type === 'session.completed' && data.sessionId === sessionId) {
							clearTimeout(timer);
							controller.abort();
							resolve(data);
							return;
						}
					}
				}
				clearTimeout(timer);
				reject(new Error('SSE stream ended before completion'));
			} catch (error) {
				if (controller.signal.aborted) return;
				clearTimeout(timer);
				reject(error);
			}
		})();
	});
}

const api = client(TOKEN);
console.log('health:', await api.health());

const workspace = await api.createWorkspace(WORKSPACE_DIR, 'Node 客户端演示');
console.log('workspace:', workspace.workspace.path, workspace.workspace.workspaceId);

const created = await api.createSession({
	workspaceId: workspace.workspace.workspaceId,
	title: '演示任务',
	prompt: '用三句话介绍这个目录里有什么。',
});
console.log('session created:', created.sessionId, 'promptAccepted=', created.promptAccepted);

console.log('listening SSE for completion…');
const completed = await waitForCompletion(TOKEN, created.sessionId);
console.log('completed event:', {
	outcome: completed.outcome,
	durationMs: completed.durationMs,
	summary: completed.summary?.slice(0, 120),
});

const result = await api.sessionResult(created.sessionId);
console.log('final result:', result.result.slice(0, 400));

console.log('workspace sessions:', (await api.listSessions(workspace.workspace.workspaceId)).sessions
	.map((s) => `${s.sessionId} running=${s.running}`));
