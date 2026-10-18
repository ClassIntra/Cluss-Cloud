#!/usr/bin/env bash
# ============================================================
# Cluss-Cloud 每日巡检 + 数据外备（本地 Windows / Git Bash）
#
# 两件事，各自独立判定，互不牵连：
#
#   A. 云端是否在线 —— 「确保云端服务一直在线」的自动检查
#      1) 公开 GET /api/health（只读、不改任何状态、不需要密钥）
#      2) 本机 GET 127.0.0.1:9003/api/health —— 确认本校节点真能打通云端
#         （看 last_ok_at 有多新、待推队列清没清）
#      3) 可选：平台管理员登录后读 /api/platform/overview，断言本节点 online:true
#         仅当配了凭据才跑。凭据取自环境变量 CLOUD_PLATFORM_USER / _PASS，
#         或 backups/cloud/.platform-creds（前两行：用户名、密码；该目录已 gitignore）。
#         未配则明确记 skipped，不当成失败。
#
#   B. 拉回云端数据库备份（走 SSH，而 SSH 走 cloudflared 隧道）
#
# ⚠️ 隧道已彻底失效：quick tunnel 域名在 1.1.1.1 / 8.8.8.8 上全 NXDOMAIN，
#    pm2 restart cf-ssh 报 "Unauthorized: Tunnel not found"，且平台已把自建隧道
#    判为违规并上报过风控。**所以本脚本不再尝试重启 cloudflared**（重建既无用又有风险）。
#
# ⚠️ 已知缺口：B 在无隧道时必然跳过，这不是脚本坏了。
#    且 Cluss-Cloud/server.js 没有暴露任何 HTTP 备份/导出/下载接口
#    （全部路由只有 /api/org、/api/auth、/api/my、/api/platform、/api/sync），
#    所以 B 也无法改写成公网 HTTPS 版本，只能等隧道恢复或用平台终端手动取库。
#
# 退出码：0 = 云端在线（B 跳过也算 0，避免每天一次无解告警）
#         1 = 云端不可达（这个才需要人介入）
# ============================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG="$REPO_DIR/backups/cloud/keepalive.log"
BASE="${CLOUD_BASE:-https://10003-04d07473060e5736.monkeycode-ai.online}"
LOCAL_NODE="${CLOUD_LOCAL_NODE:-http://127.0.0.1:9003}"
NODE_ID="${CLOUD_NODE_ID:-class-18}"
CREDS_FILE="${CLOUD_PLATFORM_CREDS:-$REPO_DIR/backups/cloud/.platform-creds}"
SSH_KEY="${CLOUD_SSH_KEY:-$HOME/.ssh/cluss_cloud}"
SSH_PORT="${CLOUD_SSH_PORT:-2299}"

mkdir -p "$REPO_DIR/backups/cloud"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# 日志别无限长：超过 512 KB 只留最后 1500 行
if [ -f "$LOG" ]; then
  SIZE=$(wc -c < "$LOG" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt 524288 ]; then
    tail -1500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  fi
fi

# 从 stdin 读 JSON，按点号路径取值；取不到就打印空串（不报错）
jget() {
  node -e '
    let s="";
    process.stdin.on("data", d => s += d).on("end", () => {
      let v;
      try { v = JSON.parse(s); } catch (e) { process.stdout.write(""); return; }
      for (const k of String(process.argv[1] || "").split(".")) {
        if (v === null || v === undefined) { v = undefined; break; }
        v = v[k];
      }
      process.stdout.write(v === null || v === undefined ? "" : String(v));
    });
  ' "$1"
}

PROBE="$REPO_DIR/backups/cloud/.probe.$$"
trap 'rm -f "$PROBE"' EXIT

# ---------- A1：公开健康检查（只读，不改状态） ----------
CLOUD_CODE=$(curl -s --max-time 20 -o "$PROBE" -w '%{http_code}' "$BASE/api/health" 2>/dev/null || echo 000)
CLOUD_MODE=$(jget data.mode < "$PROBE" 2>/dev/null || true)
CLOUD_UP=$(jget data.uptime_sec < "$PROBE" 2>/dev/null || true)

CLOUD_OK=0
if [ "$CLOUD_CODE" = "200" ] && [ "$CLOUD_MODE" = "hub" ]; then
  CLOUD_OK=1
  CLOUD_DESC="health 200 mode=hub uptime=${CLOUD_UP:-?}s"
else
  CLOUD_DESC="health ${CLOUD_CODE:-000} mode=${CLOUD_MODE:-?}"
fi

# ---------- A2：本机节点 ↔ 云端 的同步信号 ----------
LOCAL_CODE=$(curl -s --max-time 15 -o "$PROBE" -w '%{http_code}' "$LOCAL_NODE/api/health" 2>/dev/null || echo 000)
if [ "$LOCAL_CODE" = "200" ]; then
  LOCAL_DESC=$(node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      let d = {};
      try { d = (JSON.parse(s).data) || {}; } catch (e) {}
      const y = d.sync || {};                       // 同步字段都在 data.sync 下，不在 data
      // last_ok_at 是 UTC 的 YYYY-MM-DD HH:MM:SS（本机 utils/time.js 的 nowUtc），
      // 不带时区标记；不补 Z 会被当本地时间解析，整整差一个时区（本地是 GMT+8）。
      const t = y.last_ok_at ? Date.parse(String(y.last_ok_at).trim().replace(" ", "T") + "Z") : 0;
      const age = t ? Math.round((Date.now() - t) / 1000) : -1;
      const pend = (y.pending_policy ? 1 : 0) + (Number(y.pending_allocations) || 0);
      process.stdout.write("id=" + (y.instance_id || "?") + " mode=" + (y.mode || "?") +
        " last_ok=" + (age < 0 ? "从未" : age + "s前") + " pending=" + pend);
    });
  ' < "$PROBE" 2>/dev/null || echo "解析失败")
else
  LOCAL_DESC="本机 ${LOCAL_NODE} 无响应（code=${LOCAL_CODE:-000}，本机服务或未开机）"
fi

# ---------- A3：可选，平台侧确认本节点在线 ----------
OVERVIEW_DESC="skipped(未配平台凭据)"
PU="${CLOUD_PLATFORM_USER:-}"
PP="${CLOUD_PLATFORM_PASS:-}"
if [ -z "$PU" ] && [ -f "$CREDS_FILE" ]; then
  PU=$(sed -n '1p' "$CREDS_FILE" 2>/dev/null | tr -d '\r')
  PP=$(sed -n '2p' "$CREDS_FILE" 2>/dev/null | tr -d '\r')
fi
if [ -n "$PU" ] && [ -n "$PP" ]; then
  OVERVIEW_DESC="登录失败或不可达"
  TMPTOK="$REPO_DIR/backups/cloud/.tok.$$"
  curl -s --max-time 20 -o "$TMPTOK" -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$PU\",\"password\":\"$PP\"}" 2>/dev/null || true
  TOK=$(jget data.token < "$TMPTOK" 2>/dev/null || true)
  rm -f "$TMPTOK"
  if [ -n "$TOK" ]; then
    curl -s --max-time 20 -o "$PROBE" "$BASE/api/platform/overview" \
      -H "Authorization: Bearer $TOK" 2>/dev/null || true
    OVERVIEW_DESC=$(node -e '
      let s = "";
      process.stdin.on("data", d => s += d).on("end", () => {
        let j = {};
        try { j = JSON.parse(s); } catch (e) {}
        const list = (j.data && j.data.nodes) || j.nodes || [];
        const me = list.find(n => n && n.instance_id === process.argv[1]);
        if (!me) { process.stdout.write("未见节点 " + process.argv[1]); return; }
        process.stdout.write("节点 " + me.instance_id + " online=" + me.online +
          " status=" + me.status + " last_seen=" + (me.last_seen_at || "?"));
      });
    ' "$NODE_ID" < "$PROBE" 2>/dev/null || echo "解析失败")
  else
    OVERVIEW_DESC="登录未返回 token（用户名/密码不对？）"
  fi
fi

# ---------- B：数据外备（需要 SSH 隧道，通常不可用） ----------
ssh_alive() {
  [ -f "$SSH_KEY" ] || return 1
  ssh -i "$SSH_KEY" -p "$SSH_PORT" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=8 -o BatchMode=yes -o LogLevel=ERROR \
    root@127.0.0.1 'echo ok' 2>/dev/null | grep -q ok
}

BACKUP_DESC="skipped(无 SSH 通道，隧道已失效——已知缺口)"
BACKUP_RC=0
if ssh_alive; then
  log "=== 开始每日备份 ==="
  if CLOUD_SSH_HOST=127.0.0.1 CLOUD_SSH_PORT="$SSH_PORT" \
     bash "$REPO_DIR/scripts/cloud/deploy.sh" --pull-backup >> "$LOG" 2>&1; then
    NEWEST=$(ls -1t "$REPO_DIR/backups/cloud"/clusscloud-* 2>/dev/null | head -1 || true)
    BACKUP_DESC="成功，最新 ${NEWEST:+$(basename "$NEWEST")}"
    [ -z "${NEWEST:-}" ] && BACKUP_DESC="成功"
    log "备份成功"
  else
    BACKUP_DESC="失败（见上文 deploy 输出）"
    log "备份失败（云机可能已重置，或隧道半死）"
    BACKUP_RC=1
  fi
fi

# ---------- 结论 ----------
log "云端在线=$([ "$CLOUD_OK" = 1 ] && echo yes || echo NO) | $CLOUD_DESC | 本机: $LOCAL_DESC | 平台: $OVERVIEW_DESC | 备份: $BACKUP_DESC"

if [ "$CLOUD_OK" != 1 ]; then
  log "结论：云端不可达，需要人介入（公开 /api/health 都不通）"
  exit 1
fi

log "结论：云端在线"
exit "$BACKUP_RC"
