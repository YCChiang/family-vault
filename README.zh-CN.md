# family-vault（中文说明）

一个**零依赖、自托管的家人信息加密库**：身份证号、手机号、车牌、护照、银行卡这类
"绝对不该粘到聊天窗口里"的信息，存成一份 AES-256-GCM 加密文件，用网页自己维护；
再给本机的程序（比如聊天机器人）一个**只读令牌接口**，让它可以"把某人的某项信息发给你"，
而**值不会进入它的上下文和日志**。

完整设计、部署方式见英文 [README.md](README.md) 与 [SECURITY.md](SECURITY.md)。

## 三分钟跑起来

```bash
git clone <本仓库> family-vault && cd family-vault
cp config.example.json config.json     # 需要时改端口/路径
node vault-server.mjs
```

浏览器打开 <http://127.0.0.1:8791/> —— 首次启动自动建一个空库，录入即加密保存。
（需要 Node.js 18+；只有 `keyMode: "dpapi"` 需要 Windows。）

## 安全模型（要点）

* 数据文件用随机 256 位密钥加密；**密钥不在数据文件里**，单独存放。
* Windows 上密钥用 **DPAPI(LocalMachine)** 包裹 → 文件被拷到别的机器也解不开。
* **没有口令、没有账号、没有会话**。网页端唯一的门是**网络准入**：`access.allowCidrs`
  放行、`access.denyIps` 优先拒绝，判定依据是反代给出的真实来源 IP。
* 因此：**只绑 127.0.0.1，前面必须有一个你信得过的代理**（推荐
  `tailscale serve`，只有你自己的设备能进；绝不要开 `tailscale funnel`）。
* 令牌接口（`/api/index`、`/api/lookup`）额外要求 `X-Vault-Token`；网页端接口不需要。
* 任何日志都不记录字段值。

## 查人：姓名或称谓都行

录入时每人有「姓名」和「称谓」两个字段。称谓可以写多个别名（逗号分隔），
例如 `爸爸,父亲`，那么"爸爸""父亲""姓名"三种问法都能命中同一个人。
**两个人共用同一个称谓时接口返回 409 并列出候选，不会替你猜。**

## 不要把数据传上去

这个仓库**只放代码**。`.gitignore` 已排除 `data/`、`config.json`、`*.dat`、`*.key`、
`*.dpapi`、`api-token.txt`、`tmp/` 和日志。上传前跑一次：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-no-data.ps1
```

它会扫描工作区和 git 已跟踪文件，发现数据/密钥/令牌就拒绝通过（退出码 1）。
提示：把真实配置和数据放在仓库**之外**（例如 `%LOCALAPPDATA%\family-vault\`），
用 `VAULT_CONFIG` 环境变量指向它，这样即使误操作也不会被 add 进来。

## 客户端示例

`clients/openclaw/` 里是给聊天机器人用的三个 PowerShell 脚本（列人、解析、发送），
以及"值只发给主人、绝不回显、绝不写记忆"的对接约定。发送脚本本身**没有收件人参数**，
收件人在你自己的 sender 脚本里写死，所以不可能被一句话骗去发给别人。

## 许可证

MIT。
