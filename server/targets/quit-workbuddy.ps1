param([string]$ProcName = "WorkBuddy")
$ErrorActionPreference = "SilentlyContinue"
Add-Type -Namespace WB -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);' | Out-Null
$procs = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Sort-Object StartTime
if (-not $procs) { Write-Output "NO PROC"; exit 0 }
# 最早的进程 = Electron 主进程；其第一个线程 = 主线程（消息循环所在）
$main = $procs[0]
try { $tid = $main.Threads[0].Id } catch { Write-Output "NO THREADS"; exit 1 }
$ok = [WB.Win]::PostThreadMessage([uint32]$tid, 0x0012, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output ("WM_QUIT -> pid=" + $main.Id + " tid=" + $tid + " posted=" + $ok)
