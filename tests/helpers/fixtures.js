let sequence = 0;

/** A valid normalized order. Override any field to build the case under test. */
export function makeOrder(overrides = {}) {
  sequence += 1;

  return {
    courier_partner: 'mock',
    order_id: `TEST-${Date.now()}-${sequence}`,
    service_type: 'SDD',
    payment_mode: 'COD',
    shipment: {
      weight_kg: 1.1,
      dimensions_cm: { length: 12, breadth: 10, height: 10 },
      pieces: 1,
      declared_value: 100,
      collectable_value: 500,
      item_description: 'BOOKS',
      item_quantity: 1,
    },
    invoice: { number: 'INV-0002', date: '2026-09-20', value: 500 },
    pickup: {
      name: 'Rohit Athaley',
      phone: '9425018023',
      email: 'seller@example.com',
      address_line: 'Plot 137-138, Sector-I, Govindpura',
      address_type: 'Seller',
      city: 'Bhopal',
      state: 'Madhya Pradesh',
      pincode: '122017',
      country: 'INDIA',
    },
    delivery: {
      name: 'Satyam School',
      phone: '8320226438',
      email: 'buyer@example.com',
      address_line: 'Plot 26-27, Om Nagar Society, Sumbhal',
      address_type: 'Home',
      city: 'Surat',
      state: 'Gujarat',
      pincode: '122001',
      country: 'INDIA',
    },
    ...overrides,
  };
}

export const API_KEY = 'test-api-key';
