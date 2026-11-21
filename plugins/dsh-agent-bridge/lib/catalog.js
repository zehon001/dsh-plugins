// ---------------------------------------------------------------------------
// dsh-agent-bridge/lib/catalog.js
//
// DSH 本机能力目录（模型 / 思考强度 / 权限预设）——HTTP GET /capabilities 的
// 数据源。由插件在 DSH 进程内直接读取宿主配置，外部工具无需再解析本地 YAML：
//   - ~/.dsh/settings.yaml            llm-pi-ai.providers.*.models[]（模型目录）
//   - ~/.dsh/profiles/<profile>/cordis.patch.yml
//                                     dsh-permission-presets（权限预设 + 默认值）
//
// 零依赖低配 YAML 行解析；解析失败各自兜底为空表（链路不因此报错）。
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CATALOG_TTL_MS = 60_000;
let cache = null;

/** DSH 根目录（DSH_HOME 覆盖；缺省 ~/.dsh） */
function dshHome() {
	return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
}

/** DSH profile（BP_DSH_PROFILE 覆盖；桌面端缺省 desktop） */
function dshProfile() {
	return process.env.BP_DSH_PROFILE?.trim() || 'desktop';
}

/**
 * 解析 settings.yaml 的模型目录（llm-pi-ai.providers.*.models[]）：
 * 逐行缩进扫描——`models:` 开块，`- id:` 开新条目，条目内收集 name 与
 * reasoningEfforts 的键（低配 YAML，无依赖；解析失败返回空表由调用方兜底）。
 */
export function parseDshModelCatalog(text) {
	const out = [];
	let provider = '';
	let modelsIndent = null;
	let current = null;
	let inEfforts = false;
	for (const raw of text.split(/\r?\n/)) {
		if (!raw.trim() || raw.trim().startsWith('#')) continue;
		const indent = raw.length - raw.trimStart().length;
		const line = raw.trim();
		const isBareKey = /^([A-Za-z][\w-]*):\s*$/.exec(line);
		const bareKey = isBareKey ? isBareKey[1] : '';
		const isProviderKey = bareKey !== '' && modelsIndent === null && !['llm-pi-ai', 'providers', 'models'].includes(bareKey);
		if (isProviderKey) provider = bareKey;
		if (modelsIndent === null) {
			if (/^models:\s*$/.test(line)) modelsIndent = indent;
			continue;
		}
		if (/^-\s+id:\s*(.+)$/.test(line) && indent === modelsIndent + 2) {
			const id = /-\s+id:\s*(.+)$/.exec(line)[1].trim();
			current = { id, name: '', efforts: [], provider };
			inEfforts = false;
			out.push(current);
			continue;
		}
		if (indent <= modelsIndent) {
			if (/^models:\s*$/.test(line)) continue;
			modelsIndent = null;
			current = null;
			inEfforts = false;
			continue;
		}
		if (!current) continue;
		const nameMatch = /^name:\s*(.+)$/.exec(line);
		if (nameMatch && !inEfforts) {
			current.name = nameMatch[1].trim();
			continue;
		}
		if (/^reasoningEfforts:\s*$/.test(line)) {
			inEfforts = true;
			continue;
		}
		if (inEfforts) {
			const effortMatch = /^"?([A-Za-z][\w-]*)"?:\s/.exec(line);
			if (effortMatch) {
				current.efforts.push(effortMatch[1]);
				continue;
			}
			inEfforts = false;
		}
	}
	return out;
}

/**
 * 解析 profile cordis.patch.yml 的权限预设（dsh-permission-presets 条目的
 * presets 键列表 + defaultPreset）。
 */
export function parseDshPermissionConfig(text) {
	const lines = text.split(/\r?\n/);
	let scope = false;
	let pendingName = false;
	let presetsIndent = null;
	const presets = [];
	let defaultPreset = '';
	for (const raw of lines) {
		const indent = raw.length - raw.trimStart().length;
		const line = raw.trim();
		if (!scope) {
			if (/^-\s+id:\s*@deepseek-ai\/dsh-permission-presets\s*$/.test(line)) scope = true;
			else if (/^-\s+id:/.test(line)) pendingName = true;
			else if (pendingName && /^name:\s*"?.*dsh-permission-presets/.test(line)) scope = true;
			else if (line !== '') pendingName = false;
			continue;
		}
		if (/^-\s+id:/.test(line)) break;
		if (presetsIndent === null) {
			if (/^presets:\s*$/.test(line)) presetsIndent = indent;
			continue;
		}
		if (/^defaultPreset:/.test(line)) break;
		const key = /^([\w-]+):\s*$/.exec(line);
		if (key && indent === presetsIndent + 2) presets.push(key[1]);
		else if (indent <= presetsIndent) break;
	}
	for (const raw of lines) {
		const m = /^defaultPreset:\s*(.+)$/.exec(raw.trim());
		if (m) {
			defaultPreset = m[1].trim().replace(/^['"]|['"]$/g, '');
			break;
		}
	}
	return { presets, defaultPreset };
}

/** 读取能力目录（60s 缓存；读盘失败各自兜底为空表） */
export function readCapabilityCatalog() {
	if (cache !== null && Date.now() - cache.at < CATALOG_TTL_MS) return cache;
	const models = [];
	const efforts = new Set();
	const providerByModel = {};
	try {
		const entries = parseDshModelCatalog(
			fs.readFileSync(path.join(dshHome(), 'settings.yaml'), 'utf8'),
		);
		for (const entry of entries) {
			models.push({
				id: entry.id,
				name: entry.name || entry.id,
				provider: entry.provider,
				efforts: entry.efforts,
			});
			providerByModel[entry.id] = entry.provider;
			for (const effort of entry.efforts) efforts.add(effort);
		}
	} catch {
		/* settings.yaml 不可读：模型目录留空 */
	}
	let permissions = [];
	let defaultPreset = '';
	try {
		const perm = parseDshPermissionConfig(
			fs.readFileSync(path.join(dshHome(), 'profiles', dshProfile(), 'cordis.patch.yml'), 'utf8'),
		);
		permissions = perm.presets;
		defaultPreset = perm.defaultPreset;
	} catch {
		/* profile 不可读：权限预设留空 */
	}
	const defaults = {
		model: models[0]?.id ?? '',
		reasoning: models[0]?.efforts?.[0] ?? '',
		permission: defaultPreset,
	};
	cache = {
		at: Date.now(),
		models,
		reasoningLevels: [...efforts],
		permissions,
		defaults,
		providerByModel,
	};
	return cache;
}
