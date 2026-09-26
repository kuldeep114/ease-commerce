// A minimal adapter used to prove the registry discovers any folder honouring the contract.
export default {
  name: 'goodcourier',
  displayName: 'Good Courier',
  initialisedWith: null,

  init(settings) {
    this.initialisedWith = settings;
  },

  async createShipment() {
    return { awbNumber: 'GOOD1', courierOrderId: 'GOOD1', labelUrl: null, request: {}, raw: {} };
  },
  async trackShipment() {
    return { status: 'IN_TRANSIT', currentLocation: null, history: [], raw: {} };
  },
  async cancelShipment() {
    return { cancelled: true, message: 'Cancelled', raw: {} };
  },
};
