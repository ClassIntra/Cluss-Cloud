# Cluss-Cloud

多班同步管理公共服务。**班级设备上只跑 [Cluss](../Cluss)，云上只跑这个**——
它不是"跑在云上的完整 Cluss"，而是一个只做同步管理的独立轻量服务：

| 职责 | 说明 |
|---|---|
| 学校注册 | 任何 Cluss 部署者注册学校，拿到「学校编号 + 接入密钥」（密钥只显示一次） |
| 节点登记 | 班级节点凭编号+密钥接入，同步时顺路心跳；可备注/吊销/恢复 |
| 策略下发 | 模型与计价配置一处修改，各班 1 分钟内整表收敛（含峰谷、视觉转述） |
| 积分分配 | 学校管理员给本校学号充值（权威账本），节点拉取后本地扣费 |
| 用量对账 | 各班用量明细回传（学号/模型/token/费用/场景），支撑台账与看板 |

**不做的事**：不代理 AI、不存学生内容、没有学生账号。学生的对话、文件、密码
永远只在班级设备上；管理员的日常操作也在设备上进行，这里只解决
「同时管多个班」的策略一致与积分分配。

## 与 Cluss 的关系

- **两个独立实现**：同步协议两仓各一份（本仓 `server.js` ↔ Cluss `server/src/routes/sync.js` + `services/sync.js`），
  改协议时必须逐字段对照对端。与 Cluss-Cloud 对接的 Cluss 侧至少 v0.2.0（带 `CLUSS_ORG_ID` 支持）。
- **Cluss 自身的 relay 模式保留**：校内想自建中继仍可用 Cluss 单机搞定；
  想用公共中枢或对外运营，就部署这个仓。
- 命名沿用 GitHub 组织惯例：产品的衍生/分身 = `产品名-角色`（参照 `ClassIntra-Ops`）。

## 快速开始

```bash
cp .env.example .env   # 至少填 JWT_SECRET 与 ADMIN_PASSWORD
npm install
npm start              # 默认 http://localhost:10003
npm run verify         # 自验证（临时库，不碰真实数据）
```

打开首页：注册学校 → 复制 .env → 填到班级设备 → 登录看板。
**重要**：接入第一个班级前，先用平台运营者账号在「策略下发」里发布模型配置
（整份 JSON 可从任意一台 Cluss relay 的 `/api/sync/model-config` 响应复制）——
节点拉到空配置会把本机模型表清空。

## 班级设备侧的 .env（Cluss）

```ini
CLUSS_MODE=node
CLUSS_INSTANCE_ID=class-01        # 每台设备唯一
CLUSS_RELAY_URL=https://<你的 Cluss-Cloud 地址>
CLUSS_ORG_ID=<学校编号>
CLUSS_SHARED_SECRET=<接入密钥>
```

## 部署（免费/临时容器也适用）

`scripts/cloud/` 四件套：`bootstrap.sh`（幂等引导）、`deploy.sh`（本地推代码+备份拉回）、
`backup-data.sh`（在线备份账本）、`keepalive.sh`（本地定时保活+外备）。
容器随时可能被回收，**账本必须每天外备**——重置后 `deploy.sh --restore-latest deploy` 一条命令带数据复活。

## 数据边界

上云的只有计量数据（学号、用量、费用、班级标识）与分配额度；
聊天内容、云盘文件、学生密码**永不上云**，也不应该有通道。

## 开发机空闲回收与日常巡检

MonkeyCode 对开发机有空闲回收机制（规则可从其开源码 `vm_idle` 配置读出：
空闲 15 分钟休眠挂起、3 天回收；回收前会检查机器上绑定的任务近期是否活跃）。

本机跑着 Cluss-Cloud 服务，配套两个例行任务（pm2 托管）：

- `clusscloud-snap`：每小时对账本做一次本地快照（保留 48 份）；
- `clusscloud-check`：每日一条运维巡检指令（轮换检查服务状态/磁盘/备份/日志），
  agent 在开发机内执行后把结果留档到 `checks/`。

巡检凭据在 `/root/.clusscloud-check.json`（root 0600）。日常运维建议尽量通过
巡检与快照完成，减少对某台管理电脑在线状态的依赖；账本外备仍建议定期执行
`deploy.sh --pull-backup`。
ZCode 内置浏览器登录一次 MonkeyCode）；每日 9 点另有账本外备任务兜底——
即使保活失败被回收，`deploy.sh --restore-latest deploy` 也能 5 分钟带数据复活。
