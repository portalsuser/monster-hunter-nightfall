/**
 * A three.js stand-in that reports *real* triangle counts.
 *
 * The regular mock (mock-three.mjs) gives every primitive the same tiny
 * attribute set, which is fine for logic tests but useless for asking "how
 * much does the horde actually cost to draw?". This module re-exports the mock
 * wholesale and replaces only the geometry constructors with versions that
 * allocate a position attribute of the correct non-indexed vertex count, using
 * three's own tessellation rules.
 *
 * Because mergeGeos() concatenates attribute arrays, merged geometries come out
 * with the right totals for free.
 */

export * from './mock-three.mjs';
import * as MOCK from './mock-three.mjs';

const { BufferGeometry, BufferAttribute } = MOCK;

/** Builds a geometry whose position attribute holds `tris * 3` vertices. */
function geoOfTris(tris) {
  const g = new BufferGeometry();
  const verts = Math.max(0, Math.round(tris)) * 3;
  g.setAttribute('position', new BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(verts * 2), 2));
  return g;
}

/** Triangles in a geometry produced by this module. */
export function trisOf(geo) {
  return geo.attributes.position.array.length / 9;
}

const def = (v, d) => (v === undefined ? d : v);

class Counted extends BufferGeometry {
  constructor(tris) {
    super();
    Object.assign(this, geoOfTris(tris));
  }
}

export class BoxGeometry extends Counted {
  constructor(w, h, d, ws = 1, hs = 1, ds = 1) {
    super(4 * (ws * hs + ws * ds + hs * ds));
  }
}

export class SphereGeometry extends Counted {
  constructor(r, ws = 32, hs = 16, ps, pl, ts, tl) {
    // Pole rows are single triangles, every other row is a quad pair.
    super(ws * (hs * 2 - 2));
  }
}

export class PlaneGeometry extends Counted {
  constructor(w, h, ws = 1, hs = 1) { super(ws * hs * 2); }
}

export class CylinderGeometry extends Counted {
  constructor(rt = 1, rb = 1, h = 1, rs = 32, hs = 1, open = false) {
    let t = rs * hs * 2;
    if (!open) {
      if (rt > 0) t += rs;
      if (rb > 0) t += rs;
    }
    super(t);
  }
}

export class ConeGeometry extends Counted {
  constructor(r = 1, h = 1, rs = 32, hs = 1, open = false) {
    // A cone is a cylinder with radiusTop 0: the apex row loses one triangle
    // per radial segment, and there is only one cap.
    let t = rs * hs * 2 - rs;
    if (!open) t += rs;
    super(t);
  }
}

export class CapsuleGeometry extends Counted {
  constructor(r = 1, len = 1, capSeg = 4, radSeg = 8) {
    // three builds a capsule as a lathe: capSeg rings per hemisphere plus the
    // cylindrical body, each ring pair contributing radSeg quads.
    const rings = capSeg * 2 + 1;
    super(radSeg * rings * 2);
  }
}

export class TorusGeometry extends Counted {
  constructor(r = 1, tube = 0.4, rs = 12, ts = 48) { super(rs * ts * 2); }
}

export class RingGeometry extends Counted {
  constructor(ir = 0.5, or_ = 1, ts = 32, ps = 1) { super(ts * ps * 2); }
}

export class CircleGeometry extends Counted {
  constructor(r = 1, seg = 32) { super(seg); }
}

const platonic = (base) => class extends Counted {
  constructor(r = 1, detail = 0) { super(base * Math.pow(4, detail)); }
};

export const IcosahedronGeometry = platonic(20);
export const DodecahedronGeometry = platonic(36);
export const OctahedronGeometry = platonic(8);
export const TetrahedronGeometry = platonic(4);
export { def };
