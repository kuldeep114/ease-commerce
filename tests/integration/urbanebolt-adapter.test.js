import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import nock from 'nock';

import adapter from '../../src/couriers/urbanebolt/index.js';
import { courierConfig } from '../../src/config/couriers.js';
import { ErrorCode } from '../../src/errors/error-codes.js';
import { ShipmentStatus } from '../../src/utils/status.js';
import { makeOrder } from '../helpers/fixtures.js';

const BASE = 'https://urbanebolt.test';
const AUTH_PATH = '/api/v1/auth/getToken/';
const MANIFEST_PATH = '/api/v1/services/manifest/';

const authReply = { access_token: 'test-token', expires_in: 86400, token_type: 'Bearer', status: 'Success' };

function mockAuth(times = 1) {
  return nock(BASE).post(AUTH_PATH).times(times).reply(200, authReply);
}

describe('urbanebolt adapter', () => {
  before(() => nock.disableNetConnect());
  after(() => { nock.enableNetConnect(); nock.restore(); });

  beforeEach(() => {
    nock.cleanAll();
    // Re-initialising drops the cached token so each case starts from a known state.
    adapter.init(courierConfig('urbanebolt'));
  });

  afterEach(() => nock.cleanAll());

  describe('createShipment', () => {
    it('returns the AWB from a successful manifest', async () => {
      mockAuth();
      nock(BASE).post(MANIFEST_PATH).reply(200, {
        status: 'Success',
        successResponse: [{
          status: 'Success',
          orderNumber: 'ORD-1',
          awbNumber: 200000007934,
          shippingLabel: 'https://label.test/abc',
          customerCode: 'TESTCUS001',
        }],
        errorResponse: [],
      });

      const result = await adapter.createShipment(makeOrder({ order_id: 'ORD-1' }));

      assert.equal(result.awbNumber, '200000007934', 'numeric AWB must be normalized to a string');
      assert.equal(result.courierOrderId, 'ORD-1');
      assert.equal(result.labelUrl, 'https://label.test/abc');
      assert.equal(result.status, ShipmentStatus.CREATED);
      assert.equal(result.request.customerCode, 'TESTCUS001', 'the sent payload is returned for the audit trail');
    });

    // The single most important behaviour in this adapter. UrbaneBolt answers 200 OK even when
    // it rejects the shipment; trusting the status code would record failures as successes.
    it('treats a 200 response carrying errorResponse as a failure', async () => {
      mockAuth();
      nock(BASE).post(MANIFEST_PATH).reply(200, {
        status: 'Success',
        successResponse: [],
        errorResponse: [{ orderNumber: 'ORD-2', status: 'Failed', message: 'orderNumber already shipped!' }],
      });

      await assert.rejects(
        adapter.createShipment(makeOrder({ order_id: 'ORD-2' })),
        (err) => {
          assert.equal(err.code, ErrorCode.COURIER_VALIDATION_ERROR);
          assert.equal(err.status, 422);
          return true;
        },
      );
    });

    it('keeps the courier wording out of the consumer-facing message but preserves it for logs', async () => {
      mockAuth();
      const courierWording = "'shprName' is a required property";
      nock(BASE).post(MANIFEST_PATH).reply(200, {
        status: 'Success',
        successResponse: [],
        errorResponse: [{ status: 'Failed', message: courierWording }],
      });

      const err = await adapter.createShipment(makeOrder()).catch((e) => e);

      assert.ok(!err.message.includes('shprName'), 'raw courier text must not leak into the message');
      assert.equal(err.courierMessage, courierWording, 'but it must be kept for the log line');
      assert.ok(err.courierRequest, 'the sent payload is attached for the audit trail');
    });

    it('attaches the request payload even when the transport fails', async () => {
      mockAuth();
      nock(BASE).post(MANIFEST_PATH).times(3).reply(500, 'upstream down');

      const err = await adapter.createShipment(makeOrder()).catch((e) => e);

      assert.equal(err.code, ErrorCode.COURIER_UNAVAILABLE);
      assert.equal(err.courierRequest.customerCode, 'TESTCUS001');
    });
  });

  describe('authentication', () => {
    it('authenticates once and reuses the token across calls', async () => {
      const auth = mockAuth(1);
      const manifest = nock(BASE).post(MANIFEST_PATH).times(2).reply(200, {
        status: 'Success',
        successResponse: [{ orderNumber: 'X', awbNumber: 1 }],
        errorResponse: [],
      });

      await adapter.createShipment(makeOrder());
      await adapter.createShipment(makeOrder());

      assert.ok(auth.isDone(), 'token endpoint called exactly once');
      assert.ok(manifest.isDone());
    });

    // An expired or revoked token must self-heal without the caller noticing.
    it('re-authenticates and retries once after a 401', async () => {
      let authCalls = 0;
      nock(BASE).post(AUTH_PATH).times(2).reply(200, () => { authCalls += 1; return authReply; });

      nock(BASE).post(MANIFEST_PATH).reply(401, { detail: 'Authentication credentials were not provided.' });
      nock(BASE).post(MANIFEST_PATH).reply(200, {
        status: 'Success',
        successResponse: [{ orderNumber: 'ORD-3', awbNumber: 777 }],
        errorResponse: [],
      });

      const result = await adapter.createShipment(makeOrder({ order_id: 'ORD-3' }));

      assert.equal(result.awbNumber, '777');
      assert.equal(authCalls, 2, 'one initial token, one refresh after the 401');
    });

    it('gives up after a single re-authentication rather than looping', async () => {
      let authCalls = 0;
      nock(BASE).post(AUTH_PATH).times(5).reply(200, () => { authCalls += 1; return authReply; });
      nock(BASE).post(MANIFEST_PATH).times(5).reply(401, { detail: 'nope' });

      await assert.rejects(adapter.createShipment(makeOrder()), (err) => err.code === ErrorCode.COURIER_AUTH_ERROR);

      assert.equal(authCalls, 2, 'a bad credential must not become an auth-request storm');
    });
  });

  describe('retry behaviour', () => {
    it('retries a 5xx and succeeds when the courier recovers', async () => {
      mockAuth();
      nock(BASE).post(MANIFEST_PATH).reply(503, 'unavailable');
      nock(BASE).post(MANIFEST_PATH).reply(200, {
        status: 'Success',
        successResponse: [{ orderNumber: 'ORD-4', awbNumber: 888 }],
        errorResponse: [],
      });

      const result = await adapter.createShipment(makeOrder({ order_id: 'ORD-4' }));
      assert.equal(result.awbNumber, '888');
    });

    it('does not retry a 400 — the payload will be rejected every time', async () => {
      mockAuth();
      let attempts = 0;
      nock(BASE).post(MANIFEST_PATH).times(3).reply(400, () => { attempts += 1; return { detail: 'bad request' }; });

      await assert.rejects(adapter.createShipment(makeOrder()), (err) => err.code === ErrorCode.COURIER_VALIDATION_ERROR);

      assert.equal(attempts, 1);
    });

    it('maps a connection timeout to COURIER_TIMEOUT', async () => {
      mockAuth();
      nock(BASE).post(MANIFEST_PATH).times(3).delayConnection(3000).reply(200, {});

      await assert.rejects(adapter.createShipment(makeOrder()), (err) => err.code === ErrorCode.COURIER_TIMEOUT);
    });
  });

  describe('trackShipment', () => {
    it('normalizes the courier tracking payload', async () => {
      mockAuth();
      nock(BASE).get('/api/v1/services/tracking-pub/').query({ awb: '200000001170' }).reply(200, {
        status: 'Success',
        message: 'Tracking',
        data: {
          awbNumber: 200000001170,
          currentLocation: 'Gurgaon',
          currentStatusCode: 'MAN',
          scans: [{ statusDateTime: '03 May 2025, 15:44', statusCode: 'MAN', statusCodeDescription: 'Shipment Manifested', currentLocation: 'Gurgaon' }],
        },
      });

      const result = await adapter.trackShipment('200000001170');

      assert.equal(result.status, ShipmentStatus.CREATED);
      assert.equal(result.history.length, 1);
      assert.equal(result.history[0].code, 'MAN');
    });

    // "Data Not Found" also arrives as HTTP 200.
    it('rejects an unknown AWB reported as a 200', async () => {
      mockAuth();
      nock(BASE).get('/api/v1/services/tracking-pub/').query(true).reply(200, { status: 'Failed', message: 'Data Not Found', data: [] });

      await assert.rejects(adapter.trackShipment('999'), (err) => err.code === ErrorCode.COURIER_VALIDATION_ERROR);
    });
  });

  describe('cancelShipment', () => {
    it('reports a successful cancellation', async () => {
      mockAuth();
      nock(BASE).post('/api/v1/services/cancel/').reply(200, {
        status: 'Success',
        successResponse: [{ orderNumber: 'ORD-5', awb: '200000007934', message: 'Cancelled' }],
        failureResponse: [],
      });

      const result = await adapter.cancelShipment('200000007934');

      assert.equal(result.cancelled, true);
      assert.equal(result.message, 'Cancelled');
    });

    // Note the key is `failureResponse` here but `errorResponse` on manifest.
    it('treats an already-cancelled shipment as success, not an error', async () => {
      mockAuth();
      nock(BASE).post('/api/v1/services/cancel/').reply(200, {
        status: 'Success',
        successResponse: [],
        failureResponse: [{ awb: '200000007934', message: 'Shipment already cancelled!' }],
      });

      const result = await adapter.cancelShipment('200000007934');
      assert.equal(result.cancelled, true);
    });

    it('surfaces a genuine refusal as a normalized error', async () => {
      mockAuth();
      nock(BASE).post('/api/v1/services/cancel/').reply(200, {
        status: 'Success',
        successResponse: [],
        failureResponse: [{ awb: '1', message: 'Shipment already picked up' }],
      });

      await assert.rejects(adapter.cancelShipment('1'), (err) => err.code === ErrorCode.COURIER_VALIDATION_ERROR);
    });
  });
});
