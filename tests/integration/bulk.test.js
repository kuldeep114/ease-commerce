import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';

import { app } from '../../src/app.js';
import { loadCouriers } from '../../src/couriers/registry.js';
import { waitForBatch } from '../../src/services/bulk.service.js';
import { API_KEY, makeOrder } from '../helpers/fixtures.js';
import { closeDatabase, db, resetDatabase } from '../helpers/db.js';

const api = () => request.agent(app).set('x-api-key', API_KEY);

async function submit(orders) {
  const res = await api().post('/api/v1/orders/bulk').send({ orders }).expect(202);
  // Waiting on the batch's own promise beats polling — deterministic, and no sleeps.
  await waitForBatch(res.body.data.batch_id);
  return res.body.data;
}

describe('bulk orders API', () => {
  before(() => loadCouriers());
  beforeEach(() => resetDatabase());
  after(() => closeDatabase());

  it('accepts the batch immediately instead of waiting for the courier', async () => {
    const orders = Array.from({ length: 20 }, () => makeOrder());

    const res = await api().post('/api/v1/orders/bulk').send({ orders }).expect(202);

    assert.equal(res.body.data.status, 'QUEUED');
    assert.equal(res.body.data.total_count, 20);
    assert.equal(res.body.data.accepted_count, 20);
    assert.ok(res.body.data.batch_id);
    assert.ok(res.body.data.status_url.endsWith(res.body.data.batch_id));

    await waitForBatch(res.body.data.batch_id);
  });

  it('processes a full batch of 100 orders', async () => {
    const { batch_id } = await submit(Array.from({ length: 100 }, () => makeOrder()));

    const res = await api().get(`/api/v1/orders/bulk/${batch_id}`).expect(200);

    assert.equal(res.body.data.status, 'COMPLETED');
    assert.equal(res.body.data.success_count, 100);
    assert.equal(res.body.data.failure_count, 0);
    assert.equal((await db('orders').where({ batch_id })).length, 100);
  });

  it('rejects a batch larger than the configured maximum', async () => {
    const res = await api()
      .post('/api/v1/orders/bulk')
      .send({ orders: Array.from({ length: 101 }, () => makeOrder()) })
      .expect(400);

    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.match(res.body.error.details[0].message, /at most 100/);
  });

  describe('partial success', () => {
    it('reports each order individually and never aborts the batch', async () => {
      const good = Array.from({ length: 5 }, () => makeOrder());
      const badPincode = makeOrder({ order_id: 'BULK-BAD-PIN' });
      badPincode.delivery.pincode = '12';
      const unknownCourier = makeOrder({ order_id: 'BULK-BAD-COURIER', courier_partner: 'delhivery' });

      const { batch_id } = await submit([...good, badPincode, unknownCourier]);
      const res = await api().get(`/api/v1/orders/bulk/${batch_id}`).expect(200);
      const { data } = res.body;

      assert.equal(data.total_count, 7);
      assert.equal(data.success_count, 5);
      assert.equal(data.failure_count, 2);
      assert.equal(data.pending_count, 0);

      const failures = Object.fromEntries(
        data.results.filter((r) => r.status === 'FAILED').map((r) => [r.order_id, r.error]),
      );

      assert.equal(failures['BULK-BAD-PIN'].code, 'VALIDATION_ERROR');
      assert.match(failures['BULK-BAD-PIN'].message, /delivery\.pincode/);
      assert.equal(failures['BULK-BAD-COURIER'].code, 'UNSUPPORTED_COURIER');
    });

    it('rejects an invalid order up front without ever calling the courier', async () => {
      const bad = makeOrder({ order_id: 'BULK-NEVER-SENT' });
      bad.delivery.pincode = 'oops';

      const { batch_id, accepted_count, rejected_count } = await submit([bad]);

      assert.equal(accepted_count, 0);
      assert.equal(rejected_count, 1);
      // No order row exists, because the item never reached the service.
      assert.equal((await db('orders').where({ batch_id })).length, 0);
    });
  });

  describe('idempotency', () => {
    it('creates one shipment when the same order_id appears twice in a batch', async () => {
      const order = makeOrder({ order_id: 'BULK-DUP-1' });

      const { batch_id } = await submit([order, { ...order }]);
      const res = await api().get(`/api/v1/orders/bulk/${batch_id}`).expect(200);

      assert.equal(res.body.data.success_count, 1);
      assert.equal(res.body.data.failure_count, 1);

      const duplicate = res.body.data.results.find((r) => r.status === 'FAILED');
      assert.equal(duplicate.error.code, 'DUPLICATE_ORDER');
      assert.equal((await db('orders').where({ order_id: 'BULK-DUP-1' })).length, 1);
    });

    it('creates no new shipments when an entire batch is resubmitted', async () => {
      const orders = Array.from({ length: 5 }, (_, i) => makeOrder({ order_id: `BULK-REPLAY-${i}` }));

      await submit(orders);
      const { batch_id: secondBatch } = await submit(orders);

      const res = await api().get(`/api/v1/orders/bulk/${secondBatch}`).expect(200);
      assert.equal(res.body.data.failure_count, 5);
      assert.ok(res.body.data.results.every((r) => r.error.code === 'DUPLICATE_ORDER'));

      assert.equal((await db('orders')).length, 5, 'still only the original five shipments');
    });
  });

  it('mixes couriers within a single batch', async () => {
    const orders = [
      makeOrder({ order_id: 'MIX-1', courier_partner: 'mock' }),
      makeOrder({ order_id: 'MIX-2', courier_partner: 'mock' }),
      makeOrder({ order_id: 'MIX-3', courier_partner: 'delhivery' }),
    ];

    const { batch_id } = await submit(orders);
    const res = await api().get(`/api/v1/orders/bulk/${batch_id}`).expect(200);

    assert.equal(res.body.data.success_count, 2);
    assert.equal(res.body.data.results.find((r) => r.order_id === 'MIX-3').error.code, 'UNSUPPORTED_COURIER');
  });

  it('404s for an unknown batch_id', async () => {
    const res = await api().get('/api/v1/orders/bulk/11111111-2222-3333-4444-555555555555').expect(404);
    assert.equal(res.body.error.code, 'BATCH_NOT_FOUND');
  });
});
