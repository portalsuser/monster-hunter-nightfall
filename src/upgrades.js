import { WEAPONS, PASSIVES } from './weapons.js';
import { shuffle } from './utils.js';

export const MAX_WEAPONS = 6;
export const MAX_PASSIVES = 6;

/**
 * Builds the set of cards offered on a level up.
 *
 * Priority is deliberately biased toward *finishing* things the player already
 * committed to — a survivors run feels bad when the pool keeps offering brand
 * new level-1 weapons at minute 18.
 */
export function rollUpgrades(weaponSystem, player, count = 3) {
  const owned = weaponSystem.owned;
  const passives = weaponSystem.passives;

  const weaponSlotsFree = owned.size < MAX_WEAPONS;
  const passiveSlotsFree = passives.size < MAX_PASSIVES;

  const upgradeExisting = [];
  const newWeapons = [];
  const upgradePassive = [];
  const newPassives = [];

  for (const [key, w] of owned) {
    if (w.level < w.def.maxLevel) upgradeExisting.push(makeCard(key, w.level + 1, 'weapon'));
  }
  if (weaponSlotsFree) {
    for (const key of Object.keys(WEAPONS)) {
      if (owned.has(key)) continue;
      newWeapons.push(makeCard(key, 1, 'weapon'));
    }
  }
  for (const [key, lvl] of passives) {
    if (lvl < PASSIVES[key].maxLevel) upgradePassive.push(makeCard(key, lvl + 1, 'passive'));
  }
  if (passiveSlotsFree) {
    for (const key of Object.keys(PASSIVES)) {
      if (passives.has(key)) continue;
      newPassives.push(makeCard(key, 1, 'passive'));
    }
  }

  shuffle(upgradeExisting);
  shuffle(newWeapons);
  shuffle(upgradePassive);
  shuffle(newPassives);

  // Weighted draw across the four buckets. Late in a run, "new" buckets are
  // starved so the player can actually cap what they are building.
  const pools = [
    { list: upgradeExisting, weight: 3.2 },
    { list: newWeapons, weight: owned.size < 3 ? 3.0 : 1.5 },
    { list: upgradePassive, weight: 2.2 },
    { list: newPassives, weight: passives.size < 3 ? 2.0 : 1.1 },
  ];

  const chosen = [];
  const usedKeys = new Set();
  let guard = 0;
  while (chosen.length < count && guard++ < 200) {
    const available = pools.filter((p) => p.list.some((c) => !usedKeys.has(c.key)));
    if (!available.length) break;
    let total = 0;
    for (const p of available) total += p.weight;
    let r = Math.random() * total;
    let picked = available[available.length - 1];
    for (const p of available) {
      r -= p.weight;
      if (r <= 0) { picked = p; break; }
    }
    const card = picked.list.find((c) => !usedKeys.has(c.key));
    if (!card) continue;
    usedKeys.add(card.key);
    chosen.push(card);
  }

  // Fallbacks when everything is maxed — always give the player *something*.
  while (chosen.length < count) {
    chosen.push(
      chosen.some((c) => c.key === '__heal')
        ? { key: '__parts', kind: 'bonus', name: 'Trophy Cache', icon: '🦴', color: '#ffd23c', level: 0, text: 'Gain a burst of monster parts.' }
        : { key: '__heal', kind: 'bonus', name: 'Field Dressing', icon: '✚', color: '#8affb0', level: 0, text: 'Restore 40% of your maximum health.' }
    );
    if (chosen.length > 8) break;
  }

  return chosen;
}

function makeCard(key, level, kind) {
  if (kind === 'weapon') {
    const def = WEAPONS[key];
    return {
      key, kind, level,
      name: def.name,
      icon: def.icon,
      color: def.color,
      text: level === 1 ? def.desc : def.levels[level - 1],
      isNew: level === 1,
      maxLevel: def.maxLevel,
    };
  }
  const def = PASSIVES[key];
  return {
    key, kind, level,
    name: def.name,
    icon: def.icon,
    color: def.color,
    text: level === 1 ? def.desc : def.step,
    sub: def.step,
    isNew: level === 1,
    maxLevel: def.maxLevel,
  };
}

/**
 * Applies a chosen card.
 * Returns { label, gainedLevels } — the Trophy Cache fallback awards raw
 * monster parts, which can itself push the player over the next threshold, and
 * the caller has to fold those extra picks back into the level-up queue.
 */
export function applyUpgrade(card, weaponSystem, player) {
  if (card.key === '__heal') {
    player.heal(player.stats.maxHp * 0.4);
    return { label: 'Field Dressing', gainedLevels: 0 };
  }
  if (card.key === '__parts') {
    const gained = player.addXp(Math.round(46 + player.level * 9));
    return { label: 'Trophy Cache', gainedLevels: gained };
  }
  weaponSystem.addOrLevel(card.key);
  return { label: `${card.name} Lv.${card.level}`, gainedLevels: 0 };
}
