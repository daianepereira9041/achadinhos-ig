# Achadinhos IG: gera a arte ou o vídeo, publica no Instagram e manda o link por DM

## 1. Subir no Render
1. Crie um repositório novo no GitHub com **todos** estes arquivos: `server.js`, `midia.js`, `painel.html`, `package.json`, `package-lock.json`, `.gitignore`, `.env.example`, `README.md`. Não envie token nem chave secreta.
2. No Render: **New > PostgreSQL**. Copie a **Internal Database URL**.
3. No Render: **New > Web Service**, escolha o repositório.
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Em **Environment**, crie: `IG_ACCESS_TOKEN`, `IG_APP_SECRET`, `IG_VERIFY_TOKEN`, `ADMIN_KEY` (senha longa inventada por você) e `DATABASE_URL`. `PUBLIC_URL` é opcional no Render.
5. Aguarde o deploy. Abrir o endereço do serviço no navegador deve mostrar `ok`.

Para receber webhooks de forma confiável, o serviço não pode hibernar (o plano gratuito hiberna). Para gerar vídeos, prefira um plano com pelo menos 1 GB de memória.

## 2. Ligar o webhook na Meta
No app **DP Achadinhos**, em **Instagram > Configuração da API com login do Instagram**, na parte de webhooks:
- **URL de callback:** `https://SEU-SERVICO.onrender.com/webhook`
- **Token de verificação:** o mesmo valor de `IG_VERIFY_TOKEN`
- Assine o campo **comments**.

## 3. Assinar a sua conta e testar o token
```bash
curl -X POST https://SEU-SERVICO.onrender.com/api/instagram/assinar -H "x-admin-key: SUA_ADMIN_KEY"
curl https://SEU-SERVICO.onrender.com/api/instagram/eu -H "x-admin-key: SUA_ADMIN_KEY"
```
A segunda chamada deve devolver o `@` da sua conta.

## 4. Usar o painel
Abra `https://SEU-SERVICO.onrender.com/painel` e entre com a `ADMIN_KEY`. No painel você escolhe a plataforma e o formato (imagem ou Reels), preenche nome, preço, link de afiliado e palavra-chave, clica em **Gerar arte**, confere a prévia e clica em **Publicar**. A senha fica salva só no seu navegador. Depois de 10 tentativas erradas, o acesso daquele endereço de rede é bloqueado por 15 minutos.

O painel tem modo claro e escuro e funciona no celular.

## 5. Token do Instagram: renovação automática
O serviço renova o token sozinho (checa a cada 12 horas e renova quando passam 30 dias). O token renovado fica guardado no banco. A Meta costuma exigir que o token tenha mais de 24 horas para renovar, então a primeira renovação pode falhar no dia em que você gerou o token. O serviço tenta de novo depois. O painel mostra quantos dias faltam, e o botão **Renovar agora** força a renovação.

Se você gerar um token novo na Meta e trocar `IG_ACCESS_TOKEN` no Render, o serviço passa a usar o novo.

## 6. Criar um achadinho pela linha de comando (opcional)

**Post de imagem (feed 4:5):**
```bash
curl -X POST https://SEU-SERVICO.onrender.com/api/achadinhos \
  -H "x-admin-key: SUA_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"nome":"Fone Bluetooth","preco":"59,90","plataforma":"Shopee","link":"https://link-de-afiliado","keyword":"FONE","foto_url":"https://endereco-da-foto-do-produto.jpg"}'
```

**Reels (vídeo de 8 segundos, 9:16):** acrescente `"formato":"reels"`.

- `foto_url` é opcional. Sem ela, a arte sai com o painel colorido "OFERTA". Use só fotos que você tem direito de divulgar (as lojas de afiliados costumam ter regras sobre isso).
- Se você já tem a sua própria arte pronta, mande `image_url` (JPEG, endereço público `https://`) e nada é gerado.
- A resposta traz o `id` e o endereço da mídia (`image_url` ou `video_url`). Abra no navegador para conferir antes de publicar.
- O vídeo leva de 10 a 40 segundos para gerar.

Depois publique: `POST /api/achadinhos/ID/publicar` (com o cabeçalho `x-admin-key`). Vídeos podem levar um tempo extra enquanto o Instagram processa.

## 7. Testar o "comentou, recebeu"
Comente a palavra-chave no post com **outra conta**. Comentários da própria conta são ignorados de propósito. Se nada chegar, olhe os logs do Render e confira se a conta de teste tem função no app (Testador).

## Limites
- A resposta privada só vale por 7 dias após o comentário. Cada comentário gera no máximo uma DM.
- O token do Instagram precisa ser renovado antes de vencer (cerca de 60 dias). Isso vem na próxima etapa.
- As mídias geradas ficam no banco de dados, então não somem quando o Render reinicia.
