#!/usr/bin/env node
// ============================================================
// 每日巡检（浏览器版）：真实 chromium 打开任务页发送运维检查指令。
// 背景与致平台说明：/workspace/cluss-cloud/NOTICE.md（务必先读）。
//
// 相比 daily-check.js（WS + Cookie）的差异：
//   · 真实浏览器环境，与人工操作一致；
//   · 会话失效时用凭据文件里的账号密码自动重新登录，无需人工补登。
//
// 凭据 /root/.clusscloud-check.json（0600）：{ "email": "...", "password": "..." }
// 会话状态：/root/.clusscloud-browser-state.json（playwright storageState，自动续存）
// 留档：/workspace/cluss-cloud/checks/browser-<stamp>.log
// ============================================================
'use strict';

var fs = require('fs');
var path = require('path');
var { chromium } = require('playwright-core');

var BASE = 'https://monkeycode-ai.com';
var TASK_URL = BASE + '/console/task/7b9eb8fc-d3e9-4352-8667-f973efc31468';
var CREDS_PATH = '/root/.clusscloud-check.json';
var STATE_PATH = '/root/.clusscloud-browser-state.json';
var CHECKS_DIR = '/workspace/cluss-cloud/checks';

// 巡检内容轮换表（与 daily-check.js 保持一致语义）
var PROMPTS = [
  '在 /workspace/cluss-cloud 目录跑一遍 npm run verify（自验证脚本，约 1 分钟），把通过/失败情况汇总给我，不要改动任何代码。',
  '查看 /workspace/cluss-cloud 的 git status 和最近 3 条提交，确认部署的代码版本，只读汇报。',
  'tail 一下 pm2 里 clusscloud 的最近日志，汇总有没有异常报错，只读汇报。',
  '看一下磁盘使用率和 node_modules 体积，评估是否需要清理依赖缓存，只读汇报。',
  '检查 /workspace/cluss-cloud-backups 目录最近的快照时间戳和份数，确认备份机制正常，只读汇报。',
  '在 /workspace/cluss-cloud 跑 node scripts/verify.cjs（只跑自验证），汇报结果，不要改动代码。',
  '汇报 uptime、内存占用和 10003 端口监听情况，确认服务健康，只读汇报。'
];

function fail(msg) { console.error('[keepalive-browser] ' + msg); process.exit(1); }
function stamp() { return new Date().toISOString().replace(/[T:]/g, '-').replace(/\..*/, '').slice(0, 16); }

// 登录页 → 账号密码表单 → 提交；成功 = URL 离开 /login
// 表单结构（zh-CN 实测）：button「账号密码登录」→ input[type=email] + input[type=password] + button[type=submit]
async function doLogin(page, creds) {
  console.log('[keepalive-browser] 会话失效，账号密码重登…');
  await page.locator('button:has-text("账号密码登录")').click();
  var email = page.locator('input[type=email]');
  await email.waitFor({ timeout: 20000 });
  await email.fill(creds.email);
  await page.locator('input[type=password]').fill(creds.password);
  await page.locator('button[type=submit]').click();
  await page.waitForURL(/console/, { timeout: 30000 }).catch(function() {});
  if (page.url().indexOf('/login') >= 0) fail('自动登录未通过（凭据或风控），URL=' + page.url());
  console.log('[keepalive-browser] 重新登录成功');
}

// 关掉「订阅重要通知」等一次性弹窗（新设备首次访问会弹）
async function closeNagDialogs(page) {
  try {
    var marker = page.locator(':text("订阅重要通知")');
    if (!(await marker.count())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    if (!(await marker.count())) return;
    // 点弹窗容器里的第一个按钮（右上角 ×）
    var dlg = page.locator('div:has-text("订阅重要通知")').last();
    await dlg.locator('button').first().click({ force: true }).catch(function() {});
    await page.waitForTimeout(600);
    if (!(await marker.count())) return;
    // 终极手段：把弹层 DOM 直接摘掉
    await page.evaluate(function() {
      var nodes = document.querySelectorAll('body *');
      nodes.forEach(function(e) {
        if (e.children.length === 0 && /订阅重要通知/.test(e.textContent || '')) {
          var p = e;
          for (var i = 0; i < 10 && p.parentElement && p.parentElement !== document.body; i++) p = p.parentElement;
          if (p !== document.body) p.remove();
        }
      });
    });
    await page.waitForTimeout(400);
  } catch (e) { /* 尽力而为 */ }
}

(async function main() {
  if (!fs.existsSync(CREDS_PATH)) fail('缺少凭据文件 ' + CREDS_PATH);
  var creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  if (!creds.email || !creds.password) fail('凭据文件缺少 email/password');

  var prompt = PROMPTS[Math.floor(Date.now() / 86400000) % PROMPTS.length];

  (async function() {
    var browser = await chromium.launch({ headless: true });
    var context = await browser.newContext({
      locale: 'zh-CN', // headless 默认 en-US 会渲染出英文界面，选择器全失配
      storageState: fs.existsSync(STATE_PATH) ? STATE_PATH : undefined,
      viewport: { width: 1024, height: 640 }
    });
    var page = await context.newPage();
    var logged = 'cookie';

    console.log('[keepalive-browser] 打开任务页…');
    await page.goto(TASK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // 循环确认：任务页就绪（输入框可见）为止；期间处理跳转登录、自动重登与一次性弹窗
    var ready = false;
    for (var attempt = 0; attempt < 6 && !ready; attempt++) {
      await page.waitForTimeout(2500);
      if (page.url().indexOf('/login') >= 0) {
        await doLogin(page, creds);
        logged = 'password';
        await page.goto(TASK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        continue;
      }
      await closeNagDialogs(page);
      ready = await page.getByRole('textbox', { name: /描述你的需求/ })
        .waitFor({ timeout: 6000 }).then(function() { return true; }).catch(function() { return false; });
      if (!ready && page.url().indexOf('/login') >= 0) attempt--; // 又被踢回登录页，重走登录
    }
    if (!ready) {
      // 失败留证：截图到 checks/，排障用
      var shot = path.join(CHECKS_DIR, 'fail-' + stamp() + '.png');
      fs.mkdirSync(CHECKS_DIR, { recursive: true });
      await page.screenshot({ path: shot }).catch(function() {});
      fail('任务页始终未就绪（最终 URL=' + page.url() + '，截图 ' + shot + '）');
    }

    // 发送巡检指令
    var box = page.getByRole('textbox', { name: /描述你的需求/ });
    await box.fill(prompt);
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '发送' }).click();
    await page.waitForTimeout(8000);

    var boxValue = await box.inputValue().catch(function() { return 'gone'; });
    // 发送成功的两种表现：输入框清空；或任务进入运行态（运行中输入框会保留文字并排队）
    var running = await page.locator(':text("任务正在执行"), :text("任务执行中")')
      .first().isVisible().catch(function() { return false; });
    var sent = boxValue === '' || running;
    var file = path.join(CHECKS_DIR, 'browser-' + stamp() + '.log');
    fs.mkdirSync(CHECKS_DIR, { recursive: true });
    fs.writeFileSync(file, 'prompt: ' + prompt + '\nlogin: ' + logged + '\nsent: ' + sent + '\nurl: ' + page.url() + '\n');
    await page.screenshot({ path: path.join(CHECKS_DIR, 'after-send-' + stamp() + '.png') }).catch(function() {});

    await context.storageState({ path: STATE_PATH });
    await browser.close();
    console.log('[keepalive-browser] 完成（sent=' + sent + '，login=' + logged + '）→ ' + file);
    process.exit(sent ? 0 : 2);
  })().catch(function(err) {
    console.error('[keepalive-browser] 失败: ' + (err && err.message));
    process.exit(1);
  });
})();
