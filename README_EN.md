<div align="center">

# database-cli

A CLI-based multi-database tool that packages common database connection, query, metadata inspection, and connection reuse capabilities as local commands callable by agents.

MySQL · PostgreSQL · Redis · Oracle · MongoDB · Read-only mode · Command blocklist · SQLcl Oracle · Local daemon

<p>
  <img src="https://img.shields.io/badge/CLI-database--cli-2ea44f" alt="CLI database-cli">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License MIT">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node.js >=20">
  <img src="https://img.shields.io/badge/npm-%3E%3D10-CB3837?logo=npm&logoColor=white" alt="npm >=10">
  <img src="https://img.shields.io/badge/Windows-MacOS-0078D6?labelColor=0078D6&color=C0C0C0" alt="Windows/MacOS">
  <img src="https://img.shields.io/badge/release-v0.2.2-blue" alt="release v0.2.2">
</p>

[AI One-Click Installation](#ai-one-click-installation) · [Installation](#installation) · [Configuration](#configuration) · [Permission Configuration](#permission-configuration) · [Oracle SQLcl](#oracle-sqlcl) · [License](#license) · [Friendly Links](#friendly-links)

[中文](README.md) | English

</div>

## Introduction

`database-cli` references the database adapter, config loading, safety checking, and connection management layering of [Anarkh-Lee/universal-db-mcp](https://github.com/Anarkh-Lee/universal-db-mcp), then rewrites it into a standalone CLI form without MCP, HTTP, or SSE services.

What it can do:

- List currently supported database types and locally configured connections
- Execute SQL, Redis commands, or MongoDB JSON commands against a specified database
- Query database metadata such as tables, columns, collections, and Redis keys
- Enable read-only mode and command blocklists per database configuration
- Auto-start the local daemon on demand; the daemon exits after `300` idle seconds by default
- Keep connections alive through the local daemon; each database connection is released after `180` idle seconds by default
- Switch Oracle between `oracledb` and SQLcl drivers
- Never store or print unmasked passwords, tokens, or secrets
- Use named pipes on Windows and Unix sockets on macOS/Linux for the daemon

Driver configuration table:

| Database | `type` | Default driver | Driver switch configuration | Common configuration |
| --- | --- | --- | --- | --- |
| MySQL | `mysql` | npm package `mysql2` | Not switchable yet | `readonly`, `blacklist`, `keepAliveSeconds` |
| PostgreSQL | `postgres` | npm package `pg` | Not switchable yet | `readonly`, `blacklist`, `keepAliveSeconds` |
| Redis | `redis` | npm package `redis` | Not switchable yet | `readonly`, `blacklist`, `keepAliveSeconds` |
| Oracle | `oracle` | npm package `oracledb` | `oracleDriver: "oracledb" \| "sqlcl"`; SQLcl mode can configure `sqlclPath` and `javaHome`. SQLcl is recommended for older Oracle versions | `readonly`, `blacklist`, `keepAliveSeconds` |
| MongoDB | `mongodb` | npm package `mongodb` | Not switchable yet; `database` can be configured as the default database | `readonly`, `blacklist`, `keepAliveSeconds` |

## Installation

### Requirements

- Node.js `>= 20`
- npm `>= 10`
- Local network access to the target database
- Docker and Docker Compose if you run integration tests
- SQLcl and Java installed locally if Oracle uses SQLcl

### AI One-Click Installation

```text
Please read https://github.com/sleepinginsummer/database-cli/blob/main/AI_INSTALL.md, install the CLI as instructed, and add `SKILL.md`.
```

### Manual Global Installation

```bash
npm install -g @sleepinsummer/database-cli
database-cli --help
```

If npm package installation is restricted, use the equivalent source installation flow:

```powershell
git clone https://github.com/sleepinginsummer/database-cli.git
cd database-cli
npm install
npm run build
npm link
database-cli --help
```

Add `SKILL.md` to the agent that needs to use this tool.

## Configuration

Default configuration file:

```text
~/.database-cli/config.json
```

You can override the configuration path with an environment variable:

```bash
DATABASE_CLI_CONFIG=/path/to/config.json database-cli list
```

The configuration file is an object. Each key under `databases` is a database connection name:

- `type`: Database type, supports `mysql`, `postgres`, `redis`, `oracle`, and `mongodb`
- `url`: Database connection URL
- `sshTunnel`: Optional SSH tunnel configuration. When enabled, the database URL host and port are reached through SSH forwarding
- `database`: Optional default MongoDB database name
- `readonly`: Whether read-only mode is enabled, default `true`; only explicitly set `false` when write access is really required
- `blacklist`: Command blocklist array, case-insensitive
- `keepAliveSeconds`: Idle release timeout in seconds for a single database connection, default `180`
- `oracleDriver`: Oracle driver, supports `oracledb` or `sqlcl`
- `sqlclPath`: SQLcl executable path, used only when `oracleDriver` is `sqlcl`
- `javaHome`: Optional `JAVA_HOME` used by SQLcl

`sshTunnel` supports password, private key, password plus private key, and passphrase-protected private key authentication:

- `host`: SSH jump host address
- `port`: SSH port, default `22`
- `username`: SSH username
- `password`: Optional SSH password
- `privateKeyPath`: Optional private key file path, supports `~`
- `privateKey`: Optional private key content, mutually exclusive with `privateKeyPath`
- `passphrase`: Optional private key passphrase, only valid when a private key is configured
- `readyTimeout`: Optional SSH connection timeout in milliseconds

The blocklist and read-only mode work together with a fixed priority: check the blocklist first, reject immediately on match, and only check read-only mode when no blocklist rule matches.

Read-only mode notes:

- Read-only mode is enabled by default; write operations are still rejected when `readonly` is omitted
- It is recommended to keep all database connections read-only by default. When data changes are needed, let AI generate the SQL or command first, then execute it after your confirmation
- Only set `readonly: false` on a specific connection when write access is truly required

Reference configuration:

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
    "remote-mysql": {
      "type": "mysql",
      "url": "mysql://user:password@db.internal:3306/app",
      "sshTunnel": {
        "host": "jump.example.com",
        "port": 22,
        "username": "deploy",
        "privateKeyPath": "~/.ssh/id_rsa",
        "passphrase": "key-passphrase"
      },
      "readonly": true,
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

## Permission Configuration

It is recommended to use both `readonly` and `blacklist` together for permission control. Do not rely on only one of them.

### Read-only Mode

- The default value is `true`
- When `readonly` is omitted, the connection is still treated as read-only
- It is recommended to keep all day-to-day query connections read-only by default
- When data changes are needed, let AI generate the SQL or command first, then execute it after your confirmation
- Only dedicated writable connections should explicitly set `readonly: false`

### Command Blocklist

- The blocklist has higher priority than read-only mode
- A command is rejected immediately once it matches the blocklist
- It is suitable for blocking high-risk commands such as dropping data, schema changes, mass writes, and cache-clearing operations
- It is recommended for production databases, shared test databases, and online Redis instances

### Execution Order

1. Check `blacklist` first
2. Reject immediately on match
3. Check `readonly` only when not matched
4. When `readonly` is enabled, only read commands are allowed

### Common High-Risk Commands

Common high-risk SQL for MySQL / PostgreSQL / Oracle:

```json
["drop", "truncate", "delete", "update", "insert", "merge", "alter", "create", "replace", "grant", "revoke"]
```

Common high-risk Redis commands:

```json
["flushall", "flushdb", "del", "unlink", "set", "mset", "expire", "rename", "hset", "lpush", "rpush", "sadd", "zadd"]
```

Common high-risk MongoDB commands:

```json
["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "findAndModify", "findOneAndUpdate", "findOneAndDelete", "drop", "dropDatabase", "createIndex", "dropIndex"]
```

### Recommended Configuration Examples

Recommended for production databases:

```json
{
  "type": "mysql",
  "url": "mysql://user:password@prod-db:3306/app",
  "readonly": true,
  "blacklist": ["drop", "truncate", "delete", "update", "insert", "alter", "create"],
  "keepAliveSeconds": 180
}
```

Recommended for a dedicated writable connection:

```json
{
  "type": "postgres",
  "url": "postgres://user:password@write-db:5432/app",
  "readonly": false,
  "blacklist": ["drop", "truncate", "alter"],
  "keepAliveSeconds": 180
}
```

## Oracle SQLcl

Official link: https://www.oracle.com/database/sqldeveloper/technologies/sqlcl/

Oracle uses the npm package `oracledb` by default. If the target Oracle version is older, Thin mode compatibility errors such as `NJS-138` may appear. In that case, switch a single Oracle connection to SQLcl:

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

SQLcl mode passes the connection script through stdin to avoid exposing the password in process arguments. Security checks still happen before execution, and both blocklist and read-only mode remain effective.

## Update

```bash
npm install -g @sleepinsummer/database-cli@latest
```

## Uninstall and Cleanup

Update the locally installed global package:

```bash
npm install -g @sleepinsummer/database-cli@latest
```

Uninstall and clean local configuration:

```bash
npm uninstall -g @sleepinsummer/database-cli
npm cache clean --force
rm -rf ~/.database-cli
```

## License

[MIT](LICENSE)

## Friendly Links

- [LINUX DO - A New Ideal Community](https://linux.do/)
