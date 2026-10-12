// ============================================================
// ClussCloud —— 多班同步管理公共服务（独立轻量服务端）
//
// 职责边界（刻意收窄）：**只做同步管理，不做任何学生功能**。
//   · 注册学校 / 节点登记 / 心跳 / 吊销
//   · 策略下发（模型与计价配置，改一处全网生效）
//   · 积分分配（权威账本）与用量回传对账
//   · 一个极简网页（注册 / 登录 / 学校看板 / 平台运营者视图）
//
// 不做的事：不代理 AI、不存学生内容、没有学生账号。
// 学生的一切都在班级设备（Cluss node）上；管理员的日常操作也在
// 设备上进行，这里只解决「同时管多个班」的策略同步与积分分配。
//
// 线上协议与 Cluss node 模式完全兼容（班级电脑的 .env 一个字不用改）：
//   GET  /api/sync/version       轮询 分配版本号 + 模型配置版本号
//   GET  /api/sync/assignments   按校拉额度分配快照
//   GET  /api/sync/model-config  拉模型配置快照（整表替换语义）
//   POST /api/sync/usage         上报用量明细
//   认证：X-Cluss-Org（学校编号）+ X-Cluss-Secret（校级接入密钥）
//
// 本仓库与 Cluss 是**两个独立实现**：协议两处各一份，改动时必须
// 对照 Cluss/services/sync.js 的消费端逐字段核对。
// ============================================================
'use strict';

var crypto = require('crypto');
var path = require('path');
var fs = require('fs');
var express = require('express');
var Database = require('better-sqlite3');
var jwt = require('jsonwebtoken');

// 极简 .env 加载：不覆盖已存在的环境变量（与 dotenv 同语义），省一个依赖
(function loadEnv() {
  var envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(function(line) {
    line = line.trim();
    if (!line || line.charAt(0) === '#') return;
    var eq = line.indexOf('=');
    if (eq < 1) return;
    var k = line.slice(0, eq).trim();
    var v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  });
})();

// ------------------------------------------------------------
// 配置
// ------------------------------------------------------------
var PORT = parseInt(process.env.PORT, 10) || 10003;
var JWT_SECRET = String(process.env.JWT_SECRET || '').trim();
var PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
var DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, 'database', 'clusscloud.db'));

// 平台运营者（就是部署这个公共服务的人）：环境变量引导，首启建号
var ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'admin').trim();
var ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();

if (!JWT_SECRET) {
  console.error('FATAL: 环境变量 JWT_SECRET 必须设置（见 .env.example）');
  process.exit(1);
}

var INSTANCE_ID = 'clusscloud';
var B32 = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // 去 0/O/1/I/L
var NODE_ONLINE_WINDOW_SEC = 600;
var MAX_ASSIGN_YUAN = 10000;
var REGISTER_LIMIT_PER_HOUR = 5;
var BIND_CODE_TTL_MS = 15 * 60 * 1000;   // 绑定确认码 15 分钟有效（够从设备走到电脑网页，不够闲晃）

// ------------------------------------------------------------
// 数据库（独立 schema：没有学生表 —— 学生不属于这里）
// ------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
var db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// 建表语句放在数组里交给 SQLite 一次执行；出错时把整段 SQL 落到 stderr，
// 否则 better-sqlite3 只报 "near X: syntax error" 而不给上下文，排查要靠猜。
function execSchema(sql) {
  try {
    db.exec(sql.join('\n'));
  } catch (err) {
    console.error('[Schema] 建表失败: ' + err.message);
    console.error('[Schema] SQL:\n' + sql.join('\n'));
    throw err;
  }
}

execSchema([
  'CREATE TABLE IF NOT EXISTS orgs (',
  '  id TEXT PRIMARY KEY,',                 // 6 位去混淆字符，本身不是凭证
  '  name TEXT NOT NULL,',
  "  region TEXT NOT NULL DEFAULT '',",
  "  status TEXT NOT NULL DEFAULT 'active',", // active | disabled
  "  secret_hash TEXT NOT NULL DEFAULT '',",  // sha256(接入密钥)，密钥只在注册响应明文出现一次
  '  created_at TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS org_admins (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  org_id TEXT NOT NULL REFERENCES orgs(id),',
  '  username TEXT NOT NULL UNIQUE,',
  '  pass_hash TEXT NOT NULL,',              // scrypt: salt:hex
  '  created_at TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS nodes (',
  '  instance_id TEXT NOT NULL,',
  '  org_id TEXT NOT NULL REFERENCES orgs(id),',
  "  label TEXT NOT NULL DEFAULT '',",
  "  status TEXT NOT NULL DEFAULT 'active',", // active | revoked
  "  first_seen_at TEXT NOT NULL DEFAULT '',",
  "  last_seen_at TEXT NOT NULL DEFAULT '',",
  "  last_report_at TEXT NOT NULL DEFAULT '',",
  '  last_assign_version INTEGER NOT NULL DEFAULT 0,',
  '  last_model_version INTEGER NOT NULL DEFAULT 0,',
  "  node_version TEXT NOT NULL DEFAULT '',",
  "  revoked_at TEXT NOT NULL DEFAULT '',",
  '  PRIMARY KEY (instance_id, org_id)',
  ');',
  'CREATE TABLE IF NOT EXISTS allocations (',
  '  user_id TEXT NOT NULL,',                // 学号（学生在班级设备上，这里只见学号）
  '  org_id TEXT NOT NULL REFERENCES orgs(id),',
  '  allocated_micro INTEGER NOT NULL DEFAULT 0,', // 微元，1 元 = 1e6
  '  weekly_quota_micro INTEGER NOT NULL DEFAULT 0,',
  "  assigned_by TEXT NOT NULL DEFAULT '',",
  '  updated_at TEXT NOT NULL,',
  '  PRIMARY KEY (user_id, org_id)',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_alloc_org ON allocations(org_id);',
  'CREATE TABLE IF NOT EXISTS credit_log (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  org_id TEXT NOT NULL,',
  '  user_id TEXT NOT NULL,',
  '  amount_micro INTEGER NOT NULL,',        // 正充负扣（快照差额）
  '  kind TEXT NOT NULL,',                   // topup | adjust | revoke
  "  reason TEXT NOT NULL DEFAULT '',",
  "  operator TEXT NOT NULL DEFAULT '',",
  "  idem_key TEXT UNIQUE,",                 // 幂等键：同一笔重复提交只入账一次
  '  created_at TEXT NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_clog_org ON credit_log(org_id, id DESC);',
  'CREATE TABLE IF NOT EXISTS usage_log (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  org_id TEXT NOT NULL,',
  "  origin_instance TEXT NOT NULL DEFAULT '',",
  "  user_id TEXT NOT NULL DEFAULT '',",
  "  conversation_id TEXT NOT NULL DEFAULT '',",
  "  model_id TEXT NOT NULL DEFAULT '',",
  '  prompt_tokens INTEGER NOT NULL DEFAULT 0,',
  '  completion_tokens INTEGER NOT NULL DEFAULT 0,',
  '  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,',
  '  cache_miss_tokens INTEGER NOT NULL DEFAULT 0,',
  '  total_tokens INTEGER NOT NULL DEFAULT 0,',
  '  cost_micro INTEGER NOT NULL DEFAULT 0,',
  '  estimated INTEGER NOT NULL DEFAULT 0,',
  "  source TEXT NOT NULL DEFAULT 'chat',",
  "  trace_id TEXT NOT NULL DEFAULT '',",
'  image_count INTEGER NOT NULL DEFAULT 0,',
  '  created_at TEXT NOT NULL,',
  // 节点侧的本机主键（Cluss/services/sync.js 上报时带 local_id）。
  // 幂等靠它：节点只在收到 HTTP 200 时才标记已同步，所以「服务端已提交、
  // 响应在网关丢了」这种最常见的超时场景必然重发，没有唯一约束的话
  // 学校账单直接翻倍，而且节点随后把本地行标记为已发送、永不自愈。
  "  local_id INTEGER NOT NULL DEFAULT 0",   // 末列：后面不能再跟逗号
  ');',
  'CREATE INDEX IF NOT EXISTS idx_usage_org ON usage_log(org_id, created_at DESC);',
  // 同一节点同一 local_id 只能入库一次。org_id 进键，因为不同学校可能
  // 都用 class-01 这样的实例号，而各校 local_id 是各自本机的自增主键。
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_usage_local ON usage_log(org_id, origin_instance, local_id) WHERE local_id > 0;',
  // ---- 账号绑定：把「班级里的班管」和「云端学校管理员」认成同一个人 ----
  // 为什么要这张表：接入 CI 后班管在班级设备上就是管理员，在 Cluss-Cloud 上
  // 又是一个独立的管理员账号，两边两套口令、两个人 —— 换届/交接时最容易出岔。
  // 绑定后管理员的每一次操作都带着「他是哪个班的哪个学号」这一层身份。
  // 学号本身不是凭证：真正的证明是「节点用校级密钥上报 + 管理员用密码确认」。
  'CREATE TABLE IF NOT EXISTS account_bindings (',
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  org_id TEXT NOT NULL REFERENCES orgs(id),',
  '  admin_id INTEGER NOT NULL,',            // org_admins.id，锁定到具体那个管理员账号
  '  admin_username TEXT NOT NULL,',
  '  instance_id TEXT NOT NULL,',            // 班管所在的班级节点
  '  class_user_id TEXT NOT NULL,',          // 该节点上的学号
  "  node_label TEXT NOT NULL DEFAULT '',",
  "  status TEXT NOT NULL DEFAULT 'active',", // active | released
  '  bound_at TEXT NOT NULL,',
  "  released_at TEXT NOT NULL DEFAULT '',",
  "  note TEXT NOT NULL DEFAULT ''",
  ');',
  // 一个学校只有一个「管理员席位」：别的班也有班管，但全校只能有一个班管
  // 占这个位（DB 层硬保证，不靠代码判断，绕不过去）
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_bind_org ON account_bindings(org_id) WHERE status = 'active';",
  // 反过来同一个班级账号也不能同时挂到两个云端账号下。
  // 必须带 org_id：实例号是各校自己编的，两所学校都用 class-01 + 学号 S001
  // 是极常见的组合，全局唯一索引会让后注册的学校绑不上席位，而错误信息
  // 还归因成「本校席位已被占用」——管理员永远查不出原因。
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_bind_seat ON account_bindings(org_id, instance_id, class_user_id) WHERE status = 'active';",
  'CREATE TABLE IF NOT EXISTS bind_requests (',
  '  code TEXT PRIMARY KEY,',                // 一次性确认码（6 位），15 分钟内有效
  '  org_id TEXT NOT NULL REFERENCES orgs(id),',
  '  instance_id TEXT NOT NULL,',
  '  class_user_id TEXT NOT NULL,',
  "  node_label TEXT NOT NULL DEFAULT '',",
  '  admin_username TEXT NOT NULL,',
  '  created_at TEXT NOT NULL,',
  '  expires_at TEXT NOT NULL,',
  "  used_at TEXT NOT NULL DEFAULT ''",
  ');',
  'CREATE INDEX IF NOT EXISTS idx_bindreq_org ON bind_requests(org_id, created_at DESC);',
  // 每所学校自己的模型密钥。不建这张表的话，/api/sync/model-config 会把平台
  // 运营者的 LLM 供应商密钥原样发给任何注册方——而注册接口是公开无审批的，
  // 等于任何人花 10 秒就能拿到平台的钱包。
  'CREATE TABLE IF NOT EXISTS org_model_keys (',
  '  org_id TEXT PRIMARY KEY REFERENCES orgs(id),',
  '  api_key TEXT NOT NULL,',
  '  updated_at TEXT NOT NULL',
  ');',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
'CREATE TABLE IF NOT EXISTS admins (',     // 平台运营者
  '  username TEXT PRIMARY KEY,',
  '  pass_hash TEXT NOT NULL,',
  '  created_at TEXT NOT NULL',
  ');'
]);
// 这里没有 migration 版本表（单文件服务，早期取舍），但仍然要给已存在的库补列：
// CREATE TABLE IF NOT EXISTS 对已建好的表是空操作，新加的列不会自己出现。
// 每一步都先查再改，所以重复启动是安全的。
function ensureColumn(table, column, ddl) {
  var cols = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (cols.some(function(c) { return c.name === column; })) return false;
  db.exec(ddl);
  console.log('[Migrate] 已补列 %s.%s', table, column);
  return true;
}

ensureColumn('usage_log', 'local_id', 'ALTER TABLE usage_log ADD COLUMN local_id INTEGER NOT NULL DEFAULT 0');
db.exec([
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_usage_local',
  'ON usage_log(org_id, origin_instance, local_id) WHERE local_id > 0'
].join('\n'));

// 旧版 ux_bind_seat 不含 org_id，会让两所学校用同样实例号+学号时互相撞车。
// CREATE INDEX IF NOT EXISTS 不会改已存在的索引，所以要显式删掉再按新定义建。
(function migrateBindSeat() {
  var row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_bind_seat'").get();
  if (row && row.sql && row.sql.indexOf('org_id') < 0) {
    db.exec('DROP INDEX ux_bind_seat');
    db.exec([
      'CREATE UNIQUE INDEX ux_bind_seat',
      'ON account_bindings(org_id, instance_id, class_user_id) WHERE status = \'active\''
    ].join('\n'));
    console.log('[Migrate] ux_bind_seat 已重建（补上 org_id，避免跨校撞车）');
  }
})();

function nowIso() { return new Date().toISOString(); }

function getMeta(key, dflt) {
  var row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : dflt;
}
function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function bumpMeta(name) {
  var next = (parseInt(getMeta(name, '0'), 10) || 0) + 1;
  setMeta(name, next);
  return next;
}

// ---- 按校隔离的版本号 ----
// 额度分配和模型配置的上行写都带 base_version 做 CAS，而 CAS 必须按校比：
// 全局单值的话，B 校管理员在网页上充个值，A 校班管本机的改动下一次推送
// 就被 409 掉（而 A 校压根没碰过 B 的数据）。更糟的是重复充值同一个值
// 也会 bump 版本，于是「点错了两次」能让全校所有席位班管的本机改动全部失败。
function orgVersion(orgId, kind) {
  var row = db.prepare('SELECT value FROM meta WHERE key = ?').get('ver:' + kind + ':' + orgId);
  return row ? (parseInt(row.value, 10) || 0) : 0;
}
function bumpOrgVersion(orgId, kind) {
  var next = orgVersion(orgId, kind) + 1;
  setMeta('ver:' + kind + ':' + orgId, next);
  return next;
}

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function randomCode(len) {
  var b = crypto.randomBytes(len), out = '';
  for (var i = 0; i < len; i++) out += B32[b[i] % B32.length];
  return out;
}
// scrypt 口令哈希（不引第三方依赖）
function hashPassword(pw) {
  var salt = crypto.randomBytes(16).toString('hex');
  var hex = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + hex;
}
function verifyPassword(pw, stored) {
  var parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  var hex = crypto.scryptSync(String(pw), parts[0], 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hex), Buffer.from(parts[1]));
}
function safeCompare(a, b) {
  var ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 平台运营者引导：存在则不改密码
(function bootstrapAdmin() {
  if (!ADMIN_PASSWORD) {
    console.warn('[init] 未设置 ADMIN_PASSWORD，平台运营者视图将无法登录');
    return;
  }
  var row = db.prepare('SELECT username FROM admins WHERE username = ?').get(ADMIN_USERNAME);
  if (row) return;
  db.prepare('INSERT INTO admins (username, pass_hash, created_at) VALUES (?, ?, ?)')
    .run(ADMIN_USERNAME, hashPassword(ADMIN_PASSWORD), nowIso());
  console.log('[init] 已创建平台运营者: %s', ADMIN_USERNAME);
})();

// ------------------------------------------------------------
// 应用与静态页
// ------------------------------------------------------------
var app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// 静态页：极简单页，无构建链（web/index.html 直接托管）
var WEB_DIR = path.join(__dirname, 'web');
app.use(express.static(WEB_DIR, { maxAge: '1h' }));

// ------------------------------------------------------------
// 节点认证（每个 /api/sync 请求）：校级密钥 + 顺路心跳
// ------------------------------------------------------------
function touchNode(req, orgId) {
  var instanceId = String(req.headers['x-cluss-instance'] || '').trim();
  if (!instanceId) return null;

  var assignV = parseInt(req.headers['x-cluss-assign-version'], 10) || 0;
  var modelV = parseInt(req.headers['x-cluss-model-version'], 10) || 0;
  var nodeV = String(req.headers['x-cluss-node-version'] || '').trim();
  var now = nowIso();

  var existing = db.prepare(
    'SELECT status FROM nodes WHERE instance_id = ? AND org_id = ?'
  ).get(instanceId, orgId);
  if (existing) {
    if (existing.status === 'revoked') return { revoked: true };
    // 头缺席时保留旧值（显式接入写入的 node_version 不被没带头的请求抹掉）
    db.prepare([
      'UPDATE nodes SET last_seen_at = ?,',
      '  last_assign_version = CASE WHEN ? > 0 THEN ? ELSE last_assign_version END,',
      '  last_model_version = CASE WHEN ? > 0 THEN ? ELSE last_model_version END,',
      "  node_version = CASE WHEN ? != '' THEN ? ELSE node_version END",
      'WHERE instance_id = ? AND org_id = ?'
    ].join('\n')).run(now, assignV, assignV, modelV, modelV, nodeV, nodeV, instanceId, orgId);
    return { revoked: false };
  }

  db.prepare([
    'INSERT INTO nodes (instance_id, org_id, status, first_seen_at, last_seen_at,',
    'last_assign_version, last_model_version, node_version)',
    "VALUES (?, ?, 'active', ?, ?, ?, ?, ?)"
  ].join('\n')).run(instanceId, orgId, now, now, assignV, modelV, nodeV);
  console.log('[Sync] 新节点接入: %s（学校 %s，版本 %s）', instanceId, orgId, nodeV || '未知');
  return { revoked: false };
}

function requireNode(req, res, next) {
  var orgId = String(req.headers['x-cluss-org'] || '').trim();
  var secret = String(req.headers['x-cluss-secret'] || '');
  if (!orgId) return res.status(403).json({ code: 403, message: '缺少 X-Cluss-Org（ClussCloud 只接受按校接入）' });

  var org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
  if (!org) return res.status(403).json({ code: 403, message: '学校编号不存在' });
  if (org.status !== 'active') return res.status(403).json({ code: 403, message: '该学校已被停用' });
  if (!org.secret_hash || !safeCompare(sha256(secret), org.secret_hash)) {
    return res.status(403).json({ code: 403, message: '学校接入密钥校验失败' });
  }
  var touched = touchNode(req, orgId);
  if (touched && touched.revoked) {
    return res.status(403).json({ code: 403, message: '节点已被吊销，同步被拒绝' });
  }
  req.nodeOrg = orgId;
  req.nodeInstance = String(req.headers['x-cluss-instance'] || '').trim();
  next();
}

// ------------------------------------------------------------
// 上行写的授权：只有「管理员席位」所在的那个班能改全校配置
// ------------------------------------------------------------
// 依据是已有的账号绑定：一个学校只有一个 active 席位（ux_bind_org 保证），
// 席位记着是哪个班（instance_id）的哪个学号。把这个既有关系升级成
// 配置写入权的来源——不新建角色表，也不会出现两班互相覆盖。
function seatBinding(orgId) {
  return db.prepare("SELECT * FROM account_bindings WHERE org_id = ? AND status = 'active'").get(orgId) || null;
}

// 校验「本节点持有本校的管理员席位」。返回 {ok:true, binding} 或 {ok:false, reason}
function checkSeat(req) {
  var orgId = req.nodeOrg;
  var instanceId = req.nodeInstance;
  if (!instanceId) return { ok: false, code: 400, reason: '缺少实例标识' };

  var b = req.body || {};
  // 本机登录的确实是班管（与 bind-request 同一套前提）
  if (!b.class_admin) {
    return { ok: false, code: 403, reason: '只有本班班管可以修改全校配置（当前账号不是班管）' };
  }
  var seat = seatBinding(orgId);
  if (!seat) {
    return { ok: false, code: 403, reason: '本校还没有认领管理员席位，无法修改全校配置。请先在云端完成账号绑定。' };
  }
  if (seat.instance_id !== instanceId) {
    return { ok: false, code: 403, reason: '本校管理员席位在另一个班（' + seat.instance_id + '），本班只能查看。' };
  }
  // 学号也要对得上：光有班管身份不够，还得是绑定的那个班管本人
  var classUserId = String(b.class_user_id || '').trim();
  if (!classUserId || seat.class_user_id !== classUserId) {
    return { ok: false, code: 403, reason: '发起操作的学号与管理员席位不一致' };
  }
  return { ok: true, binding: seat };
}

// ------------------------------------------------------------
// 网页端认证（学校管理员 / 平台运营者，JWT）
// ------------------------------------------------------------
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
function requireWeb(req, res, next) {
  var h = String(req.headers.authorization || '');
  var token = h.indexOf('Bearer ') === 0 ? h.slice(7) : '';
  if (!token) return res.status(401).json({ code: 401, message: '未登录' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ code: 401, message: '登录已过期' });
  }
  next();
}
function requireOrgAdmin(req, res, next) {
  if (req.auth.role !== 'org') return res.status(403).json({ code: 403, message: '仅限学校管理员' });
  var org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.auth.org_id);
  if (!org || org.status !== 'active') return res.status(403).json({ code: 403, message: '该学校已被停用' });
  req.org = org;
  next();
}
function requirePlatform(req, res, next) {
  if (req.auth.role !== 'platform') return res.status(403).json({ code: 403, message: '仅限平台运营者' });
  next();
}

function microToYuan(m) { return (Number(m || 0) / 1e6).toFixed(2); }

// ------------------------------------------------------------
// 健康检查
// ------------------------------------------------------------
app.get('/api/health', function(req, res) {
  res.json({
    code: 200, message: 'ok',
    data: {
      service: 'clusscloud',
      mode: 'hub',
      instance_id: INSTANCE_ID,
      assign_version: parseInt(getMeta('assign_version', '0'), 10) || 0,
      model_config_version: parseInt(getMeta('model_config_version', '0'), 10) || 0,
      time: nowIso(),
      uptime_sec: Math.floor(process.uptime())
    }
  });
});

// ------------------------------------------------------------
// 注册学校（公共服务入口，限流防灌水）
// body: { school_name, region?, username, password }
// ------------------------------------------------------------
var registerHits = {};
app.post('/api/org/register', function(req, res) {
  var ip = req.ip || 'unknown';
  var now = Date.now();
  var hits = (registerHits[ip] || []).filter(function(t) { return now - t < 3600e3; });
  if (hits.length >= REGISTER_LIMIT_PER_HOUR) {
    return res.status(429).json({ code: 429, message: '注册太频繁，请一小时后再试' });
  }

  var b = req.body || {};
  var schoolName = String(b.school_name || '').trim().slice(0, 40);
  var region = String(b.region || '').trim().slice(0, 40);
  var username = String(b.username || '').trim().toLowerCase().slice(0, 30);
  var password = String(b.password || '');

  if (schoolName.length < 2) return res.status(400).json({ code: 400, message: '请填写学校名称（至少 2 个字）' });
  if (!/^[a-z0-9_-]{3,30}$/.test(username)) {
    return res.status(400).json({ code: 400, message: '用户名限 3-30 位小写字母/数字/下划线/短横线' });
  }
  if (password.length < 8) return res.status(400).json({ code: 400, message: '密码至少 8 位' });

  var dupOrg = db.prepare('SELECT id FROM orgs WHERE name = ?').get(schoolName);
  if (dupOrg) return res.status(409).json({ code: 409, message: '该学校名称已注册过，请直接登录' });
  var dupUser = db.prepare('SELECT id FROM org_admins WHERE username = ?').get(username);
  if (dupUser) return res.status(409).json({ code: 409, message: '该用户名已被使用，请换一个' });

  var orgId = randomCode(6);
  while (db.prepare('SELECT id FROM orgs WHERE id = ?').get(orgId)) orgId = randomCode(6);
  var orgSecret = randomCode(24);

  var tx = db.transaction(function() {
    db.prepare('INSERT INTO orgs (id, name, region, status, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(orgId, schoolName, region, 'active', sha256(orgSecret), nowIso());
    db.prepare('INSERT INTO org_admins (org_id, username, pass_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(orgId, username, hashPassword(password), nowIso());
  });
  tx();
  hits.push(now);
  registerHits[ip] = hits;
  console.log('[Org] 新学校注册: %s（%s），管理员 %s', orgId, schoolName, username);

  var base = PUBLIC_BASE_URL || (req.protocol + '://' + (req.get('host') || 'cloud.example'));

  // 实例号带学校编号前缀，不写死 class-01。
  //
  // 写死的害处有两层（都实测过）：
  //   · 同校第二个班照抄 → nodes 表主键是 (instance_id, org_id)，两个班挤进
  //     同一行，用量混在一起、吊销时两个班一起被拒，而且 2 班在面板上直接消失；
  //   · 两所学校照抄 → account_bindings 的 ux_bind_seat 是全局唯一索引，
  //     后注册的学校绑不上管理员席位，错误信息还归因成「本校席位已被占用」。
  var instanceId = orgId.toLowerCase() + '-class-01';
  var sameOrg = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE org_id = ?').get(orgId).c;
  if (sameOrg > 0) instanceId = orgId.toLowerCase() + '-class-0' + (sameOrg + 1);

  res.json({
    code: 200, message: '注册成功',
    data: {
      org_id: orgId,
      org_name: schoolName,
      username: username,
      org_secret: orgSecret, // 只显示这一次
      relay_url: base,
      // 每台教室电脑的实例号必须不同。下一台设备接入时把这行改一下
      // （比如 …-class-02），否则两个班会挤进同一条节点记录。
      instance_id: instanceId,
      env_template: [
        'CLUSS_MODE=node',
        'CLUSS_INSTANCE_ID=' + instanceId,
        'CLUSS_RELAY_URL=' + base,
        'CLUSS_ORG_ID=' + orgId,
        'CLUSS_SHARED_SECRET=' + orgSecret
      ].join('\n')
    }
  });
});

// ------------------------------------------------------------
// 节点显式接入（部署时「粘贴后先验证」用；心跳也会自动登记）
// body: { org_id, secret, instance_id, label?, node_version? }
// ------------------------------------------------------------
app.post('/api/org/join', function(req, res) {
  var b = req.body || {};
  var orgId = String(b.org_id || '').trim();
  var secret = String(b.secret || '');
  var instanceId = String(b.instance_id || '').trim().slice(0, 60);
  if (!orgId || !secret || !instanceId) {
    return res.status(400).json({ code: 400, message: '缺少学校编号、接入密钥或实例标识' });
  }

  var org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
  if (!org) return res.status(403).json({ code: 403, message: '学校编号不存在' });
  if (org.status !== 'active') return res.status(403).json({ code: 403, message: '该学校已被停用' });
  if (!org.secret_hash || !safeCompare(sha256(secret), org.secret_hash)) {
    return res.status(403).json({ code: 403, message: '接入密钥校验失败' });
  }

  var now = nowIso();
  var existing = db.prepare('SELECT status FROM nodes WHERE instance_id = ? AND org_id = ?').get(instanceId, orgId);
  if (existing && existing.status === 'revoked') {
    return res.status(403).json({ code: 403, message: '该节点已被吊销，请联系平台运营者恢复' });
  }
  if (existing) {
    db.prepare('UPDATE nodes SET last_seen_at = ?, node_version = ? WHERE instance_id = ? AND org_id = ?')
      .run(now, String(b.node_version || ''), instanceId, orgId);
  } else {
    db.prepare([
      'INSERT INTO nodes (instance_id, org_id, label, status, first_seen_at, last_seen_at, node_version)',
      "VALUES (?, ?, ?, 'active', ?, ?, ?)"
    ].join('\n')).run(instanceId, orgId, String(b.label || '').slice(0, 60), now, now, String(b.node_version || ''));
    console.log('[Org] 节点显式接入: %s（学校 %s）', instanceId, orgId);
  }
  res.json({ code: 200, message: '接入成功', data: { org_id: orgId, org_name: org.name, instance_id: instanceId } });
});

// ------------------------------------------------------------
// 登录（学校管理员 / 平台运营者）
// body: { username, password }
// ------------------------------------------------------------
app.post('/api/auth/login', function(req, res) {
  var username = String((req.body || {}).username || '').trim().toLowerCase();
  var password = String((req.body || {}).password || '');
  if (!username || !password) return res.status(400).json({ code: 400, message: '请输入账号和密码' });

  var admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (admin && verifyPassword(password, admin.pass_hash)) {
    return res.json({
      code: 200, message: '登录成功',
      data: { token: signToken({ role: 'platform', name: username }), role: 'platform', name: username }
    });
  }

  var oa = db.prepare('SELECT * FROM org_admins WHERE username = ?').get(username);
  if (oa && verifyPassword(password, oa.pass_hash)) {
    var org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(oa.org_id);
    if (!org || org.status !== 'active') return res.status(403).json({ code: 403, message: '该学校已被停用' });
    return res.json({
      code: 200, message: '登录成功',
      data: {
        token: signToken({ role: 'org', org_id: org.id, name: username }),
        role: 'org',
        org: { id: org.id, name: org.name, region: org.region }
      }
    });
  }

  res.status(401).json({ code: 401, message: '账号或密码错误' });
});

// ------------------------------------------------------------
// 学校管理员视角（/api/my/*，全部强制本校过滤）
// ------------------------------------------------------------
function relNodes(orgId, rows) {
  var cutoff = new Date(Date.now() - NODE_ONLINE_WINDOW_SEC * 1000).toISOString();
  var usageStmt = db.prepare([
    'SELECT COUNT(*) AS calls, IFNULL(SUM(cost_micro),0) AS cost_micro,',
    '  IFNULL(SUM(CASE WHEN created_at >= ? THEN cost_micro ELSE 0 END),0) AS month_cost_micro,',
    '  MAX(created_at) AS last_at',
    'FROM usage_log WHERE origin_instance = ? AND org_id = ?'
  ].join('\n'));
  var monthStart = new Date();
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  var monthIso = monthStart.toISOString().replace('T', ' ').slice(0, 19);

  return rows.map(function(r) {
    var u = usageStmt.get(monthIso, r.instance_id, orgId);
    return {
      instance_id: r.instance_id,
      label: r.label,
      status: r.status,
      online: !!r.last_seen_at && r.last_seen_at >= cutoff,
      last_seen_at: r.last_seen_at || null,
      last_report_at: r.last_report_at || null,
      node_version: r.node_version,
      last_assign_version: r.last_assign_version,
      last_model_version: r.last_model_version,
      calls: u.calls, cost_micro: u.cost_micro, month_cost_micro: u.month_cost_micro,
      last_usage_at: u.last_at || null
    };
  });
}

app.get('/api/my/overview', requireWeb, requireOrgAdmin, function(req, res) {
  var orgId = req.org.id;
  var nodes = relNodes(orgId, db.prepare('SELECT * FROM nodes WHERE org_id = ? ORDER BY last_seen_at DESC').all(orgId));
  var monthStart = new Date();
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  var monthIso = monthStart.toISOString().replace('T', ' ').slice(0, 19);
  var dayIso = nowIso().slice(0, 10) + ' 00:00:00';

  var totals = db.prepare([
    'SELECT',
    '  (SELECT COUNT(*) FROM allocations WHERE org_id = ? AND allocated_micro > 0) AS students,',
    '  (SELECT IFNULL(SUM(allocated_micro),0) FROM allocations WHERE org_id = ?) AS allocated_micro,',
    '  (SELECT IFNULL(SUM(cost_micro),0) FROM usage_log WHERE org_id = ?) AS used_micro,',
    '  (SELECT COUNT(*) FROM usage_log WHERE org_id = ?) AS calls,',
    '  (SELECT IFNULL(SUM(cost_micro),0) FROM usage_log WHERE org_id = ? AND created_at >= ?) AS month_cost_micro,',
    '  (SELECT IFNULL(SUM(cost_micro),0) FROM usage_log WHERE org_id = ? AND created_at >= ?) AS today_cost_micro'
  ].join('\n')).get(orgId, orgId, orgId, orgId, orgId, monthIso, orgId, dayIso);

  res.json({
    code: 200, message: 'ok',
    data: {
      org: { id: req.org.id, name: req.org.name, region: req.org.region },
      assign_version: orgVersion(req.org.id, 'assign'),
      model_config_version: orgVersion(req.org.id, 'model'),
      online_window_sec: NODE_ONLINE_WINDOW_SEC,
      admin_binding: myBinding(orgId),
      nodes: nodes,
      totals: totals
    }
  });
});

app.get('/api/my/students', requireWeb, requireOrgAdmin, function(req, res) {
  var orgId = req.org.id;
  var keyword = String(req.query.keyword || '').trim();
  var limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);

  var sql = [
    'SELECT a.user_id, a.allocated_micro, a.weekly_quota_micro, a.updated_at, a.assigned_by,',
    '  IFNULL(s.used_micro,0) AS used_micro, IFNULL(s.calls,0) AS calls, s.last_at',
    'FROM allocations a',
    'LEFT JOIN (',
    '  SELECT user_id, SUM(cost_micro) AS used_micro, COUNT(*) AS calls, MAX(created_at) AS last_at',
    '  FROM usage_log WHERE org_id = ? GROUP BY user_id',
    ') s ON s.user_id = a.user_id',
    'WHERE a.org_id = ?'
  ].join('\n');

  // 关键词可选，占位符个数跟着变。显式分两支而不是拼参数数组：
  // 这个路由以前正是因为数组多推了一个值而恒 500，
  // 而验证套件从没调过它，于是没人发现。写成 if/else 让两者对得上。
  var rows;
  if (keyword) {
    sql += ' AND a.user_id LIKE ? ORDER BY a.updated_at DESC LIMIT ?';
    rows = db.prepare(sql).all(orgId, orgId, '%' + keyword + '%', limit);
  } else {
    sql += ' ORDER BY a.updated_at DESC LIMIT ?';
    rows = db.prepare(sql).all(orgId, orgId, limit);
  }

  res.json({
    code: 200, message: 'ok',
    data: {
      students: rows.map(function(r) {
        return {
          user_id: r.user_id,
          allocated_micro: r.allocated_micro,
          weekly_quota_micro: r.weekly_quota_micro,
          used_micro: r.used_micro,
          calls: r.calls,
          balance_micro: r.allocated_micro - r.used_micro,
          last_usage_at: r.last_at || null,
          updated_at: r.updated_at
        };
      })
    }
  });
});

app.post('/api/my/topup', requireWeb, requireOrgAdmin, function(req, res) {
  var b = req.body || {};
  var userId = String(b.user_id || '').trim();
  var amountYuan = Number(b.amount_yuan);
  var weeklyYuan = (b.weekly_quota_yuan === undefined || b.weekly_quota_yuan === '') ? null : Number(b.weekly_quota_yuan);

  if (!userId) return res.status(400).json({ code: 400, message: '请填写学号' });
  if (!isFinite(amountYuan) || amountYuan < 0) return res.status(400).json({ code: 400, message: '金额必须是不小于 0 的数字' });
  if (amountYuan > MAX_ASSIGN_YUAN) return res.status(400).json({ code: 400, message: '单次不能超过 ' + MAX_ASSIGN_YUAN + ' 元' });
  if (weeklyYuan !== null && (!isFinite(weeklyYuan) || weeklyYuan < 0 || weeklyYuan > MAX_ASSIGN_YUAN)) {
    return res.status(400).json({ code: 400, message: '周限额不合法' });
  }

  // 学号归属本校校验：已有分配的学校字段是唯一权威
  var existing = db.prepare('SELECT org_id FROM allocations WHERE user_id = ?').get(userId);
  if (existing && existing.org_id !== req.org.id) {
    return res.status(403).json({ code: 403, message: '该学号属于另一所学校，无权操作' });
  }

  var allocated = Math.round(amountYuan * 1e6);
  var weekly = weeklyYuan === null ? 0 : Math.round(weeklyYuan * 1e6);
  var now = nowIso();
  var idemKey = 'topup:' + req.org.id + ':' + userId + ':' + crypto.randomBytes(8).toString('hex');

  var previousMicro = 0;
  var tx = db.transaction(function() {
    var before = db.prepare('SELECT allocated_micro FROM allocations WHERE user_id = ? AND org_id = ?').get(userId, req.org.id);
    previousMicro = before ? before.allocated_micro : 0;
    db.prepare([
      'INSERT INTO allocations (user_id, org_id, allocated_micro, weekly_quota_micro, assigned_by, updated_at)',
      'VALUES (?, ?, ?, ?, ?, ?)',
      'ON CONFLICT(user_id, org_id) DO UPDATE SET allocated_micro = excluded.allocated_micro,',
      '  weekly_quota_micro = excluded.weekly_quota_micro, assigned_by = excluded.assigned_by,',
      '  updated_at = excluded.updated_at'
    ].join('\n')).run(userId, req.org.id, allocated, weekly, req.auth.name, now);
    var delta = allocated - previousMicro;
    if (delta !== 0) {
      db.prepare([
        'INSERT INTO credit_log (org_id, user_id, amount_micro, kind, reason, operator, idem_key, created_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ].join('\n')).run(req.org.id, userId, delta, 'topup', String(b.reason || '充值'), req.auth.name, idemKey, now);
    }
    bumpOrgVersion(req.org.id, 'assign');
  });
  tx();

  console.log('[Org] 充值: 学校 %s → %s ¥%s by %s', req.org.id, userId, amountYuan, req.auth.name);
  // 把改后的总额回传：语义是「设为 N 元」而不是「加 N 元」，不回传的话
  // 连点两次预设时管理员会以为充了两份，账实对不上还查不出原因。
  res.json({
    code: 200,
    message: '额度已设为 ¥' + amountYuan + '，各班节点将在 1 分钟内同步',
    data: {
      assign_version: orgVersion(req.org.id, 'assign'),
      user_id: userId,
      allocated_micro: allocated,
      previous_micro: previousMicro
    }
  });
});

app.get('/api/my/logs', requireWeb, requireOrgAdmin, function(req, res) {
  var limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  var rows = db.prepare('SELECT * FROM credit_log WHERE org_id = ? ORDER BY id DESC LIMIT ?').all(req.org.id, limit);
  res.json({
    code: 200, message: 'ok',
    data: {
      logs: rows.map(function(r) {
        return {
          id: r.id, user_id: r.user_id,
          amount_yuan: microToYuan(r.amount_micro), amount_micro: r.amount_micro,
          kind: r.kind, reason: r.reason, operator: r.operator, created_at: r.created_at
        };
      })
    }
  });
});

function findMyNode(req, res) {
  var instanceId = String(req.params.instanceId || '').trim();
  var row = instanceId
    ? db.prepare('SELECT * FROM nodes WHERE instance_id = ? AND org_id = ?').get(instanceId, req.org.id)
    : null;
  if (!row) { res.status(404).json({ code: 404, message: '节点不存在或不属于本校' }); return null; }
  return row;
}

app.put('/api/my/nodes/:instanceId', requireWeb, requireOrgAdmin, function(req, res) {
  var row = findMyNode(req, res);
  if (!row) return;
  var label = String((req.body || {}).label || '').trim().slice(0, 60);
  db.prepare('UPDATE nodes SET label = ? WHERE instance_id = ? AND org_id = ?').run(label, row.instance_id, req.org.id);
  res.json({ code: 200, message: '已保存' });
});
app.post('/api/my/nodes/:instanceId/revoke', requireWeb, requireOrgAdmin, function(req, res) {
  var row = findMyNode(req, res);
  if (!row) return;
  db.prepare("UPDATE nodes SET status = 'revoked', revoked_at = ? WHERE instance_id = ? AND org_id = ?")
    .run(nowIso(), row.instance_id, req.org.id);
  console.log('[Org] 节点吊销: %s（学校 %s）', row.instance_id, req.org.id);
  res.json({ code: 200, message: '已吊销，该节点的同步请求将被拒绝' });
});
app.post('/api/my/nodes/:instanceId/restore', requireWeb, requireOrgAdmin, function(req, res) {
  var row = findMyNode(req, res);
  if (!row) return;
  db.prepare("UPDATE nodes SET status = 'active', revoked_at = '' WHERE instance_id = ? AND org_id = ?")
    .run(row.instance_id, req.org.id);
  res.json({ code: 200, message: '已恢复' });
});

// ------------------------------------------------------------
// 账号绑定 · 第二节：管理员在网页上确认（管理员密码认证）
// ------------------------------------------------------------
function myBinding(orgId) {
  var r = db.prepare("SELECT * FROM account_bindings WHERE org_id = ? AND status = 'active'").get(orgId);
  if (!r) return null;
  var node = db.prepare('SELECT label, status, last_seen_at FROM nodes WHERE instance_id = ? AND org_id = ?')
    .get(r.instance_id, orgId);
  return {
    id: r.id,
    admin_username: r.admin_username,
    instance_id: r.instance_id,
    node_label: r.node_label || (node && node.label) || '',
    node_status: node ? node.status : '',
    node_last_seen_at: node ? (node.last_seen_at || null) : null,
    class_user_id: r.class_user_id,
    bound_at: r.bound_at,
    note: r.note
  };
}

app.get('/api/my/bindings', requireWeb, requireOrgAdmin, function(req, res) {
  var orgId = req.org.id;
  // 本校所有未用的确认码（谁在哪个班发起过）：管理员能一眼看到
  // 「2 班班管也想来当管理员」这件事，而不是只在被拒绝时才知道有人来过
  var pending = db.prepare([
    'SELECT code, instance_id, class_user_id, node_label, admin_username, created_at, expires_at',
    'FROM bind_requests WHERE org_id = ? AND used_at = ? ORDER BY created_at DESC LIMIT 20'
  ].join('\n')).all(orgId, '');
  res.json({
    code: 200, message: 'ok',
    data: {
      binding: myBinding(orgId),
      pending: pending.map(function(p) {
        return {
          bind_code: p.code,
          instance_id: p.instance_id,
          node_label: p.node_label,
          class_user_id: p.class_user_id,
          admin_username: p.admin_username,
          created_at: p.created_at,
          expires_at: p.expires_at,
          expired: p.expires_at <= nowIso()
        };
      })
    }
  });
});

app.post('/api/my/bind', requireWeb, requireOrgAdmin, function(req, res) {
  var code = String((req.body || {}).code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ code: 400, message: '请填写确认码' });

  var reqRow = db.prepare('SELECT * FROM bind_requests WHERE code = ?').get(code);
  if (!reqRow) return res.status(404).json({ code: 404, message: '确认码不存在，请检查是否输错' });
  // 跨校确认码一律当无效：不给「拿别校的码来试」留任何回声
  if (reqRow.org_id !== req.org.id) {
    return res.status(403).json({ code: 403, message: '该确认码不属于本校' });
  }
  if (reqRow.used_at) return res.status(409).json({ code: 409, message: '该确认码已使用过了，请重新发起' });
  if (reqRow.expires_at <= nowIso()) {
    return res.status(410).json({ code: 410, message: '确认码已过期，请回到班级设备重新发起' });
  }

  // 全校一个管理员席位：这里再判一次（给人一句能看懂的话），
  // 真正的硬保证在 ux_bind_org 这个部分唯一索引上。
  var held = db.prepare("SELECT * FROM account_bindings WHERE org_id = ? AND status = 'active'").get(req.org.id);
  if (held) {
    return res.status(409).json({
      code: 409,
      message: '本校管理员席位已绑定给「' + (held.node_label || held.instance_id) + ' · 学号 ' + held.class_user_id +
        '」。一个学校只能有一个班管当管理员，要换人请先解绑。'
    });
  }

  var admin = db.prepare('SELECT * FROM org_admins WHERE username = ? AND org_id = ?')
    .get(reqRow.admin_username, req.org.id);
  if (!admin) {
    return res.status(409).json({ code: 409, message: '确认码对应的管理员账号已不存在，请重新发起' });
  }

  var now = nowIso();
  var tx = db.transaction(function() {
    db.prepare([
      'INSERT INTO account_bindings (org_id, admin_id, admin_username, instance_id, class_user_id,',
      "  node_label, status, bound_at, note)",
      "VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)"
    ].join('\n')).run(
      req.org.id, admin.id, admin.username, reqRow.instance_id, reqRow.class_user_id,
      reqRow.node_label, now, '管理员 = 该班班管本人'
    );
    db.prepare('UPDATE bind_requests SET used_at = ? WHERE code = ?').run(now, code);
  });
  try {
    tx();
  } catch (err) {
    // 并发双提交时唯一索引会拦下来，翻译成人话
    if (String(err.message || '').indexOf('UNIQUE') >= 0) {
      return res.status(409).json({ code: 409, message: '本校管理员席位已被占用，一个学校只能有一个班管当管理员' });
    }
    throw err;
  }

  console.log('[Bind] 绑定成立: 学校 %s 管理员 %s ← %s · 学号 %s',
    req.org.id, admin.username, reqRow.node_label || reqRow.instance_id, reqRow.class_user_id);
  res.json({
    code: 200,
    message: '绑定完成：现在这个管理员账号就是你所在班的班管本人',
    data: { binding: myBinding(req.org.id) }
  });
});

app.delete('/api/my/binding', requireWeb, requireOrgAdmin, function(req, res) {
  var row = db.prepare("SELECT * FROM account_bindings WHERE org_id = ? AND status = 'active'").get(req.org.id);
  if (!row) return res.status(404).json({ code: 404, message: '当前没有绑定关系' });
  db.prepare("UPDATE account_bindings SET status = 'released', released_at = ? WHERE id = ?")
    .run(nowIso(), row.id);
  console.log('[Bind] 已解绑: 学校 %s（管理员 %s）', req.org.id, row.admin_username);
  res.json({ code: 200, message: '已解绑。席位空出来后，本校任意班管都可以来认领。', data: { binding: null } });
});

// ------------------------------------------------------------
// 学校管理员的增删改
// ------------------------------------------------------------
// 为什么必须有：账号绑定的卖点是「换届交接只传一个身份」，但原来全校只能建
// 一个管理员、密码无处可改、账号删不掉 —— 交接之后新管理员的密码仍然没地方设，
// 只能改数据库文件。组织内一班一台设备，接入三年总要换人。
var USERNAME_RE = /^[a-z0-9_-]{3,30}$/;

app.get('/api/my/admins', requireWeb, requireOrgAdmin, function(req, res) {
  var rows = db.prepare(
    'SELECT id, username, created_at FROM org_admins WHERE org_id = ? ORDER BY created_at'
  ).all(req.org.id);
  res.json({ code: 200, message: 'ok', data: { admins: rows } });
});

app.post('/api/my/admins', requireWeb, requireOrgAdmin, function(req, res) {
  var b = req.body || {};
  var username = String(b.username || '').trim().toLowerCase();
  var password = String(b.password || '');
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ code: 400, message: '用户名只能用 3-30 位小写字母、数字、下划线、短横线' });
  }
  if (password.length < 8) {
    return res.status(400).json({ code: 400, message: '密码至少 8 位' });
  }
  // 用户名是全局唯一（历史设计），撞了要说清是谁的
  var dup = db.prepare('SELECT org_id FROM org_admins WHERE username = ?').get(username);
  if (dup) {
    return res.status(409).json({ code: 409, message: '该用户名已被占用，换一个' });
  }
  db.prepare('INSERT INTO org_admins (org_id, username, pass_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(req.org.id, username, hashPassword(password), nowIso());
  console.log('[Org] 新增管理员: 学校 %s ← %s（操作人 %s）', req.org.id, username, req.auth.name);
  res.json({ code: 200, message: '已添加 ' + username });
});

app.put('/api/my/admins/:username/password', requireWeb, requireOrgAdmin, function(req, res) {
  var username = String(req.params.username || '').trim().toLowerCase();
  var password = String((req.body || {}).password || '');
  if (password.length < 8) return res.status(400).json({ code: 400, message: '密码至少 8 位' });
  var row = db.prepare('SELECT * FROM org_admins WHERE username = ? AND org_id = ?').get(username, req.org.id);
  if (!row) return res.status(404).json({ code: 404, message: '本校没有这个管理员账号' });
  db.prepare('UPDATE org_admins SET pass_hash = ? WHERE id = ?').run(hashPassword(password), row.id);
  console.log('[Org] 管理员改密: 学校 %s / %s（操作人 %s）', req.org.id, username, req.auth.name);
  res.json({ code: 200, message: '密码已更新' });
});

app.delete('/api/my/admins/:username', requireWeb, requireOrgAdmin, function(req, res) {
  var username = String(req.params.username || '').trim().toLowerCase();
  var row = db.prepare('SELECT * FROM org_admins WHERE username = ? AND org_id = ?').get(username, req.org.id);
  if (!row) return res.status(404).json({ code: 404, message: '本校没有这个管理员账号' });
  var n = db.prepare('SELECT COUNT(*) AS c FROM org_admins WHERE org_id = ?').get(req.org.id).c;
  if (n <= 1) {
    return res.status(400).json({ code: 400, message: '本校至少要留一个管理员，否则没人能登录' });
  }
  // 席位指向被删账号的话一并清掉，否则节点还会按老账号名推配置被拒
  db.prepare("UPDATE account_bindings SET status = 'released', released_at = ? WHERE admin_username = ? AND org_id = ? AND status = 'active'")
    .run(nowIso(), username, req.org.id);
  db.prepare('DELETE FROM org_admins WHERE id = ?').run(row.id);
  console.log('[Org] 删除管理员: 学校 %s / %s（操作人 %s）', req.org.id, username, req.auth.name);
  res.json({ code: 200, message: '已删除 ' + username });
});

// ------------------------------------------------------------
// 平台运营者视角（/api/platform/*）
// ------------------------------------------------------------
app.get('/api/platform/overview', requireWeb, requirePlatform, function(req, res) {
  var orgs = db.prepare('SELECT * FROM orgs ORDER BY created_at DESC').all();
  var nodes = db.prepare('SELECT * FROM nodes ORDER BY last_seen_at DESC').all();
  var cutoff = new Date(Date.now() - NODE_ONLINE_WINDOW_SEC * 1000).toISOString();
  var monthStart = new Date();
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  var monthIso = monthStart.toISOString().replace('T', ' ').slice(0, 19);

  var names = {};
  orgs.forEach(function(o) { names[o.id] = o.name; });
  res.json({
    code: 200, message: 'ok',
    data: {
      orgs: orgs.map(function(o) {
        var t = db.prepare([
          'SELECT IFNULL(SUM(cost_micro),0) AS cost_micro,',
          '  IFNULL(SUM(CASE WHEN created_at >= ? THEN cost_micro ELSE 0 END),0) AS month_cost_micro,',
          '  COUNT(*) AS calls',
          'FROM usage_log WHERE org_id = ?'
        ].join('\n')).get(monthIso, o.id);
        return {
          id: o.id, name: o.name, region: o.region, status: o.status, created_at: o.created_at,
          calls: t.calls, cost_micro: t.cost_micro, month_cost_micro: t.month_cost_micro,
          admin_binding: myBinding(o.id),
          has_model_key: !!db.prepare('SELECT 1 FROM org_model_keys WHERE org_id = ? AND api_key <> \'\'').get(o.id)
        };
      }),
      nodes: nodes.map(function(r) {
        return {
          instance_id: r.instance_id, org_id: r.org_id, org_name: names[r.org_id] || '',
          label: r.label, status: r.status,
          online: !!r.last_seen_at && r.last_seen_at >= cutoff,
          last_seen_at: r.last_seen_at || null, last_report_at: r.last_report_at || null,
          node_version: r.node_version,
          last_assign_version: r.last_assign_version, last_model_version: r.last_model_version
        };
      }),
      totals: {
        orgs: orgs.length,
        nodes: nodes.length,
        usage_cost_micro: db.prepare('SELECT IFNULL(SUM(cost_micro),0) AS m FROM usage_log').get().m
      }
    }
  });
});

// 模型配置：整份 JSON 文档存储 + 版本号（与节点消费端逐字段对应：
// models 行需要 Cluss ai_models 的全部业务列 —— 最省事的来源是
// 从任意一台 Cluss relay 的 /api/sync/model-config 响应整份复制）
app.get('/api/platform/model-config', requireWeb, requirePlatform, function(req, res) {
  var raw = getMeta('model_config', 'null');
  var doc = null;
  try { doc = JSON.parse(raw); } catch (e) { doc = null; }
  res.json({
    code: 200, message: 'ok',
    data: {
      model_config_version: parseInt(getMeta('model_config_version', '0'), 10) || 0,
      config: doc
    }
  });
});

app.put('/api/platform/model-config', requireWeb, requirePlatform, function(req, res) {
  var b = req.body || {};
  var doc = b.config;
  if (!doc || typeof doc !== 'object') return res.status(400).json({ code: 400, message: '配置必须是对象' });
  if (!Array.isArray(doc.models)) return res.status(400).json({ code: 400, message: '缺少 models 数组' });
  for (var i = 0; i < doc.models.length; i++) {
    var m = doc.models[i] || {};
    if (!m.id || !m.label) {
      return res.status(400).json({ code: 400, message: 'models[' + i + '] 缺少 id 或 label' });
    }
  }
  if (!Array.isArray(doc.sources)) doc.sources = [];
  if (!doc.meta || typeof doc.meta !== 'object') doc.meta = {};

  var tx = db.transaction(function() {
    setMeta('model_config', JSON.stringify(doc));
    bumpMeta('model_config_version');
  });
  tx();
  var version = parseInt(getMeta('model_config_version', '0'), 10);
  console.log('[Platform] 模型配置已下发: v%s（%d 个模型）', version, doc.models.length);
  res.json({
    code: 200, message: '已保存，各班节点将在 1 分钟内自动同步',
    data: { model_config_version: version }
  });
});

// 给某校下发它自己的模型密钥（平台运营者）。
// 没有这一步，学校节点拉到的模型 api_key 会是空串，学生点了就报错——
// 所以配置完记得确认该校的节点真的能跑通一次对话。
app.put('/api/platform/orgs/:orgId/model-key', requireWeb, requirePlatform, function(req, res) {
  var org = db.prepare('SELECT id FROM orgs WHERE id = ?').get(req.params.orgId);
  if (!org) return res.status(404).json({ code: 404, message: '学校不存在' });
  var apiKey = String((req.body || {}).api_key || '').trim();
  if (apiKey && apiKey.length < 8) {
    return res.status(400).json({ code: 400, message: 'api_key 太短，请填完整的供应商密钥' });
  }
  db.prepare([
    'INSERT INTO org_model_keys (org_id, api_key, updated_at) VALUES (?, ?, ?)',
    'ON CONFLICT(org_id) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at'
  ].join('\n')).run(req.params.orgId, apiKey, nowIso().replace('T', ' ').slice(0, 19));
  db.prepare("SELECT id FROM orgs WHERE status = 'active'").all().forEach(function(o) {
    bumpOrgVersion(o.id, 'model'); // 让该校的节点尽快拉到
  });
  bumpMeta('model_config_version');
  console.log('[Platform] 学校 %s 的模型密钥已%s', req.params.orgId, apiKey ? '更新' : '清空');
  res.json({ code: 200, message: apiKey ? '已下发，该校节点会在 1 分钟内同步' : '已清空' });
});

// 学校停用/启用（平台运营者的总闸）
app.post('/api/platform/orgs/:orgId/:action(disable|enable)', requireWeb, requirePlatform, function(req, res) {
  var org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.params.orgId);
  if (!org) return res.status(404).json({ code: 404, message: '学校不存在' });
  var status = req.params.action === 'disable' ? 'disabled' : 'active';
  db.prepare('UPDATE orgs SET status = ? WHERE id = ?').run(status, org.id);
  console.log('[Platform] 学校 %s → %s', org.id, status);
  res.json({ code: 200, message: status === 'disabled' ? '已停用，该校节点同步将被拒绝' : '已启用' });
});

// ------------------------------------------------------------
// 配置上行写 · 第一节：席位班管在本地改完，推给全校
//
// 这是「搞 Cloud 的理由」本身：管理员坐在教室电脑前就能改模型配置、
// 调积分，改完同步到同校所有班，而不是登云端网页改。
//
// 落库复用既有的 meta.model_config（{models, sources, meta}），所以下行
// 的 GET /api/sync/model-config 一个字都不用改 —— 上行写进去的，下行原样读出来。
//
// base_version 做 CAS：班管改的是他读到的那一版，若这期间云端被别人改过
// （比如平台运营者推了新配置），返回 409 让本机提示「已被改动，请刷新」。
// 没有这个，两个班同时改会静默覆盖，而覆盖掉的是全校都在用的配置。
//
// body: { base_version, class_user_id, class_admin, config:{models,sources,meta} }
// ------------------------------------------------------------
app.post('/api/sync/policy', requireNode, function(req, res) {
  var seat = checkSeat(req);
  if (!seat.ok) {
    return res.status(seat.code).json({ code: seat.code, message: seat.reason });
  }

  var b = req.body || {};
  var doc = b.config;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.models)) {
    return res.status(400).json({ code: 400, message: 'config 必须是对象且含 models 数组' });
  }
  for (var i = 0; i < doc.models.length; i++) {
    var m = doc.models[i] || {};
    if (!m.id || !m.label) {
      return res.status(400).json({ code: 400, message: 'models[' + i + '] 缺少 id 或 label' });
    }
  }
  if (!Array.isArray(doc.sources)) doc.sources = [];
  if (!doc.meta || typeof doc.meta !== 'object') doc.meta = {};

  var current = orgVersion(req.nodeOrg, 'model');
  var baseVersion = (b.base_version === undefined || b.base_version === null) ? current : (parseInt(b.base_version, 10) || 0);
  if (baseVersion !== current) {
    return res.status(409).json({
      code: 409,
      message: '云端配置已被改动（你基于 v' + baseVersion + ' 编辑，当前已是 v' + current + '），请刷新后重新修改',
      data: { model_config_version: current }
    });
  }

  var version = 0;
  var tx = db.transaction(function() {
    setMeta('model_config', JSON.stringify({
      models: doc.models,
      sources: doc.sources,
      meta: doc.meta
    }));
    version = bumpOrgVersion(req.nodeOrg, 'model');
  });
  tx();

  console.log('[Sync] 席位班 %s 上行模型配置: v%s（%d 个模型）by %s',
    req.nodeInstance, version, doc.models.length, seat.binding.admin_username);
  res.json({
    code: 200,
    message: '已同步到全校，各班会在 1 分钟内自动更新',
    data: { model_config_version: version }
  });
});

// ------------------------------------------------------------
// 配置上行写 · 第二节：积分分配
//
// 语义与云端网页 /api/my/topup 一致：**总额覆盖**，不是追加。本机管理台
// 原本是累加（PUT /admin/users/:userId/quota），两端口径相反会让账对不上，
// 所以这里以本机推上来的 allocated_micro 绝对值为准。
//
// idem_key 去重：本机重试（断网、网关超时）不会重复记账 —— 这是
// credit_log.idem_key UNIQUE 这个索引本来就该有、却一直没被用上的能力。
//
// body: { base_version, class_user_id, class_admin, items:[{user_id, allocated_micro, weekly_quota_micro, reason, idem_key}] }
// ------------------------------------------------------------
app.post('/api/sync/allocations', requireNode, function(req, res) {
  var seat = checkSeat(req);
  if (!seat.ok) {
    return res.status(seat.code).json({ code: seat.code, message: seat.reason });
  }

  var b = req.body || {};
  var items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ code: 400, message: '没有要同步的分配项' });
  if (items.length > 500) return res.status(400).json({ code: 400, message: '单次最多同步 500 条' });

  var current = orgVersion(req.nodeOrg, 'assign');
  var baseVersion = (b.base_version === undefined || b.base_version === null) ? current : (parseInt(b.base_version, 10) || 0);
  if (baseVersion !== current) {
    return res.status(409).json({
      code: 409,
      message: '云端额度已被改动（你基于 v' + baseVersion + ' 编辑，当前已是 v' + current + '），请刷新后重新修改',
      data: { assign_version: current }
    });
  }

  var applied = 0, skipped = 0, touched = false;
  var now = nowIso();
  var operator = seat.binding.admin_username;
  var self = seat.binding.class_user_id;

  var tx = db.transaction(function() {
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var userId = String(it.user_id || '').trim().slice(0, 40);
      if (!userId) { skipped++; continue; }

      // 幂等：同一个 idem_key 已经入过账就跳过（重试不会双记）
      var idemKey = String(it.idem_key || '').trim().slice(0, 64);
      if (idemKey && db.prepare('SELECT id FROM credit_log WHERE idem_key = ?').get(idemKey)) {
        skipped++;
        continue;
      }

      // 别的学校的学号不能通过「本机改过」这条路塞进来
      var owner = db.prepare('SELECT org_id FROM allocations WHERE user_id = ?').get(userId);
      if (owner && owner.org_id !== req.nodeOrg) { skipped++; continue; }

      var allocated = Math.max(0, Math.round(Number(it.allocated_micro) || 0));
      var weekly = Math.max(0, Math.round(Number(it.weekly_quota_micro) || 0));
      var before = db.prepare('SELECT allocated_micro FROM allocations WHERE user_id = ? AND org_id = ?').get(userId, req.nodeOrg);
      var prevMicro = before ? before.allocated_micro : 0;

      db.prepare([
        'INSERT INTO allocations (user_id, org_id, allocated_micro, weekly_quota_micro, assigned_by, updated_at)',
        'VALUES (?, ?, ?, ?, ?, ?)',
        'ON CONFLICT(user_id, org_id) DO UPDATE SET allocated_micro = excluded.allocated_micro,',
        '  weekly_quota_micro = excluded.weekly_quota_micro, assigned_by = excluded.assigned_by,',
        '  updated_at = excluded.updated_at'
      ].join('\n')).run(userId, req.nodeOrg, allocated, weekly, operator, now);

      var delta = allocated - prevMicro;
      if (delta !== 0) {
        db.prepare([
          'INSERT INTO credit_log (org_id, user_id, amount_micro, kind, reason, operator, idem_key, created_at)',
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ].join('\n')).run(
          req.nodeOrg, userId, delta, 'adjust',
          String(it.reason || '班管在本机调整') + '（来自 ' + req.nodeInstance + '，操作人 ' + operator + (self ? ' / ' + self : '') + '）',
          operator, idemKey || null, now
        );
      }
      applied++;
      touched = true;
    }
    if (touched) bumpOrgVersion(req.nodeOrg, 'assign');
  });
  tx();

  console.log('[Sync] 席位班 %s 上行额度: %d 条生效、%d 条跳过 by %s（学校 %s）',
    req.nodeInstance, applied, skipped, operator, req.nodeOrg);
  res.json({
    code: 200,
    message: applied ? ('已同步到全校（' + applied + ' 人）') : '没有需要同步的变更',
    data: {
      assign_version: orgVersion(req.nodeOrg, 'assign'),
      applied: applied,
      skipped: skipped
    }
  });
});

// ------------------------------------------------------------
// 账号绑定 · 第一节：班级节点发起（node 认证，校级密钥）
//
// 为什么由节点发起而不是管理员自己在网页上填学号：云端永远不存班级密码，
// 网页上填学号等于谁都能声称自己是任何人。节点是唯一能作证「当前登录的这个
// 人就是 X 班学号 Y，而且他是班管」的地方 —— 它只在自己这台上这么确信。
// 节点把一份**一次性确认码**递上来，管理员再用自己的密码去网页上确认，
// 两头对上才认定是同一个人。
//
// body: { admin_username, class_user_id, class_admin }
// ------------------------------------------------------------
app.post('/api/sync/bind-request', requireNode, function(req, res) {
  var b = req.body || {};
  var adminUsername = String(b.admin_username || '').trim().toLowerCase().slice(0, 30);
  var classUserId = String(b.class_user_id || '').trim().slice(0, 40);
  var instanceId = String(req.headers['x-cluss-instance'] || '').trim();

  if (!instanceId) return res.status(400).json({ code: 400, message: '缺少实例标识' });
  if (!classUserId) return res.status(400).json({ code: 400, message: '缺少班级学号' });
  // 节点只在「当前登录者确实是班管」时才允许发起：这是绑定关系的另一半前提
  if (!b.class_admin) {
    return res.status(403).json({ code: 403, message: '只有本班班管可以发起账号绑定（当前账号不是班管）' });
  }

  var admin = db.prepare('SELECT * FROM org_admins WHERE username = ?').get(adminUsername);
  if (!admin || admin.org_id !== req.nodeOrg) {
    return res.status(403).json({ code: 403, message: '该用户名不是本学校的管理员账号' });
  }

  // 同一次重发会把这个人此前未用的确认码作废：确认码只保留最新一枚
  db.prepare([
    "UPDATE bind_requests SET used_at = ? WHERE org_id = ? AND instance_id = ? AND class_user_id = ? AND used_at = ''"
  ].join('\n')).run(nowIso(), req.nodeOrg, instanceId, classUserId);

  var node = db.prepare('SELECT label FROM nodes WHERE instance_id = ? AND org_id = ?').get(instanceId, req.nodeOrg);
  var code = randomCode(6);
  var now = nowIso();
  var expires = new Date(Date.now() + BIND_CODE_TTL_MS).toISOString();
  db.prepare([
    'INSERT INTO bind_requests (code, org_id, instance_id, class_user_id, node_label, admin_username, created_at, expires_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ].join('\n')).run(code, req.nodeOrg, instanceId, classUserId,
    String((node && node.label) || ''), adminUsername, now, expires);

  console.log('[Bind] %s（学校 %s，学号 %s）发起绑定管理员 %s', instanceId, req.nodeOrg, classUserId, adminUsername);
  res.json({
    code: 200, message: 'ok',
    data: {
      bind_code: code,
      expires_at: expires,
      admin_username: adminUsername,
      ttl_sec: Math.round(BIND_CODE_TTL_MS / 1000)
    }
  });
});

// ------------------------------------------------------------
// 同步接口（与 Cluss node 模式逐字段兼容）
// ------------------------------------------------------------
app.get('/api/sync/version', requireNode, function(req, res) {
  // 节点要知道「本班是不是管理员席位」才能在本地决定给不给班管开写入权——
  // 这个判断以云端为准，本机无权自己认定。
  var seat = seatBinding(req.nodeOrg);
  res.json({
    code: 200, message: 'ok',
    data: {
      instance_id: INSTANCE_ID,
      assign_version: orgVersion(req.nodeOrg, 'assign'),
      model_config_version: orgVersion(req.nodeOrg, 'model'),
      is_seat_admin: !!(seat && seat.instance_id === req.nodeInstance),
      seat_instance: seat ? seat.instance_id : '',
      server_time: nowIso().replace('T', ' ').slice(0, 19)
    }
  });
});

app.get('/api/sync/assignments', requireNode, function(req, res) {
  // 不要过滤 allocated_micro > 0：管理员把额度调回 0 是必须能生效的操作，
  // 而节点侧 applyAssignments 只处理快照里出现的条目——过滤掉就等于
  // 「云端账清了、版本号也涨了、节点余额纹丝不动」，账实永久不一致。
  var rows = db.prepare([
    'SELECT user_id, allocated_micro, weekly_quota_micro, assigned_by, updated_at',
    'FROM allocations WHERE org_id = ?'
  ].join('\n')).all(req.nodeOrg);
  res.json({
    code: 200, message: 'ok',
    data: {
      assign_version: orgVersion(req.nodeOrg, 'assign'),
      assignments: rows
    }
  });
});

app.get('/api/sync/model-config', requireNode, function(req, res) {
  var raw = getMeta('model_config', 'null');
  var doc = null;
  try { doc = JSON.parse(raw); } catch (e) { doc = null; }
  var models = (doc && doc.models) || [];

  // 逐校换密钥：平台配置的模板里带着运营者的供应商密钥，直接下发等于把钱包
  // 送给任何注册方。本校配了 org_model_keys 就用它替换，没配就把 api_key 抹空
  // ——模型列表照常下发（学生还要用它显示模型名），只是不能拿去调供应商。
  var own = db.prepare('SELECT api_key FROM org_model_keys WHERE org_id = ?').get(req.nodeOrg);
  var key = own && own.api_key ? own.api_key : '';
  models = models.map(function(m) {
    var copy = Object.assign({}, m);
    copy.api_key = key;
    return copy;
  });

  res.json({
    code: 200, message: 'ok',
    data: {
      model_config_version: parseInt(getMeta('model_config_version', '0'), 10) || 0,
      models: models,
      sources: (doc && doc.sources) || [],
      meta: (doc && doc.meta) || {}
    }
  });
});

app.post('/api/sync/usage', requireNode, function(req, res) {
  var instanceId = String(req.headers['x-cluss-instance'] || '').trim() ||
    String((req.body || {}).instance_id || '').trim();
  var records = Array.isArray((req.body || {}).records) ? req.body.records : [];
  if (!instanceId) return res.status(400).json({ code: 400, message: '缺少 instance_id' });
  if (records.length > 500) return res.status(400).json({ code: 400, message: '单次上报最多 500 条' });

  var ALLOWED_SOURCES = ['chat', 'study', 'solve', 'grade', 'vision_relay'];
  // 幂等查询：节点重发同一批时靠它挡掉（键 = org + 实例 + 节点本机主键）。
  // 节点只有收到 200 才会标记本地已同步，所以「已提交但响应丢了」必然重发。
  var existsStmt = db.prepare(
    'SELECT 1 FROM usage_log WHERE org_id = ? AND origin_instance = ? AND local_id = ? AND local_id > 0'
  );
  // 单条落库。INSERT OR IGNORE 兜住并发下的唯一约束冲突（两个请求同时到达）。
  var insertOne = db.prepare([
    'INSERT OR IGNORE INTO usage_log (org_id, origin_instance, user_id, conversation_id, model_id,',
    '  prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens, total_tokens,',
    '  cost_micro, estimated, source, trace_id, image_count, created_at, local_id)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ].join('\n'));

  // 数字字段的兜底：Number('abc') 是 NaN，better-sqlite3 遇到 NaN 会抛，
  // 整个批次的用量全丢 —— 一条脏数据害一整批。负数也直接丢掉。
  function numOf(v) {
    var n = Number(v);
    if (!isFinite(n) || n < 0) return 0;
    return Math.round(n);
  }

  var accepted = 0, duplicated = 0, rejected = 0;
  var tx = db.transaction(function() {
    for (var i = 0; i < records.length; i++) {
      var r = records[i] || {};
      if (!r.user_id) { rejected++; continue; }
      var src = String(r.source || 'chat');
      if (ALLOWED_SOURCES.indexOf(src) < 0) src = 'chat';
      var localId = numOf(r.local_id);

      if (localId > 0 && existsStmt.get(req.nodeOrg, instanceId, localId)) { duplicated++; continue; }

      var info = insertOne.run(
        req.nodeOrg, instanceId, String(r.user_id), String(r.conversation_id || ''), String(r.model_id || ''),
        numOf(r.prompt_tokens), numOf(r.completion_tokens), numOf(r.cache_hit_tokens),
        numOf(r.cache_miss_tokens), numOf(r.total_tokens), numOf(r.cost_micro),
        r.estimated ? 1 : 0, src, String(r.trace_id || ''), numOf(r.image_count),
        String(r.created_at || nowIso()), localId
      );
      if (info.changes > 0) accepted++; else duplicated++;
    }
  });
  try { tx(); } catch (err) {
    console.error('[Sync] 用量入库失败（学校 %s / 节点 %s）:', req.nodeOrg, instanceId, err.message);
    return res.status(500).json({ code: 500, message: '用量入库失败' });
  }

  db.prepare('UPDATE nodes SET last_report_at = ? WHERE instance_id = ? AND org_id = ?')
    .run(nowIso(), instanceId, req.nodeOrg);
  if (duplicated || rejected) {
    console.log('[Sync] 收到上报: %s（学校 %s），入库 %d 条，重复 %d 条，丢弃 %d 条',
      instanceId, req.nodeOrg, accepted, duplicated, rejected);
  } else {
    console.log('[Sync] 收到上报: %s（学校 %s），%d 条', instanceId, req.nodeOrg, accepted);
  }
  // 把三个数都回传：节点侧要能看出「我发的被丢了几条」，
  // 全部重复时也仍返回 200 —— 那表示云端已经收过了，重发是成功的。
  res.json({
    code: 200, message: 'ok',
    data: { accepted: accepted, duplicated: duplicated, rejected: rejected }
  });
});

// SPA 兜底：极简单页的 hash 路由不需要服务端兜底，但裸访问 / 时给 index
app.get('/', function(req, res) { res.sendFile(path.join(WEB_DIR, 'index.html')); });

app.listen(PORT, function() {
  console.log('ClussCloud 已启动');
  console.log('  ├─ 端口     : %d', PORT);
  console.log('  ├─ 数据库   : %s', DB_PATH);
  console.log('  └─ 职责     : 学校注册 / 节点同步 / 策略下发 / 积分分配');
});
