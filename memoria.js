// Memória do Cérebro: o que ele sabe do dono e o histórico das conversas por voz.
// Fica num projeto Supabase à parte (conta contato.babel.os, schema privado "cerebro", fora da API pública),
// acessado pela Management API com o mesmo ~/.supabase/access-token. O token nunca vai ao navegador.
// Os fatos e as últimas conversas vão para a Groq junto com a pergunta, para ela responder lembrando.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJETO = process.env.CEREBRO_MEMORIA_PROJECT || 'fvvpkukstbagyhtuhsuu';
// desligada com CEREBRO_MEMORIA=off (os testes usam isso para não escrever no banco de verdade)
const ATIVA = process.env.CEREBRO_MEMORIA !== 'off' && process.env.CEREBRO_FONTE !== 'teste';
const MAX_FATOS = 60;
const MAX_TURNOS = 8;

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  try { return fs.readFileSync(path.join(os.homedir(), '.supabase', 'access-token'), 'utf8').trim(); } catch { return null; }
}

// literal SQL seguro (standard_conforming_strings está ligado no Supabase)
const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/\u0000/g, '').replace(/'/g, "''")}'`);

async function sql(query, readOnly = false) {
  const t = token();
  if (!t) throw new Error('sem ~/.supabase/access-token');
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJETO}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, read_only: readOnly }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`memória ${r.status}: ${String(body?.message || '').slice(0, 200)}`);
  return body || [];
}

// nunca derruba o assistente: sem memória, ele só responde sem lembrar
async function seguro(fn, padrao) {
  if (!ATIVA) return padrao;
  try { return await fn(); } catch (e) { console.error(e.message); return padrao; }
}

// texto para o prompt: fatos numerados (o id serve para esquecer) + últimas falas, da mais antiga para a mais nova
function contexto() {
  return seguro(async () => {
    const [fatos, turnos] = await Promise.all([
      sql(`select id, fato from cerebro.memorias order by atualizado_em desc limit ${MAX_FATOS}`, true),
      sql(`select pergunta, fala, criado_em from cerebro.conversas order by criado_em desc limit ${MAX_TURNOS}`, true),
    ]);
    const partes = [];
    if (fatos.length) partes.push('O que você sabe do usuário (id: fato):\n' + fatos.map((f) => `${f.id}: ${f.fato}`).join('\n'));
    if (turnos.length) {
      partes.push('Últimas conversas (mais antiga primeiro):\n' + turnos.reverse()
        .map((t) => `[${new Date(t.criado_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] Usuário: ${t.pergunta}${t.fala ? `\nCérebro: ${t.fala}` : ''}`).join('\n'));
    }
    return partes.join('\n\n');
  }, '');
}

function lembrar(fato) {
  fato = String(fato || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!fato) return Promise.resolve(false);
  return seguro(async () => {
    await sql(`insert into cerebro.memorias (fato) values (${lit(fato)})
      on conflict (lower(fato)) do update set atualizado_em = now()`);
    return true;
  }, false);
}

function esquecer(ids) {
  const lista = [].concat(ids).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!lista.length) return Promise.resolve(0);
  return seguro(async () => (await sql(`delete from cerebro.memorias where id in (${lista.join(',')}) returning id`)).length, 0);
}

function registrar({ pergunta, acao, fala, sql: consulta }) {
  return seguro(() => sql(`insert into cerebro.conversas (pergunta, acao, fala, sql)
    values (${lit(String(pergunta).slice(0, 1000))}, ${lit(acao)}, ${lit(fala && String(fala).slice(0, 1000))}, ${lit(consulta && String(consulta).slice(0, 4000))})`), null);
}

module.exports = { ativa: ATIVA, contexto, lembrar, esquecer, registrar };
