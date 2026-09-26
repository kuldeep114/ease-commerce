import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateAdapter } from './base-courier.js';
import { courierConfig } from '../config/couriers.js';
import { AppError } from '../errors/app-error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { logger } from '../utils/logger.js';

const COURIERS_DIR = path.dirname(fileURLToPath(import.meta.url));

const adapters = new Map();

/**
 * Discovers adapters by scanning this directory at boot.
 *
 * This is the mechanism behind requirement 3.2: onboarding a courier means dropping in a folder
 * that exports the contract and setting its env vars. No route, DTO, service or existing
 * adapter is touched — there is no central list to append to, including here.
 */
export async function loadCouriers({ dir = COURIERS_DIR } = {}) {
  adapters.clear();

  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const source = `couriers/${entry.name}`;
    const modulePath = pathToFileURL(path.join(dir, entry.name, 'index.js')).href;
    const adapter = validateAdapter((await import(modulePath)).default, source);

    const settings = courierConfig(adapter.name);
    if (!settings.enabled) {
      logger.info({ courier: adapter.name }, 'Courier adapter disabled by configuration, skipping');
      continue;
    }

    adapter.init?.(settings);
    adapters.set(adapter.name, adapter);
    logger.info({ courier: adapter.name, baseUrl: settings.baseUrl }, 'Courier adapter registered');
  }

  if (adapters.size === 0) {
    logger.warn('No courier adapters are enabled — every create request will be rejected');
  }
  return listCourierNames();
}

export function getCourier(name) {
  const adapter = adapters.get(String(name ?? '').toLowerCase());
  if (!adapter) {
    throw new AppError(ErrorCode.UNSUPPORTED_COURIER, `Unsupported courier_partner: "${name}"`, {
      details: { supported_couriers: listCourierNames() },
    });
  }
  return adapter;
}

export function listCourierNames() {
  return [...adapters.keys()].sort();
}

export function listCouriers() {
  return listCourierNames().map((name) => ({
    courier_partner: name,
    display_name: adapters.get(name).displayName ?? name,
  }));
}
