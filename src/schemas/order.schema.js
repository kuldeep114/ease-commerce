import { z } from 'zod';

import { config } from '../config/index.js';

const addressSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().regex(/^\d{10}$/, 'must be a 10-digit phone number'),
  email: z.string().trim().email('must be a valid email address').optional(),
  address_line: z.string().trim().min(1).max(500),
  address_type: z.enum(['Seller', 'Home', 'Office', 'Warehouse']).default('Home'),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  pincode: z.string().trim().regex(/^\d{6}$/, 'must be a 6-digit pincode'),
  country: z.string().trim().min(1).max(60).default('INDIA'),
});

const shipmentSchema = z.object({
  weight_kg: z.number().positive('must be greater than 0'),
  dimensions_cm: z.object({
    length: z.number().positive(),
    breadth: z.number().positive(),
    height: z.number().positive(),
  }),
  pieces: z.number().int().positive().default(1),
  declared_value: z.number().nonnegative(),
  collectable_value: z.number().nonnegative().default(0),
  item_description: z.string().trim().min(1).max(200),
  item_quantity: z.number().int().positive().default(1),
});

const invoiceSchema = z.object({
  number: z.string().trim().min(1).max(50),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)'),
  value: z.number().nonnegative(),
});

/**
 * The platform's own order contract. It is intentionally nested and readable rather than
 * mirroring any courier's wire format — translating to `shprPincode` and friends is the
 * adapter's job, not the consumer's.
 *
 * `.strict()` rejects unknown keys so a typo like `delivery_pincode` fails loudly instead of
 * being silently dropped on the way to the courier.
 */
export const createOrderSchema = z
  .object({
    courier_partner: z.string().trim().min(1, 'courier_partner is required'),
    order_id: z.string().trim().min(1).max(64),
    service_type: z.string().trim().min(1).max(20).default('SDD'),
    payment_mode: z.enum(['COD', 'PPD']),
    shipment: shipmentSchema,
    invoice: invoiceSchema,
    pickup: addressSchema,
    delivery: addressSchema,
    return_to: addressSchema.optional(),
  })
  .strict()
  // A cash-on-delivery shipment with nothing to collect is always a caller mistake, and one the
  // courier would only surface as an unmappable message string.
  .refine((order) => order.payment_mode !== 'COD' || order.shipment.collectable_value > 0, {
    message: 'must be greater than 0 when payment_mode is COD',
    path: ['shipment', 'collectable_value'],
  });

export const bulkCreateSchema = z
  .object({
    // Items are intentionally not validated here. The envelope is checked first so a single
    // malformed order cannot reject the other ninety-nine; each item is parsed individually and
    // reported per-order in the batch result.
    orders: z
      .array(z.unknown())
      .min(1, 'at least one order is required')
      .max(config.bulk.maxOrders, `a batch may contain at most ${config.bulk.maxOrders} orders`),
  })
  .strict();
