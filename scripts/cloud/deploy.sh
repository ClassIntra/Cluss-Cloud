#!/usr/bin/env bash
# ============================================================
# Cluss-Cloud 部署/运维（本地 Git Bash 跑，经 SSH 隧道操作云机）
# 用法：
#   CLOUD_SSH_HOST=127.0.0.1 CLOUD_SSH_PORT=2222 bash scripts/cloud/deploy.sh deploy
#   … deploy.sh --restore-latest deploy   # 重置后带数据复活
#   … deploy.sh --pull-backup             # 触发云端备份并拉回本地
#   … deploy.sh --status
# ============================================================
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST="${CLOUD_SSH_HOST:-127.0.0.1}"
PORT="${CLOUD_SSH_PORT:-2222}"
USER="${CLOUD_SSH_USER:-root}"
KEY="${CLOUD_SSH_KEY:-$HOME/.ssh/cluss_cloud}"
DEPLOY_DIR="${CLOUD_DEPLOY_DIR:-/workspace/cluss-cloud}"
LOCAL_BACKUP_DIR="${CLOUD_BACKUP_LOCAL:-$REPO_DIR/backups/cloud}"

SSH_OPTS=(-i "$KEY" -p "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20)
SCP_OPTS=(-i "$KEY" -P "$PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20)
SSH="ssh ${SSH_OPTS[*]} $USER@$HOST"
SCP="scp ${SCP_OPTS[*]}"
log() { echo "[deploy] $*"; }

do_deploy() {
  local restore_flag="$1"
  log "打包（server.js + web + NOTICE + 云脚本）…"
  local tgz="/tmp/clusscloud-deploy.tar.gz"
  tar czf "$tgz" -C "$REPO_DIR" server.js web package.json package-lock.json NOTICE.md scripts/cloud
  log "上传…"
  $SSH "mkdir -p /tmp/clusscloud-deploy"
  $SCP "$tgz" "$USER@$HOST:/tmp/clusscloud-deploy.tar.gz" >/dev/null
  $SSH "tar xzf /tmp/clusscloud-deploy.tar.gz -C /tmp/clusscloud-deploy"
  local restore_env=""
  if [ "$restore_flag" = "restore" ]; then
    local latest
    latest=$(ls -1t "$LOCAL_BACKUP_DIR"/clusscloud-*.tar.gz 2>/dev/null | head -1 || true)
    if [ -n "$latest" ]; then
      log "上传本地最新备份用于恢复: $latest"
      $SCP "$latest" "$USER@$HOST:/tmp/clusscloud-restore.tar.gz" >/dev/null
      restore_env="CLUSS_RESTORE_DB=/tmp/clusscloud-restore.tar.gz"
    else
      log "（本地没有可用备份，跳过恢复）"
    fi
  fi
  log "引导…"
  $SSH "$restore_env CLUSS_DEPLOY_DIR=$DEPLOY_DIR bash /tmp/clusscloud-deploy/scripts/cloud/bootstrap.sh"
  log "部署完成。"
}
do_pull_backup() {
  log "触发远程备份…"
  $SSH "CLUSS_DEPLOY_DIR=$DEPLOY_DIR bash $DEPLOY_DIR/scripts/cloud/backup-data.sh"
  mkdir -p "$LOCAL_BACKUP_DIR"
  local remote_latest
  remote_latest=$($SSH "ls -1t $DEPLOY_DIR-backups/clusscloud-*.tar.gz 2>/dev/null | head -1")
  [ -n "$remote_latest" ] || { log "远程没有备份文件"; exit 1; }
  log "拉回: $remote_latest"
  $SCP "$USER@$HOST:$remote_latest" "$LOCAL_BACKUP_DIR/" >/dev/null
  log "本地备份目录：$LOCAL_BACKUP_DIR（$(ls -1 "$LOCAL_BACKUP_DIR" | wc -l) 份）"
}
do_status() {
  $SSH "pm2 ls; echo ---; CPORT=\$(grep '^PORT=' $DEPLOY_DIR/.env 2>/dev/null | cut -d= -f2); curl -s http://127.0.0.1:\${CPORT:-10003}/api/health; echo; echo ---; ls -1t $DEPLOY_DIR-backups/ 2>/dev/null | head -3"
}
ACTION="deploy"; RESTORE="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --restore-latest) RESTORE="restore" ;;
    --pull-backup) ACTION="pull-backup" ;;
    --status) ACTION="status" ;;
    deploy|pull-backup|status) ACTION="$1" ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
  shift
done
case "$ACTION" in
  deploy) do_deploy "$RESTORE" ;;
  pull-backup) do_pull_backup ;;
  status) do_status ;;
esac
