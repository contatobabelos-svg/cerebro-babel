// Teste ponta a ponta do Cérebro Babel.
// Sobe um servidor próprio na porta 3078 com CEREBRO_NO_OPEN=1 (nunca chama xdg-open)
// e ainda intercepta /api/open no navegador. Screenshots vão para prints/.
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_PATH || '/home/marcos/.npm/_npx/e41f203b7505f1fb/node_modules/playwright';
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
  env: { ...process.env, CEREBRO_PORT: String(PORT), CEREBRO_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'inherit'],
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d; });
for (let i = 0; i < 50 && !srvLog.includes('Cérebro Babel em'); i++) await sleep(100);

const post = (body, headers = { 'Content-Type': 'application/json', 'X-Cerebro': '1' }) =>
  fetch(`${B}/api/open`, { method: 'POST', headers, body: JSON.stringify(body) });

try {
  console.log('\n[segurança]');
  ok((await post({ path: '/etc/passwd' })).status === 403, 'abrir recusa /etc/passwd');
  ok((await post({ path: '../../etc' })).status === 403, 'abrir recusa path traversal ../../etc');
  ok((await post({ path: '/home' })).status === 403, 'abrir recusa /home (pai da home)');
  ok((await post({ path: '.ssh' })).status === 403, 'abrir recusa pasta oculta');
  const link = path.join(ROOT, 'tests', 'link-para-fora');
  rmSync(link, { force: true });
  symlinkSync('/etc', link);
  ok((await post({ path: path.relative(os.homedir(), link) })).status === 403, 'abrir recusa symlink que aponta para fora da home');
  ok((await fetch(`${B}/api/text?path=${encodeURIComponent(path.relative(os.homedir(), link) + '/hostname')}`)).status === 403, 'prévia recusa symlink para fora');
  rmSync(link, { force: true });
  ok((await post({ path: 'Imagens' }, { 'Content-Type': 'application/json' })).status === 403, 'abrir exige cabeçalho X-Cerebro (anti-CSRF)');
  const r = await post({ path: 'Imagens' });
  ok(r.status === 200 && (await r.json()).mocked === true, 'abrir caminho válido responde ok (simulado, sem xdg-open)');
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
  // usa o Google Chrome do sistema (tem H.264, como o lançador); cai no Chromium do Playwright se não houver
  const chrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((f) => existsSync(f));
  const browser = await chromium.launch({ executablePath: chrome, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400) erros.push(`HTTP ${r.status()} ${decodeURIComponent(r.url())}`); });
  const aberturas = [];
  await page.route('**/api/open', (route) => {
    aberturas.push(JSON.parse(route.request().postData() || '{}').path);
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"mocked":true}' });
  });
  // No Chrome headless com swiftshader (~1 fps) as transições CSS ficam pendentes para sempre
  // (acontece também na v1). Só nos testes, desliga as transições para os prints saírem estáveis.
  const semTransicao = () => page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
  const abrir = async () => {
    await page.goto(B, { timeout: 90000 });
    await semTransicao();
    await page.waitForFunction(() => window.__cerebro && window.__cerebro.nodes.size > 5, null, { timeout: 20000 });
  };
  const st = () => page.evaluate(() => window.__cerebro.state());
  const esperar = async (fn, arg, ms = 15000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  const cameraParada = async () => { await esperar(() => !window.__cerebro.state().camBusy, null, 20000); await sleep(1600); };

  await abrir();
  await sleep(7000);
  const top = await page.evaluate(() => [...window.__cerebro.nodes.values()].filter((n) => n.depth === 1).map((n) => n.name));
  ok(top.includes('Imagens') && top.includes('Documentos'), `linhas neurais carregadas (${top.length} no 1º nível)`);
  await page.screenshot({ path: path.join(PRINTS, 'v2-01-cerebro.png') });

  // ---------- painel de controle ----------
  const noPainel = await page.evaluate(() => ['#busca', '#legenda li', '#zoom-mais', '#zoom-menos', '#nos-mais', '#nos-menos', '#btn-home', '#btn-voltar', '#btn-avancar', '.atalhos li']
    .every((s) => document.querySelector('#painel ' + s)));
  ok(noPainel, 'painel inferior esquerdo reúne busca, legenda, zoom, nós, voltar ao cérebro e atalhos');
  await page.click('#painel-recolher');
  await sleep(600);
  const recolhido = await page.evaluate(() => ({ cls: document.querySelector('#painel').classList.contains('recolhido'), ls: localStorage.getItem('cerebro.painel'), botao: getComputedStyle(document.querySelector('#painel-abrir')).opacity, corpo: getComputedStyle(document.querySelector('#painel-corpo')).visibility }));
  ok(recolhido.cls && recolhido.ls === 'recolhido' && recolhido.botao === '1' && recolhido.corpo === 'hidden', 'botão recolhe o painel e guarda o estado');
  await page.screenshot({ path: path.join(PRINTS, 'v2-02-painel-recolhido.png') });
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
  await focar('Documentos');
  const hp = await apontar('Documentos');
  ok(hp.viu, 'hover em pasta mostra o card');
  await esperar(() => document.querySelector('#popup .grafico .pilha i'), null, 10000);
  await sleep(1500);
  const hud = await page.evaluate(() => {
    const p = document.querySelector('#popup');
    return {
      cantos: p.querySelectorAll('.canto').length, meta: p.querySelectorAll('.hud-meta dt').length, medidor: !!p.querySelector('.medidor .barra i'),
      grafico: p.querySelectorAll('.grafico li').length, trilha: !!p.querySelector('.onde .raiz'), scan: !!p.querySelector('.scan'),
      guia: document.querySelector('#guia').classList.contains('on'), mono: getComputedStyle(p.querySelector('.hud-meta dd')).fontFamily,
    };
  });
  ok(hud.cantos === 4 && hud.meta >= 3 && hud.medidor && hud.grafico >= 1 && hud.trilha && hud.scan && hud.guia && /mono/i.test(hud.mono),
    `card HUD: cantos, metadados mono, medidor, gráfico por tipo (${hud.grafico}), breadcrumb, varredura e linha-guia`);
  await page.screenshot({ path: path.join(PRINTS, 'v2-03-hover-pasta.png') });
  await page.locator('#popup').screenshot({ path: path.join(PRINTS, 'v2-03b-card-pasta.png') });

  // ---------- duplo clique em pasta: entra no próprio Cérebro, sem /api/open ----------
  await page.mouse.dblclick(hp.c.x, hp.c.y);
  const entrou = await esperar(() => window.__cerebro.state().focusId === 'Documentos' && window.__cerebro.state().helix.length > 0, null, 15000);
  await sleep(1500);
  ok(entrou, 'duplo clique em pasta entra nela (foco + DNA)');
  ok(aberturas.length === 0, 'duplo clique em pasta NÃO chama /api/open (nada de Thunar)');
  let s1 = await st();
  ok(JSON.stringify(s1.back) === '[null]', `duplo clique entra no histórico (voltar: ${JSON.stringify(s1.back)})`);
  await longe();
  await cameraParada();
  await sleep(4000);

  // ---------- foco esmaece o resto ----------
  const foco = await page.evaluate(() => {
    const c = window.__cerebro;
    const s = c.state();
    const outro = c.nodes.get('Imagens');
    const filho = c.nodes.get(s.helix[0]);
    let opOutro = 1;
    outro.__obj.traverse((m) => { if (m.isMesh) opOutro = Math.min(opOutro, m.material.opacity); });
    let opFilho = 0;
    filho.__obj.traverse((m) => { if (m.isMesh) opFilho = Math.max(opFilho, m.material.opacity); });
    const lblOutro = Number(outro.__label.element.style.opacity);
    return { dimK: s.dimK, outroDim: outro.__dimmed, filhoDim: filho.__dimmed, opOutro, opFilho, lblOutro };
  });
  ok(foco.dimK > 0.9 && foco.outroDim && !foco.filhoDim && foco.opOutro < 0.2 && foco.opFilho > 0.9 && foco.lblOutro < 0.3,
    `foco esmaece as outras pastas (opacidade ${foco.opOutro.toFixed(2)}, rótulo ${foco.lblOutro}) e mantém os filhos acesos (${foco.opFilho.toFixed(2)})`);

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
      rotulos: lbls.length, texto: lbls[0]?.textContent || '', sobrepostos: (() => {
        const rs = lbls.map((e) => e.firstChild.getBoundingClientRect());
        let k = 0;
        for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (rs[i].left < rs[j].right - 2 && rs[i].right > rs[j].left + 2 && rs[i].top < rs[j].bottom - 2 && rs[i].bottom > rs[j].top + 2) k++;
        return k;
      })(),
    };
  });
  ok(dna.n > 10 && dna.raioErro < 0.5 && dna.pares && dna.desce && dna.altura > dna.R * 2,
    `arquivos em dupla hélice vertical (${dna.n} pontos, raio ${dna.R.toFixed(1)}, altura ${dna.altura.toFixed(0)}, pares no mesmo nível)`);
  ok(dna.rotulos >= 8 && /·/.test(dna.texto) && dna.sobrepostos <= 1, `rótulos presos aos pontos do DNA (${dna.rotulos} visíveis, ${dna.sobrepostos} sobreposições): "${dna.texto.slice(0, 60)}"`);
  const g0 = (await st()).spin;
  await sleep(2500);
  ok((await st()).spin > g0, 'a hélice gira devagar');
  await page.screenshot({ path: path.join(PRINTS, 'v2-04-foco-dna.png') });

  // ---------- hover em arquivo do DNA ----------
  await page.evaluate(() => window.__cerebro.setSpin(false));
  await sleep(1200);
  const naTela = (pred) => page.evaluate(`(() => { const c = window.__cerebro; return c.state().helix.map((id) => c.nodes.get(id)).filter(${pred})
    .map((n) => ({ id: n.id, ...c.graph.graph2ScreenCoords(n.x, n.y, n.z) })).filter((p) => p.x > 420 && p.x < 1300 && p.y > 140 && p.y < 820)
    .sort((a, b) => Math.abs(a.x - 800) - Math.abs(b.x - 800))[0]?.id })()`);
  const pdf = await naTela("(n) => /\\.pdf$/i.test(n.name)");
  if (pdf) {
    const h = await apontar(pdf);
    ok(h.viu, `hover em arquivo do DNA mostra o card ("${h.nome}")`);
    await esperar(() => { const i = document.querySelector('#popup .media.pdf img'); return i && i.complete && i.naturalWidth > 0; }, null, 20000);
    await sleep(800);
    ok(await page.evaluate(() => { const i = document.querySelector('#popup .media.pdf img'); return !!i && i.naturalWidth > 0; }), 'card do PDF mostra a 1ª página');
    await page.screenshot({ path: path.join(PRINTS, 'v2-05-hover-arquivo-dna.png') });
    await page.locator('#popup').screenshot({ path: path.join(PRINTS, 'v2-05b-card-pdf.png') });

    // ---------- duplo clique em arquivo: visor grande dentro do app ----------
    await page.mouse.dblclick(h.c.x, h.c.y);
    const visorAbriu = await esperar(() => !document.querySelector('#visor').hidden, null, 8000);
    await esperar(() => { const i = document.querySelector('#pdf-img'); return i && i.complete && i.naturalWidth > 0; }, null, 30000);
    await sleep(1500);
    ok(visorAbriu && aberturas.length === 0, 'duplo clique em arquivo abre o visor do app (sem /api/open)');
    ok(await page.evaluate(() => { const i = document.querySelector('#pdf-img'); return !!i && i.naturalWidth >= 800; }), 'visor mostra a página do PDF em tamanho grande');
    await page.screenshot({ path: path.join(PRINTS, 'v2-06-visor-pdf.png') });
    await page.click('#visor-abrir');
    for (let i = 0; i < 20 && !aberturas.length; i++) await sleep(200);
    ok(aberturas[0] === pdf, 'botão "abrir no aplicativo padrão" pede o xdg-open só quando clicado (interceptado)');
    aberturas.length = 0;
    await page.keyboard.press('Escape');
    await sleep(500);
    ok(await page.evaluate(() => document.querySelector('#visor').hidden), 'Esc fecha o visor');
  } else ok(false, 'achar PDF de Documentos visível no DNA');
  const md = await page.evaluate(() => window.__cerebro.state().helix.find((id) => /\.(md|txt)$/i.test(id)));
  if (md) {
    await page.evaluate((id) => window.__cerebro.openVisor(window.__cerebro.nodes.get(id)), md);
    await esperar(() => (document.querySelector('.v-txt')?.textContent || 'lendo…') !== 'lendo…', null, 8000);
    ok(await page.evaluate(() => (document.querySelector('.v-txt')?.textContent || '').length > 20), 'visor mostra texto completo');
    await page.screenshot({ path: path.join(PRINTS, 'v2-06b-visor-texto.png') });
    await page.keyboard.press('Escape');
  }
  await longe();
  await page.evaluate(() => window.__cerebro.setSpin(true));

  // ---------- Espaço / Q / E ----------
  await page.evaluate(() => window.__cerebro.navigate('Imagens'));
  await esperar(() => window.__cerebro.state().focusId === 'Imagens' && window.__cerebro.state().helix.length > 0, null, 15000);
  const mais = await page.evaluate(() => window.__cerebro.nodes.has('Imagens#mais') && window.__cerebro.nodes.get('Imagens#mais').name);
  ok(!!mais, `pasta grande mostra nó "${mais}" no fim do DNA`);
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
  await tecla('q', 'Imagens', 'Q volta para trás');
  await tecla('q', 'Documentos', 'Q de novo');
  await tecla('e', 'Imagens', 'E refaz');
  await tecla('e', null, 'E refaz de novo');
  await tecla('q', 'Imagens', 'Q depois do E');
  await page.click('#busca');
  await page.keyboard.type('qe ');
  await sleep(600);
  ok((await st()).focusId === 'Imagens', 'Q/E/Espaço não navegam enquanto digita na busca');
  await page.fill('#busca', '');
  await page.evaluate(() => document.activeElement.blur());
  // Q sem histórico sobe para a pasta pai
  await page.evaluate(async () => {
    const c = window.__cerebro;
    const sub = [...c.nodes.values()].find((n) => n.parent === 'Imagens' && n.type === 'dir');
    if (sub) await c.navigate(sub.id);
  });
  const sub = (await st()).focusId;
  if (sub && sub !== 'Imagens') {
    await page.evaluate(() => window.__cerebro.clearHistory());
    await tecla('q', 'Imagens', `Q sem histórico sobe de "${sub}" para a pasta pai`);
  }
  await cameraParada();
  await sleep(2500);
  await page.screenshot({ path: path.join(PRINTS, 'v2-07-foco-imagens.png') });

  // ---------- clique na pasta em foco recolhe e volta um nível ----------
  await page.evaluate(() => window.__cerebro.setSpin(false));
  const hi = await apontar('Imagens');
  await page.mouse.click(hi.c.x, hi.c.y);
  const recolheu = await esperar(() => window.__cerebro.state().focusId === null && !window.__cerebro.nodes.get('Imagens').expanded, null, 10000);
  ok(recolheu && await page.evaluate(() => ![...window.__cerebro.nodes.values()].some((n) => n.parent === 'Imagens')), 'clicar na pasta em foco recolhe e volta ao nível de cima');
  await page.evaluate(() => window.__cerebro.setSpin(true));
  await longe();

  // ---------- busca (no painel) ----------
  await page.locator('#busca').fill('MENSAGEM');
  await page.waitForSelector('#resultados.on button', { timeout: 8000 }).catch(() => {});
  await sleep(600);
  await page.screenshot({ path: path.join(PRINTS, 'v2-08-busca.png') });
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
    ok(await page.evaluate((p) => { const n = window.__cerebro.nodes.get(p); return !!n.__dna && n.__dna.visible && n.__dna.element.classList.contains('forte'); }, alvo), 'o arquivo buscado fica destacado com o rótulo no DNA');
    await page.screenshot({ path: path.join(PRINTS, 'v2-09-busca-revelou.png') });
  } else ok(false, 'busca retorna resultados');

  // voltar ao cérebro pelo botão
  await page.locator('#btn-home').click();
  await esperar(() => window.__cerebro.state().focusId === null, null, 5000);
  await cameraParada();
  await esperar(() => window.__cerebro.state().dimK < 0.05, null, 15000);
  await sleep(1500);
  ok((await st()).focusId === null && (await st()).dimK < 0.05, 'botão "voltar ao cérebro" sai do foco e reacende tudo');
  await page.screenshot({ path: path.join(PRINTS, 'v2-10-voltar-cerebro.png') });

  // movimento reduzido
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => erros.push('[reduzido] ' + e));
  p2.on('console', (m) => { if (m.type() === 'error') erros.push('[reduzido] ' + m.text()); });
  await p2.route('**/api/open', (route) => { aberturas.push('[reduzido]'); route.fulfill({ status: 200, body: '{}' }); });
  await p2.goto(B, { timeout: 90000 });
  await p2.waitForFunction(() => window.__cerebro && window.__cerebro.nodes.size > 5, null, { timeout: 20000 });
  ok(await p2.evaluate(() => document.body.classList.contains('reduzido')), 'respeita prefers-reduced-motion');
  await p2.evaluate(() => window.__cerebro.navigate('Documentos'));
  await p2.waitForFunction(() => window.__cerebro.state().helix.length > 0, null, { timeout: 15000 }).catch(() => {});
  const g1 = await p2.evaluate(() => window.__cerebro.state().spin);
  await sleep(2000);
  ok(await p2.evaluate((g) => window.__cerebro.state().spin === g && getComputedStyle(document.querySelector('.pulso')).animationName === 'none', g1), 'movimento reduzido: hélice parada e sem animações CSS');
  await ctx2.close();

  ok(aberturas.length === 0, `nenhum /api/open fora do botão explícito (${aberturas.length})`);
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
