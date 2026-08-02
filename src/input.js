/**
 * Keyboard + gamepad + on-screen thumbstick, normalised into a single
 * {x, z} movement vector so the player module never cares about the source.
 */

export class Input {
  constructor(dom) {
    this.keys = new Set();
    this.move = { x: 0, z: 0 };
    this.touch = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 };
    this.pausePressed = false;
    this._consumers = [];

    this._onKeyDown = (e) => {
      // Never swallow browser/devtools shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      if (e.code === 'Escape' || e.code === 'KeyP') this.pausePressed = true;
      this._consumers.forEach((fn) => fn(e.code));
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);

    this._bindTouch(dom);
  }

  onKey(fn) {
    this._consumers.push(fn);
  }

  _bindTouch(dom) {
    const stick = document.getElementById('stick');
    const knob = document.getElementById('stick-knob');
    const R = 52;

    const start = (e) => {
      const t = e.changedTouches[0];
      this.touch.active = true;
      this.touch.id = t.identifier;
      this.touch.ox = t.clientX;
      this.touch.oy = t.clientY;
      if (stick) {
        stick.style.display = 'block';
        stick.style.left = `${t.clientX}px`;
        stick.style.top = `${t.clientY}px`;
      }
    };

    const move = (e) => {
      if (!this.touch.active) return;
      for (const t of e.changedTouches) {
        if (t.identifier !== this.touch.id) continue;
        let dx = t.clientX - this.touch.ox;
        let dy = t.clientY - this.touch.oy;
        const len = Math.hypot(dx, dy);
        if (len > R) {
          dx = (dx / len) * R;
          dy = (dy / len) * R;
        }
        this.touch.dx = dx / R;
        this.touch.dy = dy / R;
        if (knob) knob.style.transform = `translate(${dx}px, ${dy}px)`;
      }
      e.preventDefault();
    };

    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.touch.id) continue;
        this.touch.active = false;
        this.touch.dx = 0;
        this.touch.dy = 0;
        if (stick) stick.style.display = 'none';
        if (knob) knob.style.transform = 'translate(0,0)';
      }
    };

    const target = dom || window;
    target.addEventListener('touchstart', start, { passive: true });
    target.addEventListener('touchmove', move, { passive: false });
    target.addEventListener('touchend', end, { passive: true });
    target.addEventListener('touchcancel', end, { passive: true });
  }

  /** Call once per frame before reading `move`. */
  update() {
    let x = 0;
    let z = 0;
    const k = this.keys;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) z -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) z += 1;

    if (this.touch.active) {
      x += this.touch.dx;
      z += this.touch.dy;
    }

    // Gamepad (left stick) with a generous deadzone.
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] || 0;
      const az = p.axes[1] || 0;
      if (Math.abs(ax) > 0.18) x += ax;
      if (Math.abs(az) > 0.18) z += az;
      break;
    }

    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    this.move.x = x;
    this.move.z = z;
    return this.move;
  }

  consumePause() {
    const p = this.pausePressed;
    this.pausePressed = false;
    return p;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }
}
