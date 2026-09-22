/** Read-only: renders the new templates against a real club, to see how they actually read. */
import { db } from '../lib/db.ts';
import { loadDeck, materialise } from '../lib/services/events.ts';
import { buildContext } from '../lib/services/triggers.ts';

const KEYS = ['swap_offer', 'release_for_two', 'sponsor_target', 'appearance_fee', 'league_bond', 'the_book_on_you'];

const league = await db.league.findFirstOrThrow({ where: { status: 'ACTIVE' }, include: { teams: true } });
const team = league.teams[0];
const context = await buildContext(league.id, team.id);
if (!context) throw new Error('no context');

console.log(`${league.name} — ${team.name} (${context.tierKey}, ₽${context.cash.toLocaleString()}, squad ${context.squadSize}, room ${context.squadRoom}, ${context.freeAgents.length} free agents)\n`);

for (const key of KEYS) {
  const template = loadDeck().find((entry) => entry.key === key)!;
  const offer = materialise(template, context, null, () => 0.42);
  console.log(`━━ ${template.title}`);
  console.log(`   ${offer.description}`);
  for (const option of offer.options) {
    const price = option.cost > 0 ? ` [₽${option.cost.toLocaleString()}]` : '';
    const shut = option.available ? '' : `  ✗ ${option.unavailableReason}`;
    console.log(`   • ${option.label}${price}${shut}`);
    console.log(`     ${option.detail}`);
  }
  console.log();
}
await db.$disconnect();
