import { createClient } from '@libsql/client';
import { applyMigrations } from './src/db/manual-migrate.ts';
import { pathToFileURL } from 'node:url';

const dbUrl = pathToFileURL('./kanban.db').href;
console.log('Creating database at:', dbUrl);

const client = createClient({ url: dbUrl });

try {
  console.log('Applying migrations...');
  await applyMigrations(client);
  console.log('✓ Migrations applied successfully');

  // Verify tables were created
  const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const tables = result.rows.map(r => r.name);
  console.log(`✓ Created ${tables.length} tables:`, tables.join(', '));
} catch (e) {
  console.error('✗ Error:', e.message);
  process.exit(1);
} finally {
  client.close();
}
