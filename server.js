// Cérebro Babel — servidor local (somente leitura de um projeto Supabase).
// Escuta apenas em 127.0.0.1. O token do Supabase fica aqui e nunca vai para o navegador.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { HttpError } = require('./comum');
const assistente = require('./assistente');

const HOST = '127.0.0.1';
const PORT = Number(process.env.CEREBRO_PORT || 3077);
const PUBLIC = path.join(__dirname, 'public');
const PAGE = 150;
const fonte = process.env.CEREBRO_FONTE === 'teste' ? require('./fonte-teste') : require('./fonte-supabase');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
};

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

async function sendStatic(req, res, file, st) {
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (b) => { n += b.length; if (n > max) { reject(new HttpError(413, 'áudio grande demais')); req.destroy(); } else parts.push(b); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  // Anti DNS-rebinding: só aceita Host local
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 421, 'host não permitido');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = url.searchParams;
  const p = url.pathname;

  // única exceção ao "só GET": o áudio do botão de falar (vai para o Whisper, não toca no banco)
  if (p === '/api/ouvir') {
    if (req.method !== 'POST') throw new HttpError(405, 'use POST');
    if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'origem não permitida');
    return send(res, 200, await assistente.ouvir(await readBody(req, 8 * 1024 * 1024), String(req.headers['content-type'] || '')));
  }
  if (p.startsWith('/api/') && req.method !== 'GET') throw new HttpError(405, 'só leitura');
  if (p === '/api/perguntar') {
    // grava na memória: só a própria página pode perguntar (senão outro site plantaria "lembranças")
    if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'origem não permitida');
    return send(res, 200, await assistente.perguntar(fonte, q.get('q') || ''));
  }
  if (p === '/api/voz') return send(res, 200, await assistente.voz(q.get('texto') || ''), { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600' });
  if (p === '/api/info') return send(res, 200, { ...(await fonte.info()), page: PAGE, fonte: fonte.kind });
  if (p === '/api/list') {
    const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
    const limit = Math.min(500, Math.max(1, parseInt(q.get('limit') || String(PAGE), 10) || PAGE));
    return send(res, 200, await fonte.list(q.get('path') || '', offset, limit));
  }
  if (p === '/api/search') return send(res, 200, { results: await fonte.search(q.get('q') || '') });
  if (p === '/api/stats') return send(res, 200, await fonte.stats(q.get('path') || ''));
  if (p === '/api/text') return send(res, 200, await fonte.text(q.get('path') || '', q.get('full') === '1'));
  if (p === '/api/media') {
    const m = await fonte.media(q.get('path') || '');
    // sandbox: um SVG aberto direto não executa script na origem do app
    return send(res, 200, m.body, { 'Content-Type': m.type, 'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, max-age=600' });
  }
  if (p.startsWith('/api/')) throw new HttpError(404, 'rota desconhecida');

  // estáticos
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'método não permitido');
  const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : decodeURIComponent(p)));
  if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(403, 'proibido');
  let st;
  try { st = await fsp.stat(file); } catch { throw new HttpError(404, 'não encontrado'); }
  if (!st.isFile()) throw new HttpError(404, 'não encontrado');
  return sendStatic(req, res, file, st);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const code = err instanceof HttpError ? err.code : 500;
    if (code >= 500) console.error(err.message || err);
    if (!res.headersSent) send(res, code, { error: err.message || 'erro' });
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Cérebro Babel em http://${HOST}:${PORT}  (fonte: ${fonte.kind})`);
  assistente.mapa(fonte); // estuda a árvore já na partida, para a primeira pergunta não esperar
});
