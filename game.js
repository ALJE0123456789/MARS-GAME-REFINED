/* =====================================================================
   MARS OUTPOST  -  game.js
   PART 1 of 2 : Setup, Environment & Structures
   Part 2 (Physics, Gameplay & Game Loop) is pasted directly BELOW this.
   Built for Three.js r128 (the version your index.html already loads).
   ===================================================================== */
'use strict';

// ---------------------------------------------------------------------
// 0. CONFIG
// ---------------------------------------------------------------------
const TASK_COUNT  = 50;       // tasks needed to win
const DAY_LENGTH  = 900;      // seconds for one full Mars day/night cycle
const R_PLANET    = 6000;     // radius of the curved planet under the map (space view)
const PLANET_DROP = 45;       // planet surface sits this far under the terrain
const WORLD_HALF  = 700;      // terrain mesh half-size
const STATION     = { x: 80, y: 1150, z: -260, deckR: 70 };   // orbital station deck centre
const ROLES = {
  1: { name: 'ENGINEER', color: 0x3498db },
  2: { name: 'EXPLORER', color: 0x2ecc71 },
  3: { name: 'MEDIC',    color: 0xe74c3c }
};

// Shared game state (Part 2 reads/writes this)
const G = { state: 'menu', time: 0, tod: 0.12, space: 0, night: 0, storm: 0,
            blackout: 0, dishSpin: 1, sunDir: null };

// ---------------------------------------------------------------------
// 1. UTILITIES
// ---------------------------------------------------------------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp  = (a, b, t) => a + (b - a) * t;
const rand  = (a, b) => a + Math.random() * (b - a);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// hex (sRGB, as you see it) -> linear colour used by lights/materials (correct colours with sRGB output)
const lin = hex => new THREE.Color(hex).convertSRGBToLinear();

// Perlin noise (seeded) -------------------------------------------------
const PERM = new Uint8Array(512);
(function () {
  const r = mulberry32(1337), p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();
const GRAD = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
function perlin(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, X = xi & 255, Y = yi & 255;
  const g = (h, dx, dy) => { const v = GRAD[h & 7]; return v[0] * dx + v[1] * dy; };
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  const u = fade(xf), v = fade(yf);
  const aa = PERM[PERM[X] + Y], ab = PERM[PERM[X] + Y + 1], ba = PERM[PERM[X + 1] + Y], bb = PERM[PERM[X + 1] + Y + 1];
  return lerp(lerp(g(aa, xf, yf), g(ba, xf - 1, yf), u), lerp(g(ab, xf, yf - 1), g(bb, xf - 1, yf - 1), u), v);
}

// Material / mesh helpers -----------------------------------------------
function stdMat(hex, o = {}) {
  const { emissive, ...rest } = o;
  const m = new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.7, metalness: 0.2 }, rest));
  m.color.copy(lin(hex));
  if (emissive !== undefined) m.emissive.copy(lin(emissive));
  return m;
}
function glowMat(hex, opacity = 1, additive = true) {
  const m = new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.DoubleSide });
  m.color.copy(lin(hex)); return m;
}
function basicMat(hex, o = {}) { const m = new THREE.MeshBasicMaterial(o); m.color.copy(lin(hex)); return m; }
function mesh(geo, mat, x = 0, y = 0, z = 0, parent = null, shadow = true) {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z);
  if (shadow) { m.castShadow = true; m.receiveShadow = true; }
  if (parent) parent.add(m);
  return m;
}
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
function holoTex(lines, hex = '#7ff6ff', w = 512, h = 256) {
  return canvasTex(w, h, (c) => {
    c.clearRect(0, 0, w, h); c.fillStyle = 'rgba(0,30,45,0.55)'; c.fillRect(0, 0, w, h);
    c.strokeStyle = hex; c.lineWidth = 6; c.strokeRect(6, 6, w - 12, h - 12);
    c.fillStyle = hex; c.textAlign = 'center'; c.shadowColor = hex; c.shadowBlur = 12;
    lines.forEach((ln, i) => { c.font = (i === 0 ? 'bold 46px' : '30px') + ' Orbitron, monospace'; c.fillText(ln, w / 2, 70 + i * 52); });
  });
}
const TEX = {
  hazard: canvasTex(128, 128, (c, w, h) => {
    c.fillStyle = '#f1c40f'; c.fillRect(0, 0, w, h); c.fillStyle = '#16161a';
    for (let i = -h; i < w + h; i += 32) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + 16, 0); c.lineTo(i + 16 + h, h); c.lineTo(i + h, h); c.fill(); }
  }),
  grain: canvasTex(128, 128, (c, w, h) => {
    for (let i = 0; i < w * h * 0.6; i++) { const v = 205 + Math.random() * 50 | 0; c.fillStyle = `rgb(${v},${v},${v})`; c.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
  }, [110, 110]),
  solar: canvasTex(256, 128, (c, w, h) => {
    c.fillStyle = '#0a1a3a'; c.fillRect(0, 0, w, h); c.strokeStyle = '#3f78c9'; c.lineWidth = 2;
    for (let x = 0; x <= w; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y <= h; y += 32) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.fillStyle = 'rgba(120,190,255,0.18)'; c.fillRect(0, 0, w, h / 2);
  }),
  hex: canvasTex(256, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h); c.strokeStyle = 'rgba(120,230,255,0.9)'; c.lineWidth = 3;
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      const cx = x * 56 + (y % 2) * 28, cy = y * 50; c.beginPath();
      for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; c.lineTo(cx + 28 * Math.cos(a), cy + 28 * Math.sin(a)); }
      c.closePath(); c.stroke();
    }
  }, [10, 1]),
  stripes: canvasTex(64, 64, (c, w, h) => {
    c.fillStyle = '#111'; c.fillRect(0, 0, w, h); c.fillStyle = '#e67e22'; for (let y = 0; y < h; y += 16) c.fillRect(0, y, w, 8);
  }, [1, 12]),
  deck: canvasTex(512, 512, (c, w, h) => {
    c.fillStyle = '#1c2230'; c.fillRect(0, 0, w, h); c.strokeStyle = '#2f3c57'; c.lineWidth = 2;
    for (let i = 0; i <= w; i += 64) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, h); c.stroke(); c.beginPath(); c.moveTo(0, i); c.lineTo(w, i); c.stroke(); }
    c.strokeStyle = '#4fd1ff'; c.lineWidth = 4; c.beginPath(); c.arc(w / 2, h / 2, w * 0.46, 0, 7); c.stroke();
    c.strokeStyle = '#f1c40f'; c.setLineDash([22, 16]); c.beginPath(); c.arc(w / 2, h / 2, w * 0.3, 0, 7); c.stroke();
  })
};

// ---------------------------------------------------------------------
// 2. AUDIO  (fully procedural; uses assets/background.mp3 if it exists)
// ---------------------------------------------------------------------
const SND = {
  ctx: null, master: null, muted: false, wind: null, eng: null, musicStarted: false, synthDone: false,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = 0.8; this.master.connect(c.destination);
    const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    // wind / dust-storm layer
    const ws = c.createBufferSource(); ws.buffer = buf; ws.loop = true;
    const wf = c.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 380; wf.Q.value = 0.7;
    const wg = c.createGain(); wg.gain.value = 0;
    ws.connect(wf); wf.connect(wg); wg.connect(this.master); ws.start();
    this.wind = { gain: wg, filter: wf };
    // hover engine layer
    const o1 = c.createOscillator(), o2 = c.createOscillator(), ef = c.createBiquadFilter(), eg = c.createGain();
    o1.type = 'sawtooth'; o2.type = 'square'; ef.type = 'lowpass'; ef.frequency.value = 500; eg.gain.value = 0;
    o1.connect(ef); o2.connect(ef); ef.connect(eg); eg.connect(this.master); o1.start(); o2.start();
    this.eng = { o1, o2, filter: ef, gain: eg };
  },
  startMusic() {
    if (this.musicStarted) return; this.musicStarted = true;
    const bgm = document.getElementById('bgm'), fb = () => this.synthMusic();
    if (!bgm) return fb();
    bgm.volume = 0.45; bgm.addEventListener('error', fb, { once: true });
    const p = bgm.play(); if (p && p.catch) p.catch(fb);   // missing/blocked file -> procedural ambient
  },
  synthMusic() {
    if (this.synthDone || !this.ctx) return; this.synthDone = true;
    const c = this.ctx, g = c.createGain(), f = c.createBiquadFilter();
    g.gain.value = 0.07; f.type = 'lowpass'; f.frequency.value = 900; g.connect(f); f.connect(this.master);
    [55, 82.4, 110, 164.8, 220].forEach((fr, i) => {
      const o = c.createOscillator(), lg = c.createGain(), lfo = c.createOscillator(), la = c.createGain();
      o.type = i % 2 ? 'sine' : 'triangle'; o.frequency.value = fr; o.detune.value = (i - 2) * 6;
      lg.gain.value = 0.5; lfo.frequency.value = 0.05 + i * 0.021; la.gain.value = 0.4;
      lfo.connect(la); la.connect(lg.gain); lfo.start(); o.connect(lg); lg.connect(g); o.start();
    });
    const notes = [440, 493.9, 587.3, 659.3, 880];
    setInterval(() => { if (G.state === 'playing' && Math.random() < 0.6) this.tone(notes[Math.floor(Math.random() * 5)], 2.5, 'sine', 0.035); }, 3800);
  },
  tone(f, dur, type = 'sine', vol = 0.1, to = null, delay = 0) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  },
  noise(dur, vol, freq = 800) {
    if (!this.ctx) return;
    const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noiseBuf; f.type = 'lowpass'; f.frequency.value = freq;
    g.gain.setValueAtTime(vol, c.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(); s.stop(c.currentTime + dur);
  },
  play(n) {
    if (!this.ctx) return;
    switch (n) {
      case 'door':   this.tone(60, 1.2, 'triangle', 0.25, 150); this.noise(0.9, 0.08, 500); break;
      case 'work':   this.tone(50 + Math.random() * 50, 0.1, 'sawtooth', 0.05); break;
      case 'refill': this.tone(400, 0.5, 'sine', 0.15, 800); break;
      case 'alarm':  this.tone(880, 0.18, 'square', 0.07); break;
      case 'lowpwr': this.tone(140, 0.3, 'sawtooth', 0.07, 90); break;
      case 'done':   [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.09, null, i * 0.08)); break;
      case 'spawn':  this.tone(200, 0.9, 'sawtooth', 0.1, 1200); this.noise(0.9, 0.12, 2500); break;
      case 'boom':   this.noise(1.2, 0.45, 350); this.tone(90, 0.9, 'sine', 0.3, 30); break;
      case 'hit':    this.noise(0.3, 0.3, 1200); this.tone(120, 0.25, 'square', 0.12, 60); break;
      case 'deny':   this.tone(180, 0.18, 'square', 0.07); break;
      case 'click':  this.tone(900, 0.05, 'triangle', 0.05); break;
      case 'enter':  this.tone(300, 0.25, 'sine', 0.1, 600); break;
      case 'meteor': this.noise(0.8, 0.2, 2200); this.tone(900, 0.6, 'sawtooth', 0.04, 200); break;
    }
  },
  setWind(level) { if (!this.wind) return; const t = this.ctx.currentTime; this.wind.gain.gain.setTargetAtTime(level * 0.35, t, 0.4); this.wind.filter.frequency.setTargetAtTime(300 + level * 700, t, 0.4); },
  setEngine(level, pitch) {
    if (!this.eng) return; const t = this.ctx.currentTime;
    this.eng.gain.gain.setTargetAtTime(level * 0.11, t, 0.15);
    this.eng.o1.frequency.setTargetAtTime(40 + pitch * 90, t, 0.1); this.eng.o2.frequency.setTargetAtTime(20 + pitch * 45, t, 0.1);
    this.eng.filter.frequency.setTargetAtTime(250 + pitch * 900, t, 0.15);
  },
  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.8;
    const b = document.getElementById('bgm'); if (b) b.muted = this.muted;
    return this.muted;
  }
};

// ---------------------------------------------------------------------
// 3. RENDERER, CAMERA, LIGHTS
// ---------------------------------------------------------------------
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xb86a45, 0.0016);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.3, 6000);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.6);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 1.3);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
Object.assign(dirLight.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 10, far: 900 });
dirLight.shadow.camera.updateProjectionMatrix();
dirLight.shadow.bias = -0.0004; dirLight.shadow.normalBias = 0.6;
scene.add(dirLight); scene.add(dirLight.target);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (typeof PARTICLE_UNIFORMS !== 'undefined') PARTICLE_UNIFORMS.uScale.value = renderer.domElement.height * 0.866;
});

// ---------------------------------------------------------------------
// 4. SKY, STARS, SUN, MOONS, PLANET
// ---------------------------------------------------------------------
const skyGroup = new THREE.Group(); scene.add(skyGroup);
const FOG_CHUNKS = '#include <tonemapping_fragment>\n#include <encodings_fragment>';
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  uniforms: { uHorizon: { value: lin(0xd2855a) }, uZenith: { value: lin(0x6d3a30) }, uSunDir: { value: V3(0, 1, 0) },
              uSunColor: { value: lin(0xffc890) }, uSpace: { value: 0 }, uGlow: { value: 1 } },
  vertexShader: 'varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `uniform vec3 uHorizon,uZenith,uSunDir,uSunColor; uniform float uSpace,uGlow; varying vec3 vDir;
    void main(){ vec3 d=normalize(vDir); float h=clamp(d.y,0.0,1.0);
      vec3 col=mix(uHorizon,uZenith,pow(h,0.5));
      col=mix(col,uHorizon*0.55,1.0-smoothstep(-0.3,0.0,d.y));
      col=mix(col,vec3(0.0006,0.0009,0.004),uSpace);
      float s=max(dot(d,uSunDir),0.0);
      col+=uSunColor*(pow(s,5.0)*0.25+pow(s,40.0)*0.55)*uGlow;
      gl_FragColor=vec4(col,1.0);
      ${FOG_CHUNKS} }`
});
const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), skyMat);
skyMesh.renderOrder = -10; skyMesh.frustumCulled = false; skyGroup.add(skyMesh);

const starsMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
(function () {
  const r = mulberry32(99), n = 3500, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    p[i * 3] = Math.cos(a) * s * 4800; p[i * 3 + 1] = u * 4800; p[i * 3 + 2] = Math.sin(a) * s * 4800;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const pts = new THREE.Points(g, starsMat); pts.frustumCulled = false; pts.renderOrder = -9; skyGroup.add(pts);
})();
const sunTex = canvasTex(128, 128, (c, w, h) => {
  const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.12, 'rgba(255,230,190,0.95)');
  g.addColorStop(0.4, 'rgba(255,170,100,0.25)'); g.addColorStop(1, 'rgba(255,120,60,0)');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
});
const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
sunSprite.scale.set(900, 900, 1); sunSprite.renderOrder = -8; skyGroup.add(sunSprite);
const moonA = mesh(new THREE.SphereGeometry(55, 20, 14), basicMat(0xb9aea6, { fog: false }), 0, 0, 0, skyGroup, false);
const moonB = mesh(new THREE.SphereGeometry(26, 16, 12), basicMat(0x9a8f88, { fog: false }), 0, 0, 0, skyGroup, false);
moonA.renderOrder = moonB.renderOrder = -7;

// the planet itself (so you see a curved horizon from orbit)
const planetTex = canvasTex(1024, 512, (c, w, h) => {
  c.fillStyle = '#9a4a2c'; c.fillRect(0, 0, w, h); const r = mulberry32(5);
  for (let i = 0; i < 700; i++) {
    const x = r() * w, y = r() * h, rad = 10 + r() * 90, k = r();
    c.fillStyle = k < 0.45 ? 'rgba(70,28,18,0.14)' : k < 0.8 ? 'rgba(220,150,90,0.12)' : 'rgba(40,20,20,0.18)';
    c.beginPath(); c.ellipse(x, y, rad, rad * (0.4 + r() * 0.6), r() * 3, 0, 7); c.fill();
  }
});
const planet = new THREE.Mesh(new THREE.SphereGeometry(R_PLANET, 128, 64),
  new THREE.MeshStandardMaterial({ map: planetTex, roughness: 1, metalness: 0 }));
planet.position.y = -R_PLANET - PLANET_DROP; planet.receiveShadow = false; scene.add(planet);

// Day/night + atmosphere/space transition. focus = player or hover position.
const PAL = {
  dayH: lin(0xd2855a), dayZ: lin(0x6d3a30), duskH: lin(0x8a5a72), duskZ: lin(0x2a1c46), nightH: lin(0x1c1020), nightZ: lin(0x03030a),
  stormH: lin(0x8a4422), stormZ: lin(0x4e2412),
  sunDay: lin(0xffe2c0), sunDusk: lin(0x7fa4ff), sunNight: lin(0x3a4a88),
  gndDay: lin(0x5a2c1c), gndNight: lin(0x140a10)
};
const _h = new THREE.Color(), _z = new THREE.Color(), _s = new THREE.Color(), _t = new THREE.Color();
function mix3(out, a, wa, b, wb, c, wc) { out.setRGB(a.r * wa + b.r * wb + c.r * wc, a.g * wa + b.g * wb + c.g * wc, a.b * wa + b.b * wb + c.b * wc); }
G.sunDir = V3(0, 1, 0);

function updateEnvironment(dt, focus) {
  G.tod = (G.tod + dt / DAY_LENGTH) % 1;
  const camY = camera.position.y;
  const space = G.space = smoothstep(120, 700, camY);
  const a = G.tod * Math.PI * 2;
  let se = Math.sin(a); se = lerp(se, Math.max(se, 0.34), space);        // the sun is always up in orbit
  G.sunDir.set(Math.cos(a) * 0.85, se, 0.45).normalize();
  const e = G.sunDir.y;
  const wDay = smoothstep(0.12, 0.4, e), wNight = 1 - smoothstep(-0.18, 0.02, e), wDusk = Math.max(0, 1 - wDay - wNight);
  const st = G.storm;
  mix3(_h, PAL.dayH, wDay, PAL.duskH, wDusk, PAL.nightH, wNight);
  mix3(_z, PAL.dayZ, wDay, PAL.duskZ, wDusk, PAL.nightZ, wNight);
  _h.lerp(PAL.stormH, st * 0.8 * (1 - wNight * 0.7)); _z.lerp(PAL.stormZ, st * 0.8 * (1 - wNight * 0.7));
  G.night = wNight;

  skyMat.uniforms.uHorizon.value.copy(_h); skyMat.uniforms.uZenith.value.copy(_z);
  skyMat.uniforms.uSunDir.value.copy(G.sunDir); skyMat.uniforms.uSpace.value = space;
  mix3(_s, PAL.sunDay, wDay, PAL.sunDusk, wDusk, PAL.sunNight, wNight);
  skyMat.uniforms.uSunColor.value.copy(_s); skyMat.uniforms.uGlow.value = (1 - st * 0.8) * smoothstep(-0.25, 0.0, e);
  scene.fog.color.copy(_h);
  scene.fog.density = lerp(0.0016 + st * 0.0085, 0.00005, space);

  const day = smoothstep(-0.12, 0.35, e);
  dirLight.color.copy(_s);
  dirLight.intensity = lerp(0.1 + day * 1.3, 1.7, space) * (1 - st * 0.45);
  hemiLight.color.copy(_h).lerp(_z, 0.4);
  hemiLight.groundColor.copy(PAL.gndNight).lerp(PAL.gndDay, day);
  hemiLight.intensity = lerp(0.2 + day * 0.42, 0.22, space);
  starsMat.opacity = clamp(Math.max(wNight, space) * (1 - st * 0.9), 0, 1);

  skyGroup.position.copy(camera.position);
  sunSprite.position.copy(G.sunDir).multiplyScalar(4500);
  sunSprite.material.opacity = smoothstep(-0.2, 0.05, e) * (1 - st * 0.85);
  const ma = G.time * 0.012 + 1.0, mb = G.time * 0.03 + 3.0;
  moonA.position.set(Math.cos(ma) * 4300, 1400 + Math.sin(ma * 0.7) * 900, Math.sin(ma) * 4300);
  moonB.position.set(Math.cos(mb) * 4300, 900 + Math.sin(mb * 0.9) * 800, Math.sin(mb) * 4300);

  // light + shadow frustum follow the player/hover
  dirLight.position.copy(focus).addScaledVector(G.sunDir, 400);
  dirLight.target.position.copy(focus);
}

// ---------------------------------------------------------------------
// 5. TERRAIN  (one height function used by the mesh AND by physics)
// ---------------------------------------------------------------------
// Flat construction pads. y is filled in below. Names are used all over the file.
const PAD = {
  hab:       { x:    0, z:   10, r: 62, blend: 45 },
  bayHome:   { x:    0, z:  100, r: 24, blend: 25 },
  mine:      { x: -200, z: -170, r: 78, blend: 45 },
  nuke:      { x: -210, z:   50, r: 44, blend: 40 },
  ice:       { x: -190, z:  200, r: 40, blend: 40 },
  garage:    { x:  200, z:  205, r: 72, blend: 40 },
  solar:     { x:  200, z:  -50, r: 72, blend: 40 },
  comms:     { x: -100, z:  -60, r: 22, blend: 30 },
  o2:        { x:  120, z: -130, r: 22, blend: 30 }
};
const PADS = Object.values(PAD);
const CRATERS = [];
(function () {
  const r = mulberry32(2024);
  for (let tries = 0; CRATERS.length < 16 && tries < 400; tries++) {
    const ang = r() * 6.283, dist = 80 + r() * 380, cr = 20 + r() * 38;
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    if (PADS.some(p => Math.hypot(x - p.x, z - p.z) < p.r + p.blend + cr * 1.6)) continue;
    CRATERS.push({ x, z, r: cr, r2: cr * cr * 2.56, depth: 4 + r() * 9 });
  }
})();

function rawTerrain(x, z) {
  const r2 = x * x + z * z, r = Math.sqrt(r2);
  let h = perlin(x * 0.0035 + 7.3, z * 0.0035 - 2.1) * 20 + perlin(x * 0.011 - 3, z * 0.011 + 9) * 6.5 + perlin(x * 0.045 + 1, z * 0.045 + 4) * 1.4;
  h += Math.sin((x * 0.7 + z * 0.3) * 0.09 + perlin(x * 0.01, z * 0.01) * 4) * 0.8;      // dune ripples
  const ring = smoothstep(330, 470, r) * (1 - smoothstep(520, 620, r));                     // mountain ring
  const rd = 1 - Math.abs(perlin(x * 0.006 + 20, z * 0.006 + 20));
  h += ring * (40 + 130 * rd * rd);
  for (let i = 0; i < CRATERS.length; i++) {
    const c = CRATERS[i], dx = x - c.x, dz = z - c.z, d2 = dx * dx + dz * dz;
    if (d2 > c.r2) continue;
    const t = Math.sqrt(d2) / c.r;
    if (t < 1) h -= c.depth * (1 - t * t);
    h += c.depth * 0.45 * Math.exp(-Math.pow((t - 1.05) / 0.22, 2));
  }
  h -= r2 / (2 * R_PLANET);                                                                  // planet curvature
  return lerp(h, -PLANET_DROP - r2 / (2 * R_PLANET), smoothstep(580, 700, r));              // blend into planet
}
PADS.forEach(p => { p.y = rawTerrain(p.x, p.z); });
function terrainHeight(x, z) {
  let h = rawTerrain(x, z);
  for (let i = 0; i < PADS.length; i++) {
    const p = PADS[i], d = Math.hypot(x - p.x, z - p.z);
    if (d < p.r + p.blend) h = lerp(h, p.y, 1 - smoothstep(p.r, p.r + p.blend, d));
  }
  return h;
}
function padWeight(x, z) {
  let w = 0;
  for (const p of PADS) w = Math.max(w, 1 - smoothstep(p.r * 0.9, p.r + 6, Math.hypot(x - p.x, z - p.z)));
  return w;
}

(function buildTerrain() {
  const SEG = 256, geo = new THREE.PlaneGeometry(WORLD_HALF * 2, WORLD_HALF * 2, SEG, SEG);
  const pos = geo.attributes.position, n = pos.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const x = pos.getX(i), z = -pos.getY(i); pos.setXYZ(i, x, terrainHeight(x, z), z); }
  geo.computeVertexNormals();
  const nor = geo.attributes.normal;
  const cA = [0.43, 0.17, 0.11], cB = [0.72, 0.36, 0.20], cC = [0.86, 0.56, 0.33], cRock = [0.34, 0.24, 0.21], cPad = [0.30, 0.29, 0.33];
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), z = pos.getZ(i), h = pos.getY(i);
    const t = clamp((perlin(x * 0.02, z * 0.02) * 0.5 + 0.5) * 0.8 + (perlin(x * 0.15 + 9, z * 0.15) * 0.5 + 0.5) * 0.35 - 0.1, 0, 1);
    const slope = 1 - nor.getY(i), rock = clamp(slope * 3.5, 0, 1) * 0.6 + smoothstep(55, 110, h) * 0.7, pw = padWeight(x, z);
    const dark = 1 - clamp(slope * 2.2, 0, 0.5);
    for (let k = 0; k < 3; k++) {
      let c = t < 0.5 ? lerp(cA[k], cB[k], t * 2) : lerp(cB[k], cC[k], (t - 0.5) * 2);
      c = lerp(c * dark, cRock[k], clamp(rock, 0, 1));
      c = lerp(c, cPad[k] * (0.9 + 0.2 * perlin(x * 0.4, z * 0.4)), pw);
      col[i * 3 + k] = Math.pow(c, 2.2);                              // sRGB -> linear
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, map: TEX.grain, roughness: 1, metalness: 0 }));
  ground.receiveShadow = true; scene.add(ground);
})();

// Rocks (instanced) - large ones also become collision circles
const colliders = [];      // {ax,az,bx,bz,r,y0,y1,door,footOnly}  (a circle = a segment with ax=bx, az=bz)
(function buildRocks() {
  const N = 480, r = mulberry32(777);
  const geo = new THREE.IcosahedronGeometry(1, 1), p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {              // jitter by position so shared corners stay joined
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 1 + 0.32 * perlin(x * 2.3 + 5, y * 2.3 + z * 1.7);
    p.setXYZ(i, x * k, y * k * 0.75, z * k);
  }
  geo.computeVertexNormals();
  const inst = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, flatShading: true }), N);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
  let placed = 0;
  for (let tries = 0; placed < N && tries < N * 6; tries++) {
    const ang = r() * 6.283, dist = Math.sqrt(r()) * 560, x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    if (padWeight(x, z) > 0.001 || Math.hypot(x - 0, z - 100) < 40) continue;
    const s = 0.8 + Math.pow(r(), 3) * 9;
    e.set(r() * 0.4, r() * 6.283, r() * 0.4); q.setFromEuler(e);
    m.compose(V3(x, terrainHeight(x, z) + s * 0.1, z), q, V3(s, s * (0.7 + r() * 0.5), s));
    inst.setMatrixAt(placed, m);
    const g = 0.28 + r() * 0.2; c.setRGB(Math.pow(g * 1.15, 2.2), Math.pow(g * 0.8, 2.2), Math.pow(g * 0.7, 2.2)); inst.setColorAt(placed, c);
    if (s > 5 && dist < 470) colliders.push({ ax: x, az: z, bx: x, bz: z, r: s * 0.85, y0: -50, y1: terrainHeight(x, z) + s * 1.2, door: null, footOnly: false });
    placed++;
  }
  inst.count = placed; inst.instanceMatrix.needsUpdate = true; if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.castShadow = inst.receiveShadow = true; inst.frustumCulled = false; scene.add(inst);
})();

// ---------------------------------------------------------------------
// 6. WORLD REGISTRIES & BUILDING HELPERS
// ---------------------------------------------------------------------
const walkables = [];   // extra floors: {type:'rect'|'disc'|'stairs', ...}   (platforms, stairs, station deck)
const DOORS = {};       // auto sliding doors
const ANIMS = [];       // per-frame structure animations (dt, t)
const ROOFS = [];       // cut-away roofs: {mat, inside(x,z), op}
const ZONES = [];       // pressurised / sheltered areas: {type, y, inside(x,z)}
const OUTPOSTS = {};    // task locations (pos.y = floor height at the work spot)
const SPAWNERS = [];    // hover bays

const M = {
  metal: stdMat(0x8a8d96, { metalness: 0.7, roughness: 0.45 }),
  dark: stdMat(0x2b2d35, { metalness: 0.8, roughness: 0.4 }),
  white: stdMat(0xe6e6ee, { metalness: 0.3, roughness: 0.45 }),
  concrete: stdMat(0x55535a, { metalness: 0, roughness: 0.95 })
};
const GLOW = {};
function glowBox(parent, w, h, d, x, y, z, hex) {
  const m = GLOW[hex] || (GLOW[hex] = basicMat(hex));
  return mesh(new THREE.BoxGeometry(w, h, d), m, x, y, z, parent, false);
}
function pointLight(parent, hex, intensity, dist, x, y, z) {
  const l = new THREE.PointLight(0xffffff, intensity, dist); l.color.copy(lin(hex)); l.position.set(x, y, z); parent.add(l); return l;
}
function outpost(key, name, action, role, x, y, z, radius) {
  OUTPOSTS[key] = { key, name, action, role, pos: V3(x, y, z), radius };
}
function addCircle(x, z, r, y0, y1) { colliders.push({ ax: x, az: z, bx: x, bz: z, r, y0, y1, door: null, footOnly: false }); }

// Wall: visible box + collision segment (coordinates local to group at world gx,gy,gz)
function addWall(parent, gx, gy, gz, x0, z0, x1, z1, th, h, mat, footOnly) {
  const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
  if (mat) { const m = mesh(new THREE.BoxGeometry(len, h, th), mat, (x0 + x1) / 2, h / 2, (z0 + z1) / 2, parent); m.rotation.y = -Math.atan2(dz, dx); }
  colliders.push({ ax: gx + x0, az: gz + z0, bx: gx + x1, bz: gz + z1, r: th / 2, y0: gy - 3, y1: gy + h, door: null, footOnly: !!footOnly });
}

// Sliding double door. Door plane sits at local (lx,lz); world centre = group pos + local.
function makeDoor(id, parent, gx, gy, gz, lx, lz, w, h, tint) {
  const mat = stdMat(tint, { map: TEX.hazard, metalness: 0.6, roughness: 0.4 });
  const L = mesh(new THREE.BoxGeometry(w / 2, h, 1.4), mat, lx - w / 4, h / 2, lz, parent);
  const R = mesh(new THREE.BoxGeometry(w / 2, h, 1.4), mat, lx + w / 4, h / 2, lz, parent);
  mesh(new THREE.BoxGeometry(w + 7, 4, 3.4), M.dark, lx, h + 2, lz, parent);
  mesh(new THREE.BoxGeometry(3, h + 4, 3.4), M.dark, lx - w / 2 - 1.5, (h + 4) / 2, lz, parent);
  mesh(new THREE.BoxGeometry(3, h + 4, 3.4), M.dark, lx + w / 2 + 1.5, (h + 4) / 2, lz, parent);
  const lightMat = basicMat(0xff3322);
  mesh(new THREE.BoxGeometry(w * 0.6, 0.8, 0.5), lightMat, lx, h + 2, lz + 1.8, parent, false);
  const d = { id, t: 0, target: 0, cx: gx + lx, cz: gz + lz, y: gy, w, h, L, R, lx, lightMat };
  colliders.push({ ax: d.cx - w / 2, az: d.cz, bx: d.cx + w / 2, bz: d.cz, r: 1.2, y0: gy - 3, y1: gy + h, door: d, footOnly: false });
  DOORS[id] = d; return d;
}
const COL_RED = lin(0xff3322), COL_GREEN = lin(0x33ff66);
function updateDoors(dt, actors) {       // actors: [{x,y,z}] (player and/or hover)
  for (const id in DOORS) {
    const d = DOORS[id]; let near = false; const R = d.target ? 34 : 26;
    for (const a of actors) if (Math.abs(a.y - d.y) < 45 && Math.hypot(a.x - d.cx, a.z - d.cz) < R + (a.reach || 0)) { near = true; break; }
    if (near !== !!d.target) { d.target = near ? 1 : 0; SND.play('door'); }
    d.t += (d.target - d.t) * (1 - Math.exp(-3.2 * dt));
    d.L.position.x = d.lx - d.w / 4 - d.t * d.w / 2; d.R.position.x = d.lx + d.w / 4 + d.t * d.w / 2;
    d.lightMat.color.copy(d.t > 0.5 ? COL_GREEN : COL_RED);
  }
}

// Floor height for walking/hovering: terrain, platforms, stairs, station deck.
function floorAt(x, z, footY, stepUp = 1.4) {
  let best = terrainHeight(x, z);
  for (let i = 0; i < walkables.length; i++) {
    const w = walkables[i]; let y = null;
    if (w.type === 'disc') { if (Math.hypot(x - w.x, z - w.z) < w.r) y = w.y; }
    else if (x > w.minX && x < w.maxX && z > w.minZ && z < w.maxZ) {
      if (w.type === 'rect') y = w.y;
      else {
        const t = w.dir === '-x' ? (w.maxX - x) / (w.maxX - w.minX) : w.dir === '+x' ? (x - w.minX) / (w.maxX - w.minX)
                : w.dir === '-z' ? (w.maxZ - z) / (w.maxZ - w.minZ) : (z - w.minZ) / (w.maxZ - w.minZ);
        y = w.y + (Math.min(w.steps - 1, Math.floor(t * w.steps)) + 1) * w.rise;
      }
    }
    if (y !== null && y <= footY + stepUp && y > best) best = y;
  }
  return best;
}
// 'station' | 'hab' | 'shelter' | null  - where the astronaut is breathing safely
function zoneAt(x, y, z) {
  if (Math.abs(y - STATION.y) < 45 && Math.hypot(x - STATION.x, z - STATION.z) < STATION.deckR) return 'station';
  for (const zn of ZONES) if (Math.abs(y - zn.y) < 70 && zn.inside(x, z)) return zn.type;
  return null;
}
// Cut-away roofs fade out while you are inside
function updateRoofs(dt, px, py, pz) {
  for (const r of ROOFS) {
    const target = (Math.abs(py - r.y) < 60 && r.inside(px, pz)) ? 0.04 : 1;
    r.op += (target - r.op) * (1 - Math.exp(-5 * dt));
    r.mat.opacity = r.op; r.mat.depthWrite = r.op > 0.6;
  }
}
function updateStructures(dt, t) { for (let i = 0; i < ANIMS.length; i++) ANIMS[i](dt, t); }

// Rectangular building with hollow interior, front door (+Z), cut-away roof, glowing windows
function buildBox(id, o) {
  const gy = o.padY, g = new THREE.Group(); g.position.set(o.cx, gy, o.cz); scene.add(g);
  const hw = o.w / 2, hd = o.d / 2, th = o.th || 4, dw = o.doorW, wm = stdMat(o.wallHex, { metalness: 0.7, roughness: 0.45 });
  addWall(g, o.cx, gy, o.cz, -hw, -hd, hw, -hd, th, o.h, wm);
  addWall(g, o.cx, gy, o.cz, -hw, -hd, -hw, hd, th, o.h, wm);
  addWall(g, o.cx, gy, o.cz, hw, -hd, hw, hd, th, o.h, wm);
  addWall(g, o.cx, gy, o.cz, -hw, hd, -dw / 2 - 3, hd, th, o.h, wm);
  addWall(g, o.cx, gy, o.cz, dw / 2 + 3, hd, hw, hd, th, o.h, wm);
  makeDoor(id, g, o.cx, gy, o.cz, 0, hd, dw, o.doorH, o.tint || 0xffffff);
  mesh(new THREE.BoxGeometry(o.w - th, 0.12, o.d - th), stdMat(o.floorHex, { metalness: 0.9, roughness: 0.3 }), 0, 0.06, 0, g, false).receiveShadow = true;
  const roofMat = stdMat(o.roofHex, { metalness: 0.8, roughness: 0.4, transparent: true });
  mesh(new THREE.BoxGeometry(o.w + 6, 3, o.d + 6), roofMat, 0, o.h + 1.5, 0, g);
  const inside = (x, z) => Math.abs(x - o.cx) < hw && Math.abs(z - o.cz) < hd;
  ROOFS.push({ mat: roofMat, inside, op: 1, y: gy }); ZONES.push({ type: 'shelter', y: gy, inside });
  // glowing window bands on the outside (front, left, right)
  for (const s of [-1, 1]) {
    glowBox(g, (hw - dw / 2 - 10) * 0.8, 3, 0.4, s * (dw / 2 + 3 + (hw - dw / 2 - 3) / 2), o.h * 0.62, hd + th / 2 + 0.1, o.glow || 0x66ccff);
    glowBox(g, 0.4, 3, o.d * 0.6, s * (hw + th / 2 + 0.1), o.h * 0.62, 0, o.glow || 0x66ccff);
  }
  return { g, hw, hd, gy };
}

// ---------------------------------------------------------------------
// 7. HABITAT DOME  (centre 0,0 - glass dome + airlock tunnel on +Z)
// ---------------------------------------------------------------------
(function buildHab() {
  const gy = PAD.hab.y, gx = 0, gz = 0, g = new THREE.Group(); g.position.set(0, gy, 0); scene.add(g);
  const glass = new THREE.MeshStandardMaterial({ roughness: 0.08, metalness: 0.4, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
  glass.color.copy(lin(0x66ffff)); glass.emissive.copy(lin(0x0a4a55));
  mesh(new THREE.SphereGeometry(50, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), glass, 0, 0, 0, g, false);
  const ribs = new THREE.Mesh(new THREE.SphereGeometry(50.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.28, depthWrite: false })); ribs.material.color.copy(lin(0x7ff6ff)); g.add(ribs);
  const ring = mesh(new THREE.TorusGeometry(50, 1.8, 10, 64), M.metal, 0, 1.2, 0, g); ring.rotation.x = Math.PI / 2;
  mesh(new THREE.CylinderGeometry(50, 50, 0.12, 64), stdMat(0x101a2c, { emissive: 0x001a33, metalness: 0.9, roughness: 0.3 }), 0, 0.06, 0, g, false);
  for (const rr of [18, 34]) { const m = mesh(new THREE.RingGeometry(rr, rr + 0.7, 64), glowMat(0x4fe8ff, 0.7), 0, 0.16, 0, g, false); m.rotation.x = -Math.PI / 2; }
  // reactor core + animated rings
  mesh(new THREE.CylinderGeometry(6, 6, 26, 24), stdMat(0x00ffff, { emissive: 0x00ffff, emissiveIntensity: 1.2 }), 0, 13, 0, g);
  mesh(new THREE.CylinderGeometry(8.6, 8.6, 28, 24, 1, true), glowMat(0x66ffff, 0.18), 0, 14, 0, g, false);
  const rings = [8, 14, 20].map((y, i) => { const m = mesh(new THREE.TorusGeometry(10 + i, 0.5, 8, 48), glowMat(0x7ff6ff, 0.85), 0, y, 0, g, false); m.rotation.x = Math.PI / 2; return m; });
  ANIMS.push((dt, t) => rings.forEach((m, i) => { m.position.y = 13 + Math.sin(t * 0.8 + i * 2.1) * 9; m.rotation.z += dt * (0.5 + i * 0.3); }));
  pointLight(g, 0x66ffff, 3.6, 170, 0, 30, 0);
  // holo screen, planters, bunks
  const holo = mesh(new THREE.PlaneGeometry(26, 13), new THREE.MeshBasicMaterial({ map: holoTex(['HABITAT', 'O2  NOMINAL', 'POWER  ONLINE']), transparent: true, side: THREE.DoubleSide, depthWrite: false }), 0, 24, -34, g, false);
  ANIMS.push((dt, t) => { holo.position.y = 24 + Math.sin(t * 1.3) * 0.5; });
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2 + 0.3, x = Math.sin(a) * 30, z = Math.cos(a) * 30;
    mesh(new THREE.CylinderGeometry(4, 4.5, 2.4, 14), M.concrete, x, 1.2, z, g);
    mesh(new THREE.SphereGeometry(3.2, 12, 8), stdMat(0x2ecc71, { emissive: 0x0a5a22, roughness: 0.9 }), x, 4, z, g);
    addCircle(gx + x, gz + z, 4.5, gy - 3, gy + 8);
  }
  addCircle(gx, gz, 8.5, gy - 3, gy + 28);
  // glass-dome collision ring with a gap for the airlock tunnel
  const N = 48, R = 49.5;
  for (let i = 0; i < N; i++) {
    const a0 = i / N * Math.PI * 2, a1 = (i + 1) / N * Math.PI * 2, am = (a0 + a1) / 2, mx = Math.sin(am) * R, mz = Math.cos(am) * R;
    if (Math.abs(mx) < 18.5 && mz > 0) continue;
    addWall(g, gx, gy, gz, Math.sin(a0) * R, Math.cos(a0) * R, Math.sin(a1) * R, Math.cos(a1) * R, 2.4, 40, null);
  }
  // airlock tunnel
  addWall(g, gx, gy, gz, -16.5, 40, -16.5, 62, 2, 30, M.metal);
  addWall(g, gx, gy, gz, 16.5, 40, 16.5, 62, 2, 30, M.metal);
  mesh(new THREE.BoxGeometry(36, 2, 24), M.metal, 0, 31, 51.5, g);
  glowBox(g, 28, 0.5, 0.5, 0, 29.5, 40.6, 0x66ffff);
  makeDoor('hab', g, gx, gy, gz, 0, 62, 32, 28, 0xffffff);
  const inside = (x, z) => Math.hypot(x, z) < 49 || (Math.abs(x) < 16 && z >= 40 && z < 62);
  ZONES.push({ type: 'hab', y: gy, inside });
  outpost('hab', 'Habitat Dome', 'Calibrate Life Support', 3, 0, gy, 24, 16);
})();

// ---------------------------------------------------------------------
// 8. MINING RIG  (100 x 100)
// ---------------------------------------------------------------------
(function buildMine() {
  const P = PAD.mine, b = buildBox('mine', { cx: P.x, cz: P.z, padY: P.y, w: 100, d: 100, h: 40, doorW: 40, doorH: 32,
    wallHex: 0x3a3d46, roofHex: 0x2a2c33, floorHex: 0x15161b, glow: 0xff8c33 }), g = b.g, gy = b.gy;
  const drill = new THREE.Group(); drill.position.set(-22, 0, 0); g.add(drill);
  mesh(new THREE.CylinderGeometry(15, 17, 4, 24), M.dark, 0, 2, 0, drill);
  mesh(new THREE.CylinderGeometry(7, 9, 30, 16), stdMat(0xffaa00, { metalness: 0.8, emissive: 0x331100 }), 0, 19, 0, drill);
  const head = mesh(new THREE.TorusKnotGeometry(5, 1.4, 64, 8, 2, 3), stdMat(0xdddddd, { metalness: 0.95, roughness: 0.25 }), 0, 38, 0, drill);
  ANIMS.push((dt) => { head.rotation.y += dt * 2; head.rotation.x += dt * 0.6; });
  addCircle(P.x - 22, P.z, 16, gy - 3, gy + 40);
  const belt = mesh(new THREE.BoxGeometry(10, 2, 80), stdMat(0xffffff, { map: TEX.stripes, roughness: 0.6 }), 22, 5, 0, g);
  ANIMS.push((dt) => { TEX.stripes.offset.y -= dt * 0.6; });
  addWall(g, P.x, gy, P.z, 22, -40, 22, 40, 11, 7, null);
  for (let i = 0; i < 4; i++) mesh(new THREE.ConeGeometry(7 - i, 9 - i, 7), stdMat(0x4a2418, { roughness: 1 }), 14 + i * 4, 4.5, -44 + i * 3, g);
  for (let x = -40; x <= 40; x += 20) mesh(new THREE.CylinderGeometry(1, 1, 38, 8), basicMat(0xff00ff), x, 20, -45, g, false);
  glowBox(g, 90, 1, 1, 0, 36, -45, 0xff00ff);
  [[-38, 30], [-30, 36], [38, 30], [34, 38]].forEach(([x, z]) => { mesh(new THREE.BoxGeometry(5, 5, 5), M.metal, x, 2.5, z, g); addCircle(P.x + x, P.z + z, 3.6, gy - 3, gy + 6); });
  const lamp = mesh(new THREE.SphereGeometry(1.4, 10, 8), basicMat(0xff6a00), 0, 38, 30, g, false);
  ANIMS.push((dt, t) => { lamp.visible = Math.sin(t * 6) > 0; });
  pointLight(g, 0xff6a00, 5, 200, 0, 32, 0);
  outpost('mine', 'Mining Rig', 'Clear Drill Jam', 2, P.x, gy, P.z + 6, 22);
})();

// ---------------------------------------------------------------------
// 9. NUCLEAR GENERATOR  (round, radius 30, door on +Z)
// ---------------------------------------------------------------------
(function buildNuke() {
  const P = PAD.nuke, gy = P.y, g = new THREE.Group(); g.position.set(P.x, gy, P.z); scene.add(g);
  const R = 30, hw = 13, alpha = Math.asin(hw / R), doorZ = Math.sqrt(R * R - hw * hw);
  const shell = new THREE.CylinderGeometry(R, R, 40, 40, 1, true, alpha, Math.PI * 2 - alpha * 2);
  const wallMat = stdMat(0x4a4e57, { metalness: 0.6, roughness: 0.5, side: THREE.DoubleSide });
  mesh(shell, wallMat, 0, 20, 0, g);
  const domeMat = stdMat(0x3a3e47, { metalness: 0.7, roughness: 0.4, transparent: true, side: THREE.DoubleSide });
  mesh(new THREE.SphereGeometry(R, 32, 14, 0, Math.PI * 2, 0, Math.PI / 2), domeMat, 0, 40, 0, g);
  ROOFS.push({ mat: domeMat, inside: (x, z) => Math.hypot(x - P.x, z - P.z) < R - 1, op: 1, y: gy });
  ZONES.push({ type: 'shelter', y: gy, inside: (x, z) => Math.hypot(x - P.x, z - P.z) < R - 1 });
  mesh(new THREE.CylinderGeometry(R - 1, R - 1, 0.12, 40), stdMat(0x0b2b12, { metalness: 0.9, roughness: 0.3, emissive: 0x021a08 }), 0, 0.06, 0, g, false);
  const m = mesh(new THREE.TorusGeometry(R - 0.5, 0.9, 8, 48), glowMat(0x33ff77, 0.8), 0, 18, 0, g, false); m.rotation.x = Math.PI / 2;
  // collision ring (gap at the door)
  const N = 32;
  for (let i = 0; i < N; i++) {
    const a0 = alpha + (i / N) * (Math.PI * 2 - alpha * 2), a1 = alpha + ((i + 1) / N) * (Math.PI * 2 - alpha * 2);
    addWall(g, P.x, gy, P.z, Math.sin(a0) * (R - 0.5), Math.cos(a0) * (R - 0.5), Math.sin(a1) * (R - 0.5), Math.cos(a1) * (R - 0.5), 2.4, 40, null);
  }
  makeDoor('nuke', g, P.x, gy, P.z, 0, doorZ, hw * 2, 24, 0x88ffaa);
  // reactor core
  const core = mesh(new THREE.SphereGeometry(8, 24, 18), stdMat(0x00ff55, { emissive: 0x00ff55, emissiveIntensity: 2.2 }), 0, 17, 0, g);
  const rings = [0, 1, 2].map(i => { const r = mesh(new THREE.TorusGeometry(12 + i * 1.5, 0.45, 8, 48), glowMat(0x7dffa8, 0.8), 0, 17, 0, g, false); return r; });
  ANIMS.push((dt, t) => { core.scale.setScalar(1 + Math.sin(t * 5) * 0.08);
    rings.forEach((r, i) => { r.rotation.x = t * (0.6 + i * 0.35) + i; r.rotation.y = t * (0.4 - i * 0.2); }); });
  mesh(new THREE.CylinderGeometry(3, 3, 17, 12), M.dark, 0, 8.5, 0, g);
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2, x = Math.sin(a) * 22, z = Math.cos(a) * 22; if (Math.abs(x) < 14 && z > 12) continue; mesh(new THREE.CylinderGeometry(1.6, 1.6, 34, 10), M.metal, x, 17, z, g); addCircle(P.x + x, P.z + z, 2, gy - 3, gy + 36); }
  addCircle(P.x, P.z, 9.5, gy - 3, gy + 30);
  pointLight(g, 0x33ff77, 6, 160, 0, 22, 0);
  outpost('nuke', 'Nuclear Generator', 'Stabilize Core', 1, P.x, gy, P.z + 15, 15);
})();

// ---------------------------------------------------------------------
// 10. ICE DRILL (50 x 50)  &  ROVER GARAGE (80 x 60)
// ---------------------------------------------------------------------
(function buildIce() {
  const P = PAD.ice, b = buildBox('ice', { cx: P.x, cz: P.z, padY: P.y, w: 50, d: 50, h: 30, doorW: 24, doorH: 20,
    wallHex: 0x8fa3b5, roofHex: 0x73879a, floorHex: 0x06223d, glow: 0x66f0ff, tint: 0xaaffff }), g = b.g, gy = b.gy;
  const crystal = mesh(new THREE.OctahedronGeometry(8), stdMat(0x66f6ff, { emissive: 0x33d6ff, emissiveIntensity: 1.5, transparent: true, opacity: 0.9, metalness: 0.2, roughness: 0.1 }), 0, 13, -6, g);
  ANIMS.push((dt, t) => { crystal.rotation.y += dt * 1.5; crystal.position.y = 13 + Math.sin(t * 1.4) * 0.8; });
  addCircle(P.x, P.z - 6, 8, gy - 3, gy + 24);
  for (let i = 0; i < 7; i++) { const a = rand(0, 6.28), d = rand(12, 19), s = rand(2, 4.5);
    mesh(new THREE.OctahedronGeometry(s), stdMat(0x9ff8ff, { emissive: 0x2288aa, transparent: true, opacity: 0.8, roughness: 0.1 }), Math.cos(a) * d, s * 0.9, Math.sin(a) * d - 6, g); }
  mesh(new THREE.CylinderGeometry(2.5, 2.5, 28, 10), M.metal, -18, 14, -16, g); mesh(new THREE.CylinderGeometry(2.5, 2.5, 28, 10), M.metal, 18, 14, -16, g);
  addCircle(P.x - 18, P.z - 16, 3, gy - 3, gy + 28); addCircle(P.x + 18, P.z - 16, 3, gy - 3, gy + 28);
  pointLight(g, 0x66f0ff, 5, 110, 0, 20, 0);
  outpost('ice', 'Ice Drill', 'Clear Ice Blockage', 3, P.x, gy, P.z + 10, 15);
})();

(function buildGarage() {
  const P = PAD.garage, cx = 200, cz = 180, b = buildBox('garage', { cx, cz, padY: P.y, w: 80, d: 60, h: 30, doorW: 40, doorH: 25,
    wallHex: 0x70757e, roofHex: 0x3a3d45, floorHex: 0x1c1d22, glow: 0xffffff }), g = b.g, gy = b.gy;
  const rover = new THREE.Group(); rover.position.set(0, 0, -6); g.add(rover);
  mesh(new THREE.BoxGeometry(11, 4, 18), stdMat(0xdddddd, { metalness: 0.4 }), 0, 4.2, 0, rover);
  mesh(new THREE.BoxGeometry(8, 3, 8), stdMat(0x223355, { metalness: 0.9, roughness: 0.1 }), 0, 7.2, 2, rover);
  for (const sx of [-1, 1]) for (const sz of [-6, 0, 6]) { const w = mesh(new THREE.CylinderGeometry(2.1, 2.1, 1.8, 14), M.dark, sx * 6.2, 2.1, sz, rover); w.rotation.z = Math.PI / 2; }
  glowBox(rover, 2, 1, 0.3, -3, 4.5, 9.1, 0xffffff); glowBox(rover, 2, 1, 0.3, 3, 4.5, 9.1, 0xffffff);
  mesh(new THREE.CylinderGeometry(0.2, 0.2, 6, 6), M.metal, -4, 10.5, -6, rover);
  addWall(g, cx, gy, cz, 0, -15, 0, 3, 12, 9, null);
  ANIMS.push((dt, t) => { rover.rotation.y = Math.sin(t * 0.4) * 0.03; });
  mesh(new THREE.PlaneGeometry(20, 10), new THREE.MeshBasicMaterial({ map: holoTex(['TOOL RACK', 'ONLINE']), transparent: true, side: THREE.DoubleSide, depthWrite: false }), 0, 15, -27, g, false);
  for (const x of [-30, 30]) { mesh(new THREE.BoxGeometry(6, 14, 6), M.metal, x, 7, -20, g); addCircle(cx + x, cz - 20, 4.2, gy - 3, gy + 16); }
  pointLight(g, 0xffffff, 4, 130, 0, 24, 0);
  outpost('garage', 'Rover Garage', 'Repair Rover Tracks', 2, cx + 18, gy, cz - 4, 16);
})();

// ---------------------------------------------------------------------
// 11. SOLAR ARRAY - platform + real stairs (the original task floated in mid-air)
// ---------------------------------------------------------------------
(function buildSolar() {
  const P = PAD.solar, gy = P.y, cx = P.x, cz = P.z, g = new THREE.Group(); g.position.set(cx, gy, cz); scene.add(g);
  const PLAT = 11, panelMat = stdMat(0xffffff, { map: TEX.solar, metalness: 0.6, roughness: 0.25, emissive: 0x0a1a3a, emissiveIntensity: 0.35 });
  for (const rz of [-60, -42, -24, 24, 42, 60]) {
    const p = mesh(new THREE.BoxGeometry(90, 0.6, 10), panelMat, 0, 7, rz, g); p.rotation.x = -0.5;
    for (const px of [-40, 0, 40]) mesh(new THREE.CylinderGeometry(0.7, 0.9, 7, 8), M.metal, px, 3.5, rz + 1.5, g);
    mesh(new THREE.BoxGeometry(90, 0.5, 0.5), M.white, 0, 9.4, rz - 4, g);
    addWall(g, cx, gy, cz, -45, rz, 45, rz, 4, 11, null);
  }
  // platform on four legs
  mesh(new THREE.BoxGeometry(24, 1.2, 24), M.metal, 0, PLAT - 0.6, 0, g);
  for (const sx of [-10, 10]) for (const sz of [-10, 10]) mesh(new THREE.CylinderGeometry(1, 1.4, PLAT, 8), M.dark, sx, PLAT / 2, sz, g);
  walkables.push({ type: 'rect', minX: cx - 12, maxX: cx + 12, minZ: cz - 12, maxZ: cz + 12, y: gy + PLAT });
  // rails (decor) + console + beacon
  for (const [x, z, w, d] of [[0, -11.5, 24, 0.5], [0, 11.5, 24, 0.5], [-11.5, 0, 0.5, 24]]) mesh(new THREE.BoxGeometry(w, 2.2, d), glowMat(0xffcc33, 0.55), x, PLAT + 1.2, z, g, false);
  mesh(new THREE.BoxGeometry(5, 3, 3), M.dark, -6, PLAT + 1.5, 0, g);
  mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshBasicMaterial({ map: holoTex(['SOLAR', 'GRID 62%']), transparent: true, side: THREE.DoubleSide }), -6, PLAT + 4.2, 0, g, false);
  // stairs: 15 steps rising toward -X, starting at x = +45
  const STEPS = 15, RISE = PLAT / STEPS, RUN = 2.2, x0 = 12;
  for (let i = 0; i < STEPS; i++) {
    const h = (i + 1) * RISE;
    mesh(new THREE.BoxGeometry(RUN, h, 8), stdMat(0x9a9ea8, { metalness: 0.5, roughness: 0.6 }), x0 + (STEPS - 1 - i) * RUN + RUN / 2, h / 2, 0, g);
  }
  walkables.push({ type: 'stairs', minX: cx + x0, maxX: cx + x0 + STEPS * RUN, minZ: cz - 4, maxZ: cz + 4, dir: '-x', y: gy, rise: RISE, steps: STEPS });
  for (const sz of [-4.3, 4.3]) {
    const rail = mesh(new THREE.BoxGeometry(Math.hypot(STEPS * RUN, PLAT), 0.35, 0.35), glowMat(0xffcc33, 0.7), x0 + STEPS * RUN / 2, PLAT / 2 + 3, sz, g, false);
    rail.rotation.z = Math.atan2(PLAT, STEPS * RUN);
  }
  glowBox(g, 1, 8, 1, x0 + STEPS * RUN + 1, 4, 0, 0xffcc33);       // marker at the foot of the stairs
  const lamp = mesh(new THREE.SphereGeometry(1, 8, 6), basicMat(0xff3322), 10, PLAT + 6, 10, g, false);
  mesh(new THREE.CylinderGeometry(0.3, 0.3, 6, 6), M.metal, 10, PLAT + 3, 10, g);
  ANIMS.push((dt, t) => { lamp.visible = Math.sin(t * 4) > 0; });
  outpost('solar', 'Solar Array', 'Repair Solar Panels', 1, cx + 4, gy + PLAT, cz, 10);
})();

// ---------------------------------------------------------------------
// 12. COMMS DISH  &  O2 TOWER
// ---------------------------------------------------------------------
let commsDish = null;
(function buildComms() {
  const P = PAD.comms, gy = P.y, g = new THREE.Group(); g.position.set(P.x, gy, P.z); scene.add(g);
  mesh(new THREE.BoxGeometry(14, 8, 12), M.white, 0, 4, 10, g); glowBox(g, 8, 2, 0.3, 0, 5, 16.1, 0x66ccff);
  mesh(new THREE.CylinderGeometry(1.2, 2.6, 30, 8), M.metal, 0, 15, 0, g);
  for (let i = 0; i < 3; i++) { const t = mesh(new THREE.TorusGeometry(2 + i * 0.3, 0.2, 6, 14), M.dark, 0, 8 + i * 8, 0, g, false); t.rotation.x = Math.PI / 2; }
  commsDish = new THREE.Group(); commsDish.position.y = 31; g.add(commsDish);
  const dish = mesh(new THREE.SphereGeometry(15, 24, 10, 0, Math.PI * 2, 0, Math.PI / 3), stdMat(0xf2f2f6, { side: THREE.DoubleSide, metalness: 0.5, roughness: 0.35 }), 0, 0, 0, commsDish);
  dish.rotation.x = -Math.PI / 2.6; dish.position.set(0, 4, 3);
  mesh(new THREE.CylinderGeometry(0.4, 0.4, 14, 6), M.metal, 0, 4, 8.5, commsDish).rotation.x = Math.PI / 2.6;
  const blink = mesh(new THREE.SphereGeometry(1, 8, 6), basicMat(0xff2222), 0, 38, 0, g, false);
  ANIMS.push((dt, t) => { commsDish.rotation.y += dt * 0.25 * G.dishSpin; blink.visible = Math.sin(t * 3) > 0; });
  addCircle(P.x, P.z, 4, gy - 3, gy + 40); addCircle(P.x, P.z + 10, 9, gy - 3, gy + 9);
  outpost('comms', 'Comms Dish', 'Align Comms Dish', 1, P.x, gy, P.z + 20, 12);
})();

const O2_TOWER = {};
(function buildO2() {
  const P = PAD.o2, gy = P.y, g = new THREE.Group(); g.position.set(P.x, gy, P.z); scene.add(g);
  mesh(new THREE.CylinderGeometry(7, 9, 36, 16), stdMat(0xffffff, { emissive: 0x00ffff, emissiveIntensity: 0.35, metalness: 0.4 }), 0, 18, 0, g);
  mesh(new THREE.SphereGeometry(7, 16, 10), M.white, 0, 37, 0, g);
  const rings = [10, 20, 30].map(y => { const r = mesh(new THREE.TorusGeometry(8.4, 0.5, 8, 32), glowMat(0x66ffff, 0.9), 0, y, 0, g, false); r.rotation.x = Math.PI / 2; return r; });
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + 0.78; mesh(new THREE.CylinderGeometry(2.6, 2.6, 12, 12), M.metal, Math.sin(a) * 15, 6, Math.cos(a) * 15, g); }
  ANIMS.push((dt, t) => rings.forEach((r, i) => { r.material.opacity = 0.45 + 0.45 * Math.sin(t * 2 - i); }));
  addCircle(P.x, P.z, 12, gy - 3, gy + 40);
  Object.assign(O2_TOWER, { x: P.x, y: gy, z: P.z, radius: 22 });
})();

// ---------------------------------------------------------------------
// 13. HOVER BAYS  (spawner consoles - press E to deploy / recall a hover)
// ---------------------------------------------------------------------
function buildBay(id, name, x, y, z, cdx, cdz, fog) {
  const g = new THREE.Group(); g.position.set(x, y, z); scene.add(g);
  const f = { fog };
  const plate = stdMat(0x23262e, Object.assign({ metalness: 0.8, roughness: 0.4 }, f));
  mesh(new THREE.CylinderGeometry(16, 17, 0.4, 40), plate, 0, 0.2, 0, g, false).receiveShadow = true;
  const ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog });
  ringMat.color.copy(lin(0x4fe8ff));
  const ring = mesh(new THREE.RingGeometry(12.6, 14, 48), ringMat, 0, 0.5, 0, g, false); ring.rotation.x = -Math.PI / 2;
  const hTex = canvasTex(128, 128, (c, w, h) => { c.fillStyle = 'rgba(0,0,0,0)'; c.fillRect(0, 0, w, h); c.fillStyle = '#7ff6ff'; c.shadowColor = '#7ff6ff'; c.shadowBlur = 10; c.font = 'bold 100px Orbitron, sans-serif'; c.textAlign = 'center'; c.fillText('H', w / 2, 100); });
  const hMat = new THREE.MeshBasicMaterial({ map: hTex, transparent: true, depthWrite: false, fog }); const hd = mesh(new THREE.PlaneGeometry(14, 14), hMat, 0, 0.45, 0, g, false); hd.rotation.x = -Math.PI / 2;
  const posts = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    mesh(new THREE.CylinderGeometry(0.6, 0.8, 5, 8), stdMat(0x444851, f), sx * 15, 2.5, sz * 15, g);
    const bulbMat = new THREE.MeshBasicMaterial({ fog }); bulbMat.color.copy(lin(0xffaa22));
    const b = mesh(new THREE.SphereGeometry(0.9, 10, 8), bulbMat, sx * 15, 5.4, sz * 15, g, false); posts.push(b);
  }
  // console
  const con = new THREE.Group(); con.position.set(cdx, 0, cdz); con.rotation.y = Math.atan2(-cdx, -cdz); g.add(con);
  mesh(new THREE.BoxGeometry(5, 4, 2.6), stdMat(0x30343e, Object.assign({ metalness: 0.7 }, f)), 0, 2, 0, con);
  const sm = new THREE.MeshBasicMaterial({ map: holoTex(['HOVER BAY', 'PRESS  E'], '#7ff6ff', 384, 192), transparent: true, side: THREE.DoubleSide, depthWrite: false, fog });
  const scr = mesh(new THREE.PlaneGeometry(6.5, 3.2), sm, 0, 6.4, 0.2, con, false);
  ANIMS.push((dt, t) => { ringMat.opacity = 0.55 + 0.35 * Math.sin(t * 2.4); scr.position.y = 6.4 + Math.sin(t * 1.5) * 0.25;
    posts.forEach((p, i) => { p.visible = Math.sin(t * 4 + i * 1.6) > -0.2; }); });
  addCircle(x + cdx, z + cdz, 3.4, y - 3, y + 8);
  const consoleWorld = V3(x + cdx, y, z + cdz);
  SPAWNERS.push({ id, name, x, y, z, padR: 16, console: consoleWorld, spawn: V3(x, y, z) });
  return g;
}
buildBay('home', 'Habitat Bay', PAD.bayHome.x, PAD.bayHome.y, PAD.bayHome.z, -24, 0, true);
buildBay('garage', 'Garage Bay', 200, terrainHeight(200, 248), 248, -24, 0, true);

// ---------------------------------------------------------------------
// 14. ORBITAL STATION  (altitude ~1150) - pressurised landing deck
// ---------------------------------------------------------------------
const stationGroup = new THREE.Group(); stationGroup.position.set(STATION.x, STATION.y, STATION.z); scene.add(stationGroup);
(function buildStation() {
  const F = { fog: false }, g = stationGroup;
  const sMetal = stdMat(0x9aa3b5, Object.assign({ metalness: 0.75, roughness: 0.35 }, F));
  const sDark = stdMat(0x232733, Object.assign({ metalness: 0.85, roughness: 0.4 }, F));
  const sWhite = stdMat(0xe8ecf4, Object.assign({ metalness: 0.4, roughness: 0.4 }, F));
  const sBasic = (hex, extra) => { const m = new THREE.MeshBasicMaterial(Object.assign({ fog: false }, extra)); m.color.copy(lin(hex)); return m; };
  const panelMat = stdMat(0xffffff, Object.assign({ map: TEX.solar, metalness: 0.6, roughness: 0.25, emissive: 0x0a1a3a, emissiveIntensity: 0.4 }, F));

  // deck (top face at local y = 0)
  const deckMats = [sMetal, stdMat(0xffffff, Object.assign({ map: TEX.deck, metalness: 0.5, roughness: 0.5 }, F)), sDark];
  mesh(new THREE.CylinderGeometry(70, 72, 4, 64), deckMats, 0, -2, 0, g).receiveShadow = true;
  const bulbGeo = new THREE.SphereGeometry(0.9, 8, 6), bulbMat = sBasic(0xffcc55);
  for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2; mesh(bulbGeo, bulbMat, Math.cos(a) * 68.5, 0.4, Math.sin(a) * 68.5, g, false); }
  // force field (keeps astronauts on the deck, lets hovers fly in from above)
  const ffMat = sBasic(0x66e0ff, { map: TEX.hex, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  mesh(new THREE.CylinderGeometry(70.5, 70.5, 30, 48, 1, true), ffMat, 0, 15, 0, g, false);
  ANIMS.push((dt) => { TEX.hex.offset.x += dt * 0.02; });
  for (let i = 0; i < 40; i++) {
    const a0 = i / 40 * Math.PI * 2, a1 = (i + 1) / 40 * Math.PI * 2;
    addWall(g, STATION.x, STATION.y, STATION.z, Math.cos(a0) * 68, Math.sin(a0) * 68, Math.cos(a1) * 68, Math.sin(a1) * 68, 2, 40, null, true);
  }
  walkables.push({ type: 'disc', x: STATION.x, z: STATION.z, r: STATION.deckR, y: STATION.y });
  // decorative pads
  for (const [px, pz] of [[-22, 42], [-22, -42]]) {
    mesh(new THREE.CylinderGeometry(11, 11, 0.3, 32), sDark, px, 0.15, pz, g, false);
    const r = mesh(new THREE.RingGeometry(8.6, 9.6, 40), sBasic(0x4fe8ff, { transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }), px, 0.35, pz, g, false); r.rotation.x = -Math.PI / 2;
  }
  // central tower
  mesh(new THREE.CylinderGeometry(12, 13, 38, 24), sWhite, 0, 19, 0, g);
  mesh(new THREE.CylinderGeometry(12.7, 12.7, 6, 24, 1, true), sBasic(0x66e8ff, { transparent: true, opacity: 0.45, side: THREE.DoubleSide }), 0, 28, 0, g, false);
  mesh(new THREE.CylinderGeometry(17, 14, 3, 24), sMetal, 0, 39.5, 0, g);
  mesh(new THREE.CylinderGeometry(0.6, 0.6, 30, 6), sMetal, 0, 56, 0, g);
  const beacon = mesh(new THREE.SphereGeometry(1.6, 10, 8), sBasic(0xff3030), 0, 72, 0, g, false);
  ANIMS.push((dt, t) => { beacon.visible = Math.sin(t * 3) > 0; });
  addCircle(STATION.x, STATION.z, 13.5, STATION.y - 3, STATION.y + 42);
  const pl = new THREE.PointLight(0xffffff, 2.2, 260); pl.color.copy(lin(0xbfd8ff)); pl.position.set(0, 46, 0); g.add(pl);
  // task terminal
  mesh(new THREE.BoxGeometry(3.4, 5, 3.4), sDark, -40, 2.5, 0, g);
  const term = mesh(new THREE.PlaneGeometry(10, 5), new THREE.MeshBasicMaterial({ map: holoTex(['ORBITAL ARRAY', 'REALIGN']), transparent: true, side: THREE.DoubleSide, fog: false }), -40, 8.5, 0, g, false);
  term.rotation.y = Math.PI / 2;
  const tr = mesh(new THREE.RingGeometry(9, 10, 40), sBasic(0xffd24a, { transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }), -40, 0.4, 0, g, false); tr.rotation.x = -Math.PI / 2;
  // rotating habitat ring, spokes, windows
  const ringG = new THREE.Group(); ringG.position.y = -14; g.add(ringG);
  const torus = mesh(new THREE.TorusGeometry(118, 7, 16, 96), sMetal, 0, 0, 0, ringG); torus.rotation.x = Math.PI / 2;
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; const s = mesh(new THREE.BoxGeometry(48, 3, 3), sMetal, Math.cos(a) * 91, 0, Math.sin(a) * 91, ringG); s.rotation.y = -a; }
  const winMat = sBasic(0xffe6a0);
  for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2, w = mesh(new THREE.BoxGeometry(1, 2.4, 5), winMat, Math.cos(a) * 125, 1, Math.sin(a) * 125, ringG, false); w.rotation.y = -a; }
  ANIMS.push((dt) => { ringG.rotation.y += dt * 0.05; });
  // underbelly + engines
  const cone = mesh(new THREE.ConeGeometry(28, 42, 24), sDark, 0, -25, 0, g); cone.rotation.x = Math.PI;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    mesh(new THREE.CylinderGeometry(2.6, 3.4, 6, 12), sMetal, sx * 18, -9, sz * 18, g);
    const gl = mesh(new THREE.CircleGeometry(2.4, 14), sBasic(0x66ccff, { side: THREE.DoubleSide }), sx * 18, -12.2, sz * 18, g, false); gl.rotation.x = Math.PI / 2;
  }
  // solar wings
  for (const s of [-1, 1]) {
    mesh(new THREE.BoxGeometry(150, 2, 2), sMetal, s * 146, -8, 0, g);
    for (const sz of [-1, 1]) mesh(new THREE.BoxGeometry(100, 0.6, 30), panelMat, s * 140, -8, sz * 20, g);
    const nav = mesh(new THREE.SphereGeometry(1.4, 8, 6), sBasic(s < 0 ? 0xff2222 : 0x22ff55), s * 222, -8, 0, g, false);
    ANIMS.push((dt, t) => { nav.visible = Math.sin(t * 2.5 + s) > -0.3; });
  }
  outpost('station', 'Orbital Station', 'Realign Orbital Array', 1, STATION.x - 40, STATION.y, STATION.z, 14);
})();
buildBay('station', 'Station Bay', STATION.x + 40, STATION.y, STATION.z, 0, 24, false);

// ---------------------------------------------------------------------
// 15. MODELS : astronaut + hover   (instances are created in Part 2)
// ---------------------------------------------------------------------
function buildAstronaut() {
  const g = new THREE.Group();
  const suit = stdMat(0xf4f4f8, { roughness: 0.55, metalness: 0.1 }), gray = stdMat(0x40444d, { roughness: 0.6, metalness: 0.4 });
  const accent = stdMat(0x3498db, { emissive: 0x3498db, emissiveIntensity: 0.5 });
  const visorMat = stdMat(0x3498db, { emissive: 0x3498db, emissiveIntensity: 0.8, metalness: 0.9, roughness: 0.1 });
  const legs = [-1, 1].map(s => {
    const p = new THREE.Group(); p.position.set(s * 0.55, 2.1, 0); g.add(p);
    mesh(new THREE.CylinderGeometry(0.42, 0.36, 1.7, 10), suit, 0, -0.85, 0, p);
    mesh(new THREE.BoxGeometry(0.95, 0.7, 1.5), gray, 0, -1.75, 0.22, p); return p;
  });
  mesh(new THREE.CylinderGeometry(1.0, 0.85, 2.1, 14), suit, 0, 3.15, 0, g).scale.z = 0.72;
  glowBox(g, 0.8, 0.5, 0.12, 0, 3.5, 0.78, 0x66ffff);
  mesh(new THREE.BoxGeometry(1.5, 2.2, 0.9), gray, 0, 3.3, -0.95, g);
  for (const s of [-1, 1]) mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.8, 10), suit, s * 0.45, 3.5, -1.55, g);
  mesh(new THREE.BoxGeometry(0.22, 1.6, 0.1), accent, 0, 3.3, -1.45, g, false);
  mesh(new THREE.SphereGeometry(0.85, 18, 14), suit, 0, 4.75, 0, g);
  const visor = mesh(new THREE.SphereGeometry(0.7, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), visorMat, 0, 4.8, 0.3, g, false); visor.rotation.x = Math.PI / 2;
  const neck = mesh(new THREE.TorusGeometry(0.7, 0.14, 8, 16), gray, 0, 4.05, 0, g, false); neck.rotation.x = Math.PI / 2;
  const arms = [-1, 1].map(s => {
    const p = new THREE.Group(); p.position.set(s * 1.3, 3.9, 0); g.add(p);
    mesh(new THREE.CylinderGeometry(0.3, 0.26, 1.5, 10), suit, 0, -0.75, 0, p);
    mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.3, 10), accent, 0, -0.4, 0, p, false);
    mesh(new THREE.SphereGeometry(0.36, 10, 8), gray, 0, -1.6, 0, p); return p;
  });
  mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6), gray, 0.5, 4.6, -1.3, g, false);
  mesh(new THREE.SphereGeometry(0.14, 6, 6), basicMat(0xff3030), 0.5, 5.45, -1.3, g, false);
  const lamp = new THREE.SpotLight(0xffffff, 0, 110, 0.75, 0.5); lamp.position.set(0, 4.9, 0.9); lamp.target.position.set(0, 3, 22); g.add(lamp); g.add(lamp.target);
  return { group: g, legs, arms, visorMat, accent, lamp, height: 5.7 };
}
function setRoleColor(av, hex) {
  av.visorMat.color.copy(lin(hex)); av.visorMat.emissive.copy(lin(hex)); av.accent.color.copy(lin(hex)); av.accent.emissive.copy(lin(hex));
}

function buildHover() {
  const g = new THREE.Group();
  const white = stdMat(0xeeeef4, { metalness: 0.55, roughness: 0.28 }), dark = stdMat(0x1f2229, { metalness: 0.8, roughness: 0.4 });
  const accent = stdMat(0xff7a1a, { emissive: 0xff4a00, emissiveIntensity: 0.8, metalness: 0.3 });
  const canopyMat = stdMat(0x2a6bff, { emissive: 0x0a2a66, metalness: 1, roughness: 0.05, transparent: true, opacity: 0.6 });
  mesh(new THREE.SphereGeometry(5, 28, 18), white, 0, 2.9, 0, g).scale.set(1.1, 0.55, 1.9);
  mesh(new THREE.SphereGeometry(5, 24, 14), dark, 0, 1.9, 0, g).scale.set(1.0, 0.32, 1.75);
  mesh(new THREE.SphereGeometry(3, 20, 14), canopyMat, 0, 4.3, 2.6, g, false).scale.set(0.95, 0.7, 1.5);
  mesh(new THREE.BoxGeometry(2, 1.4, 2), dark, 0, 3.6, 1.6, g, false);
  for (const s of [-1, 1]) {
    const w = mesh(new THREE.BoxGeometry(6, 0.4, 5), white, s * 6.4, 2.6, -2.5, g); w.rotation.z = -s * 0.12;
    mesh(new THREE.BoxGeometry(0.4, 0.4, 10), accent, s * 4.9, 3.0, -1, g, false);
  }
  const tail = mesh(new THREE.BoxGeometry(0.5, 3.4, 3.4), white, 0, 5, -7.4, g); tail.rotation.x = -0.3;
  // four lift thrusters
  const flames = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = sx * 7, pz = sz * 5;
    mesh(new THREE.CylinderGeometry(1.5, 1.7, 2.2, 14), dark, px, 1.7, pz, g);
    const d = mesh(new THREE.CircleGeometry(1.3, 16), glowMat(0x66ddff, 0.95), px, 0.55, pz, g, false); d.rotation.x = Math.PI / 2;
    const f = new THREE.Group(); f.position.set(px, 0.55, pz); g.add(f);
    const c = mesh(new THREE.ConeGeometry(1.2, 4.2, 12), glowMat(0xffa040, 0.8), 0, -2.1, 0, f, false); c.rotation.x = Math.PI;
    const c2 = mesh(new THREE.ConeGeometry(0.6, 2.6, 10), glowMat(0x9fe8ff, 0.95), 0, -1.3, 0, f, false); c2.rotation.x = Math.PI;
    flames.push(f);
  }
  // main rear engine
  const eng = mesh(new THREE.CylinderGeometry(1.7, 2.0, 1.6, 14), dark, 0, 2.8, -9.4, g); eng.rotation.x = Math.PI / 2;
  const mainFlame = new THREE.Group(); mainFlame.position.set(0, 2.8, -10.2); mainFlame.rotation.x = -Math.PI / 2; g.add(mainFlame);
  mesh(new THREE.ConeGeometry(1.5, 6, 12), glowMat(0xff9a3a, 0.8), 0, 3, 0, mainFlame, false);
  mesh(new THREE.ConeGeometry(0.8, 3.6, 10), glowMat(0xc6f2ff, 0.95), 0, 1.8, 0, mainFlame, false);
  const navL = mesh(new THREE.SphereGeometry(0.4, 8, 6), basicMat(0xff2222), -9.7, 2.8, -2.5, g, false);
  const navR = mesh(new THREE.SphereGeometry(0.4, 8, 6), basicMat(0x22ff55), 9.7, 2.8, -2.5, g, false);
  mesh(new THREE.SphereGeometry(0.45, 8, 6), basicMat(0xffffff), -2.4, 2.7, 8.5, g, false);
  mesh(new THREE.SphereGeometry(0.45, 8, 6), basicMat(0xffffff), 2.4, 2.7, 8.5, g, false);
  const spot = new THREE.SpotLight(0xffffff, 0, 170, 0.55, 0.6); spot.position.set(0, 2.8, 8); spot.target.position.set(0, -6, 70); g.add(spot); g.add(spot.target);
  const glow = mesh(new THREE.CircleGeometry(10, 32), glowMat(0x66ccff, 0), 0, 0, 0, null, false); glow.rotation.x = -Math.PI / 2; scene.add(glow);
  return { group: g, flames, mainFlame, spot, glow, navL, navR, canopyMat, radius: 9, rideH: 3 };
}
// beam used when a new hover is deployed
const spawnBeam = mesh(new THREE.CylinderGeometry(10, 10, 160, 28, 1, true), glowMat(0x66e8ff, 0.5), 0, 80, 0, scene, false);
spawnBeam.visible = false;

// ---------------------------------------------------------------------
// 16. PARTICLES (soft round sprites, per-particle size/alpha/colour)
// ---------------------------------------------------------------------
const PARTICLE_UNIFORMS = { uScale: { value: renderer.domElement.height * 0.866 } };
const _pcols = {}; const pcol = hex => _pcols[hex] || (_pcols[hex] = lin(hex));
class ParticleSystem {
  constructor(n, additive) {
    this.n = n; this.next = 0;
    ['pos', 'col', 'vel'].forEach(k => this[k] = new Float32Array(n * 3));
    ['size', 'alpha', 'life', 'max', 's0', 's1', 'a0', 'grav'].forEach(k => this[k] = new Float32Array(n));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      uniforms: PARTICLE_UNIFORMS, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `attribute float aSize; attribute float aAlpha; attribute vec3 aColor; uniform float uScale; varying float vA; varying vec3 vC;
        void main(){ vA=aAlpha; vC=aColor; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=aSize*uScale/max(-mv.z,0.1); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `varying float vA; varying vec3 vC;
        void main(){ float d=length(gl_PointCoord-0.5); float a=(1.0-smoothstep(0.05,0.5,d))*vA; if(a<0.01) discard; gl_FragColor=vec4(vC,a);
          ${FOG_CHUNKS} }`
    });
    this.points = new THREE.Points(geo, mat); this.points.frustumCulled = false; scene.add(this.points);
  }
  emit(x, y, z, vx, vy, vz, life, s0, s1, hex, alpha = 1, grav = 0) {
    const i = this.next; this.next = (i + 1) % this.n; const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z; this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    const c = pcol(hex); this.col[i3] = c.r; this.col[i3 + 1] = c.g; this.col[i3 + 2] = c.b;
    this.life[i] = this.max[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = alpha; this.grav[i] = grav; this.size[i] = s0; this.alpha[i] = 0;
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.alpha[i] = 0; this.size[i] = 0; continue; }
      const i3 = i * 3; this.vel[i3 + 1] -= this.grav[i] * dt;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const k = 1 - this.life[i] / this.max[i];
      this.size[i] = lerp(this.s0[i], this.s1[i], k); this.alpha[i] = this.a0[i] * (1 - k) * Math.min(1, k * 8);
    }
    const a = this.geo.attributes; a.position.needsUpdate = a.aSize.needsUpdate = a.aAlpha.needsUpdate = a.aColor.needsUpdate = true;
  }
}
const dust   = new ParticleSystem(900, false);   // dust puffs, smoke, storm streaks
const sparks = new ParticleSystem(700, true);    // engine glow, impacts, explosions

// ---------------------------------------------------------------------
// 17. OBJECTIVE BEACON  (tall light beam + spinning ring + floating diamond)
// ---------------------------------------------------------------------
const beacon = (function () {
  const g = new THREE.Group(); g.visible = false; scene.add(g);
  const mk = op => { const m = new THREE.MeshBasicMaterial({ transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }); return m; };
  const beamMat = mk(0.3), ringMat = mk(0.65), diaMat = mk(0.85);
  mesh(new THREE.CylinderGeometry(3, 3, 900, 16, 1, true), beamMat, 0, 0, 0, g, false);
  const ring = mesh(new THREE.RingGeometry(9, 11.5, 48), ringMat, 0, 0.6, 0, g, false); ring.rotation.x = -Math.PI / 2;
  const dia = mesh(new THREE.OctahedronGeometry(3.4), diaMat, 0, 26, 0, g, false);
  ANIMS.push((dt, t) => { ring.rotation.z += dt * 1.2; dia.rotation.y += dt * 1.6; dia.position.y = 26 + Math.sin(t * 2) * 2.5; });
  return { group: g, mats: [beamMat, ringMat, diaMat] };
})();
function setBeacon(pos, hex) {
  beacon.group.position.copy(pos); beacon.group.visible = true;
  beacon.mats.forEach(m => m.color.copy(lin(hex)));
}

/* =====================================================================
   END OF PART 1.
   Part 2 expects these globals from Part 1:
   G, SND, scene, camera, renderer, dirLight, ROLES, STATION, TASK_COUNT,
   clamp/lerp/rand/smoothstep/V3/lin, terrainHeight(x,z), floorAt(x,z,footY,stepUp),
   colliders[], walkables[], DOORS + updateDoors(dt,[{x,y,z}]), updateRoofs(dt,x,y,z),
   updateStructures(dt,t), updateEnvironment(dt,focusVec3), zoneAt(x,y,z),
   OUTPOSTS{}, SPAWNERS[], O2_TOWER, commsDish, buildAstronaut(), setRoleColor(),
   buildHover(), spawnBeam, dust, sparks (ParticleSystem.emit), setBeacon(pos,hex)
   ===================================================================== */

/* =====================================================================
   PART 2 of 2 : Physics, Gameplay & Game Loop
   ===================================================================== */

// ---------------------------------------------------------------------
// 18. UI HELPERS  (null-safe: a missing element never crashes the game)
// ---------------------------------------------------------------------
const DUMMY = { style: {}, classList: { add() {}, remove() {}, toggle() {} }, getContext() { return null; }, addEventListener() {}, width: 0, height: 0 };
const UI = {};
const $ = id => UI[id] || (UI[id] = document.getElementById(id) || DUMMY);
const _last = {};
function txt(id, v) { v = String(v); if (_last[id] !== v) { _last[id] = v; $(id).textContent = v; } }
function bar(id, pct) { const w = clamp(pct, 0, 100).toFixed(1) + '%'; if (_last['w' + id] !== w) { _last['w' + id] = w; $(id).style.width = w; } }
function show(id, on, disp = 'block') { const d = on ? disp : 'none'; if (_last['d' + id] !== d) { _last['d' + id] = d; $(id).style.display = d; } }
let _toastT = 0;
function toast(msg, ms = 2600) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.remove('show'), ms);
}
function flash(cls) { const el = $('flash'); el.classList.remove('hit', 'heal'); void el.offsetWidth; el.classList.add(cls); }

// ---------------------------------------------------------------------
// 19. INPUT
// ---------------------------------------------------------------------
const keys = { w: false, a: false, s: false, d: false, e: false, space: false, shift: false, down: false };
const pressed = { e: false };
const cam = { yaw: 0, pitch: 0.35, dist: 30, shake: 0, idle: 0, fov: 60 };
function setKey(code, v) {
  switch (code) {
    case 'KeyW': case 'ArrowUp': keys.w = v; break;
    case 'KeyS': case 'ArrowDown': keys.s = v; break;
    case 'KeyA': case 'ArrowLeft': keys.a = v; break;
    case 'KeyD': case 'ArrowRight': keys.d = v; break;
    case 'KeyE': keys.e = v; break;
    case 'Space': keys.space = v; break;
    case 'ShiftLeft': case 'ShiftRight': keys.shift = v; break;
    case 'KeyC': case 'ControlLeft': keys.down = v; break;
  }
}
window.addEventListener('keydown', e => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && G.state !== 'menu') e.preventDefault();
  if (e.repeat) return;
  setKey(e.code, true);
  if (G.state === 'paused' && e.code === 'KeyP') return resumeGame();
  if (G.state !== 'playing') return;
  if (e.code === 'KeyE') pressed.e = true;
  else if (e.code === 'Digit1') switchRole(1);
  else if (e.code === 'Digit2') switchRole(2);
  else if (e.code === 'Digit3') switchRole(3);
  else if (e.code === 'KeyM') toast(SND.toggleMute() ? 'Sound OFF' : 'Sound ON', 1200);
  else if (e.code === 'KeyP') pauseGame();
});
window.addEventListener('keyup', e => setKey(e.code, false));
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

let hadLock = false;
function lockMouse() { 
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (isTouchDevice) return; // Skip pointer lock on mobile
  
  try { const p = document.body.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not supported */ } 
}
document.addEventListener('pointerlockchange', () => {
  const l = document.pointerLockElement === document.body;
  if (hadLock && !l && G.state === 'playing') pauseGame();
  hadLock = l;
});
document.body.addEventListener('click', () => {
  // Check if the device is a touch screen (mobile). If so, DO NOT lock the mouse.
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  
  if (!isTouchDevice && G.state === 'playing' && !document.pointerLockElement) {
    lockMouse();
  } else if (G.state === 'paused') {
    resumeGame();
  }
});
document.addEventListener('mousemove', e => {
  if (G.state !== 'playing' || document.pointerLockElement !== document.body) return;
  cam.yaw -= e.movementX * 0.0025; cam.pitch = clamp(cam.pitch - e.movementY * 0.0025, -0.25, 1.15); cam.idle = 0;
});
function pauseGame() { if (G.state !== 'playing') return; G.state = 'paused'; for (const k in keys) keys[k] = false; document.exitPointerLock(); show('pause', true, 'flex'); }
function resumeGame() { if (G.state !== 'paused') return; G.state = 'playing'; show('pause', false); clock.getDelta(); lockMouse(); }

// ---------------------------------------------------------------------
// 20. ENTITIES
// ---------------------------------------------------------------------
const stats = { dist: 0, maxAlt: 0, hoversLost: 0, tasks: 0 };
const player = { pos: V3(0, 0, 84), vx: 0, vz: 0, vy: 0, face: Math.PI, grounded: true, walkT: 0, stepT: 0, workT: 0, role: 1,
                 o2: 100, power: 100, o2cd: 0, inHover: false, sprint: false, taskProg: 0, av: buildAstronaut() };
player.pos.y = floorAt(0, 84, 100);
scene.add(player.av.group); setRoleColor(player.av, ROLES[1].color);

const hv = { obj: buildHover(), alive: false, occ: false, spawn: null, pos: V3(0, 0, 0), vel: V3(0, 0, 0), heading: Math.PI,
             pitch: 0, roll: 0, fuel: 100, hull: 100, alt: 0, warnedFuel: false, spd: 0 };
hv.obj.group.rotation.order = 'YXZ'; hv.obj.group.visible = false; hv.obj.glow.visible = false; scene.add(hv.obj.group);
G.spawnCd = 0; G.event = null; G.nextEvent = 45; G.eventEnd = 0;

function burst(x, y, z, hex, n, speed, size = 2.2) {
  for (let i = 0; i < n; i++) sparks.emit(x, y, z, rand(-1, 1) * speed, rand(-0.3, 1) * speed, rand(-1, 1) * speed, rand(0.5, 1.3), size, 0.2, hex, 1, 20);
}
function puff(x, y, z, n, speed, size = 4) {
  for (let i = 0; i < n; i++) dust.emit(x + rand(-1, 1), y, z + rand(-1, 1), rand(-1, 1) * speed, rand(0.2, 1) * speed * 0.5, rand(-1, 1) * speed, rand(0.8, 1.8), size, size * 3, 0xc88a60, 0.5, -1);
}

// --- roles ------------------------------------------------------------
function switchRole(r) {
  player.role = r; setRoleColor(player.av, ROLES[r].color);
  const hex = '#' + ROLES[r].color.toString(16).padStart(6, '0');
  txt('role-text', `ROLE: ${ROLES[r].name}`); $('role-text').style.color = hex;
  document.querySelectorAll('.role-chip').forEach(ch => ch.classList.toggle('active', +ch.dataset.role === r));
  SND.play('click');
}

// --- tasks ------------------------------------------------------------
let tasks = [], taskIdx = 0;
function generateTasks() {
  const pool = Object.keys(OUTPOSTS).filter(k => k !== 'station'), stationAt = new Set([9, 19, 29, 39, 47]), out = [];
  let prev = null;
  for (let i = 0; i < TASK_COUNT; i++) {
    let k; if (stationAt.has(i)) k = 'station'; else do { k = pool[Math.floor(Math.random() * pool.length)]; } while (k === prev);
    const o = OUTPOSTS[k]; prev = k;
    out.push({ key: k, text: `${o.action} at ${o.name}`, role: o.role, pos: o.pos, radius: o.radius, duration: k === 'station' ? 4.5 : 3.2 });
  }
  return out;
}
function updateTaskUI() {
  if (taskIdx >= tasks.length) return;
  
  const currentTask = tasks[taskIdx];
  
  // Update the top-right objective text
  txt('objective', currentTask.text);
  
  // Update the top-left progress counter
  txt('tasks-done', taskIdx);
  bar('task-bar', (taskIdx / TASK_COUNT) * 100);
  
  // Update the hint below the objective (optional)
  const roleName = ROLES[currentTask.role] ? ROLES[currentTask.role].name : 'ANY';
  txt('task-progress-hint', `REQUIRES: ${roleName}`);
}
function completeTask() {
  stats.tasks = taskIdx + 1; taskIdx++; player.power = Math.min(100, player.power + 10); player.o2 = Math.min(100, player.o2 + 4);
  SND.play('done'); flash('heal'); toast(`TASK COMPLETE  ·  ${taskIdx}/${TASK_COUNT}`, 1800); updateTaskUI();
}

// ---------------------------------------------------------------------
// 21. COLLISION  (capsule vs wall segments / circles)
// ---------------------------------------------------------------------
const RES = { x: 0, z: 0, hit: 0 };
function resolveColliders(x, z, r, y0, y1, isHover) {
  let hit = 0;
  for (let it = 0; it < 2; it++) {
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      if (y1 < c.y0 || y0 > c.y1) continue;
      if (c.footOnly && isHover) continue;
      if (c.door && c.door.t > 0.75) continue;
      const abx = c.bx - c.ax, abz = c.bz - c.az, l2 = abx * abx + abz * abz;
      let t = l2 > 0 ? ((x - c.ax) * abx + (z - c.az) * abz) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = c.ax + abx * t, pz = c.az + abz * t, dx = x - px, dz = z - pz, rr = c.r + r, d2 = dx * dx + dz * dz;
      if (d2 < rr * rr) {
        const d = Math.sqrt(d2); let nx, nz;
        if (d > 1e-4) { nx = dx / d; nz = dz / d; } else { const l = Math.sqrt(l2) || 1; nx = -abz / l; nz = abx / l; }
        x = px + nx * rr; z = pz + nz * rr; hit = Math.max(hit, rr - d);
      }
    }
  }
  RES.x = x; RES.z = z; RES.hit = hit; return RES;
}
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// ---------------------------------------------------------------------
// 22. PLAYER  (on foot)
// ---------------------------------------------------------------------
function updatePlayer(dt) {
  const p = player, g = p.av.group;
  const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw), rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw);
  let mx = 0, mz = 0;
  if (keys.w) { mx += fx; mz += fz; } if (keys.s) { mx -= fx; mz -= fz; }
  if (keys.d) { mx += rx; mz += rz; } if (keys.a) { mx -= rx; mz -= rz; }
  const ml = Math.hypot(mx, mz); if (ml > 0) { mx /= ml; mz /= ml; }
  p.sprint = keys.shift && ml > 0 && p.o2 > 5;
  const speed = (p.sprint ? 68 : 44) * (p.role === 2 ? 1.15 : 1);
  const k = 1 - Math.exp(-12 * dt);
  p.vx += (mx * speed - p.vx) * k; p.vz += (mz * speed - p.vz) * k;

  // horizontal move + collisions
  let nx = p.pos.x + p.vx * dt, nz = p.pos.z + p.vz * dt;
  const r = resolveColliders(nx, nz, 1.4, p.pos.y, p.pos.y + 5.7, false); nx = r.x; nz = r.z;
  if (hv.alive && !hv.occ && !hv.spawn && Math.abs(p.pos.y - hv.pos.y) < 7) {       // a parked hover is solid
    const dx = nx - hv.pos.x, dz = nz - hv.pos.z, d = Math.hypot(dx, dz);
    if (d < 9 && d > 0.01) { nx = hv.pos.x + dx / d * 9; nz = hv.pos.z + dz / d * 9; }
  }
  if (p.pos.y < 300) { const rr = Math.hypot(nx, nz); if (rr > 470) { nx *= 470 / rr; nz *= 470 / rr; } }
  const moved = Math.hypot(nx - p.pos.x, nz - p.pos.z); p.pos.x = nx; p.pos.z = nz;

  // vertical (Mars gravity, stairs, platforms)
  const fl = floorAt(nx, nz, p.pos.y, 1.5);
  if (keys.space && p.grounded) { p.vy = 46; p.grounded = false; }
  p.vy = Math.max(p.vy - 95 * dt, -55);                       // -55 = emergency descent suit terminal speed
  if (p.grounded && fl > p.pos.y && fl - p.pos.y < 1.6) { p.pos.y += (fl - p.pos.y) * (1 - Math.exp(-30 * dt)); p.vy = 0; }
  else {
    p.pos.y += p.vy * dt;
    if (p.pos.y <= fl) { p.pos.y = fl; p.vy = 0; p.grounded = true; }
    else if (p.pos.y > fl + 0.6) p.grounded = false;
  }

  // animation
  if (ml > 0) { p.face += angDiff(p.face, Math.atan2(mx, mz)) * (1 - Math.exp(-14 * dt)); p.walkT += dt * (p.sprint ? 17 : 12) * Math.min(1, moved / (dt * 20 + 1e-6)); }
  g.position.copy(p.pos); g.rotation.y = p.face;
  const sw = ml > 0 && p.grounded ? Math.sin(p.walkT) * 0.7 : 0, av = p.av;
  av.legs[0].rotation.x = sw; av.legs[1].rotation.x = -sw; av.arms[0].rotation.x = -sw * 0.8; av.arms[1].rotation.x = sw * 0.8;
  if (!p.grounded) { av.legs[0].rotation.x = 0.4; av.legs[1].rotation.x = -0.3; av.arms[0].rotation.x = av.arms[1].rotation.x = -0.9; }
  if (p.workT > 0) { p.workT -= dt; av.arms[0].rotation.x = Math.sin(G.time * 20) * 1.3 - 1; av.arms[1].rotation.x = Math.sin(G.time * 20 + 2) * 1.3 - 1; }
  av.lamp.intensity = lerp(0.8, 3.4, G.night);
  if (p.grounded && ml > 0 && (p.stepT -= dt) <= 0) { p.stepT = p.sprint ? 0.12 : 0.2; puff(p.pos.x, p.pos.y + 0.3, p.pos.z, 1, 2, 1.6); }
}

// ---------------------------------------------------------------------
// 23. HOVER  (deploy, fly, fuel, hull, crash)
// ---------------------------------------------------------------------
function deployHover(bay, instant) {
  if (G.spawnCd > 0 && !instant) { toast(`Hover fabricator recharging: ${Math.ceil(G.spawnCd)}s`); SND.play('deny'); return; }
  if (hv.alive) burst(hv.pos.x, hv.pos.y + 3, hv.pos.z, 0x66e8ff, 26, 30);          // old hover is recalled
  hv.alive = true; hv.occ = false; hv.fuel = 100; hv.hull = 100; hv.vel.set(0, 0, 0); hv.heading = Math.PI; hv.pitch = hv.roll = 0; hv.warnedFuel = false;
  hv.pos.set(bay.x, bay.y + (instant ? 0.5 : 90), bay.z); hv.spawn = instant ? null : { t: 0, y0: bay.y + 90, bay };
  hv.obj.group.visible = true; hv.obj.glow.visible = true; G.spawnCd = 12;
  if (!instant) { spawnBeam.visible = true; SND.play('spawn'); toast(`HOVER DEPLOYED  ·  ${bay.name}`); }
}
function damageHover(d) {
  if (!hv.alive || d <= 0) return;
  hv.hull -= d; SND.play('hit');
  if (hv.occ) { cam.shake = Math.max(cam.shake, Math.min(1, d / 30)); flash('hit'); }
  if (hv.hull <= 0) destroyHover();
}
function destroyHover() {
  const p = hv.pos, wasOcc = hv.occ; hv.alive = false; hv.obj.group.visible = false; hv.obj.glow.visible = false; hv.spawn = null; spawnBeam.visible = false;
  burst(p.x, p.y + 3, p.z, 0xffa040, 70, 45, 4); burst(p.x, p.y + 3, p.z, 0xffffff, 25, 60, 3); puff(p.x, p.y + 2, p.z, 24, 18, 7);
  SND.play('boom'); cam.shake = 1.4; stats.hoversLost++;
  if (wasOcc) { hv.occ = false; player.inHover = false; player.av.group.visible = true; player.pos.copy(p); player.grounded = false; player.vy = 8; player.vx = player.vz = 0; }
  toast('HOVER DESTROYED  ·  deploy a new one at any Hover Bay', 4200);
}
function enterHover() {
  hv.occ = true; player.inHover = true; player.av.group.visible = false; cam.yaw = hv.heading + Math.PI; cam.idle = 5;
  SND.play('enter'); toast('SPACE climb  ·  C descend  ·  SHIFT boost  ·  E exit', 3200);
}
function exitHover() {
  if (hv.alt > 14 && hv.fuel > 0) { toast('Land the hover before exiting'); SND.play('deny'); return; }
  const rx = -Math.cos(hv.heading), rz = Math.sin(hv.heading), x = hv.pos.x + rx * 11, z = hv.pos.z + rz * 11;
  hv.occ = false; player.inHover = false; player.av.group.visible = true; hv.vel.set(0, 0, 0);
  player.pos.set(x, floorAt(x, z, hv.pos.y, 4), z); player.grounded = true; player.vy = 0; player.vx = player.vz = 0; SND.play('enter');
}

function updateHover(dt) {
  if (!hv.alive) return;
  const g = hv.obj.group, o = hv.obj;
  if (hv.spawn) {                                       // drop-in animation
    const s = hv.spawn; s.t += dt; const k = Math.min(1, s.t / 1.6), e = 1 - Math.pow(1 - k, 3);
    hv.pos.y = lerp(s.y0, s.bay.y + 0.5, e); hv.pos.x = s.bay.x; hv.pos.z = s.bay.z;
    spawnBeam.position.set(s.bay.x, s.bay.y + 80, s.bay.z); spawnBeam.material.opacity = (1 - k) * 0.5 + 0.05;
    o.flames.forEach(f => { f.scale.y = 1.1 + Math.random() * 0.3; }); o.mainFlame.scale.y = 0.001;
    g.position.copy(hv.pos); g.rotation.set(0, hv.heading, 0);
    if (k >= 1) { hv.spawn = null; spawnBeam.visible = false; puff(s.bay.x, s.bay.y + 1, s.bay.z, 22, 22, 6); burst(s.bay.x, s.bay.y + 2, s.bay.z, 0x66e8ff, 20, 25); SND.play('door'); cam.shake = Math.max(cam.shake, 0.3); }
    return;
  }
  const occ = hv.occ, engine = occ && hv.fuel > 0;
  const fl = floorAt(hv.pos.x, hv.pos.z, hv.pos.y, 3); hv.alt = hv.pos.y - fl;
  let thr = 0, steer = 0, up = false, down = false, boost = false;
  if (engine) { thr = (keys.w ? 1 : 0) - (keys.s ? 0.6 : 0); steer = (keys.a ? 1 : 0) - (keys.d ? 1 : 0); up = keys.space; down = keys.down; boost = keys.shift && hv.fuel > 4 && (thr > 0 || up); }
  const space = smoothstep(120, 700, hv.pos.y), spd0 = Math.hypot(hv.vel.x, hv.vel.z);
  const maxSp = 85 * (1 + 1.3 * space) * (boost ? 1.9 : 1);
  hv.heading += steer * dt * (1.9 - Math.min(0.9, spd0 / 260));
  const sn = Math.sin(hv.heading), cs = Math.cos(hv.heading), rate = (thr !== 0 ? 1.7 : 0.55) * (engine ? 1 : 0.25), kk = 1 - Math.exp(-rate * dt);
  hv.vel.x += (sn * thr * maxSp - hv.vel.x) * kk; hv.vel.z += (cs * thr * maxSp - hv.vel.z) * kk;
  const rest = occ ? 3.0 : 0.5;
  if (engine) {
    const climb = 55 * (1 + 0.8 * space) * (boost ? 1.6 : 1);
    const tvy = up ? climb : down ? -40 : hv.alt < rest + 0.6 ? (rest - hv.alt) * 3.2 : 0;
    hv.vel.y += (tvy - hv.vel.y) * (1 - Math.exp(-3.5 * dt));
  } else hv.vel.y = Math.max(hv.vel.y - 70 * dt, -120);                         // no engine: gravity

  let nx = hv.pos.x + hv.vel.x * dt, nz = hv.pos.z + hv.vel.z * dt, ny = hv.pos.y + hv.vel.y * dt;
  const r = resolveColliders(nx, nz, 7, ny - 1, ny + 6, true);
  if (r.hit > 0.02) { nx = r.x; nz = r.z; const dmg = Math.max(0, spd0 - 28) * 0.3; hv.vel.x *= 0.35; hv.vel.z *= 0.35; if (dmg > 0.5) damageHover(dmg); }
  const lim = ny > 300 ? 1300 : 640; nx = clamp(nx, -lim, lim); nz = clamp(nz, -lim, lim); ny = Math.min(ny, 1800);
  const nfl = floorAt(nx, nz, ny, 3);
  if (ny < nfl + rest) {
    if (-hv.vel.y > 55) damageHover((-hv.vel.y - 55) * 0.9);
    if (occ) ny = lerp(ny, nfl + rest, 1 - Math.exp(-14 * dt)); else ny = nfl + rest;
    if (hv.vel.y < 0) hv.vel.y = 0;
  }
  if (!hv.alive) return;
  hv.pos.set(nx, ny, nz); hv.spd = Math.hypot(hv.vel.x, hv.vel.z);
  if (occ) { stats.dist += hv.spd * dt; stats.maxAlt = Math.max(stats.maxAlt, ny); }

  // fuel & repairs
  if (occ && hv.fuel > 0) {
    const use = 0.25 + Math.max(0, thr) * 0.7 + (up ? 2.6 : 0) + (boost ? 4 : 0);
    hv.fuel = Math.max(0, hv.fuel - use * dt * (hv.alt < 4 && !up && thr === 0 ? 0.2 : 1));
    if (hv.fuel <= 0 && !hv.warnedFuel) { hv.warnedFuel = true; toast('FUEL EMPTY  ·  engines offline!', 3500); SND.play('alarm'); }
  }
  let atBay = false; for (const b of SPAWNERS) if (Math.hypot(nx - b.x, nz - b.z) < 24 && Math.abs(ny - b.y) < 14) { atBay = true; break; }
  const resting = hv.alt < 6 && hv.spd < 14;
  if (resting) { hv.fuel = Math.min(100, hv.fuel + (atBay ? 22 : 2.5) * dt); if (atBay) hv.hull = Math.min(100, hv.hull + 8 * dt); }
  if (hv.fuel > 15) hv.warnedFuel = false;

  // visuals
  hv.pitch += ((-(hv.vel.y / 70) * 0.35 + thr * 0.07) - hv.pitch) * (1 - Math.exp(-6 * dt));
  hv.roll += (steer * 0.42 - hv.roll) * (1 - Math.exp(-5 * dt));
  g.position.copy(hv.pos); g.rotation.set(hv.pitch, hv.heading, hv.roll);
  const lift = engine ? (up ? 1 : hv.alt < 8 ? 0.55 : 0.35) : 0;
  o.flames.forEach(f => { f.scale.y = lift * (0.8 + Math.random() * 0.4) + 0.001; });
  o.mainFlame.scale.y = engine ? (0.15 + Math.max(0, thr) * 0.7 + (boost ? 0.9 : 0)) * (0.9 + Math.random() * 0.2) + 0.001 : 0.001;
  o.navL.visible = Math.sin(G.time * 5) > 0; o.navR.visible = Math.sin(G.time * 5 + 1.5) > 0;
  o.spot.intensity = occ ? lerp(1.0, 5, G.night) : 0;
  if (engine) {
    const bx = hv.pos.x - sn * 10.5, bz = hv.pos.z - cs * 10.5;
    if (Math.random() < 0.8) sparks.emit(bx, hv.pos.y + 2.8, bz, -sn * (14 + hv.spd * 0.3) + rand(-2, 2), rand(-1, 1), -cs * (14 + hv.spd * 0.3) + rand(-2, 2), 0.45, boost ? 3.4 : 2.2, 0.2, boost ? 0x9fe8ff : 0xffa040, 0.9);
    if (lift > 0.3 && Math.random() < 0.5) sparks.emit(hv.pos.x + rand(-6, 6), hv.pos.y + 0.5, hv.pos.z + rand(-4, 4), 0, -14, 0, 0.35, 1.8, 0.2, 0x9fe8ff, 0.7);
    if (hv.alt < 16 && Math.random() < 0.9) puff(hv.pos.x + rand(-6, 6), nfl + 0.5, hv.pos.z + rand(-6, 6), 1, 14 + hv.spd * 0.1, 5);
  }
  o.glow.position.set(nx, nfl + 0.3, nz);
  o.glow.material.opacity = hv.alt < 40 ? 0.3 * (1 - hv.alt / 40) * (engine ? 1 : 0.3) : 0;
  if (hv.hull < 35 && Math.random() < 0.3) dust.emit(hv.pos.x + rand(-2, 2), hv.pos.y + 4, hv.pos.z + rand(-2, 2), rand(-2, 2), 6, rand(-2, 2), 1.2, 2.5, 7, 0x222222, 0.7);
}

// ---------------------------------------------------------------------
// 24. INTERACTIONS  (bays, hover, O2 tower, tasks)
// ---------------------------------------------------------------------
function updateInteract(dt) {
  const p = player; let prompt = '', working = false;
  if (p.inHover) {
    if (hv.alt < 14 || hv.fuel <= 0) prompt = 'Press E to exit hover';
    if (pressed.e) exitHover();
    p.taskProg = Math.max(0, p.taskProg - dt * 50); return prompt;
  }
  const x = p.pos.x, y = p.pos.y, z = p.pos.z;
  let bay = null; for (const b of SPAWNERS) if (Math.hypot(x - b.console.x, z - b.console.z) < 10 && Math.abs(y - b.y) < 12) { bay = b; break; }
  if (bay) {
    prompt = G.spawnCd > 0 ? `Hover fabricator recharging: ${Math.ceil(G.spawnCd)}s` : hv.alive ? 'Press E to recall hover to this bay' : 'Press E to deploy a hover';
    if (pressed.e) deployHover(bay);
  } else if (hv.alive && !hv.spawn && Math.hypot(x - hv.pos.x, z - hv.pos.z) < 14 && Math.abs(y - hv.pos.y) < 10) {
    prompt = 'Press E to board hover'; if (pressed.e) enterHover();
  } else if (Math.hypot(x - O2_TOWER.x, z - O2_TOWER.z) < O2_TOWER.radius && Math.abs(y - O2_TOWER.y) < 12) {
    if (p.role !== 3) prompt = 'O2 Tower requires MEDIC (press 3)';
    else if (p.o2cd > 0) prompt = `O2 tower cooling down (${Math.ceil(p.o2cd)}s)`;
    else if (p.o2 >= 100) prompt = 'O2 FULL';
    else {
      prompt = 'Hold E to refill O2';
      if (keys.e) {
        p.o2 += dt * 40; p.workT = 0.15; if (Math.random() < 0.1) SND.play('refill');
        if (Math.random() < 0.6) sparks.emit(O2_TOWER.x + rand(-4, 4), O2_TOWER.y + 4, O2_TOWER.z + rand(-4, 4), 0, 10, 0, 0.8, 1.6, 0.2, 0x66ffff, 0.8);
        if (p.o2 >= 100) { p.o2 = 100; p.o2cd = 30; SND.play('door'); }
      }
    }
  } else if (taskIdx < tasks.length) {
    const t = tasks[taskIdx];
    if (Math.hypot(x - t.pos.x, z - t.pos.z) < t.radius && Math.abs(y - t.pos.y) < 8) {
      if (p.role === t.role) {
        prompt = `Hold E to ${t.text}`;
        if (keys.e) {
          working = true; p.workT = 0.15; p.taskProg += dt * (100 / t.duration) * (p.role === 1 ? 1.25 : 1);
          p.power = Math.min(100, p.power + dt * 8);
          if (Math.random() < 0.2) SND.play('work');
          if (Math.random() < 0.6) sparks.emit(x + Math.sin(p.face) * 2, y + 2.8, z + Math.cos(p.face) * 2, rand(-8, 8), rand(2, 10), rand(-8, 8), 0.5, 1.4, 0.1, 0xffd24a, 1, 30);
          if (p.taskProg >= 100) completeTask();
        }
      } else prompt = `Requires ${ROLES[t.role].name}  (press ${t.role})`;
    }
  }
  if (!working) p.taskProg = Math.max(0, p.taskProg - dt * 50);
  return prompt;
}

// ---------------------------------------------------------------------
// 25. SURVIVAL (oxygen / power)
// ---------------------------------------------------------------------
function updateSurvival(dt) {
  const p = player, pos = p.inHover ? hv.pos : p.pos;
  const zone = G.zone = p.inHover ? 'hover' : zoneAt(pos.x, pos.y, pos.z);
  let rate;
  if (zone === 'hab' || zone === 'station') rate = -2.5;                  // pressurised: slow recharge
  else if (zone === 'hover') rate = 0.25;
  else if (zone === 'shelter') rate = 0.35;
  else rate = G.event === 'Dust Storm' ? 3.2 : 1.0;
  if (rate > 0) { if (p.sprint && zone === null) rate *= 1.5; if (p.role === 3) rate *= 0.7; }
  p.o2 = clamp(p.o2 - rate * dt, 0, 100);
  p.power -= 0.4 * dt;
  if (p.o2cd > 0) p.o2cd = Math.max(0, p.o2cd - dt);
  G.alarmT = (G.alarmT || 0) - dt;
  if (G.alarmT <= 0) { if (p.o2 < 20) { SND.play('alarm'); G.alarmT = 0.5; } else if (p.power < 20) { SND.play('lowpwr'); G.alarmT = 1.6; } }
  if (p.power <= 0) gameOver('Base power lost. Life support offline.');
  else if (p.o2 <= 0) gameOver('Oxygen depleted.');
}

// ---------------------------------------------------------------------
// 26. EVENTS : Dust Storm / Comms Blackout / Meteor Shower
// ---------------------------------------------------------------------
const meteors = [];
for (let i = 0; i < 8; i++) {
  const ring = mesh(new THREE.RingGeometry(0.82, 1, 40), glowMat(0xff3322, 0.8), 0, 0, 0, scene, false); ring.rotation.x = -Math.PI / 2; ring.scale.set(11, 11, 1); ring.visible = false;
  const rock = mesh(new THREE.SphereGeometry(2.4, 10, 8), glowMat(0xffa040, 0.95), 0, 0, 0, scene, false); rock.visible = false;
  meteors.push({ s: 0, t: 0, x: 0, z: 0, gy: 0, ring, rock });
}
function spawnMeteor() {
  const m = meteors.find(q => q.s === 0); if (!m) return;
  const base = player.inHover ? hv.pos : player.pos; if (base.y > 200) return;
  const a = Math.random() * 6.283, d = rand(6, 70);
  m.x = base.x + Math.cos(a) * d; m.z = base.z + Math.sin(a) * d; m.gy = floorAt(m.x, m.z, base.y + 5, 3);
  m.s = 1; m.t = 0; m.ring.position.set(m.x, m.gy + 0.6, m.z); m.ring.visible = true; SND.play('meteor');
}
function updateMeteors(dt) {
  if (G.event === 'Meteor Shower' && (G.metT = (G.metT || 0) - dt) <= 0) { G.metT = rand(0.5, 1.3); spawnMeteor(); if (Math.random() < 0.4) spawnMeteor(); }
  for (const m of meteors) {
    if (m.s === 0) continue;
    m.t += dt;
    if (m.s === 1) {
      m.ring.material.opacity = 0.35 + 0.45 * Math.abs(Math.sin(m.t * 12));
      if (m.t > 1.3) { m.s = 2; m.t = 0; m.rock.visible = true; }
    } else {
      const k = Math.min(1, m.t / 0.55), e = k * k;
      const x = m.x + 70 * (1 - e), y = m.gy + 300 * (1 - e), z = m.z + 35 * (1 - e);
      m.rock.position.set(x, y, z); sparks.emit(x, y, z, rand(-3, 3), rand(-3, 3), rand(-3, 3), 0.6, 4, 0.3, 0xffa040, 0.9);
      if (k >= 1) {
        m.s = 0; m.rock.visible = false; m.ring.visible = false;
        burst(m.x, m.gy + 1, m.z, 0xffa040, 40, 40, 3.5); puff(m.x, m.gy + 1, m.z, 16, 20, 7);
        const base = player.inHover ? hv.pos : player.pos, d = Math.hypot(base.x - m.x, base.z - m.z);
        if (d < 150) { SND.play('boom'); cam.shake = Math.max(cam.shake, clamp(1 - d / 150, 0.1, 0.9)); }
        if (d < 12 && Math.abs(base.y - m.gy) < 20) {
          if (player.inHover) damageHover(28);
          else if (G.zone !== 'hab' && G.zone !== 'shelter') { player.o2 = Math.max(1, player.o2 - 18); flash('hit'); SND.play('hit'); toast('METEOR IMPACT  ·  suit breach!', 1800); }
        }
      }
    }
  }
}
function updateEvents(dt) {
  G.storm += ((G.event === 'Dust Storm' ? 1 : 0) - G.storm) * (1 - Math.exp(-0.7 * dt));
  G.blackout += ((G.event === 'Comms Blackout' ? 1 : 0) - G.blackout) * (1 - Math.exp(-3 * dt));
  G.dishSpin = G.blackout > 0.5 ? 6 : 1;
  if (!G.event) {
    if ((G.nextEvent -= dt) <= 0) {
      G.event = ['Dust Storm', 'Comms Blackout', 'Meteor Shower'][Math.floor(Math.random() * 3)];
      G.eventEnd = G.time + (G.event === 'Dust Storm' ? 30 : 22); SND.play('alarm'); SND.tone(440, 0.6, 'sawtooth', 0.06, 220);
    }
  } else if (G.time > G.eventEnd) { G.event = null; G.nextEvent = rand(35, 60); toast('All clear  ·  hazard has passed', 2200); }
  updateMeteors(dt);
}
function ambientDust(dt, cx, cy, cz) {
  if (G.space > 0.6) return;
  const n = (G.storm * 7 + 0.4) * (1 - G.space), wx = 55 + G.storm * 40;
  for (let i = 0; i < n; i++) if (Math.random() < Math.min(1, n - i)) dust.emit(cx + rand(-70, 70), cy + rand(-6, 24), cz + rand(-70, 70), wx, rand(-1, 3), 14, 1.6, 1.4 + G.storm, 2 + G.storm * 2, 0xd8946a, 0.12 + G.storm * 0.28);
}

// ---------------------------------------------------------------------
// 27. CAMERA  (third person, wall + ground aware, shake, speed FOV)
// ---------------------------------------------------------------------
const _ct = V3(0, 0, 0);
function updateCamera(dt) {
  const inH = player.inHover;
  if (inH) { _ct.set(hv.pos.x, hv.pos.y + 4, hv.pos.z); cam.idle += dt; if (cam.idle > 1.4 && hv.spd > 6) cam.yaw += angDiff(cam.yaw, hv.heading + Math.PI) * (1 - Math.exp(-1.6 * dt)); }
  else _ct.set(player.pos.x, player.pos.y + 3.6, player.pos.z);
  const zone = inH ? null : G.zone;
  cam.dist += ((inH ? 32 + hv.spd * 0.12 : (zone && zone !== 'station' ? 15 : 30)) - cam.dist) * (1 - Math.exp(-3 * dt));
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  let cx = _ct.x + cam.dist * Math.sin(cam.yaw) * cp, cy = _ct.y + cam.dist * sp + (inH ? 3 : 2), cz = _ct.z + cam.dist * Math.cos(cam.yaw) * cp;
  // keep the camera in front of walls
  const rx = cx - _ct.x, rz = cz - _ct.z; let tmin = 1;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i]; if (c.footOnly || (c.door && c.door.t > 0.75) || cy > c.y1 + 2 || cy < c.y0) continue;
    const sx = c.bx - c.ax, sz = c.bz - c.az; if (sx * sx + sz * sz < 1e-6) continue;
    const den = rx * sz - rz * sx; if (Math.abs(den) < 1e-6) continue;
    const t = ((c.ax - _ct.x) * sz - (c.az - _ct.z) * sx) / den, u = ((c.ax - _ct.x) * rz - (c.az - _ct.z) * rx) / den;
    if (t > 0 && t < tmin && u >= 0 && u <= 1) tmin = t;
  }
  if (tmin < 1) { const f = Math.max(0.15, tmin - 0.05); cx = _ct.x + rx * f; cz = _ct.z + rz * f; cy = _ct.y + (cy - _ct.y) * f; }
  cy = Math.max(cy, floorAt(cx, cz, cy, 2) + 2.2);
  cam.shake *= Math.exp(-3 * dt);
  camera.position.set(cx + rand(-1, 1) * cam.shake * 1.4, cy + rand(-1, 1) * cam.shake * 1.4, cz + rand(-1, 1) * cam.shake * 1.4);
  camera.lookAt(_ct);
  const tf = 60 + (inH ? clamp(hv.spd / 150, 0, 1) * 16 : player.sprint ? 5 : 0);
  cam.fov += (tf - cam.fov) * (1 - Math.exp(-4 * dt));
  if (Math.abs(camera.fov - cam.fov) > 0.05) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
}

// ---------------------------------------------------------------------
// 28. HUD, WAYPOINT, MINIMAP
// ---------------------------------------------------------------------
function cls(id, name, on) { const k = 'c' + id + name; if (_last[k] !== on) { _last[k] = on; $(id).classList.toggle(name, on); } }
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const _wp = V3(0, 0, 0);
function updateWaypoint() {
  const t = tasks[taskIdx]; if (!t || G.blackout > 0.5) return show('waypoint', false);
  const base = player.inHover ? hv.pos : player.pos, dist = Math.hypot(base.x - t.pos.x, base.y - t.pos.y, base.z - t.pos.z);
  _wp.set(t.pos.x, t.pos.y + 14, t.pos.z).project(camera);
  let x = _wp.x, y = _wp.y; const behind = _wp.z > 1; if (behind) { x = -x; y = -y; }
  const off = behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.86;
  if (off) { const m = Math.max(Math.abs(x) / 0.92, Math.abs(y) / 0.86, 1e-3); x /= m; y /= m; }
  show('waypoint', true, 'flex'); cls('waypoint', 'off', off);
  $('waypoint').style.transform = `translate(${((x * 0.5 + 0.5) * window.innerWidth).toFixed(0)}px,${((0.5 - y * 0.5) * window.innerHeight).toFixed(0)}px) translate(-50%,-50%)`;
  txt('wp-dist', Math.round(dist) + ' m'); txt('quest-dist', Math.round(dist) + ' m');
}
const POIS = [
  [0, 0, '#4fe8ff', 'H'], [PAD.mine.x, PAD.mine.z, '#ff9a3a', 'M'], [PAD.nuke.x, PAD.nuke.z, '#33ff77', 'N'], [PAD.ice.x, PAD.ice.z, '#9ff8ff', 'I'],
  [200, 180, '#cfd3da', 'G'], [PAD.solar.x, PAD.solar.z, '#5a9bff', 'S'], [PAD.comms.x, PAD.comms.z, '#ffffff', 'C'], [PAD.o2.x, PAD.o2.z, '#66ffff', 'O']
];
function drawMinimap() {
  const c = $('minimap'), ctx = c.getContext ? c.getContext('2d') : null; if (!ctx) return;
  const W = c.width, R = W / 2;
  ctx.clearRect(0, 0, W, W); ctx.save(); ctx.beginPath(); ctx.arc(R, R, R - 2, 0, 7); ctx.clip();
  ctx.fillStyle = 'rgba(4,16,26,0.86)'; ctx.fillRect(0, 0, W, W);
  if (G.blackout > 0.5) {
    for (let i = 0; i < 240; i++) { ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.3})`; ctx.fillRect(Math.random() * W, Math.random() * W, 4 + Math.random() * 14, 2); }
    ctx.fillStyle = '#ff5544'; ctx.font = 'bold 14px Orbitron, monospace'; ctx.textAlign = 'center'; ctx.fillText('NO SIGNAL', R, R + 5); ctx.restore(); return;
  }
  const inH = player.inHover, bp = inH ? hv.pos : player.pos, range = inH ? 300 + clamp(hv.pos.y, 0, 1000) * 0.7 : 300, s = (R - 8) / range;
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const map = (x, z) => { const dx = x - bp.x, dz = z - bp.z; return [R + (dx * cy - dz * sy) * s, R + (dx * sy + dz * cy) * s]; };
  const edge = (p) => { const dx = p[0] - R, dy = p[1] - R, d = Math.hypot(dx, dy), lim = R - 12; return d > lim ? [R + dx / d * lim, R + dy / d * lim, true] : [p[0], p[1], false]; };
  ctx.strokeStyle = 'rgba(79,232,255,0.18)'; ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.arc(R, R, (R - 8) * i / 3, 0, 7); ctx.stroke(); }
  ctx.font = 'bold 10px Orbitron, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [x, z, col, ch] of POIS) { const p = map(x, z); if (Math.hypot(p[0] - R, p[1] - R) > R - 8) continue; ctx.fillStyle = col; ctx.globalAlpha = 0.28; ctx.fillRect(p[0] - 8, p[1] - 8, 16, 16); ctx.globalAlpha = 1; ctx.fillText(ch, p[0], p[1] + 1); }
  for (const b of SPAWNERS) { if (b.id === 'station') continue; const p = map(b.x, b.z); if (Math.hypot(p[0] - R, p[1] - R) > R - 8) continue; ctx.strokeStyle = '#7ff6ff'; ctx.strokeRect(p[0] - 4, p[1] - 4, 8, 8); }
  const st = edge(map(STATION.x, STATION.z)); ctx.fillStyle = '#c9a7ff'; ctx.beginPath(); ctx.arc(st[0], st[1], 5, 0, 7); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText('ORB', st[0], st[1] + (st[1] < R ? 13 : -13));
  const t = tasks[taskIdx]; if (t) { const tp = edge(map(t.pos.x, t.pos.z)), pulse = 5 + Math.sin(G.time * 5) * 2; ctx.strokeStyle = '#f1c40f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(tp[0], tp[1], pulse + 2, 0, 7); ctx.stroke(); ctx.fillStyle = '#f1c40f'; ctx.beginPath(); ctx.arc(tp[0], tp[1], 2.5, 0, 7); ctx.fill(); }
  const arrow = (x, z, ang, col) => { const p = map(x, z), fx = Math.sin(ang) * cy - Math.cos(ang) * sy, fy = Math.sin(ang) * sy + Math.cos(ang) * cy;
    ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(Math.atan2(fx, -fy)); ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5.5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5.5, 6); ctx.closePath(); ctx.fill(); ctx.restore(); };
  if (hv.alive) { const p = map(hv.pos.x, hv.pos.z); if (Math.hypot(p[0] - R, p[1] - R) < R - 8) arrow(hv.pos.x, hv.pos.z, hv.heading, '#ff9a3a'); }
  if (!inH) arrow(player.pos.x, player.pos.z, player.face, '#ffffff'); else { ctx.fillStyle = '#ff9a3a'; ctx.beginPath(); ctx.arc(R, R, 3, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#ff6b5a'; ctx.fillText('N', R + sy * (R - 9), R - cy * (R - 9));
  ctx.restore();
}

let _quest = '';
function updateHUD(dt, prompt) {
  const p = player, inH = p.inHover;
  bar('o2-bar', p.o2); txt('o2-val', Math.floor(p.o2) + '%'); bar('pwr-bar', p.power); txt('pwr-val', Math.floor(p.power) + '%');
  cls('hud', 'lowo2', p.o2 < 20); cls('hud', 'lowpwr', p.power < 20); cls('hud', 'storm', G.storm > 0.3); cls('hud', 'space', G.space > 0.5);
  if (p.o2cd > 0) { show('o2-cooldown', true); txt('o2-cooldown', `RECHARGING: ${Math.ceil(p.o2cd)}s`); } else show('o2-cooldown', false);
  show('hover-panel', inH, 'block');
  if (inH) {
    bar('fuel-bar', hv.fuel); txt('fuel-val', Math.floor(hv.fuel) + '%'); bar('hull-bar', hv.hull); txt('hull-val', Math.floor(hv.hull) + '%');
    txt('spd-val', Math.round(hv.spd * 1.8)); txt('alt-val', Math.max(0, Math.round(hv.pos.y)));
    txt('st-dist', Math.round(Math.hypot(hv.pos.x - STATION.x, hv.pos.y - STATION.y, hv.pos.z - STATION.z)));
    cls('fuel-bar', 'warn', hv.fuel < 20); cls('hull-bar', 'warn', hv.hull < 35);
  }
  txt('controls-hint', inH ? 'W/S throttle · A/D steer · SPACE climb · C descend · SHIFT boost · E exit' : 'WASD move · SHIFT sprint · SPACE jump · E interact · 1/2/3 role · M mute · P pause');
  txt('bay-cd', G.spawnCd > 0 ? `FABRICATOR ${Math.ceil(G.spawnCd)}s` : 'FABRICATOR READY');
  document.querySelectorAll('.role-chip').forEach(ch => { const a = +ch.dataset.role === p.role; if (ch._a !== a) { ch._a = a; ch.classList.toggle('active', a); } });
  const hr = ((G.tod * 24 + 6) % 24), hh = Math.floor(hr), mm = Math.floor((hr - hh) * 60);
  txt('clock', `SOL 1 · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  txt('time-val', fmtTime(G.time - G.startT));
  if (G.event) { show('event-alert', true); txt('event-alert', `⚠ ${G.event.toUpperCase()} ⚠  ${Math.max(0, Math.ceil(G.eventEnd - G.time))}s`); } else show('event-alert', false);
  const t = tasks[taskIdx];
  if (t) txt('quest-text', G.blackout > 0.5 ? '▒▒ COMMS BLACKOUT ▒▒  SIGNAL LOST' : `TASK ${taskIdx + 1}/${TASK_COUNT}: ${t.text}`);
  show('task-bar-bg', p.taskProg > 0.5); bar('task-bar-fill', p.taskProg);
  txt('prompt', prompt); show('prompt', !!prompt);
  updateWaypoint(); drawMinimap();
}

// ---------------------------------------------------------------------
// 29. GAME FLOW
// ---------------------------------------------------------------------
function startGame() {
  if (G.state !== 'menu') return;
  SND.init(); SND.startMusic();
  show('menu', false); show('hud', true, 'flex');
  G.state = 'playing'; G.startT = G.time; stats.tasks = 0;
  tasks = generateTasks(); taskIdx = 0; switchRole(1); updateTaskUI();
  player.pos.set(0, floorAt(0, 84, 100), 84); cam.yaw = 0; cam.pitch = 0.35; cam.idle = 0;
  lockMouse(); clock.getDelta();
  toast('Welcome, Commander. Hover deploying at the Habitat Bay...', 3600);
  setTimeout(() => { if (G.state === 'playing' && !hv.alive) deployHover(SPAWNERS[0]); }, 900);
}
function fillStats() {
  txt('stat-tasks', `${taskIdx}/${TASK_COUNT}`); txt('stat-time', fmtTime(G.time - G.startT));
  txt('stat-dist', Math.round(stats.dist) + ' m'); txt('stat-alt', Math.round(stats.maxAlt) + ' m');
}
function endGame(title, color, reason) {
  if (G.state === 'over') return; G.state = 'over'; document.exitPointerLock(); SND.setEngine(0, 0); SND.setWind(0.1);
  fillStats(); txt('go-title', title); $('go-title').style.color = color; txt('fail-reason', reason); show('game-over', true, 'flex'); show('hud', false);
}
function gameOver(reason) { endGame('MISSION FAILED', '#e74c3c', reason); SND.play('boom'); }
function winGame() { endGame('MISSION SUCCESS', '#2ecc71', `You saved the outpost! All ${TASK_COUNT} tasks completed.`); SND.play('done'); }
$('startBtn').addEventListener('click', startGame);

// ---------------------------------------------------------------------
// 30. MAIN LOOP
// ---------------------------------------------------------------------
const clock = new THREE.Clock();
const _actP = { x: 0, y: 0, z: 0, reach: 0 }, _actH = { x: 0, y: 0, z: 0, reach: 0 }, _actors = [];
function worldVisuals(dt, focus) {
  updateEnvironment(dt, focus); updateStructures(dt, G.time); updateRoofs(dt, focus.x, focus.y, focus.z);
  dust.update(dt); sparks.update(dt);
  if (beacon.group.visible) beacon.mats[0].opacity = 0.22 + 0.1 * Math.sin(G.time * 3);
}
function simulate(dt) {
  G.time += dt; G.spawnCd = Math.max(0, G.spawnCd - dt);
  updateEvents(dt);
  if (!player.inHover) updatePlayer(dt);
  updateHover(dt);
  if (G.state !== 'playing') return;                          // destroyed / game over inside updates
  _actors.length = 0;
  if (!player.inHover) { _actP.x = player.pos.x; _actP.y = player.pos.y; _actP.z = player.pos.z; _actors.push(_actP); }
  if (hv.alive) { _actH.x = hv.pos.x; _actH.y = hv.pos.y; _actH.z = hv.pos.z; _actH.reach = hv.occ ? hv.spd * 0.9 : 0; _actors.push(_actH); }
  updateDoors(dt, _actors);
  updateSurvival(dt);
  if (G.state !== 'playing') return;
  const prompt = updateInteract(dt); pressed.e = false;
  updateCamera(dt);
  const focus = player.inHover ? hv.pos : player.pos;
  worldVisuals(dt, focus);
  ambientDust(dt, camera.position.x, camera.position.y, camera.position.z);
  G.audT = (G.audT || 0) - dt;
  if (G.audT <= 0) {
    G.audT = 0.1; const spd = player.inHover ? hv.spd : 0;
    SND.setWind(clamp(G.storm * 0.9 + 0.12 * (1 - G.space) + spd / 450, 0, 1));
    SND.setEngine(player.inHover && hv.fuel > 0 ? 0.35 + 0.65 * clamp(spd / 150, 0, 1) : 0, spd / 150 + (keys.space && player.inHover ? 0.4 : 0));
  }
  updateHUD(dt, prompt);
}
let menuAngle = 0;
function menuFrame(dt) {
  G.time += dt; menuAngle += dt * 0.07;
  camera.position.set(Math.cos(menuAngle) * 175, terrainHeight(0, 0) + 48 + Math.sin(menuAngle * 0.7) * 10, Math.sin(menuAngle) * 175 + 20);
  camera.lookAt(0, terrainHeight(0, 0) + 22, 20); camera.updateMatrixWorld();
  worldVisuals(dt, V3(0, 0, 0));
}
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (G.state === 'playing') simulate(dt);
  else if (G.state === 'menu') menuFrame(dt);
  else if (G.state === 'over') { G.time += dt; updateCamera(dt); worldVisuals(dt, player.inHover ? hv.pos : player.pos); }
  // Add these to your main game loop:
txt('o2-value', Math.round(player.o2) + '%');
txt('power-value', Math.round(player.power) + '%');
  renderer.render(scene, camera);
}
switchRole(1);
animate();
// =====================================================================
// START BUTTON CONNECTION (Add this if missing)
// =====================================================================
document.getElementById('start-btn').addEventListener('click', () => {
    // 1. Hide the menu overlay
    document.getElementById('menu').style.display = 'none';
    
    // 2. Change game state to 'playing'
    G.state = 'playing';
    
    // 3. Initialize Audio (needs a click to start)
    if (typeof SND !== 'undefined') {
        SND.init();
        SND.startMusic();
    }
    
    // 4. Generate the 50 tasks
    if (typeof generateTasks === 'function') {
        tasks = generateTasks();
        taskIdx = 0;
        if (typeof updateTaskUI === 'function') updateTaskUI();
    }
    
    // 5. Lock the mouse for 3D camera control
    if (typeof lockMouse === 'function') {
        lockMouse();
    }
    
    console.log("Game Started!");
});


// =====================================================================
// MOBILE TOUCH CONTROLS
// =====================================================================
(function initMobileControls() {
  const joystickZone = document.getElementById('joystick-zone');
  const joystickKnob = document.getElementById('joystick-knob');
  const lookZone = document.getElementById('look-zone');
  
  if (!joystickZone || !lookZone) return; // Exit if UI is missing

  // --- 1. Joystick Logic (WASD) ---
  let joyCenter = { x: 0, y: 0 };
  let joyRadius = 50;
  let joyTouchId = null;

  joystickZone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const rect = joystickZone.getBoundingClientRect();
    joyCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    joyRadius = rect.width / 2;
    joyTouchId = e.changedTouches[0].identifier;
    updateJoystick(e.changedTouches[0]);
  }, { passive: false });

  joystickZone.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === joyTouchId) {
        updateJoystick(e.changedTouches[i]);
      }
    }
  }, { passive: false });

  const endJoystick = (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === joyTouchId) {
        joyTouchId = null;
        keys.w = keys.a = keys.s = keys.d = false;
        joystickKnob.style.transform = `translate(-50%, -50%)`;
      }
    }
  };
  joystickZone.addEventListener('touchend', endJoystick);
  joystickZone.addEventListener('touchcancel', endJoystick);

  function updateJoystick(touch) {
    let dx = touch.clientX - joyCenter.x;
    let dy = touch.clientY - joyCenter.y;
    const dist = Math.hypot(dx, dy);
    
    // Clamp knob to base
    if (dist > joyRadius) {
      dx = (dx / dist) * joyRadius;
      dy = (dy / dist) * joyRadius;
    }
    
    joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    // Map to WASD (threshold of 20px to prevent jitter)
    const threshold = 20;
    keys.w = dy < -threshold;
    keys.s = dy > threshold;
    keys.a = dx < -threshold;
    keys.d = dx > threshold;
  }

  // --- 2. Camera Look Logic ---
  let lookTouchId = null;
  let lastLookX = 0, lastLookY = 0;

  lookZone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (lookTouchId === null) {
      lookTouchId = e.changedTouches[0].identifier;
      lastLookX = e.changedTouches[0].clientX;
      lastLookY = e.changedTouches[0].clientY;
    }
  }, { passive: false });

  lookZone.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === lookTouchId) {
        const touch = e.changedTouches[i];
        const dx = touch.clientX - lastLookX;
        const dy = touch.clientY - lastLookY;
        
        cam.yaw -= dx * 0.005;
        cam.pitch = clamp(cam.pitch - dy * 0.005, -0.25, 1.15);
        
        lastLookX = touch.clientX;
        lastLookY = touch.clientY;
        cam.idle = 0; // Wake up camera
      }
    }
  }, { passive: false });

  const endLook = (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === lookTouchId) {
        lookTouchId = null;
      }
    }
  };
  lookZone.addEventListener('touchend', endLook);
  lookZone.addEventListener('touchcancel', endLook);

  // --- 3. Action Buttons ---
  const bindBtn = (id, keyName, isKeyMap = true) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      btn.classList.add('active');
      if (isKeyMap) {
        keys[keyName] = true;
      } else if (keyName === 'e') {
        pressed.e = true; // Trigger interaction
      }
    }, { passive: false });

    btn.addEventListener('touchend', (e) => {
      e.preventDefault();
      btn.classList.remove('active');
      if (isKeyMap) keys[keyName] = false;
    });
  };

  bindBtn('btn-interact', 'e', false); // E uses 'pressed' object
  bindBtn('btn-space', 'space');       // Space is in 'keys'
  bindBtn('btn-shift', 'shift');       // Shift is in 'keys'
})();

// =====================================================================
// BULLETPROOF FULLSCREEN TOGGLE
// =====================================================================
(function initFullscreen() {
  const btn = document.getElementById('fullscreen-btn');
  let isPseudoFullscreen = false;

  function triggerFullscreen(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    // Show a toast so we know the button was actually pressed
    if (typeof toast === 'function') toast("Toggling Fullscreen...", 1500);

    const isNative = document.fullscreenElement || document.webkitFullscreenElement;
    
    if (isNative) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    } else if (isPseudoFullscreen) {
      togglePseudoFullscreen();
      return;
    }

    // Try Native
    const el = document.documentElement;
    try {
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => {
          // Native failed (blocked by phone), use CSS fallback
          if (typeof toast === 'function') toast("Native Fullscreen blocked, using fallback", 2000);
          togglePseudoFullscreen();
        });
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      } else {
        // API doesn't exist, use CSS fallback
        togglePseudoFullscreen();
      }
      
      // Try to lock landscape
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
      }
    } catch (err) {
      togglePseudoFullscreen();
    }
  }

  function togglePseudoFullscreen() {
    isPseudoFullscreen = !isPseudoFullscreen;
    const hud = document.getElementById('hud');
    const canvas = document.querySelector('canvas');

    if (isPseudoFullscreen) {
      document.body.classList.add('pseudo-fullscreen');
      if (hud) hud.classList.add('pseudo-fullscreen');
      if (canvas) canvas.classList.add('pseudo-fullscreen');
      window.scrollTo(0, 1);
    } else {
      document.body.classList.remove('pseudo-fullscreen');
      if (hud) hud.classList.remove('pseudo-fullscreen');
      if (canvas) canvas.classList.remove('pseudo-fullscreen');
    }
    
    // Force 3D engine resize
    if (typeof renderer !== 'undefined' && typeof camera !== 'undefined') {
      setTimeout(() => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
      }, 150);
    }
  }

  // Attach to 'pointerdown' which is the most reliable mobile event
  if (btn) {
    btn.addEventListener('pointerdown', triggerFullscreen);
    btn.addEventListener('click', triggerFullscreen); // Desktop fallback
  }
})();
// =====================================================================
// MOBILE ROLE SWITCHING
// =====================================================================
(function initMobileRoles() {
  const chips = document.querySelectorAll('.role-chip');
  
  chips.forEach(chip => {
    // Handle both Desktop clicks and Mobile taps
    const handleRoleChange = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const roleId = parseInt(chip.dataset.role);
      if (typeof switchRole === 'function' && !isNaN(roleId)) {
        switchRole(roleId);
      }
    };
    
    chip.addEventListener('click', handleRoleChange);
    chip.addEventListener('touchstart', handleRoleChange, { passive: false });
  });
})();