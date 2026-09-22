/**
 * Runs once per container start, after the schema is applied and before the server comes up.
 *
 * Seeding is *not* safe to do on every boot. `scripts/seed.ts` upserts the catalog, but it also
 * backfills free-agent Ownership rows into every existing league — which is right after a roster
 * rotation and wrong on a restart. So it runs only when the catalog is empty, i.e. exactly once,
 * on a fresh volume. A roster rotation is a deliberate `docker compose exec app npm run db:seed`.
 */

import { execFileSync } from 'node:child_process';

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const count = await db.pokemon.count();
await db.$disconnect();

if (count === 0) {
  console.log('==> empty catalog — seeding from data/roster.json');
  // Through node rather than the .bin shim, so neither the exec bit nor the shebang has to have
  // survived the image build. scripts/seed.ts resolves its own root from import.meta.url, which
  // is safe here precisely because tsx doesn't bundle — unlike webpack, it leaves the real file
  // URL in place.
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/seed.ts'], {
    stdio: 'inherit',
  });
} else {
  console.log(`==> catalog holds ${count} Pokémon — not seeding`);
}
