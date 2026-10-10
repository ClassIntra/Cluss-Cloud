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

// ------------------------------------------------------------
// 数据库（独立 schema：没有学生表 —— 学生不属于这里）
// ------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
var db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec([
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
  '  created_at TEXT NOT NULL',
  ');',
  'CREATE INDEX IF NOT EXISTS idx_usage_org ON usage_log(org_id, created_at DESC);',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS admins (',     // 平台运营者
  '  username TEXT PRIMARY KEY,',
  '  pass_hash TEXT NOT NULL,',
  '  created_at TEXT NOT NULL',
  ');'
].join('\n'));

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
  next();
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
  res.json({
    code: 200, message: '注册成功',
    data: {
      org_id: orgId,
      org_name: schoolName,
      username: username,
      org_secret: orgSecret, // 只显示这一次
      relay_url: base,
      env_template: [
        'CLUSS_MODE=node',
        'CLUSS_INSTANCE_ID=class-01',
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

  var totals = db.prepare([
    'SELECT',
    '  (SELECT COUNT(*) FROM allocations WHERE org_id = ? AND allocated_micro > 0) AS students,',
    '  (SELECT IFNULL(SUM(allocated_micro),0) FROM allocations WHERE org_id = ?) AS allocated_micro,',
    '  (SELECT IFNULL(SUM(cost_micro),0) FROM usage_log WHERE org_id = ?) AS used_micro,',
    '  (SELECT COUNT(*) FROM usage_log WHERE org_id = ?) AS calls,',
    '  (SELECT IFNULL(SUM(cost_micro),0) FROM usage_log WHERE org_id = ? AND created_at >= ?) AS month_cost_micro'
  ].join('\n')).get(orgId, orgId, orgId, orgId, orgId, monthIso);

  res.json({
    code: 200, message: 'ok',
    data: {
      org: { id: req.org.id, name: req.org.name, region: req.org.region },
      assign_version: parseInt(getMeta('assign_version', '0'), 10) || 0,
      model_config_version: parseInt(getMeta('model_config_version', '0'), 10) || 0,
      online_window_sec: NODE_ONLINE_WINDOW_SEC,
      nodes: nodes,
      totals: totals
    }
  });
});

app.get('/api/my/students', requireWeb, requireOrgAdmin, function(req, res) {
  var orgId = req.org.id;
  var keyword = String(req.query.keyword || '').trim();
  var limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);
  var params = [orgId, orgId];
  var where = 'WHERE a.org_id = ?';
  if (keyword) { where += ' AND a.user_id LIKE ?'; params.push('%' + keyword + '%'); }
  params.push(orgId, limit);

  var rows = db.prepare([
    'SELECT a.user_id, a.allocated_micro, a.weekly_quota_micro, a.updated_at, a.assigned_by,',
    '  IFNULL(s.used_micro,0) AS used_micro, IFNULL(s.calls,0) AS calls, s.last_at',
    'FROM allocations a',
    'LEFT JOIN (',
    '  SELECT user_id, SUM(cost_micro) AS used_micro, COUNT(*) AS calls, MAX(created_at) AS last_at',
    '  FROM usage_log WHERE org_id = ? GROUP BY user_id',
    ') s ON s.user_id = a.user_id',
    where,
    'ORDER BY a.updated_at DESC LIMIT ?'
  ].join('\n')).all.apply(db.prepare([
    'SELECT a.user_id, a.allocated_micro, a.weekly_quota_micro, a.updated_at, a.assigned_by,',
    '  IFNULL(s.used_micro,0) AS used_micro, IFNULL(s.calls,0) AS calls, s.last_at',
    'FROM allocations a',
    'LEFT JOIN (',
    '  SELECT user_id, SUM(cost_micro) AS used_micro, COUNT(*) AS calls, MAX(created_at) AS last_at',
    '  FROM usage_log WHERE org_id = ? GROUP BY user_id',
    ') s ON s.user_id = a.user_id',
    where,
    'ORDER BY a.updated_at DESC LIMIT ?'
  ].join('\n')), params);

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

  var tx = db.transaction(function() {
    var before = db.prepare('SELECT allocated_micro FROM allocations WHERE user_id = ? AND org_id = ?').get(userId, req.org.id);
    db.prepare([
      'INSERT INTO allocations (user_id, org_id, allocated_micro, weekly_quota_micro, assigned_by, updated_at)',
      'VALUES (?, ?, ?, ?, ?, ?)',
      'ON CONFLICT(user_id, org_id) DO UPDATE SET allocated_micro = excluded.allocated_micro,',
      '  weekly_quota_micro = excluded.weekly_quota_micro, assigned_by = excluded.assigned_by,',
      '  updated_at = excluded.updated_at'
    ].join('\n')).run(userId, req.org.id, allocated, weekly, req.auth.name, now);
    var delta = allocated - (before ? before.allocated_micro : 0);
    if (delta !== 0) {
      db.prepare([
        'INSERT INTO credit_log (org_id, user_id, amount_micro, kind, reason, operator, idem_key, created_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ].join('\n')).run(req.org.id, userId, delta, 'topup', String(b.reason || '充值'), req.auth.name, idemKey, now);
    }
    bumpMeta('assign_version');
  });
  tx();

  console.log('[Org] 充值: 学校 %s → %s ¥%s by %s', req.org.id, userId, amountYuan, req.auth.name);
  res.json({ code: 200, message: '已充值，各班节点将在 1 分钟内同步到', data: { assign_version: parseInt(getMeta('assign_version', '0'), 10) } });
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
          calls: t.calls, cost_micro: t.cost_micro, month_cost_micro: t.month_cost_micro
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
// 同步接口（与 Cluss node 模式逐字段兼容）
// ------------------------------------------------------------
app.get('/api/sync/version', requireNode, function(req, res) {
  res.json({
    code: 200, message: 'ok',
    data: {
      instance_id: INSTANCE_ID,
      assign_version: parseInt(getMeta('assign_version', '0'), 10) || 0,
      model_config_version: parseInt(getMeta('model_config_version', '0'), 10) || 0,
      server_time: nowIso().replace('T', ' ').slice(0, 19)
    }
  });
});

app.get('/api/sync/assignments', requireNode, function(req, res) {
  var rows = db.prepare([
    'SELECT user_id, allocated_micro, weekly_quota_micro, assigned_by, updated_at',
    'FROM allocations WHERE allocated_micro > 0 AND org_id = ?'
  ].join('\n')).all(req.nodeOrg);
  res.json({
    code: 200, message: 'ok',
    data: {
      assign_version: parseInt(getMeta('assign_version', '0'), 10) || 0,
      assignments: rows
    }
  });
});

app.get('/api/sync/model-config', requireNode, function(req, res) {
  var raw = getMeta('model_config', 'null');
  var doc = null;
  try { doc = JSON.parse(raw); } catch (e) { doc = null; }
  res.json({
    code: 200, message: 'ok',
    data: {
      model_config_version: parseInt(getMeta('model_config_version', '0'), 10) || 0,
      models: (doc && doc.models) || [],
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
  var insert = db.prepare([
    'INSERT INTO usage_log (org_id, origin_instance, user_id, conversation_id, model_id,',
    '  prompt_tokens, completion_tokens, cache_hit_tokens, cache_miss_tokens, total_tokens,',
    '  cost_micro, estimated, source, trace_id, image_count, created_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ].join('\n'));

  var accepted = 0;
  var tx = db.transaction(function() {
    for (var i = 0; i < records.length; i++) {
      var r = records[i] || {};
      if (!r.user_id) continue;
      var src = String(r.source || 'chat');
      if (ALLOWED_SOURCES.indexOf(src) < 0) src = 'chat';
      insert.run(
        req.nodeOrg, instanceId, String(r.user_id), String(r.conversation_id || ''), String(r.model_id || ''),
        Number(r.prompt_tokens || 0), Number(r.completion_tokens || 0), Number(r.cache_hit_tokens || 0),
        Number(r.cache_miss_tokens || 0), Number(r.total_tokens || 0), Number(r.cost_micro || 0),
        r.estimated ? 1 : 0, src, String(r.trace_id || ''), Number(r.image_count || 0),
        String(r.created_at || nowIso())
      );
      accepted++;
    }
  });
  try { tx(); } catch (err) {
    console.error('[Sync] 用量入库失败:', err.message);
    return res.status(500).json({ code: 500, message: '用量入库失败' });
  }

  db.prepare('UPDATE nodes SET last_report_at = ? WHERE instance_id = ? AND org_id = ?')
    .run(nowIso(), instanceId, req.nodeOrg);
  console.log('[Sync] 收到上报: %s（学校 %s），%d 条', instanceId, req.nodeOrg, accepted);
  res.json({ code: 200, message: 'ok', data: { accepted: accepted } });
});

// SPA 兜底：极简单页的 hash 路由不需要服务端兜底，但裸访问 / 时给 index
app.get('/', function(req, res) { res.sendFile(path.join(WEB_DIR, 'index.html')); });

app.listen(PORT, function() {
  console.log('ClussCloud 已启动');
  console.log('  ├─ 端口     : %d', PORT);
  console.log('  ├─ 数据库   : %s', DB_PATH);
  console.log('  └─ 职责     : 学校注册 / 节点同步 / 策略下发 / 积分分配');
});
