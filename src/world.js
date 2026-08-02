import * as THREE from 'three';
import { CFG } from './config.js';
import { TAU } from './utils.js';

/** Deterministic PRNG so a given forest tile always regenerates identically. */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tileSeed(tx, tz) {
  return (Math.imul(tx, 374761393) ^ Math.imul(tz, 668265263)) | 0;
}

/** Procedural ground texture — mottled forest floor, no image assets. */
function makeGroundTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');

  g.fillStyle = '#3a4a2c';
  g.fillRect(0, 0, S, S);

  // Soft blotches of moss and dirt.
  for (let i = 0; i < 620; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 4 + Math.random() * 26;
    const shade = Math.random();
    const col = shade < 0.45 ? [70, 94, 52] : shade < 0.8 ? [52, 66, 40] : [86, 76, 46];
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},0.75)`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }

  // Scattered twigs / leaf litter for high-frequency detail.
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    g.strokeStyle = `rgba(${72 + Math.random() * 40},${62 + Math.random() * 34},${34 + Math.random() * 20},0.55)`;
    g.lineWidth = 0.7 + Math.random();
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (Math.random() - 0.5) * 9, y + (Math.random() - 0.5) * 9);
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.tileSize = CFG.WORLD.tileSize;
    this.grid = CFG.WORLD.tileGrid;
    this.half = Math.floor(this.grid / 2);
    this.perTile = CFG.WORLD.treesPerTile;
    this.rocksPerTile = CFG.WORLD.rocksPerTile;
    this.fernsPerTile = CFG.WORLD.fernsPerTile;

    // Tracks which world tile currently occupies each grid slot, so we only
    // rebuild a slot when the player actually crosses a boundary.
    this.slotTiles = new Array(this.grid * this.grid).fill(null);

    this._buildLights();
    this._buildGround();
    this._buildProps();
    this._buildFireflies();

    this._dummy = new THREE.Object3D();
    this._lastTile = { x: NaN, z: NaN };
  }

  _buildLights() {
    const { scene } = this;
    scene.fog = new THREE.FogExp2(CFG.WORLD.fogColor, CFG.WORLD.fogDensity);
    scene.background = new THREE.Color(CFG.WORLD.fogColor);

    // Cold ambient bounce — keeps shadowed sides readable without flattening.
    const hemi = new THREE.HemisphereLight(0x5b7fae, 0x1b2414, 1.5);
    scene.add(hemi);

    // Moonlight. Deliberately dim and blue; the lantern does the real work.
    const moon = new THREE.DirectionalLight(0xc2ddff, 2.15);
    moon.position.set(-24, 40, -18);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.near = 1;
    moon.shadow.camera.far = 110;
    const s = 34;
    moon.shadow.camera.left = -s;
    moon.shadow.camera.right = s;
    moon.shadow.camera.top = s;
    moon.shadow.camera.bottom = -s;
    moon.shadow.bias = -0.0018;
    moon.shadow.normalBias = 0.02;
    scene.add(moon);
    scene.add(moon.target);
    this.moon = moon;

    // Warm lantern carried by the hunter — repositioned each frame.
    const lantern = new THREE.PointLight(0xffbc6b, 40, 34, 1.6);
    lantern.position.set(0, 2.2, 0);
    scene.add(lantern);
    this.lantern = lantern;

    scene.add(new THREE.AmbientLight(0x39456a, 1.35));
  }

  _buildGround() {
    const size = this.tileSize * (this.grid + 1);
    const geo = new THREE.PlaneGeometry(size, size, 32, 32);
    geo.rotateX(-Math.PI / 2);
    this.groundTex = makeGroundTexture();
    const mat = new THREE.MeshStandardMaterial({
      map: this.groundTex,
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
    });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.ground.position.y = 0;
    this.scene.add(this.ground);

    // A dark vignette ring that sits just above the ground and fades the world
    // out toward the fog — sells the "deep forest" feel far cheaper than fog
    // alone at this camera angle.
    const ringGeo = new THREE.RingGeometry(36, 62, 96, 1);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x02040a,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.vignette = new THREE.Mesh(ringGeo, ringMat);
    this.vignette.position.y = 0.12;
    this.vignette.renderOrder = 2;
    this.scene.add(this.vignette);
  }

  _buildProps() {
    const total = this.grid * this.grid * this.perTile;

    // --- pine trunks -------------------------------------------------------
    const trunkGeo = new THREE.CylinderGeometry(0.17, 0.32, 3.2, 12, 2);
    trunkGeo.translate(0, 1.6, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x554636, roughness: 0.92 });
    this.trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, total);
    this.trunks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.trunks.castShadow = true;
    this.trunks.frustumCulled = false;
    this.scene.add(this.trunks);

    // --- foliage: two stacked cones per tree -------------------------------
    const lowGeo = new THREE.ConeGeometry(1.55, 3.4, 16, 3);
    lowGeo.translate(0, 1.7, 0);
    const topGeo = new THREE.ConeGeometry(1.05, 3.0, 16, 3);
    topGeo.translate(0, 1.5, 0);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f6038, roughness: 0.9, flatShading: false });
    const leafMat2 = new THREE.MeshStandardMaterial({ color: 0x3c7546, roughness: 0.9, flatShading: false });

    this.foliageLow = new THREE.InstancedMesh(lowGeo, leafMat, total);
    this.foliageTop = new THREE.InstancedMesh(topGeo, leafMat2, total);
    for (const m of [this.foliageLow, this.foliageTop]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.frustumCulled = false;
      this.scene.add(m);
    }

    // --- rocks / stumps ----------------------------------------------------
    const rockTotal = this.grid * this.grid * this.rocksPerTile;
    const rockGeo = new THREE.DodecahedronGeometry(0.6, 1);
    // Rocks keep flat shading deliberately: faceted reads as stone, not as
    // missing geometry. Everything organic is smooth.
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x555d68, roughness: 1, flatShading: true });
    this.rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockTotal);
    this.rocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rocks.castShadow = true;
    this.rocks.receiveShadow = true;
    this.rocks.frustumCulled = false;
    this.scene.add(this.rocks);

    // --- ferns / undergrowth ------------------------------------------------
    // A cheap fourth prop layer. Shares the tile system, so it recycles with
    // everything else and costs one extra draw call.
    const fernTotal = this.grid * this.grid * this.fernsPerTile;
    const fernGeo = new THREE.ConeGeometry(0.34, 0.85, 6, 2, true);
    fernGeo.translate(0, 0.42, 0);
    const fernMat = new THREE.MeshStandardMaterial({
      color: 0x376b3c, roughness: 0.85, side: THREE.DoubleSide,
    });
    this.ferns = new THREE.InstancedMesh(fernGeo, fernMat, fernTotal);
    this.ferns.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ferns.castShadow = false;
    this.ferns.receiveShadow = true;
    this.ferns.frustumCulled = false;
    this.scene.add(this.ferns);

    // --- ground fog cards --------------------------------------------------
    // Cheap billboarded mist that drifts near the floor.
    const mistGeo = new THREE.PlaneGeometry(18, 6);
    const mistMat = new THREE.MeshBasicMaterial({
      color: 0x2c3a4d,
      transparent: true,
      opacity: 0.075,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mist = new THREE.InstancedMesh(mistGeo, mistMat, 26);
    this.mist.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mist.frustumCulled = false;
    this.mist.renderOrder = 3;
    this.scene.add(this.mist);
    this._mistSeeds = [];
    for (let i = 0; i < 26; i++) {
      this._mistSeeds.push({
        a: Math.random() * TAU,
        r: 8 + Math.random() * 34,
        y: 0.7 + Math.random() * 1.6,
        spd: 0.05 + Math.random() * 0.12,
        s: 0.7 + Math.random() * 1.1,
      });
    }
  }

  _buildFireflies() {
    const N = 90;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 90;
      pos[i * 3 + 1] = 0.6 + Math.random() * 4.5;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 90;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xb9ff6a,
      size: 0.17,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.fireflies = new THREE.Points(geo, mat);
    this.fireflies.frustumCulled = false;
    this.scene.add(this.fireflies);
    this._fireflyPhase = new Float32Array(N).map(() => Math.random() * TAU);
  }

  /** Rebuild the props belonging to one grid slot for a new world tile. */
  _fillTile(slot, tx, tz) {
    const rng = mulberry32(tileSeed(tx, tz));
    const d = this._dummy;
    const size = this.tileSize;
    const ox = tx * size;
    const oz = tz * size;

    const base = slot * this.perTile;
    for (let i = 0; i < this.perTile; i++) {
      const x = ox + (rng() - 0.5) * size;
      const z = oz + (rng() - 0.5) * size;
      const scale = 0.75 + rng() * 1.35;
      const rot = rng() * TAU;
      const lean = (rng() - 0.5) * 0.13;

      d.position.set(x, 0, z);
      d.rotation.set(lean, rot, lean * 0.6);
      d.scale.setScalar(scale);
      d.updateMatrix();
      this.trunks.setMatrixAt(base + i, d.matrix);

      d.position.set(x, 2.6 * scale, z);
      d.scale.setScalar(scale);
      d.updateMatrix();
      this.foliageLow.setMatrixAt(base + i, d.matrix);

      d.position.set(x, 4.6 * scale, z);
      d.scale.setScalar(scale * 0.92);
      d.updateMatrix();
      this.foliageTop.setMatrixAt(base + i, d.matrix);
    }

    const fbase = slot * this.fernsPerTile;
    for (let i = 0; i < this.fernsPerTile; i++) {
      const x = ox + (rng() - 0.5) * size;
      const z = oz + (rng() - 0.5) * size;
      const fs = 0.6 + rng() * 0.9;
      d.position.set(x, 0, z);
      d.rotation.set((rng() - 0.5) * 0.25, rng() * TAU, (rng() - 0.5) * 0.25);
      d.scale.set(fs, fs * (0.7 + rng() * 0.7), fs);
      d.updateMatrix();
      this.ferns.setMatrixAt(fbase + i, d.matrix);
    }

    const rbase = slot * this.rocksPerTile;
    for (let i = 0; i < this.rocksPerTile; i++) {
      const x = ox + (rng() - 0.5) * size;
      const z = oz + (rng() - 0.5) * size;
      const s = 0.4 + rng() * 1.1;
      d.position.set(x, s * 0.28, z);
      d.rotation.set(rng() * TAU, rng() * TAU, rng() * TAU);
      d.scale.set(s, s * (0.5 + rng() * 0.5), s);
      d.updateMatrix();
      this.rocks.setMatrixAt(rbase + i, d.matrix);
    }
  }

  /** Called every frame with the player's world position. */
  update(dt, px, pz, elapsed) {
    const size = this.tileSize;
    const ptx = Math.round(px / size);
    const ptz = Math.round(pz / size);

    if (ptx !== this._lastTile.x || ptz !== this._lastTile.z) {
      this._lastTile.x = ptx;
      this._lastTile.z = ptz;
      let dirty = false;
      for (let gz = -this.half; gz <= this.half; gz++) {
        for (let gx = -this.half; gx <= this.half; gx++) {
          const slot = (gz + this.half) * this.grid + (gx + this.half);
          const tx = ptx + gx;
          const tz = ptz + gz;
          const key = `${tx},${tz}`;
          if (this.slotTiles[slot] !== key) {
            this.slotTiles[slot] = key;
            this._fillTile(slot, tx, tz);
            dirty = true;
          }
        }
      }
      if (dirty) {
        this.trunks.instanceMatrix.needsUpdate = true;
        this.foliageLow.instanceMatrix.needsUpdate = true;
        this.foliageTop.instanceMatrix.needsUpdate = true;
        this.rocks.instanceMatrix.needsUpdate = true;
        this.ferns.instanceMatrix.needsUpdate = true;
        this.trunks.computeBoundingSphere();
      }
      // Snap the shared ground plane so it always sits under the player.
      //
      // No texture offset is needed: the plane spans tileSize * (grid + 1)
      // world units across `repeat` tiles, and it jumps by exactly one
      // tileSize, which works out to a whole number of texture repeats. The
      // pattern is already seamless across the jump — applying an offset in
      // world units (rather than repeat units) would desync it and pop.
      this.ground.position.set(ptx * size, 0, ptz * size);
    }

    this.vignette.position.set(px, 0.12, pz);
    this.fireflies.position.set(ptx * size, 0, ptz * size);

    // Moon shadow frustum tracks the player.
    this.moon.position.set(px - 24, 40, pz - 18);
    this.moon.target.position.set(px, 0, pz);
    this.moon.target.updateMatrixWorld();

    // Drifting mist.
    const d = this._dummy;
    for (let i = 0; i < this._mistSeeds.length; i++) {
      const m = this._mistSeeds[i];
      m.a += m.spd * dt * 0.25;
      d.position.set(px + Math.cos(m.a) * m.r, m.y, pz + Math.sin(m.a) * m.r);
      d.rotation.set(-Math.PI / 2.2, m.a * 0.4, 0);
      d.scale.set(m.s, m.s, m.s);
      d.updateMatrix();
      this.mist.setMatrixAt(i, d.matrix);
    }
    this.mist.instanceMatrix.needsUpdate = true;

    // Fireflies bob on independent sine phases.
    const pos = this.fireflies.geometry.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < this._fireflyPhase.length; i++) {
      const p = this._fireflyPhase[i] + elapsed * (0.6 + (i % 7) * 0.09);
      arr[i * 3 + 1] += Math.sin(p) * dt * 0.55;
      if (arr[i * 3 + 1] < 0.4) arr[i * 3 + 1] = 0.4;
      if (arr[i * 3 + 1] > 5.5) arr[i * 3 + 1] = 5.5;
    }
    pos.needsUpdate = true;
  }

  setLanternAt(x, y, z) {
    this.lantern.position.set(x, y, z);
  }
}
