/**
 * League lifecycle: creation, joining, and the config that governs everything downstream.
 */

import { randomInt } from 'node:crypto';

import { LEAGUE_DEFAULTS, type LeagueConfig } from '../../config/economy.ts';
import { SEASON_START, rungNumber } from '../ladder.ts';
import { db } from '../db.ts';
import { standingColumns } from './ladder.ts';
import { audit } from './money.ts';
import { parseConfig } from './ownership.ts';

/** Ambiguous characters (O/0, I/1) are omitted — these get read aloud and typed on phones. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateInviteCode(length = 6): string {
  let code = '';
  for (let i = 0; i < length; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export class LeagueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeagueError';
  }
}

/**
 * Creates a league and materialises an `Ownership` row for every legal Pokémon.
 *
 * Pre-creating the rows is what lets acquisition be a guarded UPDATE rather than an upsert:
 * the row always exists, so claiming a Pokémon is "change the owner from null to me", which
 * either matches one row or none. ~247 rows per league is nothing.
 */
export async function createLeague(input: {
  name: string;
  commissionerId: string;
  teamName: string;
  config?: Partial<LeagueConfig>;
}) {
  const config: LeagueConfig = { ...LEAGUE_DEFAULTS, ...input.config };
  const problem = checkBoardSettings(config);
  if (problem) throw new LeagueError(problem);

  const catalog = await db.pokemon.findMany({
    where: { legal: true },
    select: { slug: true, baseValue: true },
  });
  if (catalog.length === 0) {
    throw new LeagueError('The Pokémon catalog is empty — run `npm run db:seed` first.');
  }

  // Retry on the vanishingly unlikely invite-code collision rather than failing the request.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const inviteCode = generateInviteCode();
    try {
      return await db.$transaction(async (tx) => {
        const league = await tx.league.create({
          data: {
            name: input.name,
            inviteCode,
            commissionerId: input.commissionerId,
            config: JSON.stringify(config),
            status: 'SETUP',
          },
        });

        await tx.ownership.createMany({
          data: catalog.map((pokemon) => ({
            leagueId: league.id,
            pokemonSlug: pokemon.slug,
            teamId: null,
            status: 'FREE_AGENT',
            marketValue: pokemon.baseValue,
          })),
        });

        const team = await createTeamRow(tx, league.id, input.commissionerId, input.teamName, config);
        return { league, team };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'inviteCode') && attempt < 4) continue;
      throw error;
    }
  }
  throw new LeagueError('Could not generate a unique invite code. Try again.');
}

/** The event board's dials: the ones a league chooses at creation and may change afterwards. */
export type BoardSettings = Pick<LeagueConfig, 'eventBoardHours' | 'eventBoardSize' | 'eventBidMax'>;

/**
 * Checks the board's dials, in words a commissioner can act on.
 *
 * The limits are generous on purpose — a league that wants a board a week, or one event at a
 * time, is making a choice about its own pace — and only rule out the settings that would stop
 * the board working: a board that closes before anybody could bid, one with nothing on it, or
 * a ceiling of nothing, which turns every auction into a race to volunteer.
 */
export function checkBoardSettings(settings: BoardSettings): string | null {
  const { eventBoardHours: hours, eventBoardSize: size, eventBidMax: max } = settings;
  if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 14) {
    return 'The board has to stay open for between 1 hour and 14 days.';
  }
  if (!Number.isInteger(size) || size < 1 || size > 6) {
    return 'Put between 1 and 6 events on each board.';
  }
  if (!Number.isInteger(max) || max < 1_000 || max > 10_000_000) {
    return 'The most a club may ask has to be between ₽1,000 and ₽10,000,000.';
  }
  return null;
}

/**
 * The commissioner changing the board's dials once the league is under way.
 *
 * Takes effect from the next board, not the one on show: its close time is published and
 * clubs have bid against it, and a ceiling lowered under a bid already placed would leave that
 * bid standing above the rule. Merged into the stored config rather than replacing it, so the
 * league keeps every other setting it was created with.
 */
export async function updateBoardSettings(input: {
  leagueId: string;
  actorUserId: string;
  settings: BoardSettings;
}) {
  const league = await db.league.findUnique({ where: { id: input.leagueId } });
  if (!league) throw new LeagueError('League not found.');
  if (league.commissionerId !== input.actorUserId) {
    throw new LeagueError('Only the commissioner can change the league settings.');
  }
  const problem = checkBoardSettings(input.settings);
  if (problem) throw new LeagueError(problem);

  const config = { ...JSON.parse(league.config), ...input.settings };
  await db.$transaction(async (tx) => {
    await tx.league.update({ where: { id: league.id }, data: { config: JSON.stringify(config) } });
    await audit(tx, {
      leagueId: league.id,
      actorUserId: input.actorUserId,
      action: 'SETTINGS',
      detail: { ...input.settings },
    });
  });
  return parseConfig(JSON.stringify(config));
}

export async function joinLeague(input: { inviteCode: string; userId: string; teamName: string }) {
  const league = await db.league.findUnique({
    where: { inviteCode: input.inviteCode.trim().toUpperCase() },
  });
  if (!league) throw new LeagueError('No league found with that invite code.');

  if (league.status !== 'SETUP') {
    throw new LeagueError(
      league.status === 'DRAFTING'
        ? 'That league is already drafting — ask the commissioner to add you.'
        : 'That league has already started.',
    );
  }

  const existing = await db.team.findUnique({
    where: { leagueId_userId: { leagueId: league.id, userId: input.userId } },
  });
  if (existing) return { league, team: existing, alreadyJoined: true };

  const config = parseConfig(league.config);
  const team = await db.$transaction((tx) =>
    createTeamRow(tx, league.id, input.userId, input.teamName, config),
  );

  return { league, team, alreadyJoined: false };
}

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

async function createTeamRow(
  tx: Tx,
  leagueId: string,
  userId: string,
  name: string,
  config: LeagueConfig,
) {
  const teamCount = await tx.team.count({ where: { leagueId } });

  const team = await tx.team.create({
    data: {
      leagueId,
      userId,
      name: name.trim(),
      cash: config.startingCash,
      waiverPriority: teamCount,
      // Where the game starts everybody. Set here as well as in the schema so a league joined
      // mid-way through a later season starts in the same place as everyone else did.
      ...standingColumns(SEASON_START),
      bestRung: rungNumber(SEASON_START),
    },
  });

  // The starting balance is a ledger entry like any other, so `verifyLedger` stays true from
  // the very first row rather than treating the opening balance as a special case.
  await tx.transaction.create({
    data: {
      leagueId,
      teamId: team.id,
      type: 'ADJUSTMENT',
      amount: config.startingCash,
      balanceAfter: config.startingCash,
      description: 'Opening balance',
      // A league is on round 1 from the moment it is created — through setup and the draft, and
      // on into play — so there is never a point where something happens outside a round.
      round: 1,
    },
  });

  return team;
}

function isUniqueViolation(error: unknown, field: string): boolean {
  const target = (error as { code?: string; meta?: { target?: string[] | string } })?.meta?.target;
  return (
    (error as { code?: string })?.code === 'P2002' &&
    (Array.isArray(target) ? target.includes(field) : target === field)
  );
}

/** League with the bits nearly every page needs. */
export async function getLeagueContext(leagueId: string, userId: string) {
  const league = await db.league.findUnique({
    where: { id: leagueId },
    include: {
      teams: { include: { user: true }, orderBy: { createdAt: 'asc' } },
      draft: true,
    },
  });
  if (!league) return null;

  const myTeam = league.teams.find((team) => team.userId === userId) ?? null;
  return {
    league,
    myTeam,
    isCommissioner: league.commissionerId === userId,
    config: parseConfig(league.config),
  };
}
