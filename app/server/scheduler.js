// Runtime wrapper around the injected reminder engine. Only server/index.js
// wires this in production. The interval is unref'd, ticks never overlap, and
// a startup tick resumes persistent conditions after downtime. Disabled
// behavior is handled by the caller (no scheduler object is created when
// NTFY_URL is absent), keeping the disabled path free of timers/transport.

export function startReminderScheduler({
  engine,
  intervalMs = 60000,
  log = console.log,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  runImmediately = true,
} = {}) {
  if (!engine || typeof engine.tick !== 'function') {
    throw new Error('reminder scheduler requires an engine');
  }

  let stopped = false;
  let current = null;

  const tick = () => {
    if (stopped) return Promise.resolve({ stopped: true });
    if (current) return current;
    current = engine.tick()
      .then((summary) => {
        if (summary && (summary.sent || summary.failed)) {
          // Counts only: never message content, URLs, tokens, or response data.
          log(`reminders: sent ${summary.sent ?? 0}, failed ${summary.failed ?? 0}`);
        }
        return summary;
      })
      .catch(() => {
        log('reminders: tick failed');
        return null;
      })
      .finally(() => {
        current = null;
      });
    return current;
  };

  try {
    engine.recoverInterrupted?.();
  } catch {
    log('reminders: startup recovery failed');
  }

  const timer = setIntervalFn(tick, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  if (runImmediately) void tick();

  return {
    intervalMs,
    tick,
    async stop() {
      stopped = true;
      clearIntervalFn(timer);
      await current;
    },
  };
}
