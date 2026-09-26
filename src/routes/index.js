import { Router } from 'express';

import { listCouriers } from '../couriers/registry.js';
import { orderRoutes } from './order.routes.js';
import { success } from '../utils/response.js';

export const apiRoutes = Router();

apiRoutes.use('/orders', orderRoutes);

// Reads straight from the registry, so a newly added adapter appears here with no code change.
apiRoutes.get('/couriers', (req, res) => {
  res.json(success(req, { couriers: listCouriers() }));
});
