// "Abrir Reino": todo o conhecimento do banco numa esfera. Cada seção de primeiro nível (schema, Edge Functions,
// Buckets) vira um país: uma região da superfície (sem preenchimento — só uma direção e um raio angular), e os
// itens dela (tabelas, views, funções, linhas, arquivos) ficam espalhados dentro do território, em espiral de
// girassol. Não há mapa pintado: o mundo é feito só das próprias pastas abertas, cada uma com a bolinha e a cor
// do seu tipo — o "país" existe apenas como a região do céu para onde elas são puxadas, e a cor de destaque no
// rótulo da seção. Só geometria: quem carrega os nós e fixa as posições é o main.js.
import * as THREE from 'three';

export const CORES_PAISES = ['#3b82ff', '#34e6a6', '#ffb547', '#e04bff', '#3fe3ff', '#ff7ab8', '#8b5cff', '#f5c76a',
  '#5eead4', '#fb7185', '#a3e635', '#60a5fa', '#f472b6', '#facc15', '#22d3ee', '#c084fc'];
const OURO = Math.PI * (3 - Math.sqrt(5));

// raio do planeta cresce com a quantidade de itens
export const raioPlaneta = (total) => Math.min(520, Math.max(200, 120 + Math.sqrt(total) * 14));

// paises: [{ id, n }] (n = itens do país). Devolve centro (direção unitária) e raio angular de cada um.
export function distribuirPaises(paises) {
  const soma = paises.reduce((t, p) => t + p.n + 2, 0) || 1;
  const ps = paises.map((p) => {
    const a = ((p.n + 2) / soma) * 0.72; // fração da esfera; o resto é oceano entre os países
    return { ...p, theta: Math.acos(1 - 2 * Math.min(0.45, a)) };
  });
  // maiores primeiro, em pontos de Fibonacci (espalhados por igual); depois empurra quem se sobrepõe
  const ordem = [...ps].sort((a, b) => b.theta - a.theta);
  ordem.forEach((p, i) => {
    const y = 1 - (2 * (i + 0.5)) / ordem.length, r = Math.sqrt(1 - y * y), ang = i * OURO;
    p.dir = new THREE.Vector3(Math.cos(ang) * r, y, Math.sin(ang) * r);
  });
  const v = new THREE.Vector3();
  for (let it = 0; it < 400; it++) {
    for (let i = 0; i < ordem.length; i++) {
      for (let j = i + 1; j < ordem.length; j++) {
        const a = ordem[i], b = ordem[j];
        const ang = a.dir.angleTo(b.dir), quer = (a.theta + b.theta) * 1.04;
        if (ang >= quer) continue;
        const passo = (quer - ang) * 0.22;
        v.subVectors(a.dir, b.dir);
        if (v.lengthSq() < 1e-9) v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
        v.normalize();
        a.dir.addScaledVector(v, passo).normalize();
        b.dir.addScaledVector(v, -passo).normalize();
      }
    }
  }
  return ps;
}

// k-ésimo de n itens dentro do território (calota de raio angular theta em volta de dir)
export function pontoNoPais(pais, k, n, raio) {
  const dir = pais.dir;
  const t1 = new THREE.Vector3(0, 1, 0).cross(dir);
  if (t1.lengthSq() < 1e-6) t1.set(1, 0, 0);
  t1.normalize();
  const t2 = new THREE.Vector3().crossVectors(dir, t1);
  const r = pais.theta * 0.82 * Math.sqrt((k + 0.5) / Math.max(1, n));
  const phi = k * OURO;
  return new THREE.Vector3()
    .addScaledVector(dir, Math.cos(r))
    .addScaledVector(t1, Math.sin(r) * Math.cos(phi))
    .addScaledVector(t2, Math.sin(r) * Math.sin(phi))
    .multiplyScalar(raio);
}

