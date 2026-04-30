<div align="center">

# database-cli

A CLI-based multi-database tool that exposes database connections, query execution, metadata inspection, and connection reuse as local commands callable by agents.

MySQL · PostgreSQL · Redis · Oracle · MongoDB · Read-only mode · Command blocklist · SQLcl Oracle · Local daemon

<p>
  <img src="https://img.shields.io/badge/CLI-database--cli-2ea44f" alt="CLI database-cli">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License MIT">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node.js >=20">
  <img src="https://img.shields.io/badge/npm-%3E%3D10-CB3837?logo=npm&logoColor=white" alt="npm >=10">
  <img src="https://img.shields.io/badge/release-v0.1.0-blue" alt="release v0.1.0">
</p>

[Installation](#installation) · [Configuration](#configuration) · [Commands](#commands) · [Oracle SQLcl](#oracle-sqlcl) · [Docker Tests](#docker-tests) · [License](#license)

[中文](README.md) | English

</div>

## Introduction

`database-cli` references the database adapter, config loading, safety checking, and connection management layers from [Anarkh-Lee/universal-db-mcp](https://github.com/Anarkh-Lee/universal-db-mcp), but rewrites them as a standalone CLI. It does not include MCP, HTTP, or SSE services.

What it can do:

- List currently supported database types and locally configured connections
- Execute SQL, Redis commands, or MongoDB JSON commands against a configured database
- Inspect database metadata such as tables, columns, collections, and Redis keys
- Enable read-only mode and command blocklists per database configuration
- Auto-start the local daemon on demand; the daemon exits after `300` idle seconds by default
- Keep connections through the local daemon; each database connection is released after `180` idle seconds by default
- Switch Oracle between `oracledb` and SQLcl connection modes

What it does not do:

- It does not store or print unmasked passwords, tokens, or secrets

Driver configuration table:

| Database | `type` | Default driver | Driver switch configuration | Common configuration |
| --- | --- | --- | --- | --- |
| MySQL | `mysql` | npm package `mysql2` | Not switchable yet | `readonly`, `blacklist`, `keepAliveSeconds` |
| PostgreSQL | `postgres` | npm package `pg` | Not switchable yet | `readonly`, `blacklist`, `keepAliveSeconds` |
| Redis | `redis` | npm package `redis` | Not switchable yet | `readonly`, `blacklist`, `keepAliveSeconds` |
| Oracle | `oracle` | npm package `oracledb` | `oracleDriver: "oracledb" \| "sqlcl"`; SQLcl mode can set `sqlclPath` and `javaHome` | `readonly`, `blacklist`, `keepAliveSeconds` |
| MongoDB | `mongodb` | npm package `mongodb` | Not switchable yet; `database` can set the default database | `readonly`, `blacklist`, `keepAliveSeconds` |

## Installation

### Requirements

- Node.js `>= 20`
- npm `>= 10`
- Local network access to target databases
- Docker and Docker Compose for integration tests
- SQLcl and Java if Oracle uses SQLcl

### Global Installation

```bash
npm install -g github:sleepinginsummer/database-cli
database-cli --help
```

When installed from GitHub, `prepare` runs automatically and builds `dist`.

### Local Development

```bash
git clone https://github.com/sleepinginsummer/database-cli.git
cd database-cli
npm install
npm run build
node dist/cli.js --help
```

Development mode:

```bash
npm run dev -- --help
```

## Configuration

Default configuration file:

```text
~/.database-cli/config.json
```

Override the configuration path with an environment variable:

```bash
DATABASE_CLI_CONFIG=/path/to/config.json database-cli list
```

The configuration file is an object. Each key under `databases` is a database connection name:

- `type`: Database type. Supported values are `mysql`, `postgres`, `redis`, `oracle`, and `mongodb`
- `url`: Database connection URL
- `database`: Default MongoDB database name, optional
- `readonly`: Whether read-only mode is enabled
- `blacklist`: Command blocklist array, case-insensitive
- `keepAliveSeconds`: Per-database connection idle timeout in seconds, defaults to `180`
- `oracleDriver`: Oracle driver, either `oracledb` or `sqlcl`
- `sqlclPath`: SQLcl executable path, used only when `oracleDriver` is `sqlcl`
- `javaHome`: `JAVA_HOME` used by SQLcl, optional

The blocklist is checked before read-only mode. If a command matches the blocklist, it is rejected immediately; otherwise the read-only check is applied.

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

## Commands

### list

List supported database types, configured connections, and the configuration file path.

```bash
database-cli list
database-cli --format table list
```

### test

Test a configured database connection.

```bash
database-cli test --db local-mysql
```

### exec

Execute SQL, Redis commands, or MongoDB JSON commands through one unified command.

```bash
database-cli exec --db local-mysql --command "select 1"
database-cli exec --db cache --command "GET user:1"
database-cli exec --db local-mongodb --command '{"find":{"collection":"users","filter":{},"limit":1}}'
```

### meta

Inspect database metadata.

```bash
database-cli meta --db local-mysql --type tables
database-cli meta --db local-mysql --type columns --table users
database-cli meta --db local-mongodb --type collections
database-cli meta --db cache --type keys --pattern "user:*"
```

### daemon

Start, stop, or inspect the local connection daemon. Regular `test`, `exec`, `meta`, and `reset` commands automatically start the daemon when it is not running, and reuse it when it is already running. The daemon uses a local Unix socket, does not expose any network port, and exits after `300` idle seconds by default.

```bash
database-cli daemon start
database-cli daemon status
database-cli daemon stop
```

### reset

Reset a configured database connection. If the daemon is running, the connection is disconnected and removed; the next command reconnects.

```bash
database-cli reset --db local-mysql
```

## Oracle SQLcl

Oracle uses the npm package `oracledb` by default. Older Oracle servers may fail in Thin mode with errors such as `NJS-138`. In that case, switch that Oracle connection to SQLcl:

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

SQLcl mode sends the connection script through stdin so the password does not appear in process arguments. Safety checks still run before execution, including blocklist and read-only mode.

## Docker Tests

This project includes local test database configuration:

```bash
docker compose up -d mysql postgres redis mongodb
DATABASE_CLI_CONFIG=config/docker-test.json npm run dev -- test --db local-mysql
npm run test:integration
```

Oracle integration tests are run separately:

```bash
docker compose up -d oracle
npm run test:integration:oracle
```

Test commands:

```bash
npm run build
npm run test:unit
npm run test:integration
```

## Uninstall and Cleanup

```bash
npm uninstall -g database-cli
npm cache clean --force
rm -rf ~/.database-cli
docker compose down
```

## License

[MIT](LICENSE)
