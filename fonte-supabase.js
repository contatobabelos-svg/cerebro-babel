// Fonte de dados: um projeto Supabase lido pela Management API (a mesma API que o MCP do Supabase usa).
// Só leitura: todo SQL vai com read_only: true. O token fica no servidor e nunca vai para o navegador.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { HttpError, SECRET_RE, redact, rowLabel, rowTime, rowImage, seg, unseg, joinPath } = require('./comum');

const REF = process.env.CEREBRO_PROJECT || 'fxlansnepokjxdikxocb';
const API = `https://api.supabase.com/v1/projects/${REF}`;
const FUNCS_DIR = process.env.CEREBRO_FUNCS_DIR || path.join(os.homedir(), 'Downloads', 'Reino', 'supabase', 'functions');
const TTL = 20000;

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  try { return fs.readFileSync(path.join(os.homedir(), '.supabase', 'access-token'), 'utf8').trim(); } catch { throw new HttpError(503, 'sem token do Supabase (~/.supabase/access-token)'); }
}

// ---------- Management API com cache curto e no máximo 4 chamadas ao mesmo tempo ----------
let active = 0;
const waiting = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    const go = () => { active++; fn().then(resolve, reject).finally(() => { active--; const n = waiting.shift(); if (n) n(); }); };
    if (active < 4) go(); else waiting.push(go);
  });
}
const cache = new Map();
function cached(key, fn, ttl = TTL) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = fn();
  cache.set(key, { t: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}

async function mgmt(p, opts = {}) {
  return limited(async () => {
    let r;
    try {
      r = await fetch(API + p, { ...opts, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...opts.headers }, signal: AbortSignal.timeout(25000) });
    } catch (e) { throw new HttpError(502, `Supabase fora do ar: ${e.message}`); }
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!r.ok) {
      const msg = String((body && body.message) || text).slice(0, 300);
      if (/permission denied/i.test(msg)) throw new HttpError(403, 'o Supabase não deixa ler isto (permissão negada)');
      throw new HttpError(r.status === 404 ? 404 : 502, `Supabase ${r.status}: ${msg}`);
    }
    return body;
  });
}
const sql = (query, ttl) => cached('sql:' + query, () => mgmt('/database/query', { method: 'POST', body: JSON.stringify({ query, read_only: true }) }), ttl);
const get = (p, ttl) => cached('get:' + p, () => mgmt(p), ttl);

const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// ---------- catálogo (schemas, tabelas, views, funções, chaves) ----------
const SKIP_NS = "n.nspname not in ('pg_catalog','information_schema','pg_toast') and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast_temp%'";
const NOT_EXT = (cls, oid) => `not exists (select 1 from pg_depend d where d.classid = '${cls}'::regclass and d.objid = ${oid} and d.deptype = 'e')`;

async function catalog() {
  return cached('catalog', async () => {
    const [row] = await sql(`select json_build_object(
      'rels', (select coalesce(json_agg(json_build_object('schema', n.nspname, 'name', c.relname, 'relkind', c.relkind, 'oid', c.oid,
                 'rls', c.relrowsecurity, 'bytes', pg_total_relation_size(c.oid), 'est', c.reltuples::bigint, 'comment', obj_description(c.oid, 'pg_class'),
                 'pk', (select json_agg(a.attname order by array_position(i.indkey, a.attnum)) from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) where i.indrelid = c.oid and i.indisprimary))), '[]')
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.relkind in ('r','p','v','m') and not c.relispartition and ${SKIP_NS}),
      'funcs', (select coalesce(json_agg(json_build_object('schema', n.nspname, 'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid),
                 'oid', p.oid, 'prokind', p.prokind, 'lang', l.lanname, 'ret', pg_get_function_result(p.oid), 'secdef', p.prosecdef)), '[]')
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
               where ${SKIP_NS} and ${NOT_EXT('pg_proc', 'p.oid')}),
      'fks', (select coalesce(json_agg(json_build_object('src_schema', sn.nspname, 'src', sc.relname, 'dst_schema', dn.nspname, 'dst', dc.relname, 'name', k.conname)), '[]')
               from pg_constraint k join pg_class sc on sc.oid = k.conrelid join pg_namespace sn on sn.oid = sc.relnamespace
               join pg_class dc on dc.oid = k.confrelid join pg_namespace dn on dn.oid = dc.relnamespace where k.contype = 'f')
    ) as cat`, 30000);
    return row.cat;
  }, 30000);
}

// contagem exata de linhas (tabelas pequenas; acima de 100 mil usa a estimativa)
async function counts(schema) {
  return cached('counts:' + schema, async () => {
    const cat = await catalog();
    const rels = cat.rels.filter((r) => r.schema === schema);
    const out = {};
    for (const r of rels) out[r.name] = r.est >= 0 ? r.est : null;
    const alvo = rels.filter((r) => !(r.est > 100000));
    if (!alvo.length) return out;
    const q = alvo.map((r) => `select ${lit(r.name)} as t, (select count(*) from ${ident(schema)}.${ident(r.name)}) as c`).join(' union all ');
    try {
      for (const x of await sql(q)) out[x.t] = Number(x.c);
    } catch { // uma view sem permissão derruba a consulta toda: tenta uma por uma
      await Promise.all(alvo.map(async (r) => {
        try { out[r.name] = Number((await sql(`select count(*) as c from ${ident(schema)}.${ident(r.name)}`))[0].c); } catch { /* fica a estimativa */ }
      }));
    }
    return out;
  });
}

const relKind = (r) => (r.relkind === 'v' || r.relkind === 'm' ? 'view' : 'tabela');
const fnSeg = (f) => `${f.name}(${f.args})`;

async function schemas() {
  const cat = await catalog();
  const map = new Map();
  for (const r of cat.rels) map.set(r.schema, (map.get(r.schema) || 0) + 1);
  for (const f of cat.funcs) map.set(f.schema, (map.get(f.schema) || 0) + 1);
  return map;
}

async function findRel(schema, name) {
  const r = (await catalog()).rels.find((x) => x.schema === schema && x.name === name);
  if (!r) throw new HttpError(404, 'tabela não encontrada');
  return r;
}
async function findFn(schema, s) {
  const f = (await catalog()).funcs.find((x) => x.schema === schema && fnSeg(x) === s);
  if (!f) throw new HttpError(404, 'função não encontrada');
  return f;
}

// ---------- linhas ----------
const orderBy = (r) => (r.pk && r.pk.length ? r.pk.map(ident).join(', ') : 'j');
function rowKey(r, j, idx) {
  if (r.pk && r.pk.length) return r.pk.length === 1 ? String(j[r.pk[0]]) : JSON.stringify(r.pk.map((k) => j[k]));
  return '~' + idx;
}
async function rows(r, offset, limit) {
  return sql(`select to_jsonb(t) as j from ${ident(r.schema)}.${ident(r.name)} t order by ${orderBy(r)} limit ${limit} offset ${offset}`);
}
async function oneRow(r, key) {
  let q;
  if (key.startsWith('~')) {
    const idx = Number(key.slice(1));
    if (!Number.isInteger(idx) || idx < 0) throw new HttpError(400, 'linha inválida');
    q = `select to_jsonb(t) as j from ${ident(r.schema)}.${ident(r.name)} t order by j limit 1 offset ${idx}`;
  } else if (r.pk && r.pk.length) {
    let vals;
    if (r.pk.length === 1) vals = [key];
    else { try { vals = JSON.parse(key); } catch { throw new HttpError(400, 'linha inválida'); } }
    if (!Array.isArray(vals) || vals.length !== r.pk.length) throw new HttpError(400, 'linha inválida');
    q = `select to_jsonb(t) as j from ${ident(r.schema)}.${ident(r.name)} t where ${r.pk.map((k, i) => `${ident(k)}::text = ${lit(vals[i])}`).join(' and ')} limit 1`;
  } else throw new HttpError(404, 'linha não encontrada');
  const [x] = await sql(q);
  if (!x) throw new HttpError(404, 'linha não encontrada');
  return x.j;
}

function rowItem(base, r, j, idx) {
  const key = rowKey(r, j, idx);
  const p = base + '/' + seg(key);
  const img = rowImage(j, p);
  return { name: rowLabel(j, key), path: p, type: 'file', kind: 'linha', size: Buffer.byteLength(JSON.stringify(j)), mtime: rowTime(j), img };
}

// ---------- edge functions e storage ----------
const edgeList = () => get('/functions');
async function bucketList() {
  return sql(`select b.id, b.name, b.public, b.created_at, (select count(*) from storage.objects o where o.bucket_id = b.id) as n,
    (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o where o.bucket_id = b.id) as bytes from storage.buckets b order by b.name`);
}
async function objects(bucket) {
  return sql(`select name, metadata, created_at, updated_at from storage.objects where bucket_id = ${lit(bucket)} order by name`);
}
const isImgMime = (m) => /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/.test(m || '');
function objItem(bucket, o) {
  const p = joinPath('@buckets', bucket, o.name);
  const mime = o.metadata && o.metadata.mimetype;
  return { name: o.name, path: p, type: 'file', kind: 'objeto', size: o.metadata ? Number(o.metadata.size) || 0 : 0,
    mtime: Date.parse(o.updated_at || o.created_at) || null, mime, img: isImgMime(mime) ? `/api/media?path=${encodeURIComponent(p)}` : undefined };
}

let serviceKey = null;
async function storageKey() {
  if (serviceKey) return serviceKey;
  const keys = await mgmt('/api-keys?reveal=true');
  const k = keys.find((x) => x.name === 'service_role') || keys.find((x) => x.type === 'secret');
  if (!k || !k.api_key) throw new HttpError(502, 'sem chave para ler o storage');
  serviceKey = k.api_key;
  return serviceKey;
}

// ---------- API pública da fonte ----------
function parse(p) {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) throw new HttpError(400, 'caminho inválido');
  return p ? p.split('/').map(unseg) : [];
}

async function info() {
  const proj = await get('/', 300000).catch(() => ({ name: 'Supabase', region: '' }));
  const cat = await catalog().catch(() => ({ fks: [] }));
  return {
    hostname: proj.name || REF, user: proj.region || '', home: REF, ref: REF, region: proj.region || '',
    dashboard: `https://supabase.com/dashboard/project/${REF}`,
    fks: cat.fks.map((f) => ({ src: joinPath(f.src_schema, f.src), dst: joinPath(f.dst_schema, f.dst), name: f.name })),
  };
}

async function list(p, offset, limit) {
  const s = parse(p);
  if (s.length === 0) {
    const sch = await schemas();
    const names = [...sch.keys()].sort((a, b) => (a === 'public' ? -1 : b === 'public' ? 1 : a.localeCompare(b)));
    const items = names.map((n) => ({ name: n, path: joinPath(n), type: 'dir', kind: 'schema', children: sch.get(n) }));
    const edge = await edgeList().catch(() => []);
    items.push({ name: 'Edge Functions', path: '@edge', type: 'dir', kind: 'edge', children: edge.length });
    const bk = await bucketList().catch(() => []);
    items.push({ name: 'Buckets', path: '@buckets', type: 'dir', kind: 'bucket', children: bk.length });
    return page('', 'raiz', items, offset, limit);
  }
  if (s[0] === '@edge') {
    if (s.length !== 1) throw new HttpError(400, 'não é pasta');
    const items = (await edgeList()).map((f) => ({ name: f.slug, path: joinPath('@edge', f.slug), type: 'file', kind: 'edge', size: null, mtime: f.updated_at || f.created_at || null }));
    return page(p, 'Edge Functions', items.sort((a, b) => a.name.localeCompare(b.name)), offset, limit);
  }
  if (s[0] === '@buckets') {
    if (s.length === 1) {
      const items = (await bucketList()).map((b) => ({ name: b.name, path: joinPath('@buckets', b.id), type: 'dir', kind: 'bucket', children: Number(b.n), mtime: Date.parse(b.created_at) || null }));
      return page(p, 'Buckets', items, offset, limit);
    }
    if (s.length === 2) return page(p, s[1], (await objects(s[1])).map((o) => objItem(s[1], o)), offset, limit);
    throw new HttpError(400, 'não é pasta');
  }
  const cat = await catalog();
  if (s.length === 1) {
    const cnt = await counts(s[0]);
    const rels = cat.rels.filter((r) => r.schema === s[0]).sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => ({ name: r.name, path: joinPath(r.schema, r.name), type: 'dir', kind: relKind(r), children: cnt[r.name], size: r.bytes }));
    const fns = cat.funcs.filter((f) => f.schema === s[0]).sort((a, b) => fnSeg(a).localeCompare(fnSeg(b)))
      .map((f) => ({ name: `${f.name}()`, path: joinPath(f.schema, fnSeg(f)), type: 'file', kind: 'funcao', size: null, mtime: null }));
    if (!rels.length && !fns.length) throw new HttpError(404, 'schema não encontrado');
    return page(p, s[0], [...rels, ...fns], offset, limit);
  }
  if (s.length === 2) {
    const r = await findRel(s[0], s[1]);
    const total = (await counts(s[0]))[r.name] ?? 0;
    const got = await rows(r, offset, limit);
    const items = got.map((x, i) => rowItem(p, r, x.j, offset + i));
    return { path: p, name: r.name, total: Math.max(total, offset + items.length), offset, limit, items };
  }
  throw new HttpError(400, 'não é pasta');
}

function page(p, name, all, offset, limit) {
  return { path: p, name, total: all.length, offset, limit, items: all.slice(offset, offset + limit) };
}

async function stats(p) {
  const s = parse(p);
  if (s[0] === '@edge') {
    const e = await edgeList();
    return { total: e.length, kinds: { edge: e.length }, bytes: null };
  }
  if (s[0] === '@buckets') {
    if (s.length === 1) { const b = await bucketList(); return { total: b.length, kinds: { bucket: b.length }, bytes: b.reduce((t, x) => t + Number(x.bytes), 0) }; }
    const o = await objects(s[1]);
    const b = (await bucketList()).find((x) => x.id === s[1]);
    return { total: o.length, kinds: { objeto: o.length }, bytes: o.reduce((t, x) => t + (Number(x.metadata && x.metadata.size) || 0), 0), info: b ? [['PÚBLICO', b.public ? 'sim' : 'não']] : [] };
  }
  const cat = await catalog();
  if (s.length === 1) {
    const rels = cat.rels.filter((r) => r.schema === s[0]);
    const fns = cat.funcs.filter((f) => f.schema === s[0]);
    const kinds = { tabela: rels.filter((r) => relKind(r) === 'tabela').length, view: rels.filter((r) => relKind(r) === 'view').length, funcao: fns.length };
    return { total: rels.length + fns.length, kinds, bytes: rels.reduce((t, r) => t + Number(r.bytes || 0), 0) };
  }
  if (s.length === 2) {
    const r = await findRel(s[0], s[1]);
    const total = (await counts(s[0]))[r.name] ?? 0;
    const [det] = await sql(`select
      (select json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notnull', a.attnotnull) order by a.attnum)
         from pg_attribute a where a.attrelid = ${Number(r.oid)} and a.attnum > 0 and not a.attisdropped) as cols,
      (select json_agg(json_build_object('name', polname, 'cmd', polcmd) order by polname) from pg_policy where polrelid = ${Number(r.oid)}) as pols,
      (select count(*) from pg_trigger where tgrelid = ${Number(r.oid)} and not tgisinternal) as trig`);
    const cmd = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' };
    const fks = cat.fks.filter((f) => (f.src_schema === r.schema && f.src === r.name) || (f.dst_schema === r.schema && f.dst === r.name))
      .map((f) => (f.src === r.name && f.src_schema === r.schema ? `→ ${f.dst_schema}.${f.dst}` : `← ${f.src_schema}.${f.src}`));
    return {
      total, kinds: { linha: total }, bytes: Number(r.bytes || 0),
      info: [['RLS', r.rls ? 'ligado' : 'desligado'], ['POLÍTICAS', String((det.pols || []).length)], ['PK', (r.pk || []).join(', ') || '—'], ['GATILHOS', String(det.trig)]],
      cols: (det.cols || []).map((c) => ({ ...c, pk: (r.pk || []).includes(c.name), oculta: SECRET_RE.test(c.name) })),
      pols: (det.pols || []).map((x) => `${x.name} · ${cmd[x.cmd] || x.cmd}`), fks, comment: r.comment || '',
    };
  }
  throw new HttpError(400, 'não é pasta');
}

// texto de um item-folha: linha (JSON), função (SQL), edge function (metadados + código local)
async function text(p, full) {
  const s = parse(p);
  let out;
  if (s[0] === '@edge' && s.length === 2) {
    const f = (await edgeList()).find((x) => x.slug === s[1]);
    if (!f) throw new HttpError(404, 'função não encontrada');
    const meta = { slug: f.slug, nome: f.name, versao: f.version, status: f.status, verify_jwt: f.verify_jwt, entrypoint: f.entrypoint_path,
      criada: f.created_at && new Date(f.created_at).toISOString(), atualizada: f.updated_at && new Date(f.updated_at).toISOString() };
    out = `// ${JSON.stringify(meta, null, 2).split('\n').join('\n// ')}\n`;
    const src = path.join(FUNCS_DIR, f.slug, 'index.ts');
    try { out += `\n// código local: ${src.replace(os.homedir(), '~')}\n\n` + await fsp.readFile(src, 'utf8'); } catch { out += '\n// (sem código local desta função)\n'; }
  } else if (s[0] === '@buckets' && s.length === 3) {
    const o = (await objects(s[1])).find((x) => x.name === s[2]);
    if (!o) throw new HttpError(404, 'objeto não encontrado');
    out = JSON.stringify({ bucket: s[1], nome: o.name, criado: o.created_at, atualizado: o.updated_at, metadata: o.metadata }, null, 2);
  } else if (s.length === 2 && !s[0].startsWith('@')) {
    const f = await findFn(s[0], s[1]);
    if (f.prokind === 'a' || f.prokind === 'w') out = `-- ${f.prokind === 'a' ? 'agregado' : 'função de janela'} ${s[0]}.${fnSeg(f)} → ${f.ret}`;
    else out = (await sql(`select pg_get_functiondef(${Number(f.oid)}) as d`))[0].d;
  } else if (s.length === 3 && !s[0].startsWith('@')) {
    const r = await findRel(s[0], s[1]);
    out = JSON.stringify(redact(await oneRow(r, s[2]), full ? 4000 : 160), null, 2);
  } else throw new HttpError(400, 'não é item');
  const max = full ? 512 * 1024 : 8192;
  if (full) return { text: out.slice(0, max), truncated: out.length > max };
  const lines = out.split('\n');
  return { text: lines.slice(0, 40).map((l) => (l.length > 160 ? l.slice(0, 160) + '…' : l)).join('\n'), truncated: lines.length > 40 };
}

// imagem de um item: objeto do storage ou imagem em base64 dentro de uma linha
async function media(p) {
  const s = parse(p);
  if (s[0] === '@buckets' && s.length === 3) {
    const o = (await objects(s[1])).find((x) => x.name === s[2]);
    if (!o) throw new HttpError(404, 'objeto não encontrado');
    const mime = o.metadata && o.metadata.mimetype;
    if (!isImgMime(mime)) throw new HttpError(415, 'tipo não suportado');
    const key = await storageKey();
    const url = `https://${REF}.supabase.co/storage/v1/object/authenticated/${encodeURIComponent(s[1])}/${s[2].split('/').map(encodeURIComponent).join('/')}`;
    const r = await limited(() => fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(25000) }));
    if (!r.ok) throw new HttpError(502, `storage ${r.status}`);
    return { type: mime, body: Buffer.from(await r.arrayBuffer()) };
  }
  if (s.length === 3 && !s[0].startsWith('@')) {
    const j = await oneRow(await findRel(s[0], s[1]), s[2]);
    for (const [k, v] of Object.entries(j)) {
      if (SECRET_RE.test(k) || typeof v !== 'string') continue;
      const m = /^data:(image\/(?:png|jpe?g|gif|webp|avif|svg\+xml));base64,(.+)$/s.exec(v);
      if (m) return { type: m[1], body: Buffer.from(m[2], 'base64') };
    }
  }
  throw new HttpError(404, 'sem imagem');
}

// busca: nomes do catálogo + conteúdo das linhas dos schemas do app (public e privado)
async function search(q, max = 40) {
  q = q.trim();
  if (q.length < 2) return [];
  const ql = q.toLocaleLowerCase('pt-BR');
  const has = (s) => String(s).toLocaleLowerCase('pt-BR').includes(ql);
  const cat = await catalog();
  const out = [];
  for (const r of cat.rels) if (has(r.name)) out.push({ name: r.name, path: joinPath(r.schema, r.name), type: 'dir', kind: relKind(r) });
  for (const f of cat.funcs) if (has(f.name)) out.push({ name: `${f.name}()`, path: joinPath(f.schema, fnSeg(f)), type: 'file', kind: 'funcao' });
  for (const e of await edgeList().catch(() => [])) if (has(e.slug)) out.push({ name: e.slug, path: joinPath('@edge', e.slug), type: 'file', kind: 'edge' });
  const alvo = cat.rels.filter((r) => ['public', 'privado'].includes(r.schema));
  const like = lit('%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
  await Promise.all(alvo.map(async (r) => {
    try {
      const got = await sql(`select to_jsonb(t) as j from ${ident(r.schema)}.${ident(r.name)} t where t::text ilike ${like} order by ${orderBy(r)} limit 12`);
      const base = joinPath(r.schema, r.name);
      for (const [i, x] of got.entries()) {
        const vis = redact(x.j, 400);
        if (!Object.values(vis).some((v) => v != null && has(typeof v === 'object' ? JSON.stringify(v) : v))) continue; // só achou em coluna oculta
        if (!(r.pk && r.pk.length)) continue; // sem chave primária não dá para apontar a linha com segurança
        out.push(rowItem(base, r, x.j, i));
      }
    } catch { /* tabela sem permissão: ignora */ }
  }));
  return out.slice(0, max).map(({ name, path: p, type, kind }) => ({ name, path: p, type, kind }));
}

// ---------- assistente de voz ----------
// schemas internos do Supabase que o assistente não precisa conhecer
const SYS_NS = new Set(['graphql', 'graphql_public', 'realtime', 'supabase_functions', 'supabase_migrations', 'vault', 'net', 'pgsodium', 'pgsodium_masks', 'extensions', 'cron', 'pgbouncer', '_realtime', '_analytics']);
// lista "schema.tabela: coluna tipo, ..." para o modelo montar SQL (só nomes, nenhum dado)
async function esquema() {
  return cached('esquema', async () => {
    const got = await sql(`select n.nspname as s, c.relname as t, json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) order by a.attnum) as cols
      from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relkind in ('r','p','v','m') and not c.relispartition and ${SKIP_NS} group by 1, 2 order by 1, 2`, 300000);
    return got.filter((r) => !SYS_NS.has(r.s) && !(r.s === 'auth' && r.t !== 'users') && !(r.s === 'storage' && !['buckets', 'objects'].includes(r.t)))
      .map((r) => `${r.s}.${r.t}: ${r.cols.filter(([n]) => !SECRET_RE.test(n)).map(([n, t]) => `${n} ${t}`).join(', ')}`).join('\n');
  }, 300000);
}
// SQL do assistente: um único SELECT, read_only, no máximo 50 linhas
async function consultar(q) {
  q = String(q || '').trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(q) || q.includes(';') || q.length > 4000) throw new HttpError(400, 'só um SELECT');
  return sql(`select * from (${q}) as resposta limit 50`, 5000);
}

module.exports = { info, list, stats, text, media, search, esquema, consultar, kind: 'supabase' };
