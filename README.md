<div align="center">

# database-cli

基于 CLI 的多数据库操作工具，将常见数据库连接、查询、元信息读取和连接复用能力封装为 Agent 可调用的本地命令。

MySQL · PostgreSQL · Redis · Oracle · MongoDB · 只读模式 · 命令黑名单 · SQLcl Oracle · 本地 daemon

<p>
  <img src="https://img.shields.io/badge/CLI-database--cli-2ea44f" alt="CLI database-cli">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License MIT">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node.js >=20">
  <img src="https://img.shields.io/badge/npm-%3E%3D10-CB3837?logo=npm&logoColor=white" alt="npm >=10">
  <img src="https://img.shields.io/badge/release-v0.1.0-blue" alt="release v0.1.0">
</p>

[AI 一键安装](#ai-一键安装) · [安装](#安装) · [配置](#配置) · [Oracle SQLcl](#oracle-sqlcl) · [许可证](#许可证)

中文 | [English](README_EN.md)

</div>

## 简介

`database-cli` 参考 [Anarkh-Lee/universal-db-mcp](https://github.com/Anarkh-Lee/universal-db-mcp) 的数据库适配器、配置加载、安全检查和连接管理分层，改写为独立 CLI 形式，不包含 MCP/HTTP/SSE 服务。

它能做的事：

- 列出当前支持的数据库类型和本地已配置连接
- 对指定数据库执行 SQL、Redis 命令或 MongoDB JSON 命令
- 查询数据库元信息，例如表、列、集合、Redis keys
- 按单个数据库配置启用只读模式和命令黑名单
- CLI 按需自动启动本地 daemon；daemon 默认空闲 `300` 秒后自动退出
- 通过本地 daemon 保持连接，单个数据库连接默认空闲 `180` 秒后释放
- Oracle 可在 `oracledb` 和 SQLcl 两种连接方式之间切换
- 不保存或输出脱敏前的密码、token、secret
- daemon 在 Windows 使用 named pipe，在 macOS/Linux 使用 Unix socket

驱动配置表：

| 数据库 | `type` | 默认驱动 | 驱动切换配置 | 通用配置 |
| --- | --- | --- | --- | --- |
| MySQL | `mysql` | npm 包 `mysql2` | 暂不支持切换 | `readonly`、`blacklist`、`keepAliveSeconds` |
| PostgreSQL | `postgres` | npm 包 `pg` | 暂不支持切换 | `readonly`、`blacklist`、`keepAliveSeconds` |
| Redis | `redis` | npm 包 `redis` | 暂不支持切换 | `readonly`、`blacklist`、`keepAliveSeconds` |
| Oracle | `oracle` | npm 包 `oracledb` | `oracleDriver: "oracledb" \| "sqlcl"`，SQLcl 模式可配 `sqlclPath`、`javaHome` | `readonly`、`blacklist`、`keepAliveSeconds` |
| MongoDB | `mongodb` | npm 包 `mongodb` | 暂不支持切换；可配 `database` 指定默认库 | `readonly`、`blacklist`、`keepAliveSeconds` |

## 安装

### 环境要求

- Node.js `>= 20`
- npm `>= 10`
- 本机网络可访问目标数据库
- 如使用 Docker 集成测试，需要 Docker 和 Docker Compose
- 如 Oracle 使用 SQLcl，需要本机可运行 SQLcl 和 Java

### AI 一键安装

```text
安装请阅读 https://github.com/sleepinginsummer/database-cli/blob/main/AI_INSTALL.md，按说明安装 CLI 并添加 `SKILL.md`。
```

### 手动全局安装

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

添加skiil.md到需要使用的agent中

## 配置

默认配置文件：

```text
~/.database-cli/config.json
```

可以通过环境变量修改配置位置：

```bash
DATABASE_CLI_CONFIG=/path/to/config.json database-cli list
```

配置文件是一个对象，`databases` 中每个 key 是一个数据库连接名：

- `type`: 数据库类型，支持 `mysql`、`postgres`、`redis`、`oracle`、`mongodb`
- `url`: 数据库连接 URL
- `database`: MongoDB 默认数据库名，可选
- `readonly`: 是否启用只读模式
- `blacklist`: 命令黑名单数组，大小写不敏感
- `keepAliveSeconds`: 单个数据库连接空闲释放秒数，默认 `180`
- `oracleDriver`: Oracle 驱动，支持 `oracledb` 或 `sqlcl`
- `sqlclPath`: SQLcl 可执行文件路径，仅 `oracleDriver: "sqlcl"` 时使用
- `javaHome`: SQLcl 使用的 `JAVA_HOME`，可选

黑名单和只读模式兼容，优先级固定为：先检查黑名单，命中直接拒绝；未命中再检查只读模式。

参考配置：

```json
{
  "databases": {
    "local-mysql": {
      "type": "mysql",
      "url": "mysql://user:password@localhost:3306/app",
      "readonly": true,
      "blacklist": ["drop", "truncate", "delete"],
      "keepAliveSeconds": 180
    },
    "cache": {
      "type": "redis",
      "url": "redis://localhost:6379",
      "readonly": false,
      "blacklist": ["flushall", "flushdb"],
      "keepAliveSeconds": 180
    },
    "oracle-test": {
      "type": "oracle",
      "url": "oracle://USER:password@127.0.0.1:1521/qftest201",
      "oracleDriver": "sqlcl",
      "sqlclPath": "/opt/homebrew/Caskroom/sqlcl/26.1.0.086.1709/sqlcl/bin/sql",
      "javaHome": "/Applications/IntelliJ IDEA Ultimate.app/Contents/jbr/Contents/Home",
      "readonly": true,
      "blacklist": ["drop", "truncate", "delete", "update", "insert", "merge", "alter", "create"],
      "keepAliveSeconds": 180
    }
  }
}
```


## Oracle SQLcl

Oracle 默认使用 npm 包 `oracledb`。如果目标 Oracle 版本较老，可能出现 Thin mode 不兼容错误，例如 `NJS-138`。此时可以将单个 Oracle 配置切换为 SQLcl：

```json
{
  "type": "oracle",
  "url": "oracle://USER:password@127.0.0.1:1521/qftest201",
  "oracleDriver": "sqlcl",
  "sqlclPath": "/opt/homebrew/Caskroom/sqlcl/26.1.0.086.1709/sqlcl/bin/sql",
  "javaHome": "/Applications/IntelliJ IDEA Ultimate.app/Contents/jbr/Contents/Home",
  "readonly": true,
  "blacklist": ["drop", "truncate", "delete", "update", "insert", "merge", "alter", "create"]
}
```

SQLcl 模式会通过 stdin 传入连接脚本，避免密码出现在命令行参数列表中。安全检查仍在执行前完成，黑名单和只读模式都会生效。


## 卸载和清理

```bash
npm uninstall -g @sleepinsummer/database-cli
npm cache clean --force
rm -rf ~/.database-cli
docker compose down
```

## 许可证

[MIT](LICENSE)
