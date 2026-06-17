# Benchmark + correctness gate for the agent-database-cli launch path.
#
# Each command opens a direct connection (there is no daemon), so this measures:
#   * exec  -- one-off latency: process spawn + fresh DB connection + query
#   * repl  -- marginal per-statement latency over a single reused connection
#     (isolated from the one-time setup by comparing two batch sizes)
# It also verifies list/exec/meta still return correct output through the binary.
#
# Usage:
#   pwsh scripts/bench-launch.ps1 -Bin <path-to-exe-or-js-launcher> [-Conn <name>] [-Iter 20]
#
# -Bin may be a native .exe or "node <path>/agent-database-cli.js" style launcher.
param(
  [Parameter(Mandatory = $true)][string]$Bin,
  [string]$Conn = "minted-edge-samad",
  [int]$Iter = 20
)

# Resolve invocation: allow "node path/to.js" by splitting on first space.
function Invoke-Cli {
  param([string[]]$CliArgs)
  if ($Bin -like "node *") {
    $js = $Bin.Substring(5)
    return & node $js @CliArgs 2>&1
  }
  return & $Bin @CliArgs 2>&1
}

Write-Host "== binary: $Bin =="

# Warm up the OS file cache and the DB so the first sample isn't an outlier.
Invoke-Cli @("exec", "--db", $Conn, "--command", "select 1") | Out-Null

# --- Correctness gate ---
$ok = $true
$list = (Invoke-Cli @("list")) -join "`n"
if ($list -notmatch [regex]::Escape($Conn)) { Write-Host "FAIL: list missing $Conn"; $ok = $false }
$exec = (Invoke-Cli @("exec", "--db", $Conn, "--command", "select 1 as n")) -join "`n"
if ($exec -notmatch '"rowCount"\s*:\s*1') { Write-Host "FAIL: exec rowCount != 1"; $ok = $false }
$meta = (Invoke-Cli @("meta", "--db", $Conn, "--type", "tables")) -join "`n"
if ($meta -notmatch '"rows"') { Write-Host "FAIL: meta returned no rows array"; $ok = $false }
Write-Host ("correctness: {0}" -f ($(if ($ok) { "PASS" } else { "FAIL" })))

# --- exec one-off latency (full process + fresh connection each call) ---
$samples = @()
for ($i = 0; $i -lt $Iter; $i++) {
  $t = Measure-Command { Invoke-Cli @("exec", "--db", $Conn, "--command", "select 1") | Out-Null }
  $samples += [math]::Round($t.TotalMilliseconds)
}
$sorted = $samples | Sort-Object
$median = $sorted[[int]([math]::Floor($sorted.Count / 2))]
Write-Host ("exec one-off ms  min={0} median={1} max={2}  (n={3})" -f $sorted[0], $median, $sorted[-1], $Iter)

# --- repl per-statement latency ---
# Feed a large batch through one process and divide total by N. At this size the
# one-time setup (spawn + connect, ~one exec) amortizes to near zero per
# statement, so total/N is a stable per-statement figure. (Differencing two
# small batches is NOT used: at sub-millisecond/stmt the Measure-Command jitter
# swamps the difference and can even go negative.)
$n = 2000
$lines = (1..$n | ForEach-Object { "select 1" }) -join "`n"
$best = [double]::MaxValue
for ($r = 0; $r -lt 3; $r++) {
  $t = (Measure-Command { $lines | Invoke-Cli @("repl", "--db", $Conn) | Out-Null }).TotalMilliseconds
  if ($t -lt $best) { $best = $t }
}
$perStmt = [math]::Round($best / $n, 3)
Write-Host ("repl per-stmt ms ~={0}  (batch of {1}, incl. amortized setup)" -f $perStmt, $n)

if (-not $ok) { exit 1 }
