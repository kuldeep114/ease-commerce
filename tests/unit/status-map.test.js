import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapStatus } from '../../src/couriers/urbanebolt/status-map.js';
import { ShipmentStatus } from '../../src/utils/status.js';

describe('urbanebolt status map', () => {
  it('maps the codes observed in the sandbox', () => {
    assert.equal(mapStatus('MAN'), ShipmentStatus.CREATED);
    assert.equal(mapStatus('CAN'), ShipmentStatus.CANCELLED);
  });

  it('is case and whitespace insensitive', () => {
    assert.equal(mapStatus('man'), ShipmentStatus.CREATED);
    assert.equal(mapStatus('  Can  '), ShipmentStatus.CANCELLED);
  });

  // The sandbox only ever produced MAN and CAN, so the mapping is necessarily incomplete.
  // Falling back keeps an unknown code from stranding an order or breaking a tracking call.
  it('falls back to IN_TRANSIT for an unknown code instead of throwing', () => {
    assert.equal(mapStatus('WAT'), ShipmentStatus.IN_TRANSIT);
    assert.equal(mapStatus(''), ShipmentStatus.IN_TRANSIT);
    assert.equal(mapStatus(undefined), ShipmentStatus.IN_TRANSIT);
    assert.equal(mapStatus(null), ShipmentStatus.IN_TRANSIT);
  });

  it('only ever returns a known shipment status', () => {
    for (const code of ['MAN', 'CAN', 'DEL', 'OFD', 'RTO', 'NONSENSE']) {
      assert.ok(Object.values(ShipmentStatus).includes(mapStatus(code)), `${code} mapped outside the enum`);
    }
  });
});
