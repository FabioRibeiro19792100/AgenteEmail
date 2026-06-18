# Plataforma de Agentes para Alunos

MVP sem dependencias externas, com:

- importacao administrativa de alunos
- links individuais por `invite_id`
- sessao isolada por aluno
- OAuth Google server-side para Gmail com leitura e operacao confirmada
- composer individual com leitura, preparacao e execucao confirmada
- logs por `user_id` e `turma_id`
- preparacao de rotas para Calendar
- healthchecks para deploy
- container Docker basico

## Rodar

1. Copie `.env.example` para `.env`
2. Preencha as credenciais Google e OpenAI
3. Rode `npm start`
4. Abra `http://localhost:3000/admin/import`

## Observacoes

- Os dados agora devem ficar no Supabase.
- Tokens Google sao armazenados criptografados com AES-256-GCM.
- O frontend nunca recebe a `OPENAI_API_KEY` nem os tokens Google.
- Acoes de escrita viram confirmacoes pendentes antes de qualquer execucao.
- Calendar ficou preparado, mas bloqueado nesta versao.

## Supabase

1. Crie um projeto no Supabase.
2. Rode o SQL de [supabase/schema.sql](/Users/fabioribeiro/Documents/Agente%20Email/supabase/schema.sql) no SQL Editor.
3. Use a `service_role` key apenas no backend.

Variaveis minimas:

- `NODE_ENV=production`
- `APP_BASE_URL=https://seu-dominio`
- `OPENAI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI_GMAIL=https://seu-dominio/api/google/gmail/callback`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `TOKEN_ENCRYPTION_KEY` com segredo forte

## Producao

Checks operacionais:

- `GET /healthz`
- `GET /readyz`

Container:

```bash
docker build -t agente-email .
docker run -p 3000:3000 --env-file .env agente-email
```
