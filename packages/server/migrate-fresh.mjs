import { applyMigrations } from './src/db/manual-migrate.ts';
// Use the shared pragma factory so this entry point runs migrations with the SAME
// connection semantics as the live server (foreign_keys=ON). Previously this used a
// bare createClient — FK OFF — which silently diverged from the runner: FK-toggling
// migrations (0010/0039/0096) behaved differently here than in production. (arch-review §3.1)
import { createClientWithPragmas } from './src/db/pragmas.ts';
// #854: route through the shared resolver, never a CWD-relative './kanban.db'.
// The old `pathToFileURL('./kanban.db')` CREATED a brand-new packages/server/kanban.db
// when run from this directory — the same shadow-DB minting that drizzle.config.ts
// was cured of (see its header): once such a file exists, naive existence probes
// adopt it instead of the real home-fallback DB.
import { getDbUrl } from './src/db/data-dir.ts';

const dbUrl = getDbUrl();
console.log('Migrating database at:', dbUrl);

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
