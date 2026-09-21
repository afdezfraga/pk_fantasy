import type { Tier } from '../config/economy.ts';

/** Money, always as whole Pokédollars. */
export function money(amount: number): string {
  const sign = amount < 0 ? '−' : '';
  return `${sign}₽${Math.abs(amount).toLocaleString('en-US')}`;
}

/** Compact money for tight spots like draft boards: ₽120.5k. */
export function moneyShort(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '−' : '';
  if (abs >= 1000) {
    const thousands = abs / 1000;
    return `${sign}₽${thousands % 1 === 0 ? thousands : thousands.toFixed(1)}k`;
  }
  return `${sign}₽${abs}`;
}

export function signedMoney(amount: number): string {
  return `${amount > 0 ? '+' : ''}${money(amount)}`;
}

export const TIER_CLASS: Record<Tier, string> = {
  S: 'bg-tier-s/15 text-tier-s border-tier-s/30',
  'A+': 'bg-tier-aplus/15 text-tier-aplus border-tier-aplus/30',
  A: 'bg-tier-a/15 text-tier-a border-tier-a/30',
  B: 'bg-tier-b/15 text-tier-b border-tier-b/30',
  C: 'bg-tier-c/15 text-tier-c border-tier-c/30',
  D: 'bg-tier-d/15 text-tier-d border-tier-d/30',
  UR: 'bg-tier-ur/15 text-tier-ur border-tier-ur/30',
};

const TYPE_COLORS: Record<string, string> = {
  Normal: '#9fa19f', Fire: '#e62829', Water: '#2980ef', Electric: '#fac000',
  Grass: '#3fa129', Ice: '#3dcef3', Fighting: '#ff8000', Poison: '#9141cb',
  Ground: '#915121', Flying: '#81b9ef', Psychic: '#ef4179', Bug: '#91a119',
  Rock: '#afa981', Ghost: '#704170', Dragon: '#5060e1', Dark: '#624d4e',
  Steel: '#60a1b8', Fairy: '#ef70ef',
};

export function typeColor(type: string): string {
  return TYPE_COLORS[type] ?? '#6b7280';
}

/** "Ninetales (Alolan Form)" — the name shown wherever a Pokémon is referred to. */
export function pokemonLabel(pokemon: { name: string; form?: string | null }): string {
  return pokemon.form ? `${pokemon.name} (${pokemon.form})` : pokemon.name;
}

export function parseTypes(json: string): string[] {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}
