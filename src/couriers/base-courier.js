/**
 * The courier adapter contract.
 *
 * Everything courier-specific lives behind these three methods: payload shape, auth scheme,
 * status vocabulary, error wording. Nothing above this line — no route, DTO, service or other
 * adapter — knows which courier is in play.
 *
 * Two rules keep adapters replaceable:
 *
 *  1. Adapters are stateless and never touch the database. They translate and call; the service
 *     decides what to persist. That is why every method returns `raw`.
 *  2. Adapters throw CourierError with a normalized ErrorCode, never a raw courier message as
 *     the user-facing text.
 *
 * @typedef {object} CourierAdapter
 * @property {string} name              identifier used as `courier_partner`, lowercase
 * @property {string} displayName
 * @property {(settings: object) => void} [init]   receives its `<NAME>_*` config at boot
 * @property {(order: object) => Promise<CreateResult>} createShipment
 * @property {(awb: string) => Promise<TrackResult>} trackShipment
 * @property {(awb: string) => Promise<CancelResult>} cancelShipment
 *
 * @typedef {object} CreateResult
 * @property {string} awbNumber
 * @property {string|null} courierOrderId
 * @property {string|null} labelUrl
 * @property {object} request  exact body sent to the courier, for the audit trail
 * @property {object} raw      exact body received from the courier
 *
 * @typedef {object} TrackResult
 * @property {string} status                 normalized ShipmentStatus
 * @property {string|null} currentLocation
 * @property {Array<TrackEvent>} history
 * @property {object} raw
 *
 * @typedef {object} TrackEvent
 * @property {string} status
 * @property {string} code
 * @property {string} description
 * @property {string|null} location
 * @property {Date} occurredAt
 * @property {object} raw
 *
 * @typedef {object} CancelResult
 * @property {boolean} cancelled
 * @property {string} message
 * @property {object} raw
 */

export const REQUIRED_METHODS = ['createShipment', 'trackShipment', 'cancelShipment'];

/**
 * Checked by the registry at boot, so a half-finished adapter stops the process on startup
 * rather than throwing on a customer's request at 2am.
 */
export function validateAdapter(adapter, source) {
  const problems = [];

  if (!adapter || typeof adapter !== 'object') {
    problems.push('must export a default object');
  } else {
    if (typeof adapter.name !== 'string' || adapter.name.trim() === '') {
      problems.push('is missing a non-empty "name"');
    } else if (adapter.name !== adapter.name.toLowerCase()) {
      problems.push(`has a non-lowercase name "${adapter.name}"`);
    }
    for (const method of REQUIRED_METHODS) {
      if (typeof adapter[method] !== 'function') problems.push(`is missing ${method}()`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid courier adapter at ${source}: it ${problems.join(', ')}.`);
  }
  return adapter;
}
