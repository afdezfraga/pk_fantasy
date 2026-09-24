/** Read-only: renders one template (by key) against a real club, for review. */
import { db } from '../lib/db.ts';
import { loadDeck, materialise } from '../lib/services/events.ts';
import { buildContext } from '../lib/services/triggers.ts';

const [keyArg, leagueArg, teamArg] = process.argv.slice(2);

const league = await db.league.findFirstOrThrow({
  where: leagueArg ? { name: { contains: leagueArg } } : { status: 'ACTIVE' },
  include: { teams: true },
});
const team = teamArg ? league.teams.find((t) => t.name.includes(teamArg))! : league.teams[0];
const context = await buildContext(league.id, team.id);
if (!context) throw new Error('no context');

const deck = loadDeck();
const keys = keyArg === 'all' ? deck.map((t) => t.key) : keyArg.split(',');

console.log(`${league.name} — ${team.name} (${context.tierKey}, P${context.cash.toLocaleString()}, squad ${context.squadSize}, room ${context.squadRoom}, ${context.freeAgents.length} free agents, ladder ${context.ladderPosition}/${context.teamCount}, played ${context.matchesPlayed}, W${context.winStreak}/L${context.losingStreak})`);
console.log(`squad: ${context.squad.map((m) => `${m.name}${m.captain ? '(C)' : ''}${m.starter ? '' : '[bench]'} P${m.marketValue.toLocaleString()}`).join(', ')}\n`);

for (const key of keys) {
  const t = deck.find((e) => e.key === key);
  if (!t) { console.log(`?? unknown key ${key}`); continue; }
  const n = deck.indexOf(t) + 1;
  console.log(`━━ ${n}/${deck.length}  ${t.title}   [${t.key}]`);
  console.log(`   scope ${t.scope} · weight ${t.weight} · cooldown ${t.cooldown ?? 0}${t.severityMult ? ` · severityMult ${JSON.stringify(t.severityMult)}` : ''}${t.target ? ` · target ${t.target}` : ''}`);
  if (t.requires) console.log(`   requires ${JSON.stringify(t.requires)}`);
  if (t.trigger) console.log(`   trigger  ${JSON.stringify(t.trigger)}`);
  if (t.virtue) console.log(`   virtue @${t.virtueChance ?? 8}%: ${t.virtue.title}`);
  const offer = materialise(t, context, context.benched?.pokemonSlug ?? null, () => 0.42);
  console.log(`\n   "${offer.description}"\n`);
  for (const o of offer.options) {
    console.log(`   • ${o.label}${o.cost > 0 ? `  [P${o.cost.toLocaleString()}]` : ''}${o.default ? '  (default)' : ''}${o.available ? '' : `   UNAVAILABLE: ${o.unavailableReason}`}`);
    console.log(`     ${o.detail}`);
    for (const e of o.effects) {
      const dur = e.matches ? `${e.matches} matches` : e.events ? `${e.events} events` : e.rounds ? `${e.rounds} rounds` : 'instant';
      console.log(`       → ${e.kind}${e.pokemonSlug ? ` (${e.pokemonSlug})` : ''} ${dur} ${JSON.stringify(e.params)}`);
      if (e.label) console.log(`         in force: "${e.label}"`);
      if (e.liftedMessage) console.log(`         lifts:    "${e.liftedMessage}"`);
    }
  }
  if (t.virtue) {
    const v = materialise({ ...t, options: [{ key: 'virtue', label: 'virtue', detail: '', effects: t.virtue.effects }], description: t.virtue.description }, context, context.benched?.pokemonSlug ?? null, () => 0.42);
    console.log(`   VIRTUE (${t.virtueChance ?? 8}% of draws) — ${t.virtue.title}`);
    console.log(`     "${v.description}"`);
    for (const e of v.options[0]?.effects ?? []) {
      const dur = e.matches ? `${e.matches} matches` : e.events ? `${e.events} events` : e.rounds ? `${e.rounds} rounds` : 'instant';
      console.log(`       → ${e.kind}${e.pokemonSlug ? ` (${e.pokemonSlug})` : ''} ${dur} ${JSON.stringify(e.params)}`);
      if (e.label) console.log(`         in force: "${e.label}"`);
    }
  }
  console.log();
}
await db.$disconnect();
