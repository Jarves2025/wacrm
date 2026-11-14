# Deploy no Railway + Neon

Este fork roda **sem Supabase Cloud e sem Hostinger**:

- **Neon** = banco Postgres.
- **Railway** = hospeda o app Next.js e os serviços open-source que o app
  usa via `supabase-js` (Auth, API REST, Storage, Realtime).

O código do app não muda: ele continua falando a API do Supabase, só que
apontada para o gateway no Railway (`NEXT_PUBLIC_SUPABASE_URL`).

## Arquitetura

```
navegador ──► app (Next.js)          ── Railway, público
    │             │
    └─────────────┴──► gateway (Caddy) ── Railway, público
                          /auth/v1     ─► auth     (supabase/gotrue)
                          /rest/v1     ─► rest     (postgrest/postgrest)
                          /storage/v1  ─► storage  (supabase/storage-api + volume)
                          /realtime/v1 ─► realtime (supabase/realtime)
                                               │
                                               ▼
                                         Neon Postgres
```

| Serviço Railway | Fonte | Porta |
| --- | --- | --- |
| `app` | este repo, `Dockerfile` da raiz | 3000 (público) |
| `gateway` | este repo, root dir `infra/railway/gateway` | 8000 (público) |
| `auth` | imagem `supabase/gotrue:v2.197.0` | 9999 |
| `rest` | imagem `postgrest/postgrest:v14.18` | 3000 |
| `storage` | imagem `supabase/storage-api:v1.89.12`, volume em `/var/lib/storage` | 5000 |
| `realtime` | imagem `supabase/realtime:v2.148.3` | 4000 |

Coloque todos os serviços na mesma região do Neon (ex.: Railway
`us-east4` + Neon `aws-us-east-1`). Cada query atravessa essa distância.

## Passo a passo

### 1. Neon

1. Crie um projeto (Postgres 17). Em **Settings → Logical replication**,
   ligue a replicação lógica (o Realtime precisa).
2. Copie a connection string **direta** (sem `-pooler`) do role dono do
   banco (`neondb_owner`).

### 2. Segredos

Gere uma vez e guarde:

```bash
node -e "const c=require('crypto');for(const k of ['JWT_SECRET','ENCRYPTION_KEY','REALTIME_SECRET_KEY_BASE','AUTOMATION_CRON_SECRET'])console.log(k+'='+c.randomBytes(32).toString('hex'));for(const k of ['AUTHENTICATOR_PASSWORD','AUTH_ADMIN_PASSWORD','STORAGE_ADMIN_PASSWORD'])console.log(k+'='+c.randomBytes(24).toString('hex'));console.log('REALTIME_DB_ENC_KEY='+c.randomBytes(8).toString('hex'))"
```

`ANON_KEY` e `SERVICE_ROLE_KEY` são JWTs HS256 assinados com
`JWT_SECRET`, payload `{"role":"anon"}` e `{"role":"service_role"}`
(com `iss`, `iat`, `exp`). Exemplo:

```bash
JWT_SECRET=... node -e "const c=require('crypto');const s=process.env.JWT_SECRET;const b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');const now=Math.floor(Date.now()/1e3);for(const role of ['anon','service_role']){const h=b({alg:'HS256',typ:'JWT'}),p=b({role,iss:'supabase',iat:now,exp:now+315360000});console.log(role,h+'.'+p+'.'+c.createHmac('sha256',s).update(h+'.'+p).digest('base64url'))}"
```

### 3. Bootstrap do banco

Cria os roles (`anon`, `authenticated`, `service_role`, `authenticator`,
`supabase_auth_admin`, `supabase_storage_admin`, `supabase_realtime_admin`
e os substitutos `postgres`, `supabase_admin`, `dashboard_user` que as
migrations dos serviços citam), schemas `auth`/`storage`/`realtime` e a
publication `supabase_realtime`:

```bash
DATABASE_URL='postgresql://neondb_owner:...@ep-xxx.neon.tech/neondb?sslmode=require' \
AUTHENTICATOR_PASSWORD=... AUTH_ADMIN_PASSWORD=... STORAGE_ADMIN_PASSWORD=... \
node scripts/neon-setup.mjs bootstrap
```

O script usa o driver WebSocket do Neon (porta 443), então funciona mesmo
em redes que bloqueiam a 5432.

### 4. Railway

Crie um projeto com os 6 serviços da tabela. Variáveis compartilhadas
(Project → Variables → Shared):

```
JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY
NEON_HOST=ep-xxx.c-NN.us-east-1.aws.neon.tech   # host direto, sem -pooler
NEON_DB=neondb
```

**auth**

```
PORT=9999
GOTRUE_API_HOST=::
GOTRUE_API_PORT=9999
API_EXTERNAL_URL=https://${{gateway.RAILWAY_PUBLIC_DOMAIN}}/auth/v1
GOTRUE_DB_DRIVER=postgres
GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:<AUTH_ADMIN_PASSWORD>@${{shared.NEON_HOST}}/${{shared.NEON_DB}}?sslmode=require
GOTRUE_DB_NAMESPACE=auth
GOTRUE_SITE_URL=https://${{app.RAILWAY_PUBLIC_DOMAIN}}
GOTRUE_URI_ALLOW_LIST=https://${{app.RAILWAY_PUBLIC_DOMAIN}}/**,http://localhost:3000/**
GOTRUE_JWT_SECRET=${{shared.JWT_SECRET}}
GOTRUE_JWT_EXP=3600
GOTRUE_JWT_AUD=authenticated
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
GOTRUE_JWT_ADMIN_ROLES=service_role
GOTRUE_EXTERNAL_EMAIL_ENABLED=true
GOTRUE_MAILER_AUTOCONFIRM=true      # sem SMTP: contas confirmam sozinhas
GOTRUE_DISABLE_SIGNUP=false
```

Para e-mails reais (reset de senha, troca de e-mail), configure
`GOTRUE_SMTP_HOST/PORT/USER/PASS`, `GOTRUE_SMTP_ADMIN_EMAIL` e coloque
`GOTRUE_MAILER_AUTOCONFIRM=false`.

**rest**

```
PORT=3000
PGRST_SERVER_HOST=*6
PGRST_SERVER_PORT=3000
PGRST_DB_URI=postgres://authenticator:<AUTHENTICATOR_PASSWORD>@${{shared.NEON_HOST}}/${{shared.NEON_DB}}?sslmode=require
PGRST_DB_SCHEMAS=public
PGRST_DB_EXTRA_SEARCH_PATH=public,extensions
PGRST_DB_ANON_ROLE=anon
PGRST_DB_POOL=10
PGRST_JWT_SECRET=${{shared.JWT_SECRET}}
PGRST_DB_USE_LEGACY_GUCS=false
```

**storage** (+ volume montado em `/var/lib/storage`)

```
PORT=5000
SERVER_PORT=5000
SERVER_HOST=::
RAILWAY_RUN_UID=0
ANON_KEY=${{shared.ANON_KEY}}
SERVICE_KEY=${{shared.SERVICE_ROLE_KEY}}
AUTH_JWT_SECRET=${{shared.JWT_SECRET}}
PGRST_JWT_SECRET=${{shared.JWT_SECRET}}
POSTGREST_URL=http://${{rest.RAILWAY_PRIVATE_DOMAIN}}:3000
DATABASE_URL=postgres://supabase_storage_admin:<STORAGE_ADMIN_PASSWORD>@${{shared.NEON_HOST}}/${{shared.NEON_DB}}?sslmode=require
STORAGE_PUBLIC_URL=https://${{gateway.RAILWAY_PUBLIC_DOMAIN}}
REQUEST_ALLOW_X_FORWARDED_PATH=true
FILE_SIZE_LIMIT=52428800
STORAGE_BACKEND=file
FILE_STORAGE_BACKEND_PATH=/var/lib/storage
GLOBAL_S3_BUCKET=stub
TENANT_ID=stub
REGION=stub
ENABLE_IMAGE_TRANSFORMATION=false
```

**realtime**

```
PORT=4000
DB_HOST=${{shared.NEON_HOST}}
DB_PORT=5432
DB_USER=neondb_owner          # precisa de REPLICATION
DB_PASSWORD=<senha do neondb_owner>
DB_NAME=${{shared.NEON_DB}}
DB_SSL=true
DB_IP_VERSION=ipv4
DB_AFTER_CONNECT_QUERY=SET search_path TO _realtime
DB_ENC_KEY=<REALTIME_DB_ENC_KEY, 16 caracteres>
API_JWT_SECRET=${{shared.JWT_SECRET}}
METRICS_JWT_SECRET=${{shared.JWT_SECRET}}
SECRET_KEY_BASE=<REALTIME_SECRET_KEY_BASE>
ERL_AFLAGS=-proto_dist inet_tcp
DNS_NODES=''
APP_NAME=realtime
SEED_SELF_HOST=true
RUN_JANITOR=true
```

No serviço `realtime`, ligue também **Settings → Networking → Outbound
IPv6** (`ipv6EgressEnabled`): a conexão do tenant resolve o Neon por IPv6
e ignora `DB_IP_VERSION`.

**gateway** (root directory `infra/railway/gateway`, domínio público na porta 8000)

```
PORT=8000
AUTH_UPSTREAM=http://${{auth.RAILWAY_PRIVATE_DOMAIN}}:9999
REST_UPSTREAM=http://${{rest.RAILWAY_PRIVATE_DOMAIN}}:3000
STORAGE_UPSTREAM=http://${{storage.RAILWAY_PRIVATE_DOMAIN}}:5000
REALTIME_UPSTREAM=http://${{realtime.RAILWAY_PRIVATE_DOMAIN}}:4000
```

**app** (domínio público na porta 3000)

```
PORT=3000
NEXT_PUBLIC_SUPABASE_URL=https://${{gateway.RAILWAY_PUBLIC_DOMAIN}}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${{shared.ANON_KEY}}
SUPABASE_SERVICE_ROLE_KEY=${{shared.SERVICE_ROLE_KEY}}
NEXT_PUBLIC_SITE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
NEXT_PUBLIC_APP_LOCALE=pt
ENCRYPTION_KEY=...
META_APP_SECRET=...
AUTOMATION_CRON_SECRET=...
```

`NEXT_PUBLIC_*` entram no build: mudou, faça redeploy do `app`.

### 5. Migrations do app

Depois que `auth` e `storage` subirem uma vez (eles criam `auth.users` e
`storage.objects`):

```bash
DATABASE_URL='postgresql://neondb_owner:...@ep-xxx.neon.tech/neondb?sslmode=require' \
node scripts/neon-setup.mjs migrate
```

Roda `supabase/migrations/*.sql` em ordem, cada arquivo numa transação,
e registra em `public._wacrm_migrations` (re-executar só aplica as novas).
Diferença para o Supabase Cloud: o Neon não tem superusuário `postgres`,
então `OWNER TO postgres` vira `OWNER TO CURRENT_USER` (o dono do banco,
que tem BYPASSRLS e é dono das tabelas).

### 6. Realtime no Neon

Dois ajustes, depois que o serviço `realtime` subir uma vez (ele cria o
tenant `realtime-dev` em `_realtime.tenants`):

1. **Senha do tenant com `endpoint=`.** O Realtime conecta no banco do
   tenant via TLS **sem SNI**, e o Neon usa o SNI para achar o endpoint.
   O contorno documentado do Neon é a senha `endpoint=<ep-id>$<senha>`.
   A conexão principal do Realtime (com SNI) precisa da senha normal, então
   só a senha guardada do tenant muda:

   ```bash
   DATABASE_URL='postgresql://neondb_owner:...@ep-xxx.neon.tech/neondb?sslmode=require' \
   REALTIME_DB_ENC_KEY=<DB_ENC_KEY do realtime> \
   node scripts/neon-setup.mjs realtime-tenant
   ```

   Depois reinicie o serviço `realtime`.

2. **Migrations do tenant.** 4 migrations do Realtime criam funções com
   `SET log_min_messages`, que só superusuário pode. O script aplica essas
   sem a cláusula e deixa o próprio Realtime aplicar o resto:

   ```bash
   DATABASE_URL='postgresql://neondb_owner:...@ep-xxx.neon.tech/neondb?sslmode=require' \
   SUPABASE_URL=https://<domínio do gateway> ANON_KEY=... REALTIME_VERSION=v2.148.3 \
   node scripts/realtime-neon-migrations.mjs
   ```

   Termina com `realtime: all N tenant migrations applied`. Rode de novo
   se atualizar a imagem do Realtime.

### 7. Cron das automações (opcional)

Passos "Aguardar" das automações precisam de um ping periódico. Crie um
serviço Railway com cron `*/5 * * * *` e start command:

```bash
curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://$APP_DOMAIN/api/automations/cron
```

### 8. Webhook do WhatsApp

Na Meta, use `https://<domínio do app>/api/whatsapp/webhook`.

## Limitações conhecidas

- Sem SMTP configurado, não há e-mail de reset de senha nem de
  confirmação (as contas são autoconfirmadas). A tela de cadastro ainda
  mostra "Verifique seu e-mail", mas a conta já entra logada.
- CORS é respondido no gateway (`Access-Control-Allow-Origin: *`), como o
  Kong faz no Supabase. O supabase-js autentica por header, não cookie.
- O Realtime mantém uma conexão de replicação aberta, então o compute do
  Neon não hiberna enquanto ele roda.
- Storage em volume do Railway (uma única réplica). Para produção, troque
  para `STORAGE_BACKEND=s3` com um Railway Bucket.
