import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runWithConcurrency } from '../../src/utils/concurrency.js';

describe('runWithConcurrency', () => {
  it('never exceeds the configured number of in-flight tasks', async () => {
    let inFlight = 0;
    let peak = 0;

    await runWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 5, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });

    assert.ok(peak <= 5, `peak concurrency was ${peak}`);
    assert.ok(peak > 1, 'tasks should actually run in parallel');
  });

  it('keeps results in input order regardless of completion order', async () => {
    const results = await runWithConcurrency([30, 10, 20], 3, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return delay;
    });

    assert.deepEqual(results.map((r) => r.value), [30, 10, 20]);
  });

  // The behaviour the bulk endpoint depends on: one bad order must not abort the batch.
  it('isolates a failing task and still runs the rest', async () => {
    const results = await runWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n * 10;
    });

    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.message, 'boom');
    assert.equal(results[3].value, 40);
  });

  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const seen = [];

    await runWithConcurrency(items, 10, async (n) => { seen.push(n); });

    assert.equal(seen.length, 100);
    assert.equal(new Set(seen).size, 100);
  });

  it('handles an empty list without hanging', async () => {
    assert.deepEqual(await runWithConcurrency([], 10, async () => 'x'), []);
  });
});
