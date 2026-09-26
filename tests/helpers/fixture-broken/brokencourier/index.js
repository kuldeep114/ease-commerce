// Deliberately incomplete: cancelShipment is missing, so the registry must reject it at boot.
export default {
  name: 'brokencourier',
  displayName: 'Broken Courier',

  async createShipment() {
    return {};
  },
  async trackShipment() {
    return {};
  },
};
