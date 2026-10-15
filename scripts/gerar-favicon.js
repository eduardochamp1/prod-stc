#!/usr/bin/env node
/**
 * scripts/gerar-favicon.js — gera public/favicon.svg e public/favicon-alerta.svg
 * a partir do RAIO do logo real (public/logo.png), sem redesenhar (14/10/2026).
 *
 * Uso (de qualquer lugar do repo):
 *   node scripts/gerar-favicon.js
 *
 * Sem dependência: decodifica o PNG (RGBA 8 bits, inclusive entrelaçado Adam7) com
 * o zlib do Node, acha o raio PELA COR (amarelo/vermelho; o texto é preto/verde) e
 * embute o recorte como data URI (favicon SVG não carrega arquivo externo, e o
 * Fortinet bloqueia CDN). Rode de novo se o logo mudar.
 */
const path = require('path');
process.argv[2] = process.argv[2] || path.join(__dirname, '..', 'public', 'logo.png');
process.argv[3] = process.argv[3] || path.join(__dirname, '..', 'public');

const fs = require('fs');
const zlib = require('zlib');

const src = fs.readFileSync(process.argv[2]);
const W = src.readUInt32BE(16), H = src.readUInt32BE(20);
if (src[24] !== 8 || src[25] !== 6) throw new Error('esperava RGBA 8 bits');
const entrelacado = src[28] === 1;

let off = 8; const idat = [];
while (off < src.length) {
  const len = src.readUInt32BE(off), tipo = src.toString('ascii', off + 4, off + 8);
  if (tipo === 'IDAT') idat.push(src.slice(off + 8, off + 8 + len));
  off += 12 + len;
}
const raw = zlib.inflateSync(Buffer.concat(idat));
const bpp = 4, stride = W * bpp;
const px = Buffer.alloc(H * stride);
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

// Desfaz o filtro de uma sub-imagem pw x ph a partir de raw[pos]; devolve [pixels, nova pos].
function desfiltra(pos, pw, ph) {
  const st = pw * bpp, out = Buffer.alloc(ph * st);
  for (let y = 0; y < ph; y++) {
    const f = raw[pos]; pos++;
    for (let x = 0; x < st; x++) {
      const r = raw[pos + x];
      const a = x >= bpp ? out[y * st + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * st + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * st + x - bpp] : 0;
      out[y * st + x] = (f === 0 ? r : f === 1 ? r + a : f === 2 ? r + b : f === 3 ? r + ((a + b) >> 1) : r + paeth(a, b, c)) & 255;
    }
    pos += st;
  }
  return [out, pos];
}

if (!entrelacado) {
  const [out] = desfiltra(0, W, H); out.copy(px);
} else {
  const passadas = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  let pos = 0;
  for (const [xs, ys, dx, dy] of passadas) {
    const pw = Math.ceil((W - xs) / dx), ph = Math.ceil((H - ys) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const [out, np] = desfiltra(pos, pw, ph); pos = np;
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      out.copy(px, (ys + y * dy) * stride + (xs + x * dx) * bpp, (y * pw + x) * bpp, (y * pw + x) * bpp + bpp);
    }
  }
}

// Sanidade: fundo do logo é transparente.
const alfa = (x, y) => px[y * stride + x * 4 + 3];
if (alfa(W - 2, 2) > 16 || alfa(W - 2, H - 2) > 16) throw new Error('decodificação suspeita: fundo não transparente');

// O raio é AMARELO e VERMELHO; o texto é PRETO (ENGELMIG) e VERDE (ENERGIA). Seleciona
// pela cor (vermelho alto, azul baixo) — o raio encosta no E, então coluna vazia não serve.
const ehRaio = (x, y) => { const i = y * stride + x * 4; return px[i + 3] > 16 && px[i] > 140 && px[i + 2] < 150; };
let x0 = W, x1 = 0, y0 = H, y1 = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ehRaio(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
x1++; y1++;
// dentro da caixa, apaga o que for texto (escuro ou verde), preservando a borda suave do raio
for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
  const i = y * stride + x * 4;
  if (px[i + 3] > 16 && !(px[i] > 110 && px[i + 2] < 170)) px[i + 3] = 0;
}
const cw = x1 - x0, ch = y1 - y0;
console.log(`logo ${W}x${H} (entrelaçado=${entrelacado}); raio em x=${x0}..${x1} y=${y0}..${y1} (${cw}x${ch})`);
if (cw > 160) throw new Error('caixa do raio larga demais — critério de cor pegou texto');

// recodifica o recorte (filtro 0, sem entrelaçar) como PNG RGBA
const linhas = [];
for (let y = y0; y < y1; y++) linhas.push(Buffer.concat([Buffer.from([0]), px.slice(y * stride + x0 * 4, y * stride + x1 * 4)]));
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (tipo, dados) => { const l = Buffer.alloc(4); l.writeUInt32BE(dados.length); const td = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(cw, 0); ihdr.writeUInt32BE(ch, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(linhas), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const b64 = png.toString('base64');
console.log(`recorte: ${png.length} bytes (${b64.length} em base64)`);

// Encaixa o raio num quadrado 64x64 escuro: cabe na área acima da faixa do header
// (y 0..58), com margem, centralizado.
const AREA_W = 50, AREA_H = 48, TOPO = 5;
const esc = Math.min(AREA_W / cw, AREA_H / ch);
const w = +(cw * esc).toFixed(2), h = +(ch * esc).toFixed(2);
const x = +((64 - w) / 2).toFixed(2), y = +(TOPO + (AREA_H - h) / 2).toFixed(2);
const svg = (comAlerta) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64">
  <!-- Favicon do WPA Monitor (14/10/2026): o RAIO do logo.png REAL da Engelmig, recortado
       do próprio arquivo, sem redesenho (pedido do José), sobre o preto do cabeçalho, com a
       faixa amarela/verde do header embaixo.${comAlerta ? '\n       Versão COM AVISO: ponto vermelho no canto, usada pelo balão de avisos quando há\n       equipe abaixo do esperado.' : ''}
       Recorte de public/logo.png: x=${x0}..${x1}, y=${y0}..${y1}. Imagem embutida (data URI):
       favicon SVG não carrega arquivo externo, e o Fortinet bloqueia CDN. -->
  <defs>
    <clipPath id="canto"><rect width="64" height="64" rx="14"/></clipPath>
  </defs>
  <g clip-path="url(#canto)">
    <rect width="64" height="64" fill="#231F20"/>
    <rect y="58" width="32" height="6" fill="#FEC40E"/>
    <rect x="32" y="58" width="32" height="6" fill="#086738"/>
  </g>
  <image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"
         href="data:image/png;base64,${b64}"
         xlink:href="data:image/png;base64,${b64}"/>${comAlerta ? '\n  <circle cx="51" cy="13" r="11" fill="#ED1C24" stroke="#FFFFFF" stroke-width="3.5"/>' : ''}
</svg>
`;
fs.writeFileSync(process.argv[3] + '/favicon.svg', svg(false));
fs.writeFileSync(process.argv[3] + '/favicon-alerta.svg', svg(true));
console.log(`favicons: raio ${w}x${h} em x=${x} y=${y}`);
