# Changelog

## 0.2.22

- 新功能：新增 `repl` 子命令，从 stdin 逐行读取 SQL 并复用同一进程与 daemon 连接执行，逐行输出 JSON。进程启动开销只付一次，单条查询稳定在约 0.6–2ms（对比 `exec` 每次新建进程的约 20ms，约 16x）。适合 Agent 连续执行大量查询。
- 性能优化：缓存安全检查的关键字正则。此前 `has_blacklisted_keyword` 每次命令都重新编译正则，只读 SELECT 会对约 16 个写关键字各编译一次，单次 exec 仅正则编译就约 28ms。改为进程级缓存后，daemon 单次往返从约 28.5ms 降到约 0.86ms，进程级 exec 从约 45ms 降到约 20ms。
- 性能优化：移除热路径上的 Node.js 启动开销。安装时通过 `postinstall` 将启动器 shim 改写为直接调用平台原生二进制，纯启动耗时约从 74ms 降到 27ms；`bin/agent-database-cli.js` 作为 `--ignore-scripts` 等场景的回退保留。
- 性能优化：`run_via_daemon` 去掉每次命令前的 `is_daemon_running` 探测，改为直接发送请求、仅在传输失败时启动 daemon 并重试一次；热路径由两次往返降为一次，warm 查询耗时约从 99ms 降到 50ms。
- Bugfix：daemon 启动时与启动器分离（Windows 清除标准句柄继承标志 + `DETACHED_PROCESS`，Unix `setsid`），避免冷启动时调用方在管道读取（如 `out=$(agent-database-cli ...)`）上挂起直到 daemon 空闲退出。

## 0.2.19

- 安全优化：数据库 URL 明文密码、SSH 隧道密码和私钥口令在首次使用连接时自动迁移到本地加密存储，配置文件仅保留 `passwordRef` / `passphraseRef`。
- 兼容性优化：保留明文字段改密入口，重新填写明文密码后下次使用会覆盖旧密文。

## 0.2.18

- Bugfix: `daemon status` 在 daemon 未运行或 Unix socket 残留时返回明确的未运行状态，避免直接暴露 `Connection refused`。

## 0.2.17

- 性能优化：daemon 数据库请求不再持有全局配置锁，改为按数据库连接粒度串行执行；不同数据库的慢查询不会互相阻塞。
- 稳定性优化：daemon 首次初始化同一数据库连接时增加初始化占位，避免并发冷启动重复创建 SSH 隧道和数据库连接。
- 安全优化：Redis keys 元信息查询改用 `SCAN` 分批读取，避免使用阻塞式 `KEYS`；只读模式下 Redis `KEYS` 命令会被拒绝。
- 安全优化：只读模式额外拒绝 PostgreSQL `SELECT INTO`、CTE 后接写操作，以及 MongoDB aggregate `$out` / `$merge` 等具备写入语义的查询。
- 易用性优化：daemon 空响应时返回明确错误信息，避免暴露底层 `EOF while parsing a value`。
- 质量优化：清理 clippy 报出的冗余代码写法，保持 `cargo fmt`、`cargo test`、`cargo clippy --all-targets -- -D warnings` 通过。

## 0.2.16

- Bugfix: 修复 Windows 下 daemon named pipe 客户端和服务端未实现，导致 `test`、`exec`、`meta`、`reset`、`daemon status` 等命令无法正常通过本地 daemon 工作的问题。
