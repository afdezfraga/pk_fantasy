/**
 * Builds a throwaway database for the integration tests and fills it with a small, fixed
 * catalog. Deliberately not the real roster: the tests should fail because the logic broke,
 * not because Garchomp changed tier.
 */

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = join(ROOT, 'prisma/test.db');

export const TEST_POKEMON = [
  { slug: 'incineroar', name: 'Incineroar', tier: 'S', baseValue: 120_000, bst: 530 },
  { slug: 'garchomp', name: 'Garchomp', tier: 'S', baseValue: 132_000, bst: 700 },
  { slug: 'whimsicott', name: 'Whimsicott', tier: 'S', baseValue: 115_500, bst: 480 },
  { slug: 'torkoal', name: 'Torkoal', tier: 'A', baseValue: 70_000, bst: 470 },
  { slug: 'sableye', name: 'Sableye', tier: 'A+', baseValue: 88_000, bst: 380 },
  { slug: 'pikachu', name: 'Pikachu', tier: 'UR', baseValue: 6_000, bst: 320 },
  { slug: 'ditto', name: 'Ditto', tier: 'UR', baseValue: 6_000, bst: 288 },
  { slug: 'furfrou', name: 'Furfrou', tier: 'UR', baseValue: 8_000, bst: 472 },
  { slug: 'delibird', name: 'Delibird', tier: 'UR', baseValue: 6_000, bst: 330 },
  { slug: 'luvdisc', name: 'Luvdisc', tier: 'UR', baseValue: 6_000, bst: 330 },
];

export async function setup() {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }

  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
    stdio: 'pipe',
  });

  const db = new PrismaClient({ datasources: { db: { url: 'file:./test.db' } } });
  await db.pokemon.createMany({
    data: TEST_POKEMON.map((pokemon) => ({
      slug: pokemon.slug,
      dex: 1,
      name: pokemon.name,
      form: null,
      types: JSON.stringify(['Normal']),
      bst: pokemon.bst,
      effectiveBst: pokemon.bst,
      tier: pokemon.tier,
      baseValue: pokemon.baseValue,
      spriteUrl: null,
      megas: '[]',
      alternateForms: '[]',
      legal: true,
      notes: null,
      versionAdded: '1.0.0',
    })),
  });
  await db.$disconnect();
}

export async function teardown() {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(`${DB_FILE}${suffix}`, { force: true });
  }
}
