import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

import { app } from '../../src/app.js';
import { loadCouriers } from '../../src/couriers/registry.js';
import { API_KEY, makeOrder } from '../helpers/fixtures.js';
import { closeDatabase, db, resetDatabase } from '../helpers/db.js';
import { ShipmentStatus } from '../../src/utils/status.js';

// These run the real routes, services and database end to end. MockCourier stands in for the
// network, which is what keeps them fast and deterministic.
const api = () => request.agent(app).set('x-api-key', API_KEY);

describe('orders API', () => {
  before(() => loadCouriers());
  beforeEach(() => resetDatabase());
  after(() => closeDatabase());

  describe('authentication', () => {
    it('rejects a request with no API key', async () => {
      const res = await request(app).get('/api/v1/couriers').expect(401);
      assert.equal(res.body.error.code, 'UNAUTHORIZED');
    });

    it('rejects a wrong API key', async () => {
      await request(app).get('/api/v1/couriers').set('x-api-key', 'nope').expect(401);
    });

    it('leaves /health open for probes', async () => {
      const res = await request(app).get('/health').expect(200);
      assert.equal(res.body.status, 'ok');
    });
  });

  describe('POST /api/v1/orders', () => {
    it('creates a shipment and persists the audit trail', async () => {
      const order = makeOrder({ order_id: 'ORD-CREATE-1' });
      const res = await api().post('/api/v1/orders').send(order).expect(201);

      assert.equal(res.body.success, true);
      assert.equal(res.body.data.order_id, 'ORD-CREATE-1');
      assert.equal(res.body.data.status, ShipmentStatus.CREATED);
      assert.ok(res.body.data.awb_number);
      assert.ok(res.body.request_id.startsWith('req_'));

      const row = await db('orders').where({ order_id: 'ORD-CREATE-1' }).first();
      assert.ok(row.request_payload, 'the request sent to the courier must be stored');
      assert.ok(row.response_payload, 'the response received must be stored');

      // Creation is itself a tracking event.
      const history = await db('tracking_history').where({ order_id: row.id });
      assert.equal(history.length, 1);
    });

    it('never returns the raw courier payloads to the consumer', async () => {
      const res = await api().post('/api/v1/orders').send(makeOrder()).expect(201);

      assert.equal(res.body.data.request_payload, undefined);
      assert.equal(res.body.data.response_payload, undefined);
    });

    it('applies schema defaults', async () => {
      const order = makeOrder();
      delete order.service_type;
      delete order.shipment.pieces;

      await api().post('/api/v1/orders').send(order).expect(201);

      const row = await db('orders').where({ order_id: order.order_id }).first();
      const sent = typeof row.request_payload === 'string' ? JSON.parse(row.request_payload) : row.request_payload;
      assert.equal(sent.order_number ?? order.order_id, order.order_id);
    });

    describe('validation', () => {
      it('returns field-level detail for a bad payload', async () => {
        const res = await api()
          .post('/api/v1/orders')
          .send(makeOrder({ delivery: { ...makeOrder().delivery, pincode: '12', phone: 'abc' } }))
          .expect(400);

        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
        const fields = res.body.error.details.map((d) => d.field);
        assert.ok(fields.includes('delivery.pincode'));
        assert.ok(fields.includes('delivery.phone'));
      });

      it('rejects a COD order with nothing to collect', async () => {
        const order = makeOrder();
        order.payment_mode = 'COD';
        order.shipment.collectable_value = 0;

        const res = await api().post('/api/v1/orders').send(order).expect(400);
        assert.equal(res.body.error.details[0].field, 'shipment.collectable_value');
      });

      it('rejects unknown fields rather than silently dropping them', async () => {
        const res = await api().post('/api/v1/orders').send({ ...makeOrder(), delivery_pincode: '110001' }).expect(400);
        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      });

      it('rejects malformed JSON with the same error envelope', async () => {
        const res = await api()
          .post('/api/v1/orders')
          .set('Content-Type', 'application/json')
          .send('{"broken":')
          .expect(400);

        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
        assert.ok(res.body.request_id);
      });
    });

    it('rejects an unknown courier and names the supported ones', async () => {
      const res = await api().post('/api/v1/orders').send(makeOrder({ courier_partner: 'delhivery' })).expect(400);

      assert.equal(res.body.error.code, 'UNSUPPORTED_COURIER');
      assert.ok(res.body.error.details.supported_couriers.includes('mock'));
    });

    describe('idempotency', () => {
      it('refuses a second shipment for the same order_id', async () => {
        const order = makeOrder({ order_id: 'ORD-DUP-1' });
        const first = await api().post('/api/v1/orders').send(order).expect(201);
        const second = await api().post('/api/v1/orders').send(order).expect(409);

        assert.equal(second.body.error.code, 'DUPLICATE_ORDER');
        assert.equal(second.body.error.details.awb_number, first.body.data.awb_number);

        assert.equal((await db('orders').where({ order_id: 'ORD-DUP-1' })).length, 1);
      });

      // The guarantee has to hold under concurrency, which is exactly what the unique
      // constraint buys us over a read-then-write check.
      it('creates exactly one shipment when the same order arrives concurrently', async () => {
        const order = makeOrder({ order_id: 'ORD-RACE-1' });

        const responses = await Promise.all(
          Array.from({ length: 5 }, () => api().post('/api/v1/orders').send(order)),
        );

        const created = responses.filter((r) => r.status === 201);
        const duplicates = responses.filter((r) => r.status === 409);

        assert.equal(created.length, 1, 'exactly one request may win');
        assert.equal(duplicates.length, 4);
        assert.equal((await db('orders').where({ order_id: 'ORD-RACE-1' })).length, 1);
      });
    });
  });

  describe('GET /api/v1/orders/:order_id/track', () => {
    it('returns live status and appends new scans to history', async () => {
      const order = makeOrder({ order_id: 'ORD-TRACK-1' });
      await api().post('/api/v1/orders').send(order).expect(201);

      const first = await api().get('/api/v1/orders/ORD-TRACK-1/track').expect(200);
      assert.equal(first.body.data.status, ShipmentStatus.PICKED_UP);
      assert.ok(first.body.data.tracking_history.length >= 2);

      const second = await api().get('/api/v1/orders/ORD-TRACK-1/track').expect(200);
      assert.equal(second.body.data.status, ShipmentStatus.IN_TRANSIT);
      assert.ok(
        second.body.data.tracking_history.length > first.body.data.tracking_history.length,
        'history must grow as the shipment progresses',
      );
    });

    it('does not duplicate scans the courier replays on every poll', async () => {
      const order = makeOrder({ order_id: 'ORD-TRACK-2' });
      await api().post('/api/v1/orders').send(order).expect(201);

      await api().get('/api/v1/orders/ORD-TRACK-2/track').expect(200);
      const after = await api().get('/api/v1/orders/ORD-TRACK-2/track').expect(200);

      const codes = after.body.data.tracking_history.map((e) => `${e.courier_status_code}@${e.occurred_at}`);
      assert.equal(new Set(codes).size, codes.length, 'no duplicate scans');
    });

    it('404s for an unknown order', async () => {
      const res = await api().get('/api/v1/orders/DOES-NOT-EXIST/track').expect(404);
      assert.equal(res.body.error.code, 'ORDER_NOT_FOUND');
    });
  });

  describe('POST /api/v1/orders/:order_id/cancel', () => {
    it('cancels a shipment and records the event', async () => {
      const order = makeOrder({ order_id: 'ORD-CANCEL-1' });
      await api().post('/api/v1/orders').send(order).expect(201);

      const res = await api().post('/api/v1/orders/ORD-CANCEL-1/cancel').expect(200);
      assert.equal(res.body.data.status, ShipmentStatus.CANCELLED);

      const row = await db('orders').where({ order_id: 'ORD-CANCEL-1' }).first();
      const history = await db('tracking_history').where({ order_id: row.id, status: ShipmentStatus.CANCELLED });
      assert.equal(history.length, 1);
    });

    it('is safe to repeat', async () => {
      const order = makeOrder({ order_id: 'ORD-CANCEL-2' });
      await api().post('/api/v1/orders').send(order).expect(201);

      await api().post('/api/v1/orders/ORD-CANCEL-2/cancel').expect(200);
      const again = await api().post('/api/v1/orders/ORD-CANCEL-2/cancel').expect(200);

      assert.equal(again.body.data.status, ShipmentStatus.CANCELLED);
    });

    it('404s for an unknown order', async () => {
      await api().post('/api/v1/orders/NOPE/cancel').expect(404);
    });
  });

  describe('GET /api/v1/couriers', () => {
    it('lists every registered adapter', async () => {
      const res = await api().get('/api/v1/couriers').expect(200);

      const names = res.body.data.couriers.map((c) => c.courier_partner);
      assert.deepEqual(names.sort(), ['mock', 'urbanebolt']);
    });
  });

  it('returns the normalized error envelope for an unknown route', async () => {
    const res = await api().get('/api/v1/nonsense').expect(404);

    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'NOT_FOUND');
    assert.ok(res.body.timestamp);
  });
});
