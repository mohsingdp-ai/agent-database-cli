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

[安装](#安装) · [配置](#配置) · [命令](#命令) · [Oracle SQLcl](#oracle-sqlcl) · [Docker 测试](#docker-测试) · [许可证](#许可证)

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

它不做的事：

- 不保存或输出脱敏前的密码、token、secret

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

### 全局安装

```bash
npm install -g github:sleepinginsummer/database-cli
database-cli --help
```

从 GitHub 安装时会执行 `prepare` 自动构建 `dist`。

### 本地开发

```bash
git clone https://github.com/sleepinginsummer/database-cli.git
cd database-cli
npm install
npm run build
node dist/cli.js --help
```

开发模式：

```bash
npm run dev -- --help
```

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
      "url": "oracle://USER:password@172.16.72.201:1521/qftest201",
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

## 命令

### list

列出支持的数据库类型、已配置连接和配置文件路径。

```bash
database-cli list
database-cli --format table list
```

### test

测试指定数据库连接。

```bash
database-cli test --db local-mysql
```

### exec

统一执行 SQL、Redis 命令或 MongoDB JSON 命令。

```bash
database-cli exec --db local-mysql --command "select 1"
database-cli exec --db cache --command "GET user:1"
database-cli exec --db local-mongodb --command '{"find":{"collection":"users","filter":{},"limit":1}}'
```

### meta

查询数据库元信息。

```bash
database-cli meta --db local-mysql --type tables
database-cli meta --db local-mysql --type columns --table users
database-cli meta --db local-mongodb --type collections
database-cli meta --db cache --type keys --pattern "user:*"
```

### daemon

启动、停止或查看本地连接守护进程。普通 `test`、`exec`、`meta`、`reset` 命令会在 daemon 未运行时自动启动 daemon，已运行时直接复用，不会重复启动。daemon 使用本机 Unix socket，不对外暴露网络端口，默认空闲 `300` 秒后自动退出。

```bash
database-cli daemon start
database-cli daemon status
database-cli daemon stop
```

### reset

重置指定数据库连接。daemon 正在运行时会断开并清理该连接，下次命令重新连接。

```bash
database-cli reset --db local-mysql
```

## Oracle SQLcl

Oracle 默认使用 npm 包 `oracledb`。如果目标 Oracle 版本较老，可能出现 Thin mode 不兼容错误，例如 `NJS-138`。此时可以将单个 Oracle 配置切换为 SQLcl：

```json
{
  "type": "oracle",
  "url": "oracle://USER:password@172.16.72.201:1521/qftest201",
  "oracleDriver": "sqlcl",
  "sqlclPath": "/opt/homebrew/Caskroom/sqlcl/26.1.0.086.1709/sqlcl/bin/sql",
  "javaHome": "/Applications/IntelliJ IDEA Ultimate.app/Contents/jbr/Contents/Home",
  "readonly": true,
  "blacklist": ["drop", "truncate", "delete", "update", "insert", "merge", "alter", "create"]
}
```

SQLcl 模式会通过 stdin 传入连接脚本，避免密码出现在命令行参数列表中。安全检查仍在执行前完成，黑名单和只读模式都会生效。

## Docker 测试

本项目提供本地测试数据库配置：

```bash
docker compose up -d mysql postgres redis mongodb
DATABASE_CLI_CONFIG=config/docker-test.json npm run dev -- test --db local-mysql
npm run test:integration
```

Oracle 集成测试单独执行：

```bash
docker compose up -d oracle
npm run test:integration:oracle
```

测试命令：

```bash
npm run build
npm run test:unit
npm run test:integration
```

## 卸载和清理

```bash
npm uninstall -g database-cli
npm cache clean --force
rm -rf ~/.database-cli
docker compose down
```

## 许可证

[MIT](LICENSE)
