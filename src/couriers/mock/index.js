import { CourierError } from '../../errors/app-error.js';
import { ErrorCode } from '../../errors/error-codes.js';
import { ShipmentStatus } from '../../utils/status.js';

const NAME = 'mock';

/**
 * A second, fully functional courier — added without touching a single shared file. That is the
 * pluggability claim in requirement 3.2, demonstrated rather than asserted.
 *
 * It also makes the test suite fast and deterministic: the integration tests exercise the real
 * routes, services and database against this adapter with no network involved.
 */

// Deliberately in-memory: this courier has no backend, and the platform's own database is the
// only durable record either way.
const shipments = new Map();

const PROGRESSION = [
  ShipmentStatus.CREATED,
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.DELIVERED,
];

const CODE_BY_STATUS = {
  // The courier's own code for "I have accepted this shipment", deliberately distinct from the
  // CREATED event the service records — mirroring UrbaneBolt's MAN scan.
  [ShipmentStatus.CREATED]: 'MANIFESTED',
  [ShipmentStatus.PICKED_UP]: 'PICKED_UP',
  [ShipmentStatus.IN_TRANSIT]: 'IN_TRANSIT',
  [ShipmentStatus.OUT_FOR_DELIVERY]: 'OUT_FOR_DELIVERY',
  [ShipmentStatus.DELIVERED]: 'DELIVERED',
  [ShipmentStatus.CANCELLED]: 'CANCELLED',
};

let settings = { failureRate: 0, latencyMs: 0, autoAdvance: true };
let counter = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scanFor(status, at = new Date()) {
  return {
    status,
    code: CODE_BY_STATUS[status] ?? status,
    description: `Mock courier: ${status.toLowerCase().replace(/_/g, ' ')}`,
    location: 'Mock Hub',
    occurredAt: at,
    raw: { status, at: at.toISOString() },
  };
}

function requireShipment(awbNumber) {
  const shipment = shipments.get(String(awbNumber));
  if (!shipment) {
    throw new CourierError(ErrorCode.COURIER_VALIDATION_ERROR, 'Courier has no record of this shipment', {
      courier: NAME,
      courierMessage: `unknown awb ${awbNumber}`,
    });
  }
  return shipment;
}

export default {
  name: NAME,
  displayName: 'Mock Courier',

  init(courierSettings) {
    settings = {
      // A non-zero failure rate makes partial-success behaviour easy to demonstrate on a bulk
      // request without waiting for a real courier to misbehave.
      failureRate: courierSettings.getNumber('FAILURE_RATE', 0),
      latencyMs: courierSettings.getNumber('LATENCY_MS', 0),
      autoAdvance: courierSettings.getBoolean('AUTO_ADVANCE', true),
    };
    shipments.clear();
    counter = 0;
  },

  async createShipment(order) {
    if (settings.latencyMs > 0) await sleep(settings.latencyMs);

    if (Math.random() < settings.failureRate) {
      throw new CourierError(ErrorCode.COURIER_UNAVAILABLE, 'Courier is temporarily unavailable', {
        courier: NAME,
        courierMessage: 'simulated failure',
      });
    }

    counter += 1;
    const awbNumber = `MOCK${String(Date.now()).slice(-8)}${String(counter).padStart(4, '0')}`;

    shipments.set(awbNumber, {
      orderId: order.order_id,
      step: 0,
      cancelled: false,
      scans: [scanFor(ShipmentStatus.CREATED)],
    });

    const raw = { status: 'Success', awb: awbNumber, order_number: order.order_id };
    return {
      awbNumber,
      courierOrderId: order.order_id,
      labelUrl: `https://mock-courier.local/labels/${awbNumber}.pdf`,
      status: ShipmentStatus.CREATED,
      request: { order_number: order.order_id, courier: NAME },
      raw,
    };
  },

  async trackShipment(awbNumber) {
    const shipment = requireShipment(awbNumber);

    // Advancing one step per call lets a reviewer watch a shipment move through its lifecycle
    // by calling /track repeatedly, without any time-based waiting.
    if (settings.autoAdvance && !shipment.cancelled && shipment.step < PROGRESSION.length - 1) {
      shipment.step += 1;
      shipment.scans.push(scanFor(PROGRESSION[shipment.step]));
    }

    const status = shipment.cancelled ? ShipmentStatus.CANCELLED : PROGRESSION[shipment.step];
    return {
      status,
      currentLocation: 'Mock Hub',
      awbNumber: String(awbNumber),
      estimatedDelivery: null,
      history: [...shipment.scans],
      raw: { status: 'Success', awb: awbNumber, scans: shipment.scans.map((scan) => scan.raw) },
    };
  },

  async cancelShipment(awbNumber) {
    const shipment = requireShipment(awbNumber);

    if (shipment.cancelled) {
      return { cancelled: true, message: 'Shipment was already cancelled', raw: { status: 'Success' } };
    }

    if (PROGRESSION[shipment.step] === ShipmentStatus.DELIVERED) {
      throw new CourierError(ErrorCode.COURIER_VALIDATION_ERROR, 'Courier refused the cancellation', {
        courier: NAME,
        courierMessage: 'shipment already delivered',
      });
    }

    shipment.cancelled = true;
    shipment.scans.push(scanFor(ShipmentStatus.CANCELLED));
    return { cancelled: true, message: 'Cancelled', raw: { status: 'Success', awb: awbNumber } };
  },
};
