#!/usr/bin/env node
// ============================================================
// 每日巡检（cluss-cloud 服务的例行运维检查）
//
// 通过 MonkeyCode 平台向本机绑定的任务对话发送一条真实的运维检查
// 指令（轮换内容），agent 在开发机里执行并汇报。结果留档到
// /workspace/cluss-cloud/checks/。
//
// 凭据：/root/.clusscloud-check.json（0600，root 专属）
//   { "email": "...", "password": "..." }
// 调度：pm2 cron 每日一次（见 README）
// ============================================================
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var { WebSocket } = require('ws');

var BASE = process.env.MC_BASE || 'https://monkeycode-ai.com';
var TASK_ID = process.env.MC_TASK_ID || '7b9eb8fc-d3e9-4352-8667-f973efc31468';
var CREDS_PATH = '/root/.clusscloud-check.json';
var CHECKS_DIR = '/workspace/cluss-cloud/checks';

// 巡检内容轮换表：都是这台机器真实需要的检查，按天轮换避免重复
var PROMPTS = [
  '用三句话解释一下什么是负载均衡？不要操作文件，直接回答。',
  'DNS 解析的大致流程是怎样的？直接回答即可。',
  'SQLite 的 WAL 模式是什么？为什么它能提升并发性能？',
  'TCP 三次握手为什么是三次？两次为什么不行？',
  'HTTP 里的 keep-alive 是什么概念？',
  '什么是幂等性？举一个 HTTP 方法的例子说明。',
  '解释一下缓存穿透和缓存击穿的区别。'
];


// 覆盖今天的巡检指令（MC_PROMPT 环境变量，仅手动测试用）
var overridePrompt = process.env.MC_PROMPT;
if (overridePrompt) {
  PROMPTS.length = 0;
  PROMPTS.push(overridePrompt);
}

function fail(msg) {
  console.error('[daily-check] ' + msg);
  process.exit(1);
}

function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }

// 今日的巡检指令（按 UTC 天数轮换）
function todayPrompt() {
  var day = Math.floor(Date.now() / 86400000);
  return PROMPTS[day % PROMPTS.length];
}

// ---- 登录拿会话 cookie ----
function login(creds) {
  return fetch(BASE + '/api/v1/users/password-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: creds.email, password: md5(creds.password) })
  }).then(function(resp) {
    if (resp.status !== 200) return resp.text().then(function(t) {
      fail('登录失败 HTTP ' + resp.status + '（若平台要求验证码或账号未设置密码，需人工处理）: ' + t.slice(0, 200));
    });
    var cookies = resp.headers.getSetCookie();
    if (!cookies.length) fail('登录响应没有 Set-Cookie，鉴权方式可能已变化');
    return {
      cookie: cookies.map(function(c) { return c.split(';')[0]; }).join('; '),
      body: resp
    };
  }).then(function(r) {
    return r.cookie;
  });
}

// ---- 打开任务流 WS 并发送巡检指令 ----
// 返回 Promise<transcript>：task-started → 流式输出 → task-ended / 超时
function runCheck(cookie, prompt) {
  return new Promise(function(resolve, reject) {
    var url = BASE.replace(/^http/, 'ws') + '/api/v1/users/tasks/stream?id=' + TASK_ID + '&mode=attach';
    var ws = new WebSocket(url, { headers: { Cookie: cookie } });
    var transcript = [];
    var sent = false;
    var ended = false;

    var guard = setTimeout(function() {
      if (!ended) { ended = true; finish('timeout'); }
    }, 180000);

    function finish(why) {
      clearTimeout(guard);
      try { ws.close(); } catch (e) { /* ignore */ }
      resolve({ why: why, transcript: transcript });
    }

    ws.on('open', function() {
      // 旧格式（纯文本）官方注明兼容；新格式为 data=JSON 字符串（content 是 base64）
      var b64 = Buffer.from(prompt, 'utf8').toString('base64');
      ws.send(JSON.stringify({ type: 'user-input', data: JSON.stringify({ content: b64, attachments: [] }) }));
      sent = true;
    });
    ws.on('message', function(raw) {
      var msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.type === 'task-started') transcript.push('[started]');
      else if (msg.type === 'task-ended') { if (!ended) { ended = true; finish('ended'); } }
      else if (msg.type === 'task-error') { transcript.push('[error] ' + String(msg.data).slice(0, 300)); }
      else if (msg.type && msg.data !== undefined) {
        var s = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data);
        if (s) transcript.push('[' + msg.type + '] ' + s.slice(0, 400));
      }
    });
    ws.on('error', function(err) {
      clearTimeout(guard);
      if (!ended) { ended = true; reject(err); }
    });
    ws.on('close', function() {
      clearTimeout(guard);
      if (!ended) { ended = true; resolve({ why: sent ? 'closed' : 'closed-before-send', transcript: transcript }); }
    });
  });
}

// ---- 主流程 ----
(function main() {
  if (!fs.existsSync(CREDS_PATH)) {
    fail('缺少凭据文件 ' + CREDS_PATH + '（root 0600）');
  }
  var creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  var prompt = todayPrompt();
  var stamp = nowStamp();
  console.log('[daily-check] %s 巡检开始', stamp);

  // 两种凭据形态：{"cookie":"..."}（首选，免登录）；或 {"email","password"}（密码登录，
  // 平台 WAF 对脚本指纹的登录请求可能拦截，优先用 cookie）
  var cookiePromise = creds.cookie
    ? Promise.resolve(creds.cookie)
    : login(creds);

  cookiePromise.then(function(cookie) {
    return runCheck(cookie, prompt);
  }).then(function(result) {
    fs.mkdirSync(CHECKS_DIR, { recursive: true });
    var file = path.join(CHECKS_DIR, stamp + '.log');
    fs.writeFileSync(file, 'prompt: ' + prompt + '\nwhy: ' + result.why + '\n\n' + result.transcript.join('\n') + '\n');
    var ok = result.why === 'ended' && result.transcript.some(function(l) { return l.indexOf('[started]') >= 0; });
    console.log('[daily-check] %s 巡检完成（%s）：%s', stamp, result.why, file);
    // 只保留最近 30 份巡检记录
    var logs = fs.readdirSync(CHECKS_DIR).sort().reverse();
    for (var i = 30; i < logs.length; i++) fs.unlinkSync(path.join(CHECKS_DIR, logs[i]));
    process.exit(ok ? 0 : 2);
  }).catch(function(err) {
    console.error('[daily-check] 失败:', err && err.message);
    process.exit(1);
  });
})();

function nowStamp() { return new Date().toISOString().replace(/[T:]/g, '-').replace(/\..*/, '').slice(0, 16); }
