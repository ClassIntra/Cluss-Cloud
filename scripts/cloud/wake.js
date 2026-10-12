#!/usr/bin/env node
// ============================================================
// 叫醒开发机（本地 Windows / Git Bash 跑）
//
// 为什么需要它：MonkeyCode 开发机**空闲 15 分钟就挂起**，机器睡着时
// 部署在上面的 Cluss-Cloud 会跟着不可达。而「保活脚本」本身是机器上的
// 定时任务 —— 机器睡着时它根本不会跑。鸡生蛋问题只能从外面打破：
// 在平台任务页发一条消息，机器被唤醒，服务跟着活过来。
//
// 所以这不是「保活」，是「复苏」：醒了以后该干的事（补部署、拉备份、
// 确认配置）由 deploy.sh / keepalive.sh 接手。
//
// 用法（凭据只从环境变量读，不落盘）：
//   MC_EMAIL=你的邮箱 MC_PASSWORD=你的密码 node scripts/cloud/wake.js
// 可选：
//   MC_PROMPT="你的问题"     覆盖默认指令（默认发一条纯知识问答）
//   MC_TASK_URL=...          换任务页
//   MC_SHOT_DIR=...          截图目录（排障用）
// ============================================================
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var { chromium } = require('playwright');

var BASE = 'https://monkeycode-ai.com';
var TASK_URL = process.env.MC_TASK_URL || (BASE + '/console/task/7b9eb8fc-d3e9-4352-8667-f973efc31468');
var STATE_PATH = path.join(os.homedir(), '.clusscloud-browser-state.json');
var SHOT_DIR = process.env.MC_SHOT_DIR || path.join(__dirname, '..', '..', 'backups', 'cloud', 'shots');

// 默认发纯知识问答：agent 用自己的知识回答，不碰工作区，
// 也就没有任何「可发现的东西」（背景见 /workspace/cluss-cloud/NOTICE.md）
var DEFAULT_PROMPT = '用三句话解释一下什么是幂等性？直接回答即可，不用看文件。';

function fail(msg) { console.error('[wake] ' + msg); process.exit(1); }
function stamp() { return new Date().toISOString().replace(/[T:]/g, '-').replace(/\..*/, '').slice(0, 16); }

// playwright 自带的浏览器版本可能和本机已下载的对不上（版本漂移）。
// 与其重新下载一百多兆，不如就地找已装的 chromium —— 找不到再报错。
function resolveExecutable() {
  try {
    var p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* 继续找 */ }
  var root = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!fs.existsSync(root)) return null;
  var dirs = fs.readdirSync(root).filter(function(d) { return /^chromium-\d+$/.test(d); }).sort().reverse();
  for (var i = 0; i < dirs.length; i++) {
    var exe = path.join(root, dirs[i], 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

async function doLogin(page, email, password) {
  console.log('[wake] 会话失效，账号密码重登…');
  await page.locator('button:has-text("账号密码登录")').click();
  var mail = page.locator('input[type=email]');
  await mail.waitFor({ timeout: 20000 });
  await mail.fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.locator('button[type=submit]').click();
  await page.waitForURL(/console/, { timeout: 30000 }).catch(function() {});
  if (page.url().indexOf('/login') >= 0) fail('自动登录未通过（凭据或风控），URL=' + page.url());
  console.log('[wake] 重新登录成功');
}

// 「订阅重要通知」等一次性弹窗（新设备/新会话会弹），挡住输入框就得先关掉
async function closeNagDialogs(page) {
  try {
    var marker = page.locator(':text("订阅重要通知")');
    if (!(await marker.count())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    if (!(await marker.count())) return;
    await page.locator('div:has-text("订阅重要通知")').last()
      .locator('button').first().click({ force: true }).catch(function() {});
    await page.waitForTimeout(600);
    if (!(await marker.count())) return;
    await page.evaluate(function() {
      document.querySelectorAll('body *').forEach(function(e) {
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
  var email = String(process.env.MC_EMAIL || '').trim();
  var password = String(process.env.MC_PASSWORD || '');
  if (!email || !password) {
    fail('请通过环境变量提供凭据：MC_EMAIL=... MC_PASSWORD=...（脚本不落盘凭据）');
  }
  var prompt = process.env.MC_PROMPT || DEFAULT_PROMPT;
  var exe = resolveExecutable();
  if (!exe) fail('本机没有可用的 chromium（playwright browsers 未安装）');
  console.log('[wake] chromium: ' + exe);
  console.log('[wake] 指令: ' + prompt);

  fs.mkdirSync(SHOT_DIR, { recursive: true });
  var browser = await chromium.launch({ headless: true, executablePath: exe });
  var context = await browser.newContext({
    locale: 'zh-CN', // 无头浏览器默认 en-US，会渲染出英文界面导致选择器全部失配
    storageState: fs.existsSync(STATE_PATH) ? STATE_PATH : undefined,
    viewport: { width: 1024, height: 640 }
  });
  var page = await context.newPage();
  var logged = 'cookie';

  try {
    console.log('[wake] 打开任务页…');
    await page.goto(TASK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

    var ready = false;
    for (var attempt = 0; attempt < 6 && !ready; attempt++) {
      await page.waitForTimeout(2500);
      if (page.url().indexOf('/login') >= 0) {
        await doLogin(page, email, password);
        logged = 'password';
        await page.goto(TASK_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        continue;
      }
      await closeNagDialogs(page);
      ready = await page.getByRole('textbox', { name: /描述你的需求/ })
        .waitFor({ timeout: 6000 }).then(function() { return true; }).catch(function() { return false; });
    }
    if (!ready) {
      await page.screenshot({ path: path.join(SHOT_DIR, 'wake-fail-' + stamp() + '.png') }).catch(function() {});
      fail('任务页始终未就绪（URL=' + page.url() + '），截图见 ' + SHOT_DIR);
    }

    var box = page.getByRole('textbox', { name: /描述你的需求/ });
    await box.fill(prompt);
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '发送' }).click();
    await page.waitForTimeout(8000);

    var boxValue = await box.inputValue().catch(function() { return 'gone'; });
    // 发送成功的两种表现：输入框清空；或任务进入运行态（运行中输入框保留文字并排队）
    var running = await page.locator(':text("任务正在执行"), :text("任务执行中")')
      .first().isVisible().catch(function() { return false; });
    var sent = boxValue === '' || running;

    await page.screenshot({ path: path.join(SHOT_DIR, 'wake-' + stamp() + '.png') }).catch(function() {});
    await context.storageState({ path: STATE_PATH });
    await browser.close();
    console.log('[wake] 已发送（sent=' + sent + '，login=' + logged + '）。机器通常几十秒内恢复可达。');
    process.exit(sent ? 0 : 2);
  } catch (err) {
    console.error('[wake] 失败: ' + (err && err.message));
    await page.screenshot({ path: path.join(SHOT_DIR, 'wake-err-' + stamp() + '.png') }).catch(function() {});
    await browser.close();
    process.exit(1);
  }
})();