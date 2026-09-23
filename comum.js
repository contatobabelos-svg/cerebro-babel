// Peças comuns às fontes de dados (Supabase e a de teste).
'use strict';

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// colunas cujo valor nunca aparece no app (senhas, tokens, segredos do vault…)
const SECRET_RE = /pass(word)?|secret|token|hash|salt|nonce|otp|api_?key|private_?key|^key$|encrypted/i;

// cópia da linha com segredos escondidos e textos longos cortados
function redact(j, maxStr = 160) {
  const cut = (v) => {
    if (typeof v === 'string') {
      if (/^data:[^;]+;base64,/.test(v)) return `${v.slice(0, v.indexOf(',') + 1)}… (${Math.round((v.length * 3) / 4 / 1024)} KB)`;
      return v.length > maxStr ? v.slice(0, maxStr) + `… (+${v.length - maxStr})` : v;
    }
    if (Array.isArray(v)) return v.map(cut);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_RE.test(k) && x != null ? '•••••• (oculto)' : cut(x)]));
    return v;
  };
  return cut(j);
}

const LABEL_COLS = ['nome', 'titulo', 'name', 'title', 'email', 'usuario', 'username', 'slug', 'codigo', 'chave', 'version', 'id'];
function rowLabel(j, key) {
  for (const c of LABEL_COLS) {
    const v = j[c];
    if (v != null && v !== '' && typeof v !== 'object' && !SECRET_RE.test(c)) {
      const s = String(v).replace(/\s+/g, ' ').trim();
      return s.length > 48 ? s.slice(0, 48) + '…' : s;
    }
  }
  return key.length > 24 ? key.slice(0, 24) + '…' : key;
}

const TIME_COLS = ['atualizado_em', 'updated_at', 'criado_em', 'created_at', 'inserted_at', 'buscado_em', 'publicado_em'];
function rowTime(j) {
  for (const c of TIME_COLS) {
    const t = j[c] && Date.parse(j[c]);
    if (t) return t;
  }
  return null;
}

// imagem de uma linha: base64 → servida por /api/media; link https de imagem → usado direto
const IMG_URL = /^https:\/\/[^\s"'<>]+(\.(png|jpe?g|gif|webp|avif)(\?[^\s"'<>]*)?$|ytimg\.com\/|googleusercontent\.com\/|\/storage\/v1\/object\/public\/)/i;
function rowImage(j, p) {
  for (const [k, v] of Object.entries(j)) {
    if (SECRET_RE.test(k) || typeof v !== 'string') continue;
    if (/^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);base64,/.test(v)) return `/api/media?path=${encodeURIComponent(p)}`;
    if (IMG_URL.test(v)) return v;
  }
  return undefined;
}

// caminho do app = segmentos codificados unidos por "/" (um id com "/" não quebra a árvore)
const seg = (s) => encodeURIComponent(String(s)).replace(/%40/g, '@');
const unseg = (s) => { try { return decodeURIComponent(s); } catch { throw new HttpError(400, 'caminho inválido'); } };
const joinPath = (...parts) => parts.map(seg).join('/');

module.exports = { HttpError, SECRET_RE, redact, rowLabel, rowTime, rowImage, seg, unseg, joinPath };
