// In-memory ring buffer of gateway log lines, shown in the dashboard's activity feed.

export function createActivity(limit = 300) {
  const ring = [];
  return {
    push(text) {
      ring.unshift({ ts: Date.now(), text });
      ring.length = Math.min(ring.length, limit);
    },
    recent: (n = 100) => ring.slice(0, n),
  };
}
