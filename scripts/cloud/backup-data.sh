#!/usr/bin/env bash
# Cluss-Cloud 账本在线备份（部署机上跑；容器随时可能整盘回滚，必须外备）
# 用法：CLUSS_DEPLOY_DIR=/workspace/cluss-cloud bash scripts/cloud/backup-data.sh
set -euo pipefail
DEPLOY_DIR="${CLUSS_DEPLOY_DIR:-/workspace/cluss-cloud}"
BACKUP_DIR="${CLUSS_BACKUP_DIR:-$DEPLOY_DIR-backups}"
KEEP="${CLUSS_BACKUP_KEEP:-48}"
DB_PATH="$DEPLOY_DIR/database/clusscloud.db"
[ -f "$DB_PATH" ] || { echo "[backup] 数据库不存在（首次启动前无需备份）"; exit 0; }
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/clusscloud-$STAMP.db"
node -e '
  var dbPath = process.argv[1], target = process.argv[2];
  var Database = require(dbPath.replace(/database\/[^/]+$/, "node_modules/better-sqlite3"));
  var db = new Database(dbPath, { readonly: true });
  db.backup(target).then(function () { db.close(); console.log("[backup] 完成: " + target); })
    .catch(function (e) { console.error(e.message); process.exit(1); });
' "$DB_PATH" "$TARGET"
gzip -f "$TARGET"
ls -1t "$BACKUP_DIR"/clusscloud-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "[backup] 现有 $(ls -1 "$BACKUP_DIR"/clusscloud-*.db.gz | wc -l) 份，最新 $(ls -1t "$BACKUP_DIR"/clusscloud-*.db.gz | head -1)"
