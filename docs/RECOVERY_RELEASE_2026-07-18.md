# GUTO Recovery Release — relatório final de validação

Data: 2026-07-18

Escopo: CEREBROGUTO + CORPOGUTO
Veredito técnico desta execução: **PRONTO PARA TESTE REAL**

## 1. Critério de aceite executado

Esta release foi validada contra o fluxo publicado completo, sem seed de onboarding e sem artefatos injetados:

`idioma → autenticação/convite → consentimento → nome → calibragem → pacto → sistema`

O aceite exigiu, imediatamente após o pacto e antes de abrir qualquer aba:

- missão persistida;
- treino persistido;
- dieta persistida;
- reidratação por reload;
- reidratação em outro navegador sem storage;
- leitura pelo URL exato do deployment do backend;
- Gemini e Redis de produção reais.

Também foi executada literalmente a mensagem `Supino reto máquina ocupado?`, exigindo resposta útil e nenhuma memória, confirmação, card ou alteração lateral inventada.

## 2. Documentação canônica usada

As decisões preservam os contratos descritos em:

- `GUTO-RAIZ/PARTE_2_CONSENTIMENTO_NOME_CALIBRAGEM_PACTO.md`;
- `GUTO-RAIZ/GUTO_CALIBRAGEM_E_MEMORIA_DETALHADA.md`;
- `docs/GUTO_FASE_2_VALIDACAO_CONSENTIMENTO_NOME_CALIBRAGEM_PACTO.md` do CORPOGUTO;
- `docs/GUTO_FASE_2C_AUDITORIA_CALIBRAGEM_FLUXO_VIVO.md` do CORPOGUTO;
- `docs/SOVEREIGN_BRAIN_PR_HANDOFF.md` do CEREBROGUTO.

Os pontos aplicados foram: o pacto é o evento que libera o sistema; a calibragem persistida é a fonte dos artefatos; treino e dieta são executores soberanos do backend; o frontend lê o estado persistido; fatos e cards precisam ter origem na fala real do usuário.

## 3. Causas-raiz e correções

### 3.1 Dieta dependia indevidamente da missão

**Causa-raiz:** o backend tinha gates `hasMissionReadyForDiet`, token de concorrência baseado em missão, erro `MISSION_REQUIRED_FOR_DIET` e mutações de `dietGenerationStatus` disparadas pela geração do treino. O frontend repetia a política com `isMissionReadyForDiet`, estado `waiting_mission`, copy “a dieta nasce depois da primeira missão” e geração lateral acionada pela chegada/chat.

**Correção:** missão/treino e dieta passaram a ser consumidores irmãos da mesma calibragem persistida. Foram removidos gates, tokens, erros, copy e mutações cruzadas. Abrir a aba Dieta agora é leitura; ela não encobre um bootstrap quebrado gerando silenciosamente. O retry manual continua independente da existência de missão.

### 3.2 O pós-pacto não era uma transação de produto

**Causa-raiz:** `xpEvent: grant_initial_xp` persistia pacto/XP e liberava o sistema, mas treino e dieta dependiam de efeitos posteriores de chegada ou abertura de aba. Um build verde podia, portanto, entregar um usuário no sistema sem os três artefatos.

**Correção:** `ensurePostPactArtifacts(userId)` é chamado no POST de memória que confirma o pacto. Ele:

1. relê a calibragem persistida;
2. clona o mesmo snapshot para dois workers independentes;
3. gera treino/missão e dieta em paralelo com `Promise.allSettled`;
4. aguarda as escritas;
5. relê os stores duráveis;
6. só devolve sucesso quando treino e dieta realmente existem.

Se algum artefato não ficar durável, o endpoint responde `503 POST_PACT_BOOTSTRAP_INCOMPLETE` com o estado de cada artefato. Não há falso sucesso.

### 3.3 O extrator semântico podia transformar alucinação em memória/card

**Causa-raiz:** o JSON do extrator Gemini era validado por tipo e tamanho, mas `rawText`, `understood`, data e localização não precisavam existir literalmente numa fala `USER:`. Assim, uma inferência inventada podia atravessar o pipeline, ser persistida e virar confirmação/card.

**Correção:** `groundExtractedEvents` virou a fronteira de confiança. Um evento só sobrevive se `rawText` for citação literal de uma fala do usuário. O texto visível fica ancorado nessa citação; data é resolvida a partir dela; localização só sobrevive quando também está nela. O mesmo grounding é reaplicado antes da persistência HTTP.

### 3.4 Testes mascaravam o fluxo real

**Causa-raiz:** cenários chamados de “real user” desativavam Gemini/Redis ou partiam de memória, treino, dieta e onboarding semeados. No frontend, alguns testes codificavam a regra errada dieta→missão e aceitavam geração da dieta como efeito de abrir aba/chat.

**Correção:** esses cenários foram explicitamente reclassificados como auxiliares. Foram removidos aliases enganosos. Os testes 10c–10g do frontend agora verificam dieta independente, aba read-only e retry independente. Foram adicionados testes de backend zero-state pós-pacto e do caso literal do supino com o extrator deliberadamente tentando alucinar “semana corrida”.

## 4. Arquivos alterados

### CEREBROGUTO — commit `890afbf9e347c8c9c93a845df8b9b82234614856`

- `server.ts` — transação pós-pacto, desacoplamento dieta/missão e grounding antes da persistência;
- `src/proactivity/memory-extractor.ts` — fronteira de grounding literal;
- `src/proactivity/index.ts` — export do grounding;
- `src/admin-router.ts` — remoção da política dieta→missão no admin;
- `tests/guto-diet-generation.test.ts` — dieta sem missão, invalidação independente e bootstrap zero-state;
- `tests/guto-proactivity-http.test.ts` — regressão literal do supino e alucinação “semana corrida”;
- `tests/guto-brain-convergence.test.ts` — convergência no novo contrato;
- `scripts/audit-new-user-arrival.ts` — auditoria auxiliar compatível com o contrato;
- `tests/real-user-scenarios/run-real-user-scenarios.ts` — classificação honesta do cenário auxiliar;
- `package.json` — nomes de scripts auxiliares sem alegação de prova real.

### CORPOGUTO — commit `3716d14592164f0e80259f2ad3d333b8c455ba9f`

- `components/guto/guto-app.tsx` — remoção do disparo lateral de dieta;
- `components/guto/tabs/chat-tab.tsx` — chegada não gera dieta no cliente;
- `components/guto/tabs/diet-tab.tsx` — remoção total do gate por missão e abertura read-only;
- `e2e/guto.spec.ts` — testes 10c–10g corrigidos para o contrato oficial.

## 5. Testes locais e CI

### CEREBROGUTO

- `npm test` — PASS, suíte completa;
- `npm run typecheck` — PASS;
- foco dieta — 28/28 PASS;
- foco proatividade/grounding — PASS;
- cenário Gemini auxiliar PT/EN/IT — PASS, identificado como auxiliar porque não usa Redis/produção;
- GitHub Actions `GUTO Cerebro CI / validate` — SUCCESS.

### CORPOGUTO

- `npm test` — 108/108 PASS;
- `npx tsc --noEmit` — PASS;
- `npm run lint` — 0 erros; 1 warning preexistente e fora do escopo;
- `npm run build` — PASS;
- Playwright focal dos novos contratos — 5/5 PASS;
- Playwright completo contra build imutável (`next build` + `next start`) — 88/88 PASS;
- GitHub Actions `GUTO Corpo CI / validate` — SUCCESS;
- GitHub Actions `Playwright Tests / test` — SUCCESS.

Um primeiro ensaio Playwright em `next dev` encontrou um JSON truncado gerado em `.next`. O diretório gerado foi isolado e a regressão completa foi repetida contra build imutável, que passou 88/88. Nenhum arquivo gerado entrou nos commits.

## 6. Commits, PRs e merges de código

### Backend

- commit: `890afbf9e347c8c9c93a845df8b9b82234614856`;
- PR: https://github.com/williangustavosantos-sys/CEREBROGUTO/pull/98;
- CI: SUCCESS;
- merge: `8e1934c200a1bcf8364b3659eadd39429b5be166` em `main`, 2026-07-18T20:46:46Z;
- `origin/main` verificado no merge SHA e contendo o commit de correção.

### Frontend

- commit: `3716d14592164f0e80259f2ad3d333b8c455ba9f`;
- PR: https://github.com/williangustavosantos-sys/CORPOGUTO/pull/89;
- CI + Playwright: SUCCESS;
- merge: `9c6e9db5689d18e962b056ffecf3f3905ed56425` em `main`, 2026-07-18T20:46:44Z;
- `origin/main` verificado no merge SHA e contendo o commit de correção.

## 7. Deployments de produção validados

### Backend

- projeto: `cerebroguto-sovereign-smoke`;
- deployment: `dpl_FiZmZC7WxWRNtEDDHHdqciVndbFd`;
- estado: `READY`, target `production`;
- commit servido: `8e1934c200a1bcf8364b3659eadd39429b5be166`;
- URL imutável: `https://cerebroguto-sovereign-smoke-qf6tsmdo1.vercel.app`;
- alias público: `https://cerebroguto-sovereign-smoke.vercel.app`.

### Frontend

- projeto: `corpoguto`;
- deployment: `dpl_5JHFCCEMMsTiG7ioTBDTB9kgrTVZ`;
- estado: `READY`, target `production`;
- commit servido: `9c6e9db5689d18e962b056ffecf3f3905ed56425`;
- URL imutável: `https://corpoguto-prrmrkor6-williangustavosantos-sys-projects.vercel.app`;
- alias público: `https://corpoguto.vercel.app`.

Os dois aliases públicos responderam HTTP 200. O health do backend retornou `ok: true`, `geminiConfigured: true` e modelo `gemini-3.1-flash-lite`.

## 8. Prova real em produção — usuário novo

Execução final aceita:

- run ID: `recovery-mrqup1q8`;
- intervalo UTC: `2026-07-18T21:00:10.880Z` a `2026-07-18T21:02:04.672Z`;
- usuário realmente novo: `u-d5e35243fb05434e`;
- storage inicial: 0 origins;
- API: real, sem mock;
- onboarding prévio: nenhum;
- memória prévia: nenhuma;
- treino/dieta injetados: nenhum;
- resultado: **59/59 checks aprovados**.

### Sequência comprovada

1. idioma — PASS;
2. convite e autenticação — PASS;
3. consentimento — PASS;
4. nome — PASS;
5. calibragem — PASS;
6. antes do pacto: sem treino, sem dieta e sem proatividade — PASS;
7. pacto → sistema — PASS;
8. antes de abrir abas: missão/treino com 6 exercícios — PASS;
9. antes de abrir abas: dieta com 5 refeições — PASS;
10. XP inicial persistido em 100 — PASS;
11. reload reidratou treino e dieta — PASS;
12. URL imutável do backend leu os mesmos artefatos — PASS;
13. novo contexto de navegador começou com 0 origins — PASS;
14. login limpo reidratou treino e dieta — PASS;
15. abas Missão, Dieta, Arena, Evoluir e Percurso — PASS;
16. artefatos finais continuaram duráveis — PASS;
17. 0 erros de console, 0 page errors, 0 falhas de rede inesperadas e 0 HTTP inesperado — PASS.

A primeira tentativa anterior (`recovery-mrqukxa2`) foi descartada: o script de validação criou um nome com mais de 20 caracteres e a UI corretamente recusou. O gerador de nome foi corrigido e todo o fluxo foi reiniciado com outra conta zero-state; nenhum resultado parcial foi usado como aceite.

## 9. Gemini real

Antes do onboarding, `GET /health/gemini` em produção respondeu HTTP 200 com:

- `ok: true`;
- `quota_ok: true`;
- `reason: ok`;
- modelo `gemini-3.1-flash-lite`.

O chat real do usuário novo executou `POST /guto` em produção com HTTP 200. Não houve flag de Gemini desativado, mock de API ou resposta predefinida na automação.

## 10. Redis real

O projeto Vercel de produção tem `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` configurados como variáveis encrypted de Production.

Às `2026-07-18T21:04:50.145Z`, uma leitura direta autenticada e somente-leitura do Upstash de produção comprovou:

- chave `guto:memory` legível;
- usuário `u-d5e35243fb05434e` presente;
- treino persistido com 6 exercícios;
- chave `guto:diet` legível;
- dieta do mesmo usuário presente com 5 refeições;
- 0 memórias proativas;
- 0 impactos proativos.

As credenciais não foram registradas no relatório nem nos artefatos. O arquivo temporário usado para carregar o ambiente Vercel foi removido imediatamente após a leitura.

Além da leitura direta, reload, login em navegador limpo e requests ao alias e ao deployment imutável recuperaram os mesmos dados em invocações separadas. Na janela do ensaio, os logs Vercel não mostraram 5xx, `error`, `fatal`, falha de Redis ou fallback para filesystem.

## 11. Cenário literal do supino

Entrada real:

> Supino reto máquina ocupado?

Resposta real de produção:

> Supino reto ocupado? Troca por Crucifixo máquina: mantém 4 séries, 8-12, descanso de 90s. Mesma missão, sem ficar parado.

Asserções após aguardar o pipeline assíncrono:

- HTTP 200 — PASS;
- substituição útil — PASS;
- `expectedResponse == null` — PASS;
- `proactiveMemoryAction == null` — PASS;
- 0 cards no turno — PASS;
- nenhuma “semana corrida” na resposta — PASS;
- 0 memórias criadas — PASS;
- 0 impactos criados — PASS;
- 0 confirmações pendentes — PASS;
- 0 card proativo — PASS;
- treino não substituído — PASS;
- agenda e disponibilidade inalteradas — PASS;
- contexto ativo nulo — PASS;
- prompt proativo nulo — PASS.

## 12. Artefatos de evidência

Relatório bruto local, sanitizado e sem credenciais:

- `recovery-mrqup1q8-production-evidence.json`;
- SHA-256: `fd08d7580ddce8f8f75cd620f185432f28276350a460f94ba56a8fc07dc4f4ea`.

Capturas:

- pós-pacto antes das abas — `c07f9ac796dc321b71ca716c5db78197d050f4eeeb3b77f7d9170bde23ef915b`;
- sistema reidratado em navegador limpo — `60e8d42d6811c996e037c692b0f963b3c6920038a99e6707fa10920f43bd89e6`;
- abas publicadas — `fcf0fb224ba160d21eebae4edfc723a55aff634a99f7ad7fff2193a83b5b25a0`;
- resposta grounded do supino — `bd89ac5db99b4cdea10856520763437025bc4f7818e29c30bed75d3d280bbb8d`.

Diretório de execução no Codex:

`/Users/williandossantos/.codex/visualizations/2026/07/18/019f76a9-7b0d-74b2-bdf4-6639fbbd085e/recovery-release/`

## 13. Regressões e encerramento

Não há regressões conhecidas nesta release. As suítes locais, CI dos dois repositórios, E2E completo contra build imutável, produto publicado, runtime Vercel, Gemini real e Redis real foram verificados.

O escopo não alterou apresentação, onboarding visual, regras de treino, cálculo nutricional, XP além do bootstrap, autenticação ou outras superfícies. A mudança restaura o contrato canônico com a menor fronteira necessária: bootstrap pós-pacto soberano, dieta independente e memória estritamente grounded.
