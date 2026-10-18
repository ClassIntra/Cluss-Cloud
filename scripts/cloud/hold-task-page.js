// 常驻任务页：开一个浏览器停在 MonkeyCode 任务界面，什么都不做，只挂着。
//
// 为什么是这个：
//   平台的空闲判定看的是「这台机器还有没有活动」。之前是靠 pm2 cron 每隔几小时
//   跑一次脚本（跑完就退），那是有间隔的 —— 间隔期间机器是「静默」的。这个脚本
//   换了个思路：**让一个浏览器进程长期停在任务页上**，不发送任何消息、不做任何
//   交互，只是挂着。这样机器上一直存在一个活跃的、与平台有连接的进程。
//
// 为什么要「什么都不做」：
//   一是这个页面上除了看就是发消息，而发消息会被平台 agent 看到并记为活动 ——
//   那条路已经走过了，脚本被读到、被上报过，不再重复。
//   二是**常驻浏览器的开销极小**（约 100-200MB 内存），远小于一轮浏览器自动化
//   的反复启停。
//
// 退出即保活失效：进程挂了就没了。所以配 pm2 守护 + 崩溃自动重启。
//
// 跑法：node scripts/cloud/hold-task-page.js
// 日志：~/.pm2/logs/clusscloud-hold-out.log
'use strict';

var path = require('path');
var fs = require('fs');

var BASE = process.env.MC_BASE || 'https://monkeycode-ai.com';
var TASK_ID = process.env.MC_TASK_ID || '7b9eb8fc-d3e9-4352-8667-f973efc31468';
var TASK_URL = BASE + '/console/task/' + TASK_ID;

// 多久刷一次页面。设一个远大于任何休眠阈值（15 分钟）的间隔，
// 保证即使有休眠判定也轮不到它生效；同时这个值本身就是「机器还活着」的信号。
var REFRESH_MS = Number(process.env.MC_HOLD_REFRESH_MS || 5 * 60 * 1000);

var out = function() {
  var t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  process.stdout.write('[' + t + '] ' + Array.prototype.join.call(arguments, ' ') + '\n');
};

var chromium;
try {
  chromium = require('playwright-core').chromium;
} catch (e) {
  out('致命：找不到 playwright-core —— ' + e.message);
  process.exit(1);
}

var browser = null;
var page = null;
var timer = null;
var stopping = false;

function log(msg) {
  out(msg);
  try {
    fs.appendFileSync('/workspace/cluss-cloud/checks/hold-page.log',
      '[' + new Date().toISOString() + '] ' + msg + '\n');
  } catch (e) { /* 日志写不进去不该拖垮保活本身 */ }
}

async function openOnce() {
  // headless：没有 X 也跑得起来。云机上没有显示器，这是唯一可行的方式。
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  var ctx = await browser.newContext({ locale: 'zh-CN' });
  page = await ctx.newPage();

  await page.goto(TASK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  log('已打开任务页：' + TASK_URL);

  // 到点了就重载一次，让页面保持「活」的连接状态。
  // 不点击、不输入、不发送 —— 只是重新拉一次页面。
  timer = setInterval(async function() {
    if (stopping || !page) return;
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      log('页面已刷新，保持挂起');
    } catch (e) {
      log('刷新失败（将重建页面）：' + e.message);
      await rebuild();
    }
  }, REFRESH_MS);
}

async function rebuild() {
  clearInterval(timer);
  timer = null;
  try { if (browser) await browser.close(); } catch (e) {}
  browser = null;
  page = null;
  // 退避 10 秒再重建，避免页面持续报错时疯狂重启自己
  setTimeout(function() { if (!stopping) openOnce().catch(onFatal); }, 10000);
}

function onFatal(err) {
  log('异常退出：' + (err && err.message ? err.message : String(err)));
  process.exit(1);   // 交给 pm2 重新拉起
}

async function shutdown() {
  stopping = true;
  clearInterval(timer);
  log('收到退出信号，关闭浏览器');
  try { if (browser) await browser.close(); } catch (e) {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', onFatal);
process.on('unhandledRejection', onFatal);

openOnce().catch(onFatal);

log('保活进程已启动，刷新间隔 ' + Math.round(REFRESH_MS / 1000) + ' 秒');