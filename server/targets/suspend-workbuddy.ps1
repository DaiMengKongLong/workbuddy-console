param()
$ErrorActionPreference = "SilentlyContinue"
Add-Type -Namespace WB -Name P -MemberDefinition '
[DllImport("ntdll.dll")] public static extern uint NtSuspendProcess(IntPtr h);
[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool b, uint pid);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);' | Out-Null
# 0x0800 = PROCESS_SUSPEND_RESUME
$procs = Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue
$n = 0
foreach ($p in $procs) {
  $h = [WB.P]::OpenProcess(0x0800, $false, [uint32]$p.Id)
  if ($h -ne [IntPtr]::Zero) {
    [WB.P]::NtSuspendProcess($h) | Out-Null
    [WB.P]::CloseHandle($h) | Out-Null
    $n++
  }
}
Write-Output ("suspended " + $n)
