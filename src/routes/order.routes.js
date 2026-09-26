import { Router } from 'express';

import * as orderController from '../controllers/order.controller.js';
import { bulkCreateSchema, createOrderSchema } from '../schemas/order.schema.js';
import { validateBody } from '../middleware/validate.js';

export const orderRoutes = Router();

// These routes are courier-agnostic and stay that way: `courier_partner` is just a field in the
// body, resolved to an adapter at the service layer. Onboarding a courier adds nothing here.

// Declared before "/:order_id" so the literal path is not swallowed by the parameter.
orderRoutes.post('/bulk', validateBody(bulkCreateSchema), orderController.createBulk);
orderRoutes.get('/bulk/:batch_id', orderController.getBulk);

orderRoutes.post('/', validateBody(createOrderSchema), orderController.create);
orderRoutes.get('/:order_id', orderController.get);
orderRoutes.get('/:order_id/track', orderController.track);
orderRoutes.post('/:order_id/cancel', orderController.cancel);
