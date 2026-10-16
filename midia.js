const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');
const ffmpeg = require('ffmpeg-static');

const F = (pkg, file) => path.join(__dirname, 'node_modules', '@fontsource', pkg, 'files', file);
GlobalFonts.registerFromPath(F('sora', 'sora-latin-800-normal.woff'), 'SoraXB');
GlobalFonts.registerFromPath(F('sora', 'sora-latin-700-normal.woff'), 'SoraB');
GlobalFonts.registerFromPath(F('figtree', 'figtree-latin-500-normal.woff'), 'FigM');
GlobalFonts.registerFromPath(F('figtree', 'figtree-latin-700-normal.woff'), 'FigB');

const COR = { 'Shopee': '#EE4D2D', 'Amazon': '#FF9900', 'Mercado Livre': '#FFE600', 'Magazine Luiza': '#0086FF' };

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function linhas(ctx, texto, larguraMax, maxLinhas) {
  const palavras = String(texto).split(/\s+/);
  const out = [];
  let atual = '';
  for (const p of palavras) {
    const teste = atual ? atual + ' ' + p : p;
    if (ctx.measureText(teste).width <= larguraMax) atual = teste;
    else { if (atual) out.push(atual); atual = p; }
  }
  if (atual) out.push(atual);
  if (out.length > maxLinhas) {
    out.length = maxLinhas;
    let u = out[maxLinhas - 1];
    while (ctx.measureText(u + '…').width > larguraMax && u.length > 1) u = u.slice(0, -1);
    out[maxLinhas - 1] = u + '…';
  }
  return out;
}

async function baixarFoto(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await loadImage(Buffer.from(await r.arrayBuffer()));
  } catch { return null; }
}

// formato: 'feed' = 1080x1350 (4:5)   |   'reels' = 1080x1920 (9:16)
async function gerarArte({ nome, preco, plataforma, keyword, fotoUrl, formato = 'feed' }) {
  const W = 1080, H = formato === 'reels' ? 1920 : 1350;
  const c = createCanvas(W, H), ctx = c.getContext('2d');
  const cor = COR[plataforma] || '#8B6DFF';

  // fundo
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0A0920'); g.addColorStop(0.55, '#1D1A4A'); g.addColorStop(1, '#3A1F7A');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const brilho = ctx.createRadialGradient(W * 0.85, H * 0.1, 0, W * 0.85, H * 0.1, 700);
  brilho.addColorStop(0, 'rgba(255,77,147,0.35)'); brilho.addColorStop(1, 'rgba(255,77,147,0)');
  ctx.fillStyle = brilho; ctx.fillRect(0, 0, W, H);

  // selo da plataforma
  const topo = formato === 'reels' ? 150 : 70;
  ctx.font = '700 38px FigB';
  const tw = ctx.measureText(plataforma).width + 64;
  rr(ctx, 70, topo, tw, 72, 36); ctx.fillStyle = cor; ctx.fill();
  ctx.fillStyle = plataforma === 'Mercado Livre' ? '#1a1a1a' : '#fff';
  ctx.textBaseline = 'middle'; ctx.fillText(plataforma, 102, topo + 38);
  ctx.fillStyle = '#EEEBFF'; ctx.font = '700 38px FigB'; ctx.textAlign = 'right';
  ctx.fillText('ACHADINHO', W - 70, topo + 38); ctx.textAlign = 'left';

  // painel da foto
  const pY = topo + 130, pH = formato === 'reels' ? 760 : 400, pW = W - 140;
  rr(ctx, 70, pY, pW, pH, 44); ctx.fillStyle = '#ffffff'; ctx.fill();
  const foto = await baixarFoto(fotoUrl);
  if (foto) {
    const esc = Math.min((pW - 60) / foto.width, (pH - 60) / foto.height);
    const fw = foto.width * esc, fh = foto.height * esc;
    ctx.save(); rr(ctx, 70, pY, pW, pH, 44); ctx.clip();
    ctx.drawImage(foto, 70 + (pW - fw) / 2, pY + (pH - fh) / 2, fw, fh);
    ctx.restore();
  } else {
    const gp = ctx.createLinearGradient(70, pY, 70 + pW, pY + pH);
    gp.addColorStop(0, cor); gp.addColorStop(1, '#8B6DFF');
    rr(ctx, 70, pY, pW, pH, 44); ctx.fillStyle = gp; ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.font = '800 150px SoraXB'; ctx.textAlign = 'center';
    ctx.fillText('OFERTA', W / 2, pY + pH / 2); ctx.textAlign = 'left';
  }

  // nome
  let y = pY + pH + 60;
  ctx.fillStyle = '#FFFFFF'; ctx.font = '800 58px SoraXB'; ctx.textBaseline = 'top';
  for (const l of linhas(ctx, nome, W - 140, 3)) { ctx.fillText(l, 70, y); y += 72; }

  // preço
  y += 20;
  const txt = 'R$ ' + preco;
  ctx.font = '800 96px SoraXB';
  const pw = ctx.measureText(txt).width + 90;
  const gb = ctx.createLinearGradient(70, y, 70 + pw, y + 150);
  gb.addColorStop(0, '#6D4AFF'); gb.addColorStop(1, '#FF4D93');
  rr(ctx, 70, y, pw, 150, 40); ctx.fillStyle = gb; ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(txt, 115, y + 78);

  // chamada para comentar
  const rodape = H - 250;
  ctx.fillStyle = 'rgba(255,255,255,0.10)'; rr(ctx, 70, rodape, W - 140, 150, 40); ctx.fill();
  ctx.fillStyle = '#EEEBFF'; ctx.font = '500 40px FigM'; ctx.textBaseline = 'top';
  ctx.fillText('Comente', 110, rodape + 28);
  ctx.fillStyle = '#FFE600'; ctx.font = '800 64px SoraXB';
  ctx.fillText(String(keyword).toUpperCase(), 110, rodape + 72);
  const larg = ctx.measureText(String(keyword).toUpperCase()).width;
  ctx.fillStyle = '#EEEBFF'; ctx.font = '500 40px FigM';
  ctx.fillText('e receba o link no direct', 110 + larg + 24, rodape + 92);

  ctx.fillStyle = 'rgba(238,235,255,0.7)'; ctx.font = '500 30px FigM'; ctx.textAlign = 'center';
  ctx.fillText('#publi  ·  contém links de afiliado', W / 2, H - 70); ctx.textAlign = 'left';

  return c.toBuffer('image/jpeg', 90);
}

// MP4 de 8s (9:16) com zoom lento, entrada suave e faixa de áudio silenciosa
function gerarVideo(jpegBuf) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ach-'));
    const entrada = path.join(dir, 'arte.jpg'), saida = path.join(dir, 'video.mp4');
    fs.writeFileSync(entrada, jpegBuf);
    const vf = "scale=1296:2304,zoompan=z='1+0.0002*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30,fade=t=in:st=0:d=0.6,format=yuv420p";
    const args = ['-y', '-loop', '1', '-framerate', '30', '-t', '8', '-i', entrada,
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest',
      '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart', saida];
    execFile(ffmpeg, args, { timeout: 120000 }, (err, _o, se) => {
      try {
        if (err) return reject(new Error('ffmpeg: ' + String(se).slice(-400)));
        resolve(fs.readFileSync(saida));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  });
}

module.exports = { gerarArte, gerarVideo };
