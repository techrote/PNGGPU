import {execFileSync} from 'node:child_process';
// Read-only Windows System-log check. No registry writes or device operations.
export function driverEventsSince(since) {
  if(process.platform!=='win32')return {supported:false,events:[]};
  const iso=new Date(since).toISOString();
  const command=`$ErrorActionPreference='Stop'; Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Diagnostics/Microsoft.PowerShell.Diagnostics.psd1"; try { $events=@(Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=[DateTime]::Parse('${iso}'); ProviderName=@('nvlddmkm','Display'); Level=@(1,2,3)} -ErrorAction Stop); ConvertTo-Json -InputObject @($events | Select-Object @{N='timeUtc';E={$_.TimeCreated.ToUniversalTime().ToString('o')}},ProviderName,Id,Message) -Compress } catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { '[]' } else { throw } }`;
  const events=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],
    {encoding:'utf8',timeout:10000,windowsHide:true}));
  return {supported:true,events};
}
