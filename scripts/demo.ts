/**
 * Builds a ready-to-poke demo league, so you can see a populated app without spending twenty
 * minutes creating accounts and clicking through a draft.
 *
 *   npm run db:demo          add a demo league
 *   npm run db:demo -- --reset   wipe every league and user first, then add it
 *
 * Creates three players (password `champions`), drafts them a squad each, sets their ladder
 * ranks, logs some ladder matches and closes a round — so the market, standings, activity feed
 * and Pokémon values all have something in them.
 *
 * Safe to delete: it only ever touches leagues named "Demo League" and users named `demo-*`
 * unless you pass --reset.
 */

import { PrismaClient } from '@prisma/client';

import { hashPassword } from '../lib/auth/password.ts';
import { createLeague, joinLeague } from '../lib/services/league.ts';
import { getDraftState, makePick, startDraft } from '../lib/services/draft.ts';
import { reportMatch } from '../lib/services/matches.ts';
import { updateStanding } from '../lib/services/ladder.ts';
import { advanceRound } from '../lib/services/rounds.ts';

const db = new PrismaClient();
const reset = process.argv.includes('--reset');

const PASSWORD = 'champions';
const PLAYERS = [
  { username: 'demo-alex', displayName: 'Alex', team: 'Pallet Pidgeots' },
  { username: 'demo-dani', displayName: 'Dani', team: 'Cerulean Gyarados' },
  { username: 'demo-sam', displayName: 'Sam', team: 'Viridian Vees' },
];

/** Spreads a team's budget across its remaining picks instead of blowing it on pick one. */
async function pickSensibly(leagueId: string, teamId: string, userId: string, picksLeft: number) {
  const team = await db.team.findUniqueOrThrow({ where: { id: teamId } });

  // Leave something for the picks still to come, so the squad ends up balanced rather than
  // one star and nothing else.
  const budget = team.cash / Math.max(picksLeft, 1);

  const candidate =
    (await db.ownership.findFirst({
      where: { leagueId, teamId: null, pokemon: { legal: true }, marketValue: { lte: Math.floor(budget) } },
      orderBy: { marketValue: 'desc' },
    })) ??
    (await db.ownership.findFirst({
      where: { leagueId, teamId: null, pokemon: { legal: true } },
      orderBy: { marketValue: 'asc' },
    }));

  if (!candidate) return null;
  if (candidate.marketValue > team.cash) return null;

  return makePick({ leagueId, teamId, pokemonSlug: candidate.pokemonSlug, actorUserId: userId });
}

async function main() {
  if ((await db.pokemon.count()) === 0) {
    throw new Error('The Pokémon catalog is empty — run `npm run db:seed` first.');
  }

  if (reset) {
    await db.league.deleteMany({});
    await db.user.deleteMany({});
    console.log('Wiped all leagues and users.');
  } else {
    const existing = await db.league.findMany({ where: { name: 'Demo League' } });
    for (const league of existing) await db.league.delete({ where: { id: league.id } });
    await db.user.deleteMany({ where: { username: { startsWith: 'demo-' } } });
    if (existing.length > 0) console.log('Replaced the previous demo league.');
  }

  const passwordHash = await hashPassword(PASSWORD);
  const users: { id: string }[] = [];
  for (const player of PLAYERS) {
    users.push(
      await db.user.create({
        data: { username: player.username, displayName: player.displayName, passwordHash },
      }),
    );
  }

  const { league } = await createLeague({
    name: 'Demo League',
    commissionerId: users[0].id,
    teamName: PLAYERS[0].team,
  });

  const teams = [await db.team.findFirstOrThrow({ where: { leagueId: league.id, userId: users[0].id } })];
  for (let i = 1; i < users.length; i += 1) {
    const joined = await joinLeague({
      inviteCode: league.inviteCode,
      userId: users[i].id,
      teamName: PLAYERS[i].team,
    });
    teams.push(joined.team);
  }
  console.log(`Created "Demo League" (invite code ${league.inviteCode}) with ${teams.length} teams.`);

  // --- draft ---
  const rounds = 6;
  await startDraft({ leagueId: league.id, actorUserId: users[0].id, rounds });

  const userByTeam = new Map(teams.map((team, index) => [team.id, users[index].id]));
  for (let guard = 0; guard < rounds * teams.length + 10; guard += 1) {
    const state = await getDraftState(league.id);
    if (!state || state.isComplete) break;

    const { teamId } = state.onTheClock!;
    const picksLeft = rounds - Math.floor(state.draft.cursor / teams.length);
    const result = await pickSensibly(league.id, teamId, userByTeam.get(teamId)!, picksLeft);
    if (!result) break; // auto-skip will move the cursor on the next read
  }

  const squads = await db.ownership.groupBy({
    by: ['teamId'],
    where: { leagueId: league.id, teamId: { not: null } },
    _count: { _all: true },
  });
  console.log(`Drafted: ${squads.map((row) => row._count._all).join(', ')} Pokémon per team.`);

  // --- ladder standings ---
  const standings = [
    { tierKey: 'ultra', rank: 2, progress: 3, ratingPoints: null, globalPlacement: null },
    { tierKey: 'great', rank: 1, progress: 2, ratingPoints: null, globalPlacement: null },
    { tierKey: 'master', rank: 4, progress: 0, ratingPoints: 1703.462, globalPlacement: 123329 },
  ];
  for (const [index, team] of teams.entries()) {
    await updateStanding({
      leagueId: league.id,
      teamId: team.id,
      standing: standings[index],
      actorUserId: users[index].id,
    });
  }
  console.log('Set ladder ranks: Ultra Ball 2, Great Ball 1, Master Ball 4.');

  // --- some ladder matches ---
  let played = 0;
  for (const [index, team] of teams.entries()) {
    // Only the starting lineup can be reported, and a match takes four of them.
    const squad = await db.ownership.findMany({
      where: { leagueId: league.id, teamId: team.id, starter: true },
      orderBy: { marketValue: 'desc' },
      take: 4,
    });
    if (squad.length === 0) continue;

    // A different record each, so the standings and the Pokémon values have something to chew on.
    const results = [[2, 0], [2, 1], [1, 2], [2, 0]].slice(0, 2 + index);
    for (const [mine, theirs] of results) {
      await reportMatch({
        leagueId: league.id,
        homeTeamId: team.id,
        awayTeamId: null,
        opponentName: 'Ranked ladder',
        homeScore: mine,
        awayScore: theirs,
        lines: squad.map((row, i) => ({
          pokemonSlug: row.pokemonSlug,
          teamId: team.id,
          kos: mine > theirs ? (i === 0 ? 2 : 1) : 0,
          fainted: mine > theirs ? i === 3 : i < 2,
          benched: false,
        })),
        reportedById: users[index].id,
      });
      played += 1;
    }
  }
  console.log(`Logged ${played} ladder matches.`);

  // --- close a round, so the pay cap starts again ---
  const round = await advanceRound({ leagueId: league.id, actorUserId: users[0].id });
  console.log(`Closed round ${round.round} — waivers cleared, match pay reset.`);

  console.log('\n─── Sign in with any of these ───');
  for (const player of PLAYERS) {
    console.log(`  ${player.username.padEnd(11)} / ${PASSWORD}   (${player.team})`);
  }
  console.log(`\n  ${PLAYERS[0].username} is the commissioner — only they can close a round.`);
  console.log(`  Invite code for a fourth player: ${league.inviteCode}`);
  console.log('\n  npm run dev   →   http://localhost:3000');
}

main()
  .catch((error) => {
    console.error(`\nDemo setup failed: ${error.message}`);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
