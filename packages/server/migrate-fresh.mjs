import { applyMigrations } from './src/db/manual-migrate.ts';
// Use the shared pragma factory so this entry point runs migrations with the SAME
// connection semantics as the live server (foreign_keys=ON). Previously this used a
// bare createClient — FK OFF — which silently diverged from the runner: FK-toggling
// migrations (0010/0039/0096) behaved differently here than in production. (arch-review §3.1)
import { createClientWithPragmas } from './src/db/pragmas.ts';
import { pathToFileURL } from 'node:url';

const dbUrl = pathToFileURL('./kanban.db').href;
console.log('Creating database at:', dbUrl);

const client = await createClientWithPragmas(dbUrl);

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
