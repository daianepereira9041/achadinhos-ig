const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const { gerarArte, gerarVideo } = require('./midia');

const {
  IG_ACCESS_TOKEN, IG_APP_SECRET, IG_VERIFY_TOKEN, ADMIN_KEY, DATABASE_URL,
  IG_API_VERSION = 'v26.0', PORT = 3000, PUBLIC_URL, RENDER_EXTERNAL_URL,
} = process.env;
const BASE = (PUBLIC_URL || RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
if (!BASE) { console.error('Falta PUBLIC_URL (endereço público do serviço)'); process.exit(1); }

for (const [k, v] of Object.entries({ IG_ACCESS_TOKEN, IG_APP_SECRET, IG_VERIFY_TOKEN, ADMIN_KEY, DATABASE_URL })) {
  if (!v) { console.error(`Falta a variável de ambiente ${k}`); process.exit(1); }
}

const API = `https://graph.instagram.com/${IG_API_VERSION}`;
let TOKEN = IG_ACCESS_TOKEN;
const pool = new Pool({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } });
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ---------- utilidades ----------
const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
const temPalavra = (texto, palavra) => norm(texto).split(/[^A-Z0-9]+/).includes(norm(palavra));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESPOSTAS = ['Te mandei no direct! 😉', 'Link enviado no seu direct! 🔥', 'Enviei por mensagem, confere lá! 💜', 'Chegou no seu direct! ✅'];

function igual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function ig(path, { method = 'POST', body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Instagram ${r.status}: ${JSON.stringify(data.error || data)}`);
  return data;
}

function legenda(a) {
  return `${a.nome} por R$ ${a.preco} 🔥\n\nComente "${a.keyword}" e receba o link no direct!\n\n#publi · contém links de afiliado`;
}

async function iniciarBanco() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS achadinhos (
      id SERIAL PRIMARY KEY, nome TEXT NOT NULL, preco TEXT NOT NULL, plataforma TEXT NOT NULL,
      link TEXT NOT NULL, keyword TEXT NOT NULL, image_url TEXT, media_id TEXT,
      status TEXT NOT NULL DEFAULT 'fila', comentarios INT NOT NULL DEFAULT 0, dms INT NOT NULL DEFAULT 0,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE achadinhos ALTER COLUMN image_url DROP NOT NULL;
    ALTER TABLE achadinhos ADD COLUMN IF NOT EXISTS foto_url TEXT;
    ALTER TABLE achadinhos ADD COLUMN IF NOT EXISTS video_url TEXT;
    ALTER TABLE achadinhos ADD COLUMN IF NOT EXISTS formato TEXT NOT NULL DEFAULT 'feed';
    CREATE TABLE IF NOT EXISTS midias (
      id SERIAL PRIMARY KEY, achadinho_id INT, tipo TEXT NOT NULL, mime TEXT NOT NULL,
      dados BYTEA NOT NULL, criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS comentarios_atendidos (
      comment_id TEXT PRIMARY KEY, criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
}

async function getCfg(k) { const r = await pool.query('SELECT valor FROM config WHERE chave=$1', [k]); return r.rows[0]?.valor || ''; }
async function setCfg(k, v) {
  await pool.query('INSERT INTO config (chave,valor) VALUES ($1,$2) ON CONFLICT (chave) DO UPDATE SET valor=EXCLUDED.valor', [k, v]);
}

// O token renovado fica no banco. Se você trocar IG_ACCESS_TOKEN no Render, o serviço passa a usar o novo.
async function iniciarToken() {
  const hashEnv = crypto.createHash('sha256').update(IG_ACCESS_TOKEN).digest('hex');
  if ((await getCfg('env_token_hash')) !== hashEnv) {
    await setCfg('env_token_hash', hashEnv);
    await setCfg('ig_token', IG_ACCESS_TOKEN);
    await setCfg('ig_token_renovado_em', '');
    await setCfg('ig_token_expira_em', '');
  }
  TOKEN = (await getCfg('ig_token')) || IG_ACCESS_TOKEN;
}

async function renovarToken() {
  const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(TOKEN)}`;
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Renovação recusada: ' + JSON.stringify(d.error || d));
  TOKEN = d.access_token;
  await setCfg('ig_token', TOKEN);
  await setCfg('ig_token_renovado_em', new Date().toISOString());
  await setCfg('ig_token_expira_em', new Date(Date.now() + (d.expires_in || 5184000) * 1000).toISOString());
}

async function statusToken() {
  const exp = await getCfg('ig_token_expira_em'), ren = await getCfg('ig_token_renovado_em');
  return {
    renovado_em: ren || null, expira_em: exp || null,
    dias_restantes: exp ? Math.max(0, Math.floor((Date.parse(exp) - Date.now()) / 86400000)) : null,
  };
}

async function verificarToken() {
  const ren = await getCfg('ig_token_renovado_em');
  if (!ren || Date.now() - Date.parse(ren) > 30 * 86400000) await renovarToken();
}

async function guardarMidia(achadinhoId, tipo, mime, dados) {
  const r = await pool.query(
    'INSERT INTO midias (achadinho_id,tipo,mime,dados) VALUES ($1,$2,$3,$4) RETURNING id', [achadinhoId, tipo, mime, dados]);
  return `${BASE}/media/${r.rows[0].id}`;
}

async function esperarVideo(containerId) {
  for (let i = 0; i < 40; i++) {
    const st = await ig(`/${containerId}?fields=status_code`, { method: 'GET' });
    if (st.status_code === 'FINISHED') return;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error('O Instagram não aceitou o vídeo: ' + st.status_code);
    await sleep(3000);
  }
  throw new Error('Tempo esgotado esperando o Instagram processar o vídeo');
}

// ---------- mídia gerada (pública: o Instagram precisa baixar) ----------
app.get('/media/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.sendStatus(404);
  const r = await pool.query('SELECT mime, dados FROM midias WHERE id=$1', [req.params.id]);
  if (!r.rowCount) return res.sendStatus(404);
  res.set({ 'Content-Type': r.rows[0].mime, 'Content-Length': r.rows[0].dados.length, 'Cache-Control': 'public, max-age=86400' });
  res.send(r.rows[0].dados);
});

// ---------- rotas do painel (protegidas por ADMIN_KEY) ----------
const falhas = new Map();
const admin = (req, res, next) => {
  const agora = Date.now(), f = falhas.get(req.ip) || { n: 0, ate: 0 };
  if (f.ate > agora) return res.status(429).json({ erro: 'muitas tentativas erradas, aguarde alguns minutos' });
  if (igual(req.get('x-admin-key') || '', ADMIN_KEY)) { falhas.delete(req.ip); return next(); }
  f.n += 1;
  if (f.n >= 10) { f.ate = agora + 15 * 60000; f.n = 0; }
  falhas.set(req.ip, f);
  res.status(401).json({ erro: 'não autorizado' });
};

app.get('/', (_req, res) => res.send('ok'));
app.get('/painel', (_req, res) => res.sendFile(path.join(__dirname, 'painel.html')));

app.get('/api/instagram/token', admin, async (_req, res) => res.json(await statusToken()));
app.post('/api/instagram/renovar', admin, async (_req, res) => {
  try { await renovarToken(); res.json(await statusToken()); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/instagram/eu', admin, async (_req, res) => {
  try { res.json(await ig('/me?fields=user_id,username', { method: 'GET' })); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/instagram/assinar', admin, async (_req, res) => {
  try { res.json(await ig('/me/subscribed_apps?subscribed_fields=comments,messages')); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/achadinhos', admin, async (_req, res) => {
  const r = await pool.query('SELECT * FROM achadinhos ORDER BY id DESC LIMIT 200');
  res.json(r.rows);
});

app.post('/api/achadinhos', admin, async (req, res) => {
  const { nome, preco, plataforma, link, keyword, image_url, foto_url, formato = 'feed' } = req.body || {};
  if (![nome, preco, plataforma, link, keyword].every(Boolean))
    return res.status(400).json({ erro: 'campos obrigatórios: nome, preco, plataforma, link, keyword' });
  if (!/^https?:\/\//i.test(link)) return res.status(400).json({ erro: 'link precisa começar com http(s)://' });
  if (image_url && !/^https:\/\//i.test(image_url)) return res.status(400).json({ erro: 'image_url precisa começar com https://' });
  if (foto_url && !/^https?:\/\//i.test(foto_url)) return res.status(400).json({ erro: 'foto_url precisa começar com http(s)://' });
  if (!['feed', 'reels'].includes(formato)) return res.status(400).json({ erro: "formato: 'feed' (imagem) ou 'reels' (vídeo)" });
  if (!/^[A-Za-z0-9À-ÿ]{2,20}$/.test(keyword))
    return res.status(400).json({ erro: 'keyword: uma palavra só, sem espaços, de 2 a 20 letras/números' });

  const ins = await pool.query(
    'INSERT INTO achadinhos (nome,preco,plataforma,link,keyword,foto_url,formato) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [nome, preco, plataforma, link, norm(keyword), foto_url || null, formato]);
  const a = ins.rows[0];
  try {
    let imgUrl = image_url || null, vidUrl = null;
    const dados = { nome, preco, plataforma, keyword: norm(keyword), fotoUrl: foto_url };
    if (formato === 'reels') {
      const arte = await gerarArte({ ...dados, formato: 'reels' });
      vidUrl = await guardarMidia(a.id, 'video', 'video/mp4', await gerarVideo(arte));
    } else if (!imgUrl) {
      imgUrl = await guardarMidia(a.id, 'imagem', 'image/jpeg', await gerarArte({ ...dados, formato: 'feed' }));
    }
    const u = await pool.query('UPDATE achadinhos SET image_url=$1, video_url=$2 WHERE id=$3 RETURNING *', [imgUrl, vidUrl, a.id]);
    res.status(201).json(u.rows[0]);
  } catch (e) {
    await pool.query('DELETE FROM achadinhos WHERE id=$1', [a.id]);
    await pool.query('DELETE FROM midias WHERE achadinho_id=$1', [a.id]);
    res.status(500).json({ erro: 'falha ao gerar a mídia: ' + e.message });
  }
});

app.post('/api/achadinhos/:id/publicar', admin, async (req, res) => {
  const r = await pool.query('SELECT * FROM achadinhos WHERE id=$1', [req.params.id]);
  const a = r.rows[0];
  if (!a) return res.status(404).json({ erro: 'não encontrado' });
  if (a.status === 'publicado') return res.status(409).json({ erro: 'já publicado' });
  try {
    let c;
    if (a.formato === 'reels') {
      c = await ig('/me/media', { body: { media_type: 'REELS', video_url: a.video_url, caption: legenda(a), share_to_feed: true } });
      await esperarVideo(c.id);
    } else {
      c = await ig('/me/media', { body: { image_url: a.image_url, caption: legenda(a) } });
      await sleep(3000);
    }
    const p = await ig('/me/media_publish', { body: { creation_id: c.id } });
    const u = await pool.query("UPDATE achadinhos SET media_id=$1, status='publicado' WHERE id=$2 RETURNING *", [p.id, a.id]);
    res.json(u.rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- webhook do Instagram ----------
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && igual(req.query['hub.verify_token'] || '', IG_VERIFY_TOKEN))
    return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  const assinatura = req.get('x-hub-signature-256') || '';
  const esperada = 'sha256=' + crypto.createHmac('sha256', IG_APP_SECRET).update(req.rawBody || '').digest('hex');
  if (!igual(assinatura, esperada)) return res.sendStatus(401);
  res.sendStatus(200); // responde rápido; processa depois
  tratarEventos(req.body).catch((e) => console.error('erro no webhook:', e.message));
});

async function tratarEventos(body) {
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      if (ch.field !== 'comments') continue;
      const v = ch.value || {};
      if (!v.id || !v.text || !v.media?.id) continue;
      if (v.from?.id && v.from.id === entry.id) continue; // ignora comentários da própria conta

      const novo = await pool.query(
        'INSERT INTO comentarios_atendidos (comment_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING comment_id', [v.id]);
      if (!novo.rowCount) continue; // já tratado

      const r = await pool.query("SELECT * FROM achadinhos WHERE media_id=$1 AND status='publicado'", [v.media.id]);
      const a = r.rows[0];
      if (!a) continue;
      await pool.query('UPDATE achadinhos SET comentarios = comentarios + 1 WHERE id=$1', [a.id]);
      if (!temPalavra(v.text, a.keyword)) continue;

      try {
        await ig('/me/messages', { body: {
          recipient: { comment_id: v.id },
          message: { text: `Oi! Aqui está o link do produto 👉 ${a.link}\n\n${a.nome} por R$ ${a.preco}\n(link de afiliado)` },
        } });
        await pool.query('UPDATE achadinhos SET dms = dms + 1 WHERE id=$1', [a.id]);
      } catch (e) {
        console.error('falha ao enviar DM:', e.message);
        await pool.query('DELETE FROM comentarios_atendidos WHERE comment_id=$1', [v.id]); // permite nova tentativa se a Meta reenviar
        continue;
      }

      try {
        await ig(`/${v.id}/replies`, { body: { message: RESPOSTAS[Math.floor(Math.random() * RESPOSTAS.length)] } });
      } catch (e) { console.error('falha ao responder comentário:', e.message); }
      await sleep(1500); // ritmo calmo para evitar bloqueios
    }
  }
}

iniciarBanco()
  .then(iniciarToken)
  .then(() => app.listen(PORT, () => console.log(`Servindo na porta ${PORT}`)))
  .then(() => {
    const checar = () => verificarToken().catch((e) => console.error('token:', e.message));
    checar();
    setInterval(checar, 12 * 3600 * 1000);
  })
  .catch((e) => { console.error('erro ao iniciar:', e.message); process.exit(1); });
