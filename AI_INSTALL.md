# AI 安装说明

使用本工具时，先按下面步骤安装 CLI 和 skill。

## 1. 安装 CLI

```bash
npm install -g @sleepinsummer/database-cli
database-cli --help
```

如果 npm 包安装受限，使用等价的源码安装方式：

```powershell
git clone https://github.com/sleepinginsummer/database-cli.git
cd database-cli
npm install
npm run build
npm link
database-cli --help
```

如果 `database-cli --help` 失败，先检查：

```bash
node --version
npm --version
```

需要 Node.js `>= 20` 和 npm `>= 10`。

## 2. 初始化配置目录

```bash
mkdir -p ~/.database-cli
```

然后创建并编辑：

```text
~/.database-cli/config.json
```

配置内容可参考项目中的 `https://github.com/sleepinginsummer/database-cli/blob/main/config/docker-test.json`。配置文件保存真实数据库连接信息，不要公开。可以询问用户如何配置数据库连接，或告知用户配置目录。

## 3. 安装 skill

将本仓库根目录的 `https://github.com/sleepinginsummer/database-cli/blob/main/SKILL.md` 安装到 agent 的 skills 目录。

Codex 默认目录示例：

```bash
mkdir -p ~/.codex/skills/database-cli
cp SKILL.md ~/.codex/skills/database-cli/SKILL.md
```

如果 AI 使用其它 skills 目录，将 `SKILL.md` 复制到对应的 `database-cli/SKILL.md`。

## 4. 更新

```bash
npm install -g @sleepinsummer/database-cli@latest
```
## 5. 验证测试
配置完成后，测试执行：

```bash
database-cli list
database-cli test --db <databaseName>
```

拿到数据库配置名后，再执行 `exec`、`meta` 或 `reset`。
