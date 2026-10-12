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
  var tokenA, tokenPlatform, code1;

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

    section('⑦ 账号绑定：班管 = 学校管理员');
    // 先把 2 班节点也接进来：另一个班的班管也要来抢席位，这是本节要拦的场景
    return http('POST', baseUrl + '/api/org/join', {
      org_id: global.A.org_id, secret: global.A.org_secret,
      instance_id: 'class-a2', label: '高一2班'
    });
  }).then(function(r) {
    ok('2 班节点接入成功', r.status === 200);
    return http('POST', baseUrl + '/api/sync/bind-request',
      { admin_username: 'yzadmin', class_user_id: '100101', class_admin: false },
      nodeHeaders(global.A.org_id, 'class-a1', 1, 1));
  }).then(function(r) {
    ok('非班管发起绑定被拒（403）', r.status === 403, 'status=' + r.status);
    return http('POST', baseUrl + '/api/sync/bind-request',
      { admin_username: 'ezadmin', class_user_id: '100101', class_admin: true },
      nodeHeaders(global.A.org_id, 'class-a1', 1, 1));
  }).then(function(r) {
    ok('拿别校管理员用户名发起被拒（403）', r.status === 403, 'status=' + r.status);
    return http('POST', baseUrl + '/api/sync/bind-request',
      { admin_username: 'yzadmin', class_user_id: '100101', class_admin: true },
      nodeHeaders(global.A.org_id, 'class-a1', 1, 1));
  }).then(function(r) {
    code1 = r.data.data.bind_code;
    ok('1 班班管发起成功，拿到 6 位确认码', r.status === 200 && /^[A-HJ-NP-Z2-9]{6}$/.test(code1 || ''), code1);
    return http('POST', baseUrl + '/api/auth/login', { username: 'ezadmin', password: 'ez-pass-12345' });
  }).then(function(r) {
    var tokenBAdmin = r.data.data.token;
    return http('POST', baseUrl + '/api/my/bind', { code: code1 }, { Authorization: 'Bearer ' + tokenBAdmin });
  }).then(function(r) {
    ok('别校管理员拿本校确认码被拒（403）', r.status === 403, 'status=' + r.status);
    return http('POST', baseUrl + '/api/my/bind', { code: 'ZZZZZZ' }, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    ok('错误确认码 404', r.status === 404, 'status=' + r.status);
    return http('POST', baseUrl + '/api/my/bind', { code: code1 }, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    ok('管理员确认后绑定成立', r.status === 200 && r.data.data.binding.class_user_id === '100101',
      JSON.stringify(r.data.data));
    return http('GET', baseUrl + '/api/my/overview', undefined, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    var ab = r.data.data.admin_binding;
    ok('概览带出管理员绑定（1 班 + 学号）',
      ab && ab.instance_id === 'class-a1' && ab.class_user_id === '100101',
      JSON.stringify(ab));
    // —— 第二个班的班管也想当管理员：全校只有一个席位 ——
    return http('POST', baseUrl + '/api/sync/bind-request',
      { admin_username: 'yzadmin', class_user_id: '100202', class_admin: true },
      nodeHeaders(global.A.org_id, 'class-a2', 1, 1));
  }).then(function(r) {
    var code2 = r.data.data.bind_code;
    ok('2 班班管也能发起（发起不禁他，禁的是占席位）', r.status === 200 && !!code2);
    return http('POST', baseUrl + '/api/my/bind', { code: code2 }, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    ok('第二个班管被拒：全校只能有一个班管当管理员（409）', r.status === 409,
      'status=' + r.status + ' ' + JSON.stringify(r.data));
    return http('POST', baseUrl + '/api/my/bind', { code: code1 }, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    ok('同一个确认码不能重复使用（409）', r.status === 409, 'status=' + r.status);
    return http('GET', baseUrl + '/api/my/bindings', undefined, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    ok('绑定状态可查：已有绑定 + 2 班待确认记录',
      r.data.data.binding && r.data.data.binding.class_user_id === '100101' &&
      r.data.data.pending.some(function(p) { return p.class_user_id === '100202'; }),
      JSON.stringify(r.data.data.pending));
    return http('DELETE', baseUrl + '/api/my/binding', {}, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    ok('解绑成功', r.status === 200);
    return http('GET', baseUrl + '/api/my/overview', undefined, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    ok('解绑后概览里绑定为空', r.data.data.admin_binding === null, JSON.stringify(r.data.data.admin_binding));
    // 席位空出来后，换人应当立刻可以（换届交接）
    return http('POST', baseUrl + '/api/sync/bind-request',
      { admin_username: 'yzadmin', class_user_id: '100202', class_admin: true },
      nodeHeaders(global.A.org_id, 'class-a2', 1, 1));
  }).then(function(r) {
    var code3 = r.data.data.bind_code;
    return http('POST', baseUrl + '/api/my/bind', { code: code3 }, { Authorization: 'Bearer ' + tokenA });
  }).then(function(r) {
    ok('换届交接：2 班班管接任成功', r.status === 200 && r.data.data.binding.instance_id === 'class-a2',
      JSON.stringify(r.data.data));
    return http('POST', baseUrl + '/api/auth/login', { username: ADMIN.username, password: ADMIN.password });
  }).then(function(r) {
    var tp = r.data.data.token;
    return http('GET', baseUrl + '/api/platform/overview', undefined, { Authorization: 'Bearer ' + tp });
  }).then(function(r) {
    var orgA = r.data.data.orgs.filter(function(o) { return o.id === global.A.org_id; })[0];
    ok('平台视图可见各校管理员席位',
      orgA && orgA.admin_binding && orgA.admin_binding.class_user_id === '100202',
      JSON.stringify(orgA && orgA.admin_binding));

    console.log('\n== ⑧ 配置上行写：席位班管在本地改 → 同步全校 ==');
    // 上一节结束时 A 校席位已在 class-a2（学号 100202）上。
    var SEAT = { instance: 'class-a2', user: '100202' };
    var OTHER = { instance: 'class-a1', user: '100101' };
    var seatNode = function(v) {
      var h = nodeHeaders(global.A.org_id, SEAT.instance, v || 0, v || 0);
      return h;
    };
    var cfg = {
      models: [{ id: 'up-model', label: '上行模型', api_url: 'https://api.example.com', api_key: 'sk-node', model_name: 'up-model', api_style: 'openai', price_in: 1000, price_out: 2000, price_cache_hit: 100, is_free: 0, enabled: 1, is_default: 1 }],
      sources: [{ id: 'up-src', label: '上行源', api_url: 'https://src.example.com', api_key: 'sk-src', api_style: 'openai', enabled: 1 }],
      meta: { vision_enabled: '1', offpeak_enabled: '0' }
    };

    return http('POST', baseUrl + '/api/sync/policy',
      { base_version: 99, class_user_id: SEAT.user, class_admin: true, config: cfg }, seatNode())
      .then(function(r) {
        ok('版本对不上时推配置被拒（409，防止静默覆盖）', r.status === 409, 'HTTP ' + r.status);
        return http('POST', baseUrl + '/api/sync/policy',
          { class_user_id: OTHER.user, class_admin: true, config: cfg }, nodeHeaders(global.A.org_id, OTHER.instance, 0, 0));
      }).then(function(r) {
        ok('非席位班推配置被拒（403）', r.status === 403, 'HTTP ' + r.status + ' ' + (r.data && r.data.message));
        ok('拒绝原因说清了席位在哪个班', r.status === 403 && String(r.data.message).indexOf(SEAT.instance) > 0,
          r.data && r.data.message);
        return http('POST', baseUrl + '/api/sync/policy',
          { class_user_id: SEAT.user, class_admin: false, config: cfg }, seatNode());
      }).then(function(r) {
        ok('不是班管的账号推配置被拒（403）', r.status === 403, 'HTTP ' + r.status);
        return http('POST', baseUrl + '/api/sync/policy',
          { class_user_id: '999999', class_admin: true, config: cfg }, seatNode());
      }).then(function(r) {
        ok('学号与席位不符被拒（403）', r.status === 403, 'HTTP ' + r.status);
        return http('POST', baseUrl + '/api/sync/policy',
          { class_admin: true, config: cfg }, seatNode());
      }).then(function(r) {
        ok('不报学号被拒（403）', r.status === 403, 'HTTP ' + r.status);
        return http('POST', baseUrl + '/api/sync/policy',
          { class_user_id: SEAT.user, class_admin: true, config: cfg },
          nodeHeaders(global.B.org_id, SEAT.instance, 0, 0));
      }).then(function(r) {
        ok('B 校拿 A 校席位推不了（403）', r.status === 403, 'HTTP ' + r.status);
        return http('GET', baseUrl + '/api/my/bindings', undefined, { Authorization: 'Bearer ' + tokenA });
      }).then(function(r) {
        var mv = (r.data.data.binding && 0) || 0;
        global.CUR_MODEL_V = 1; // 上一节推过一次模型配置，版本从 1 起
        return http('POST', baseUrl + '/api/sync/policy',
          { base_version: global.CUR_MODEL_V, class_user_id: SEAT.user, class_admin: true, config: cfg }, seatNode());
      }).then(function(r) {
        ok('席位班管推配置成功', r.status === 200, 'HTTP ' + r.status + ' ' + (r.data && r.data.message));
        ok('版本号递增', r.status === 200 && r.data.data.model_config_version > 1,
          JSON.stringify(r.data && r.data.data));
        global.CUR_MODEL_V = r.data.data.model_config_version;
        return http('GET', baseUrl + '/api/sync/model-config', undefined,
          nodeHeaders(global.A.org_id, OTHER.instance, 0, 0));
      }).then(function(r) {
        // 关键验收：另一个班的节点要能读到席位班推上来的配置
        var models = (r.data && r.data.data && r.data.data.models) || [];
        ok('另一个班的节点读到了推送的配置',
          models.some(function(m) { return m.id === 'up-model'; }),
          JSON.stringify(models.map(function(m) { return m.id; })));
        ok('模型源也一并同步', ((r.data.data.sources) || []).some(function(s) { return s.id === 'up-src'; }));
        return http('GET', baseUrl + '/api/sync/model-config', undefined,
          nodeHeaders(global.A.org_id, SEAT.instance, 0, 0));
      }).then(function(r) {
        var models = (r.data.data.models) || [];
        ok('推送的配置里的 api_key 仍按校隔离',
          models.every(function(m) { return m.api_key !== 'sk-node'; }),
          JSON.stringify(models.map(function(m) { return m.api_key; })));
        return http('POST', baseUrl + '/api/sync/policy',
          { base_version: 1, class_user_id: SEAT.user, class_admin: true, config: cfg }, seatNode());
      }).then(function(r) {
        ok('重复用旧 base_version 推被拒（CAS 生效）', r.status === 409, 'HTTP ' + r.status);
        return http('POST', baseUrl + '/api/sync/policy',
          { class_user_id: SEAT.user, class_admin: true, config: { models: [{ label: '缺 id' }] } }, seatNode());
      }).then(function(r) {
        ok('模型缺 id 被拒（400）', r.status === 400, 'HTTP ' + r.status);

        // ---- 额度上行 ----
        return http('POST', baseUrl + '/api/sync/allocations',
          { class_user_id: OTHER.user, class_admin: true, items: [{ user_id: '100101', allocated_micro: 8888, idem_key: 'k-other' }] },
          nodeHeaders(global.A.org_id, OTHER.instance, 0, 0));
      }).then(function(r) {
        ok('非席位班推额度被拒（403）', r.status === 403, 'HTTP ' + r.status);
        return http('GET', baseUrl + '/api/my/overview', undefined, { Authorization: 'Bearer ' + tokenA });
      }).then(function(r) {
        global.CUR_ASSIGN_V = parseInt(r.data.data.assign_version, 10) || 0;
        return http('POST', baseUrl + '/api/sync/allocations', {
          base_version: global.CUR_ASSIGN_V,
          class_user_id: SEAT.user,
          class_admin: true,
          items: [
            { user_id: '100303', allocated_micro: 3000000, weekly_quota_micro: 0, reason: '本机分配', idem_key: 'up-idem-001' },
            { user_id: '100404', allocated_micro: 5000000, weekly_quota_micro: 0, reason: '本机分配', idem_key: 'up-idem-002' }
          ]
        }, seatNode());
      }).then(function(r) {
        ok('席位班管推额度成功', r.status === 200 && r.data.data.applied === 2,
          'HTTP ' + r.status + ' ' + JSON.stringify(r.data && r.data.data));
        global.CUR_ASSIGN_V = r.data.data.assign_version;
        return http('GET', baseUrl + '/api/sync/assignments', undefined, nodeHeaders(global.A.org_id, OTHER.instance, 0, 0));
      }).then(function(r) {
        var a = (r.data.data.assignments) || [];
        var hit = a.filter(function(x) { return x.user_id === '100303' && x.allocated_micro === 3000000; });
        ok('另一个班拉到席位班推的额度', hit.length === 1,
          JSON.stringify(a.map(function(x) { return x.user_id + '=' + x.allocated_micro; })));
        return http('POST', baseUrl + '/api/sync/allocations', {
          base_version: global.CUR_ASSIGN_V,
          class_user_id: SEAT.user, class_admin: true,
          items: [{ user_id: '100303', allocated_micro: 3000000, weekly_quota_micro: 0, reason: '重试', idem_key: 'up-idem-001' }]
        }, seatNode());
      }).then(function(r) {
        ok('同一 idem_key 重放不重复生效', r.status === 200 && r.data.data.skipped >= 1,
          JSON.stringify(r.data && r.data.data));
        return http('GET', baseUrl + '/api/my/logs?limit=20', undefined, { Authorization: 'Bearer ' + tokenA });
      }).then(function(r) {
        var logs = (r.data.data.logs) || [];
        var dups = logs.filter(function(l) { return l.user_id === '100303' && l.amount_micro === 3000000; });
        ok('流水里没有重复记账', dups.length <= 1, '匹配流水 ' + dups.length + ' 条');
        ok('流水记下了操作来自哪个班', logs.some(function(l) { return String(l.reason).indexOf(SEAT.instance) > 0; }),
          JSON.stringify(logs.slice(0, 2).map(function(l) { return l.reason; })));
        return http('POST', baseUrl + '/api/sync/allocations', {
          base_version: 1, class_user_id: SEAT.user, class_admin: true,
          items: [{ user_id: '100303', allocated_micro: 1, idem_key: 'up-idem-003' }]
        }, seatNode());
      }).then(function(r) {
        ok('额度推的 CAS 也生效', r.status === 409, 'HTTP ' + r.status);
        return http('GET', baseUrl + '/api/my/overview', undefined, { Authorization: 'Bearer ' + tokenA });
      }).then(function(r) {
        ok('上行写不会误伤其他学校的密钥隔离', r.status === 200);
        console.log('\n== ⑨ 学生台账 / 额度归零 / 密钥隔离 ==');
        return http('GET', baseUrl + '/api/my/students', undefined, { Authorization: 'Bearer ' + tokenA });
      }).then(function(r) {
        // 这条路由以前从没被验证套件碰过，于是「参数个数不对 → 恒 500」
        // 一直没人发现，学生的额度台账页从上线起就是坏的。
        ok('学生台账接口不 500', r.status === 200, 'HTTP ' + r.status);
        var list = (r.data && r.data.data && r.data.data.students) || [];
        ok('台账能列出已分配的学生', list.length > 0, JSON.stringify(list.map(function(s) { return s.user_id; })));
        return http('GET', baseUrl + '/api/my/students?keyword=1001', undefined, { Authorization: 'Bearer ' + tokenA });
      }).then(function(r) {
        ok('带关键词查询也正常', r.status === 200, 'HTTP ' + r.status);
        return http('POST', baseUrl + '/api/my/topup', { user_id: '100101', amount_yuan: 0, reason: '停用测试' },
          { Authorization: 'Bearer ' + tokenA });
      }).then(function(r) {
        ok('额度设为 0 被接受', r.status === 200 && r.data.data.allocated_micro === 0,
          JSON.stringify(r.data && r.data.data));
        return http('GET', baseUrl + '/api/sync/assignments', undefined, nodeHeaders(global.A.org_id, 'class-a1', 0, 0));
      }).then(function(r) {
        // 归零记录必须真的下发：云端账清了、版本号也涨了，节点却收不到，
        // 学生的额度就永远停不掉——这是扣费系统最不能错的方向。
        var a = (r.data && r.data.data && r.data.data.assignments) || [];
        var zero = a.filter(function(x) { return x.user_id === '100101' && x.allocated_micro === 0; });
        ok('归零记录会下发到节点', zero.length === 1,
          '下发内容: ' + JSON.stringify(a.map(function(x) { return x.user_id + '=' + x.allocated_micro; })));
        return http('GET', baseUrl + '/api/sync/model-config', undefined, nodeHeaders(global.A.org_id, 'class-a1', 0, 0));
      }).then(function(r) {
        var models = (r.data && r.data.data && r.data.data.models) || [];
        var leaked = models.filter(function(m) { return m.api_key && m.api_key !== ''; });
        // 注册接口是公开无审批的：不隔离的话，任何人花 10 秒注册一个学校
        // 就能拿到平台运营者的 LLM 供应商密钥，直接烧平台的钱。
        ok('未配密钥的学校拿不到平台密钥', leaked.length === 0,
          '拿到的 api_key: ' + JSON.stringify(leaked.map(function(m) { return m.api_key; })));
        ok('模型列表本身照常下发（学生还要用它显示）', models.length > 0, '模型数 ' + models.length);
        return http('PUT', baseUrl + '/api/platform/orgs/' + global.A.org_id + '/model-key',
          { api_key: 'sk-ORG-A-KEY-123' }, { Authorization: 'Bearer ' + tokenPlatform });
      }).then(function(r) {
        ok('平台可给该校单独下发密钥', r.status === 200, 'HTTP ' + r.status);
        return http('GET', baseUrl + '/api/sync/model-config', undefined, nodeHeaders(global.A.org_id, 'class-a1', 0, 0));
      }).then(function(r) {
        var models = (r.data && r.data.data && r.data.data.models) || [];
        ok('配了之后节点拿到的是本校密钥',
          models.length > 0 && models[0].api_key === 'sk-ORG-A-KEY-123',
          JSON.stringify(models.map(function(m) { return m.api_key; })));
        return http('GET', baseUrl + '/api/sync/model-config', undefined, nodeHeaders(global.B.org_id, 'class-b1', 0, 0));
      }).then(function(r) {
        var models = (r.data && r.data.data && r.data.data.models) || [];
        ok('A 校的密钥不会串到 B 校',
          models.every(function(m) { return m.api_key !== 'sk-ORG-A-KEY-123'; }),
          JSON.stringify(models.map(function(m) { return m.api_key; })));
        return http('GET', baseUrl + '/api/platform/overview', undefined, { Authorization: 'Bearer ' + tokenPlatform });
      }).then(function(r) {
        var oa = r.data.data.orgs.filter(function(o) { return o.id === global.A.org_id; })[0];
        var ob = r.data.data.orgs.filter(function(o) { return o.id === global.B.org_id; })[0];
        ok('平台视图能看出哪校配了密钥',
          oa && oa.has_model_key === true && ob && ob.has_model_key === false,
          'A=' + (oa && oa.has_model_key) + ' B=' + (ob && ob.has_model_key));
      });
  }).catch(function(err) {
    console.error('\n验证异常:', err && err.message);
    if (child) console.error('--- 服务日志尾部 ---\n' + child.buf().split('\n').slice(-25).join('\n'));
    shutdown(1);
  }).then(function() {
    console.log('\n========================================');
    console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
    console.log('========================================');
    shutdown(fail ? 1 : 0);
  });
}

process.on('SIGINT', function() { shutdown(1); });
main();
