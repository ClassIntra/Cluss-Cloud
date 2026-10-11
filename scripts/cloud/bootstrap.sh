#!/usr/bin/env bash
# ============================================================
# Cluss-Cloud 引导脚本（全新 Linux 机器/容器上执行，幂等可反复跑）
# 前提：代码已推送到机器（deploy.sh 会打 tar 推过去）
# 用法：CLUSS_DEPLOY_DIR=/workspace/cluss-cloud bash scripts/cloud/bootstrap.sh
# ============================================================
set -euo pipefail

DEPLOY_DIR="${CLUSS_DEPLOY_DIR:-/workspace/cluss-cloud}"
CLOUD_PORT="${CLUSS_CLOUD_PORT:-10003}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "[bootstrap] 部署目录: $DEPLOY_DIR（Cluss-Cloud 只含 server.js + web + 脚本）"

mkdir -p "$DEPLOY_DIR"
cp -r "$REPO_DIR/web" "$DEPLOY_DIR/web"
cp "$REPO_DIR/server.js" "$REPO_DIR/package.json" "$DEPLOY_DIR/"
[ -f "$REPO_DIR/package-lock.json" ] && cp "$REPO_DIR/package-lock.json" "$DEPLOY_DIR/"
mkdir -p "$DEPLOY_DIR/scripts/cloud"
cp "$REPO_DIR"/scripts/cloud/*.sh "$REPO_DIR"/scripts/cloud/*.js "$DEPLOY_DIR/scripts/cloud/" 2>/dev/null || cp "$REPO_DIR"/scripts/cloud/*.sh "$DEPLOY_DIR/scripts/cloud/"

cd "$DEPLOY_DIR"
if [ ! -d node_modules ]; then
  echo "[bootstrap] 安装依赖…"
  npm install --omit=dev --no-audit --no-fund 2>&1 | tail -1
fi

if [ ! -f .env ]; then
  ADMIN_PW="${CLUSS_ADMIN_PW:-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)}"
  JWT="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48)"
  cat > .env <<ENVEOF
PORT=$CLOUD_PORT
JWT_SECRET=$JWT
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$ADMIN_PW
PUBLIC_BASE_URL=
ENVEOF
  echo "[bootstrap] 已生成 .env —— 平台运营者: admin / $ADMIN_PW（请立即保存）"
else
  echo "[bootstrap] .env 已存在，保持不变"
fi

# 重置后的恢复：最近一份备份放回去
if [ -n "${CLUSS_RESTORE_DB:-}" ] && [ ! -f database/clusscloud.db ]; then
  mkdir -p database
  case "$CLUSS_RESTORE_DB" in
    # 新格式：tar.gz（clusscloud.db + .env）
    *.tar.gz)
      RST=/tmp/cc-restore; mkdir -p "$RST"
      tar -xzf "$CLUSS_RESTORE_DB" -C "$RST"
      cp "$RST/clusscloud.db" database/clusscloud.db
      # .env 只在机器上没有时才恢复（不覆盖本次生成的新配置）
      if [ -f "$RST/.env" ] && [ ! -f .env ]; then
        cp "$RST/.env" .env
        echo "[bootstrap] 已一并恢复 .env（JWT_SECRET 与运营者密码保持原样）"
      fi
      rm -rf "$RST"
      ;;
    *.db.gz) gunzip -c "$CLUSS_RESTORE_DB" > database/clusscloud.db ;;
    *)       cp "$CLUSS_RESTORE_DB" database/clusscloud.db ;;
  esac
  echo "[bootstrap] 已从备份恢复数据库: $CLUSS_RESTORE_DB"
fi

if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2 --no-audit --no-fund 2>&1 | tail -1
fi
pm2 delete clusscloud >/dev/null 2>&1 || true
pm2 start server.js --name clusscloud --time --max-memory-restart 400M >/dev/null

# 每小时本地数据快照（防库损坏；外备由 deploy.sh --pull-backup 承担）
pm2 delete clusscloud-snap >/dev/null 2>&1 || true
pm2 start "$DEPLOY_DIR/scripts/cloud/backup-data.sh" --name clusscloud-snap --cron "0 * * * *" --no-autorestart >/dev/null 2>&1 || true

# 每日巡检（凭据就位才注册；见 scripts/cloud/daily-check.js 头注释）
pm2 delete clusscloud-check >/dev/null 2>&1 || true
if [ -f /root/.clusscloud-check.json ] && [ -x "$(command -v node)" ]; then
  pm2 start "$DEPLOY_DIR/scripts/cloud/daily-check.js" --name clusscloud-check --cron "30 9 * * *" --no-autorestart >/dev/null 2>&1 || true
fi
pm2 save >/dev/null
pm2 logs clusscloud --lines 5 --nostream || true
echo "[bootstrap] 完成。健康检查：curl -s http://127.0.0.1:$CLOUD_PORT/api/health"
