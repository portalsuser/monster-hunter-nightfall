import { CFG } from './config.js';
import { SFX } from './audio.js';
import { formatTime } from './utils.js';
import { WEAPONS, PASSIVES } from './weapons.js';

const $ = (id) => document.getElementById(id);

/** All DOM/UI. The 3D layer never touches the document directly. */
export class HUD {
  constructor(game) {
    this.game = game;
    this.el = {
      hp: $('hp-fill'),
      hpText: $('hp-text'),
      xp: $('xp-fill'),
      level: $('level-num'),
      timer: $('timer'),
      kills: $('kills'),
      parts: $('parts'),
      picks: $('picks'),
      slots: $('slots'),
      bossWrap: $('boss-wrap'),
      bossName: $('boss-name'),
      bossFill: $('boss-fill'),
      toasts: $('toasts'),
      levelup: $('levelup'),
      cards: $('cards'),
      levelupSub: $('levelup-sub'),
      pause: $('pause'),
      pauseList: $('pause-list'),
      over: $('gameover'),
      overStats: $('over-stats'),
      overTitle: $('over-title'),
      board: $('leaderboard'),
      start: $('start'),
      startBtn: $('start-btn'),
      damageFlash: $('damage-flash'),
      lowhp: $('lowhp'),
      portalsNote: $('portals-note'),
    };
    this._slotCache = new Map();
    this._bind();
  }

  _bind() {
    this.el.startBtn.addEventListener('click', () => this.game.start());
    $('resume-btn').addEventListener('click', () => this.game.togglePause());
    $('restart-btn').addEventListener('click', () => this.game.restart());
    $('again-btn').addEventListener('click', () => this.game.restart());
    $('mute-btn').addEventListener('click', (e) => {
      const m = this.game.toggleMute();
      e.currentTarget.textContent = m ? '🔇' : '🔊';
    });
    $('pause-btn').addEventListener('click', () => this.game.togglePause());
  }

  // ---- screens -----------------------------------------------------------

  showStart(show) { this.el.start.classList.toggle('hidden', !show); }
  showPause(show) {
    this.el.pause.classList.toggle('hidden', !show);
    if (show) this._renderPauseList();
  }
  showGameOver(show) { this.el.over.classList.toggle('hidden', !show); }

  setPortalsNote(text) {
    this.el.portalsNote.textContent = text;
  }

  // ---- live stats --------------------------------------------------------

  update(game) {
    const p = game.player;
    const hpFrac = Math.max(0, p.hp / p.maxHp);
    this.el.hp.style.width = `${hpFrac * 100}%`;
    this.el.hpText.textContent = `${Math.ceil(p.hp)} / ${Math.round(p.maxHp)}`;
    this.el.lowhp.classList.toggle('active', hpFrac < 0.3 && p.alive);

    const xpFrac = Math.min(1, p.xp / p.xpNeeded);
    this.el.xp.style.width = `${xpFrac * 100}%`;
    this.el.level.textContent = p.level;
    this.el.picks.textContent = `${p.levelUps}`;

    this.el.timer.textContent = formatTime(game.elapsed);
    this.el.kills.textContent = game.enemies.totalKills;
    this.el.parts.textContent = p.parts_collected;

    // Boss bar (shows the most-damaged living boss).
    const bosses = game.enemies.bosses;
    if (bosses.length) {
      const b = bosses[0];
      this.el.bossWrap.classList.remove('hidden');
      this.el.bossName.textContent = b.def.name;
      this.el.bossFill.style.width = `${Math.max(0, (b.hp / b.maxHp) * 100)}%`;
    } else {
      this.el.bossWrap.classList.add('hidden');
    }

    this._renderSlots(game.weapons);

    // Damage vignette.
    this.el.damageFlash.style.opacity = p.hurtFlash * 0.55;
  }

  _renderSlots(weapons) {
    const entries = [];
    for (const [key, w] of weapons.owned) entries.push({ key, level: w.level, def: WEAPONS[key], kind: 'w' });
    for (const [key, lvl] of weapons.passives) entries.push({ key, level: lvl, def: PASSIVES[key], kind: 'p' });

    const sig = entries.map((e) => `${e.key}${e.level}`).join(',');
    if (sig === this._slotSig) return;
    this._slotSig = sig;

    this.el.slots.innerHTML = '';
    for (const e of entries) {
      const d = document.createElement('div');
      d.className = `slot ${e.kind === 'p' ? 'passive' : ''}`;
      d.style.setProperty('--c', e.def.color);
      d.innerHTML = `<span class="slot-icon">${e.def.icon}</span><span class="slot-lvl">${e.level}</span>`;
      d.title = `${e.def.name} — level ${e.level}/${e.def.maxLevel}`;
      if (e.level >= e.def.maxLevel) d.classList.add('maxed');
      this.el.slots.appendChild(d);
    }
  }

  _renderPauseList() {
    const w = this.game.weapons;
    const rows = [];
    for (const [key, it] of w.owned) {
      rows.push(`<li><span class="pi" style="color:${WEAPONS[key].color}">${WEAPONS[key].icon}</span> ${WEAPONS[key].name} <b>Lv.${it.level}</b></li>`);
    }
    for (const [key, lvl] of w.passives) {
      rows.push(`<li><span class="pi" style="color:${PASSIVES[key].color}">${PASSIVES[key].icon}</span> ${PASSIVES[key].name} <b>Lv.${lvl}</b></li>`);
    }
    this.el.pauseList.innerHTML = rows.join('') || '<li>Nothing but your fists.</li>';
  }

  // ---- level up ----------------------------------------------------------

  showLevelUp(cards, remaining, onPick) {
    this.el.levelup.classList.remove('hidden');
    this.el.levelupSub.textContent = remaining > 1
      ? `Choose an enhancement — ${remaining} pending`
      : 'Choose an enhancement';
    this.el.cards.innerHTML = '';

    cards.forEach((card, i) => {
      const btn = document.createElement('button');
      btn.className = 'card';
      btn.style.setProperty('--c', card.color);
      // Twenty pips do not fit on a card; past a handful, show a rank bar.
      const pips = !card.maxLevel
        ? ''
        : card.maxLevel <= 8
          ? `<div class="pips">${Array.from({ length: card.maxLevel }, (_, k) =>
              `<i class="${k < card.level ? 'on' : ''}"></i>`).join('')}</div>`
          : `<div class="rankbar"><div class="rankbar-fill" style="width:${(card.level / card.maxLevel) * 100}%"></div>`
            + `<span class="rankbar-txt">RANK ${card.level} / ${card.maxLevel}</span></div>`;
      btn.innerHTML = `
        <div class="card-top">
          <span class="card-icon">${card.icon}</span>
          <span class="card-tag">${card.isNew ? 'NEW' : card.kind === 'passive' ? 'PASSIVE' : `LV ${card.level}`}</span>
        </div>
        <h3>${card.name}</h3>
        <p>${card.text}</p>
        ${pips}
      `;
      btn.addEventListener('click', () => {
        // Single-shot. hideLevelUp() only toggled a CSS class, so these buttons
        // kept their listeners; a double-click (or a click plus a number key)
        // fired the pick twice, and each fire spent one of the 20 enhancements.
        if (!this._levelUpOpen) return;
        this._levelUpOpen = false;
        SFX.select();
        onPick(card);
      });
      // Keyboard: 1 / 2 / 3.
      btn.dataset.index = String(i + 1);
      this.el.cards.appendChild(btn);
    });

    this._levelUpCards = cards;
    this._levelUpPick = onPick;
    this._levelUpOpen = true;
  }

  hideLevelUp() {
    this.el.levelup.classList.add('hidden');
    this._levelUpCards = null;
    this._levelUpOpen = false;
    // Drop the buttons entirely so no stale listener can fire later.
    this.el.cards.innerHTML = '';
  }

  pickByIndex(i) {
    if (!this._levelUpOpen || !this._levelUpCards) return false;
    const card = this._levelUpCards[i];
    if (!card) return false;
    this._levelUpOpen = false;
    SFX.select();
    this._levelUpPick(card);
    return true;
  }

  // ---- misc --------------------------------------------------------------

  toast(text, color = '#ffe9b0') {
    const d = document.createElement('div');
    d.className = 'toast';
    d.style.color = color;
    d.textContent = text;
    this.el.toasts.appendChild(d);
    setTimeout(() => d.classList.add('out'), 1600);
    setTimeout(() => d.remove(), 2400);
  }

  showResults(game, best) {
    const p = game.player;
    this.el.overTitle.textContent = game.victory ? 'The Hunt Endures' : 'You Fell';
    const rows = [
      ['Survived', formatTime(game.elapsed)],
      ['Monsters slain', game.enemies.totalKills],
      ['Monster parts', p.parts_collected],
      ['Level reached', p.level],
      ['Enhancements', `${p.levelUps}/${CFG.MAX_LEVEL_UPS}`],
      ['Bosses felled', game.bossesKilled],
      ['Score', game.score],
    ];
    if (best) rows.push(['Best score', best]);
    this.el.overStats.innerHTML = rows
      .map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`)
      .join('');
  }

  showLeaderboard(entries, message) {
    if (message) {
      this.el.board.innerHTML = `<div class="lb-note">${message}</div>`;
      return;
    }
    if (!entries || !entries.length) {
      this.el.board.innerHTML = '<div class="lb-note">No scores yet — be the first.</div>';
      return;
    }
    this.el.board.innerHTML = `
      <h4>Top Hunters</h4>
      <ol>${entries.map((e) => `<li><span>${escapeHtml(e.name || 'Hunter')}</span><b>${e.score}</b></li>`).join('')}</ol>
    `;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
