// Teste ponta a ponta do Cérebro Babel.
// Sobe um servidor próprio na porta 3078 com CEREBRO_FONTE=teste: um banco falso em memória (fonte-teste.js),
// então o teste nunca toca no Supabase de verdade. Screenshots vão para prints/.
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, existsSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_PATH || path.join(os.homedir(), '.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const { chromium } = require(PW);

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3078;
const B = `http://127.0.0.1:${PORT}`;
const PRINTS = path.join(ROOT, 'prints');
mkdirSync(PRINTS, { recursive: true });

let falhas = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok ' : 'FALHA'}  ${msg}`); if (!cond) falhas++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, CEREBRO_PORT: String(PORT), CEREBRO_FONTE: 'teste' }, stdio: ['ignore', 'pipe', 'inherit'],
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d; });
for (let i = 0; i < 50 && !srvLog.includes('Cérebro Babel em'); i++) await sleep(100);

try {
  console.log('\n[segurança]');
  const raw = (p, init) => fetch(B + p, init);
  ok((await raw('/api/list', { method: 'POST' })).status === 405, 'API só aceita leitura: POST em /api/list é recusado (405)');
  ok((await raw('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cerebro': '1' }, body: '{"path":"x"}' })).status === 405, '/api/open não existe mais (nada abre programas no computador)');
  ok((await raw('/api/list?path=nao_existe')).status === 404, 'schema inexistente responde 404');
  ok((await raw('/api/list?path=public%00x')).status === 400, 'caminho com byte nulo é recusado (400)');
  ok((await raw('/api/list?path=public/cadastros/x/y/z')).status === 400, 'caminho fundo demais é recusado (400)');
  const info = await (await raw('/api/info')).json();
  ok(info.fonte === 'teste' && !/sbp_|eyJ/.test(JSON.stringify(info)), 'info não vaza token nem chave');
  const usr = await (await raw('/api/list?path=auth/users&limit=1')).json();
  const usrTxt = await (await raw(`/api/text?path=${encodeURIComponent(usr.items[0].path)}&full=1`)).json();
  ok(usrTxt.text.includes('(oculto)') && !usrTxt.text.includes('$2a$10') && !/tok0|segredo/.test(usrTxt.text), 'senha e tokens de auth.users saem ocultos');
  ok(!/\$2a\$10|segredo/.test(JSON.stringify(await (await raw('/api/search?q=segredo')).json())), 'busca não encontra valor de coluna secreta');
  const perf = await (await raw('/api/list?path=public/perfis&limit=1')).json();
  const im = await raw(`/api/media?path=${encodeURIComponent(perf.items[0].path)}`);
  ok(im.status === 200 && im.headers.get('content-type') === 'image/png' && im.headers.get('content-security-policy') === 'sandbox', 'imagem dentro de uma linha é servida com CSP sandbox');
  const hostStatus = await new Promise((res) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/info', headers: { Host: 'evil.example:3078' } }, (r) => { r.resume(); res(r.statusCode); }).on('error', () => res(0)));
  ok(hostStatus === 421, 'Host estranho é recusado (anti DNS-rebinding)');

  console.log('\n[rede]');
  const ss = execSync(`ss -ltnH 'sport = :${PORT}'`).toString().trim();
  ok(ss.includes(`127.0.0.1:${PORT}`) && !ss.includes(`0.0.0.0:${PORT}`) && !ss.includes(`*:${PORT}`) && !ss.includes(`[::]:${PORT}`), `escuta só em 127.0.0.1 (${ss.split(/\s+/)[3]})`);
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (lan) {
    const recusado = await new Promise((res) => {
      const s = net.connect({ host: lan.address, port: PORT, timeout: 1500 });
      s.on('connect', () => { s.destroy(); res(false); });
      s.on('error', () => res(true));
      s.on('timeout', () => { s.destroy(); res(true); });
    });
    ok(recusado, `conexão pelo IP da rede ${lan.address} é recusada`);
  }

  console.log('\n[navegador 1440×900]');
  // usa o Google Chrome do sistema; cai no Chromium do Playwright se não houver
  const chrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((f) => existsSync(f));
  const browser = await chromium.launch({ executablePath: chrome, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400) erros.push(`HTTP ${r.status()} ${decodeURIComponent(r.url())}`); });
  // No Chrome headless com swiftshader (~1 fps) as transições CSS ficam pendentes para sempre.
  // Só nos testes, desliga as transições para os prints saírem estáveis.
  const semTransicao = () => page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
  const abrir = async () => {
    await page.goto(B, { timeout: 90000 });
    await semTransicao();
    // o painel do Supabase só abre por clique explícito: captura em vez de abrir uma aba
    await page.evaluate(() => { window.__abertos = []; window.open = (u) => { window.__abertos.push(u); return null; }; });
    await page.waitForFunction(() => window.__cerebro && window.__cerebro.nodes.size > 5, null, { timeout: 20000 });
  };
  const st = () => page.evaluate(() => window.__cerebro.state());
  const esperar = async (fn, arg, ms = 15000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const cameraParada = async () => { await esperar(() => !window.__cerebro.state().camBusy, null, 20000); await sleep(1600); };

  await abrir();
  await sleep(7000);
  const top = await page.evaluate(() => [...window.__cerebro.nodes.values()].filter((n) => n.depth === 1).map((n) => n.name));
  ok(['public', 'auth', 'storage', 'Edge Functions', 'Buckets'].every((n) => top.includes(n)), `linhas neurais: schemas, Edge Functions e Buckets (${top.length} no 1º nível: ${top.join(', ')})`);
  ok(await page.evaluate(() => document.querySelector('#host').textContent.includes('Reino')) && (await page.title()).includes('Reino'), 'centro do cérebro é o projeto Supabase (nome no topo e no título)');
  ok(!(await page.evaluate(() => document.body.innerText)).includes('~/'), 'nenhum resto de "~/" (pasta do computador) na tela');
  await page.screenshot({ path: path.join(PRINTS, 'v3-01-cerebro.png') });

  // ---------- painel de controle ----------
  const noPainel = await page.evaluate(() => ['#busca', '#legenda li', '#zoom-mais', '#zoom-menos', '#nos-mais', '#nos-menos', '#btn-home', '#btn-voltar', '#btn-avancar', '.atalhos li']
    .every((s) => document.querySelector('#painel ' + s)));
  ok(noPainel, 'painel inferior esquerdo reúne busca, legenda, zoom, nós, voltar ao cérebro e atalhos');
  const legenda = await page.evaluate(() => [...document.querySelectorAll('#legenda li')].map((l) => l.textContent));
  ok(['Schema', 'Tabela', 'View', 'Função', 'Linha', 'Edge Function', 'Bucket'].every((l) => legenda.includes(l)), `legenda fala de banco (${legenda.join(', ')})`);
  await page.click('#painel-recolher');
  await sleep(600);
  const recolhido = await page.evaluate(() => ({ cls: document.querySelector('#painel').classList.contains('recolhido'), ls: localStorage.getItem('cerebro.painel'), botao: getComputedStyle(document.querySelector('#painel-abrir')).opacity, corpo: getComputedStyle(document.querySelector('#painel-corpo')).visibility }));
  ok(recolhido.cls && recolhido.ls === 'recolhido' && recolhido.botao === '1' && recolhido.corpo === 'hidden', 'botão recolhe o painel e guarda o estado');
  await page.screenshot({ path: path.join(PRINTS, 'v3-02-painel-recolhido.png') });
  await abrir();
  ok(await page.evaluate(() => document.querySelector('#painel').classList.contains('recolhido')), 'painel continua recolhido depois de recarregar');
  await page.click('#painel-abrir');
  await sleep(600);
  ok(await page.evaluate(() => !document.querySelector('#painel').classList.contains('recolhido') && localStorage.getItem('cerebro.painel') === 'aberto'), 'painel expande de novo e lembra');
  await sleep(6000);

  // coordenada de tela de um nó
  const coords = (id) => page.evaluate((id) => {
    const n = window.__cerebro.nodes.get(id);
    const cam = window.__cerebro.graph.camera();
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const c = window.__cerebro.graph.graph2ScreenCoords(n.x, n.y, n.z);
    return { x: c.x, y: c.y };
  }, id);
  const focar = async (id) => {
    await esperar(() => document.body.classList.contains('estavel'), null, 15000);
    await page.evaluate((id) => window.__cerebro.flyTo(window.__cerebro.nodes.get(id), 900), id);
    await cameraParada();
  };
  // aponta e espera o hover registrar (em poucos fps o clique pode chegar antes do quadro)
  const apontar = async (id) => {
    const nome = await page.evaluate((id) => window.__cerebro.nodes.get(id).name, id);
    const c = await coords(id);
    await page.mouse.move(c.x - 1, c.y);
    await page.mouse.move(c.x, c.y);
    const viu = await esperar((n) => document.querySelector('#popup.on h3')?.textContent === n, nome, 10000);
    await sleep(300);
    return { c, viu, nome };
  };
  const longe = async () => { await page.mouse.move(1430, 450); await sleep(700); };

  // ---------- card HUD ao passar o mouse ----------
  await focar('public');
  const hp = await apontar('public');
  ok(hp.viu, 'hover em schema mostra o card');
  await esperar(() => document.querySelector('#popup .grafico .pilha i'), null, 10000);
  await sleep(1500);
  const hud = await page.evaluate(() => {
    const p = document.querySelector('#popup');
    return {
      cantos: p.querySelectorAll('.canto').length, meta: p.querySelectorAll('.hud-meta dt').length, medidor: !!p.querySelector('.medidor .barra i'),
      grafico: p.querySelectorAll('.grafico li').length, trilha: !!p.querySelector('.onde .raiz'), scan: !!p.querySelector('.scan'),
      guia: document.querySelector('#guia').classList.contains('on'), mono: getComputedStyle(p.querySelector('.hud-meta dd')).fontFamily,
      tipo: p.querySelector('.tipo').textContent, legivel: p.textContent,
    };
  });
  ok(hud.cantos === 4 && hud.meta >= 3 && hud.medidor && hud.grafico >= 2 && hud.trilha && hud.scan && hud.guia && /mono/i.test(hud.mono),
    `card HUD: cantos, metadados mono, medidor, gráfico por tipo (${hud.grafico}), breadcrumb, varredura e linha-guia`);
  ok(hud.tipo === 'Schema' && /TAB|Tabela|tabela/i.test(hud.legivel), `card do schema fala de banco ("${hud.tipo}")`);
  await page.screenshot({ path: path.join(PRINTS, 'v3-03-hover-schema.png') });
  await page.locator('#popup').screenshot({ path: path.join(PRINTS, 'v3-03b-card-schema.png') });

  // ---------- duplo clique em schema: entra nele dentro do próprio Cérebro ----------
  await page.mouse.dblclick(hp.c.x, hp.c.y);
  const entrou = await esperar(() => window.__cerebro.state().focusId === 'public' && window.__cerebro.state().helix.length > 0, null, 15000);
  await sleep(1500);
  ok(entrou, 'duplo clique em schema entra nele (foco + DNA)');
  ok(await page.evaluate(() => window.__abertos.length === 0), 'duplo clique não abre nada fora do app');
  let s1 = await st();
  ok(JSON.stringify(s1.back) === '[null]', `duplo clique entra no histórico (voltar: ${JSON.stringify(s1.back)})`);
  await longe();
  await cameraParada();
  await sleep(4000);

  // ---------- foco esmaece o resto ----------
  const foco = await page.evaluate(() => {
    const c = window.__cerebro;
    const s = c.state();
    const outro = c.nodes.get('auth');
    const filho = c.nodes.get(s.helix[0]);
    let opOutro = 1;
    outro.__obj.traverse((m) => { if (m.isMesh) opOutro = Math.min(opOutro, m.material.opacity); });
    let opFilho = 0;
    filho.__obj.traverse((m) => { if (m.isMesh) opFilho = Math.max(opFilho, m.material.opacity); });
    const lblOutro = Number(outro.__label.element.style.opacity);
    return { dimK: s.dimK, outroDim: outro.__dimmed, filhoDim: filho.__dimmed, opOutro, opFilho, lblOutro };
  });
  ok(foco.dimK > 0.9 && foco.outroDim && !foco.filhoDim && foco.opOutro < 0.2 && foco.opFilho > 0.9 && foco.lblOutro < 0.3,
    `foco esmaece os outros schemas (opacidade ${foco.opOutro.toFixed(2)}, rótulo ${foco.lblOutro}) e mantém os filhos acesos (${foco.opFilho.toFixed(2)})`);

  // ---------- DNA em pé com rótulos ----------
  const dna = await page.evaluate(() => {
    const c = window.__cerebro;
    const s = c.state();
    const h = s.helixGeo;
    const kids = s.helix.map((id) => c.nodes.get(id));
    const raios = kids.map((n) => Math.hypot(n.x - h.origin.x, n.z - h.origin.z));
    const ys = kids.map((n) => n.y);
    const pares = kids.every((n, i) => i % 2 === 0 || Math.abs(n.y - kids[i - 1].y) < 0.01);
    const desce = kids.every((n, i) => i < 2 || n.y < kids[i - 2].y);
    const lbls = [...document.querySelectorAll('.dna')].filter((e) => e.style.display !== 'none');
    return {
      n: kids.length, R: h.R, raioErro: Math.max(...raios.map((r) => Math.abs(r - h.R))), altura: Math.max(...ys) - Math.min(...ys), pares, desce,
      kinds: [...new Set(kids.map((k) => k.kind))].sort().join(','),
      rotulos: lbls.length, texto: lbls[0]?.textContent || '', sobrepostos: (() => {
        const rs = lbls.map((e) => e.firstChild.getBoundingClientRect());
        let k = 0;
        for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (rs[i].left < rs[j].right - 2 && rs[i].right > rs[j].left + 2 && rs[i].top < rs[j].bottom - 2 && rs[i].bottom > rs[j].top + 2) k++;
        return k;
      })(),
    };
  });
  ok(dna.n > 10 && dna.raioErro < 0.5 && dna.pares && dna.desce && dna.altura > dna.R * 1.5,
    `tabelas e funções em dupla hélice vertical (${dna.n} pontos, raio ${dna.R.toFixed(1)}, altura ${dna.altura.toFixed(0)}, pares no mesmo nível)`);
  ok(dna.kinds === 'funcao,tabela,view', `o schema public mostra tabelas, views e funções (${dna.kinds})`);
  ok(dna.rotulos >= 8 && /·/.test(dna.texto) && dna.sobrepostos <= 1, `rótulos presos aos pontos do DNA (${dna.rotulos} visíveis, ${dna.sobrepostos} sobreposições): "${dna.texto.slice(0, 60)}"`);
  const g0 = (await st()).spin;
  await sleep(2500);
  ok((await st()).spin > g0, 'a hélice gira devagar');
  ok(await page.evaluate(() => window.__cerebro.links().some((l) => l.type === 'fk' && (l.source.id || l.source) === 'public/academy_aulas' && (l.target.id || l.target) === 'public/academy_trilhas')), 'chave estrangeira academy_aulas → academy_trilhas vira um fio entre as duas tabelas');
  await page.screenshot({ path: path.join(PRINTS, 'v3-04-foco-dna.png') });

  // ---------- card de tabela: colunas, RLS, políticas ----------
  await page.evaluate(() => window.__cerebro.showPopup(window.__cerebro.nodes.get('public/cadastros')));
  await esperar(() => document.querySelector('#popup ul.colunas li'), null, 10000);
  const tab = await page.evaluate(() => {
    const p = document.querySelector('#popup');
    return { cols: p.querySelectorAll('ul.colunas li').length, pk: !!p.querySelector('ul.colunas li.pk'), rls: /RLS/.test(p.textContent) && /ligado/.test(p.textContent), pol: /cadastros|anon insere/i.test(p.textContent) };
  });
  ok(tab.cols >= 5 && tab.pk && tab.rls && tab.pol, `card da tabela mostra colunas (${tab.cols}), chave primária, RLS e políticas`);
  await page.locator('#popup').screenshot({ path: path.join(PRINTS, 'v3-05-card-tabela.png') });
  await longe();

  // ---------- hover em função do DNA e visor com o SQL ----------
  await page.evaluate(() => window.__cerebro.setSpin(false));
  await sleep(1200);
  const naTela = (pred) => page.evaluate(`(() => { const c = window.__cerebro; return c.state().helix.map((id) => c.nodes.get(id)).filter(${pred})
    .map((n) => ({ id: n.id, ...c.graph.graph2ScreenCoords(n.x, n.y, n.z) })).filter((p) => p.x > 420 && p.x < 1300 && p.y > 140 && p.y < 820)
    .sort((a, b) => Math.abs(a.x - 800) - Math.abs(b.x - 800))[0]?.id })()`);
  const fn = await naTela("(n) => n.kind === 'funcao'");
  if (fn) {
    const h = await apontar(fn);
    ok(h.viu, `hover em função do DNA mostra o card ("${h.nome}")`);
    await esperar(() => /FUNCTION/.test(document.querySelector('#popup pre.txt')?.textContent || ''), null, 10000);
    ok(await page.evaluate(() => /CREATE OR REPLACE FUNCTION/.test(document.querySelector('#popup pre.txt')?.textContent || '')), 'card da função mostra o SQL da definição');
    await page.screenshot({ path: path.join(PRINTS, 'v3-06-hover-funcao.png') });

    // duplo clique em função: visor grande dentro do app
    await page.mouse.dblclick(h.c.x, h.c.y);
    const visorAbriu = await esperar(() => !document.querySelector('#visor').hidden, null, 8000);
    await esperar(() => /FUNCTION/.test(document.querySelector('.v-txt')?.textContent || ''), null, 10000);
    ok(visorAbriu && await page.evaluate(() => window.__abertos.length === 0), 'duplo clique em função abre o visor do app (sem abrir nada fora)');
    ok(await page.evaluate(() => /CREATE OR REPLACE FUNCTION/.test(document.querySelector('.v-txt')?.textContent || '')), 'visor mostra o SQL completo da função');
    await page.screenshot({ path: path.join(PRINTS, 'v3-07-visor-funcao.png') });
    await page.click('#visor-abrir');
    await sleep(300);
    const abertos = await page.evaluate(() => window.__abertos.slice());
    ok(abertos.length === 1 && abertos[0].startsWith('https://supabase.com/dashboard/project/teste/database/functions'), `botão "Abrir no painel do Supabase" só abre no clique (${abertos[0]})`);
    await page.evaluate(() => { window.__abertos.length = 0; });
    await page.keyboard.press('Escape');
    await sleep(500);
    ok(await page.evaluate(() => document.querySelector('#visor').hidden), 'Esc fecha o visor');
  } else ok(false, 'achar função de public visível no DNA');
  await longe();
  await page.evaluate(() => window.__cerebro.setSpin(true));

  // ---------- linhas de uma tabela: imagem, texto e segredos ----------
  await page.evaluate(() => window.__cerebro.navigate('public/perfis'));
  await esperar(() => window.__cerebro.state().focusId === 'public/perfis' && window.__cerebro.state().helix.length >= 6, null, 15000);
  await cameraParada();
  const comImg = await page.evaluate(() => [...window.__cerebro.nodes.values()].find((n) => n.parent === 'public/perfis' && n.img)?.id);
  ok(!!comImg, 'linha com foto ganha imagem (perfis)');
  if (comImg) {
    await page.evaluate((id) => window.__cerebro.showPopup(window.__cerebro.nodes.get(id)), comImg);
    await esperar(() => { const i = document.querySelector('#popup .media img'); return i && i.complete && i.naturalWidth > 0; }, null, 10000);
    ok(await page.evaluate(() => { const i = document.querySelector('#popup .media img'); return !!i && i.naturalWidth > 0; }), 'card da linha mostra a foto guardada na coluna');
    await esperar(() => /"nome"/.test(document.querySelector('#popup pre.txt')?.textContent || ''), null, 10000);
    ok(await page.evaluate(() => /"nome"/.test(document.querySelector('#popup pre.txt')?.textContent || '') && !/data:image\/png;base64,iVBOR/.test(document.querySelector('#popup pre.txt').textContent)), 'card da linha mostra o JSON sem despejar o base64');
    await longe();
    await page.evaluate((id) => window.__cerebro.openVisor(window.__cerebro.nodes.get(id)), comImg);
    await esperar(() => /"nome"/.test(document.querySelector('.v-txt')?.textContent || ''), null, 8000);
    ok(await page.evaluate(() => !!document.querySelector('.v-img-linha') && /"nome"/.test(document.querySelector('.v-txt').textContent)), 'visor da linha mostra a foto e o registro inteiro');
    await page.screenshot({ path: path.join(PRINTS, 'v3-08-visor-linha.png') });
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => window.__cerebro.navigate('auth/users'));
  await esperar(() => window.__cerebro.state().focusId === 'auth/users' && window.__cerebro.state().helix.length >= 3, null, 15000);
  const linhaAuth = await page.evaluate(() => [...window.__cerebro.nodes.values()].find((n) => n.parent === 'auth/users')?.id);
  await page.evaluate((id) => window.__cerebro.openVisor(window.__cerebro.nodes.get(id)), linhaAuth);
  await esperar(() => /"email"/.test(document.querySelector('.v-txt')?.textContent || ''), null, 8000);
  ok(await page.evaluate(() => { const t = document.querySelector('.v-txt').textContent; return /"email"/.test(t) && t.includes('(oculto)') && !t.includes('$2a$10'); }), 'visor de auth.users esconde a senha e os tokens');
  await page.keyboard.press('Escape');
  await longe();

  // ---------- Edge Functions e Buckets ----------
  await page.evaluate(() => window.__cerebro.navigate('@edge'));
  await esperar(() => window.__cerebro.state().focusId === '@edge' && window.__cerebro.state().helix.length === 4, null, 15000);
  ok((await st()).helix.length === 4, 'Edge Functions lista as 4 funções');
  await page.evaluate(() => window.__cerebro.openVisor(window.__cerebro.nodes.get('@edge/reino-login')));
  await esperar(() => /Deno\.serve|slug|reino-login/.test(document.querySelector('.v-txt')?.textContent || ''), null, 8000);
  ok(await page.evaluate(() => /reino-login/.test(document.querySelector('.v-txt').textContent)), 'visor da Edge Function mostra o código');
  await page.click('#visor-abrir');
  await sleep(300);
  ok(await page.evaluate(() => window.__abertos.at(-1) === 'https://supabase.com/dashboard/project/teste/functions/reino-login/details'), 'abrir Edge Function leva ao painel dela');
  await page.evaluate(() => { window.__abertos.length = 0; });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__cerebro.navigate('@buckets/avatares'));
  await esperar(() => window.__cerebro.state().focusId === '@buckets/avatares' && window.__cerebro.state().helix.length === 1, null, 15000);
  ok(await page.evaluate(() => window.__cerebro.nodes.get('@buckets/avatares/u1%2Favatar.png')?.img?.startsWith('/api/media')), 'arquivo de bucket é imagem servida pelo servidor (a chave nunca vai ao navegador)');
  await longe();

  // ---------- Espaço / Q / E ----------
  await page.evaluate(() => window.__cerebro.navigate('public'));
  await esperar(() => window.__cerebro.state().focusId === 'public', null, 15000);
  await page.evaluate(() => window.__cerebro.clearHistory());
  await page.evaluate(() => window.__cerebro.navigate('public/cliques'));
  await esperar(() => window.__cerebro.state().focusId === 'public/cliques' && window.__cerebro.state().helix.length > 0, null, 15000);
  const mais = await page.evaluate(() => window.__cerebro.nodes.has('public/cliques#mais') && window.__cerebro.nodes.get('public/cliques#mais').name);
  ok(!!mais, `tabela grande mostra nó "${mais}" no fim do DNA`);
  await page.locator('#grafo canvas').first().focus().catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  const tecla = async (k, esperado, rotulo) => {
    await page.keyboard.press(k);
    const foi = await esperar((e) => window.__cerebro.state().focusId === e, esperado, 8000);
    const s = await st();
    ok(foi, `${rotulo} → ${esperado ?? 'cérebro'} (voltar ${JSON.stringify(s.back)}, refazer ${JSON.stringify(s.fwd)})`);
    await sleep(900);
  };
  await tecla('Space', null, 'Espaço volta ao cérebro');
  await tecla('q', 'public/cliques', 'Q volta para trás');
  await tecla('q', 'public', 'Q de novo');
  await tecla('e', 'public/cliques', 'E refaz');
  await tecla('e', null, 'E refaz de novo');
  await tecla('q', 'public/cliques', 'Q depois do E');
  await page.click('#busca');
  await page.keyboard.type('qe ');
  await sleep(600);
  ok((await st()).focusId === 'public/cliques', 'Q/E/Espaço não navegam enquanto digita na busca');
  await page.fill('#busca', '');
  await page.evaluate(() => document.activeElement.blur());
  const linhas = await page.evaluate(() => [...window.__cerebro.nodes.values()].filter((n) => n.parent === 'public/cliques' && n.type === 'file').length);
  ok(linhas === 150, `a primeira página da tabela traz 150 linhas (${linhas}) e o resto fica atrás do nó "+mais"`);
  // Q sem histórico sobe para o schema
  await page.evaluate(() => window.__cerebro.clearHistory());
  await tecla('q', 'public', 'Q sem histórico sobe da tabela para o schema');
  await cameraParada();
  await sleep(2500);
  await page.screenshot({ path: path.join(PRINTS, 'v3-09-foco-public.png') });

  // ---------- clique no schema em foco recolhe e volta um nível ----------
  await page.evaluate(() => window.__cerebro.setSpin(false));
  const hi = await apontar('public');
  await page.mouse.click(hi.c.x, hi.c.y);
  const recolheu = await esperar(() => window.__cerebro.state().focusId === null && !window.__cerebro.nodes.get('public').expanded, null, 10000);
  ok(recolheu && await page.evaluate(() => ![...window.__cerebro.nodes.values()].some((n) => n.parent === 'public')), 'clicar no schema em foco recolhe e volta ao nível de cima');
  await page.evaluate(() => window.__cerebro.setSpin(true));
  await longe();

  // ---------- busca (no painel): acha registro pelo conteúdo ----------
  await page.locator('#busca').fill('Beatriz');
  await page.waitForSelector('#resultados.on button', { timeout: 8000 }).catch(() => {});
  await sleep(600);
  await page.screenshot({ path: path.join(PRINTS, 'v3-10-busca.png') });
  const alvo = await page.locator('#resultados button').first().getAttribute('data-path').catch(() => null);
  if (alvo) {
    const antes = (await st()).back.length;
    await page.locator('#resultados button').first().click();
    await esperar((p) => window.__cerebro.nodes.has(p) && window.__cerebro.state().focusId !== null, alvo, 15000);
    await sleep(2500);
    await cameraParada();
    await esperar(() => [...document.querySelectorAll('.dna.forte')].some((e) => e.style.display !== 'none'), null, 10000);
    await sleep(800);
    const s = await st();
    ok(await page.evaluate((p) => window.__cerebro.nodes.has(p), alvo), `busca revela "${alvo}" no grafo`);
    ok(s.focusId !== null && s.back.length === antes + 1, `busca entra no histórico e foca "${s.focusId}"`);
    ok(await page.evaluate((p) => { const n = window.__cerebro.nodes.get(p); return !!n.__dna && n.__dna.visible && n.__dna.element.classList.contains('forte'); }, alvo), 'a linha buscada fica destacada com o rótulo no DNA');
    await page.screenshot({ path: path.join(PRINTS, 'v3-11-busca-revelou.png') });
  } else ok(false, 'busca retorna resultados');
  await page.fill('#busca', 'trilhas');
  ok(await esperar(() => [...document.querySelectorAll('#resultados button')].some((b) => /academy_trilhas/.test(b.textContent)), null, 8000), 'busca acha tabela pelo nome');
  await page.fill('#busca', '');

  // voltar ao cérebro pelo botão
  await page.locator('#btn-home').click();
  await esperar(() => window.__cerebro.state().focusId === null, null, 5000);
  await cameraParada();
  await esperar(() => window.__cerebro.state().dimK < 0.05, null, 15000);
  await sleep(1500);
  ok((await st()).focusId === null && (await st()).dimK < 0.05, 'botão "voltar ao cérebro" sai do foco e reacende tudo');
  await page.screenshot({ path: path.join(PRINTS, 'v3-12-voltar-cerebro.png') });

  // movimento reduzido
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => erros.push('[reduzido] ' + e));
  p2.on('console', (m) => { if (m.type() === 'error') erros.push('[reduzido] ' + m.text()); });
  await p2.goto(B, { timeout: 90000 });
  await p2.waitForFunction(() => window.__cerebro && window.__cerebro.nodes.size > 5, null, { timeout: 20000 });
  ok(await p2.evaluate(() => document.body.classList.contains('reduzido')), 'respeita prefers-reduced-motion');
  await p2.evaluate(() => window.__cerebro.navigate('public'));
  await p2.waitForFunction(() => window.__cerebro.state().helix.length > 0, null, { timeout: 15000 }).catch(() => {});
  const g1 = await p2.evaluate(() => window.__cerebro.state().spin);
  await sleep(2000);
  ok(await p2.evaluate((g) => window.__cerebro.state().spin === g && getComputedStyle(document.querySelector('.pulso')).animationName === 'none', g1), 'movimento reduzido: hélice parada e sem animações CSS');
  await ctx2.close();

  ok(erros.length === 0, `zero erros de console${erros.length ? ': ' + erros.join(' | ') : ''}`);
  await browser.close();
} catch (e) {
  console.error(e);
  falhas++;
} finally {
  srv.kill();
}
console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'} · prints em ${PRINTS}`);
process.exit(falhas ? 1 : 0);
