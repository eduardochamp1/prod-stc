/**
 * mock/mockData.js
 * Dados simulados para desenvolvimento — estrutura espelha a API WPA real.
 */

const hoje = new Date().toISOString().split('T')[0];
const mesAtual = hoje.slice(0, 7); // YYYY-MM

const TIPOS_SERVICO = {
  LN: 'Ligação Nova',
  LE: 'Ligação Existente',
  DL: 'Desligamento',
  MD: 'Modificação',
  SF: 'Suspensão de Fornecimento',
  RL: 'Religa',
  UG: 'Uso Geral',
  DD: 'Falhas para Distribuição',
  II: 'Inspeção de Irregularidade',
  PO: 'Ordem Prioritária',
};

function gerarNota(tipoCode, status) {
  const num = String(10000 + Math.floor(Math.random() * 89999));
  return {
    codigo: `${tipoCode}${num}`,
    tipoCode,
    tipoNome: TIPOS_SERVICO[tipoCode] || tipoCode,
    status,
  };
}

function gerarNotasPorPerfil(perfil, statusCounts) {
  // statusCounts: { baixadas, executadas, concluidas, rejeitadas }
  const result = { notasBaixadas: [], notasExecutadas: [], notasConcluidas: [], notasRejeitadas: [] };
  const pick = () => perfil[Math.floor(Math.random() * perfil.length)];

  for (let i = 0; i < statusCounts.baixadas;   i++) result.notasBaixadas.push(gerarNota(pick(), 'baixada'));
  for (let i = 0; i < statusCounts.executadas;  i++) result.notasExecutadas.push(gerarNota(pick(), 'executada'));
  for (let i = 0; i < statusCounts.concluidas;  i++) result.notasConcluidas.push(gerarNota(pick(), 'concluida'));
  for (let i = 0; i < statusCounts.rejeitadas;  i++) result.notasRejeitadas.push(gerarNota(pick(), 'rejeitada'));

  return result;
}

function gerarSessoes(relogins) {
  const sessoes = [];
  let hora = 6 + Math.floor(Math.random() * 2);
  let min  = Math.floor(Math.random() * 30);
  for (let i = 0; i <= relogins; i++) {
    const ih = hora, im = min;
    hora += 1 + Math.floor(Math.random() * 3);
    min   = Math.floor(Math.random() * 60);
    if (hora >= 18) break;
    sessoes.push({
      inicio: `${String(ih).padStart(2,'0')}:${String(im).padStart(2,'0')}`,
      fim:    `${String(hora).padStart(2,'0')}:${String(min).padStart(2,'0')}`,
      motivo: i < relogins ? 'Logout manual' : null,
    });
  }
  return sessoes;
}

// ── DEFINIÇÃO DAS EQUIPES ─────────────────────────────────────────────────────

const EQUIPES_DEF = [
  // ── GUARAPARI — DESG ─────────────────────────────────────────────────────
  { id: 'eq-01', sigla: 'EPGUA01', sectorId: 'DESG', regional: 'GUA', perfil: ['LN','LE','RL'],     relogins: 0, ativa: true  },
  { id: 'eq-02', sigla: 'EPGUA02', sectorId: 'DESG', regional: 'GUA', perfil: ['DL','SF','RL'],     relogins: 1, ativa: true  },
  { id: 'eq-03', sigla: 'ECGUA03', sectorId: 'DESG', regional: 'GUA', perfil: ['II','DD','UG'],     relogins: 0, ativa: false },
  { id: 'eq-04', sigla: 'EPGUA04', sectorId: 'DESG', regional: 'GUA', perfil: ['MD','LN','LE'],     relogins: 2, ativa: true  },
  { id: 'eq-05', sigla: 'ETGUA05', sectorId: 'DESG', regional: 'GUA', perfil: ['PO','RL','DL'],     relogins: 0, ativa: false },
  { id: 'eq-06', sigla: 'EPGUA06', sectorId: 'DESG', regional: 'GUA', perfil: ['SF','DL','RL'],     relogins: 1, ativa: true  },
  { id: 'eq-07', sigla: 'ECGUA07', sectorId: 'DESG', regional: 'GUA', perfil: ['DD','UG','II'],     relogins: 0, ativa: true  },
  { id: 'eq-08', sigla: 'EPGUA08', sectorId: 'DESG', regional: 'GUA', perfil: ['LN','MD','LE'],     relogins: 3, ativa: true  },

  // ── GUARAPARI — DEPT ─────────────────────────────────────────────────────
  { id: 'eq-09', sigla: 'EPGUA09', sectorId: 'DEPT', regional: 'GUA', perfil: ['RL','SF','DL'],     relogins: 0, ativa: true  },
  { id: 'eq-10', sigla: 'EPGUA10', sectorId: 'DEPT', regional: 'GUA', perfil: ['LN','LE','MD'],     relogins: 1, ativa: false },
  { id: 'eq-11', sigla: 'ECGUA11', sectorId: 'DEPT', regional: 'GUA', perfil: ['II','PO','UG'],     relogins: 0, ativa: true  },
  { id: 'eq-12', sigla: 'ETGUA12', sectorId: 'DEPT', regional: 'GUA', perfil: ['DL','SF','RL'],     relogins: 2, ativa: true  },

  // ── CACHOEIRO — DESC ─────────────────────────────────────────────────────
  { id: 'eq-13', sigla: 'EPACH13', sectorId: 'DESC', regional: 'CAC', perfil: ['LN','LE','RL'],     relogins: 0, ativa: true  },
  { id: 'eq-14', sigla: 'EPACH14', sectorId: 'DESC', regional: 'CAC', perfil: ['DL','SF','RL'],     relogins: 1, ativa: true  },
  { id: 'eq-15', sigla: 'ECACH15', sectorId: 'DESC', regional: 'CAC', perfil: ['DD','II','UG'],     relogins: 0, ativa: false },
  { id: 'eq-16', sigla: 'EPACH16', sectorId: 'DESC', regional: 'CAC', perfil: ['MD','LN','LE'],     relogins: 0, ativa: true  },
  { id: 'eq-17', sigla: 'ETACH17', sectorId: 'DESC', regional: 'CAC', perfil: ['PO','RL','DL'],     relogins: 1, ativa: true  },
  { id: 'eq-18', sigla: 'EPACH18', sectorId: 'DESC', regional: 'CAC', perfil: ['SF','DL','RL'],     relogins: 2, ativa: false },
  { id: 'eq-19', sigla: 'ECACH19', sectorId: 'DESC', regional: 'CAC', perfil: ['LN','MD','II'],     relogins: 0, ativa: true  },
  { id: 'eq-20', sigla: 'EPACH20', sectorId: 'DESC', regional: 'CAC', perfil: ['RL','SF','UG'],     relogins: 1, ativa: true  },
  { id: 'eq-21', sigla: 'EPACH21', sectorId: 'DESC', regional: 'CAC', perfil: ['DL','DD','RL'],     relogins: 0, ativa: true  },
  { id: 'eq-22', sigla: 'ETACH22', sectorId: 'DESC', regional: 'CAC', perfil: ['LN','LE','MD'],     relogins: 3, ativa: false },
];

const PLACAS = ['PQR-4521','ABC-1234','DEF-5678','GHI-9012','JKL-3456','MNO-7890',
                'RST-2345','UVW-6789','XYZ-0123','BCD-4567','EFG-8901','HIJ-2345',
                'KLM-6789','NOP-0123','QRS-4567','TUV-8901','WXY-2345','ZAB-6789',
                'CDE-0123','FGH-4567','IJK-8901','LMN-2345'];

const COLABORADORES = [
  ['Carlos Eduardo Silva','Eletricista Sênior'],   ['Marcos Antônio Pereira','Auxiliar de Campo'],
  ['João Paulo Nascimento','Eletricista Pleno'],   ['Rafael Souza Lima','Auxiliar de Campo'],
  ['Thiago Martins Costa','Eletricista Sênior'],   ['Bruno Alves Ferreira','Auxiliar de Campo'],
  ['Anderson Luiz Santos','Eletricista Pleno'],    ['Leandro Costa Rocha','Auxiliar de Campo'],
  ['Rodrigo Mendes Oliveira','Eletricista Sênior'],['Felipe Gomes Teixeira','Auxiliar de Campo'],
  ['Gustavo Henrique Dias','Eletricista Pleno'],   ['Wellington Souza Neto','Auxiliar de Campo'],
  ['Diego Ribeiro Campos','Eletricista Sênior'],   ['Lucas Moreira Azevedo','Auxiliar de Campo'],
  ['Henrique Borges Lima','Eletricista Pleno'],    ['Matheus Costa Rocha','Auxiliar de Campo'],
  ['Vinícius Almeida Cruz','Eletricista Sênior'],  ['Gabriel Nunes Pinto','Auxiliar de Campo'],
  ['Samuel Freitas Melo','Eletricista Pleno'],     ['Igor Cardoso Vieira','Auxiliar de Campo'],
  ['Patrick Oliveira Gomes','Eletricista Sênior'], ['Renato Santos Braga','Auxiliar de Campo'],
];

function gerarMatricula(idx) {
  return String(100100 + idx * 7);
}

const MOCK_TEAMS = EQUIPES_DEF.map((def, i) => {
  const baixadas   = 8  + Math.floor(Math.random() * 14);
  const concluidas = Math.floor(baixadas * (0.55 + Math.random() * 0.35));
  const executadas = Math.floor((baixadas - concluidas) * (0.3 + Math.random() * 0.5));
  const rejeitadas = Math.floor(Math.random() * 3);

  const hIni = 6 + Math.floor(Math.random() * 2);
  const mIni = Math.floor(Math.random() * 30);
  const sessionBegin = `${hoje}T0${hIni}:${String(mIni).padStart(2,'0')}:00`;
  const sessionEnd   = def.ativa ? null
    : `${hoje}T1${7 + Math.floor(Math.random() * 2)}:${String(Math.floor(Math.random()*60)).padStart(2,'0')}:00`;

  const c1 = COLABORADORES[(i * 2) % COLABORADORES.length];
  const c2 = COLABORADORES[(i * 2 + 1) % COLABORADORES.length];

  return {
    id: def.id,
    sigla: def.sigla,
    teamName: def.sigla,
    sectorId: def.sectorId,
    regional: def.regional,
    date: hoje,
    sessionBegin,
    sessionEnd,
    vehiclePlate: PLACAS[i % PLACAS.length],
    collaborators: [
      { nome: c1[0], matricula: gerarMatricula(i * 2),     cargo: c1[1] },
      { nome: c2[0], matricula: gerarMatricula(i * 2 + 1), cargo: c2[1] },
    ],
    sessions: gerarSessoes(def.relogins),
    relogins: def.relogins,
    servicosPerfil: def.perfil,
    ...gerarNotasPorPerfil(def.perfil, { baixadas, executadas, concluidas, rejeitadas }),
    checkinTime: `${hoje}T0${hIni}:${String(mIni + 5 > 59 ? mIni : mIni + 5).padStart(2,'0')}:00`,
  };
});

// ── EXPORTS ───────────────────────────────────────────────────────────────────

function getMockTeams(filters = {}) {
  let teams = MOCK_TEAMS;

  // Agrupa Guarapari (DESG + DEPT) quando filtro for 'GUA'
  if (filters.regional === 'GUA') {
    teams = teams.filter(t => t.sectorId === 'DESG' || t.sectorId === 'DEPT');
  } else if (filters.regional === 'CAC') {
    teams = teams.filter(t => t.sectorId === 'DESC');
  } else if (filters.sectorId && filters.sectorId !== 'ALL') {
    teams = teams.filter(t => t.sectorId === filters.sectorId);
  }

  if (filters.uen) teams = teams.filter(t => t.uen === filters.uen);
  return teams;
}

function getMockTeamDetail(teamId) {
  return MOCK_TEAMS.find(t => t.id === teamId || t.sigla === teamId) || null;
}

function getMockSummary() {
  return [
    { regionalId: 'GUA', nome: 'Guarapari', teams: MOCK_TEAMS.filter(t => t.regional === 'GUA') },
    { regionalId: 'CAC', nome: 'Cachoeiro', teams: MOCK_TEAMS.filter(t => t.regional === 'CAC') },
  ].map(r => ({
    regionalId: r.regionalId,
    nome: r.nome,
    totalEquipes:    r.teams.length,
    equipesAtivas:   r.teams.filter(t => !t.sessionEnd).length,
    totalBaixadas:   r.teams.reduce((s, t) => s + t.notasBaixadas.length,   0),
    totalExecutadas: r.teams.reduce((s, t) => s + t.notasExecutadas.length, 0),
    totalConcluidas: r.teams.reduce((s, t) => s + t.notasConcluidas.length, 0),
    totalRejeitadas: r.teams.reduce((s, t) => s + t.notasRejeitadas.length, 0),
  }));
}

module.exports = { getMockTeams, getMockTeamDetail, getMockSummary, TIPOS_SERVICO };
