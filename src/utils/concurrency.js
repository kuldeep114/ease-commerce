/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * Never rejects: a failing item resolves to `{ status: 'rejected', reason }` in the same slot,
 * because one bad order must not abort a batch of a hundred. Results keep input order.
 */
export async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;

      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner);
  await Promise.all(runners);
  return results;
}
