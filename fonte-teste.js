// Fonte de dados de teste: um banco falso em memória com o mesmo formato da fonte Supabase.
// Usada por `npm test` (CEREBRO_FONTE=teste) para os testes nunca tocarem no banco de verdade.
'use strict';

const { HttpError, SECRET_RE, redact, rowLabel, rowTime, rowImage, seg, unseg, joinPath } = require('./comum');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const NOMES = ['Maria Souza', 'João Lima', 'Ana Paula', 'Carlos Dias', 'Beatriz Rocha', 'Diego Alves', 'Fernanda Reis', 'Gabriel Nunes', 'Helena Costa', 'Igor Martins'];
const dia = (i) => new Date(Date.UTC(2026, 8, 1 + (i % 20), 12, i % 60)).toISOString();
const uuid = (p, i) => `${p}000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

const T = (pk, rows, extra = {}) => ({ pk, rows, cols: Object.keys(rows[0] || {}).map((c) => ({ name: c, type: typeof rows[0][c] === 'number' ? 'integer' : 'text', notnull: pk.includes(c) })), rls: true, pols: [], ...extra });

const DB = {
  public: {
    rels: {
      cadastros: T(['id'], range(20, (i) => ({ id: uuid('c', i), codigo: 'REINO' + (i % 5), nome: NOMES[i % 10] + ' ' + i, email: `pessoa${i}@exemplo.com`, cidade: 'Natal', uf: 'RN', criado_em: dia(i) })), { pols: [['anon insere', 'a']] }),
      cliques: T(['id'], range(400, (i) => ({ id: uuid('d', i), codigo: 'REINO' + (i % 5), origem: i % 2 ? 'whatsapp' : 'instagram', cadastrou: i % 7 === 0, criado_em: dia(i) }))),
      perfis: T(['id'], range(6, (i) => ({ id: uuid('e', i), nome: NOMES[i], usuario: 'user' + i, foto: i < 3 ? PNG : null, criado_em: dia(i) }))),
      academy_trilhas: T(['id'], range(4, (i) => ({ id: uuid('f', i), titulo: `Trilha ${i + 1}`, capa: null, ordem: i, criado_em: dia(i) }))),
      academy_aulas: T(['id'], range(12, (i) => ({ id: uuid('a', i), trilha_id: uuid('f', i % 4), titulo: `Aula ${i + 1}`, ordem: i, criado_em: dia(i) }))),
      codigos: T(['codigo'], range(5, (i) => ({ codigo: 'REINO' + i, user_id: uuid('e', i), nome: NOMES[i], criado_em: dia(i) }))),
      empresas_reais: T(['place_id'], range(8, (i) => ({ place_id: 'pl' + i, nome: `Empresa ${i}`, cidade: 'Natal', nota: 4.5, buscado_em: dia(i) }))),
      fotos: T(['chave'], range(3, (i) => ({ chave: 'foto' + i, url: PNG, criado_em: dia(i) }))),
      ranking_afiliados: T([], range(5, (i) => ({ codigo: 'REINO' + i, cliques: 80 - i * 10, cadastros: 10 - i })), { view: true, rls: false }),
    },
    funcs: ['admin_cadastros', 'ranking_afiliados', 'ao_criar_usuario', 'meu_codigo', 'registrar_clique', 'limpar_tentativas'],
  },
  auth: {
    rels: {
      users: T(['id'], range(3, (i) => ({ id: uuid('b', i), email: `user${i}@exemplo.com`, encrypted_password: '$2a$10$segredo' + i, confirmation_token: 'tok' + i, created_at: dia(i) }))),
      sessions: T(['id'], range(2, (i) => ({ id: uuid('9', i), user_id: uuid('b', i), created_at: dia(i) }))),
      refresh_tokens: T(['id'], range(2, (i) => ({ id: i + 1, token: 'rt' + i, user_id: uuid('b', i), created_at: dia(i) }))),
    },
    funcs: ['uid', 'role', 'email'],
  },
  privado: { rels: { tentativas_login: T(['chave'], range(2, (i) => ({ chave: 'ip' + i, total: i + 1, janela_inicio: dia(i) }))) }, funcs: [] },
  storage: { rels: { buckets: T(['id'], [{ id: 'avatares', name: 'avatares', public: false, created_at: dia(0) }]), objects: T(['id'], [{ id: uuid('7', 0), bucket_id: 'avatares', name: 'u1/avatar.png', created_at: dia(1) }]) }, funcs: ['search', 'foldername'] },
};
const FKS = [{ src: 'public/academy_aulas', dst: 'public/academy_trilhas', name: 'academy_aulas_trilha_id_fkey' }];
const EDGE = ['academy-importar', 'reino-apis', 'reino-cadastro', 'reino-login'].map((slug, i) => ({ slug, version: 3 + i, status: 'ACTIVE', verify_jwt: i !== 2, updated_at: Date.parse(dia(i)) }));
const OBJETOS = [{ name: 'u1/avatar.png', mime: 'image/png', size: 70, created_at: dia(1) }];

const kindOf = (r) => (r.view ? 'view' : 'tabela');
const key = (r, j, i) => (r.pk.length ? String(j[r.pk[0]]) : '~' + i);
const parse = (p) => {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) throw new HttpError(400, 'caminho inválido');
  return p ? p.split('/').map(unseg) : [];
};
const page = (p, name, all, offset, limit) => ({ path: p, name, total: all.length, offset, limit, items: all.slice(offset, offset + limit) });
const rel = (s, n) => { const r = DB[s] && DB[s].rels[n]; if (!r) throw new HttpError(404, 'tabela não encontrada'); return r; };
const row = (r, k) => {
  const j = k.startsWith('~') ? r.rows[Number(k.slice(1))] : r.rows.find((x) => String(x[r.pk[0]]) === k);
  if (!j) throw new HttpError(404, 'linha não encontrada');
  return j;
};
const rowItem = (base, r, j, i) => {
  const k = key(r, j, i);
  const p = base + '/' + seg(k);
  return { name: rowLabel(j, k), path: p, type: 'file', kind: 'linha', size: Buffer.byteLength(JSON.stringify(j)), mtime: rowTime(j), img: rowImage(j, p) };
};

async function info() {
  return { hostname: 'Reino (teste)', user: 'sa-east-1', home: 'teste', ref: 'teste', region: 'sa-east-1', dashboard: 'https://supabase.com/dashboard/project/teste', fks: FKS };
}

async function list(p, offset, limit) {
  const s = parse(p);
  if (!s.length) {
    const items = Object.keys(DB).map((n) => ({ name: n, path: joinPath(n), type: 'dir', kind: 'schema', children: Object.keys(DB[n].rels).length + DB[n].funcs.length }));
    items.push({ name: 'Edge Functions', path: '@edge', type: 'dir', kind: 'edge', children: EDGE.length });
    items.push({ name: 'Buckets', path: '@buckets', type: 'dir', kind: 'bucket', children: 1 });
    return page('', 'raiz', items, offset, limit);
  }
  if (s[0] === '@edge') return page(p, 'Edge Functions', EDGE.map((e) => ({ name: e.slug, path: joinPath('@edge', e.slug), type: 'file', kind: 'edge', size: null, mtime: e.updated_at })), offset, limit);
  if (s[0] === '@buckets') {
    if (s.length === 1) return page(p, 'Buckets', [{ name: 'avatares', path: joinPath('@buckets', 'avatares'), type: 'dir', kind: 'bucket', children: 1 }], offset, limit);
    return page(p, s[1], OBJETOS.map((o) => { const q = joinPath('@buckets', s[1], o.name); return { name: o.name, path: q, type: 'file', kind: 'objeto', size: o.size, mtime: Date.parse(o.created_at), img: `/api/media?path=${encodeURIComponent(q)}` }; }), offset, limit);
  }
  if (s.length === 1) {
    const sc = DB[s[0]];
    if (!sc) throw new HttpError(404, 'schema não encontrado');
    const rels = Object.entries(sc.rels).sort(([a], [b]) => a.localeCompare(b)).map(([n, r]) => ({ name: n, path: joinPath(s[0], n), type: 'dir', kind: kindOf(r), children: r.rows.length, size: 8192 }));
    const fns = sc.funcs.slice().sort().map((f) => ({ name: f + '()', path: joinPath(s[0], f + '()'), type: 'file', kind: 'funcao', size: null, mtime: null }));
    return page(p, s[0], [...rels, ...fns], offset, limit);
  }
  if (s.length === 2) {
    const r = rel(s[0], s[1]);
    return page(p, s[1], r.rows.map((j, i) => rowItem(p, r, j, i)), offset, limit);
  }
  throw new HttpError(400, 'não é pasta');
}

async function stats(p) {
  const s = parse(p);
  if (s[0] === '@edge') return { total: EDGE.length, kinds: { edge: EDGE.length }, bytes: null };
  if (s[0] === '@buckets') return s.length === 1 ? { total: 1, kinds: { bucket: 1 }, bytes: 70 } : { total: 1, kinds: { objeto: 1 }, bytes: 70, info: [['PÚBLICO', 'não']] };
  if (s.length === 1) {
    const sc = DB[s[0]];
    if (!sc) throw new HttpError(404, 'schema não encontrado');
    const rs = Object.values(sc.rels);
    return { total: rs.length + sc.funcs.length, kinds: { tabela: rs.filter((r) => !r.view).length, view: rs.filter((r) => r.view).length, funcao: sc.funcs.length }, bytes: rs.length * 8192 };
  }
  const r = rel(s[0], s[1]);
  return {
    total: r.rows.length, kinds: { linha: r.rows.length }, bytes: 8192,
    info: [['RLS', r.rls ? 'ligado' : 'desligado'], ['POLÍTICAS', String(r.pols.length)], ['PK', r.pk.join(', ') || '—'], ['GATILHOS', '0']],
    cols: r.cols.map((c) => ({ ...c, pk: r.pk.includes(c.name), oculta: SECRET_RE.test(c.name) })),
    pols: r.pols.map(([n, c]) => `${n} · ${{ a: 'INSERT', r: 'SELECT' }[c] || c}`),
    fks: FKS.filter((f) => f.src === p || f.dst === p).map((f) => (f.src === p ? `→ ${f.dst.replace('/', '.')}` : `← ${f.src.replace('/', '.')}`)), comment: '',
  };
}

async function text(p, full) {
  const s = parse(p);
  let out;
  if (s[0] === '@edge') out = `// ${s[1]}\nDeno.serve(async (req) => {\n  return new Response('ok');\n});\n`;
  else if (s[0] === '@buckets') out = JSON.stringify(OBJETOS.find((o) => o.name === s[2]) || {}, null, 2);
  else if (s.length === 2) out = `CREATE OR REPLACE FUNCTION ${s[0]}.${s[1].replace(/\(\)$/, '')}()\n RETURNS void\n LANGUAGE sql\nAS $function$\n  select 1;\n$function$\n`;
  else if (s.length === 3) out = JSON.stringify(redact(row(rel(s[0], s[1]), s[2]), full ? 4000 : 160), null, 2);
  else throw new HttpError(400, 'não é item');
  const lines = out.split('\n');
  if (full) return { text: out, truncated: false };
  return { text: lines.slice(0, 40).join('\n'), truncated: lines.length > 40 };
}

async function media(p) {
  const s = parse(p);
  let v = null;
  if (s[0] === '@buckets') v = PNG;
  else if (s.length === 3) v = Object.entries(row(rel(s[0], s[1]), s[2])).find(([k, x]) => !SECRET_RE.test(k) && typeof x === 'string' && x.startsWith('data:image/'))?.[1];
  if (!v) throw new HttpError(404, 'sem imagem');
  return { type: 'image/png', body: Buffer.from(v.split(',')[1], 'base64') };
}

async function search(q, max = 40) {
  const ql = q.trim().toLocaleLowerCase('pt-BR');
  if (ql.length < 2) return [];
  const has = (v) => String(v).toLocaleLowerCase('pt-BR').includes(ql);
  const out = [];
  for (const [sn, sc] of Object.entries(DB)) {
    for (const [n, r] of Object.entries(sc.rels)) {
      if (has(n)) out.push({ name: n, path: joinPath(sn, n), type: 'dir', kind: kindOf(r) });
      if (!['public', 'privado'].includes(sn) || !r.pk.length) continue;
      r.rows.forEach((j, i) => { if (Object.entries(j).some(([k, v]) => !SECRET_RE.test(k) && v != null && has(v))) out.push(rowItem(joinPath(sn, n), r, j, i)); });
    }
    for (const f of sc.funcs) if (has(f)) out.push({ name: f + '()', path: joinPath(sn, f + '()'), type: 'file', kind: 'funcao' });
  }
  return out.slice(0, max).map(({ name, path: p, type, kind }) => ({ name, path: p, type, kind }));
}

module.exports = { info, list, stats, text, media, search, kind: 'teste' };
