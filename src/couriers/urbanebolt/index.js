import { createClient } from './client.js';
import { fromTrackingResponse, toManifestPayload } from './mapper.js';
import { AppError, CourierError } from '../../errors/app-error.js';
import { ErrorCode } from '../../errors/error-codes.js';
import { ShipmentStatus } from '../../utils/status.js';

const NAME = 'urbanebolt';

const MANIFEST_PATH = '/api/v1/services/manifest/';
const TRACKING_PATH = '/api/v1/services/tracking-pub/';
const CANCEL_PATH = '/api/v1/services/cancel/';

let client;
let customerCode;

export default {
  name: NAME,
  displayName: 'UrbaneBolt',

  init(settings) {
    client = createClient(settings);
    customerCode = settings.get('CUSTOMER_CODE');
  },

  async createShipment(order) {
    const payload = toManifestPayload(order, { customerCode });

    try {
      // The manifest endpoint is natively batched, hence the array for a single shipment.
      const body = await client.request({ method: 'POST', url: MANIFEST_PATH, data: [payload] });

      // UrbaneBolt answers 200 OK even when it rejects the shipment — duplicates and field
      // errors alike arrive in errorResponse[]. Trusting the status code here would record
      // failed shipments as successful, so the verdict is read from the body.
      const failure = body?.errorResponse?.[0];
      if (failure) {
        throw new CourierError(ErrorCode.COURIER_VALIDATION_ERROR, 'Courier rejected the shipment', {
          courier: NAME,
          courierMessage: failure.message,
          courierResponse: body,
        });
      }

      const created = body?.successResponse?.[0];
      if (!created?.awbNumber) {
        throw new CourierError(ErrorCode.COURIER_UNAVAILABLE, 'Courier returned no shipment result', {
          courier: NAME,
          courierResponse: body,
        });
      }

      return {
        awbNumber: String(created.awbNumber),
        courierOrderId: created.orderNumber != null ? String(created.orderNumber) : null,
        labelUrl: created.shippingLabel ?? null,
        status: ShipmentStatus.CREATED,
        request: payload,
        raw: body,
      };
    } catch (err) {
      // Attach the exact body we sent so the service can persist it for audit even on failure.
      if (err instanceof AppError) err.courierRequest ??= payload;
      throw err;
    }
  },

  async trackShipment(awbNumber) {
    const body = await client.request({
      method: 'GET',
      url: TRACKING_PATH,
      params: { awb: awbNumber },
    });

    // "Data Not Found" also arrives as a 200.
    if (body?.status !== 'Success' || !body?.data?.awbNumber) {
      throw new CourierError(ErrorCode.COURIER_VALIDATION_ERROR, 'Courier has no record of this shipment', {
        courier: NAME,
        courierMessage: body?.message,
        courierResponse: body,
      });
    }

    return { ...fromTrackingResponse(body.data), raw: body };
  },

  async cancelShipment(awbNumber) {
    const body = await client.request({
      method: 'POST',
      url: CANCEL_PATH,
      // The courier takes a comma-separated string rather than an array here.
      data: { awbs: String(awbNumber) },
    });

    // Note the key is `failureResponse` on this endpoint but `errorResponse` on manifest.
    const failure = body?.failureResponse?.[0];
    if (failure) {
      // An already-cancelled shipment is the outcome the caller wanted, so it is reported as
      // success rather than an error.
      const alreadyCancelled = /already cancelled/i.test(failure.message ?? '');
      if (alreadyCancelled) {
        return { cancelled: true, message: 'Shipment was already cancelled', raw: body };
      }

      throw new CourierError(ErrorCode.COURIER_VALIDATION_ERROR, 'Courier refused the cancellation', {
        courier: NAME,
        courierMessage: failure.message,
        courierResponse: body,
      });
    }

    return {
      cancelled: true,
      message: body?.successResponse?.[0]?.message ?? 'Cancelled',
      raw: body,
    };
  },
};
