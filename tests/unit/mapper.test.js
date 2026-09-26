import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fromTrackingResponse, parseCourierTimestamp, toManifestPayload } from '../../src/couriers/urbanebolt/mapper.js';
import { makeOrder } from '../helpers/fixtures.js';
import { ShipmentStatus } from '../../src/utils/status.js';

describe('urbanebolt mapper', () => {
  describe('toManifestPayload', () => {
    it('flattens our nested address objects into the courier prefixed fields', () => {
      const payload = toManifestPayload(makeOrder(), { customerCode: 'TESTCUS001' });

      assert.equal(payload.customerCode, 'TESTCUS001');
      assert.equal(payload.shprName, 'Rohit Athaley');
      assert.equal(payload.consName, 'Satyam School');
      assert.equal(payload.consCity, 'Surat');

      // The courier expects numbers here, not the strings our schema validates.
      assert.equal(payload.shprPincode, 122017);
      assert.equal(payload.consMobile, 8320226438);
      assert.equal(typeof payload.consPincode, 'number');
    });

    it('defaults the return address to the pickup address', () => {
      const payload = toManifestPayload(makeOrder(), { customerCode: 'C1' });

      assert.equal(payload.rtnName, payload.shprName);
      assert.equal(payload.rtnPincode, payload.shprPincode);
    });

    it('uses an explicit return address when one is supplied', () => {
      const order = makeOrder();
      order.return_to = { ...order.pickup, name: 'Returns Desk', pincode: '400001' };

      const payload = toManifestPayload(order, { customerCode: 'C1' });

      assert.equal(payload.rtnName, 'Returns Desk');
      assert.equal(payload.rtnPincode, 400001);
      assert.equal(payload.shprName, 'Rohit Athaley', 'pickup must be untouched');
    });

    it('sends every field the courier lists as required', () => {
      const payload = toManifestPayload(makeOrder(), { customerCode: 'C1' });

      // Captured verbatim from the UAT sandbox's own rejection message.
      const required = [
        'shprName', 'shprAddress', 'shprAddressType', 'shprCity', 'shprState', 'shprPincode',
        'shprMobile', 'rtnName', 'rtnAddress', 'rtnCity', 'rtnState', 'rtnCountry', 'rtnPincode',
        'rtnMobile', 'consName', 'consAddress', 'consAddressType', 'consCity', 'consState',
        'consPincode', 'consMobile', 'payMode', 'collectableValue', 'declaredValue',
        'invoiceValue', 'itemDescription', 'itemQuantity', 'pieces', 'weight', 'length',
        'breadth', 'height', 'serviceType',
      ];

      const missing = required.filter((field) => payload[field] === undefined);
      assert.deepEqual(missing, [], `missing required courier fields: ${missing.join(', ')}`);
    });
  });

  describe('parseCourierTimestamp', () => {
    it('reads the courier non-ISO format and converts IST to UTC', () => {
      // 15:47 IST is 10:17 UTC on the same day.
      assert.equal(parseCourierTimestamp('03 May 2025, 15:47').toISOString(), '2025-05-03T10:17:00.000Z');
    });

    it('handles a single-digit day and hour', () => {
      assert.equal(parseCourierTimestamp('3 Jan 2025, 9:05').toISOString(), '2025-01-03T03:35:00.000Z');
    });

    it('returns null rather than an Invalid Date for unparseable input', () => {
      assert.equal(parseCourierTimestamp('not a date'), null);
      assert.equal(parseCourierTimestamp(''), null);
      assert.equal(parseCourierTimestamp(undefined), null);
      assert.equal(parseCourierTimestamp('03 Xyz 2025, 15:47'), null);
    });
  });

  describe('fromTrackingResponse', () => {
    // The exact body the UAT sandbox returned for AWB 200000001170.
    const response = {
      awbNumber: 200000001170,
      orderNumber: 'UEBCUS00015',
      currentLocation: 'Gurgaon',
      edd: '2025-05-05',
      currentStatusCode: 'CAN',
      currentStatusCodeDescription: 'Cancelled',
      scans: [
        { statusDateTime: '03 May 2025, 15:47', statusCode: 'CAN', statusCodeDescription: 'Cancelled', currentLocation: '' },
        { statusDateTime: '03 May 2025, 15:44', statusCode: 'MAN', statusCodeDescription: 'Shipment Manifested', currentLocation: 'Gurgaon' },
      ],
    };

    it('maps the current status and location', () => {
      const result = fromTrackingResponse(response);

      assert.equal(result.status, ShipmentStatus.CANCELLED);
      assert.equal(result.currentLocation, 'Gurgaon');
      assert.equal(result.awbNumber, '200000001170');
      assert.equal(result.estimatedDelivery, '2025-05-05');
    });

    it('turns every scan into a normalized tracking event', () => {
      const [cancelled, manifested] = fromTrackingResponse(response).history;

      assert.equal(cancelled.status, ShipmentStatus.CANCELLED);
      assert.equal(cancelled.code, 'CAN');
      assert.equal(cancelled.location, null, 'an empty location string becomes null');

      assert.equal(manifested.status, ShipmentStatus.CREATED);
      assert.equal(manifested.code, 'MAN');
      assert.equal(manifested.location, 'Gurgaon');
      assert.equal(manifested.occurredAt.toISOString(), '2025-05-03T10:14:00.000Z');
    });

    it('drops scans whose timestamp cannot be parsed instead of storing an invalid date', () => {
      const result = fromTrackingResponse({
        ...response,
        scans: [...response.scans, { statusDateTime: 'garbage', statusCode: 'DEL' }],
      });

      assert.equal(result.history.length, 2);
    });

    it('tolerates a response with no scans at all', () => {
      const result = fromTrackingResponse({ currentStatusCode: 'MAN' });

      assert.deepEqual(result.history, []);
      assert.equal(result.status, ShipmentStatus.CREATED);
    });
  });
});
