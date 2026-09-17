# RVP Industries - Kata Cabin Permanent Services Installer
$taskName = "RVP_Kata_Cabin_Supervisor"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbsPath = Join-Path $scriptDir "start-cabin-services.vbs"
$rootDir = (Resolve-Path "$scriptDir\..").Path

Write-Host "Configuring Kata Cabin Services Task..."

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`"" -WorkingDirectory $rootDir
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 365) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    $registered = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($triggerLogon) -Settings $settings -Description "RVP Industries Kata Cabin Permanent Services Supervisor"
    Write-Host "Task Scheduler task '$taskName' successfully registered!"
} catch {
    Write-Warning "Could not register scheduled task: $($_.Exception.Message)"
}

# Also ensure Windows Startup shortcut exists and points to start-cabin-services.vbs
$startupDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$shortcutPath = Join-Path $startupDir "RVP-CCTV-Bridge.lnk"
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($shortcutPath)
$sc.TargetPath = "wscript.exe"
$sc.Arguments = "`"$vbsPath`""
$sc.WorkingDirectory = $rootDir
$sc.WindowStyle = 7 # Minimized
$sc.Description = "RVP Kata Cabin Services Supervisor"
$sc.Save()

Write-Host "Startup shortcut verified: $shortcutPath"
Write-Host "Installation Complete."
