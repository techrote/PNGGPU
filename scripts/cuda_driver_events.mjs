import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execFileAsync=promisify(execFile);
function eventCommand(since) {
  const iso=new Date(since).toISOString();
  return `$ErrorActionPreference='Stop'; Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Diagnostics/Microsoft.PowerShell.Diagnostics.psd1"; try { $events=@(Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=[DateTime]::Parse('${iso}'); ProviderName=@('nvlddmkm','Display'); Level=@(1,2,3)} -ErrorAction Stop); ConvertTo-Json -InputObject @($events | Select-Object @{N='timeUtc';E={$_.TimeCreated.ToUniversalTime().ToString('o')}},ProviderName,Id,Message) -Compress } catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { '[]' } else { throw } }`;
}
// Read-only Windows System-log check. No registry writes or device operations.
export function driverEventsSince(since) {
  if(process.platform!=='win32')return {supported:false,events:[]};
  const events=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',eventCommand(since)],
    {encoding:'utf8',timeout:10000,windowsHide:true}));
  return {supported:true,events};
}
// The queue benchmark polls off the refill path. Abort kills an active query;
// timeout and output limits also apply if the caller stops making progress.
export async function driverEventsSinceAsync(since,{signal}={}) {
  if(process.platform!=='win32')return {supported:false,events:[]};
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',eventCommand(since)],
    {encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024,windowsHide:true,signal});
  return {supported:true,events:JSON.parse(stdout)};
}
