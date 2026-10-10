// ============================================================
// Cluss-Cloud 自验证：注册 → 接入 → 策略下发 → 积分分配 → 用量对账 → 吊销
//
// 起一个真实实例（临时库/端口），用内置 fetch 扮演节点与两类管理员，
// 全程不 mock。跑法：npm run verify（在仓库根目录）
// ============================================================
'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');
var net = require('net');
var { spawn } = require('child_process');

var ROOT = path.resolve(__dirname, '..');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  | ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

function freePort() {
  return new Promise(function(resolve) {
    var srv = net.createServer();
    srv.listen(0, '127.0.0.1', function() {
      var p = srv.address().port;
      srv.close(function() { resolve(p); });
    });
  });
}

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clusscloud-verify-'));
var child, baseUrl;

// fetch 包装：非 2xx 不抛异常，返回 { status, data } 交给断言判
function http(method, url, body, headers) {
  var opts = { method: method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(url, opts).then(function(r) {
    return r.json().catch(function() { return null; }).then(function(j) {
      return { status: r.status, data: j };
    });
  });
}

function waitHealthy() {
  var deadline = Date.now() + 20000;
  function tick() {
    return http('GET', baseUrl + '/api/health').then(function(r) {
      if (r.status === 200) return null;
      if (Date.now() > deadline) throw new Error('服务就绪超时');
      return new Promise(function(res) { setTimeout(res, 250); }).then(tick);
    }).catch(function(err) {
      // 服务还在启动（原生模块加载等）——连接失败也要重试到超时为止
      if (Date.now() > deadline) throw new Error('服务就绪超时: ' + (err && err.message));
      return new Promise(function(res) { setTimeout(res, 300); }).then(tick);
    });
  }
  return tick();
}
function shutdown(code) {
  if (child) { try { child.kill(); } catch (e) { /* ignore */ } }
  setTimeout(function() {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    process.exit(code);
  }, 400);
}

var ADMIN = { username: 'admin', password: 'platform-pass-123' };

var NODE_SECRET = ''; // 注册后回填：节点请求必须用学校真实密钥
function nodeHeaders(org, instance, assignV, modelV) {
  return {
    'X-Cluss-Secret': global.SECRETS[org],
    'X-Cluss-Org': org,
    'X-Cluss-Instance': instance,
    'X-Cluss-Node-Version': '0.2.0',
    'X-Cluss-Assign-Version': String(assignV || 0),
    'X-Cluss-Model-Version': String(modelV || 0)
  };
}
function bareHeaders(org, instance) {
  return { 'X-Cluss-Secret': global.SECRETS[org], 'X-Cluss-Org': org, 'X-Cluss-Instance': instance };
}

function main() {
  var tokenA, tokenPlatform;

  return freePort().then(function(port) {
    baseUrl = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, {
        PORT: String(port),
        DB_PATH: path.join(tmpDir, 'cc.db'),
        JWT_SECRET: 'clusscloud-verify-jwt-secret-0123456789',
        ADMIN_USERNAME: ADMIN.username,
        ADMIN_PASSWORD: ADMIN.password
      }),
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
    });
    var out = '';
    child.stdout.on('data', function(d) { out += d; });
    child.stderr.on('data', function(d) { out += d; });
    child.buf = function() { return out; };
    return waitHealthy();
  }).then(function() {
    section('① 注册学校 A / B');
    return http('POST', baseUrl + '/api/org/register', {
      school_name: '验证一中', region: '测试省', username: 'yzadmin', password: 'yz-pass-12345'
    }).then(function(r) {
      ok('学校 A 注册成功', r.status === 200 && /^[A-Z2-9]{6}$/.test(r.data.data.org_id), JSON.stringify(r.data.data && r.data.data.org_id));
      global.A = r.data.data;
      global.SECRETS = {};
      global.SECRETS[global.A.org_id] = global.A.org_secret;
      ok('.env 模板包含编号与密钥', global.A.env_template.indexOf(global.A.org_id) > 0 && global.A.env_template.indexOf(global.A.org_secret) > 0);
      return http('POST', baseUrl + '/api/org/register', {
        school_name: '验证二中', username: 'ezadmin', password: 'ez-pass-12345'
      });
    }).then(function(r) {
      global.B = r.data.data;
      global.SECRETS[global.B.org_id] = global.B.org_secret;
      ok('学校 B 注册成功且编号不同', r.status === 200 && global.B.org_id !== global.A.org_id);
      return http('POST', baseUrl + '/api/org/register', {
        school_name: '验证三中', username: 'yzadmin', password: 'x-pass-12345'
      });
    }).then(function(r) {
      ok('用户名冲突被拒绝（409）', r.status === 409, 'status=' + r.status);
    });
  }).then(function() {
    section('② 节点接入 + 心跳');
    return http('POST', baseUrl + '/api/org/join', {
      org_id: global.A.org_id, secret: 'wrong', instance_id: 'class-a1'
    }).then(function(r) {
      ok('错误密钥被拒绝（403）', r.status === 403);
      return http('POST', baseUrl + '/api/org/join', {
        org_id: global.A.org_id, secret: global.A.org_secret,
        instance_id: 'class-a1', node_version: '0.2.0'
      });
    }).then(function(r) {
      ok('节点 A1 接入成功', r.status === 200);
      // 无版本头的裸心跳：不应抹掉显式接入写入的 node_version（心跳覆盖坑回归）
      return http('GET', baseUrl + '/api/sync/version', undefined, bareHeaders(global.A.org_id, 'class-a1'));
    }).then(function(r) {
      ok('裸心跳后节点轮询版本成功', r.status === 200 && r.data.data.model_config_version === 0);
    });
  }).then(function() {
    section('③ 策略下发（模型配置）');
    return http('POST', baseUrl + '/api/auth/login', { username: ADMIN.username, password: ADMIN.password });
  }).then(function(r) {
    tokenPlatform = r.data.data.token;
    ok('平台运营者登录成功', r.data.data.role === 'platform');
    return http('PUT', baseUrl + '/api/platform/model-config', {
      config: {
        models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', api_url: 'https://api.deepseek.com', api_key: 'sk-test', model_name: 'deepseek-chat', api_style: 'openai', price_in: 2000, price_out: 8000, price_cache_hit: 200, is_free: 0, enabled: 1, is_default: 1 }],
        sources: [], meta: { vision_enabled: '1' }
      }
    }, { Authorization: 'Bearer ' + tokenPlatform });
  }).then(function(r) {
    ok('模型配置已下发 v1', r.status === 200 && r.data.data.model_config_version === 1, JSON.stringify(r.data));
    return http('GET', baseUrl + '/api/sync/model-config', undefined, nodeHeaders(global.A.org_id, 'class-a1', 0, 0));
  }).then(function(r) {
    var d = r.data.data;
    ok('节点拉到模型快照（1 个模型）', d.model_config_version === 1 && d.models.length === 1 && d.models[0].id === 'deepseek-chat');
    ok('meta 随行', d.meta.vision_enabled === '1');
  }).then(function() {
    section('④ 积分分配 + 按校隔离');
    return http('POST', baseUrl + '/api/auth/login', { username: 'yzadmin', password: 'yz-pass-12345' });
  }).then(function(r) {
    tokenA = r.data.data.token;
    ok('学校管理员登录成功', r.data.data.role === 'org' && r.data.data.org.id === global.A.org_id);
    return http('POST', baseUrl + '/api/my/topup', { user_id: '100101', amount_yuan: 5 }, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    ok('A 校充值 5 元成功', r.status === 200 && r.data.data.assign_version === 1, JSON.stringify(r.data));
    return http('GET', baseUrl + '/api/sync/assignments', undefined, nodeHeaders(global.A.org_id, 'class-a1', 0, 1));
  }).then(function(r) {
    var list = r.data.data.assignments;
    ok('A1 拉到分配（100101 = 5 元）', list.length === 1 && list[0].user_id === '100101' && list[0].allocated_micro === 5000000, JSON.stringify(list));
    return http('GET', baseUrl + '/api/sync/assignments', undefined, bareHeaders(global.B.org_id, 'class-b1'));
  }).then(function(r) {
    ok('B 校拉不到 A 校分配', r.data.data.assignments.length === 0);
    return http('POST', baseUrl + '/api/auth/login', { username: 'ezadmin', password: 'ez-pass-12345' });
  }).then(function(r) {
    return http('POST', baseUrl + '/api/my/topup', { user_id: '100101', amount_yuan: 9 },
      { Authorization: 'Bearer ' + r.data.data.token });
  }).then(function(r) {
    ok('B 校给 A 校学号充值被拒（403）', r.status === 403, 'status=' + r.status);
  }).then(function() {
    section('⑤ 用量回传对账');
    return http('POST', baseUrl + '/api/sync/usage', {
      records: [{ user_id: '100101', conversation_id: 'c1', model_id: 'deepseek-chat',
        prompt_tokens: 10, completion_tokens: 5, cache_hit_tokens: 0, cache_miss_tokens: 15,
        total_tokens: 15, cost_micro: 1000000, estimated: 0, source: 'chat',
        trace_id: '', image_count: 0, created_at: '2026-10-11 02:00:00' }]
    }, nodeHeaders(global.A.org_id, 'class-a1', 1, 1));
  }).then(function(r) {
    ok('A1 上报 1 条用量', r.data.data.accepted === 1);
    // 再来一次无版本头的裸心跳上报：node_version 必须原样保留
    return http('POST', baseUrl + '/api/sync/usage', { records: [] }, bareHeaders(global.A.org_id, 'class-a1'));
  }).then(function(r) {
    ok('裸心跳上报被接受', r.status === 200);
    return http('GET', baseUrl + '/api/my/overview', undefined, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    var d = r.data.data;
    ok('A 校台账：已用 1 元 / 1 次', d.totals.used_micro === 1000000 && d.totals.calls === 1, JSON.stringify(d.totals));
    ok('A 校节点在线且已上报', d.nodes.length === 1 && d.nodes[0].online === true && !!d.nodes[0].last_report_at);
    ok('节点版本号保留（裸心跳不抹掉）', d.nodes[0].node_version === '0.2.0', d.nodes[0].node_version);
  }).then(function() {
    section('⑥ 吊销 / 恢复');
    return http('POST', baseUrl + '/api/my/nodes/class-a1/revoke', {}, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    ok('吊销成功', r.status === 200);
    return http('GET', baseUrl + '/api/sync/version', undefined, nodeHeaders(global.A.org_id, 'class-a1', 1, 1));
  }).then(function(r) {
    ok('吊销后同步被拒（403）', r.status === 403, 'status=' + r.status);
    return http('POST', baseUrl + '/api/my/nodes/class-a1/restore', {}, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    ok('恢复接口成功', r.status === 200);
    return http('GET', baseUrl + '/api/sync/version', undefined, nodeHeaders(global.A.org_id, 'class-a1', 1, 1));
  }).then(function(r) {
    ok('恢复后同步正常', r.status === 200);

    console.log('\n========================================');
    console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
    console.log('========================================');
    shutdown(fail ? 1 : 0);
  }).catch(function(err) {
    console.error('\n验证异常:', err && err.message);
    if (child) console.error('--- 服务日志尾部 ---\n' + child.buf().split('\n').slice(-25).join('\n'));
    shutdown(1);
  });
}

process.on('SIGINT', function() { shutdown(1); });
main();
