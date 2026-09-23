// Assistente de voz do Cérebro (estilo Jarvis).
// ouvir: áudio → texto (Groq Whisper). perguntar: texto → ação (Groq gpt-oss). voz: texto → mp3 (edge-tts, voz neural).
// O que sai da máquina: o áudio e a pergunta (Groq) e os NOMES de tabelas/colunas (Groq). As linhas do banco não saem:
// o SQL roda aqui (read_only) e o resultado só vai para a tela e para a frase falada.
// Memória (memoria.js): fatos sobre o usuário e as últimas conversas também vão para a Groq, para ele lembrar de você.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HttpError, redact } = require('./comum');
const memoria = require('./memoria');

const MODELO = process.env.CEREBRO_LLM || 'openai/gpt-oss-120b';
const WHISPER = process.env.CEREBRO_WHISPER || 'whisper-large-v3-turbo';
const VOZ = process.env.CEREBRO_VOZ || 'pt-BR-AntonioNeural';
const EDGE_TTS = process.env.CEREBRO_EDGE_TTS || path.join(os.homedir(), '.local', 'bin', 'edge-tts');

// a chave fica no servidor: variável de ambiente ou a linha "export GROQ_API_KEY=" do ~/.bashrc
function groqKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim();
  try {
    const m = /^\s*export\s+GROQ_API_KEY=["']?([^"'\s]+)/m.exec(fs.readFileSync(path.join(os.homedir(), '.bashrc'), 'utf8'));
    if (m) return m[1];
  } catch { /* sem .bashrc */ }
  return null;
}

async function groq(p, init) {
  const key = groqKey();
  if (!key) throw new HttpError(503, 'sem GROQ_API_KEY');
  let r;
  try {
    r = await fetch('https://api.groq.com/openai/v1' + p, { ...init, headers: { Authorization: `Bearer ${key}`, ...init.headers }, signal: AbortSignal.timeout(30000) });
  } catch (e) { throw new HttpError(502, `Groq fora do ar: ${e.message}`); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, `Groq ${r.status}: ${String(body.error?.message || '').slice(0, 200)}`);
  return body;
}

// ---------- ouvir ----------
async function ouvir(audio, mime) {
  if (!audio.length) throw new HttpError(400, 'áudio vazio');
  const ext = /ogg/.test(mime) ? 'ogg' : /mp4|m4a/.test(mime) ? 'm4a' : /wav/.test(mime) ? 'wav' : /mpeg|mp3/.test(mime) ? 'mp3' : 'webm';
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: mime || 'audio/webm' }), `fala.${ext}`);
  fd.append('model', WHISPER);
  fd.append('language', 'pt');
  fd.append('temperature', '0');
  fd.append('prompt', 'Cérebro, mostre a tabela, quantos registros, Supabase, schema, função.');
  const d = await groq('/audio/transcriptions', { method: 'POST', body: fd, headers: {} });
  return { texto: String(d.text || '').trim() };
}

// ---------- perguntar ----------
const SISTEMA = `Você é o Cérebro, assistente de voz (estilo Jarvis) de um explorador de banco Supabase/Postgres.
O usuário fala em português. Decida UMA ação e responda SÓ com JSON:
{"acao":"abrir","caminho":"..."}  → mostrar qualquer item do MAPA (schema, tabela, view, função, a pasta Edge Functions ou uma delas, Buckets, um bucket ou um arquivo). Copie o caminho EXATAMENTE como está no mapa. Ex.: "abra as edge functions" → "@edge".
{"acao":"consultar","sql":"select ...","fala":"frase curta com {valor}"}  → pergunta que precisa de número ou dado (quantos, qual o último, soma, lista...)
{"acao":"buscar","termo":"texto"}  → procurar um registro, pessoa, função ou Edge Function pelo nome/conteúdo
{"acao":"inicio"}  → voltar ao cérebro inteiro
{"acao":"fechar"}  → "fechar tudo": recolher tudo e voltar ao estado inicial
{"acao":"planeta"}  → "abrir reino" / "abrir tudo": abrir todo o conhecimento num planeta
{"acao":"nada","fala":"resposta curta"}  → conversa ou pedido que não é sobre o banco
Regras do SQL: um único SELECT (ou WITH ... SELECT) em PostgreSQL, sem ponto e vírgula, nomes sempre qualificados com schema, só as tabelas/colunas da lista.
Na "fala", {valor} vira o valor da primeira coluna da primeira linha e {nome_da_coluna} o valor dessa coluna na primeira linha (dê alias simples às colunas). Escreva como quem fala: "Temos {valor} cadastros." / "O último foi {nome}, de {cidade}.". Se a resposta for uma lista, diga só quantos são ou o essencial; a tela mostra a tabela. Nunca selecione colunas de senha, token ou hash.
Não diga "aqui está, senhor": o app já diz isso.

Memória: você lembra do usuário entre conversas. Em QUALQUER ação pode acrescentar:
"memorizar":["fato curto em terceira pessoa"]  → quando o usuário contar algo sobre si (nome, como quer ser chamado, gostos, projetos, rotina) ou pedir "lembre que...". Ex.: "O nome dele é Diego.", "Prefere respostas curtas."
"esquecer":[id, ...]  → quando pedir para esquecer algo ou quando um fato novo substituir um antigo (use os ids da lista de fatos).
Para "o que você sabe de mim?", "do que falamos ontem?", apresentações e conversa pessoal use {"acao":"nada","fala":"..."} respondendo com o que está na memória, chamando o usuário pelo nome quando souber. Nunca invente fatos que não estão na memória.`;

async function perguntar(fonte, q) {
  q = String(q || '').trim().slice(0, 500);
  if (!q) throw new HttpError(400, 'pergunta vazia');
  const out = await decidir(fonte, q);
  memoria.registrar({ pergunta: q, acao: out.acao, fala: out.fala, sql: out.sql }); // em segundo plano
  return out;
}

// comandos fixos: reconhecidos aqui mesmo, sem gastar a Groq
const COMANDOS = [
  [/\b(fech(ar|e|a)|recolh(er|e|a))\s+tudo\b/i, 'fechar'],
  [/\b(abr(ir|a|e))\s+(o\s+)?reino\b|\babr(ir|a|e)\s+tudo\b/i, 'planeta'],
];

async function decidir(fonte, q) {
  for (const [re, acao] of COMANDOS) if (re.test(q)) return { acao, pergunta: q };
  try { return await decidirComLLM(fonte, q); } catch (e) {
    // limite por minuto da Groq: não trava o assistente, cai na busca por nome
    if (/Groq 429/.test(e.message)) { console.error(e.message.slice(0, 120)); return { acao: 'buscar', termo: limpar(q), pergunta: q, aviso: 'limite da Groq' }; }
    throw e;
  }
}

async function decidirComLLM(fonte, q) {
  if (!groqKey() || !fonte.esquema) return { acao: 'buscar', termo: limpar(q), pergunta: q };
  const [esquema, m, lembrancas] = await Promise.all([fonte.esquema(), mapa(fonte), memoria.contexto()]);
  const d = await groq('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODELO, temperature: 0, max_completion_tokens: 1200, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: `${SISTEMA}\n\nMAPA do cérebro (caminho | tipo | nome — descrição). Tabela ou view: caminho "schema/tabela" (as da lista abaixo e as internas do Supabase).\n${m.texto}\n\nTabelas para SQL (schema.tabela: colunas):\n${esquema}${lembrancas ? `\n\n${lembrancas}` : ''}` }, { role: 'user', content: q }],
    }),
  });
  let a;
  try { a = JSON.parse(d.choices[0].message.content); } catch { return { acao: 'buscar', termo: limpar(q), pergunta: q }; }
  // memória antes da ação: esquece primeiro, para um fato que substitui outro não ser apagado junto
  if (Array.isArray(a.esquecer) && a.esquecer.length) await memoria.esquecer(a.esquecer);
  for (const f of [].concat(a.memorizar || []).slice(0, 5)) if (typeof f === 'string') await memoria.lembrar(f);
  const out = { acao: a.acao, pergunta: q };
  if (a.acao === 'abrir' && typeof a.caminho === 'string') {
    const c = acharCaminho(m, a.caminho);
    if (c) out.caminho = c;
    else { out.acao = 'buscar'; out.termo = String(a.caminho).split('/').pop(); } // fora do mapa: procura pelo nome
  }
  else if (a.acao === 'buscar') out.termo = String(a.termo || limpar(q));
  else if (a.acao === 'consultar' && typeof a.sql === 'string') {
    try {
      const linhas = await fonte.consultar(a.sql);
      const primeira = linhas[0] ? Object.values(linhas[0])[0] : null;
      out.linhas = linhas.map((l) => redact(l, 200));
      out.fala = String(a.fala || '').replace(/\{valor\}/g, falavel(primeira))
        .replace(/\{([\wÀ-ú]+)\}/g, (m, k) => (linhas[0] && k in linhas[0] ? falavel(redact(linhas[0], 200)[k]) : m));
      out.sql = a.sql;
    } catch (e) { return { acao: 'nada', pergunta: q, fala: 'Não consegui consultar isso, senhor.', erro: e.message, sql: a.sql }; }
  } else if (a.acao === 'inicio' || a.acao === 'fechar' || a.acao === 'planeta') { /* nada a acrescentar */ }
  else { out.acao = 'nada'; out.fala = String(a.fala || '').slice(0, 300); }
  return out;
}

// ---------- mapa ----------
// O assistente "estuda" a árvore inteira que o grafo mostra (mesmo fonte.list): raiz → schemas (tabelas, views, funções),
// Edge Functions (com o comentário inicial do código, para saber o que cada uma faz), Buckets → arquivos.
// Não desce nas linhas das tabelas. Só nomes e caminhos vão para a Groq, nenhum dado.
const MAPA_TTL = 5 * 60 * 1000;
const MAX_ARQUIVOS = 60; // por bucket
let mapaCache = null;
const INTERNOS = new Set(['auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public', 'pgbouncer', 'vault', 'supabase_migrations', 'supabase_functions', 'net', 'cron', 'pgsodium']);

// montado ao ligar o servidor; depois de 5 min responde com o mapa velho e remonta em segundo plano
function mapa(fonte) {
  if (mapaCache && Date.now() - mapaCache.t < MAPA_TTL) return mapaCache.p;
  const antigo = mapaCache && mapaCache.pronto;
  const p = montarMapa(fonte).then((m) => { if (mapaCache && mapaCache.p === p) mapaCache.pronto = m; return m; })
    .catch((e) => { console.error('mapa:', e.message); if (mapaCache && mapaCache.p === p) mapaCache = null; return antigo || { texto: '(mapa indisponível)', caminhos: new Map() }; });
  mapaCache = { t: Date.now(), p, pronto: antigo };
  return antigo ? Promise.resolve(antigo) : p;
}

async function tudo(fonte, caminho) {
  const itens = [];
  for (let off = 0; ; ) {
    const pg = await fonte.list(caminho, off, 500);
    itens.push(...pg.items);
    off += pg.items.length;
    if (!pg.items.length || off >= (pg.total ?? off)) return itens;
  }
}

async function resumoEdge(fonte, caminho) {
  try {
    let t = (await fonte.text(caminho, false)).text;
    if (t.includes('código local:')) t = t.split('código local:')[1].split('\n').slice(1).join('\n');
    const linhas = [];
    for (const l of t.split('\n')) {
      const x = l.trim();
      if (!x) { if (linhas.length) break; continue; }
      if (!/^(\/\/|\/?\*)/.test(x)) break;
      const limpo = x.replace(/^(\/\/+|\/?\*+\/?)\s?/, '').trim();
      if (limpo) linhas.push(limpo);
      if (linhas.length >= 2) break;
    }
    return linhas.join(' ').slice(0, 160);
  } catch { return ''; }
}

async function montarMapa(fonte) {
  const linhas = [];
  const caminhos = new Map(); // caminho → item (para validar o que o modelo devolve)
  const add = (it, desc = '') => {
    caminhos.set(it.path, it);
    // no texto (tokens contam: a Groq grátis dá 8 mil por minuto) ficam só o que o modelo não vê em outro lugar:
    // tabelas/views já vão na lista do SQL; funções internas do Supabase ficam navegáveis, mas fora do texto
    const sch = it.path.split('/')[0];
    if (it.kind === 'tabela' || it.kind === 'view') return;
    if (it.kind === 'funcao') { if (!INTERNOS.has(sch)) linhas.push(`${it.path} | funcao`); return; }
    const n = it.children != null ? ` (${it.children} itens)` : '';
    linhas.push(`${it.path} | ${it.kind} | ${it.name}${n}${desc ? ' — ' + desc : ''}`);
  };
  for (const raiz of await tudo(fonte, '')) {
    add(raiz);
    if (raiz.type !== 'dir') continue;
    const filhos = await tudo(fonte, raiz.path);
    const descs = raiz.kind === 'edge' ? await Promise.all(filhos.map((f) => resumoEdge(fonte, f.path))) : [];
    for (const [i, f] of filhos.entries()) {
      add(f, descs[i]);
      if (f.kind !== 'bucket') continue; // tabelas: não desce nas linhas
      const arqs = await tudo(fonte, f.path);
      arqs.slice(0, MAX_ARQUIVOS).forEach((a) => add(a));
      if (arqs.length > MAX_ARQUIVOS) linhas.push(`${f.path}/… | mais ${arqs.length - MAX_ARQUIVOS} arquivos (use buscar)`);
    }
  }
  return { texto: linhas.join('\n'), caminhos };
}

// o modelo às vezes troca "/" por "." ou erra maiúsculas: aceita se casar com um caminho real do mapa
function acharCaminho(m, c) {
  c = String(c).trim().replace(/^\/+|\/+$/g, '');
  if (m.caminhos.has(c)) return c;
  const norm = (x) => { try { x = decodeURIComponent(x); } catch { /* como está */ } return x.toLowerCase().replace(/\./g, '/'); };
  const alvo = norm(c);
  for (const k of m.caminhos.keys()) if (norm(k) === alvo) return k;
  return null;
}

// sem LLM: tira as palavras de comando e busca o resto
function limpar(q) {
  return q.toLowerCase().replace(/[.,!?]/g, ' ')
    .replace(/\b(c[ée]rebro|jarvis|por favor|me|mostr[ae]r?|abr[ae]|abrir|traga|trazer|traz|busc[ae]r?|procur[ae]r?|ach[ae]r?|encontr[ae]r?|quero|ver|a|o|as|os|um|uma|tabela|registro|do|da|de|dos|das)\b/g, ' ')
    .replace(/\s+/g, ' ').trim() || q;
}

function falavel(v) {
  if (v == null) return 'nenhum';
  if (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v))) return Number(v).toLocaleString('pt-BR');
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    return new Date(v).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: /T|\s\d/.test(v) ? 'short' : undefined });
  }
  return String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 120);
}

// ---------- voz ----------
const vozCache = new Map();
function voz(texto) {
  texto = String(texto || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!texto) return Promise.reject(new HttpError(400, 'texto vazio'));
  if (vozCache.has(texto)) return vozCache.get(texto);
  const p = new Promise((resolve, reject) => {
    // tom um pouco mais grave e pausado, para soar como mordomo
    const arq = path.join(os.tmpdir(), `cerebro-voz-${process.pid}-${Math.random().toString(36).slice(2)}.mp3`);
    const ch = spawn(EDGE_TTS, ['--voice', VOZ, '--rate=-4%', '--pitch=-6Hz', '--text', texto, '--write-media', arq], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const t = setTimeout(() => ch.kill('SIGKILL'), 20000);
    ch.stderr.on('data', (b) => { err += b; });
    ch.on('error', (e) => { clearTimeout(t); reject(new HttpError(503, `edge-tts indisponível: ${e.message}`)); });
    ch.on('close', (code) => {
      clearTimeout(t);
      let buf = null;
      try { buf = fs.readFileSync(arq); fs.unlinkSync(arq); } catch { /* não gerou */ }
      if (code === 0 && buf && buf.length) resolve(buf);
      else reject(new HttpError(502, `edge-tts falhou: ${err.trim().split('\n').pop() || code}`));
    });
  });
  vozCache.set(texto, p);
  p.catch(() => vozCache.delete(texto));
  if (vozCache.size > 200) vozCache.delete(vozCache.keys().next().value);
  return p;
}

module.exports = { ouvir, perguntar, voz, mapa };
