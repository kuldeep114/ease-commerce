import { ShipmentStatus } from '../../utils/status.js';
import { logger } from '../../utils/logger.js';

/**
 * UrbaneBolt scan code -> our normalized status.
 *
 * Only MAN and CAN were reachable in the UAT sandbox, so the rest are provisional and should be
 * confirmed against production scans before anyone relies on them. That uncertainty is exactly
 * why mapStatus falls through instead of throwing: an unrecognised code must never strand an
 * order in the wrong state or break a tracking call.
 */
const STATUS_BY_CODE = {
  MAN: ShipmentStatus.CREATED, // Shipment Manifested  (verified)
  CAN: ShipmentStatus.CANCELLED, // Cancelled          (verified)

  PKP: ShipmentStatus.PICKED_UP,
  PUP: ShipmentStatus.PICKED_UP,
  INT: ShipmentStatus.IN_TRANSIT,
  RCV: ShipmentStatus.IN_TRANSIT,
  BAG: ShipmentStatus.IN_TRANSIT,
  OFD: ShipmentStatus.OUT_FOR_DELIVERY,
  DEL: ShipmentStatus.DELIVERED,
  POD: ShipmentStatus.DELIVERED,
  RTO: ShipmentStatus.RTO,
  RTD: ShipmentStatus.RTO,
  UND: ShipmentStatus.IN_TRANSIT, // undelivered attempt — still moving, pending NDR resolution
};

export function mapStatus(code) {
  const normalized = String(code ?? '').trim().toUpperCase();
  const known = STATUS_BY_CODE[normalized];
  if (known) return known;

  logger.warn(
    { courier_partner: 'urbanebolt', courier_status_code: normalized },
    'Unmapped courier status code, defaulting to IN_TRANSIT',
  );
  return ShipmentStatus.IN_TRANSIT;
}
