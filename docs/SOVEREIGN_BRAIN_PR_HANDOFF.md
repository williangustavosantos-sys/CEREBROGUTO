# Sovereign Brain PR Handoff

## Resumo Para PR

Este PR converte o backend do GUTO para um fluxo principal de decisão único: o
Cérebro Soberano. O objetivo foi remover autoridade do parlamento legado sem
trocar UI, produção, autenticação, persistência, stores, sanitizers ou executores
úteis.

O que mudou:
- `/guto` decide por `runSovereignBrainTurn`, usando `WorldStateV2`,
  `buildSovereignBrainPrompt` e `dispatchSovereignBrainAction`.
- `/guto-audio` transcreve áudio e envia o texto transcrito para o mesmo fluxo
  soberano.
- O contrato aceita as ações soberanas atuais: `none`, `updateWorkout`,
  `generateDiet`, `swapExercise`, `openProactiveCard` e `callCoach`.
- Treino, dieta, troca de exercício, proatividade, memória, voz e stores ficam
  como executores/estado. Eles não escolhem personalidade, fala ou intenção.
- `askGutoModel`, `classifyContractIntent`, `isResistance`, `isGrief`,
  `enforceTrainingFlowCertainty` e templates antigos permanecem fisicamente para
  compatibilidade/testes históricos, mas não comandam o chat principal.

Por que mudou:
- O sistema antigo podia reescrever fala, intenção e estratégia depois que o
  cérebro já havia decidido.
- A convergência elimina dupla personalidade, templates de streak guilt, tique
  de agenda e re-asks de memória que já estava disponível.
- Como não há usuários reais ativos dependendo do comportamento antigo, a melhor
  arquitetura é um único fluxo de decisão.

## Arquitetura Atual

```
Entrada
↓
Auth, rate limit, segurança aguda e sanitizers
↓
assembleWorldStateV2
↓
buildSovereignBrainPrompt + decideTurn
↓
validateContract
↓
dispatchSovereignBrainAction
↓
Executores e stores
↓
Sanitizers finais
↓
Resposta
```

Papéis:
- Cérebro: `runSovereignBrainTurn`, `WorldStateV2`,
  `buildSovereignBrainPrompt`, `decideTurn`, contrato soberano.
- Trilhos: memória, risco, treino atual, dieta atual, exercício ativo,
  proatividade, pending cards, contexto diário, catálogo, `missingFields` e
  histórico recente.
- Executores: curador de treino, gerador/validador de dieta, troca de exercício,
  proatividade/card store, memória, XP/Arena, voz/TTS, transcrição e stores.
- Sanitizers: autenticação, segurança aguda, rate limit, validação de contrato,
  validação de catálogo, idioma, payload público e prevenção de vazamento interno.
- Legado físico: mantido sem autoridade no fluxo principal até a limpeza
  estrutural posterior.

## Fluxo `/guto`

1. A rota valida acesso ativo, serializa o turno e carrega memória.
2. Segurança aguda pode bloquear antes do cérebro quando há risco imediato.
3. O backend monta `WorldStateV2` com fatos do usuário, treino, dieta, risco,
   proatividade, catálogo e histórico.
4. `buildSovereignBrainPrompt` cria o prompt próprio do cérebro, sem depender de
   `buildGutoBrainPrompt`.
5. `decideTurn` chama o modelo governado e valida o contrato.
6. `dispatchSovereignBrainAction` executa apenas a ação escolhida pelo cérebro.
7. A fala do cérebro é preservada; executores podem anexar plano/dieta/card, mas
   não substituir personalidade.
8. Sanitizers finais removem campos internos e mantêm a resposta pública estável.

Fallbacks estruturados continuam dentro do fluxo soberano. Uma ação desconhecida
vira resposta segura estruturada, não uma chamada para outro cérebro.

## Fluxo `/guto-audio`

1. A rota recebe multipart com arquivo `audio`.
2. `transcribeWithOpenAI` transforma áudio em texto quando `OPENAI_API_KEY` está
   configurada.
3. O texto transcrito entra como `input` em `runSovereignBrainTurn`.
4. A resposta textual é a mesma do cérebro soberano.
5. Se `VOICE_API_KEY` existir, o backend chama o executor TTS diretamente. Em
   serverless, não depende de `localhost:3001`.

Status: o roteamento transcrição -> cérebro soberano está coberto por teste
determinístico. O áudio real no preview Vercel ainda depende de configurar
`OPENAI_API_KEY`.

## Env Vars Necessárias

Backend `/guto`:
- `GEMINI_API_KEY`
- `GUTO_GEMINI_MODEL`
- `JWT_SECRET`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `GUTO_TIME_ZONE`
- `GUTO_ALLOWED_ORIGINS`
- `GUTO_RATE_LIMIT_MAX_REQUESTS`
- `GUTO_RATE_LIMIT_WINDOW_MS`
- `GUTO_MODEL_TIMEOUT_MS`
- `GUTO_MODEL_TEMPERATURE`

Backend opcionais/por superfície:
- `VOICE_API_KEY` para TTS.
- `OPENAI_API_KEY` para `/guto-audio` real.
- `FRONTEND_PUBLIC_URL` para links/cookies quando aplicável.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` ou `ADMIN_KEY` para fluxos admin.
- `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY`, `PUSH_VAPID_SUBJECT` e
  `PUSH_CRON_SECRET` para push.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`,
  `STRIPE_PRICE_ANNUAL`, `STRIPE_PRICE_BETA` para assinaturas.

Frontend staging/local:
- `GUTO_BACKEND_PROXY_URL`
- `NEXT_PUBLIC_GUTO_API_URL`
- `NEXT_PUBLIC_API_URL` como fallback legado

Vercel backend:
- `api/index.ts` define `GUTO_DISABLE_LISTEN=1`.
- `vercel.json` usa `npm ci`, `npm run typecheck` e rewrite `/(.*)` para
  `/api/index`.
- O runtime esperado é Vercel Function Node, sem processo local em `:3001`.

## Rotas Validadas

- `/health`: validado no backend preview.
- `/guto`: validado por testes locais, smoke Vercel direto e smoke via frontend.
- `/guto-audio`: validado por teste determinístico de roteamento após transcrição.
- `/guto/proactive`: validado no fluxo em que `openProactiveCard` aparece como
  ação soberana e a UI aceita o payload.
- Frontend proxy `/api/guto/guto`: validado no navegador local e no Vercel
  staging público.

## Previews Testados

Backend soberano:
- `https://cerebroguto-sovereign-smoke-p4jbstvux.vercel.app`
- `https://cerebroguto-sovereign-smoke-j5l1k8oh3.vercel.app`

Frontend staging:
- `https://corpoguto-avnyttjoa-williangustavosantos-sys-projects.vercel.app`
- Branch frontend: `test/card-block-contract-e2e`
- Branch backend: `feat/brain-slice1`

## Smoke Scenarios

Backend Vercel `/guto` com Gemini real:
- `oi` -> `none`
- `estou triste` -> `none`
- `bora treinar` -> `updateWorkout`
- `quero treinar braço` -> `updateWorkout`
- `meu joelho está ruim` -> `none`
- `quero trocar esse exercício` -> `none` ou `swapExercise` conforme contexto
- `quero dieta` -> `generateDiet`
- `não como lactose` -> `none`
- `viajo amanhã` -> `openProactiveCard`
- `voltei depois de duas semanas` -> `none`

Frontend staging público:
- `oi`
- `estou triste`
- `bora treinar`
- `quero treinar braço`
- `quero dieta`
- `viajo amanhã`
- `voltei depois de duas semanas`

Resultado esperado: status 200, resposta única, sem loading infinito, sem CORS,
sem redirect indevido para `/acesso-pausado` ou `/login`, sem meta leak, sem
prompt legado no payload público e sem resposta dupla.

## Testes Executados

Validação desta preparação de PR:
- Horário: `2026-07-01T16:08:12Z` (`2026-07-01 18:08:12 CEST`).
- Frontend `guto-app-v0`: `npx tsc --noEmit` passou.
- Frontend `guto-app-v0`: `npm test` passou, 95/95.
- Frontend `guto-app-v0`: `npm run build` passou.
- Backend `guto-backend`: `npm run typecheck` passou.
- Backend `guto-backend`: `node --import tsx --test --test-concurrency=1 tests/guto-brain-*.test.ts`
  passou, 133/133.

Backend:
- `npm run typecheck`
- `node --import tsx --test --test-concurrency=1 tests/guto-brain-*.test.ts`
- `node scripts/run-guto-tests.mjs` foi executado nas validações anteriores da
  convergência/smoke e permaneceu verde.

Frontend:
- `npx tsc --noEmit`
- `npm test`
- `npm run build`

## Riscos Remanescentes

- Áudio real no preview ainda não foi validado sem `OPENAI_API_KEY`.
- O preview frontend pode exigir Vercel Authentication; teste externo precisa de
  `_vercel_share` válido ou proteção desativada apenas em staging.
- `server.ts` continua grande.
- Código legado físico ainda existe. Ele deve ser removido depois, com cuidado
  para não quebrar testes históricos enquanto o PR estiver em revisão.
- Produção ainda não foi promovida; o PR está pronto para revisão, não para merge
  automático sem checklist de release.

## Rollback

Sem migração destrutiva foi feita. Stores, memória, autenticação e executores
permanecem os mesmos.

Rollback backend:
- Não promover o preview para produção, ou redeployar o deployment de produção
  anterior.
- Se o PR já tiver sido integrado em algum ambiente, reverter os commits da
  convergência/handoff ou apontar o serviço para o deployment anterior.

Rollback frontend:
- Restaurar `GUTO_BACKEND_PROXY_URL`, `NEXT_PUBLIC_GUTO_API_URL` e
  `NEXT_PUBLIC_API_URL` para o backend anterior, ou redeployar o commit frontend
  anterior.

Rollback operacional:
- Manter `OPENAI_API_KEY` ausente não afeta chat textual.
- Desabilitar o preview público ou remover `_vercel_share` se o staging não deve
  ficar acessível externamente.
