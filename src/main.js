// Cérebro Babel — explorador de arquivos em grafo 3D (estilo Obsidian) com identidade Babel.
// v2: foco na pasta com dupla hélice de DNA em pé, histórico (Espaço/Q/E), painel único
// recolhível, card HUD holográfico e visor grande dentro do app.
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { forceRadial } from 'd3-force-3d';

// ---------------- identidade ----------------
const COLORS = {
  pasta: '#3b82ff', imagem: '#3fe3ff', video: '#e04bff', audio: '#34e6a6',
  documento: '#ffb547', codigo: '#8b5cff', compactado: '#f5c76a', outro: '#8d9bc4', mais: '#f5c76a',
};
const LABELS = {
  pasta: 'Pasta', imagem: 'Imagem', video: 'Vídeo', audio: 'Áudio', documento: 'Documento',
  codigo: 'Código', compactado: 'Compactado', outro: 'Outro',
};
const SIGLA = { pasta: 'DIR', imagem: 'IMG', video: 'VID', audio: 'AUD', documento: 'DOC', codigo: 'COD', compactado: 'ZIP', outro: 'BIN', mais: 'MAIS' };
const XDG = new Set(['Documentos', 'Imagens', 'Vídeos', 'Músicas', 'Downloads', 'Área de trabalho', 'apps', 'projetos', 'Modelos', 'Público']);
const TEXT_EXT = new Set('txt md markdown csv tsv log js mjs cjs ts tsx jsx py go rs c h cpp hpp cc java kt rb php html htm css scss sass less json jsonc yml yaml toml sh bash zsh fish sql vue svelte lua swift xml ini conf cfg env gradle dart r pl desktop service'.split(' '));
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const ext = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const nf = (v) => Number(v || 0).toLocaleString('pt-BR');

function fmtSize(b) {
  if (b == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toLocaleString('pt-BR', { maximumFractionDigits: i ? 1 : 0 })} ${u[i]}`;
}
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
function hexId(s) { // identificador curto e estável, só para o visual do HUD
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return '0x' + (h >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(0, 6);
}

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

const store = { // localStorage pode falhar (janela privada, dados bloqueados)
  get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* segue sem lembrar */ } },
};

// ---------------- estado ----------------
const nodes = new Map();
let links = [];
let info = { hostname: 'computador' };
let sizeFactor = 1;
let hovered = null;

// foco
let focusId = null;             // pasta em foco (null = visão do cérebro)
const focusSet = new Set();     // em brilho total: a pasta e os filhos
const litSet = new Set();       // focusSet + caminho até o cérebro (fios desse caminho continuam acesos)
const helixIds = new Set();     // filhos dispostos na hélice
let dimK = 0, dimTarget = 0;    // 0 = tudo aceso, 1 = resto esmaecido
const pins = new Map();         // id -> animação/fixação de posição
const homes = new Map();        // id -> posição antes de entrar na hélice
let spotlight = null;           // arquivo escolhido na hélice (rótulo sempre visível, giro pausado)
let spinOn = !reduced;
const hist = { back: [], fwd: [] };
let navToken = 0;

// ---------------- materiais e geometrias compartilhados ----------------
const GEO = {
  sphere: new THREE.SphereGeometry(1, 16, 12),
  ico: new THREE.IcosahedronGeometry(1.75, 1),
  ring: new THREE.TorusGeometry(2.2, 0.35, 8, 28),
};
const matCache = new Map();
function mat(key, make) {
  if (!matCache.has(key)) {
    const m = make();
    m.userData.base = m.opacity;
    matCache.set(key, m);
  }
  return matCache.get(key);
}
// materiais dos nós: 'f:kind' (miolo) e 'w:kind' (casca aramada); a versão '~' é a esmaecida
function nodeMat(mk, dim) {
  return mat((dim ? '~' : '') + mk, () => {
    const [t, k] = mk.split(':');
    const m = new THREE.MeshBasicMaterial({ color: COLORS[k], transparent: true, opacity: t === 'w' ? 0.35 : 0.95, wireframe: t === 'w' });
    m.userData.dim = dim;
    return m;
  });
}
function lineMat(type, kind, dim) {
  return mat(`L:${type}:${type === 'neural' ? '' : kind}${dim ? '~' : ''}`, () => {
    const opacity = type === 'neural' ? 0.35 : type === 'seq' ? 0.5 : 0.22;
    const m = type === 'neural'
      ? new THREE.MeshBasicMaterial({ color: '#2aa9e0', transparent: true, opacity })
      : new THREE.LineBasicMaterial({ color: COLORS[kind] || COLORS.outro, transparent: true, opacity });
    m.userData.dim = dim;
    m.userData.line = type;
    return m;
  });
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
const GLOW = glowTexture();

// ---------------- o CÉREBRO ----------------
function gyri(x, y, z) {
  const a = Math.sin(x * 0.95 + Math.sin(z * 0.55) * 1.8) * Math.cos(z * 0.85 + Math.sin(y * 0.9) * 1.4);
  const b = Math.sin(y * 1.2 + Math.cos(x * 0.7 + z * 0.3) * 1.6);
  return 1 - Math.abs(a * 0.7 + b * 0.3);
}
const holoMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uFade: { value: 1 }, uA: { value: new THREE.Color('#3fe3ff') }, uB: { value: new THREE.Color('#8b5cff') }, uC: { value: new THREE.Color('#e04bff') } },
  vertexShader: `
    attribute float aRidge; varying float vRidge; varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main() {
      vRidge = aRidge; vP = position;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform float uTime; uniform float uFade; uniform vec3 uA; uniform vec3 uB; uniform vec3 uC;
    varying float vRidge; varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main() {
      float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
      vec3 col = mix(uA, uB, smoothstep(-12.0, 12.0, vP.z));
      col = mix(col, uC, smoothstep(4.0, 11.0, vP.y) * 0.6);
      float sulco = smoothstep(0.18, 0.02, vRidge);
      float onda = 0.5 + 0.5 * sin(vP.z * 0.6 - uTime * 2.2);
      float a = f * 0.5 + 0.015 + onda * 0.03;
      a *= (1.0 - sulco * 0.85);
      gl_FragColor = vec4(col * (0.35 + f * 0.65 + onda * 0.15) * uFade, a * uFade);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});

function hemisphere(side) {
  const geo = new THREE.SphereGeometry(1, 96, 72);
  const p = geo.attributes.position;
  const ridge = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    x = x * 9.2 * (side * x > 0 ? 1 : 0.3);
    y = y * 10.2 * (y < 0 ? 0.74 : 1);
    z = z * 13.2 * (1 + 0.06 * y / 10);
    const g = gyri(Math.abs(x), y, z);
    ridge[i] = g;
    const k = 1 + 0.06 * g;
    p.setXYZ(i, side * 1.2 + x * k, y * k, z * k);
  }
  geo.setAttribute('aRidge', new THREE.BufferAttribute(ridge, 1));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, holoMat);
}

const brainParts = {};
function makeBrain() {
  const g = new THREE.Group();
  const cortex = new THREE.Group();
  cortex.add(hemisphere(-1), hemisphere(1));
  cortex.rotation.x = 1.05;
  g.add(cortex);

  const N = reduced ? 700 : 1400;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const cA = new THREE.Color('#9ff3ff'), cB = new THREE.Color('#c9b5ff');
  let i = 0, guard = 0;
  while (i < N && guard++ < N * 40) {
    const side = i % 2 ? 1 : -1;
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    const x = Math.abs(s * Math.cos(th)) * 9.2, y = u * 10.2 * (u < 0 ? 0.74 : 1), z = s * Math.sin(th) * 13.2;
    const gg = gyri(x, y, z);
    if (gg < 0.8) continue;
    const k = 1.02 + 0.07 * gg;
    pos.set([side * (1.2 + x * k), y * k, z * k], i * 3);
    const c = cA.clone().lerp(cB, Math.random());
    col.set([c.r, c.g, c.b], i * 3);
    i++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.3, vertexColors: true, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  cortex.add(pts);

  const stem = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 0.8, 9, 16, 1, true),
    new THREE.MeshBasicMaterial({ color: '#3b82ff', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  stem.position.set(0, -10.5, -2.5);
  cortex.add(stem);

  const core = new THREE.Mesh(new THREE.SphereGeometry(1.6, 20, 14),
    new THREE.MeshBasicMaterial({ color: '#7eeaff', transparent: true, opacity: 0.3 }));
  g.add(core);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: GLOW, color: '#3b82ff', transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  halo.scale.set(46, 46, 1);
  g.add(halo);
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(19, 2),
    new THREE.MeshBasicMaterial({ color: '#8b5cff', wireframe: true, transparent: true, opacity: 0.05 }));
  g.add(shell);

  const el = document.createElement('div');
  el.className = 'lbl lbl-brain';
  el.innerHTML = `<b>${esc(info.hostname)}</b><span>o computador</span>`;
  const lbl = new CSS2DObject(el);
  lbl.position.set(0, 17, 0);
  g.add(lbl);

  for (const o of [pts, stem, core, halo, shell]) o.raycast = () => {};
  g.scale.setScalar(2.2);
  Object.assign(brainParts, { g, cortex, pts, stem, core, halo, shell, el });
  return g;
}

// ---------------- objetos dos nós ----------------
function baseScale(n) {
  if (n.type === 'file') return Math.min(2.6, 1.05 + Math.log10((n.size || 0) + 10) * 0.2);
  if (n.type === 'more') return 1;
  if (n.depth === 1) return XDG.has(n.name) ? 2.9 : 2.2;
  return Math.max(1.4, 2 - n.depth * 0.12);
}

function makeLabel(n) {
  const el = document.createElement('div');
  el.className = `lbl lbl-d${Math.min(n.depth, 3)}${n.type === 'more' ? ' lbl-more' : ''}${XDG.has(n.name) && n.depth === 1 ? ' lbl-xdg' : ''}`;
  el.style.setProperty('--c', COLORS[n.kind] || COLORS.pasta);
  const count = n.type === 'more' ? '' : n.children != null ? `<i>${n.children}</i>` : '';
  el.innerHTML = `${esc(n.name)}${count}`;
  const o = new CSS2DObject(el);
  n.__label = o;
  return o;
}

function meshFor(geo, mk) {
  const m = new THREE.Mesh(geo, nodeMat(mk, false));
  m.userData.mk = mk;
  return m;
}

function nodeObject(n) {
  if (n.type === 'brain') return makeBrain();
  let obj;
  if (n.type === 'file') {
    obj = meshFor(GEO.sphere, 'f:' + n.kind);
  } else if (n.type === 'more') {
    obj = new THREE.Group();
    obj.add(meshFor(GEO.ring, 'f:mais'));
    const l = makeLabel(n);
    l.position.set(0, 3.4, 0);
    obj.add(l);
  } else {
    obj = new THREE.Group();
    obj.add(meshFor(GEO.sphere, 'f:' + n.kind));
    obj.add(meshFor(GEO.ico, 'w:' + n.kind));
    const l = makeLabel(n);
    l.position.set(0, 2.6, 0);
    obj.add(l);
  }
  obj.userData.base = baseScale(n);
  obj.scale.setScalar(obj.userData.base * sizeFactor);
  n.__obj = obj;
  n.__dimmed = false;
  if (isDim(n)) setNodeDim(n, true);
  return obj;
}

// ---------------- grafo ----------------
const container = $('#grafo');
const css2d = new CSS2DRenderer();
css2d.domElement.classList.add('css2d');

const idOf = (end) => (end && typeof end === 'object' ? end.id : end);
const isDim = (n) => focusId !== null && !focusSet.has(n.id);
const linkLit = (l) => focusId === null || (litSet.has(idOf(l.source)) && litSet.has(idOf(l.target)));
const linkHidden = (l) => focusId !== null && (helixIds.has(idOf(l.source)) || helixIds.has(idOf(l.target)));

const graph = new ForceGraph3D(container, { extraRenderers: [css2d], controlType: 'orbit' })
  .backgroundColor('#030817')
  .showNavInfo(false)
  .nodeId('id')
  .nodeLabel(() => '')
  .nodeThreeObject(nodeObject)
  .enableNodeDrag(false)
  .linkWidth((l) => (l.type === 'neural' ? 0.55 : 0))
  .linkMaterial((l) => lineMat(l.type, l.kind, !linkLit(l)))
  .linkCurvature((l) => (l.type === 'seq' ? 0.28 : 0))
  .linkDirectionalParticles((l) => (reduced ? 0 : l.type === 'neural' ? 2 : l.type === 'seq' ? 2 : 1))
  // partículas dos fios fora do foco quase param
  .linkDirectionalParticleSpeed((l) => (l.type === 'neural' ? 0.0035 : l.type === 'seq' ? 0.009 : 0.0022) * (linkLit(l) ? 1 : 1 - 0.94 * dimK))
  .linkDirectionalParticleWidth((l) => (l.type === 'neural' ? 1.5 : l.type === 'seq' ? 1.25 : 0.8))
  .linkDirectionalParticleColor((l) => (l.type === 'neural' ? '#7eeaff' : COLORS[l.kind]))
  .linkDirectionalParticleResolution(6)
  .cooldownTime(reduced ? 3500 : 7000)
  .d3AlphaDecay(0.035)
  .d3VelocityDecay(0.38)
  .onEngineStop(() => document.body.classList.add('estavel'));

css2d.domElement.style.pointerEvents = 'none';

graph.d3Force('charge').strength((n) => (n.type === 'brain' ? -420 : n.type === 'file' ? -22 : -90)).distanceMax(260);
graph.d3Force('link')
  .distance((l) => (l.type === 'neural' ? 190 : l.type === 'seq' ? 9 : 26 + Math.sqrt(l.fan || 1) * 3))
  .strength((l) => (l.type === 'seq' ? 0.5 : l.type === 'tree' ? 0.3 : 0.5));
graph.d3Force('radial', forceRadial((n) => (n.depth ? 190 + (n.depth - 1) * 80 : 0))
  .strength((n) => (n.type === 'brain' ? 0 : n.depth === 1 ? 0.3 : 0.035)));
graph.d3Force('center', null);

const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), reduced ? 0.7 : 1.0, 0.35, 0.12);
graph.postProcessingComposer().addPass(bloom);
// Passo final só copia (o render target já está em sRGB; codificar de novo lavaria o fundo).
graph.postProcessingComposer().addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }',
}));

(function stars() {
  const N = 1400;
  const p = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 900 + Math.random() * 900, u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    p.set([r * s * Math.cos(t), r * u, r * s * Math.sin(t)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  graph.scene().add(new THREE.Points(g, new THREE.PointsMaterial({ color: '#6f8cff', size: 1.6, transparent: true, opacity: 0.45, depthWrite: false })));
})();

function refresh() {
  graph.graphData({ nodes: [...nodes.values()], links: links.slice() });
  $('#stats').textContent = `${nodes.size.toLocaleString('pt-BR')} neurônios · ${links.length.toLocaleString('pt-BR')} fios`;
  document.body.classList.remove('estavel');
}

function addLink(source, target, type, kind, fan) {
  links.push({ source, target, type, kind, fan });
}

function spawnNear(parent) {
  const j = () => (Math.random() - 0.5) * 10;
  const p = parent || { x: 0, y: 0, z: 0 };
  return { x: (p.x || 0) * 1.04 + j(), y: (p.y || 0) * 1.04 + j(), z: (p.z || 0) * 1.04 + j() };
}

function addItems(parent, data) {
  const isHome = parent.type === 'brain';
  for (const it of data.items) {
    if (nodes.has(it.path)) continue;
    let host = parent;
    if (isHome && it.type === 'file') {
      host = ensureSoltos();
      host.pending.push(it);
      host.children = host.pending.length;
      continue;
    }
    const n = { ...it, id: it.path, parent: host.id, depth: host.depth + 1, expanded: false, ...spawnNear(host) };
    nodes.set(n.id, n);
    addLink(host.id, n.id, isHome ? 'neural' : 'tree', n.kind, data.total);
    if (n.type === 'file') {
      if (host.lastFile) addLink(host.lastFile, n.id, 'seq', n.kind);
      host.lastFile = n.id;
    }
  }
  removeNode(parent.id + '#mais');
  const next = data.offset + data.limit;
  if (next < data.total) {
    const m = {
      id: parent.id + '#mais', type: 'more', kind: 'mais', name: `+${(data.total - next).toLocaleString('pt-BR')} mais`,
      parent: parent.id, depth: parent.depth + 1, offset: next, ...spawnNear(parent),
    };
    nodes.set(m.id, m);
    addLink(parent.id, m.id, isHome ? 'neural' : 'tree', 'mais');
  }
}

function ensureSoltos() {
  let s = nodes.get('#soltos');
  if (!s) {
    s = { id: '#soltos', type: 'group', kind: 'pasta', name: 'Arquivos soltos', path: '', parent: '#brain', depth: 1, children: 0, pending: [], ...spawnNear() };
    nodes.set(s.id, s);
    addLink('#brain', s.id, 'neural', 'pasta');
  }
  return s;
}

function removeNode(id) {
  const n = nodes.get(id);
  if (!n) return;
  if (n.__label) n.__label.element.remove();
  dropDnaLabel(n);
  pins.delete(id);
  homes.delete(id);
  helixIds.delete(id);
  nodes.delete(id);
  links = links.filter((l) => idOf(l.source) !== id && idOf(l.target) !== id);
}

function removeDescendants(id) {
  for (const n of [...nodes.values()]) {
    if (n.parent === id) {
      removeDescendants(n.id);
      removeNode(n.id);
    }
  }
}

async function loadPage(n, offset = 0) {
  if (n.loading) return n.loading;
  document.body.classList.add('carregando');
  n.loading = (async () => {
    try {
      if (n.type === 'group') {
        addItems(n, { items: n.pending, offset: 0, limit: n.pending.length, total: n.pending.length });
      } else {
        addItems(n, await api(`/api/list?path=${enc(n.path)}&offset=${offset}`));
      }
      n.expanded = true;
      n.__label?.element.classList.add('aberta');
      refresh();
      if (focusId === n.id) layoutHelix(n);
    } catch (e) {
      toast(`Não consegui abrir ${n.name}: ${e.message}`);
    } finally {
      n.loading = null;
      document.body.classList.remove('carregando');
    }
  })();
  return n.loading;
}

function collapse(n) {
  removeDescendants(n.id);
  n.expanded = false;
  n.lastFile = null;
  n.__label?.element.classList.remove('aberta');
  refresh();
}

async function toggle(n) {
  if (n.expanded) collapse(n);
  else await loadPage(n);
}

async function loadMore(m) {
  const parent = nodes.get(m.parent);
  if (parent) await loadPage(parent, m.offset);
}

async function openOnDesktop(n) {
  try {
    await api('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cerebro': '1' }, body: JSON.stringify({ path: n.path }) });
    toast(`Abrindo ${n.name} no aplicativo padrão…`);
  } catch (e) { toast(`Não abriu: ${e.message}`); }
}

// ---------------- câmera ----------------
let camBusyUntil = 0;
function camTo(pos, look, ms) {
  const d = reduced ? 0 : ms;
  camBusyUntil = performance.now() + d;
  graph.cameraPosition(pos, look, d);
}
const HOME_CAM = { x: 0, y: 80, z: 520 };
function flyHome(ms = 1400) {
  camTo(HOME_CAM, { x: 0, y: 0, z: 0 }, ms);
}
function flyTo(n, ms = 1200) {
  const x = n.x || 0, y = n.y || 0, z = n.z || 0;
  if (helixIds.has(n.id) && helix.group) { // na hélice: aproxima de lado, pelo lado de fora da fita
    let dx = x - helix.origin.x, dz = z - helix.origin.z;
    const r = Math.hypot(dx, dz) || 1;
    dx /= r; dz /= r;
    camTo({ x: x + dx * 72, y: y + 8, z: z + dz * 72 }, { x, y, z }, ms);
    return;
  }
  const r = Math.hypot(x, y, z) || 1;
  const d = n.type === 'file' ? 45 : 90;
  camTo({ x: x + (x / r) * d, y: y + (y / r) * d + 12, z: z + (z / r) * d }, { x, y, z }, ms);
}
function zoom(f) {
  const cam = graph.camera();
  const tgt = graph.controls().target;
  const v = cam.position.clone().sub(tgt).multiplyScalar(f).add(tgt);
  camTo({ x: v.x, y: v.y, z: v.z }, tgt, 400);
}
function resize(f) {
  sizeFactor = Math.min(3, Math.max(0.4, sizeFactor * f));
  for (const n of nodes.values()) n.__obj?.scale.setScalar(n.__obj.userData.base * sizeFactor);
}

// =====================================================================
// FOCO + DUPLA HÉLICE DE DNA EM PÉ
// =====================================================================
const helix = { group: null, origin: new THREE.Vector3(), R: 12, step: 4, turn: 0.58, H: 0, pairs: 0, spin: 0, alpha: 0, mats: [], rungs: [], pulses: null, folder: null };
const dying = []; // hélices antigas sumindo
const _v = new THREE.Vector3();

function helixLocal(i) {
  const pair = Math.floor(i / 2), strand = i % 2;
  const th = pair * helix.turn + strand * Math.PI;
  return new THREE.Vector3(helix.R * Math.cos(th), -pair * helix.step, helix.R * Math.sin(th));
}

function curPos(n) { return { x: n.x || 0, y: n.y || 0, z: n.z || 0 }; }

function pinNode(n, spec) {
  if (n.type === 'brain') return;
  if (!homes.has(n.id)) homes.set(n.id, { ...curPos(n), fresh: !!spec.fresh });
  pins.set(n.id, { from: curPos(n), t0: performance.now(), dur: reduced ? 0 : 1100, ...spec });
}

function releaseNode(n) {
  if (!n || n.type === 'brain') return;
  const home = homes.get(n.id);
  if (!home || home.fresh) { // nasceu durante o foco: solta e deixa a física arrumar
    pins.delete(n.id);
    homes.delete(n.id);
    delete n.fx; delete n.fy; delete n.fz;
    needReheat = true;
    return;
  }
  pins.set(n.id, { mode: 'home', from: curPos(n), to: home, t0: performance.now(), dur: reduced ? 0 : 1000 });
}
let needReheat = false;

function disposeGroup(g) {
  g.traverse((o) => { o.geometry?.dispose(); if (o.material && o.material !== holoMat) o.material.dispose(); });
  g.parent?.remove(g);
}

function dropHelixGroup(fade) {
  if (!helix.group) return;
  if (fade && !reduced) dying.push({ group: helix.group, mats: helix.mats, alpha: helix.alpha });
  else disposeGroup(helix.group);
  helix.group = null;
  helix.mats = [];
  helix.rungs = [];
  helix.pulses = null;
}

function buildHelixGroup(kids) {
  const g = new THREE.Group();
  g.position.copy(helix.origin);
  g.rotation.y = helix.spin;
  const mats = [];
  const add = (o) => { o.material.userData.base = o.material.opacity; mats.push(o.material); o.raycast = () => {}; g.add(o); return o; };
  const pairs = helix.pairs;
  const span = Math.max(1, pairs - 1);
  // duas fitas (esqueleto de açúcar-fosfato): tubos finos que o bloom faz brilhar
  for (let strand = 0; strand < 2; strand++) {
    const pts = [];
    const extra = 0.9; // a fita passa um pouco das pontas
    for (let s = -extra; s <= span + extra + 1e-6; s += 0.2) {
      const th = s * helix.turn + strand * Math.PI;
      pts.push(new THREE.Vector3(helix.R * Math.cos(th), -s * helix.step, helix.R * Math.sin(th)));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.TubeGeometry(curve, Math.max(24, pts.length * 2), 0.32, 6, false);
    add(new THREE.Mesh(tube, new THREE.MeshBasicMaterial({
      color: strand ? '#8b5cff' : '#3fe3ff', transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false,
    })));
  }
  // pontes (pares de base): cada par de arquivos ligado por um fio que pulsa
  const rungPos = [], rungCol = [];
  helix.rungs = [];
  for (let p = 0; p < pairs; p++) {
    const a = kids[p * 2], b = kids[p * 2 + 1];
    const A = helixLocal(p * 2), Bp = b ? helixLocal(p * 2 + 1) : A.clone().multiplyScalar(-1).setY(A.y);
    helix.rungs.push([A, Bp]);
    rungPos.push(A.x, A.y, A.z, Bp.x, Bp.y, Bp.z);
    const ca = new THREE.Color(COLORS[a.kind] || COLORS.outro), cb = new THREE.Color(b ? COLORS[b.kind] || COLORS.outro : '#3b82ff');
    rungCol.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b);
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(rungPos, 3));
  rg.setAttribute('color', new THREE.Float32BufferAttribute(rungCol, 3));
  add(new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })));
  // pulsos viajando nas pontes
  const pp = new Float32Array(pairs * 2 * 3);
  const pc = new Float32Array(pairs * 2 * 3);
  for (let p = 0; p < pairs; p++) {
    pc.set(rungCol.slice(p * 6, p * 6 + 3), p * 6);
    pc.set(rungCol.slice(p * 6 + 3, p * 6 + 6), p * 6 + 3);
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  pg.setAttribute('color', new THREE.BufferAttribute(pc, 3));
  helix.pulses = add(new THREE.Points(pg, new THREE.PointsMaterial({
    map: GLOW, size: 3.4, vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
  })));
  // eixo central tênue
  const ax = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, helix.step * 2, 0), new THREE.Vector3(0, -span * helix.step - helix.step * 2, 0)]);
  add(new THREE.Line(ax, new THREE.LineBasicMaterial({ color: '#3fe3ff', transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false })));
  for (const m of mats) m.opacity = m.userData.base * helix.alpha;
  graph.scene().add(g);
  helix.group = g;
  helix.mats = mats;
  updatePulses(0);
}

function updatePulses(t) {
  if (!helix.pulses) return;
  const arr = helix.pulses.geometry.attributes.position;
  helix.rungs.forEach(([A, B], p) => {
    for (let j = 0; j < 2; j++) {
      const ph = ((t * 0.55 + p * 0.37 + j * 0.5) % 1 + 1) % 1;
      const s = j ? 1 - ph : ph;
      arr.setXYZ(p * 2 + j, A.x + (B.x - A.x) * s, A.y + (B.y - A.y) * s, A.z + (B.z - A.z) * s);
    }
  });
  arr.needsUpdate = true;
}

// dispõe os filhos da pasta em foco na hélice (chamado ao focar e quando chegam mais itens)
function layoutHelix(F) {
  const kids = [...nodes.values()].filter((n) => n.parent === F.id);
  for (const id of [...helixIds]) if (!kids.some((k) => k.id === id)) { helixIds.delete(id); releaseNode(nodes.get(id)); dropDnaLabel(nodes.get(id)); }
  const N = kids.length;
  helix.pairs = Math.max(1, Math.ceil(N / 2));
  helix.step = N > 80 ? 2.5 : N > 30 ? 3.2 : 4.4;
  helix.R = Math.min(36, 11 + Math.sqrt(N) * 1.9);
  helix.turn = N > 80 ? 0.34 : N > 30 ? 0.45 : 0.58;
  helix.H = Math.max(0, helix.pairs - 1) * helix.step;
  const fp = pins.get(F.id)?.to || homes.get(F.id) || curPos(F);
  helix.origin.set(fp.x, fp.y - 14, fp.z);
  helix.folder = F.id;
  const hadGroup = !!helix.group;
  dropHelixGroup(false);
  if (!hadGroup) helix.alpha = 0;
  focusSet.clear();
  focusSet.add(F.id);
  kids.forEach((n, i) => {
    helixIds.add(n.id);
    focusSet.add(n.id);
    const fresh = !homes.has(n.id) && !n.__obj; // acabou de nascer
    pinNode(n, { mode: 'helix', local: helixLocal(i), fresh: fresh || homes.get(n.id)?.fresh });
  });
  computeLit();
  if (N) buildHelixGroup(kids);
  labelsDirty = true;
  applyVisuals();
}

function computeLit() {
  litSet.clear();
  for (const id of focusSet) litSet.add(id);
  let p = focusId && nodes.get(focusId);
  while (p) { litSet.add(p.id); p = nodes.get(p.parent); }
}

function releaseHelix() {
  for (const id of helixIds) { const n = nodes.get(id); releaseNode(n); dropDnaLabel(n); }
  helixIds.clear();
}

// aplica esmaecimento em nós e fios (troca de material sem reconstruir o grafo)
function applyVisuals() {
  for (const n of nodes.values()) {
    if (n.type === 'brain' || !n.__obj) continue;
    const dim = isDim(n);
    if (n.__dimmed !== dim) setNodeDim(n, dim);
  }
  for (const l of links) {
    const o = l.__lineObj;
    if (o) {
      const m = lineMat(l.type, l.kind, !linkLit(l));
      if (o.material !== m) o.material = m;
      o.visible = !linkHidden(l);
    }
    if (l.__photonsObj) l.__photonsObj.visible = !linkHidden(l);
  }
}
function setNodeDim(n, dim) {
  n.__dimmed = dim;
  n.__obj.traverse((m) => { if (m.userData.mk) m.material = nodeMat(m.userData.mk, dim); });
}

function parentFocusOf(id) {
  const n = nodes.get(id);
  if (!n || !n.parent || n.parent === '#brain') return null;
  return n.parent;
}

// carrega os ancestrais até o caminho existir no grafo
async function ensurePath(p) {
  if (nodes.has(p)) return nodes.get(p);
  const segs = p.split('/');
  for (let i = 1; i <= segs.length; i++) {
    const cur = segs.slice(0, i).join('/');
    let guard = 0;
    while (!nodes.has(cur) && guard++ < 40) {
      const parentId = i === 1 ? null : segs.slice(0, i - 1).join('/');
      if (i === 1) {
        const s = nodes.get('#soltos');
        if (s && !s.expanded) { await loadPage(s); continue; }
        break;
      }
      const parent = nodes.get(parentId);
      if (!parent) break;
      const more = nodes.get(parentId + '#mais');
      if (!parent.expanded) await loadPage(parent);
      else if (more) await loadMore(more);
      else break;
    }
    if (!nodes.has(cur)) break;
  }
  return nodes.get(p) || null;
}

async function setFocus(id) {
  const token = ++navToken;
  spotlight = null;
  if (id && !nodes.has(id) && id !== '#soltos') await ensurePath(id);
  if (token !== navToken) return;
  if (id && !nodes.has(id)) { toast('Essa pasta não está mais no grafo.'); id = null; }
  const prevFolder = focusId && nodes.get(focusId);
  releaseHelix();
  if (prevFolder && prevFolder.id !== id) releaseNode(prevFolder);
  dropHelixGroup(true);
  focusId = id;
  focusSet.clear();
  if (!id) {
    dimTarget = 0;
    computeLit();
    applyVisuals();
    flyHome();
    updateTrail();
    return;
  }
  const F = nodes.get(id);
  // a pasta fica parada onde estava antes de entrar em qualquer hélice
  const home = homes.get(F.id);
  pinNode(F, { mode: 'fixed', to: home ? { x: home.x, y: home.y, z: home.z } : curPos(F) });
  focusSet.add(F.id);
  dimTarget = 1;
  computeLit();
  applyVisuals();
  updateTrail();
  if (!F.expanded) await loadPage(F); // loadPage chama layoutHelix
  else layoutHelix(F);
  if (token !== navToken) return;
  flyToHelix();
  updateTrail();
}

function flyToHelix(ms = 1400) {
  const o = helix.origin;
  const c = { x: o.x, y: o.y - helix.H / 2, z: o.z };
  let dx = o.x, dz = o.z;
  const r = Math.hypot(dx, dz) || 1;
  dx /= r; dz /= r;
  const cam = graph.camera();
  const half = THREE.MathUtils.degToRad(cam.fov / 2);
  const needV = helix.H / 2 + helix.R * 0.5 + 34; // folga para o topo (trilha) e para a fita mais próxima
  const needH = (helix.R + 40) / Math.max(0.5, cam.aspect * 0.6); // rótulos dos dois lados
  const dist = clamp(Math.max(needV, needH) / Math.tan(half) + helix.R, 90, 820);
  camTo({ x: c.x + dx * dist, y: c.y + dist * 0.1, z: c.z + dz * dist }, c, ms);
}

// ---------------- histórico: Espaço / Q / E ----------------
function navigate(id) {
  id = id ?? null;
  if (id !== focusId) {
    hist.back.push(focusId);
    if (hist.back.length > 60) hist.back.shift();
    hist.fwd.length = 0;
  }
  return setFocus(id);
}
function goBack() {
  if (hist.back.length) { hist.fwd.push(focusId); return setFocus(hist.back.pop()); }
  if (focusId) { hist.fwd.push(focusId); return setFocus(parentFocusOf(focusId)); }
  toast('Você já está no cérebro.');
  return Promise.resolve();
}
function goForward() {
  if (!hist.fwd.length) { toast('Nada para refazer.'); return Promise.resolve(); }
  hist.back.push(focusId);
  return setFocus(hist.fwd.pop());
}
function goBrain() { return navigate(null); }

// trilha no topo (onde estou) + estado dos botões voltar/avançar
function updateTrail() {
  const segs = [];
  let n = focusId && nodes.get(focusId);
  while (n && n.type !== 'brain') { segs.unshift(n); n = nodes.get(n.parent); }
  $('#trilha-segs').innerHTML = `<button data-id="" class="${focusId ? '' : 'atual'}"><span class="dot" style="--c:#3fe3ff"></span>Cérebro</button>` +
    segs.map((s, i) => `<i>›</i><button data-id="${esc(s.id)}" class="${i === segs.length - 1 ? 'atual' : ''}">${esc(s.name)}</button>`).join('');
  $('#btn-voltar').disabled = !hist.back.length && !focusId;
  $('#btn-avancar').disabled = !hist.fwd.length;
  document.body.classList.toggle('em-foco', !!focusId);
}
$('#trilha-segs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) navigate(b.dataset.id || null);
});

// ---------------- rótulos presos aos pontos do DNA ----------------
let labelsDirty = true;
function dnaText(n) {
  if (n.type === 'more') return 'MAIS ITENS · clique para carregar';
  if (n.type === 'dir') return `DIR · ${nf(n.children)} ${n.children === 1 ? 'item' : 'itens'}${n.mtime ? ' · ' + fmtDate(n.mtime) : ''}`;
  const e = ext(n.name);
  return `${SIGLA[n.kind] || 'ARQ'}${e ? ' .' + e.toUpperCase() : ''} · ${fmtSize(n.size)}${n.mtime ? ' · ' + fmtDate(n.mtime) : ''}`;
}
function ensureDnaLabel(n) {
  if (n.__dna || !n.__obj) return;
  const el = document.createElement('div');
  el.className = 'dna';
  el.style.setProperty('--c', COLORS[n.kind] || COLORS.outro);
  el.innerHTML = `<div class="dna-in"><b>${esc(n.name)}</b><span>${esc(dnaText(n))}</span></div>`;
  const o = new CSS2DObject(el);
  o.visible = false;
  n.__obj.add(o);
  n.__dna = o;
}
function dropDnaLabel(n) {
  if (!n?.__dna) return;
  n.__dna.parent?.remove(n.__dna);
  n.__dna.element.remove();
  n.__dna = null;
  n.__dnaW = 0;
}

const _p = new THREE.Vector3();
function layoutDnaLabels() {
  if (!focusId || !helixIds.size) return;
  const cam = graph.camera();
  const W = window.innerWidth, H = window.innerHeight;
  const axis = _p.copy(helix.origin).project(cam);
  const axisX = (axis.x + 1) / 2 * W;
  const list = [];
  for (const id of helixIds) {
    const n = nodes.get(id);
    if (!n || !n.__obj) continue;
    ensureDnaLabel(n);
    if (!n.__dna) continue;
    _v.set(n.x || 0, n.y || 0, n.z || 0);
    const d = _v.distanceTo(cam.position);
    _v.project(cam);
    list.push({ n, d, sx: (_v.x + 1) / 2 * W, sy: (1 - _v.y) / 2 * H, front: _v.z < 1 });
  }
  list.sort((a, b) => a.d - b.d);
  const placed = [];
  const MAX = 26;
  const dmin = list.length ? list[0].d : 1;
  let shown = 0;
  for (const it of list) {
    const { n } = it;
    const esq = it.sx < axisX;
    const w = n.__dnaW || 190, h = 36;
    const r = esq ? [it.sx - 14 - w, it.sy - h / 2, it.sx - 14, it.sy + h / 2] : [it.sx + 14, it.sy - h / 2, it.sx + 14 + w, it.sy + h / 2];
    const onScreen = it.front && it.sx > -40 && it.sx < W + 40 && it.sy > -20 && it.sy < H + 20;
    const forced = n === hovered || n === spotlight;
    const free = !placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]);
    const vis = onScreen && (forced || (shown < MAX && free));
    n.__dna.visible = vis;
    if (!vis) continue;
    placed.push(r);
    shown++;
    const el = n.__dna.element;
    el.classList.toggle('esq', esq);
    el.classList.toggle('forte', forced);
    el.style.opacity = forced ? '1' : clamp(1.25 - (it.d - dmin) / 260, 0.45, 1).toFixed(2);
    if (!n.__dnaW) requestAnimationFrame(() => { if (n.__dna) n.__dnaW = n.__dna.element.firstChild.offsetWidth || 190; });
  }
  // os rótulos comuns das subpastas na hélice somem (o rótulo do DNA já diz tudo)
}

// ---------------- clique / duplo clique ----------------
let clickTimer = null, lastClick = null;
graph.onNodeClick((n) => {
  if (clickTimer && lastClick === n.id) {
    clearTimeout(clickTimer);
    clickTimer = null;
    onDouble(n);
    return;
  }
  clearTimeout(clickTimer);
  lastClick = n.id;
  clickTimer = setTimeout(() => { clickTimer = null; onSingle(n); }, 260);
});

function onSingle(n) {
  if (n.type === 'brain') goBrain();
  else if (n.type === 'dir' || n.type === 'group') {
    if (focusId === n.id) { // clicar de novo na pasta em foco: recolhe e volta um nível
      navigate(parentFocusOf(n.id));
      collapse(n);
    } else navigate(n.id);
  } else if (n.type === 'more') loadMore(n);
  else selectFile(n);
}
function onDouble(n) {
  if (n.type === 'brain') goBrain();
  else if (n.type === 'dir' || n.type === 'group') { if (focusId !== n.id) navigate(n.id); else flyToHelix(); }
  else if (n.type === 'more') loadMore(n);
  else openVisor(n);
}
function selectFile(n) {
  spotlight = n;
  flyTo(n);
}

// =====================================================================
// CARD HUD DE HOVER
// =====================================================================
const pop = $('#popup');
const guia = $('#guia');
const mouse = { x: 0, y: 0 };
let popNode = null, hideTimer = null, popToken = 0, overPop = false;
const textCache = new Map();
const listCache = new Map();
const statsCache = new Map();

document.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
pop.addEventListener('mouseenter', () => { overPop = true; clearTimeout(hideTimer); });
pop.addEventListener('mouseleave', () => { overPop = false; scheduleHide(); });

let popAnchor = { x: 0, y: 0 };
function placePopup() {
  const pad = 16, w = pop.offsetWidth, h = pop.offsetHeight;
  let x = mouse.x + 64, y = mouse.y - 46;
  if (x + w > window.innerWidth - pad) x = mouse.x - w - 64;
  if (y + h > window.innerHeight - pad) y = window.innerHeight - h - pad;
  x = Math.max(pad, x); y = Math.max(pad + 60, y);
  pop.style.transform = `translate(${x}px, ${y}px)`;
  popAnchor = { x, y };
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (overPop) return;
    hidePopup();
  }, 380);
}
function hidePopup() {
  pop.classList.remove('on');
  guia.classList.remove('on');
  pop.querySelectorAll('video,audio').forEach((m) => { m.pause(); m.removeAttribute('src'); m.load(); });
  popNode = null;
}

function hint(n) {
  if (n.type === 'brain') return '<kbd>clique</kbd> voltar ao cérebro';
  if (n.type === 'dir' || n.type === 'group') return focusId === n.id ? '<kbd>clique</kbd> recolher e voltar · <kbd>Q</kbd> voltar' : '<kbd>clique</kbd> focar · <kbd>2×</kbd> entrar';
  if (n.type === 'more') return '<kbd>clique</kbd> carregar o resto';
  return '<kbd>clique</kbd> aproximar · <kbd>2×</kbd> visualizar';
}

function crumbs(p) {
  const segs = p ? p.split('/') : [];
  const shown = segs.length > 4 ? ['…', ...segs.slice(-4)] : segs;
  return `<span class="raiz">~</span>${shown.map((s, i) => `<i>/</i>${i === shown.length - 1 ? `<b>${esc(s)}</b>` : esc(s)}`).join('')}`;
}
function meter(label, v, text) {
  return `<div class="medidor"><span>${label}</span><div class="barra"><i style="--v:${clamp(v, 0.02, 1).toFixed(3)}"></i></div><em>${esc(text)}</em></div>`;
}
function kindChart(kinds, total, amostra) {
  const entries = Object.entries(kinds).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '<p class="vazio">pasta vazia</p>';
  const sum = entries.reduce((s, [, c]) => s + c, 0);
  const max = entries[0][1];
  return `<div class="grafico">
    <div class="pilha">${entries.map(([k, c]) => `<i style="--c:${COLORS[k] || COLORS.outro};flex:${c}"></i>`).join('')}</div>
    <ul>${entries.slice(0, 6).map(([k, c]) => `<li style="--c:${COLORS[k] || COLORS.outro}"><span class="dot"></span><span class="k">${esc(SIGLA[k] || k)}</span><span class="b"><i style="--v:${(c / max).toFixed(3)}"></i></span><em>${nf(c)}</em><small>${Math.round((c / sum) * 100)}%</small></li>`).join('')}</ul>
    ${amostra ? `<p class="nota">amostra de ${nf(sum)} de ${nf(total)}</p>` : ''}
  </div>`;
}

function showPopup(n) {
  clearTimeout(hideTimer);
  if (popNode === n && pop.classList.contains('on')) return;
  popNode = n;
  const token = ++popToken;
  const color = n.type === 'brain' ? '#3fe3ff' : COLORS[n.kind] || COLORS.outro;
  const kindLabel = n.type === 'brain' ? 'Cérebro' : n.type === 'more' ? 'Mais itens' : n.type === 'group' ? 'Grupo' : LABELS[n.kind] || 'Arquivo';
  const e = ext(n.name || '');
  const q = n.path ? enc(n.path) : '';
  const meta = [];
  let meters = '';
  let body = '';

  if (n.type === 'file') {
    meta.push(['TIPO', `${SIGLA[n.kind] || 'ARQ'}${e ? ' · .' + e : ''}`], ['TAM', fmtSize(n.size)], ['MOD', fmtDate(n.mtime) || '—'], ['NÍVEL', String(n.depth)]);
    const irmaos = [...nodes.values()].filter((x) => x.parent === n.parent && x.type === 'file');
    const maior = Math.max(1, ...irmaos.map((x) => x.size || 0));
    meters = meter('TAMANHO', (n.size || 0) / maior, `${Math.round(((n.size || 0) / maior) * 100)}% do maior`)
      + meter('ESCALA', Math.log10((n.size || 0) + 1) / 10, fmtSize(n.size));
    if (n.kind === 'imagem') body = `<div class="media"><img alt="" src="/api/thumb?path=${q}" onerror="this.parentNode.innerHTML='<p class=vazio>sem miniatura</p>'"></div>`;
    else if (n.kind === 'video') body = `<div class="media"><video muted autoplay loop playsinline preload="auto" poster="/api/thumb?path=${q}" src="/api/media?path=${q}"></video></div>`;
    else if (n.kind === 'audio') body = `<div class="media audio"><img alt="" src="/api/thumb?path=${q}" onerror="this.remove()"><div class="disco"></div><audio controls preload="none" src="/api/media?path=${q}"></audio></div>`;
    else if (e === 'pdf') body = `<div class="media pdf"><img alt="" src="/api/thumb?path=${q}" onerror="this.parentNode.innerHTML='<p class=vazio>sem prévia do PDF</p>'"></div>`;
    else if (TEXT_EXT.has(e) || (n.kind === 'outro' && n.size < 262144)) body = '<pre class="txt carregando-txt">lendo…</pre>';
    else body = '<p class="vazio">sem prévia para este tipo</p>';
  } else if (n.type === 'dir' || n.type === 'group') {
    meta.push(['ITENS', nf(n.children)], ['MOD', fmtDate(n.mtime) || '—'], ['NÍVEL', String(n.depth)], ['ESTADO', focusId === n.id ? 'EM FOCO' : n.expanded ? 'ABERTA' : 'FECHADA']);
    meters = meter('ITENS', Math.log10((n.children || 0) + 1) / 3, `${nf(n.children)}`) + '<div class="medidor-bytes"></div>';
    body = '<div class="hud-grafico"><p class="vazio">analisando…</p></div><ul class="filhos"></ul>';
  } else if (n.type === 'brain') {
    const top = [...nodes.values()].filter((x) => x.depth === 1).length;
    meta.push(['HOST', info.hostname], ['USUÁRIO', info.user || '—'], ['FOCO', focusId ? (nodes.get(focusId)?.name || '—') : 'CÉREBRO']);
    body = `<div class="brain-info"><div><b>${top}</b><span>linhas neurais</span></div><div><b>${nf(nodes.size)}</b><span>neurônios</span></div><div><b>${nf(links.length)}</b><span>fios</span></div></div>`;
  } else if (n.type === 'more') {
    meta.push(['RESTAM', n.name.replace(/^\+| mais$/g, '')]);
  }

  const where = n.type === 'brain' ? (info.home || '~') : n.path;
  pop.style.setProperty('--c', color);
  pop.innerHTML = `
    <i class="canto tl"></i><i class="canto tr"></i><i class="canto bl"></i><i class="canto br"></i>
    <div class="hud-in">
      <div class="scan" aria-hidden="true"></div>
      <div class="pop-head"><span class="dot"></span><span class="tipo">${esc(kindLabel)}</span><span class="hud-id">ID ${hexId(n.id || 'x')}</span></div>
      <h3>${esc(n.type === 'brain' ? info.hostname : n.name)}</h3>
      ${n.type === 'brain' ? `<div class="onde mono">${esc(where)}</div>` : n.path ? `<div class="onde mono" title="~/${esc(where)}">${crumbs(where)}</div>` : ''}
      ${meta.length ? `<dl class="hud-meta">${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      ${meters}
      ${body}
      <div class="dica">${hint(n)}</div>
    </div>`;
  pop.classList.remove('entra');
  void pop.offsetWidth; // reinicia a animação de entrada
  pop.classList.add('on', 'entra');
  placePopup();
  guia.classList.add('on');
  pop.querySelectorAll('img').forEach((i) => i.addEventListener('load', placePopup));
  pop.querySelector('video')?.addEventListener('loadeddata', placePopup);

  const pre = pop.querySelector('pre.txt');
  if (pre) {
    const fill = (d) => {
      if (token !== popToken) return;
      pre.classList.remove('carregando-txt');
      if (d.binary) pre.outerHTML = '<p class="vazio">arquivo binário, sem prévia</p>';
      else pre.textContent = (d.text || '(vazio)') + (d.truncated ? '\n…' : '');
      placePopup();
    };
    if (textCache.has(n.path)) fill(textCache.get(n.path));
    else api(`/api/text?path=${q}`).then((d) => { textCache.set(n.path, d); fill(d); }).catch(() => fill({ text: '(não foi possível ler)' }));
  }
  const graf = pop.querySelector('.hud-grafico');
  if (graf) {
    const ul = pop.querySelector('ul.filhos');
    const fillStats = (s) => {
      if (token !== popToken) return;
      graf.innerHTML = kindChart(s.kinds, s.total, s.amostra);
      const mb = pop.querySelector('.medidor-bytes');
      if (mb && s.bytes != null) mb.outerHTML = meter('VOLUME', Math.log10(s.bytes + 1) / 11, fmtSize(s.bytes));
      placePopup();
    };
    const fillList = (items, total) => {
      if (token !== popToken) return;
      ul.innerHTML = items.slice(0, 5).map((it) => `<li style="--c:${COLORS[it.kind] || COLORS.outro}"><span class="dot"></span>${esc(it.name)}</li>`).join('')
        + (total > 5 ? `<li class="vazio">+ ${nf(total - 5)} itens</li>` : '');
      placePopup();
    };
    if (n.type === 'group') {
      const kinds = {};
      let bytes = 0;
      for (const it of n.pending) { kinds[it.kind] = (kinds[it.kind] || 0) + 1; bytes += it.size || 0; }
      fillStats({ kinds, total: n.pending.length, bytes });
      fillList(n.pending, n.pending.length);
    } else {
      if (statsCache.has(n.path)) fillStats(statsCache.get(n.path));
      else api(`/api/stats?path=${q}`).then((s) => { statsCache.set(n.path, s); fillStats(s); }).catch(() => fillStats({ kinds: {}, total: 0 }));
      if (listCache.has(n.path)) fillList(...listCache.get(n.path));
      else api(`/api/list?path=${q}&limit=5`).then((d) => { listCache.set(n.path, [d.items, d.total]); fillList(d.items, d.total); }).catch(() => fillList([], 0));
    }
  }
}

// linha-guia: do nó até o card, com retícula no nó
function updateGuide() {
  if (!pop.classList.contains('on') || !popNode || popNode.x == null) { guia.classList.remove('on'); return; }
  const c = graph.graph2ScreenCoords(popNode.x, popNode.y || 0, popNode.z || 0);
  const w = pop.offsetWidth;
  const left = c.x < popAnchor.x + w / 2;
  const ax = left ? popAnchor.x : popAnchor.x + w;
  const ay = popAnchor.y + 26;
  const ex = ax + (left ? -22 : 22);
  guia.querySelector('polyline').setAttribute('points', `${c.x.toFixed(1)},${c.y.toFixed(1)} ${ex.toFixed(1)},${ay.toFixed(1)} ${ax.toFixed(1)},${ay.toFixed(1)}`);
  const ret = guia.querySelector('.ret');
  ret.setAttribute('transform', `translate(${c.x.toFixed(1)} ${c.y.toFixed(1)})`);
  guia.style.setProperty('--c', pop.style.getPropertyValue('--c'));
  guia.classList.add('on');
}

graph.onNodeHover((n) => {
  container.style.cursor = n ? 'pointer' : '';
  if (hovered && hovered.__obj) hovered.__obj.scale.setScalar(hovered.__obj.userData.base * sizeFactor);
  hovered = n;
  if (n) showPopup(n);
  else scheduleHide();
});
graph.onBackgroundClick(() => { hidePopup(); spotlight = null; });

// =====================================================================
// VISOR GRANDE (duplo clique num arquivo)
// =====================================================================
const visor = $('#visor');
let visorNode = null, pdfState = null;
function openVisor(n) {
  visorNode = n;
  const q = enc(n.path);
  const e = ext(n.name);
  const color = COLORS[n.kind] || COLORS.outro;
  visor.style.setProperty('--c', color);
  $('#visor-tipo').textContent = `${LABELS[n.kind] || 'Arquivo'}${e ? ' · .' + e : ''}`;
  $('#visor-titulo').textContent = n.name;
  $('#visor-meta').innerHTML = [['CAMINHO', '~/' + n.path], ['TAM', fmtSize(n.size)], ['MOD', fmtDate(n.mtime)]]
    .map(([k, v]) => `<span><b>${k}</b> ${esc(v)}</span>`).join('');
  const corpo = $('#visor-corpo');
  pdfState = null;
  if (n.kind === 'imagem') {
    corpo.innerHTML = `<img class="v-img" alt="${esc(n.name)}" src="/api/media?path=${q}">`;
    corpo.querySelector('img').addEventListener('error', function onErr() { // formatos que o navegador não lê (HEIC, TIFF…): usa a miniatura
      this.removeEventListener('error', onErr);
      this.src = `/api/thumb?path=${q}`;
    });
  } else if (n.kind === 'video') {
    corpo.innerHTML = `<video class="v-video" controls autoplay playsinline src="/api/media?path=${q}"></video>`;
  } else if (n.kind === 'audio') {
    corpo.innerHTML = `<div class="v-audio"><img alt="" src="/api/thumb?path=${q}" onerror="this.remove()"><div class="disco grande"></div><audio controls autoplay src="/api/media?path=${q}"></audio></div>`;
  } else if (e === 'pdf') {
    pdfState = { page: 1, pages: 1 };
    corpo.innerHTML = `<div class="v-pdf"><div class="pdf-nav"><button id="pdf-ant" aria-label="Página anterior">‹</button><span id="pdf-pag" class="mono">1 / …</span><button id="pdf-prox" aria-label="Próxima página">›</button></div><img id="pdf-img" alt="Página do PDF" src="/api/pdfpage?path=${q}&page=1"></div>`;
    api(`/api/pdfinfo?path=${q}`).then((d) => { if (visorNode === n && pdfState) { pdfState.pages = d.pages; showPdfPage(); } }).catch(() => {});
    $('#pdf-ant').addEventListener('click', () => { if (pdfState.page > 1) { pdfState.page--; showPdfPage(); } });
    $('#pdf-prox').addEventListener('click', () => { if (pdfState.page < pdfState.pages) { pdfState.page++; showPdfPage(); } });
  } else if (TEXT_EXT.has(e) || (n.kind === 'outro' && n.size < 262144)) {
    corpo.innerHTML = '<pre class="v-txt">lendo…</pre>';
    api(`/api/text?path=${q}&full=1`).then((d) => {
      if (visorNode !== n) return;
      const pre = corpo.querySelector('pre');
      if (d.binary) pre.outerHTML = '<p class="vazio">arquivo binário, sem visualização</p>';
      else pre.textContent = (d.text || '(vazio)') + (d.truncated ? '\n\n… (arquivo grande: mostrando os primeiros 512 KB)' : '');
    }).catch(() => { corpo.querySelector('pre').textContent = '(não foi possível ler)'; });
  } else {
    corpo.innerHTML = '<div class="v-nada"><p>Sem visualização para este tipo de arquivo.</p><p class="vazio">Use o botão acima para abrir no aplicativo padrão.</p></div>';
  }
  visor.hidden = false;
  requestAnimationFrame(() => visor.classList.add('on'));
  $('#visor-fechar').focus();
}
function showPdfPage() {
  if (!pdfState || !visorNode) return;
  $('#pdf-pag').textContent = `${pdfState.page} / ${pdfState.pages}`;
  $('#pdf-img').src = `/api/pdfpage?path=${enc(visorNode.path)}&page=${pdfState.page}`;
  $('#pdf-ant').disabled = pdfState.page <= 1;
  $('#pdf-prox').disabled = pdfState.page >= pdfState.pages;
}
function closeVisor() {
  if (visor.hidden) return;
  visor.querySelectorAll('video,audio').forEach((m) => { m.pause(); m.removeAttribute('src'); m.load(); });
  visor.classList.remove('on');
  visor.hidden = true;
  $('#visor-corpo').innerHTML = '';
  visorNode = null;
}
$('#visor-fechar').addEventListener('click', closeVisor);
$('#visor-fundo').addEventListener('click', closeVisor);
$('#visor-abrir').addEventListener('click', () => { if (visorNode) openOnDesktop(visorNode); });

// =====================================================================
// PAINEL DE CONTROLE (inferior esquerdo, recolhível)
// =====================================================================
const painel = $('#painel');
function setPainel(aberto, lembrar = true) {
  painel.classList.toggle('recolhido', !aberto);
  $('#painel-abrir').setAttribute('aria-expanded', String(aberto));
  $('#painel-recolher').setAttribute('aria-expanded', String(aberto));
  $('#painel-corpo').inert = !aberto;
  if (lembrar) store.set('cerebro.painel', aberto ? 'aberto' : 'recolhido');
}
setPainel(store.get('cerebro.painel') !== 'recolhido', false);
$('#painel-recolher').addEventListener('click', () => setPainel(false));
$('#painel-abrir').addEventListener('click', () => setPainel(true));

// ---------------- busca ----------------
const input = $('#busca');
const results = $('#resultados');
let searchTimer = null, searchToken = 0;

input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = input.value.trim();
  if (q.length < 2) { searchToken++; results.classList.remove('on'); return; } // invalida buscas ainda em voo
  searchTimer = setTimeout(() => doSearch(q), 220);
});
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.busca')) results.classList.remove('on'); });
input.addEventListener('focus', () => { if (input.value.trim().length >= 2 && results.innerHTML) results.classList.add('on'); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { input.value = ''; results.classList.remove('on'); input.blur(); }
  if (e.key === 'Enter') results.querySelector('button')?.click();
});

async function doSearch(q) {
  const token = ++searchToken;
  if (input.value.trim() !== q) return;
  const ql = q.toLocaleLowerCase('pt-BR');
  const local = [...nodes.values()].filter((n) => n.path && n.name.toLocaleLowerCase('pt-BR').includes(ql)).slice(0, 12)
    .map((n) => ({ name: n.name, path: n.path, kind: n.kind, type: n.type }));
  render(local, true);
  let remote = [];
  try { remote = (await api(`/api/search?q=${enc(q)}`)).results; } catch { /* ignora */ }
  if (token !== searchToken) return;
  const seen = new Set(local.map((r) => r.path));
  render([...local, ...remote.filter((r) => !seen.has(r.path))].slice(0, 30), false);

  function render(list, pending) {
    if (token !== searchToken) return;
    results.innerHTML = list.length
      ? list.map((r) => `<button data-path="${esc(r.path)}" style="--c:${COLORS[r.kind] || COLORS.outro}"><span class="dot"></span><b>${esc(r.name)}</b><small>~/${esc(r.path)}</small></button>`).join('')
      : `<p class="vazio">${pending ? 'procurando…' : 'nada encontrado'}</p>`;
    results.classList.add('on');
  }
}

results.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  results.classList.remove('on');
  input.blur();
  await reveal(b.dataset.path);
});

// busca: pasta → entra nela; arquivo → entra na pasta dele e destaca o ponto no DNA
async function reveal(p) {
  const target = await ensurePath(p);
  if (!target) { toast('Não achei esse item no grafo (talvez esteja oculto).'); return; }
  if (target.type === 'dir') {
    await navigate(target.id);
    flash(target);
    return;
  }
  await navigate(target.parent === '#brain' ? null : target.parent);
  setTimeout(() => {
    if (!nodes.has(target.id)) return;
    spotlight = target;
    flyTo(target, 1300);
    flash(target);
  }, reduced ? 0 : 1500);
}

function flash(n) {
  const o = n.__obj;
  if (!o) return;
  const t0 = performance.now();
  const step = (t) => {
    const k = (t - t0) / 1600;
    if (k > 1 || !n.__obj) { o.scale.setScalar(o.userData.base * sizeFactor); return; }
    o.scale.setScalar(o.userData.base * sizeFactor * (1 + 1.2 * Math.sin(k * Math.PI * 4) ** 2 * (1 - k)));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------- controles ----------------
$('#btn-home').addEventListener('click', () => goBrain());
$('#btn-voltar').addEventListener('click', () => goBack());
$('#btn-avancar').addEventListener('click', () => goForward());
$('#zoom-mais').addEventListener('click', () => zoom(0.75));
$('#zoom-menos').addEventListener('click', () => zoom(1.33));
$('#nos-mais').addEventListener('click', () => resize(1.2));
$('#nos-menos').addEventListener('click', () => resize(1 / 1.2));

// ---------------- atalhos de teclado ----------------
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!visor.hidden) { // o visor fica com o teclado (Espaço pausa o vídeo etc.); Esc fecha
    if (e.key === 'Escape') { e.preventDefault(); closeVisor(); }
    return;
  }
  const t = e.target;
  const digitando = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (digitando) return;
  const k = e.key.toLowerCase();
  if (e.key === '/') {
    e.preventDefault();
    if (painel.classList.contains('recolhido')) setPainel(true);
    input.focus();
  } else if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    if (t && t.tagName === 'BUTTON') t.blur();
    if (!e.repeat) goBrain();
  } else if (k === 'q') {
    if (!e.repeat) goBack();
  } else if (k === 'e') {
    if (!e.repeat) goForward();
  } else if (e.key === 'Escape') {
    hidePopup();
    spotlight = null;
  }
});

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

$('#legenda').innerHTML = Object.entries(LABELS)
  .map(([k, v]) => `<li style="--c:${COLORS[k]}"><span class="dot"></span>${v}</li>`).join('');

window.addEventListener('resize', () => {
  graph.width(window.innerWidth).height(window.innerHeight);
  bloom.setSize(window.innerWidth, window.innerHeight);
});

// ---------------- animação ----------------
const clock = new THREE.Clock();
let frame = 0, lastT = 0;
function animate() {
  const t = clock.getElapsedTime();
  const rawDt = Math.min(0.5, t - lastT); // esmaecimento segue o relógio mesmo com poucos quadros
  const dt = Math.min(0.1, rawDt);
  lastT = t;
  const now = performance.now();

  // esmaecimento suave do resto quando há foco
  const prevDim = dimK;
  dimK += (dimTarget - dimK) * (reduced ? 1 : Math.min(1, rawDt * 3.2));
  if (Math.abs(dimTarget - dimK) < 0.002) dimK = dimTarget;
  const fade = 1 - 0.82 * dimK;

  // hélice: gira devagar (pausa com arquivo em destaque)
  if (helix.group) {
    helix.alpha = Math.min(1, helix.alpha + (reduced ? 1 : rawDt * 1.6));
    if (spinOn && !spotlight) helix.spin += dt * 0.11;
    helix.group.rotation.y = helix.spin;
    helix.group.updateMatrixWorld(true);
    for (const m of helix.mats) m.opacity = m.userData.base * helix.alpha * (reduced ? 1 : 0.85 + 0.15 * Math.sin(t * 2.4));
    if (!reduced) updatePulses(t);
  }
  for (let i = dying.length - 1; i >= 0; i--) {
    const d = dying[i];
    d.alpha -= rawDt * 2.5;
    if (d.alpha <= 0) { disposeGroup(d.group); dying.splice(i, 1); continue; }
    for (const m of d.mats) m.opacity = m.userData.base * d.alpha;
  }

  // posições fixadas: hélice, pasta em foco e volta para casa
  for (const [id, p] of pins) {
    const n = nodes.get(id);
    if (!n) { pins.delete(id); continue; }
    if (p.mode === 'helix') {
      if (!helix.group) continue;
      _v.copy(p.local).applyMatrix4(helix.group.matrixWorld);
    } else _v.set(p.to.x, p.to.y, p.to.z);
    const k = p.dur ? ease(clamp((now - p.t0) / p.dur, 0, 1)) : 1;
    const x = p.from.x + (_v.x - p.from.x) * k, y = p.from.y + (_v.y - p.from.y) * k, z = p.from.z + (_v.z - p.from.z) * k;
    n.fx = n.x = x; n.fy = n.y = y; n.fz = n.z = z;
    n.__obj?.position.set(x, y, z);
    if (p.mode === 'home' && k >= 1) {
      delete n.fx; delete n.fy; delete n.fz;
      n.vx = n.vy = n.vz = 0;
      pins.delete(id);
      homes.delete(id);
    }
  }
  if (needReheat && ![...pins.values()].some((p) => p.mode === 'home')) { needReheat = false; graph.d3ReheatSimulation(); }

  if (brainParts.g) {
    holoMat.uniforms.uFade.value = fade;
    brainParts.pts.material.opacity = 0.6 * fade;
    brainParts.shell.material.opacity = 0.05 * fade;
    brainParts.stem.material.opacity = 0.35 * fade;
    brainParts.el.style.opacity = (0.35 + 0.65 * fade).toFixed(2);
  }
  if (!reduced) {
    if (brainParts.g) {
      const beat = 1 + 0.025 * Math.sin(t * 2.2) + 0.02 * Math.max(0, Math.sin(t * 4.4)) ** 8;
      brainParts.cortex.scale.setScalar(beat);
      brainParts.cortex.rotation.z = Math.sin(t * 0.15) * 0.35;
      brainParts.shell.rotation.y = -t * 0.05;
      brainParts.shell.rotation.x = t * 0.03;
      brainParts.core.material.opacity = (0.15 + 0.2 * (0.5 + 0.5 * Math.sin(t * 2.2))) * fade;
      brainParts.halo.material.opacity = (0.08 + 0.06 * (0.5 + 0.5 * Math.sin(t * 2.2))) * fade;
      holoMat.uniforms.uTime.value = t;
    }
    if (hovered?.__obj) hovered.__obj.scale.setScalar(hovered.__obj.userData.base * sizeFactor * (1.45 + 0.12 * Math.sin(t * 8)));
  } else if (brainParts.g) {
    brainParts.core.material.opacity = 0.3 * fade;
    brainParts.halo.material.opacity = 0.12 * fade;
  }
  // opacidade dos materiais: acesos pulsam, esmaecidos seguem o foco
  const dimOp = 1 - 0.9 * dimK;
  bloom.strength = (reduced ? 0.7 : 1.0) * (1 - 0.3 * dimK);
  for (const m of matCache.values()) {
    const u = m.userData;
    if (u.dim) m.opacity = u.base * (u.line ? 1 - 0.8 * dimK : dimOp) * (u.line === 'neural' ? 0.9 : 1);
    else if (!reduced && u.line === 'neural') m.opacity = 0.28 + 0.12 * Math.sin(t * 1.3);
    else if (!reduced && u.line === 'seq') m.opacity = 0.42 + 0.22 * Math.sin(t * 2.4);
    else if (!reduced && u.line === 'tree') m.opacity = 0.16 + 0.08 * Math.sin(t * 0.9);
  }
  if (prevDim !== dimK && dimK === 0 && !focusId) applyVisuals();

  frame++;
  if (frame % 12 === 0) applyVisuals(); // objetos recém-criados pelo grafo
  if (frame % 6 === 0) fadeLabels();
  if (focusId && (frame % 2 === 0 || labelsDirty)) { labelsDirty = false; layoutDnaLabels(); }
  updateGuide();
  requestAnimationFrame(animate);
}

// rótulos esmaecem com a distância e com o foco
function fadeLabels() {
  const cam = graph.camera().position;
  for (const n of nodes.values()) {
    const el = n.__label?.element;
    if (!el) continue;
    if (helixIds.has(n.id)) { el.style.visibility = 'hidden'; continue; } // na hélice vale o rótulo do DNA
    const d = Math.hypot(cam.x - (n.x || 0), cam.y - (n.y || 0), cam.z - (n.z || 0));
    let o = n.depth === 1 ? (XDG.has(n.name) ? 1 : Math.min(1, Math.max(0.5, 1.25 - d / 1100))) : Math.min(1, Math.max(0, 1.35 - d / 420));
    if (n.__dimmed) o *= 1 - 0.85 * dimK;
    if (n.id === focusId) o = 1;
    if (n === hovered) o = 1;
    el.classList.toggle('foco', n.id === focusId);
    el.style.opacity = o.toFixed(2);
    el.style.visibility = o < 0.04 ? 'hidden' : '';
  }
}

// ---------------- início ----------------
async function boot() {
  if (reduced) document.body.classList.add('reduzido');
  try { info = await api('/api/info'); } catch { /* segue com padrão */ }
  $('#host').textContent = info.hostname;
  document.title = `Cérebro Babel · ${info.hostname}`;
  const brain = { id: '#brain', type: 'brain', kind: 'pasta', name: info.hostname, path: '', depth: 0, fx: 0, fy: 0, fz: 0, expanded: true };
  nodes.set(brain.id, brain);
  graph.cameraPosition({ x: 0, y: 260, z: 1500 }, { x: 0, y: 0, z: 0 }, 0);
  refresh();
  await loadPage(brain);
  const s = nodes.get('#soltos');
  if (s) s.__label?.element && (s.__label.element.innerHTML = `Arquivos soltos<i>${s.pending.length}</i>`);
  refresh();
  flyHome(reduced ? 0 : 2600);
  updateTrail();
  setTimeout(() => document.body.classList.add('pronto'), reduced ? 0 : 400);
  animate();
  // ganchos para os testes
  window.__cerebro = {
    nodes, graph, reveal, toggle, flyTo, showPopup, navigate, goBack, goForward, goBrain, openVisor, closeVisor, flyToHelix,
    setSpin: (v) => { spinOn = !!v; },
    clearHistory: () => { hist.back.length = 0; hist.fwd.length = 0; updateTrail(); },
    state: () => ({ focusId, back: hist.back.slice(), fwd: hist.fwd.slice(), helix: [...helixIds], dimK, camBusy: performance.now() < camBusyUntil, pins: pins.size, spin: helix.spin,
      helixGeo: { origin: { x: helix.origin.x, y: helix.origin.y, z: helix.origin.z }, R: helix.R, H: helix.H, step: helix.step } }),
  };
}
boot();
