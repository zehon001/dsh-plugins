#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# dsh-agent-bridge —— curl 端到端演示
#
# 用法：
#   ./curl-demo.sh <api-token> [base-url] [workspace-dir]
#
# 示例：
#   ./curl-demo.sh "$ORCHESTRATOR_TOKEN" http://127.0.0.1:49301 /tmp/orch-demo
#
# 流程：
#   1. health
#   2. 创建工作区
#   3. 在工作区创建对话并下发任务
#   4. SSE 实时监听完成事件
#   5. 读取最终结果
# ---------------------------------------------------------------------------
set -euo pipefail

TOKEN="${1:?usage: curl-demo.sh <api-token> [base-url] [workspace-dir]}"
BASE="${2:-http://127.0.0.1:49301}"
WS_DIR="${3:-/tmp/dsh-orchestrator-demo-$(date +%s)}"
AUTH=(-H "x-api-token: $TOKEN")

echo "==> 1. health"
curl -s "${AUTH[@]}" "$BASE/api/orchestrator/health" | python3 -m json.tool

echo "==> 2. create workspace at $WS_DIR"
WS_JSON=$(curl -s "${AUTH[@]}" -X POST "$BASE/api/orchestrator/workspaces" \
  -H 'content-type: application/json' \
  -d "{\"path\":\"$WS_DIR\",\"title\":\"curl 演示\"}")
echo "$WS_JSON" | python3 -m json.tool
WS_ID=$(echo "$WS_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["workspace"]["workspaceId"])')

echo "==> 3. create session in workspace"
SESSION_JSON=$(curl -s "${AUTH[@]}" -X POST "$BASE/api/orchestrator/sessions" \
  -H 'content-type: application/json' \
  -d "{
        \"workspaceId\":\"$WS_ID\",
        \"title\":\"演示任务\",
        \"prompt\":\"列出当前目录的文件，并用一句话总结。\"
      }")
echo "$SESSION_JSON" | python3 -m json.tool
SESSION_ID=$(echo "$SESSION_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionId"])')

echo "==> 4. follow SSE for up to 120s (Ctrl-C to stop)"
curl -s -N "${AUTH[@]}" "$BASE/api/orchestrator/events" | while IFS= read -r line; do
  case "$line" in
    event:*) echo "    $line" ;;
    data:*)  echo "      $line" ;;
    :*)      : ;;
  esac
  case "$line" in
    *'"sessionId":"'"$SESSION_ID"'"'*'"type":"session.completed"'*) break ;;
  esac
done &
SSE_PID=$!
sleep 1

echo "==> 5. wait for session completion"
curl -s "${AUTH[@]}" -X POST "$BASE/api/orchestrator/sessions/$SESSION_ID/wait" \
  -H 'content-type: application/json' -d '{"timeoutMs":120000}' | python3 -m json.tool

echo "==> 6. read final result"
curl -s "${AUTH[@]}" "$BASE/api/orchestrator/sessions/$SESSION_ID/result" | python3 -m json.tool

echo "==> 7. list sessions in workspace"
curl -s "${AUTH[@]}" "$BASE/api/orchestrator/workspaces/$WS_ID/sessions" | python3 -m json.tool

wait "$SSE_PID" 2>/dev/null || true
echo "==> done"
