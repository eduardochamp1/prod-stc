/**
 * services/categoriasEquipe.js
 *
 * Catálogo das categorias de equipe, derivadas do PREFIXO da sigla.
 *
 * Antes de 18/09/2026 esta regra vivia em 9 ternários encadeados espalhados
 * (4 em db/queries.js, 5 em public/index.html). Acrescentar as categorias
 * `ET` (Equipe Moto) e `EB` (BT Zero) seriam 18 edições manuais, e o modo de
 * errar era silencioso: esquecer um sítio de badge faz a mesma equipe aparecer
 * como "Equipe Moto" numa tabela e "OP" em outra.
 *
 * ⚠️ NÃO confundir com `equipes_oficiais.tipo` — o tipo OPERACIONAL do
 * cadastro (BTZERO, CS, CORTE L0, COMERCIAL…), editável no Admin. É outra
 * dimensão, e não se mexe nela por aqui. Por isso a chave do prefixo `EB` é
 * `BT_ZERO`, com underline: sem ele, um `grep BTZERO` daqui a seis meses acha
 * os dois conceitos misturados e conclui a coisa errada.
 *
 * ⚠️ Existe uma CÓPIA desta lista em public/index.html (dois runtimes, sem
 * bundler). `test/categoriasEquipe.test.js` compara as duas campo a campo —
 * se divergirem, a suíte fica vermelha antes do push.
 *
 * Nada aqui é persistido: a categoria é calculada na leitura, então vale
 * retroativamente para todo o histórico, sem backfill.
 *
 * Spec: docs/handoff/SPEC-categorias-equipe-2026-09-18.md
 */

'use strict';

/**
 * As categorias nomeadas, na ordem em que aparecem no filtro.
 *
 * `COMERCIAL` e `PLANTAO` mantêm as chaves antigas de propósito: elas viajam
 * na URL (`?tipo=COMERCIAL`) e renomeá-las quebraria link e favorito
 * existentes, sem ganho nenhum.
 */
const CATEGORIAS = [
  { prefixo: 'EC', chave: 'COMERCIAL', rotulo: 'Comercial',   badge: 'EC', cssBarra: 'tipo-comercial' },
  { prefixo: 'EP', chave: 'PLANTAO',   rotulo: 'Plantão',     badge: 'EP', cssBarra: 'tipo-plantao'   },
  { prefixo: 'ET', chave: 'MOTO',      rotulo: 'Equipe Moto', badge: 'ET', cssBarra: 'tipo-moto'      },
  { prefixo: 'EB', chave: 'BT_ZERO',   rotulo: 'BT Zero',     badge: 'EB', cssBarra: 'tipo-bt-zero'   },
];

/** O complemento: toda sigla que não casa com nenhum prefixo acima. */
const OPERACIONAL = {
  prefixo: null, chave: 'OPERACIONAL', rotulo: 'Operacional',
  badge: 'OP', cssBarra: 'tipo-operacional',
};

/** Sentinela de "sem filtro" — o que o front manda quando nada está marcado. */
const TODAS = 'TODAS';

/** Sigla → chave da categoria. Nunca estoura; o que não casa vira OPERACIONAL. */
function categoriaDaSigla(sigla) {
  const u = String(sigla === null || sigla === undefined ? '' : sigla).toUpperCase();
  const achada = CATEGORIAS.find(c => u.startsWith(c.prefixo));
  return achada ? achada.chave : OPERACIONAL.chave;
}

/** Chave → prefixo. OPERACIONAL devolve null: é o complemento, não um prefixo. */
function prefixoDaCategoria(chave) {
  const achada = CATEGORIAS.find(c => c.chave === chave);
  return achada ? achada.prefixo : null;
}

/** Chave → a entrada inteira do catálogo (ou a do OPERACIONAL). */
function categoriaPorChave(chave) {
  return CATEGORIAS.find(c => c.chave === chave) || OPERACIONAL;
}

/**
 * Monta o predicado do filtro multi.
 *
 * Aceita array (`['COMERCIAL','MOTO']`) ou CSV (`'COMERCIAL,MOTO'`) — o
 * segundo é o que chega na query string.
 *
 * Sem seleção, ou com `TODAS` presente, não filtra nada. Antes de 18/09 o
 * front colapsava ≥2 categorias em `TODAS`, o que era inofensivo com duas
 * categorias (marcar as duas = marcar todas) e virou defeito real com quatro.
 *
 * @returns {(sigla: string) => boolean}
 */
function filtroDeCategorias(chaves) {
  const lista = (Array.isArray(chaves)
    ? chaves
    : String(chaves === null || chaves === undefined ? '' : chaves).split(','))
    .map(s => String(s === null || s === undefined ? '' : s).trim().toUpperCase())
    .filter(Boolean);

  if (lista.length === 0 || lista.includes(TODAS)) return () => true;

  const prefixos = lista.map(prefixoDaCategoria).filter(Boolean);
  const querOperacional = lista.includes(OPERACIONAL.chave);

  return (sigla) => {
    const u = String(sigla === null || sigla === undefined ? '' : sigla).toUpperCase();
    if (prefixos.some(p => u.startsWith(p))) return true;
    if (querOperacional && categoriaDaSigla(u) === OPERACIONAL.chave) return true;
    return false;
  };
}

module.exports = {
  CATEGORIAS, OPERACIONAL, TODAS,
  categoriaDaSigla, prefixoDaCategoria, categoriaPorChave, filtroDeCategorias,
};
