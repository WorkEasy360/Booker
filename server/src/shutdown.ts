// Graceful stop on SIGTERM or SIGINT (systemd stop, a redeploy, Ctrl+C): the listener stops accepting connections,
// the background workers stop, requests in progress may finish for up to `graceMs`, then the database is closed and
// the process exits. An email or message cut off by a hard stop is marked "unknown" at the next start and never
// resent blindly, so stopping is safe either way; this only avoids cutting requests off mid-answer.

export interface ShutdownDeps {
  server: { close(callback: (err?: Error) => void): unknown; closeIdleConnections?(): void };
  stopWorkers: () => void;
  closeDatabase: () => void;
  exit: (code: number) => void;
  log?: (message: string) => void;
  graceMs?: number;
}

/** Returns the handler for a stop signal; calling it again while stopping does nothing. */
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  let started = false;
  return signal => {
    if (started) return;
    started = true;
    const log = deps.log ?? (m => console.log(m));
    const graceMs = deps.graceMs ?? 10_000;
    log(`[shutdown] ${signal}: no new requests; letting requests in progress finish`);
    try { deps.stopWorkers(); } catch (e) { log(`[shutdown] stopping the workers failed: ${e instanceof Error ? e.message : e}`); }
    let finished = false;
    const finish = (message: string) => {
      if (finished) return;
      finished = true;
      try { deps.closeDatabase(); } catch { /* already closed */ }
      log(message);
      deps.exit(0);
    };
    const timer = setTimeout(() => finish(`[shutdown] requests still open after ${Math.round(graceMs / 1000)} s; stopping anyway`), graceMs);
    timer.unref?.();
    deps.server.close(() => { clearTimeout(timer); finish('[shutdown] stopped cleanly'); });
    // Keep-alive connections with no request in flight would otherwise hold close() open until they time out.
    deps.server.closeIdleConnections?.();
  };
}
