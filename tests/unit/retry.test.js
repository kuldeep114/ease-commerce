import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CourierError } from '../../src/errors/app-error.js';
import { ErrorCode } from '../../src/errors/error-codes.js';
import { backoffDelay, isRetryable, withRetry } from '../../src/utils/retry.js';

const courierError = (code) => new CourierError(code, 'test');

describe('retry', () => {
  it('returns the first successful result without retrying', async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls += 1; return 'ok'; }, { retries: 3, baseDelayMs: 1 });

    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries a transient failure and succeeds on a later attempt', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw courierError(ErrorCode.COURIER_UNAVAILABLE);
        return 'recovered';
      },
      { retries: 3, baseDelayMs: 1 },
    );

    assert.equal(result, 'recovered');
    assert.equal(calls, 3);
  });

  it('gives up after the configured number of retries', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls += 1; throw courierError(ErrorCode.COURIER_TIMEOUT); }, { retries: 2, baseDelayMs: 1 }),
      (err) => err.code === ErrorCode.COURIER_TIMEOUT,
    );

    assert.equal(calls, 3, 'the initial attempt plus two retries');
  });

  it('does not retry a rejected payload — repeating it can never succeed', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls += 1; throw courierError(ErrorCode.COURIER_VALIDATION_ERROR); }, { retries: 3, baseDelayMs: 1 }),
      (err) => err.code === ErrorCode.COURIER_VALIDATION_ERROR,
    );

    assert.equal(calls, 1);
  });

  it('does not retry an auth failure here — re-authentication is handled separately', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls += 1; throw courierError(ErrorCode.COURIER_AUTH_ERROR); }, { retries: 3, baseDelayMs: 1 }),
      (err) => err.code === ErrorCode.COURIER_AUTH_ERROR,
    );

    assert.equal(calls, 1);
  });

  it('reports each retry through the onRetry hook', async () => {
    const seen = [];
    await assert.rejects(
      withRetry(async () => { throw courierError(ErrorCode.COURIER_UNAVAILABLE); }, {
        retries: 2,
        baseDelayMs: 1,
        onRetry: (err, attempt, delayMs) => seen.push({ attempt, delayMs }),
      }),
    );

    assert.deepEqual(seen.map((entry) => entry.attempt), [1, 2]);
  });

  describe('isRetryable', () => {
    it('accepts transient transport failures only', () => {
      assert.equal(isRetryable(courierError(ErrorCode.COURIER_TIMEOUT)), true);
      assert.equal(isRetryable(courierError(ErrorCode.COURIER_UNAVAILABLE)), true);
      assert.equal(isRetryable(courierError(ErrorCode.COURIER_VALIDATION_ERROR)), false);
      assert.equal(isRetryable(new Error('boom')), false);
    });
  });

  describe('backoffDelay', () => {
    it('grows exponentially and stays within the jitter window', () => {
      for (const [attempt, min, max] of [[0, 50, 100], [1, 100, 200], [2, 200, 400]]) {
        for (let i = 0; i < 25; i += 1) {
          const delay = backoffDelay(attempt, 100);
          assert.ok(delay >= min && delay <= max, `attempt ${attempt} produced ${delay}`);
        }
      }
    });
  });
});
