import { db } from '../src/db/knex.js';

// A tiny script instead of the knex CLI: the CLI loads knexfile.js with require(), which does
// not work in an ESM package. This also keeps `npm run migrate` identical on every platform.
const command = process.argv[2] ?? 'latest';

try {
  if (command === 'latest') {
    const [batch, applied] = await db.migrate.latest();
    console.log(applied.length === 0 ? 'Already up to date.' : `Batch ${batch} applied:\n  ${applied.join('\n  ')}`);
  } else if (command === 'rollback') {
    const [batch, reverted] = await db.migrate.rollback();
    console.log(reverted.length === 0 ? 'Nothing to roll back.' : `Batch ${batch} rolled back:\n  ${reverted.join('\n  ')}`);
  } else {
    console.error(`Unknown command "${command}". Use "latest" or "rollback".`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`Migration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
