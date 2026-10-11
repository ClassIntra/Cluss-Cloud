#!/usr/bin/env bash
# ============================================================
# Cluss-Cloud 保活 + 数据外备（本地 Windows / Git Bash，每日定时）
# 1. 确保 cloudflared access 隧道活着  2. 云端在线备份  3. 拉回本地
# ⚠️ 云机重置后隧道域名会变，本脚本会失败并留日志 —— 那时按
#    Cluss 仓 docs/cloud-runbook.md 的思路在共享终端重建，再跑
#    deploy.sh --restore-latest deploy
# ============================================================
set -uo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$REPO_DIR/backups/cloud/keepalive.log"
ACCESS_HOST="${CLOUD_CF_HOST:-armed-ana-luck-hartford.trycloudflare.com}"
LOCAL_PORT="${CLOUD_SSH_PORT:-2222}"
mkdir -p "$REPO_DIR/backups/cloud"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

if ! (echo > /dev/tcp/127.0.0.1/$LOCAL_PORT) >/dev/null 2>&1; then
  log "access 隧道不在，重启: $ACCESS_HOST -> 127.0.0.1:$LOCAL_PORT"
  nohup "$HOME/bin/cloudflared.exe" access tcp \
    --hostname "$ACCESS_HOST" --url "127.0.0.1:$LOCAL_PORT" \
    --loglevel error >> "$LOG" 2>&1 &
  sleep 6
fi
log "=== 开始每日备份 ==="
if CLOUD_SSH_HOST=127.0.0.1 CLOUD_SSH_PORT=$LOCAL_PORT \
   bash "$REPO_DIR/scripts/cloud/deploy.sh" --pull-backup >> "$LOG" 2>&1; then
  log "备份成功"
  # 顺带汇报每日巡检健康度（最近一次巡检记录距今多久）
  CHECK_INFO=$($SSH "ls -1t $DEPLOY_DIR/checks/*.log 2>/dev/null | head -1 | xargs -r basename" 2>/dev/null || true)
  log "最近巡检记录: ${CHECK_INFO:-无（巡检未运行或失败，需检查 clusscloud-check）}"
else
  log "备份失败（云机可能已重置或隧道失效，需按 runbook 重建）"
  exit 1
fi
