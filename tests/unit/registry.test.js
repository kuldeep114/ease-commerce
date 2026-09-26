import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { getCourier, listCourierNames, loadCouriers } from '../../src/couriers/registry.js';
import { validateAdapter } from '../../src/couriers/base-courier.js';
import { ErrorCode } from '../../src/errors/error-codes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'helpers', 'fixture-couriers');
const BROKEN = path.join(HERE, '..', 'helpers', 'fixture-broken');

describe('courier registry', () => {
  afterEach(() => {
    delete process.env.GOODCOURIER_ENABLED;
    delete process.env.BROKENCOURIER_ENABLED;
  });

  // This is requirement 3.2 in one assertion: a courier appears purely by existing as a folder
  // with the right shape and its env flag set. No list anywhere was edited.
  it('discovers an adapter from the filesystem with no registration step', async () => {
    process.env.GOODCOURIER_ENABLED = 'true';

    const loaded = await loadCouriers({ dir: FIXTURES });

    assert.deepEqual(loaded, ['goodcourier']);
    assert.equal(getCourier('goodcourier').displayName, 'Good Courier');
  });

  it('passes each adapter its own prefixed configuration', async () => {
    process.env.GOODCOURIER_ENABLED = 'true';
    process.env.GOODCOURIER_BASE_URL = 'https://good.test';

    await loadCouriers({ dir: FIXTURES });
    const adapter = getCourier('goodcourier');

    assert.equal(adapter.initialisedWith.baseUrl, 'https://good.test');
    assert.equal(adapter.initialisedWith.name, 'goodcourier');
    delete process.env.GOODCOURIER_BASE_URL;
  });

  it('skips an adapter that is disabled by configuration', async () => {
    process.env.GOODCOURIER_ENABLED = 'false';

    assert.deepEqual(await loadCouriers({ dir: FIXTURES }), []);
  });

  // Better to refuse to boot than to discover the gap on a customer's request.
  it('refuses to start when an adapter does not honour the contract', async () => {
    process.env.BROKENCOURIER_ENABLED = 'true';

    await assert.rejects(loadCouriers({ dir: BROKEN }), /is missing cancelShipment\(\)/);
  });

  it('rejects an unknown courier with the list of supported ones', async () => {
    process.env.GOODCOURIER_ENABLED = 'true';
    await loadCouriers({ dir: FIXTURES });

    assert.throws(
      () => getCourier('delhivery'),
      (err) => {
        assert.equal(err.code, ErrorCode.UNSUPPORTED_COURIER);
        assert.equal(err.status, 400);
        assert.deepEqual(err.details.supported_couriers, ['goodcourier']);
        return true;
      },
    );
  });

  it('resolves a courier name case-insensitively', async () => {
    process.env.GOODCOURIER_ENABLED = 'true';
    await loadCouriers({ dir: FIXTURES });

    assert.equal(getCourier('GoodCourier').name, 'goodcourier');
  });

  it('loads the real adapters that ship with the service', async () => {
    await loadCouriers();

    // Both are enabled in .env.test; the mock adapter is itself the proof that a second
    // courier slots in without touching shared code.
    assert.deepEqual(listCourierNames(), ['mock', 'urbanebolt']);
  });

  describe('validateAdapter', () => {
    const valid = {
      name: 'x',
      createShipment() {},
      trackShipment() {},
      cancelShipment() {},
    };

    it('accepts a complete adapter', () => {
      assert.equal(validateAdapter(valid, 'test'), valid);
    });

    it('names every problem it finds', () => {
      assert.throws(() => validateAdapter({ name: 'x' }, 'test'), /createShipment.*trackShipment.*cancelShipment/s);
      assert.throws(() => validateAdapter({ ...valid, name: 'MixedCase' }, 'test'), /non-lowercase/);
      assert.throws(() => validateAdapter(null, 'test'), /must export a default object/);
    });
  });
});
