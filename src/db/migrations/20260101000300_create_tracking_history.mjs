export async function up(knex) {
  await knex.schema.createTable('tracking_history', (table) => {
    table.bigIncrements('id').primary();
    table.uuid('order_id').notNullable().references('id').inTable('orders').onDelete('CASCADE');

    table.string('status', 20).notNullable();
    table.string('courier_status_code', 32).notNullable();
    table.text('courier_status_description').nullable();
    table.string('location', 120).nullable();
    table.timestamp('occurred_at', { useTz: true }).notNullable();
    table.jsonb('raw_payload').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Tracking is polled, so the courier replays its whole scan list on every call. This
    // constraint lets the repository insert-and-ignore, keeping the table append-only without
    // accumulating duplicates of scans already recorded.
    table.unique(['order_id', 'courier_status_code', 'occurred_at']);
    table.index(['order_id', 'occurred_at']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('tracking_history');
}
