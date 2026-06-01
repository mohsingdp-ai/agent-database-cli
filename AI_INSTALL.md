# AI 安装说明

使用本工具时，先按下面步骤安装 CLI 和 skill。

## 1. 安装 CLI

```bash
npm install -g agent-database-cli
agent-database-cli --help
```

如果 npm 包安装受限，使用等价的源码安装方式：

```powershell
git clone https://github.com/sleepinginsummer/agent-database-cli.git
cd agent-database-cli
npm install
npm run build
npm link
agent-database-cli --help
```

如果 `agent-database-cli --help` 失败，先检查：

```bash
node --version
npm --version
```

需要 Node.js `>= 20` 和 npm `>= 10`。当前预编译二进制支持 macOS x64/arm64、Linux x64/arm64、Windows x64。

## 2. 初始化配置目录

```bash
mkdir -p ~/.agent-database-cli
```

然后创建并编辑：

```text
~/.agent-database-cli/config.json
```

配置内容可参考项目中的 `https://github.com/sleepinginsummer/agent-database-cli/blob/main/config/docker-test.json`。配置文件保存真实数据库连接信息，不要公开。可以询问用户如何配置数据库连接，或告知用户配置目录。

## 3. 安装 skill

`agent-database-cli install-skill` 使用 CLI 包内置的 `skills/agent-database-cli` 作为来源。先展示真实计划，确认后再安装：

```bash
agent-database-cli install-skill --dry-run
agent-database-cli install-skill
```

需要跳过交互确认时使用：

```bash
agent-database-cli install-skill --yes
```

主安装目录为 `~/.agents/skills/agent-database-cli`。Codex、Claude、Kimi CLI、Cursor、Gemini 等已存在的 skill 父目录会创建软链接；已存在且不是软链接的目标不会被覆盖。

## 4. 更新

```bash
npm install -g agent-database-cli@latest
```
## 5. 验证测试
配置完成后，测试执行：

```bash
agent-database-cli list
agent-database-cli test --db <databaseName>
```

拿到数据库配置名后，再执行 `exec`、`meta` 或 `reset`。
