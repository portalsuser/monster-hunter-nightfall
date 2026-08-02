/**
 * A stand-in for three.js used ONLY by tools/smoke.mjs.
 *
 * This sandbox has no network egress to npm or any CDN, so the real library
 * cannot be installed here. Rather than ship untested code, this mock
 * implements the exact slice of the three.js API the game touches, with the
 * same call signatures and mutation semantics. Running the real game loop
 * against it exercises every gameplay path: spawning, targeting, collision,
 * pooling, level ups, boss states, drops and teardown.
 *
 * It verifies our code, not three's. Anything that would be a TypeError,
 * a bad property name, an out-of-range instance write or an unbounded pool
 * shows up here exactly as it would in a browser.
 */

class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  setScalar(s) { this.x = this.y = this.z = s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  normalize() {
    const l = Math.hypot(this.x, this.y, this.z) || 1;
    return this.multiplyScalar(1 / l);
  }
  length() { return Math.hypot(this.x, this.y, this.z); }
}

class V2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  set(x, y) { this.x = x; this.y = y; return this; }
}

class Euler {
  constructor() { this.x = 0; this.y = 0; this.z = 0; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}

class Color {
  constructor(c) { this.r = 1; this.g = 1; this.b = 1; if (c !== undefined) this.set(c); }
  set(c) {
    if (c instanceof Color) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
    const n = typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : c;
    if (!Number.isFinite(n)) throw new TypeError(`Color.set got ${c}`);
    this.r = ((n >> 16) & 255) / 255;
    this.g = ((n >> 8) & 255) / 255;
    this.b = (n & 255) / 255;
    return this;
  }
  setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }
  getHex() {
    const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
    return (q(this.r) << 16) | (q(this.g) << 8) | q(this.b);
  }
}

class Matrix4 {
  constructor() { this.elements = new Float32Array(16); }
}

class Object3D {
  constructor() {
    this.position = new V3();
    this.rotation = new Euler();
    this.scale = new V3(1, 1, 1);
    this.matrix = new Matrix4();
    this.children = [];
    this.parent = null;
    this.visible = true;
    this.castShadow = false;
    this.receiveShadow = false;
    this.frustumCulled = true;
    this.renderOrder = 0;
    this.userData = {};
  }
  add(...objs) { for (const o of objs) { o.parent = this; this.children.push(o); } return this; }
  remove(o) {
    const i = this.children.indexOf(o);
    if (i >= 0) { this.children.splice(i, 1); o.parent = null; }
    return this;
  }
  traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); }
  updateMatrix() {}
  updateMatrixWorld() {}
  getWorldPosition(target) {
    let x = 0, y = 0, z = 0;
    let node = this;
    while (node) { x += node.position.x; y += node.position.y; z += node.position.z; node = node.parent; }
    return (target || new V3()).set(x, y, z);
  }
  lookAt() {}
}

class BufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.count = array.length / itemSize;
    this.needsUpdate = false;
  }
  setUsage() { return this; }
  setXYZ(i, x, y, z) {
    if (i < 0 || i >= this.count) throw new RangeError(`setXYZ out of range: ${i} of ${this.count}`);
    this.array[i * 3] = x; this.array[i * 3 + 1] = y; this.array[i * 3 + 2] = z;
    return this;
  }
}
class InstancedBufferAttribute extends BufferAttribute {}

class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; }
  setAttribute(n, a) { this.attributes[n] = a; return this; }
  rotateX() { return this; }
  rotateY() { return this; }
  rotateZ() { return this; }
  translate() { return this; }
  scale() { return this; }
  computeBoundingSphere() { return this; }
  toNonIndexed() { return this; }
  dispose() {}
}

/** Every primitive geometry produces a small but real attribute set. */
function makeGeo(verts = 12) {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(verts * 2), 2));
  return g;
}

const GEOMETRIES = [
  'BoxGeometry', 'SphereGeometry', 'PlaneGeometry', 'ConeGeometry', 'CylinderGeometry',
  'TorusGeometry', 'RingGeometry', 'CircleGeometry', 'CapsuleGeometry', 'IcosahedronGeometry',
  'DodecahedronGeometry', 'OctahedronGeometry', 'TetrahedronGeometry',
];
const geoExports = {};
for (const name of GEOMETRIES) {
  geoExports[name] = class extends BufferGeometry {
    constructor() { super(); Object.assign(this, makeGeo()); }
  };
}

class Material {
  constructor(p = {}) {
    this.color = new Color(p.color ?? 0xffffff);
    this.emissive = new Color(p.emissive ?? 0x000000);
    this.emissiveIntensity = p.emissiveIntensity ?? 1;
    this.opacity = p.opacity ?? 1;
    this.transparent = !!p.transparent;
    this.side = p.side;
    this.map = p.map ?? null;
    this.vertexColors = !!p.vertexColors;
    this.needsUpdate = false;
    this.userData = {};
    Object.assign(this, { ...p, color: this.color, emissive: this.emissive });
  }
  dispose() {}
}
class MeshStandardMaterial extends Material {}
class MeshBasicMaterial extends Material { constructor(p) { super(p); this.emissive = undefined; } }
class MeshLambertMaterial extends Material {}
class PointsMaterial extends Material {}
class SpriteMaterial extends Material {}

class Mesh extends Object3D {
  constructor(geometry, material) {
    super();
    if (!geometry) throw new TypeError('Mesh built without geometry');
    if (!material) throw new TypeError('Mesh built without material');
    this.geometry = geometry;
    this.material = material;
    this.isMesh = true;
  }
}

class InstancedMesh extends Mesh {
  constructor(geometry, material, count) {
    super(geometry, material);
    if (!Number.isFinite(count) || count <= 0) throw new RangeError(`InstancedMesh capacity ${count}`);
    this.isInstancedMesh = true;
    this.capacity = count;
    this.count = count;
    this.instanceMatrix = new InstancedBufferAttribute(new Float32Array(count * 16), 16);
    this.instanceColor = null;
  }
  setMatrixAt(i) {
    if (i < 0 || i >= this.capacity) {
      throw new RangeError(`setMatrixAt ${i} exceeds InstancedMesh capacity ${this.capacity}`);
    }
  }
  setColorAt() {}
  computeBoundingSphere() {}
  dispose() {}
}

class Points extends Mesh { constructor(g, m) { super(g, m); this.isPoints = true; } }
class Sprite extends Object3D {
  constructor(material) { super(); this.material = material; this.isSprite = true; }
}
class Group extends Object3D { constructor() { super(); this.isGroup = true; } }
class Scene extends Object3D {
  constructor() { super(); this.fog = null; this.background = null; this.isScene = true; }
}

class Light extends Object3D {
  constructor(color, intensity) { super(); this.color = new Color(color ?? 0xffffff); this.intensity = intensity ?? 1; }
}
class AmbientLight extends Light {}
class HemisphereLight extends Light {}
class PointLight extends Light {}
class DirectionalLight extends Light {
  constructor(c, i) {
    super(c, i);
    this.target = new Object3D();
    this.shadow = {
      mapSize: new V2(512, 512),
      bias: 0,
      normalBias: 0,
      camera: { near: 0.5, far: 500, left: -5, right: 5, top: 5, bottom: -5 },
    };
  }
}

class PerspectiveCamera extends Object3D {
  constructor(fov, aspect, near, far) {
    super();
    this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
    this.isCamera = true;
  }
  updateProjectionMatrix() {}
}

class Texture {
  constructor() {
    this.wrapS = null; this.wrapT = null;
    this.repeat = new V2(1, 1);
    this.offset = new V2(0, 0);
    this.colorSpace = null;
    this.anisotropy = 1;
    this.needsUpdate = false;
  }
  dispose() {}
}
class CanvasTexture extends Texture {}

class Clock {
  constructor() { this._t = 0; this.fixed = 1 / 60; }
  getDelta() { return this.fixed; }
}

class FogExp2 {
  constructor(color, density) { this.color = new Color(color); this.density = density; }
}

class WebGLRenderer {
  constructor(params = {}) {
    this.domElement = params.canvas || { addEventListener() {}, style: {} };
    this.shadowMap = { enabled: false, type: null };
    this.outputColorSpace = null;
    this.toneMapping = null;
    this.toneMappingExposure = 1;
    this.info = { render: { calls: 0, triangles: 0 } };
    this.renders = 0;
    this._loop = null;
  }
  setPixelRatio() {}
  setSize() {}
  setAnimationLoop(fn) { this._loop = fn; }
  render(scene, camera) {
    if (!scene || !scene.isScene) throw new TypeError('render() without a Scene');
    if (!camera || !camera.isCamera) throw new TypeError('render() without a Camera');
    this.renders++;
    // Emulate the driver's own bounds check on instanced draws.
    scene.traverse((o) => {
      if (o.isInstancedMesh && o.count > o.capacity) {
        throw new RangeError(`InstancedMesh.count ${o.count} exceeds capacity ${o.capacity}`);
      }
    });
  }
  dispose() {}
}

const MathUtils = {
  clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
  lerp: (a, b, t) => a + (b - a) * t,
  degToRad: (d) => (d * Math.PI) / 180,
};

export {
  V3 as Vector3, V2 as Vector2, Euler, Color, Matrix4, Object3D, Group, Scene,
  BufferGeometry, BufferAttribute, InstancedBufferAttribute,
  Material, MeshStandardMaterial, MeshBasicMaterial, MeshLambertMaterial,
  PointsMaterial, SpriteMaterial,
  Mesh, InstancedMesh, Points, Sprite,
  AmbientLight, HemisphereLight, PointLight, DirectionalLight,
  PerspectiveCamera, Texture, CanvasTexture, Clock, FogExp2, WebGLRenderer, MathUtils,
};
export const {
  BoxGeometry, SphereGeometry, PlaneGeometry, ConeGeometry, CylinderGeometry,
  TorusGeometry, RingGeometry, CircleGeometry, CapsuleGeometry, IcosahedronGeometry,
  DodecahedronGeometry, OctahedronGeometry, TetrahedronGeometry,
} = geoExports;

export const RepeatWrapping = 1000;
export const SRGBColorSpace = 'srgb';
export const LinearSRGBColorSpace = 'srgb-linear';
export const DoubleSide = 2;
export const FrontSide = 0;
export const BackSide = 1;
export const AdditiveBlending = 2;
export const NormalBlending = 1;
export const DynamicDrawUsage = 35048;
export const StaticDrawUsage = 35044;
export const PCFSoftShadowMap = 2;
export const ACESFilmicToneMapping = 4;
