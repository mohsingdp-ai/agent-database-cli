# AI Installation Guide

When using this tool, first install the CLI and skill by following the steps below.

## 1. Install the CLI

```bash
npm install -g agent-database-cli
agent-database-cli --help
```

If installing the npm package is restricted, use the equivalent source-based installation:

```powershell
git clone https://github.com/sleepinginsummer/agent-database-cli.git
cd agent-database-cli
npm install
npm run build
npm link
agent-database-cli --help
```

If `agent-database-cli --help` fails, first check:

```bash
node --version
npm --version
```

Requires Node.js `>= 20` and npm `>= 10`. The current prebuilt binaries support macOS x64/arm64, Linux x64/arm64, and Windows x64.

## 2. Initialize the Configuration Directory

```bash
mkdir -p ~/.agent-database-cli
```

Then create and edit:

```text
~/.agent-database-cli/config.json
```

For the configuration content, refer to `https://github.com/sleepinginsummer/agent-database-cli/blob/main/config/docker-test.json` in the project. The configuration file stores real database connection information, so do not make it public. You can ask the user how to configure the database connections, or tell the user where the configuration directory is.

## 3. Install the Skill

`agent-database-cli install-skill` uses the `skills/agent-database-cli` bundled in the CLI package as the source. Show the actual plan first, then install after confirmation:

```bash
agent-database-cli install-skill --dry-run
agent-database-cli install-skill
```

To skip the interactive confirmation, use:

```bash
agent-database-cli install-skill --yes
```

The main installation directory is `~/.agents/skills/agent-database-cli`. Symlinks are created in the existing skill parent directories for Codex, Claude, Kimi CLI, Cursor, Gemini, and others; existing targets that are not symlinks will not be overwritten.

## 4. Update

```bash
npm install -g agent-database-cli@latest
```
## 5. Verification Test
After configuration is complete, run a test:

```bash
agent-database-cli list
agent-database-cli test --db <databaseName>
```

Once you have the database configuration name, run `exec`, `meta`, or `reset`.
