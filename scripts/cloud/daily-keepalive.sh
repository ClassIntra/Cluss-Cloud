#!/usr/bin/env bash
# ============================================================
# 每日巡检入口：浏览器版优先，失败回退 WS 版。
#
# 自动停用条件（用户知情约定 2026-10-11，平台已上报风控一次，用户接受风险）：
#   · 连续 3 次失败 → 自动删除本 pm2 任务（覆盖封号、凭据全失效等一切情形）；
#   · 容器被平台回收/用户自行销毁 → pm2 随之消失，天然停用。
# ============================================================
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
FAIL_STATE="/workspace/cluss-cloud/.check-fail-count"

if node "$DIR/keepalive-browser.js"; then
  echo 0 > "$FAIL_STATE"
  exit 0
fi
echo "[keepalive] 浏览器版失败，尝试 WS 备用通道"
if node "$DIR/daily-check.js"; then
  echo 0 > "$FAIL_STATE"
  exit 0
fi

N=$(( $(cat "$FAIL_STATE" 2>/dev/null || echo 0) + 1 ))
echo "$N" > "$FAIL_STATE"
echo "[keepalive] 连续失败 $N 次"
# 每天 4 次：连续 8 次 ≈ 2 天全失败才判定死亡，瞬态故障（平台维护/网络抖动）不触发
if [ "$N" -ge 8 ]; then
  echo "[keepalive] 连续 8 次失败，自动停用巡检任务"
  command -v pm2 >/dev/null 2>&1 && pm2 delete clusscloud-check >/dev/null 2>&1 || true
  rm -f "$FAIL_STATE"
fi
exit 1
