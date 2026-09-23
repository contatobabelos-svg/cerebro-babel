// Assistente de voz do Cérebro (estilo Jarvis): segure Espaço (ou o reator no rodapé), fale, solte.
// Áudio → /api/ouvir (Whisper) → /api/perguntar (entende e, se for o caso, consulta o banco) → ação no grafo
// → resposta falada por /api/voz (voz neural), terminando em "Aqui está, senhor."
const SEGURAR_MS = 230; // abaixo disso o Espaço é um toque (volta ao cérebro)
const MIN_FALA_MS = 450;

const CSS = `
#jarvis { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 40; display: flex; flex-direction: column; align-items: center; gap: 12px; pointer-events: none; }
#jarvis .j-card { pointer-events: auto; width: min(620px, calc(100vw - 32px)); max-height: 46vh; overflow: auto; padding: 14px 18px; border-radius: 16px;
  background: rgba(6, 14, 36, .82); backdrop-filter: blur(14px); border: 1px solid rgba(63, 227, 255, .35);
  box-shadow: 0 0 40px rgba(63, 227, 255, .12), inset 0 0 30px rgba(63, 227, 255, .05); opacity: 0; transform: translateY(12px); transition: opacity .25s, transform .25s; }
#jarvis.aberto .j-card { opacity: 1; transform: none; }
#jarvis .j-estado { font: 600 10px/1 ui-monospace, 'JetBrains Mono', monospace; letter-spacing: .2em; text-transform: uppercase; color: var(--ciano, #3fe3ff); display: flex; gap: 8px; align-items: center; }
#jarvis .j-estado::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; }
#jarvis[data-estado="ouvindo"] .j-estado { color: #ff5c7a; }
#jarvis[data-estado="pensando"] .j-estado { color: var(--ambar, #ffb547); }
#jarvis .j-voce { margin-top: 10px; font-size: 15px; color: var(--texto-2, #9fb0d6); min-height: 1.4em; }
#jarvis .j-voce:not(:empty)::before { content: '“'; } #jarvis .j-voce:not(:empty)::after { content: '”'; }
#jarvis .j-resp { margin-top: 8px; font: 600 17px/1.4 'Exo 2', Inter, sans-serif; color: var(--texto, #e6efff); }
#jarvis .j-resp:empty { display: none; }
#jarvis table { margin-top: 10px; width: 100%; border-collapse: collapse; font-size: 12px; }
#jarvis th { text-align: left; font: 600 10px/1.2 ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; color: var(--ciano, #3fe3ff); padding: 5px 8px; border-bottom: 1px solid rgba(63, 227, 255, .3); }
#jarvis td { padding: 5px 8px; border-bottom: 1px solid rgba(159, 176, 214, .12); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#jarvis .j-sql { margin-top: 8px; font: 11px/1.4 ui-monospace, monospace; color: var(--texto-2, #9fb0d6); opacity: .7; white-space: pre-wrap; }
#jarvis .j-sql:empty { display: none; }
#jarvis .j-reator { pointer-events: auto; position: relative; width: 64px; height: 64px; border: 0; padding: 0; background: none; cursor: pointer; border-radius: 50%; touch-action: none; }
#jarvis .j-reator svg { width: 100%; height: 100%; overflow: visible; }
#jarvis .j-reator .aro { transform-origin: 50% 50%; animation: j-gira 14s linear infinite; }
#jarvis .j-reator .aro2 { transform-origin: 50% 50%; animation: j-gira 9s linear infinite reverse; }
#jarvis .j-reator .nucleo { transform-origin: 50% 50%; transition: transform .08s; }
#jarvis[data-estado="pensando"] .aro, #jarvis[data-estado="pensando"] .aro2 { animation-duration: 1.4s; }
#jarvis[data-estado="ouvindo"] .j-reator { filter: drop-shadow(0 0 16px rgba(255, 92, 122, .7)); }
#jarvis[data-estado="falando"] .j-reator, #jarvis[data-estado="parado"] .j-reator { filter: drop-shadow(0 0 12px rgba(63, 227, 255, .55)); }
#jarvis .j-dica { font: 600 10px/1 ui-monospace, monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--texto-2, #9fb0d6); opacity: .55; }
#jarvis.aberto .j-dica { opacity: 0; }
@keyframes j-gira { to { transform: rotate(360deg); } }
body.reduzido #jarvis .aro, body.reduzido #jarvis .aro2 { animation: none; }
`;

const HTML = `
<div class="j-card" role="status" aria-live="polite">
  <div class="j-estado">Cérebro</div>
  <div class="j-voce"></div>
  <div class="j-resp"></div>
  <div class="j-tabela"></div>
  <div class="j-sql"></div>
</div>
<button class="j-reator" type="button" aria-label="Segure para falar com o Cérebro" title="Segure para falar (ou segure Espaço)">
  <svg viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="32" r="30" fill="rgba(6,14,36,.85)" stroke="rgba(63,227,255,.35)" stroke-width="1"/>
    <g class="aro"><circle cx="32" cy="32" r="25" fill="none" stroke="#3fe3ff" stroke-width="2" stroke-dasharray="10 6" opacity=".8"/></g>
    <g class="aro2"><circle cx="32" cy="32" r="19" fill="none" stroke="#3b82ff" stroke-width="1.5" stroke-dasharray="3 5"/></g>
    <g class="nucleo"><circle cx="32" cy="32" r="10" fill="#3fe3ff" opacity=".9"/><circle cx="32" cy="32" r="5" fill="#e6f9ff"/></g>
  </svg>
</button>
<div class="j-dica">segure espaço para falar</div>`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function iniciarVoz({ reveal, goBrain, toast, fecharTudo, abrirReino }) {
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);
  const box = document.createElement('div');
  box.id = 'jarvis';
  box.dataset.estado = 'parado';
  box.innerHTML = HTML;
  document.body.appendChild(box);
  const $ = (s) => box.querySelector(s);
  const nucleo = $('.nucleo');

  let estado = 'parado', geracao = 0, fecharTimer = null;
  let ctx = null, stream = null, rec = null, partes = [], inicio = 0, analisador = null, audioAtual = null;
  let pressTimer = null, pressionado = false;

  const setEstado = (e, rotulo) => {
    estado = e;
    box.dataset.estado = e;
    $('.j-estado').textContent = rotulo || { parado: 'Cérebro', ouvindo: 'Ouvindo…', pensando: 'Processando…', falando: 'Cérebro' }[e];
  };
  const abrir = () => { clearTimeout(fecharTimer); box.classList.add('aberto'); };
  const fechar = (ms = 0) => {
    clearTimeout(fecharTimer);
    fecharTimer = setTimeout(() => { box.classList.remove('aberto'); if (estado === 'falando') setEstado('parado'); }, ms);
  };
  const limpar = () => { $('.j-voce').textContent = ''; $('.j-resp').textContent = ''; $('.j-tabela').innerHTML = ''; $('.j-sql').textContent = ''; };

  function audioCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // bipes curtos de início/fim, sintetizados (sem arquivo)
  function bipe(subindo) {
    try {
      const c = audioCtx(), t = c.currentTime, o = c.createOscillator(), g = c.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(subindo ? 660 : 990, t);
      o.frequency.exponentialRampToValueAtTime(subindo ? 1320 : 520, t + 0.12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + 0.2);
    } catch { /* sem áudio */ }
  }

  // núcleo do reator pulsa com o volume do microfone (ou da voz)
  function pulsar() {
    if (!analisador) { nucleo.style.transform = ''; return; }
    const d = new Uint8Array(analisador.fftSize);
    analisador.getByteTimeDomainData(d);
    let s = 0;
    for (const v of d) s += ((v - 128) / 128) ** 2;
    nucleo.style.transform = `scale(${1 + Math.min(1.2, Math.sqrt(s / d.length) * 6)})`;
    requestAnimationFrame(pulsar);
  }

  function pararAudio() {
    if (audioAtual) { try { audioAtual.stop(); } catch { /* já parou */ } audioAtual = null; }
    window.speechSynthesis?.cancel();
  }

  // ---------- ouvir ----------
  async function comecar() {
    const g = ++geracao;
    pararAudio();
    limpar();
    abrir();
    setEstado('ouvindo');
    bipe(true);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      setEstado('parado', 'Sem microfone');
      $('.j-resp').textContent = 'Preciso de acesso ao microfone, senhor.';
      fechar(4000);
      return;
    }
    if (g !== geracao || !pressionado) { soltarMic(); return; } // soltou antes do microfone abrir
    const c = audioCtx();
    analisador = c.createAnalyser();
    analisador.fftSize = 1024;
    c.createMediaStreamSource(stream).connect(analisador);
    pulsar();
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => window.MediaRecorder?.isTypeSupported(m)) || '';
    partes = [];
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (e) => { if (e.data.size) partes.push(e.data); };
    rec.onstop = () => terminar(g, new Blob(partes, { type: rec.mimeType || 'audio/webm' }));
    inicio = performance.now();
    rec.start();
  }

  function soltarMic() {
    analisador = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function parar() {
    if (rec && rec.state === 'recording') { bipe(false); rec.stop(); } else if (estado === 'ouvindo') { soltarMic(); setEstado('parado'); fechar(); }
  }

  async function terminar(g, blob) {
    const dur = performance.now() - inicio;
    soltarMic();
    rec = null;
    if (g !== geracao) return;
    if (dur < MIN_FALA_MS || blob.size < 1500) { setEstado('parado'); $('.j-resp').textContent = 'Não ouvi nada, senhor.'; fechar(1800); return; }
    setEstado('pensando');
    try {
      const r = await fetch('/api/ouvir', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      if (g !== geracao) return;
      if (!d.texto) { setEstado('parado'); await falar(g, 'Não entendi, senhor. Pode repetir?'); return; }
      $('.j-voce').textContent = d.texto;
      await responder(g, d.texto);
    } catch (e) {
      if (g !== geracao) return;
      setEstado('parado', 'Erro');
      $('.j-resp').textContent = `Falha: ${e.message}`;
      fechar(6000);
    }
  }

  // ---------- entender e agir ----------
  async function responder(g, texto) {
    const r = await fetch(`/api/perguntar?q=${encodeURIComponent(texto)}`);
    const a = await r.json();
    if (!r.ok) throw new Error(a.error || r.statusText);
    if (g !== geracao) return;
    const AQUI = 'Aqui está, senhor.';
    if (a.acao === 'abrir' && a.caminho) {
      await reveal(a.caminho);
      return falar(g, AQUI);
    }
    if (a.acao === 'buscar') {
      const termo = a.termo || texto;
      let res = [];
      try { res = (await (await fetch(`/api/search?q=${encodeURIComponent(termo)}`)).json()).results || []; } catch { /* sem resultado */ }
      if (g !== geracao) return;
      if (!res.length) return falar(g, `Não encontrei ${termo}, senhor.`);
      const alvo = res.find((x) => x.name.toLowerCase() === termo.toLowerCase()) || res[0];
      await reveal(alvo.path);
      return falar(g, res.length > 1 ? `Encontrei ${res.length} resultados. ${AQUI}` : AQUI);
    }
    if (a.acao === 'consultar') {
      tabela(a.linhas || []);
      $('.j-sql').textContent = a.sql || '';
      return falar(g, `${a.fala ? a.fala + ' ' : ''}${AQUI}`, 14000);
    }
    if (a.acao === 'inicio') { goBrain(); return falar(g, 'Como quiser, senhor.'); }
    if (a.acao === 'fechar') { await fecharTudo(); return falar(g, 'Tudo fechado, senhor.'); }
    if (a.acao === 'planeta') { falar(g, 'Abrindo o Reino, senhor.'); await abrirReino(); return; }
    if (a.erro) $('.j-sql').textContent = a.sql || '';
    return falar(g, a.fala || 'Não sei responder isso, senhor.', a.erro ? 9000 : 5000);
  }

  function tabela(linhas) {
    if (!linhas.length) { $('.j-tabela').innerHTML = ''; return; }
    if (linhas.length === 1 && Object.keys(linhas[0]).length === 1) return; // um número só: a frase basta
    const cols = Object.keys(linhas[0]);
    const cel = (v) => esc(v != null && typeof v === 'object' ? JSON.stringify(v) : v);
    $('.j-tabela').innerHTML = `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
      linhas.slice(0, 20).map((l) => `<tr>${cols.map((c) => `<td title="${cel(l[c])}">${cel(l[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  // ---------- falar ----------
  async function falar(g, texto, ficar = 4500) {
    if (g !== geracao) return;
    $('.j-resp').textContent = texto;
    abrir();
    setEstado('falando');
    try {
      const r = await fetch(`/api/voz?texto=${encodeURIComponent(texto)}`);
      if (!r.ok) throw new Error('voz');
      const buf = await audioCtx().decodeAudioData(await r.arrayBuffer());
      if (g !== geracao) return;
      await tocar(buf);
    } catch {
      await falarNavegador(texto); // sem internet/edge-tts: voz do sistema
    }
    if (g === geracao) fechar(ficar);
  }

  // cadeia "Jarvis": corta grave, realça presença e um eco curto de sala metálica
  function tocar(buf) {
    return new Promise((resolve) => {
      const c = audioCtx(), src = c.createBufferSource();
      src.buffer = buf;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 110;
      const pres = c.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.gain.value = 4; pres.Q.value = 0.9;
      const seco = c.createGain(); seco.gain.value = 1;
      const atraso = c.createDelay(); atraso.delayTime.value = 0.075;
      const retorno = c.createGain(); retorno.gain.value = 0.22;
      const molhado = c.createGain(); molhado.gain.value = 0.28;
      src.connect(hp).connect(pres);
      pres.connect(seco).connect(c.destination);
      pres.connect(atraso); atraso.connect(retorno).connect(atraso); atraso.connect(molhado).connect(c.destination);
      analisador = c.createAnalyser(); analisador.fftSize = 1024; pres.connect(analisador);
      pulsar();
      src.onended = () => { analisador = null; audioAtual = null; resolve(); };
      audioAtual = src;
      src.start();
    });
  }

  function falarNavegador(texto) {
    return new Promise((resolve) => {
      const s = window.speechSynthesis;
      if (!s) return resolve();
      const u = new SpeechSynthesisUtterance(texto);
      u.lang = 'pt-BR'; u.rate = 0.98; u.pitch = 0.8;
      const v = s.getVoices().find((x) => /pt-BR/i.test(x.lang) && /male|antonio|daniel|google/i.test(x.name)) || s.getVoices().find((x) => /pt/i.test(x.lang));
      if (v) u.voice = v;
      u.onend = u.onerror = () => resolve();
      s.speak(u);
    });
  }

  // ---------- Espaço: toque = volta ao cérebro, segurar = falar ----------
  function pressionar(aoTocar) {
    if (pressionado) return;
    pressionado = true;
    pressTimer = setTimeout(() => { pressTimer = null; comecar(); }, aoTocar ? SEGURAR_MS : 0);
    soltarCb = aoTocar;
  }
  let soltarCb = null;
  function soltar() {
    if (!pressionado) return;
    pressionado = false;
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; soltarCb?.(); return; }
    parar();
  }

  const reator = $('.j-reator');
  reator.addEventListener('pointerdown', (e) => { e.preventDefault(); reator.setPointerCapture(e.pointerId); pressionar(null); });
  reator.addEventListener('pointerup', soltar);
  reator.addEventListener('pointercancel', soltar);
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' || e.key === ' ') soltar(); });
  window.addEventListener('blur', soltar);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && box.classList.contains('aberto')) { geracao++; pararAudio(); soltarMic(); setEstado('parado'); fechar(); } });

  return {
    // chamado pelo atalho do Espaço no main.js
    espaco(e) { if (!e.repeat) pressionar(() => goBrain()); },
    ocupado: () => estado !== 'parado' || pressionado,
    toast,
  };
}
