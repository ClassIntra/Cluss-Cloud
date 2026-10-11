#!/usr/bin/env bash
# Cluss-Cloud 账本在线备份（部署机上跑；容器随时可能整盘回滚，必须外备）
# 产物：clusscloud-<时间戳>.tar.gz（= clusscloud.db + .env）
#   ⚠️ .env 必须一起备份：JWT_SECRET / 运营者密码 / PUBLIC_BASE_URL 只存在这里，
#      容器回收是全盘清空，丢了这个恢复出来的库接不回原样。
# 用法：CLUSS_DEPLOY_DIR=/workspace/cluss-cloud bash scripts/cloud/backup-data.sh
# 环境变量：CLUSS_BACKUP_DIR（默认 $DEPLOY_DIR-backups）、CLUSS_BACKUP_KEEP（默认 48）
set -euo pipefail
DEPLOY_DIR="${CLUSS_DEPLOY_DIR:-/workspace/cluss-cloud}"
BACKUP_DIR="${CLUSS_BACKUP_DIR:-$DEPLOY_DIR-backups}"
KEEP="${CLUSS_BACKUP_KEEP:-48}"
DB_PATH="$DEPLOY_DIR/database/clusscloud.db"
[ -f "$DB_PATH" ] || { echo "[backup] 数据库不存在（首次启动前无需备份）"; exit 0; }
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/clusscloud-$STAMP.tar.gz"
STAGE="$(mktemp -d)"

# 在线备份：better-sqlite3 的 backup API（锁页复制，不阻塞业务）
node -e '
  var dbPath = process.argv[1], target = process.argv[2];
  var Database = require(dbPath.replace(/database\/[^/]+$/, "node_modules/better-sqlite3"));
  var db = new Database(dbPath, { readonly: true });
  db.backup(target).then(function () { db.close(); console.log("[backup] 完成: " + target); })
    .catch(function (e) { console.error(e.message); process.exit(1); });
' "$DB_PATH" "$STAGE/clusscloud.db"

[ -f "$DEPLOY_DIR/.env" ] && cp "$DEPLOY_DIR/.env" "$STAGE/.env"
tar -czf "$TARGET" -C "$STAGE" clusscloud.db $( [ -f "$STAGE/.env" ] && echo .env )
rm -rf "$STAGE"

ls -1t "$BACKUP_DIR"/clusscloud-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "[backup] 现有 $(ls -1 "$BACKUP_DIR"/clusscloud-*.tar.gz | wc -l) 份，最新 $(ls -1t "$BACKUP_DIR"/clusscloud-*.tar.gz | head -1)"
