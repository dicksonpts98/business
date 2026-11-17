# Registers ALPHA GENESIS to start at logon and restart if it stops, so research and paper trading continue
# without any AI assistant. Run once from PowerShell:   powershell -ExecutionPolicy Bypass -File install-windows-task.ps1
# Remove with:   Unregister-ScheduledTask -TaskName "ALPHA GENESIS" -Confirm:$false
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$root\start.bat`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName "ALPHA GENESIS" -Action $action -Trigger $trigger -Settings $settings -Description "ALPHA GENESIS research and paper-trading service" -Force
Write-Host "Registered. It will start at next logon; start it now with: Start-ScheduledTask -TaskName 'ALPHA GENESIS'"
