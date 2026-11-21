#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 把 dsh-agent-bridge 同步安装到桌面 profile。
#
# 用法：
#   ./scripts/install-desktop.sh
#
# 说明：
#   - pnpm 的 file: 依赖是"复制"语义且按包内容缓存；改动源码后必须删除旧副本
#     再 install，本脚本已处理。
#   - 桌面应用需要重启后才会加载新插件（profile 无 HMR）。
#   - 脚本末尾会做静态检查并打印重启后的验证命令。
# ---------------------------------------------------------------------------
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ROOT="/Applications/DeepSeek Harness.app/Contents/Resources"
NODE="$APP_ROOT/runtime/primary-runtime/dependencies/node/bin/node"
PNPM="$APP_ROOT/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
PROFILE="$HOME/.dsh/profiles/desktop"

[ -x "$NODE" ] || { echo "未找到 DSH 自带 Node: $NODE" >&2; exit 1; }
[ -d "$PROFILE" ] || { echo "未找到桌面 profile: $PROFILE" >&2; exit 1; }

echo "==> 安装 $PLUGIN_DIR 到 $PROFILE"
cd "$PROFILE"
"$NODE" -e '
  const fs = require("fs");
  const file = "package.json";
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  p.dependencies ??= {};
  p.dsh ??= {};
  p.dsh.profile ??= {};
  p.dsh.profile.bundles ??= [];
  p.dependencies["dsh-agent-bridge"] = "file:" + process.argv[1];
  if (!p.dsh.profile.bundles.includes("dsh-agent-bridge")) {
    p.dsh.profile.bundles.push("dsh-agent-bridge");
  }
  fs.writeFileSync(file, JSON.stringify(p, null, 2) + "\n");
' "$PLUGIN_DIR"

# pnpm 按内容缓存 file: 依赖，先移除旧副本确保同步最新源码
rm -rf node_modules/dsh-agent-bridge
"$NODE" "$PNPM" install --no-frozen-lockfile

echo "==> 静态检查"
test -f node_modules/dsh-agent-bridge/lib/index.js || { echo "缺少 lib/index.js" >&2; exit 1; }
test -f node_modules/dsh-agent-bridge/cordis.patch.yml || { echo "缺少 cordis.patch.yml" >&2; exit 1; }
"$NODE" -e '
  const p = require("./package.json");
  const b = p.dsh.profile.bundles;
  if (!b.includes("dsh-agent-bridge")) throw new Error("bundle 未登记");
  if (!p.dependencies["dsh-agent-bridge"]) throw new Error("依赖未登记");
  console.log("   bundles:", b.join(", "));
'

cat << 'EOF'

==> 完成。请重启 DSH 桌面应用，然后验证：

  # 1) 用插件配置的 apiToken 直连独立回环服务：
  TOKEN=<apiToken>
  curl -H "x-api-token: $TOKEN" http://127.0.0.1:49301/api/orchestrator/health

  # 期望：{"ok":true,...,"port":49301,"toolsMounted":true,"toolNames":[...10 个工具...]}

  # 2) 在 GUI 新建一个对话，让它“创建两个并行子任务并汇总结果”，
  #    会看到 orchestrator_create_session 被调用，子任务完成后主会话收到通知。
EOF
