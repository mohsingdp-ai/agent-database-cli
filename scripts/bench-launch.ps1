# Benchmark + correctness gate for the agent-database-cli launch path.
# Measures WARM per-call latency (daemon already running, so no cold-spawn hang)
# and verifies list/exec/meta still return correct output through the given binary.
#
# Usage:
#   pwsh scripts/bench-launch.ps1 -Bin <path-to-exe-or-js-launcher> [-Db <name>] [-Iter 12]
#
# -Bin may be a native .exe or "node <path>/agent-database-cli.js" style launcher.
param(
  [Parameter(Mandatory = $true)][string]$Bin,
  [string]$Conn = "minted-edge-samad",
  [int]$Iter = 12
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

# Warm up: ensure daemon + connection are live so we measure steady-state latency.
Invoke-Cli @("test", "--db", $Conn) | Out-Null

# --- Correctness gate ---
$ok = $true
$list = (Invoke-Cli @("list")) -join "`n"
if ($list -notmatch [regex]::Escape($Conn)) { Write-Host "FAIL: list missing $Conn"; $ok = $false }
$exec = (Invoke-Cli @("exec", "--db", $Conn, "--command", "select 1 as n")) -join "`n"
if ($exec -notmatch '"rowCount"\s*:\s*1') { Write-Host "FAIL: exec rowCount != 1"; $ok = $false }
$meta = (Invoke-Cli @("meta", "--db", $Conn, "--type", "tables")) -join "`n"
if ($meta -notmatch '"rows"') { Write-Host "FAIL: meta returned no rows array"; $ok = $false }
Write-Host ("correctness: {0}" -f ($(if ($ok) { "PASS" } else { "FAIL" })))

# --- Warm latency ---
$samples = @()
for ($i = 0; $i -lt $Iter; $i++) {
  $t = Measure-Command { Invoke-Cli @("exec", "--db", $Conn, "--command", "select 1") | Out-Null }
  $samples += [math]::Round($t.TotalMilliseconds)
}
$sorted = $samples | Sort-Object
$median = $sorted[[int]([math]::Floor($sorted.Count / 2))]
Write-Host ("warm exec ms  min={0} median={1} max={2}  (n={3})" -f $sorted[0], $median, $sorted[-1], $Iter)
Write-Host ("samples: {0}" -f ($samples -join ", "))
if (-not $ok) { exit 1 }
