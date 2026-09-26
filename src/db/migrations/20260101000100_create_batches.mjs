export async function up(knex) {
  await knex.schema.createTable('batches', (table) => {
    table.uuid('batch_id').primary();
    table.string('status', 20).notNullable();
    table.integer('total_count').notNullable().defaultTo(0);
    table.integer('success_count').notNullable().defaultTo(0);
    table.integer('failure_count').notNullable().defaultTo(0);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('completed_at', { useTz: true }).nullable();
  });

  await knex.schema.createTable('batch_items', (table) => {
    table.bigIncrements('id').primary();
    table.uuid('batch_id').notNullable().references('batch_id').inTable('batches').onDelete('CASCADE');

    // Keyed by position, not by order_id: the same order_id can legitimately appear twice in
    // one submission, and each occurrence still needs its own reported outcome.
    table.integer('item_index').notNullable();
    table.string('order_id', 64).nullable();

    table.string('status', 20).notNullable();
    table.string('error_code', 64).nullable();
    table.text('error_message').nullable();
    table.string('awb_number', 64).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['batch_id', 'item_index']);
    table.index(['batch_id']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('batch_items');
  await knex.schema.dropTableIfExists('batches');
}
