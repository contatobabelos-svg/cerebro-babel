// Cérebro Babel — servidor local (somente leitura do disco).
// Escuta apenas em 127.0.0.1. Nunca move, renomeia ou apaga arquivos do usuário.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.CEREBRO_PORT || 3077);
const HOME = fs.realpathSync(process.env.CEREBRO_HOME || os.homedir());
const CACHE = path.join(os.homedir(), '.cache', 'cerebro-babel');
const PUBLIC = path.join(__dirname, 'public');
const NO_OPEN = process.env.CEREBRO_NO_OPEN === '1'; // modo de teste: não chama xdg-open
const PAGE = 150;
const THUMB = 360;

fs.mkdirSync(CACHE, { recursive: true });

const IGNORE = new Set(['node_modules', '__pycache__', 'venv', 'site-packages', 'lost+found']);

const KINDS = {
  imagem: 'jpg jpeg png gif webp bmp svg avif heic heif tif tiff ico jfif',
  video: 'mp4 mkv webm mov avi m4v wmv flv 3gp mpg mpeg ts',
  audio: 'mp3 wav ogg oga flac m4a aac opus wma mid midi',
  documento: 'pdf doc docx odt txt md markdown rtf xls xlsx ods csv tsv ppt pptx odp epub log',
  codigo: 'js mjs cjs ts tsx jsx py go rs c h cpp hpp cc java kt rb php html htm css scss sass less json jsonc yml yaml toml sh bash zsh fish sql vue svelte lua swift xml ini conf cfg env gradle dart r pl ipynb lock',
  compactado: 'zip tar gz tgz bz2 xz 7z rar zst deb rpm iso appimage jar apk',
};
const EXT_KIND = {};
for (const [k, list] of Object.entries(KINDS)) for (const e of list.split(' ')) EXT_KIND[e] = k;
const TEXT_EXT = new Set('txt md markdown csv tsv log js mjs cjs ts tsx jsx py go rs c h cpp hpp cc java kt rb php html htm css scss sass less json jsonc yml yaml toml sh bash zsh fish sql vue svelte lua swift xml ini conf cfg env gradle dart r pl desktop service'.split(' '));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.json': 'application/json', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime', '.ogv': 'video/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.pdf': 'application/pdf',
};

function kindOf(name, isDir) {
  if (isDir) return 'pasta';
  const ext = path.extname(name).slice(1).toLowerCase();
  return EXT_KIND[ext] || 'outro';
}

// ---------- validação de caminho ----------
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function hasHiddenSegment(rel) {
  return rel.split(path.sep).some((s) => s.startsWith('.') && s !== '.');
}

// Recebe um caminho relativo à home (ou absoluto) vindo do cliente e devolve o caminho real,
// garantindo que fica dentro da home, sem segmentos ocultos e sem symlink para fora.
async function safePath(input) {
  if (typeof input !== 'string' || input.length > 4096 || input.includes('\0')) throw new HttpError(400, 'caminho inválido');
  const abs = path.resolve(HOME, input);
  const inside = (p) => p === HOME || p.startsWith(HOME + path.sep);
  if (!inside(abs)) throw new HttpError(403, 'fora da home');
  if (hasHiddenSegment(path.relative(HOME, abs))) throw new HttpError(403, 'caminho oculto');
  let real;
  try { real = await fsp.realpath(abs); } catch { throw new HttpError(404, 'não encontrado'); }
  if (!inside(real)) throw new HttpError(403, 'symlink para fora da home');
  if (hasHiddenSegment(path.relative(HOME, real))) throw new HttpError(403, 'caminho oculto');
  return real;
}
const rel = (p) => path.relative(HOME, p);

// ---------- listagem ----------
function isIgnored(name) {
  return name.startsWith('.') || IGNORE.has(name);
}

async function isVenv(dir) {
  try { await fsp.access(path.join(dir, 'pyvenv.cfg')); return true; } catch { return false; }
}

async function countChildren(dir) {
  try {
    const d = await fsp.readdir(dir);
    let n = 0;
    for (const name of d) if (!isIgnored(name)) n++;
    return n;
  } catch { return null; }
}

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

async function describe(dir, name) {
  const full = path.join(dir, name);
  let st;
  try { st = await fsp.lstat(full); } catch { return null; }
  let link = false;
  if (st.isSymbolicLink()) {
    link = true;
    let real;
    try { real = await fsp.realpath(full); } catch { return null; }
    if (!(real === HOME || real.startsWith(HOME + path.sep)) || hasHiddenSegment(rel(real))) return null; // symlink para fora/oculto: não mostra
    try { st = await fsp.stat(full); } catch { return null; }
  }
  const isDir = st.isDirectory();
  if (!isDir && !st.isFile()) return null;
  if (isDir && await isVenv(full)) return null;
  return {
    name, path: rel(full), type: isDir ? 'dir' : 'file', kind: kindOf(name, isDir),
    size: isDir ? null : st.size, mtime: st.mtimeMs, link,
    children: isDir ? await countChildren(full) : undefined,
  };
}

async function listDir(input, offset, limit) {
  const dir = await safePath(input || '');
  const st = await fsp.stat(dir);
  if (!st.isDirectory()) throw new HttpError(400, 'não é pasta');
  const names = (await fsp.readdir(dir)).filter((n) => !isIgnored(n));
  // ordena: pastas primeiro, depois arquivos, alfabético pt-BR
  const entries = await Promise.all(names.map(async (n) => {
    try { return { n, d: (await fsp.stat(path.join(dir, n))).isDirectory() }; } catch { return { n, d: false }; }
  }));
  entries.sort((a, b) => (a.d === b.d ? collator.compare(a.n, b.n) : a.d ? -1 : 1));
  const slice = entries.slice(offset, offset + limit);
  const items = (await Promise.all(slice.map((e) => describe(dir, e.n)))).filter(Boolean);
  return { path: rel(dir), name: dir === HOME ? os.hostname() : path.basename(dir), total: entries.length, offset, limit, items };
}

// ---------- busca por nome ----------
async function search(q, max = 40) {
  q = q.trim().toLocaleLowerCase('pt-BR');
  if (q.length < 2) return [];
  const out = [];
  const queue = [HOME];
  let visited = 0;
  while (queue.length && out.length < max && visited < 40000) {
    const dir = queue.shift();
    let ds;
    try { ds = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of ds) {
      if (isIgnored(d.name)) continue;
      visited++;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) queue.push(full);
      if (d.name.toLocaleLowerCase('pt-BR').includes(q)) {
        out.push({ name: d.name, path: rel(full), type: d.isDirectory() ? 'dir' : 'file', kind: kindOf(d.name, d.isDirectory()) });
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

// ---------- prévias (com cache em ~/.cache/cerebro-babel) ----------
function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
  });
}

// fila simples: no máximo 3 geradores simultâneos, sem duplicar trabalho
let active = 0;
const waiting = [];
const inflight = new Map();
function limited(fn) {
  return new Promise((resolve, reject) => {
    const go = () => { active++; fn().then(resolve, reject).finally(() => { active--; const n = waiting.shift(); if (n) n(); }); };
    if (active < 3) go(); else waiting.push(go);
  });
}

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

async function makeThumb(file, kind, st) {
  const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|${kind}|${THUMB}`).digest('hex');
  const out = path.join(CACHE, key + '.jpg');
  const none = path.join(CACHE, key + '.none');
  if (await exists(out)) return out;
  if (await exists(none)) return null;
  if (inflight.has(key)) return inflight.get(key);
  const job = limited(async () => {
    const tmp = path.join(CACHE, key + '.tmp.jpg');
    let ok = false;
    const scale = `scale='min(${THUMB},iw)':-2`;
    if (kind === 'imagem') {
      ok = await run('convert', [file + '[0]', '-auto-orient', '-thumbnail', `${THUMB}x${THUMB}>`, '-background', '#030817', '-flatten', '-quality', '82', 'jpg:' + tmp]);
    } else if (kind === 'video') {
      ok = await run('ffmpeg', ['-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', scale, '-y', tmp]) && await exists(tmp);
      if (!ok) ok = await run('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', scale, '-y', tmp]) && await exists(tmp);
    } else if (kind === 'audio') {
      ok = await run('ffmpeg', ['-v', 'error', '-i', file, '-an', '-frames:v', '1', '-vf', scale, '-y', tmp]) && await exists(tmp);
    } else if (path.extname(file).toLowerCase() === '.pdf') {
      const base = path.join(CACHE, key + '.tmp');
      ok = await run('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-jpeg', '-scale-to', String(THUMB), file, base]);
    }
    if (ok && await exists(tmp)) { await fsp.rename(tmp, out); return out; }
    await fsp.rm(tmp, { force: true });
    await fsp.writeFile(none, '');
    return null;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function readText(file, st, full = false) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(full ? 512 * 1024 : 8192, st.size));
    await fh.read(buf, 0, buf.length, 0);
    if (buf.subarray(0, 8192).includes(0)) return { binary: true };
    let text = buf.toString('utf8').replace(/�+$/, '');
    if (full) return { text, truncated: st.size > buf.length };
    const lines = text.split(/\r?\n/);
    const truncated = st.size > buf.length || lines.length > 40;
    text = lines.slice(0, 40).map((l) => (l.length > 160 ? l.slice(0, 160) + '…' : l)).join('\n');
    return { text, truncated };
  } finally { await fh.close(); }
}

// ---------- estatística de uma pasta (contagem por tipo, sem stat em tudo) ----------
async function dirStats(input) {
  const dir = await safePath(input || '');
  const ds = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => !isIgnored(d.name));
  const kinds = {};
  const files = [];
  for (const d of ds) {
    const isDir = d.isDirectory();
    const k = kindOf(d.name, isDir);
    kinds[k] = (kinds[k] || 0) + 1;
    if (!isDir) files.push(path.join(dir, d.name));
  }
  let bytes = null;
  if (files.length <= 3000) {
    bytes = 0;
    for (let i = 0; i < files.length; i += 200) {
      const sts = await Promise.all(files.slice(i, i + 200).map((f) => fsp.stat(f).catch(() => null)));
      for (const st of sts) if (st && st.isFile()) bytes += st.size;
    }
  }
  return { total: ds.length, kinds, bytes };
}

// ---------- página de PDF em tamanho grande (visor) ----------
async function pdfPages(file) {
  return new Promise((resolve) => {
    const p = spawn('pdfinfo', [file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const t = setTimeout(() => p.kill('SIGKILL'), 10000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(t); resolve(1); });
    p.on('close', () => { clearTimeout(t); const m = /Pages:\s+(\d+)/.exec(out); resolve(m ? Number(m[1]) : 1); });
  });
}

async function pdfPage(file, st, page) {
  const W = 1600;
  const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|pdfpage|${page}|${W}`).digest('hex');
  const out = path.join(CACHE, key + '.jpg');
  if (await exists(out)) return out;
  if (inflight.has(key)) return inflight.get(key);
  const job = limited(async () => {
    const base = path.join(CACHE, key + '.tmp');
    const ok = await run('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-jpeg', '-scale-to', String(W), file, base], 30000);
    if (ok && await exists(base + '.jpg')) { await fsp.rename(base + '.jpg', out); return out; }
    await fsp.rm(base + '.jpg', { force: true });
    return null;
  }).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

// ---------- abrir no desktop ----------
function openPath(p) {
  if (NO_OPEN) { console.log('[teste] abriria:', p); return; }
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [p], { detached: true, stdio: 'ignore', env });
  child.on('error', () => {});
  child.unref();
}

// ---------- HTTP ----------
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

async function sendFile(req, res, file, st, extraHeaders = {}) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', ...extraHeaders };
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && st.size > 0) {
    let start = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function readBody(req, max = 16384) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > max) { reject(new HttpError(413, 'grande demais')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  // Anti DNS-rebinding: só aceita Host local
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 421, 'host não permitido');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = url.searchParams;
  const p = url.pathname;

  if (p === '/api/info') {
    return send(res, 200, { hostname: os.hostname(), user: os.userInfo().username, home: HOME, page: PAGE });
  }
  if (p === '/api/list') {
    const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
    const limit = Math.min(500, Math.max(1, parseInt(q.get('limit') || String(PAGE), 10) || PAGE));
    return send(res, 200, await listDir(q.get('path') || '', offset, limit));
  }
  if (p === '/api/search') {
    return send(res, 200, { results: await search(q.get('q') || '') });
  }
  if (p === '/api/thumb') {
    const file = await safePath(q.get('path') || '');
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new HttpError(400, 'não é arquivo');
    const thumb = await makeThumb(file, kindOf(file, false), st);
    if (!thumb) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); } // sem prévia (204 não suja o console)
    return sendFile(req, res, thumb, await fsp.stat(thumb), { 'Cache-Control': 'private, max-age=3600' });
  }
  if (p === '/api/text') {
    const file = await safePath(q.get('path') || '');
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new HttpError(400, 'não é arquivo');
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!TEXT_EXT.has(ext) && st.size > 256 * 1024) return send(res, 200, { binary: true });
    return send(res, 200, await readText(file, st, q.get('full') === '1'));
  }
  if (p === '/api/stats') {
    return send(res, 200, await dirStats(q.get('path') || ''));
  }
  if (p === '/api/pdfinfo' || p === '/api/pdfpage') {
    const file = await safePath(q.get('path') || '');
    const st = await fsp.stat(file);
    if (!st.isFile() || path.extname(file).toLowerCase() !== '.pdf') throw new HttpError(400, 'não é PDF');
    if (p === '/api/pdfinfo') return send(res, 200, { pages: await pdfPages(file) });
    const page = Math.max(1, Math.min(9999, parseInt(q.get('page') || '1', 10) || 1));
    const img = await pdfPage(file, st, page);
    if (!img) throw new HttpError(404, 'página indisponível');
    return sendFile(req, res, img, await fsp.stat(img), { 'Cache-Control': 'private, max-age=3600' });
  }
  if (p === '/api/media') {
    const file = await safePath(q.get('path') || '');
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new HttpError(400, 'não é arquivo');
    const k = kindOf(file, false);
    if (!['imagem', 'video', 'audio'].includes(k)) throw new HttpError(415, 'tipo não suportado');
    // sandbox: um SVG aberto direto não executa script na origem do app
    return sendFile(req, res, file, st, { 'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, max-age=600' });
  }
  if (p === '/api/open') {
    if (req.method !== 'POST') throw new HttpError(405, 'use POST');
    // exige cabeçalho próprio + JSON: força preflight CORS, que nunca respondemos → sites externos não conseguem chamar
    if (req.headers['x-cerebro'] !== '1' || !(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(403, 'requisição recusada');
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, 'json inválido'); }
    const target = await safePath(body && body.path);
    openPath(target);
    return send(res, 200, { ok: true, opened: rel(target) || '~', mocked: NO_OPEN });
  }
  if (p.startsWith('/api/')) throw new HttpError(404, 'rota desconhecida');

  // estáticos
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'método não permitido');
  const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : decodeURIComponent(p)));
  if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(403, 'proibido');
  let st;
  try { st = await fsp.stat(file); } catch { throw new HttpError(404, 'não encontrado'); }
  if (!st.isFile()) throw new HttpError(404, 'não encontrado');
  return sendFile(req, res, file, st, { 'Cache-Control': 'no-cache' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const code = err instanceof HttpError ? err.code : err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500;
    if (code === 500) console.error(err);
    if (!res.headersSent) send(res, code, { error: err.message || 'erro' });
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Cérebro Babel em http://${HOST}:${PORT}  (home: ${HOME}${NO_OPEN ? ', abrir: simulado' : ''})`);
});
