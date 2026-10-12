#!/usr/bin/env bash
# ============================================================
# Cluss-Cloud 保活 + 数据外备（本地 Windows / Git Bash，每日定时）
# 1. 确保 cloudflared access 隧道活着  2. 云端在线备份  3. 拉回本地
#
# ⚠️ 隧道域名不是常量：quick tunnel 每次重启随机分配。
#    云机重置或隧道重启后域名必变，脚本会失败并留日志。
#    重建办法（别猜、别问人，去云机上看它自己打印的那行）：
#      grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' <隧道日志>
#    然后 CLOUD_CF_HOST=<新域名> bash scripts/cloud/keepalive.sh 跑一次。
#
# ⚠️ 端口默认 2222 曾被本机 LDPlayer 模拟器占着，裸 TCP 探测会误判隧道还活着，
#    于是隧道死了也不重启。这里改成探测「我们自己的 cloudflared 进程 + 真连一次 SSH」。
# ============================================================
set -uo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$REPO_DIR/backups/cloud/keepalive.log"
ACCESS_HOST="${CLOUD_CF_HOST:-armed-ana-luck-hartford.trycloudflare.com}"
LOCAL_PORT="${CLOUD_SSH_PORT:-2299}"
KEY="${CLOUD_SSH_KEY:-$HOME/.ssh/cluss_cloud}"
mkdir -p "$REPO_DIR/backups/cloud"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

tunnel_alive() {
  # 光看端口在监听不够（别人可能占着同一个端口）。真打一次 SSH 握手才算数。
  ssh -i "$KEY" -p "$LOCAL_PORT" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=12 -o BatchMode=yes -o LogLevel=ERROR \
    root@127.0.0.1 'echo ok' 2>/dev/null | grep -q ok
}

if tunnel_alive; then
  log "隧道正常（$ACCESS_HOST -> 127.0.0.1:$LOCAL_PORT）"
else
  log "隧道不可用，重启: $ACCESS_HOST -> 127.0.0.1:$LOCAL_PORT"
  # 端口可能被无关程序占着；先确认占用者不是我们的 cloudflared
  if netstat -ano | grep LISTENING | grep -q ":$LOCAL_PORT "; then
    log "端口 $LOCAL_PORT 已被其他程序占用，先清掉"
    PID=$(netstat -ano | grep LISTENING | grep ":$LOCAL_PORT " | head -1 | awk '{print $NF}')
    taskkill //PID "$PID" //F >>"$LOG" 2>&1 || true
    sleep 2
  fi
  nohup "$HOME/bin/cloudflared.exe" access tcp \
    --hostname "$ACCESS_HOST" --url "127.0.0.1:$LOCAL_PORT" \
    --loglevel error >> "$LOG" 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    if tunnel_alive; then log "隧道已恢复（第 $i 次探测）"; break; fi
    [ "$i" = "10" ] && log "隧道重启后仍不可用——多半是域名变了，见本文件顶部说明"
  done
fi

if ! tunnel_alive; then
  log "跳过备份：没有可用通道"
  exit 1
fi

log "=== 开始每日备份 ==="
if CLOUD_SSH_HOST=127.0.0.1 CLOUD_SSH_PORT=$LOCAL_PORT \
   bash "$REPO_DIR/scripts/cloud/deploy.sh" --pull-backup >> "$LOG" 2>&1; then
  log "备份成功"
  # 顺带汇报每日巡检健康度（最近一次巡检记录距今多久）
  DEPLOY_DIR="${CLOUD_DEPLOY_DIR:-/workspace/cluss-cloud}"
  SSH="ssh -i $KEY -p $LOCAL_PORT -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
  CHECK_INFO=$($SSH root@127.0.0.1 "ls -1t $DEPLOY_DIR/checks/*.log 2>/dev/null | head -1 | xargs -r basename" 2>/dev/null || true)
  log "最近巡检记录: ${CHECK_INFO:-无（巡检未运行或失败，需检查 clusscloud-check）}"
else
  log "备份失败（云机可能已重置或隧道失效，需按文件顶部说明重建隧道）"
  exit 1
fi