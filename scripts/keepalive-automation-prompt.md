# MonkeyCode 保活定时任务（在新 ZCode 对话里让助手执行）

> 背景：MonkeyCode 免费开发机空闲 3 天被回收销毁（源码确证：`vm_idle.sleep_seconds=900` 休眠、
> `vm_idle.recycle_seconds=259200` 回收；回收前检查 VM 绑定的任务，任一任务最近 3 天有
> agent 日志或活动即豁免并重新计时）。给任务对话发一句话 = 续命 3 天。
> 首次已在 2026-10-11 02:17 手动续命一次（下一次回收检查约在 10-14）。

## 新对话里这样说

> 按 D:\NetWork\Integration\Cluss-Cloud\scripts\keepalive-automation-prompt.md 里「定时任务指令」一节，创建每 2 天上午 10 点的定时任务。

## 定时任务指令（助手应把以下内容原样作为 CronCreate 的 prompt）

执行 MonkeyCode 开发机保活（背景：该开发机 3 天无任务活动会被平台回收销毁，规则见记忆 monkeycode-keepalive-rules；给任务对话发一条消息即可续命 3 天）。

步骤：
1. 用 Skill 工具加载 browser-use:control-browser，然后用 mcp__node_repl__js 做：bootstrap（process.env.ZCODE_PLUGIN_ROOT → setupBrowserRuntime）→ agent.browsers.getForUrl("https://monkeycode-ai.com")。
2. 列出 browser.tabs.list()，找 URL 含 monkeycode-ai.com 的标签页；没有就 tabs.new()。
3. tab.goto("https://monkeycode-ai.com/console/task/7b9eb8fc-d3e9-4352-8667-f973efc31468")，waitForLoadState domcontentloaded，等 3 秒。
4. 若 URL 跳到 /login 或页面出现登录表单 → 登录态已失效：不要尝试登录（凭据只有用户有），结束并把「MonkeyCode 登录过期，请在 ZCode 内置浏览器重新登录一次」报告给用户。
5. 定位 role=textbox 且 name 含「描述你的需求」的输入框，fill("例行保活：请只回复 ok，不要执行任何命令或修改任何文件。")，然后点 role=button name=发送（fill 后按钮才启用；若点不动改用 textbox.press("Enter")，再不行用 tab.cua.click 点按钮坐标）。
6. 等 30 秒，domSnapshot 确认 agent 有新回复（出现 ok 或新的时间戳消息块）即成功。
7. 结束时报告一句话结果即可，不要动页面其他内容、不要关闭标签页。

## 参数

- cron：`0 10 */2 * *`（每 2 天上午 10 点，留 1 天余量）+ intervalUnit=daily + interval=2
- title：`每2天MonkeyCode保活`
- 登录态存放在 ZCode 内置浏览器的 profile（2026-10-11 已由用户登录）；平台会话过期时任务会自动报告，用户重新登录一次即可。
