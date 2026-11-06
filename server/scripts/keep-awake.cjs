// Keeps the computer out of idle sleep while long test runs execute, like `caffeinate` on macOS.
// Why (2026-10-22): unattended runs failed exactly when Windows entered Modern Standby on its 5-minute idle timeout;
// standby froze timers and reset TCP connections of the processes under test.
// The helper releases the request when it is killed and also exits on its own as soon as the process that started it
// is gone, so a crashed test run can never keep the computer awake.
const { spawn } = require('child_process');

function startKeepAwake(ownerPid = process.pid) {
  try {
    let child;
    if (process.platform === 'win32') {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED, held while the owner process is alive.
      const ps = "$s = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; "
        + '$k = Add-Type -MemberDefinition $s -Name P -Namespace W -PassThru; '
        + '[void]$k::SetThreadExecutionState([uint32]2147483651); '
        + `while (Get-Process -Id ${Number(ownerPid)} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }`;
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      child = spawn('caffeinate', ['-dims', '-w', String(ownerPid)], { stdio: 'ignore' });
    } else {
      child = spawn('systemd-inhibit', ['--what=idle:sleep', '--why=WorkEasy360 tests', 'tail', `--pid=${ownerPid}`, '-f', '/dev/null'], { stdio: 'ignore' });
    }
    child.on('error', () => { /* not available on this system: tests still run */ });
    child.unref();
    return child;
  } catch {
    return null;
  }
}

module.exports = { startKeepAwake };
