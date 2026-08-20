export function startTickScheduler({ config, onTick }) {
  if (!config.tick?.enabled) {
    return { stop() {} };
  }

  const ms = (config.tick.intervalHours || 2) * 60 * 60 * 1000;
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await onTick({ reason: 'schedule' });
    } catch (err) {
      console.error('[tick] scheduled tick failed:', err);
    } finally {
      running = false;
    }
  }, ms);

  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[tick] scheduler every ${config.tick.intervalHours}h`);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
