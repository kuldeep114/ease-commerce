import { mapStatus } from './status-map.js';

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

const IST_OFFSET_MINUTES = 330;
const TIMESTAMP_PATTERN = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4}),\s*(\d{1,2}):(\d{2})/;

/**
 * The courier sends scan times as "03 May 2025, 15:47" — not ISO, and with no timezone, though
 * the operation is Indian and the values are IST. Date.parse() cannot read this reliably across
 * runtimes, so it is parsed explicitly and shifted to UTC before storage.
 */
export function parseCourierTimestamp(value) {
  const match = TIMESTAMP_PATTERN.exec(String(value ?? '').trim());
  if (!match) return null;

  const [, day, monthName, year, hour, minute] = match;
  const month = MONTHS[monthName.slice(0, 3).toUpperCase()];
  if (month === undefined) return null;

  const asIfUtc = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute));
  return new Date(asIfUtc - IST_OFFSET_MINUTES * 60_000);
}

/**
 * UrbaneBolt wants every party flattened into a prefixed group: shpr (shipper/pickup),
 * cons (consignee/delivery), rtn (return). Our nested address object becomes nine flat keys.
 */
function flattenAddress(prefix, address) {
  return {
    [`${prefix}Name`]: address.name,
    [`${prefix}Address`]: address.address_line,
    [`${prefix}AddressType`]: address.address_type,
    [`${prefix}City`]: address.city,
    [`${prefix}State`]: address.state,
    [`${prefix}Country`]: address.country,
    [`${prefix}Pincode`]: Number(address.pincode),
    [`${prefix}Mobile`]: Number(address.phone),
    [`${prefix}Email`]: address.email ?? '',
  };
}

export function toManifestPayload(order, { customerCode }) {
  const { shipment, invoice } = order;
  // Most sellers ship from and take returns at the same place, so return_to is optional in our
  // contract but mandatory in the courier's.
  const returnTo = order.return_to ?? order.pickup;

  return {
    customerCode,
    orderNumber: order.order_id,
    serviceType: order.service_type,
    payMode: order.payment_mode,

    ...flattenAddress('shpr', order.pickup),
    ...flattenAddress('cons', order.delivery),
    ...flattenAddress('rtn', returnTo),

    pieces: shipment.pieces,
    weight: shipment.weight_kg,
    length: shipment.dimensions_cm.length,
    breadth: shipment.dimensions_cm.breadth,
    height: shipment.dimensions_cm.height,
    itemDescription: shipment.item_description,
    itemQuantity: shipment.item_quantity,
    declaredValue: shipment.declared_value,
    collectableValue: shipment.collectable_value,

    invoiceNumber: invoice.number,
    invoiceDate: invoice.date,
    invoiceValue: invoice.value,
  };
}

export function fromTrackingResponse(data) {
  const scans = Array.isArray(data?.scans) ? data.scans : [];

  const history = scans
    .map((scan) => {
      const occurredAt = parseCourierTimestamp(scan.statusDateTime);
      if (!occurredAt) return null; // an unparseable timestamp cannot be deduplicated, so skip it

      return {
        status: mapStatus(scan.statusCode),
        code: String(scan.statusCode ?? '').toUpperCase(),
        description: scan.statusCodeDescription ?? null,
        location: scan.currentLocation || null,
        occurredAt,
        raw: scan,
      };
    })
    .filter(Boolean);

  return {
    status: mapStatus(data?.currentStatusCode),
    currentLocation: data?.currentLocation || null,
    awbNumber: data?.awbNumber != null ? String(data.awbNumber) : null,
    estimatedDelivery: data?.edd ?? null,
    history,
  };
}
