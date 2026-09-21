'use server';

import { revalidatePath } from 'next/cache';

import { requireUser } from '../../lib/auth/session.ts';
import { db } from '../../lib/db.ts';
import { deriveScore, LADDER_OPPONENT } from '../../lib/match.ts';
import { setLineup, setStarter } from '../../lib/services/lineup.ts';
import { ClubError, setCaptain, updateCrest } from '../../lib/services/club.ts';
import { InsufficientFunds } from '../../lib/services/money.ts';
import {
  acquireFreeAgent,
  OwnershipConflict,
  RosterRuleViolation,
  sellToMarket,
} from '../../lib/services/ownership.ts';
import { reportMatch, deleteMatch, MatchError } from '../../lib/services/matches.ts';
import { proposeTrade, respondToTrade, TradeError } from '../../lib/services/trades.ts';
import { advanceRound, RoundError } from '../../lib/services/rounds.ts';
import { updateStanding, LadderError } from '../../lib/services/ladder.ts';
import { getTier } from '../../lib/ladder.ts';
import { LeagueError } from '../../lib/services/league.ts';
import { DraftError } from '../../lib/services/draft.ts';

export interface ActionState {
  error?: string;
  success?: string;
}

const KNOWN_ERRORS = [
  ClubError,
  LeagueError,
  DraftError,
  MatchError,
  TradeError,
  RoundError,
  LadderError,
  OwnershipConflict,
  RosterRuleViolation,
  InsufficientFunds,
];

/** Domain errors become messages; anything else is a real bug and should surface as one. */
function toMessage(error: unknown): string {
  if (KNOWN_ERRORS.some((type) => error instanceof type)) return (error as Error).message;
  throw error;
}

/** The team the signed-in user manages in this league, or throws. */
async function myTeam(leagueId: string, userId: string) {
  const team = await db.team.findUnique({ where: { leagueId_userId: { leagueId, userId } } });
  if (!team) throw new LeagueError("You don't have a team in this league.");
  return team;
}

function refresh(leagueId: string) {
  for (const path of ['', '/market', '/squad', '/matches', '/trades']) {
    revalidatePath(`/league/${leagueId}${path}`);
  }
}

export async function buyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const pokemonSlug = String(formData.get('pokemonSlug') ?? '');

  try {
    const team = await myTeam(leagueId, user.id);
    // Signings always cost the shop price; an owned Pokémon's value is only what it sells for.
    const pokemon = await db.pokemon.findUniqueOrThrow({ where: { slug: pokemonSlug } });

    const result = await acquireFreeAgent({
      leagueId,
      pokemonSlug,
      teamId: team.id,
      price: pokemon.baseValue,
      type: 'MARKET_BUY',
      actorUserId: user.id,
    });
    refresh(leagueId);
    return { success: `Signed ${result.label}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function sellAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const pokemonSlug = String(formData.get('pokemonSlug') ?? '');

  try {
    const team = await myTeam(leagueId, user.id);
    const result = await sellToMarket({ leagueId, pokemonSlug, teamId: team.id, actorUserId: user.id });
    refresh(leagueId);
    return { success: `Released ${result.label} for ₽${result.proceeds.toLocaleString()}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function setStarterAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const pokemonSlug = String(formData.get('pokemonSlug') ?? '');
  const starter = String(formData.get('starter') ?? '') === '1';

  try {
    const team = await myTeam(leagueId, user.id);
    const result = await setStarter({
      leagueId,
      teamId: team.id,
      pokemonSlug,
      starter,
      actorUserId: user.id,
    });
    refresh(leagueId);
    return { success: result.starter ? `${result.label} starts.` : `${result.label} benched.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

/** The drag-and-drop board posts the whole arrangement: `starters` and `reserves`, in order. */
export async function saveLineupAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');

  try {
    const team = await myTeam(leagueId, user.id);
    await setLineup({
      leagueId,
      teamId: team.id,
      starters: formData.getAll('starters').map(String),
      reserves: formData.getAll('reserves').map(String),
      actorUserId: user.id,
    });
    refresh(leagueId);
    return { success: 'Lineup saved.' };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function setCaptainAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const pokemonSlug = String(formData.get('pokemonSlug') ?? '') || null;

  try {
    const team = await myTeam(leagueId, user.id);
    await setCaptain({ leagueId, teamId: team.id, pokemonSlug });
    refresh(leagueId);
    return { success: pokemonSlug ? 'Armband handed over.' : 'Armband removed.' };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function updateCrestAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');

  try {
    const team = await myTeam(leagueId, user.id);
    const upload = formData.get('image');
    const file = upload instanceof File && upload.size > 0 ? upload : null;

    await updateCrest({
      teamId: team.id,
      userId: user.id,
      shape: String(formData.get('shape') ?? 'shield'),
      primary: String(formData.get('primary') ?? ''),
      secondary: String(formData.get('secondary') ?? ''),
      emblem: String(formData.get('emblem') ?? '') || null,
      initials: String(formData.get('initials') ?? '') || null,
      image: file ? new Uint8Array(await file.arrayBuffer()) : null,
      removeImage: String(formData.get('removeImage') ?? '') === '1',
    });
    refresh(leagueId);
    return { success: 'Crest saved.' };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function reportMatchAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const homeTeamId = String(formData.get('homeTeamId') ?? '');
  const won = String(formData.get('won') ?? '') === '1';
  const note = String(formData.get('note') ?? '');

  // Lines arrive as `line:<teamId>:<slug>` = "kos,fainted,benched".
  const lines: { teamId: string; pokemonSlug: string; kos: number; fainted: boolean; benched: boolean }[] =
    [];
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith('line:')) continue;
    const [, teamId, pokemonSlug] = key.split(':');
    const [kos, fainted, benched] = String(raw).split(',');
    lines.push({
      teamId,
      pokemonSlug,
      kos: Number.parseInt(kos, 10) || 0,
      fainted: fainted === '1',
      benched: benched === '1',
    });
  }

  if (lines.length === 0) {
    return { error: 'Pick the Pokémon you brought to the match.' };
  }

  // The scoreline is the lines — see lib/match.ts. Derived on the server as well as in the form
  // so what's saved is what the form promised, whatever was posted.
  const { homeScore, awayScore } = deriveScore({ won, lines });

  try {
    await reportMatch({
      leagueId,
      homeTeamId,
      // Every match is a public ladder game against someone outside the league.
      awayTeamId: null,
      opponentName: LADDER_OPPONENT,
      homeScore,
      awayScore,
      lines,
      note,
      reportedById: user.id,
    });
    refresh(leagueId);
    return { success: won ? 'Win recorded.' : 'Loss recorded.' };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function deleteMatchAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const matchId = String(formData.get('matchId') ?? '');

  try {
    await deleteMatch({ matchId, actorUserId: user.id });
    refresh(leagueId);
    return { success: 'Match removed — reward and value changes reversed.' };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function proposeTradeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const toTeamId = String(formData.get('toTeamId') ?? '');
  const cash = Number.parseInt(String(formData.get('cash') ?? '0'), 10) || 0;
  const give = formData.getAll('give').map(String);
  const get = formData.getAll('get').map(String);

  try {
    const team = await myTeam(leagueId, user.id);
    await proposeTrade({
      leagueId,
      fromTeamId: team.id,
      toTeamId,
      givePokemon: give,
      getPokemon: get,
      cash,
      note: String(formData.get('note') ?? ''),
      actorUserId: user.id,
    });
    refresh(leagueId);
    return { success: 'Offer sent.' };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function respondTradeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const offerId = String(formData.get('offerId') ?? '');
  const accept = String(formData.get('accept') ?? '') === '1';

  try {
    const team = await myTeam(leagueId, user.id);
    const result = await respondToTrade({ offerId, accept, actorUserId: user.id, teamId: team.id });
    refresh(leagueId);
    return { success: result.accepted ? 'Trade done.' : 'Offer declined.' };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function advanceRoundAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');

  try {
    const result = await advanceRound({ leagueId, actorUserId: user.id });
    refresh(leagueId);
    return {
      success: `Round ${result.round} closed. Waivers cleared and match pay reset.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function updateStandingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const leagueId = String(formData.get('leagueId') ?? '');
  const [tierKey, rankRaw] = String(formData.get('rung') ?? '').split(':');
  const tier = getTier(tierKey);

  const number = (key: string): number | null => {
    const raw = String(formData.get(key) ?? '').trim();
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  try {
    const team = await myTeam(leagueId, user.id);
    const result = await updateStanding({
      leagueId,
      teamId: team.id,
      actorUserId: user.id,
      standing: {
        tierKey,
        rank: tier.ranks === 0 ? null : Number.parseInt(rankRaw, 10) || tier.ranks,
        progress: Number.parseInt(String(formData.get('progress') ?? '0'), 10) || 0,
        ratingPoints: number('ratingPoints'),
        globalPlacement: number('globalPlacement'),
      },
    });
    refresh(leagueId);
    return {
      success: result.bonus
        ? `Now ${result.label} — promotion bonus \u20bd${result.bonus.toLocaleString()}.`
        : result.baseline
          ? `Starting rank recorded as ${result.label}. Climbing from here pays a bonus.`
          : `Rank set to ${result.label}.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
