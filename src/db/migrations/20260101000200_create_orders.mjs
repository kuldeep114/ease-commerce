export async function up(knex) {
  await knex.schema.createTable('orders', (table) => {
    table.uuid('id').primary();

    // The consumer's own identifier, and the platform's idempotency key. The UNIQUE constraint
    // is what makes "the same order_id must not create two shipments" a database guarantee
    // rather than an application-level check that races under concurrent submission.
    table.string('order_id', 64).notNullable().unique();

    table.string('courier_partner', 50).notNullable();
    table.string('courier_order_id', 100).nullable();
    table.string('awb_number', 64).nullable();
    table.string('status', 20).notNullable();
    table.text('label_url').nullable();

    // Full audit trail of the courier exchange, per requirement 3.3.
    table.jsonb('request_payload').nullable();
    table.jsonb('response_payload').nullable();

    table.text('failure_reason').nullable();
    table.integer('retry_count').notNullable().defaultTo(0);
    table.uuid('batch_id').nullable().references('batch_id').inTable('batches').onDelete('SET NULL');

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['awb_number']);
    table.index(['courier_partner', 'status']);
    table.index(['batch_id']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('orders');
}
