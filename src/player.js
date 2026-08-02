import * as THREE from 'three';
import { CFG } from './config.js';
import { clamp, damp, TAU } from './utils.js';

/**
 * The hunter.
 *
 * Everything here is hand-built from primitives — the project ships no meshes
 * and no textures. Detail therefore has to come from geometry and material
 * response rather than from maps, so the model is built the way a real one
 * would be panelled: separate armour lames, rivets, straps with buckles,
 * articulated fingers, a coat with a visible lining. Segment counts are
 * generous because there is exactly one of him on screen; the horde is what
 * has to be cheap, not the hero.
 *
 * Two costs are worth keeping an eye on:
 *   - draw calls. Small repeated details (rivets, hem tatters, finger bones)
 *     are merged into a single geometry per group rather than left as dozens
 *     of meshes.
 *   - the shadow pass, which redraws every caster. Only parts that actually
 *     change his silhouette cast; rivets and buckles do not.
 */

const PAL = {
  coat: 0x2a2118,
  coatDark: 0x17110b,
  coatLining: 0x5a1f1c,   // deep red, only ever seen when the coat swings open
  leather: 0x4a3320,
  leatherDark: 0x30210f,
  strap: 0x241708,
  metal: 0x8d949c,
  metalDark: 0x555c66,
  metalWarm: 0x6b5a3c,    // brass for buckles and lantern furniture
  horn: 0xd8cbb0,
  hornDark: 0xa2957c,
  skin: 0xb98963,
  skinDark: 0x8d6544,
  wrap: 0xc9bda4,
  wrapDark: 0x9c9078,
  glow: 0xffa64d,
  eye: 0xffd27f,
};

/**
 * Merges primitives that share a material into one geometry.
 *
 * A hand full of finger bones is twelve draw calls if left as meshes and one
 * if merged, and none of them ever move independently of the hand.
 */
function mergeGeos(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const names = Object.keys(parts[0].attributes);
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    let total = 0;
    for (const g of parts) total += g.attributes[name].array.length;
    const itemSize = parts[0].attributes[name].itemSize;
    const arr = new Float32Array(total);
    let off = 0;
    for (const g of parts) { arr.set(g.attributes[name].array, off); off += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  }
  out.computeBoundingSphere();
  return out;
}

/** A ring of small studs, merged — used on pauldrons, bracers and the belt. */
function rivetRing(count, radius, size, arc = TAU, start = 0) {
  const g = [];
  for (let i = 0; i < count; i++) {
    const a = start + (i / count) * arc;
    const r = new THREE.SphereGeometry(size, 10, 8, 0, TAU, 0, Math.PI * 0.6);
    r.rotateX(-Math.PI / 2);
    r.translate(Math.sin(a) * radius, 0, Math.cos(a) * radius);
    g.push(r);
  }
  return mergeGeos(g);
}

/** A strap with a buckle plate, lying flat in XY. */
function strapWithBuckle(len, width, buckleAt) {
  const band = new THREE.BoxGeometry(width, len, 0.045, 1, 6, 1);
  const buckle = new THREE.BoxGeometry(width * 1.5, width * 1.3, 0.07, 2, 2, 1);
  buckle.translate(0, buckleAt, 0.02);
  const tongue = new THREE.BoxGeometry(width * 0.25, width * 1.6, 0.09);
  tongue.translate(0, buckleAt, 0.03);
  return mergeGeos([band, buckle, tongue]);
}

function buildHunter() {
  const g = new THREE.Group();
  const parts = {};

  const mat = (color, rough = 0.8, metal = 0) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, flatShading: false });
  const metalMat = (color, rough = 0.32) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.92, flatShading: false });

  // Silhouette parts cast shadows; trim does not. The shadow pass redraws
  // every caster, and a rivet has never changed anyone's outline.
  const add = (parent, mesh, x = 0, y = 0, z = 0) => {
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const trim = (parent, mesh, x = 0, y = 0, z = 0) => {
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };

  // ---- shared materials --------------------------------------------------
  const leatherMat = mat(PAL.leather, 0.85);
  const leatherDarkMat = mat(PAL.leatherDark, 0.9);
  const strapMat = mat(PAL.strap, 0.95);
  const brassMat = metalMat(PAL.metalWarm, 0.4);
  const steelMat = metalMat(PAL.metal, 0.28);
  const steelDarkMat = metalMat(PAL.metalDark, 0.38);
  const wrapMat = mat(PAL.wrap, 1);
  const wrapDarkMat = mat(PAL.wrapDark, 1);
  const hornMat = mat(PAL.horn, 0.55);

  // ---- torso -------------------------------------------------------------
  const body = new THREE.Group();
  g.add(body);
  parts.body = body;

  // Pelvis and a segmented spine, so the waist reads as a joint rather than a
  // seam. Each ring is slightly smaller going up.
  const pelvis = add(body, new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.16, 10, 24), leatherDarkMat), 0, 0.94, 0);
  pelvis.scale.set(1.12, 1, 0.86);

  const spine = [];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.CylinderGeometry(0.26 - i * 0.012, 0.27 - i * 0.012, 0.12, 24);
    r.translate(0, 1.06 + i * 0.11, 0);
    r.scale(1, 1, 0.82);
    spine.push(r);
  }
  add(body, new THREE.Mesh(mergeGeos(spine), leatherMat));

  const chest = add(body, new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.36, 12, 28), leatherMat), 0, 1.42, 0);
  chest.scale.set(1.04, 1.0, 0.8);
  parts.chest = chest;

  // Breastplate: three overlapping lames down the sternum, each a shallow
  // curved shell rather than a flat slab.
  const lames = [];
  for (let i = 0; i < 3; i++) {
    const l = new THREE.SphereGeometry(0.3 - i * 0.028, 20, 14, Math.PI * 0.72, Math.PI * 0.56, Math.PI * 0.28, Math.PI * 0.3);
    l.scale(1, 1.1, 0.72);
    l.translate(0, 1.6 - i * 0.16, 0.06);
    lames.push(l);
  }
  add(body, new THREE.Mesh(mergeGeos(lames), steelDarkMat));

  // Ribbed leather panels flanking the plate.
  const ribs = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const rib = new THREE.CapsuleGeometry(0.026, 0.2, 5, 10);
      rib.rotateZ(Math.PI / 2);
      rib.rotateY(side * 0.5);
      rib.translate(side * 0.22, 1.58 - i * 0.11, 0.2);
      ribs.push(rib);
    }
  }
  trim(body, new THREE.Mesh(mergeGeos(ribs), leatherDarkMat));

  // Chest harness: two straps crossing the sternum, each with a real buckle.
  [[-0.13, 0.24], [0.15, -0.28]].forEach(([x, rot]) => {
    const s = trim(body, new THREE.Mesh(strapWithBuckle(0.78, 0.11, 0.1), strapMat), x, 1.42, 0.3);
    s.rotation.z = rot;
  });
  [[-0.13, 0.24], [0.15, -0.28]].forEach(([x, rot]) => {
    const b = trim(body, new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.13, 0.05, 2, 2, 1), brassMat), x, 1.52, 0.33);
    b.rotation.z = rot;
  });

  // ---- belt --------------------------------------------------------------
  const beltGroup = new THREE.Group();
  beltGroup.position.set(0, 0.86, 0);
  body.add(beltGroup);

  const beltBand = add(beltGroup, new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.055, 14, 40), leatherDarkMat));
  beltBand.rotation.x = Math.PI / 2;
  beltBand.scale.set(1.06, 1, 0.88);
  trim(beltGroup, new THREE.Mesh(rivetRing(16, 0.34, 0.021), brassMat));

  const buckle = trim(beltGroup, new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.16, 0.06, 3, 3, 1), brassMat), 0, 0, 0.31);
  trim(beltGroup, new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.016, 8, 18), brassMat), 0, 0, 0.34);

  // Pouches hanging off the back of the belt.
  for (const [px, pz, w] of [[-0.24, -0.2, 0.13], [0.2, -0.24, 0.11]]) {
    const pouch = add(beltGroup, new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, 0.1, 2, 2, 2), leatherMat), px, -0.09, pz);
    pouch.rotation.y = Math.atan2(px, pz);
    trim(beltGroup, new THREE.Mesh(new THREE.BoxGeometry(w * 1.05, 0.05, 0.11, 2, 1, 1), strapMat), px, -0.02, pz);
  }

  // Vials, with corks and a little glass shoulder each.
  [[-0.26, 0x7fd94a], [-0.15, 0xd94a4a], [0.24, 0x4a9fd9]].forEach(([x, col]) => {
    const vialMat = new THREE.MeshStandardMaterial({
      color: col, roughness: 0.15, metalness: 0.1, emissive: col, emissiveIntensity: 0.4,
      transparent: true, opacity: 0.85,
    });
    // Tagged so the hurt-flash pass does not blank out their glow.
    vialMat.userData.keepEmissive = true;
    const body_ = new THREE.CylinderGeometry(0.045, 0.05, 0.15, 18);
    const neck = new THREE.CylinderGeometry(0.022, 0.04, 0.05, 14);
    neck.translate(0, 0.1, 0);
    const v = trim(beltGroup, new THREE.Mesh(mergeGeos([body_, neck]), vialMat), x, -0.06, 0.26);
    v.rotation.x = 0.2;
    const cork = trim(beltGroup, new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.022, 0.04, 12), mat(0x8a6a3a, 1)), x, 0.045, 0.27);
    cork.rotation.x = 0.2;
  });

  // ---- head + helm -------------------------------------------------------
  const head = new THREE.Group();
  head.position.set(0, 1.72, 0);
  body.add(head);
  parts.head = head;

  // Skull with a brow ridge, cheekbones and a jaw — a bare sphere reads as a
  // ball, and at this camera distance the profile is most of what sells a face.
  const skullGeo = new THREE.SphereGeometry(0.23, 32, 24);
  skullGeo.scale(1, 1.06, 1.02);
  const skinMat = mat(PAL.skin, 0.9);
  add(head, new THREE.Mesh(skullGeo, skinMat));

  const face = [];
  const brow = new THREE.BoxGeometry(0.3, 0.055, 0.09, 4, 1, 1);
  brow.rotateX(-0.15); brow.translate(0, 0.04, 0.19);
  face.push(brow);
  for (const side of [-1, 1]) {
    const cheek = new THREE.SphereGeometry(0.07, 12, 9);
    cheek.scale(1, 0.75, 0.8);
    cheek.translate(side * 0.14, -0.05, 0.16);
    face.push(cheek);
  }
  const nose = new THREE.ConeGeometry(0.045, 0.12, 10);
  nose.rotateX(Math.PI / 2.1); nose.translate(0, -0.02, 0.22);
  face.push(nose);
  trim(head, new THREE.Mesh(mergeGeos(face), mat(PAL.skinDark, 0.92)));

  // Helm: dome, riveted band, brow guard, nasal bar and cheek guards.
  const helm = add(head, new THREE.Mesh(new THREE.SphereGeometry(0.263, 32, 24, 0, TAU, 0, Math.PI * 0.6), steelDarkMat), 0, 0.02, 0);
  helm.scale.set(1, 1.06, 1.06);
  const band = trim(head, new THREE.Mesh(new THREE.TorusGeometry(0.262, 0.022, 10, 36), steelMat), 0, 0.03, 0);
  band.rotation.x = Math.PI / 2;
  const rivets = trim(head, new THREE.Mesh(rivetRing(14, 0.265, 0.018), brassMat), 0, 0.03, 0);

  const guard = [];
  const browGuard = new THREE.BoxGeometry(0.46, 0.085, 0.1, 5, 1, 1);
  browGuard.rotateX(-0.12); browGuard.translate(0, 0.05, 0.185);
  guard.push(browGuard);
  const nasal = new THREE.BoxGeometry(0.06, 0.22, 0.06, 1, 3, 1);
  nasal.translate(0, -0.06, 0.22);
  guard.push(nasal);
  for (const side of [-1, 1]) {
    const cheekG = new THREE.SphereGeometry(0.14, 14, 10, 0, TAU, 0, Math.PI * 0.5);
    cheekG.scale(0.55, 1.1, 0.85);
    cheekG.rotateX(Math.PI);
    cheekG.rotateZ(side * 0.2);
    cheekG.translate(side * 0.2, -0.04, 0.07);
    guard.push(cheekG);
  }
  trim(head, new THREE.Mesh(mergeGeos(guard), steelMat));

  // Horns — the signature silhouette. Each is a tapered beam with a ridged
  // sleeve and a separate tip, so it catches light along its length.
  for (const s of [-1, 1]) {
    const hornGeo = new THREE.ConeGeometry(0.078, 0.54, 20, 8);
    const horn = add(head, new THREE.Mesh(hornGeo, hornMat), s * 0.21, 0.16, -0.02);
    horn.rotation.z = s * 0.72;
    horn.rotation.x = -0.4;

    const ridges = [];
    for (let i = 0; i < 5; i++) {
      const r = new THREE.TorusGeometry(0.066 - i * 0.008, 0.011, 8, 18);
      r.rotateX(Math.PI / 2);
      r.translate(0, -0.16 + i * 0.09, 0);
      ridges.push(r);
    }
    const ridgeMesh = trim(head, new THREE.Mesh(mergeGeos(ridges), mat(PAL.hornDark, 0.6)), s * 0.21, 0.16, -0.02);
    ridgeMesh.rotation.z = s * 0.72;
    ridgeMesh.rotation.x = -0.4;

    const tip = add(head, new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.36, 18, 5), hornMat), s * 0.42, 0.36, -0.14);
    tip.rotation.z = s * 0.25;
    tip.rotation.x = -0.9;
  }

  // Eyes: a dark socket, a sclera and a glowing iris, so they read as eyes
  // rather than two dots.
  const eyeMat = new THREE.MeshBasicMaterial({ color: PAL.eye });
  eyeMat.userData = { keepEmissive: true };
  const sockets = [];
  for (const s of [-1, 1]) {
    const sock = new THREE.SphereGeometry(0.055, 12, 9);
    sock.scale(1.2, 0.8, 0.7);
    sock.translate(s * 0.09, -0.015, 0.2);
    sockets.push(sock);
  }
  trim(head, new THREE.Mesh(mergeGeos(sockets), mat(0x18120c, 1)));
  for (const s of [-1, 1]) {
    trim(head, new THREE.Mesh(new THREE.SphereGeometry(0.032, 16, 12), eyeMat), s * 0.09, -0.02, 0.215);
  }

  // Scarf over the lower face, built from overlapping folds.
  const scarf = new THREE.Group();
  scarf.position.set(0, -0.16, 0.02);
  head.add(scarf);
  parts.scarf = scarf;
  const folds = [];
  for (let i = 0; i < 3; i++) {
    const f = new THREE.CylinderGeometry(0.2 + i * 0.018, 0.235 + i * 0.018, 0.09, 24);
    f.scale(1, 1, 0.88);
    f.translate(0, -i * 0.055, 0.01);
    folds.push(f);
  }
  add(scarf, new THREE.Mesh(mergeGeos(folds), mat(0x5a2420, 0.95)));
  // A loose end trailing off one shoulder.
  const tail = add(scarf, new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.42, 0.04, 1, 6, 1), mat(0x4d1f1c, 0.95)), -0.19, -0.22, -0.08);
  tail.rotation.z = 0.25;
  parts.scarfTail = tail;

  // ---- hood + coat -------------------------------------------------------
  const hood = add(body, new THREE.Mesh(new THREE.SphereGeometry(0.36, 28, 20, 0, TAU, 0, Math.PI * 0.62), mat(PAL.coat, 0.95)), 0, 1.74, -0.06);
  hood.scale.set(1.05, 1.0, 1.15);
  const hoodRim = trim(body, new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.03, 10, 32), mat(PAL.coatDark, 1)), 0, 1.74, -0.06);
  hoodRim.rotation.x = Math.PI / 2;
  hoodRim.scale.set(1.05, 1.15, 1);

  const coat = new THREE.Group();
  coat.position.set(0, 1.52, -0.04);
  body.add(coat);
  parts.cloak = coat;   // the animation code still refers to this as `cloak`

  const COAT_GAP = 1.30;   // radians of opening across the front
  const coatMat = new THREE.MeshStandardMaterial({
    color: PAL.coat, roughness: 0.88, metalness: 0.03,
    flatShading: false, side: THREE.DoubleSide,
  });
  const liningMat = new THREE.MeshStandardMaterial({
    color: PAL.coatLining, roughness: 0.95, side: THREE.DoubleSide,
  });

  // Three builds cylinders/cones with x = r*sin(theta), z = r*cos(theta), so
  // theta 0 sits on +Z — the hunter's forward. Starting half a gap round and
  // stopping half a gap short leaves the opening centred on his chest, which is
  // what turns a closed cone (a skirt) into a coat his legs show through.
  //
  // The shell is split into three stacked bands rather than one cone so the
  // lower ones can lag behind the upper ones when he turns, which is most of
  // what makes cloth read as cloth.
  parts.coatSegs = [];
  const bandH = [0.42, 0.42, 0.42];
  let yAcc = 0;
  for (let i = 0; i < bandH.length; i++) {
    const seg = new THREE.Group();
    seg.position.y = i === 0 ? -0.02 : -bandH[i - 1];
    const rTop = 0.4 + i * 0.09;
    const rBot = 0.49 + i * 0.09;
    const shell = new THREE.CylinderGeometry(rTop, rBot, bandH[i], 28, 3, true, COAT_GAP / 2, TAU - COAT_GAP);
    shell.translate(0, -bandH[i] / 2, 0);
    const m = new THREE.Mesh(shell, coatMat);
    m.castShadow = true;
    seg.add(m);
    // Lining, very slightly inside the shell.
    const inner = new THREE.CylinderGeometry(rTop * 0.965, rBot * 0.965, bandH[i] * 0.99, 24, 1, true, COAT_GAP / 2 + 0.02, TAU - COAT_GAP - 0.04);
    inner.translate(0, -bandH[i] / 2, 0);
    seg.add(new THREE.Mesh(inner, liningMat));

    if (i === 0) coat.add(seg);
    else parts.coatSegs[i - 1].add(seg);
    parts.coatSegs.push(seg);
    yAcc -= bandH[i];
  }

  // Fur collar around the shoulders — a ring of overlapping tufts.
  const tufts = [];
  for (let i = 0; i < 22; i++) {
    const a = COAT_GAP / 2 + (i / 21) * (TAU - COAT_GAP);
    const t = new THREE.SphereGeometry(0.075 + (i % 3) * 0.012, 10, 8);
    t.scale(1, 0.8, 1.15);
    t.translate(Math.sin(a) * 0.4, 0.04 + ((i % 2) * 0.02), Math.cos(a) * 0.4);
    tufts.push(t);
  }
  add(coat, new THREE.Mesh(mergeGeos(tufts), mat(0x3b2d1e, 1)));

  // Lapels folded back over the chest.
  const lapelGeo = new THREE.BoxGeometry(0.16, 0.46, 0.05, 2, 5, 1);
  for (const s2 of [-1, 1]) {
    const lapel = trim(coat, new THREE.Mesh(lapelGeo, mat(PAL.coatDark, 0.85)), s2 * 0.2, 0.06, 0.3);
    lapel.rotation.z = s2 * -0.36;
    const edge = trim(coat, new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.46, 0.055, 1, 5, 1), liningMat), s2 * 0.27, 0.06, 0.31);
    edge.rotation.z = s2 * -0.36;
  }

  // Torn hem across the back arc only — the front stays open. Merged: eleven
  // tatters is one draw call, and they never move independently of the band.
  const hem = [];
  for (let i = 0; i < 11; i++) {
    const a = COAT_GAP / 2 + (i / 10) * (TAU - COAT_GAP);
    const t = new THREE.ConeGeometry(0.075 + (i % 2) * 0.02, 0.24 + (i % 3) * 0.07, 9);
    t.rotateX(Math.PI);
    t.translate(Math.sin(a) * 0.66, -0.11, Math.cos(a) * 0.66);
    hem.push(t);
  }
  const hemMesh = new THREE.Mesh(mergeGeos(hem), new THREE.MeshStandardMaterial({
    color: PAL.coatDark, side: THREE.DoubleSide, roughness: 1,
  }));
  hemMesh.castShadow = true;
  parts.coatSegs[parts.coatSegs.length - 1].add(hemMesh);

  // ---- pauldrons ---------------------------------------------------------
  // Three overlapping lames each, riveted, rather than one dome.
  for (const s of [-1, 1]) {
    const paul = new THREE.Group();
    paul.position.set(s * 0.4, 1.46, 0);
    paul.rotation.z = s * 0.55;
    body.add(paul);

    for (let i = 0; i < 3; i++) {
      const lame = new THREE.Mesh(
        new THREE.SphereGeometry(0.21 - i * 0.028, 24, 16, 0, TAU, 0, Math.PI * 0.55),
        i === 0 ? steelMat : steelDarkMat
      );
      lame.position.y = -i * 0.085;
      lame.scale.set(1.15, 0.8, 1.02);
      lame.castShadow = i === 0;
      paul.add(lame);
    }
    trim(paul, new THREE.Mesh(rivetRing(9, 0.2, 0.019, Math.PI * 1.3, -Math.PI * 0.65), brassMat), 0, 0.02, 0);
    const stud = trim(paul, new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.16, 14), steelMat), s * 0.15, 0.06, 0);
    stud.rotation.z = s * -1.3;
  }

  // ---- arms --------------------------------------------------------------
  // Jointed: shoulder group -> forearm group -> hand group, so the elbow and
  // wrist can bend independently instead of the whole arm swinging as a stick.
  parts.arms = [];
  parts.armFore = [];
  parts.hands = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(s * 0.4, 1.4, 0);
    body.add(arm);

    const upper = add(arm, new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.34, 10, 22), leatherMat), 0, -0.22, 0);
    upper.scale.set(1, 1, 0.95);
    const bicepStrap = trim(arm, new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.018, 8, 20), strapMat), 0, -0.12, 0);
    bicepStrap.rotation.x = Math.PI / 2;

    // Elbow cop sits on the shoulder group so it stays with the upper arm.
    const cop = trim(arm, new THREE.Mesh(new THREE.SphereGeometry(0.098, 16, 12, 0, TAU, 0, Math.PI * 0.62), steelDarkMat), 0, -0.42, 0.01);
    cop.rotation.x = Math.PI * 0.52;

    const fore = new THREE.Group();
    fore.position.set(0, -0.44, 0);
    arm.add(fore);
    parts.armFore.push(fore);

    const foreMesh = add(fore, new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.24, 10, 22), wrapMat), 0, -0.16, 0);
    // Bracer: two plates over the wraps, with straps.
    const bracer = [];
    for (let i = 0; i < 2; i++) {
      const p = new THREE.CylinderGeometry(0.108, 0.1, 0.14, 18, 1, true, -0.9, 1.8);
      p.translate(0, -0.1 - i * 0.15, 0.01);
      bracer.push(p);
    }
    trim(fore, new THREE.Mesh(mergeGeos(bracer), steelDarkMat));
    for (let i = 0; i < 2; i++) {
      const st = trim(fore, new THREE.Mesh(new THREE.TorusGeometry(0.103, 0.014, 8, 18), strapMat), 0, -0.1 - i * 0.15, 0);
      st.rotation.x = Math.PI / 2;
    }

    // Hand: palm, thumb and four two-bone fingers. Merged into one geometry —
    // they never articulate independently, and twelve meshes per hand would
    // double the model's draw calls for nothing.
    const hand = new THREE.Group();
    hand.position.set(0, -0.34, 0);
    fore.add(hand);
    parts.hands.push(hand);

    const palm = new THREE.BoxGeometry(0.17, 0.15, 0.11, 3, 3, 2);
    const bones = [palm];
    for (let f = 0; f < 4; f++) {
      const fx = -0.058 + f * 0.039;
      const len = 0.075 - Math.abs(f - 1.5) * 0.008;
      const prox = new THREE.CapsuleGeometry(0.019, len, 5, 9);
      prox.translate(fx, -0.11, 0.035);
      const dist = new THREE.CapsuleGeometry(0.017, len * 0.75, 5, 9);
      dist.rotateX(0.35);
      dist.translate(fx, -0.19, 0.055);
      bones.push(prox, dist);
    }
    const thumb = new THREE.CapsuleGeometry(0.023, 0.075, 5, 9);
    thumb.rotateZ(s * -0.9);
    thumb.translate(s * 0.085, -0.06, 0.045);
    bones.push(thumb);
    add(hand, new THREE.Mesh(mergeGeos(bones), wrapDarkMat));

    // Knuckle spikes — the level-1 "weapon".
    const spikes = [];
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.ConeGeometry(0.03, 0.11, 12);
      sp.rotateX(Math.PI / 2);
      sp.translate((i - 1) * 0.058, -0.06, 0.1);
      spikes.push(sp);
    }
    trim(hand, new THREE.Mesh(mergeGeos(spikes), steelMat));

    arm.userData.side = s;
    parts.arms.push(arm);
  }

  // ---- legs --------------------------------------------------------------
  // Also jointed: hip -> shin -> foot, for a real knee bend and a heel-toe roll.
  parts.legs = [];
  parts.shins = [];
  parts.feet = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(s * 0.16, 0.82, 0);
    body.add(leg);

    const thigh = add(leg, new THREE.Mesh(new THREE.CapsuleGeometry(0.125, 0.26, 10, 22), leatherDarkMat), 0, -0.2, 0);
    thigh.scale.set(1.05, 1, 1);
    // Thigh plate strapped over the outside.
    const plate = trim(leg, new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.128, 0.22, 18, 1, true, -1.0, 2.0), steelDarkMat), 0, -0.2, 0.01);
    const thighStrap = trim(leg, new THREE.Mesh(new THREE.TorusGeometry(0.132, 0.016, 8, 20), strapMat), 0, -0.28, 0);
    thighStrap.rotation.x = Math.PI / 2;

    // Knee cop.
    const knee = trim(leg, new THREE.Mesh(new THREE.SphereGeometry(0.115, 18, 14, 0, TAU, 0, Math.PI * 0.6), steelMat), 0, -0.38, 0.03);
    knee.rotation.x = Math.PI * 0.5;

    const shin = new THREE.Group();
    shin.position.set(0, -0.4, 0);
    leg.add(shin);
    parts.shins.push(shin);

    add(shin, new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.2, 10, 20), leatherDarkMat), 0, -0.14, 0);
    // Greave plates.
    const greave = new THREE.CylinderGeometry(0.118, 0.1, 0.26, 18, 1, true, -1.1, 2.2);
    greave.translate(0, -0.14, 0.01);
    trim(shin, new THREE.Mesh(greave, steelDarkMat));
    for (let i = 0; i < 2; i++) {
      const st = trim(shin, new THREE.Mesh(new THREE.TorusGeometry(0.112, 0.014, 8, 18), strapMat), 0, -0.06 - i * 0.16, 0);
      st.rotation.x = Math.PI / 2;
    }

    // Boot: sole, upper, toe cap and heel, so the foot has a real profile.
    const foot = new THREE.Group();
    foot.position.set(0, -0.26, 0);
    shin.add(foot);
    parts.feet.push(foot);

    const upperBoot = add(foot, new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.13, 0.3, 3, 2, 4), mat(0x24190f, 0.95)), 0, -0.03, 0.04);
    const sole = trim(foot, new THREE.Mesh(new THREE.BoxGeometry(0.225, 0.05, 0.34, 3, 1, 4), mat(0x141009, 1)), 0, -0.1, 0.05);
    const toeCap = trim(foot, new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 10, 0, TAU, 0, Math.PI * 0.5), steelDarkMat), 0, -0.04, 0.16);
    toeCap.rotation.x = -Math.PI * 0.45;
    toeCap.scale.set(1.05, 0.8, 1);
    const heel = trim(foot, new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.09, 2, 1, 1), mat(0x141009, 1)), 0, -0.13, -0.08);

    leg.userData.side = s;
    parts.legs.push(leg);
  }

  // ---- hip lantern -------------------------------------------------------
  // A real lantern: four corner posts, glass panes, a vented cap and a chain.
  const lantern = new THREE.Group();
  lantern.position.set(0.42, 0.9, -0.06);
  body.add(lantern);
  parts.lantern = lantern;

  const frame = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const post = new THREE.CylinderGeometry(0.011, 0.011, 0.22, 8);
    post.translate(Math.sin(a) * 0.085, 0, Math.cos(a) * 0.085);
    frame.push(post);
  }
  const topRing = new THREE.TorusGeometry(0.09, 0.012, 8, 20);
  topRing.rotateX(Math.PI / 2); topRing.translate(0, 0.1, 0);
  const botRing = new THREE.TorusGeometry(0.09, 0.012, 8, 20);
  botRing.rotateX(Math.PI / 2); botRing.translate(0, -0.1, 0);
  frame.push(topRing, botRing);
  trim(lantern, new THREE.Mesh(mergeGeos(frame), brassMat));

  const glass = trim(lantern, new THREE.Mesh(
    new THREE.CylinderGeometry(0.082, 0.082, 0.19, 16, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0xffe0a8, transparent: true, opacity: 0.22, side: THREE.DoubleSide,
      roughness: 0.1, metalness: 0, emissive: 0xffb055, emissiveIntensity: 0.5,
    })
  ));
  glass.material.userData.keepEmissive = true;

  const cap = trim(lantern, new THREE.Mesh(new THREE.ConeGeometry(0.115, 0.1, 16), brassMat), 0, 0.15, 0);
  trim(lantern, new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.008, 8, 14), brassMat), 0, 0.22, 0);

  const flame = trim(lantern, new THREE.Mesh(new THREE.SphereGeometry(0.062, 20, 16),
    new THREE.MeshBasicMaterial({ color: 0xffc46b })), 0, -0.01, 0);
  flame.scale.set(1, 1.3, 1);
  parts.flame = flame;
  // An inner hotter core, so the flame is not a flat blob.
  trim(lantern, new THREE.Mesh(new THREE.SphereGeometry(0.032, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xfff2c4 })), 0, 0.01, 0);

  // ---- scabbard across the back ------------------------------------------
  const scabbard = new THREE.Group();
  scabbard.position.set(-0.12, 1.28, -0.3);
  scabbard.rotation.set(0.25, 0, -0.55);
  body.add(scabbard);
  const sheath = add(scabbard, new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.86, 0.05, 2, 8, 1), mat(0x2e2116, 0.9)));
  const throat = trim(scabbard, new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, 0.07, 2, 1, 1), brassMat), 0, 0.4, 0);
  const chape = trim(scabbard, new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.13, 10), brassMat), 0, -0.47, 0);
  chape.rotation.x = Math.PI;

  g.scale.setScalar(CFG.SCALE.player);
  return { group: g, parts };
}

export class Player {
  constructor(scene) {
    const built = buildHunter();
    this.mesh = built.group;
    this.parts = built.parts;
    scene.add(this.mesh);

    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.facing = 0;         // radians, yaw
    this.aim = new THREE.Vector3(0, 0, -1); // last non-zero movement direction

    this.level = 1;
    this.levelUps = 0;       // how many upgrade picks have been taken
    this.xp = 0;
    this.xpNeeded = CFG.xpForLevel(1);
    this.kills = 0;
    this.parts_collected = 0;

    this.alive = true;
    this.invuln = 0;
    this.hurtFlash = 0;
    this._walkPhase = 0;
    this._punchSide = 0;
    this._attackYaw = 0;
    this._attackHold = 0;
    this._atk = null;     // active swing, see attack()

    // Dodge roll, see dodge().
    this.dodgeTime = 0;   // seconds of travel remaining
    this.dodgeCd = 0;     // recovery lockout
    this._dodgeDir = new THREE.Vector3(0, 0, 1);

    // Stat block. Weapons read these every time they fire.
    this.stats = {
      maxHp: CFG.PLAYER.maxHp,
      hp: CFG.PLAYER.maxHp,
      speed: CFG.PLAYER.speed,
      might: 1.0,            // outgoing damage multiplier
      haste: 1.0,            // cooldown multiplier (lower = faster)
      area: 1.0,             // AoE size multiplier
      duration: 1.0,         // lingering effect multiplier
      projectiles: 0,        // flat extra projectiles
      speedProj: 1.0,        // projectile velocity multiplier
      magnet: CFG.PLAYER.pickupRadius,
      armor: 0,              // flat damage reduction
      regen: 0,              // hp per second
      greed: 1.0,            // xp multiplier
      luck: 1.0,             // chest / rare roll multiplier
      crit: 0.03,
      critMul: 2.0,
      revives: 0,
      // Dodge fuel. Both derived values are recomputed by _applyPassives, but
      // they need sane defaults here because the hunter can roll before he has
      // ever picked up Sure-Footed.
      stamina: CFG.STAMINA.base,
      staminaMax: CFG.STAMINA.base,
      staminaRegen: CFG.STAMINA.regen,
    };
  }

  /** True when a roll is affordable and off cooldown — drives the HUD glow. */
  get canDodge() {
    return this.alive && this.dodgeCd <= 0 && this.stats.stamina >= CFG.DODGE.cost;
  }

  get hp() { return this.stats.hp; }
  get maxHp() { return this.stats.maxHp; }

  addXp(amount) {
    this.xp += amount;
    this.parts_collected += amount;
    let gained = 0;
    while (this.xp >= this.xpNeeded && this.levelUps + gained < CFG.MAX_LEVEL_UPS) {
      this.xp -= this.xpNeeded;
      this.level++;
      gained++;
      this.xpNeeded = CFG.xpForLevel(this.level);
    }
    // At the cap XP still accumulates for score but stops granting picks.
    if (this.levelUps + gained >= CFG.MAX_LEVEL_UPS) this.xp = Math.min(this.xp, this.xpNeeded);
    return gained;
  }

  heal(amount) {
    const before = this.stats.hp;
    this.stats.hp = Math.min(this.stats.maxHp, this.stats.hp + amount);
    return this.stats.hp - before;
  }

  damage(amount) {
    if (this.invuln > 0 || !this.alive) return 0;
    const dealt = Math.max(1, amount - this.stats.armor);
    this.stats.hp -= dealt;
    this.invuln = CFG.PLAYER.iframes;
    this.hurtFlash = 1;
    if (this.stats.hp <= 0) {
      if (this.stats.revives > 0) {
        this.stats.revives--;
        this.stats.hp = Math.round(this.stats.maxHp * 0.55);
        this.invuln = 2.5;
        return dealt;
      }
      this.stats.hp = 0;
      this.alive = false;
    }
    return dealt;
  }

  /**
   * Starts a swing. `kind` picks the choreography:
   *   'punch' — a hook: coil away, drive through with the hips, follow across.
   *   'slash' — a two-handed sweep with a deeper lunge.
   *
   * The old version just rotated one arm forward, which read as flapping.
   * Real weight comes from the torso twisting first and the arm arriving late.
   */
  attack(kind = 'punch') {
    this._atk = {
      t: 0,
      dur: kind === 'slash' ? 0.44 : 0.3,
      kind,
      side: this._punchSide === 0 ? -1 : 1,
    };
    this._punchSide = this._punchSide === 0 ? 1 : 0;
  }

  /** Back-compat alias. */
  punch() { this.attack('punch'); }

  /**
   * Rolls in the direction of travel, spending stamina for half a second of
   * invulnerability. Returns true if the roll actually started, so the caller
   * knows whether to play the sound and spray the dust.
   *
   * The i-frames are granted up front rather than partway through the
   * animation: the player pressed the button because something was already
   * about to hit them, and a windup would make the move feel like a lie.
   */
  dodge(move) {
    if (!this.alive || this.dodgeTime > 0 || this.dodgeCd > 0) return false;
    const s = this.stats;
    if (s.stamina < CFG.DODGE.cost) return false;

    // Direction of travel, falling back to wherever he already faces so a
    // standing dodge still goes somewhere sensible instead of nowhere.
    let dx = move ? move.x : 0;
    let dz = move ? move.z : 0;
    if (dx === 0 && dz === 0) {
      dx = Math.sin(this.facing);
      dz = Math.cos(this.facing);
    }
    const len = Math.hypot(dx, dz) || 1;

    s.stamina -= CFG.DODGE.cost;
    this._dodgeDir.set(dx / len, 0, dz / len);
    this.dodgeTime = CFG.DODGE.duration;
    this.dodgeCd = CFG.DODGE.duration + CFG.DODGE.cooldown;
    // Never shorten i-frames the hunter already had from taking a hit.
    this.invuln = Math.max(this.invuln, CFG.DODGE.iframes);
    this.facing = Math.atan2(dx, dz);

    // The roll owns the body: drop any swing pose rather than blending two
    // animations that were never designed to overlap.
    this._atk = null;
    this._attackHold = 0;
    return true;
  }

  /**
   * Swing curve, normalised to [-0.5 .. 1 .. 0]:
   * wind back, snap through, ease home. Everything in the pose reads off this
   * single value so the limbs, hips and lunge stay in sync.
   */
  static swingCurve(p) {
    if (p < 0.3) return -0.5 * (p / 0.3);
    if (p < 0.6) {
      const k = (p - 0.3) / 0.3;
      return -0.5 + 1.5 * (1 - Math.pow(1 - k, 3));   // fast out
    }
    const k = (p - 0.6) / 0.4;
    return 1 - k * k;                                  // settle back
  }

  /**
   * Snap the hunter around to face an incoming attack direction for a moment.
   * Melee weapons auto-target the nearest monster, and the body needs to follow
   * the swing or the animation reads as punching empty air.
   */
  faceAttack(yaw) {
    this._attackYaw = yaw;
    this._attackHold = 0.34;
  }

  update(dt, move) {
    const s = this.stats;
    if (this.invuln > 0) this.invuln -= dt;
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3);
    if (s.regen > 0 && this.alive) this.heal(s.regen * dt);

    // Stamina trickles back whatever else is happening; the roll's own
    // cooldown is what stops you from spamming it, not a regen delay.
    if (this.alive && s.stamina < s.staminaMax) {
      s.stamina = Math.min(s.staminaMax, s.stamina + s.staminaRegen * dt);
    }
    if (this.dodgeCd > 0) this.dodgeCd = Math.max(0, this.dodgeCd - dt);

    const dodging = this.dodgeTime > 0;
    const moving = move.x !== 0 || move.z !== 0;

    if (dodging) {
      // Input is ignored mid-roll — committing to the direction is what makes
      // the move a real decision rather than a free speed boost.
      this.dodgeTime = Math.max(0, this.dodgeTime - dt);
      const k = this.dodgeTime / CFG.DODGE.duration;   // 1 -> 0
      const sp = s.speed * CFG.DODGE.speedMul * (0.35 + k * 0.65);   // launch hard, land soft
      this.vel.x = this._dodgeDir.x * sp;
      this.vel.z = this._dodgeDir.z * sp;
    } else {
      const target = s.speed;
      this.vel.x = damp(this.vel.x, move.x * target, 16, dt);
      this.vel.z = damp(this.vel.z, move.z * target, 16, dt);
    }
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    if (moving) this.aim.set(move.x, 0, move.z).normalize();

    // A roll locks the heading; otherwise an in-progress swing wins over the
    // movement direction.
    if (this._attackHold > 0) this._attackHold -= dt;
    const want = dodging
      ? null
      : this._attackHold > 0
        ? this._attackYaw
        : (moving ? Math.atan2(move.x, move.z) : null);

    if (want !== null) {
      // Shortest-arc yaw interpolation.
      let diff = want - this.facing;
      while (diff > Math.PI) diff -= TAU;
      while (diff < -Math.PI) diff += TAU;
      const rate = this._attackHold > 0 ? CFG.PLAYER.turnLerp * 2.2 : CFG.PLAYER.turnLerp;
      this.facing += diff * clamp(rate * dt, 0, 1);
    }

    this.mesh.position.set(this.pos.x, 0, this.pos.z);
    this.mesh.rotation.y = this.facing;

    // --- animation --------------------------------------------------------
    // Layered rather than a single sine on the hips: gait, weight shift,
    // breathing and head look-at all run at once, which is most of what
    // separates a walking model from a bobbing one.
    const speedFrac = Math.hypot(this.vel.x, this.vel.z) / Math.max(0.001, s.speed);
    this._walkPhase += dt * (4 + speedFrac * 7);
    this._breath = (this._breath || 0) + dt * 1.6;
    const ph = this._walkPhase;
    const swing = Math.sin(ph) * 0.55 * speedFrac;

    for (let i = 0; i < 2; i++) {
      const dir = i === 0 ? 1 : -1;
      const legPh = ph * dir;                    // opposite legs, half a cycle apart
      const thigh = Math.sin(legPh) * 0.62 * speedFrac;
      this.parts.legs[i].rotation.x = thigh;

      // The knee only bends on the recovery half of the stride — a leg that
      // bends while bearing weight reads as a stumble.
      if (this.parts.shins) {
        const lift = Math.max(0, Math.sin(legPh + 1.1));
        this.parts.shins[i].rotation.x = -lift * 1.15 * speedFrac;
      }
      // Heel strike, roll through, toe off.
      if (this.parts.feet) {
        this.parts.feet[i].rotation.x = (Math.sin(legPh + 2.2) * 0.45 - 0.1) * speedFrac;
      }
    }

    // Hips rise on each step and roll toward the planted leg.
    const stride = Math.abs(Math.sin(ph));
    this.parts.body.position.x = Math.sin(ph) * 0.035 * speedFrac;
    this.parts.body.rotation.z = -Math.sin(ph) * 0.05 * speedFrac;

    // Arms counter-swing with a real elbow, then the swing pose overrides them.
    if (!this._atk) {
      this.parts.arms[0].rotation.x = -swing * 0.7;
      this.parts.arms[1].rotation.x = swing * 0.7;
      if (this.parts.armFore) {
        // Elbows carry more bend on the forward half of the swing.
        this.parts.armFore[0].rotation.x = -0.25 - Math.max(0, -swing) * 0.9;
        this.parts.armFore[1].rotation.x = -0.25 - Math.max(0, swing) * 0.9;
      }
      if (this.parts.hands) {
        this.parts.hands[0].rotation.x = swing * 0.3;
        this.parts.hands[1].rotation.x = -swing * 0.3;
      }
    }

    // Breathing: the chest lifts and the shoulders follow, strongest at rest.
    if (this.parts.chest) {
      const breathe = Math.sin(this._breath) * (1 - speedFrac * 0.6);
      this.parts.chest.scale.y = 1 + breathe * 0.022;
      this.parts.chest.scale.z = 0.8 + breathe * 0.016;
    }

    // --- swing pose -------------------------------------------------------
    let lungeF = 0;
    if (this._atk) {
      const a = this._atk;
      a.t += dt;
      const p = a.t / a.dur;
      if (p >= 1) {
        this._atk = null;
      } else {
        const sw = Player.swingCurve(p);
        const s2 = a.side;
        const two = a.kind === 'slash';

        // Hips lead, shoulders follow — this is what sells the weight.
        this.parts.body.rotation.y = s2 * sw * (two ? 0.95 : 0.6);
        this.parts.body.rotation.x = sw * 0.14;
        this.parts.body.rotation.z = s2 * sw * -0.1;
        this.parts.body.position.y = -Math.abs(sw) * 0.07;

        // Head lags the torso slightly, then snaps to the target.
        this.parts.head.rotation.y = -s2 * sw * 0.3;

        const lead = this.parts.arms[a.side > 0 ? 1 : 0];
        const off = this.parts.arms[a.side > 0 ? 0 : 1];

        // The striking arm travels on an arc, not a straight push.
        lead.rotation.x = -0.35 - sw * 1.5;
        lead.rotation.z = s2 * (0.2 - sw * 0.85);
        lead.position.z = sw * 0.26;
        lead.position.x = -s2 * sw * 0.12;

        // Elbow and wrist snap through late, which is what gives a strike its
        // whip. The forearm trails the upper arm by about a tenth of a swing.
        const late = Player.swingCurve(Math.max(0, p - 0.08));
        const li = a.side > 0 ? 1 : 0;
        if (this.parts.armFore) {
          this.parts.armFore[li].rotation.x = -0.9 + late * 0.85;
          this.parts.armFore[1 - li].rotation.x = -0.4 - late * 0.3;
        }
        if (this.parts.hands) {
          this.parts.hands[li].rotation.x = -0.5 + late * 0.9;
          this.parts.hands[li].rotation.z = s2 * late * 0.4;
        }
        // The head leads the strike, then whips back to follow through.
        this.parts.head.rotation.y = -s2 * sw * 0.3 + (this._headYaw || 0) * 0.4;
        this.parts.head.rotation.x = sw * 0.12;

        if (two) {
          // Both hands on the haft.
          off.rotation.x = -0.35 - sw * 1.35;
          off.rotation.z = s2 * (0.1 - sw * 0.7);
          off.position.z = sw * 0.2;
        } else {
          // Counter-rotation on the free arm keeps the pose from looking stiff.
          off.rotation.x = 0.25 + sw * 0.55;
          off.rotation.z = -s2 * sw * 0.2;
          off.position.z = -sw * 0.1;
        }

        // A short lunge into the blow, applied to the mesh only so the
        // hitbox and movement are untouched.
        lungeF = Math.max(0, sw) * (two ? 0.42 : 0.26);
      }
    } else {
      this.parts.body.rotation.set(0, 0, 0);
      this.parts.head.rotation.y = 0;
      this.parts.arms[0].position.set(-0.4, 1.4, 0);
      this.parts.arms[1].position.set(0.4, 1.4, 0);
      this.parts.arms[0].rotation.z = 0;
      this.parts.arms[1].rotation.z = 0;
    }

    if (lungeF !== 0) {
      this.mesh.position.x += Math.sin(this.facing) * lungeF;
      this.mesh.position.z += Math.cos(this.facing) * lungeF;
    }

    // Body bob + coat drag (the swing pose owns the body while it is running).
    if (!this._atk) {
      this.parts.body.position.y = Math.abs(Math.sin(this._walkPhase)) * 0.045 * speedFrac;
    }
    this.parts.cloak.rotation.x = -0.06 - speedFrac * 0.34 + Math.sin(this._walkPhase * 0.5) * 0.05 * speedFrac;
    this.parts.cloak.rotation.z = Math.sin(this._walkPhase * 0.7) * 0.07 * speedFrac;

    // Coat bands trail the one above them. Each band chases the turn rate with
    // its own lag, so a hard turn ripples down the coat instead of swinging it
    // as a single rigid cone.
    if (this.parts.coatSegs) {
      const turn = (this.facing - (this._lastFacing ?? this.facing));
      this._lastFacing = this.facing;
      let wrapped = turn;
      while (wrapped > Math.PI) wrapped -= TAU;
      while (wrapped < -Math.PI) wrapped += TAU;
      const turnRate = clamp(wrapped / Math.max(dt, 1e-4), -8, 8);
      this._coatLag = this._coatLag || [0, 0, 0];
      for (let i = 0; i < this.parts.coatSegs.length; i++) {
        const target = -turnRate * (0.02 + i * 0.014) - speedFrac * (0.05 + i * 0.05);
        this._coatLag[i] = damp(this._coatLag[i], target, 9 - i * 2, dt);
        this.parts.coatSegs[i].rotation.y = this._coatLag[i] * 0.6;
        this.parts.coatSegs[i].rotation.x = this._coatLag[i] * 0.5
          + Math.sin(this._walkPhase * 0.8 - i) * 0.03 * speedFrac;
      }
    }

    // Head look-at: he tracks whatever he last swung at, then drifts back to
    // centre. A head that never turns is the single most lifeless thing about
    // a character at this camera distance.
    if (this._attackHold > 0) {
      let d = this._attackYaw - this.facing;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      this._headYaw = damp(this._headYaw || 0, clamp(d, -0.7, 0.7), 10, dt);
    } else {
      this._headYaw = damp(this._headYaw || 0, Math.sin(this._breath * 0.4) * 0.08, 3, dt);
    }
    if (!this._atk && !dodging) {
      this.parts.head.rotation.y = this._headYaw;
      this.parts.head.rotation.x = -speedFrac * 0.08 + Math.sin(this._breath) * 0.015;
    }

    // The scarf tail and lantern swing with the stride.
    if (this.parts.scarfTail) {
      this.parts.scarfTail.rotation.x = -speedFrac * 0.5 + Math.sin(this._walkPhase * 0.9) * 0.12;
      this.parts.scarfTail.rotation.z = 0.25 + Math.sin(this._walkPhase * 0.6) * 0.1 * speedFrac;
    }
    if (this.parts.lantern) {
      this.parts.lantern.rotation.z = Math.sin(this._walkPhase) * 0.18 * speedFrac;
      this.parts.lantern.rotation.x = Math.cos(this._walkPhase * 1.1) * 0.12 * speedFrac;
    }

    // --- roll pose ---------------------------------------------------------
    // Applied last so it overrides the walk cycle and the swing reset above.
    // A diving shoulder-roll rather than a somersault: from a 3/4 camera a
    // full rotation just reads as the model glitching, whereas a hard pitch
    // forward, a low crouch and a flared coat read unmistakably as a dive.
    if (dodging) {
      const p = 1 - this.dodgeTime / CFG.DODGE.duration;   // 0 -> 1
      const bell = Math.sin(p * Math.PI);                  // 0 -> 1 -> 0

      this.parts.body.rotation.x = bell * 1.5;
      this.parts.body.rotation.y = 0;
      this.parts.body.rotation.z = 0;
      this.parts.body.position.y = -bell * 0.62;

      // Chin tucked into the dive, then up again on the landing.
      this.parts.head.rotation.x = -bell * 0.7;
      this.parts.head.rotation.y = 0;

      // Legs tuck under, arms sweep back — a shape, not a T-pose in motion.
      this.parts.legs[0].rotation.x = -1.6 * bell;
      this.parts.legs[1].rotation.x = 1.15 * bell;
      this.parts.arms[0].rotation.x = 1.45 * bell;
      this.parts.arms[1].rotation.x = 1.45 * bell;
      this.parts.arms[0].rotation.z = -0.4 * bell;
      this.parts.arms[1].rotation.z = 0.4 * bell;
      if (this.parts.armFore) {
        this.parts.armFore[0].rotation.x = -1.5 * bell;
        this.parts.armFore[1].rotation.x = -1.5 * bell;
      }
      if (this.parts.shins) {
        // Heels pulled right up to the seat — the tuck is the whole shape.
        this.parts.shins[0].rotation.x = -2.1 * bell;
        this.parts.shins[1].rotation.x = -2.1 * bell;
      }

      // Coat streams out behind him.
      this.parts.cloak.rotation.x = -0.06 - bell * 1.35;
      this.parts.cloak.rotation.z = 0;

      // Skim low across the ground. Visual only — `pos` is untouched, so the
      // hitbox never leaves the floor.
      this.mesh.position.y = -bell * 0.16;
    } else if (this._rolledLastFrame) {
      // Land cleanly — otherwise the tucked head and the skim keep their
      // values forever.
      this.parts.head.rotation.x = 0;
      this.mesh.position.y = 0;
    }
    this._rolledLastFrame = dodging;

    // Lantern flicker.
    const fl = 0.85 + Math.sin(performance.now() * 0.011) * 0.1 + Math.random() * 0.06;
    this.parts.flame.scale.setScalar(fl);

    // Hurt flash tints the whole hunter red.
    if (this.hurtFlash > 0) {
      this.mesh.traverse((o) => {
        if (o.isMesh && o.material && o.material.emissive && !o.material.userData.keepEmissive) {
          o.material.emissive.setRGB(this.hurtFlash * 0.7, 0, 0);
        }
      });
    } else if (this._wasFlashing) {
      this.mesh.traverse((o) => {
        if (o.isMesh && o.material && o.material.emissive && !o.material.userData?.keepEmissive) {
          o.material.emissive.setRGB(0, 0, 0);
        }
      });
    }
    this._wasFlashing = this.hurtFlash > 0;
  }

  /** World position of the lantern flame, for lighting. */
  lanternWorld(out) {
    return this.parts.flame.getWorldPosition(out);
  }
}
