# BRAIN_IMPLEMENTATION_STATE.md — Estado da Migração do Cérebro Soberano

> **Handoff de contexto.** Qualquer IA/dev deve LER este arquivo antes de continuar a
> migração do cérebro soberano do GUTO. Ele registra o estado exato para sobreviver à
> compactação de contexto. **Não reconstrua a conversa — continue daqui.**
>
> ⚠️ **ATENÇÃO — leia primeiro:** as Fatias **1, 2A, 2B e 2C JÁ FORAM CONCLUÍDAS** e
> validadas vivas. A sequência antiga **2D/2E/2F/2G foi superada** por decisão do
> fundador. A arquitetura principal agora é a **Convergência do Cérebro Soberano**
> registrada na seção 14. **Não retome a migração por fatias antigas.**

---

## 1. Estado atual

- **Repo:** CEREBROGUTO (submódulo local em `guto-backend/`; este arquivo está na raiz dele).
- **Branch atual:** `main`
- **PR:** **#87 — MERGED** (https://github.com/williangustavosantos-sys/CEREBROGUTO/pull/87)
- **Flag principal histórica:** `GUTO_BRAIN_SLICE1` (estrita `=== "true"`, default OFF), mantida por compatibilidade de testes/config.
- **Convergência:** `/guto` usa o Cérebro Soberano como fluxo principal mesmo com flag OFF; a flag não reativa o parlamento legado.
- **Merge feito:** PR #87 foi mergeado em `main` no commit `dce6cfe`.
- **Produção backend:** promovida para Vercel Production e validada em `/health` + `/guto` (seção 20). Frontend produção continua intocado.
- **Último commit funcional:** `dce6cfe` (`feat(guto): converge chat to sovereign brain (#87)`). `a25fdef` foi o handoff de PR; `2c29770` validou staging frontend; `528903c` conectou frontend ao preview; `0b81999` validou smoke Vercel; `5c490cc` preparou smoke; `c770910` fez a convergência; `b447318` era o handoff; antes, `f865e01` (2B).
- **Node:** `/opt/homebrew/bin/node` (export `PATH="/opt/homebrew/bin:$PATH"` antes de rodar).
- **Rodar testes:** `cd guto-backend && npm run typecheck` e `node --import tsx --test --test-concurrency=1 <arquivo>`. Suíte completa: `node scripts/run-guto-tests.mjs`.

### Commits da migração (mais recentes no topo)
```
<FRONT> chore(guto): connect frontend to sovereign brain preview
<SMOKE> chore(guto): validate sovereign brain on vercel smoke test
<VERCEL> chore(guto): prepare sovereign brain for vercel smoke test
<CONV>  feat(guto): converge fluxo principal para cérebro soberano
<2C>    feat(guto): cérebro possui adaptação/dor/continuidade — L3 vira trilho/validador (2C)
b447318 docs: add sovereign brain implementation handoff
f865e01 feat(guto): cérebro possui updateWorkout — execução de treino soberana (2B)
12a7efb feat(guto): suprime dailyPresence/proatividade no cérebro + reforça regra de felicidade (2A)
8f4cc6b feat(guto): cérebro possui conversa/emoção/identidade com riskOverride + diretriz 2A
f1d2ed0 feat(guto): trava de neutralidade da L3 para turno do cérebro acao:"none" (2A.2)
a78c5b2 feat(brain): assembleWorldState += observações risk e missingFields (2A.1)
a1db2c9 test(brain): GT-1..GT-4 da Fatia 1 (Golden Transcripts)
d5ce997 feat(guto): interceptação única da flag no handler /guto
40052e8 feat(brain): decideTurn — chamada governada própria + persist honesto
707ce3a feat(brain): assembleWorldState reduzido + leitura de feedback
e3b45e9 feat(brain): validateContract — validação só de forma + suporte Fatia 1
750d515 feat(brain): tipos narrow (ReducedWorldState, TurnContract, meta separado)
36f73c4 feat(brain): adiciona feature flag GUTO_BRAIN_SLICE1 (default OFF)
```

### Arquivos-chave do cérebro
- `src/brain/types.ts` — `ReducedWorldState`, `TurnContract`, `RiskObservation`, `SovereignField`, `TurnAcao` expandido (`none`, `updateWorkout`, `generateDiet`, `swapExercise`, `openProactiveCard`, `callCoach`).
- `src/brain/world-state-v2.ts` — `WorldStateV2` e `assembleWorldStateV2`.
- `src/brain/sovereign-prompt.ts` — `buildSovereignBrainPrompt` independente do prompt legado.
- `src/brain/validate-contract.ts` — valida FORMA + ações soberanas suportadas.
- `src/brain/assemble-world-state.ts` — função PURA; observações `risk`/`missingFields`.
- `src/brain/decide-turn.ts` — chamada governada própria; preserva acao; persist honesto.
- `server.ts`:
  - `runSovereignBrainTurn(...)`: fluxo principal soberano V2.
  - `dispatchSovereignBrainAction(...)`: dispatcher de ações (`none`, `updateWorkout`, `generateDiet`, `swapExercise`, `openProactiveCard`, `callCoach`).
  - `runSovereignBrainSlice1(...)`: helper histórico/testes da Fatia 1/2, não é o fluxo principal.
  - `buildBrain2ADirective(ws)`: diretriz soberana anexada SÓ no cérebro.
  - `generateAndCommitBrainWorkout(...)`: EXECUTOR de treino do cérebro (2B).
  - Handler `app.post("/guto", ...)`: retorna via `runSovereignBrainTurn(...)`; `askGutoModel` não é fallback de cérebro alternativo no fluxo principal.
  - `/guto-audio`: transcrição entra no mesmo `runSovereignBrainTurn(...)`.
  - `/guto/proactive`: usa fluxo soberano para decisões de base/proatividade onde há fala/persona; stores/executores permanecem.
- Testes do cérebro: `tests/guto-brain-*.test.ts` (flag, types, validate-contract, assemble-world-state, decide-turn, slice1-handler, slice1 (GT), 2a, 2b).

---

## 2. Fatias concluídas

### Fatia 1 — CONCLUÍDA
- feature flag `GUTO_BRAIN_SLICE1` criada (default OFF);
- `ReducedWorldState`; `TurnContract` (response público vs meta interno);
- `validateContract` (só forma); `assembleWorldState` (pura); `decideTurn` (chamada governada própria, NÃO chama `askGutoModel`);
- interceptação única no `/guto` antes do `askGutoModel`;
- Golden Transcripts GT-1..GT-4; validação viva com Gemini real;
- cérebro assumiu `acao:"none"` simples; tudo atrás da flag.

### Fatia 2A — CONCLUÍDA
- cérebro assumiu conversa, identidade, emoção, fragilidade, retorno e risco;
- `risk` e `missingFields` adicionados ao `ReducedWorldState` (observações/trilho);
- `riskOverride` passou a ser composto pelo cérebro (mesmo `SAFETY_OVERRIDE` do legado) — não defere mais por risco;
- diretriz soberana exclusiva do cérebro (`buildBrain2ADirective`), sem tocar `buildGutoBrainPrompt` compartilhado;
- supressão de `dailyPresence`/proatividade no caminho do cérebro (matou o tique de agenda);
- L3 neutra em `acao:"none"` (atalho `res.json` direto);
- **chantagem de streak ELIMINADA**; **tique de agenda ELIMINADO**; segurança/depressão composta pelo cérebro (CVV via riskOverride); flag OFF intacta.

### Fatia 2B — CONCLUÍDA (nesta sessão)
- cérebro assumiu `acao:"updateWorkout"` (execução de treino simples);
- `validateContract` aceita `updateWorkout`; `decideTurn` PRESERVA a acao;
- `generateAndCommitBrainWorkout` (executor): reusa as MESMAS primitivas do curador legado (curador → fallback determinístico → `safetyFilterWorkoutPlan` → `enforceMinimumWorkoutVolume` → `applyLevelStructure` → `applyWorkoutProgression` → dedupe → validação/repair → finalização + persistência em `memory.lastWorkoutPlan` + commit). **Legado intocado** (duplicação removível na 2G);
- perfil completo (`missingFields` vazio) → executa, preserva fala, sem `askGutoModel`; perfil incompleto → defer honesto; executor falha → defer;
- **template legado ELIMINADO** nos turnos de treino; **re-ask de memória ELIMINADO**; limitação respeitada na execução.

### Fatia 2C — CONCLUÍDA (nesta sessão) — adaptação, dor, continuidade
- cérebro assumiu **dor/limitação/adaptação/continuidade/troca simples**; ver seção 13 (registro completo);
- **L3 deixou de decidir fala:** `enforceDecisiveSwap`/`repairInvalidExerciseSubstitutionResponse` só rodam no legado (atalho `res.json` para `none`/`updateWorkout` já os ignora) — provado por teste;
- decisor L1 `buildExerciseSwapClarityResponse` virou **trilho/fallback** (gated por flag): com a flag ON não pré-empta o cérebro; se o cérebro deferir, é usado como fallback honesto (paridade flag-OFF);
- **validação de catálogo como trilho** dentro do cérebro: substituição inválida (outro grupo muscular) → **defer honesto**, nunca template reescrevendo a voz do cérebro;
- diretriz soberana 2C (`buildBrain2CDirective`, brain-only): adaptação decisiva, limitação conhecida sem re-ask, dificuldade sem cobrança de streak.

---

## 3. Estado de testes conhecido (mais recente)

- **Cérebro/convergência: 133/133** ✅ (`node --import tsx --test --test-concurrency=1 tests/guto-brain-*.test.ts`)
- **Backend completo: 869/869** ✅ (`node scripts/run-guto-tests.mjs`)
- **Typecheck: verde** ✅ (`npm run typecheck`)
- **Smoke Vercel `/guto`: 10/10** ✅ (`https://cerebroguto-sovereign-smoke-p4jbstvux.vercel.app`, seção 16)
- **Validação viva 2A:** 14 cenários com Gemini real — chantagem 0, agenda 0, presença OK.
- **Validação viva 2B:** 10 cenários com Gemini real — 5/5 treinos executados pelo cérebro, template legado 0, re-ask 0, chantagem 0.
- **Validação viva Convergência:** 12 cenários com Gemini real — status 200 em todos, sem vazamento de meta, sem resposta dupla, sem `askGutoModel` como fallback de cérebro; treino executado em pedidos explícitos, dieta via `generateDiet`, restrição alimentar capturada, viagem via trilho proativo, dor/troca sem fallback genérico.
- Sem vazamento de meta/validation. Sem resposta dupla. PR #87 mergeado.

*(Números históricos por etapa: Fatia 1 = 80/80 + 818 backend; 2A = 99/99 + 837 backend; 2B = 109/109 + 847 backend; 2C = 120/120 + 858 backend.)*

---

## 4. Descoberta central (NÃO ESQUECER)

> **O problema principal NÃO é que o cérebro soberano pensa errado.**
> **O cérebro soberano pensa MELHOR que o produto entregue.**
> **O problema é que o LEGADO ainda sobrescreve ou corrompe a decisão do cérebro.**
>
> O trabalho agora é **RETIRAR AUTORIDADE DO LEGADO**, não criar outro cérebro.

Evidência (Calibração 2.0): capturando o JSON cru que o cérebro QUIS emitir vs. o entregue,
4/12 turnos tinham a identidade DESTRUÍDA pelo legado (template, chantagem de streak, re-ask,
amnésia de adaptação) — não pelo cérebro. A migração desarma, um a um, os pontos onde o
legado sobrescreve o cérebro.

**Regra de ouro da migração:** a unidade de migração é o **GATE**, não o turno. Cada gate vira
**trilho** (informa o cérebro) ou **morre** (decisor) — nunca é só removido sem reclassificar.

---

## 5. Inventário trilho vs decisor (resumo)

### SANITIZERS/GUARDRAILS GLOBAIS — PERMANECEM para sempre
- `sanitizeResponsePayload` (chokepoint global de `res.json` — LEI 11).
- parte AGUDA de `enforceSafetyAndLimitationBeforeGates` (risco físico agudo, pré-cérebro).
- parte SANITIZE de `finalizeTurn`.

### TRILHOS — devem INFORMAR o cérebro (observação/ferramenta), nunca decidir
- `classifyRisk` → já vira `worldState.risk` + `riskOverride` (FEITO na 2A).
- constraints de perfil incompleto → já viram `worldState.missingFields` (FEITO na 2A/2B).
- validação de catálogo (`repairInvalidExerciseSubstitutionResponse` como validador).
- constraints de treino/dieta/swap (catálogos dos resolvers L1).

### EXECUTORES — continuam executando APÓS a decisão do cérebro
- `applyMemoryPatch` (persistência).
- curador de treino (`curateWorkout`) — já usado como executor puro pelo cérebro na 2B.
- gerador de dieta.
- transições proativas (quando forem migradas — 2F).

### DECISORES/PARLAMENTO — devem MORRER ou ser absorvidos pelo cérebro
- `classifyContractIntent` (2º classificador redundante).
- `isResistance` / `isGrief` (gatilhos da escada — origem da chantagem de streak).
- `enforceTrainingFlowCertainty` (escada determinística, falas hardcoded).
- parte DECISORA de `enforceExecutionGateBeforeWorkout` (template/re-ask; a constraint virou `missingFields`).
- `buildProactiveInput` (culpa de abandono hardcoded — `/guto/proactive`).
- templates de treino e falas hardcoded que substituem a fala do cérebro.

> Hoje (pós-2B) esses decisores **só rodam em DEFER** — o cérebro já não os alcança nos turnos
> que possui (conversa/emoção/identidade/risco/treino simples). Morrem de vez na 2G.

### Superfícies que ainda chamam `askGutoModel` (precisam migrar p/ remover)
- `/guto` (texto) — interceptado (cérebro possui conversa+emoção+treino simples).
- `/guto-audio` (voz) — NÃO interceptado (Fatia 2E).
- `/guto/proactive` (proatividade + base-plan) — NÃO interceptado (Fatia 2F).

---

## 6. Fatia 2B — (CONCLUÍDA; registro abaixo, NÃO refazer)

A próxima tarefa autorizada ERA a Fatia 2B completa — **já entregue nesta sessão** (commit
`f865e01`, validada viva). O escopo/prompt/testes/cenários ficam registrados nas seções 7–11
como o que foi implementado. **A próxima ação real é a Fatia 2C (seção 12).**

---

## 7. Prompt autorizado da 2B (registro do que foi feito)

Fazer o cérebro soberano assumir `updateWorkout` e execução de treino simples. O cérebro decide
fala, intenção e próxima ação. O curador/executor de treino apenas executa. O legado não pode
substituir a fala do cérebro por templates como:
- "Bora começar: aquecimento na aba treino do dia";
- perguntas repetidas de local/equipamento já conhecido;
- re-ask de idade/dor/local já na memória;
- fechamento genérico de treino.

**Incluído:** updateWorkout simples; execução quando perfil suficiente; `missingFields` para
perfil incompleto; adaptação simples com base no WorldState; preservar fala original do cérebro;
curador como executor; impedir `enforceTrainingFlowCertainty`/`enforceExecutionGateBeforeWorkout`
de substituir a fala; garantir que `acao:"updateWorkout"` do cérebro não caia no legado.

**NÃO incluído:** dieta; swap complexo; equipamento ocupado; proatividade nova; áudio; DuoHealth;
morte; Arena; Avatar; XP; remoção total do `askGutoModel`.

---

## 8. Regras obrigatórias (valem para 2B e seguintes)

- Tudo atrás da flag `GUTO_BRAIN_SLICE1`.
- Flag OFF intacta. PR continua draft. Sem merge. Sem frontend.
- Sem documentos além deste handoff. Sem pular para 2C/2D sem autorização.
- Não remover `askGutoModel` ainda. Não quebrar segurança. Não duplicar persistência.
- Não vazar meta, validation, contexto técnico ou marcadores internos.

---

## 9. Testes obrigatórios da 2B (todos COBERTOS — `tests/guto-brain-2b.test.ts`)

1. Flag OFF continua legado. ✅
2. updateWorkout simples + perfil completo → cérebro possui, executor roda, sem `askGutoModel`. ✅
3. Fala do cérebro preservada após executor. ✅
4. Perfil incompleto → cérebro pergunta com base em `missingFields`, sem template legado. ✅
5. Local/idade/dor já conhecidos → não repergunta. ✅
6. Limitação conhecida → executor recebe constraint. ✅
7. Turno emocional que vira updateWorkout → não cai na escada de streak/template. ✅ (2A + 2B)
8. L3 não altera fala de updateWorkout simples. ✅
9. Persistência não duplica. ✅
10. Sem vazamento de meta/validation. ✅
11. Sem resposta dupla. ✅
12. Turno complexo fora de escopo ainda dá defer para legado. ✅

---

## 10. Validação viva da 2B (FEITA — Gemini real, flag ON)

Cenários: feliz; triste; "bora treinar"; "quero treinar braço"; "só braço hoje"; "meu joelho está
ruim"; "quero mudar meu treino"; "hoje tá difícil"; "voltei depois de 2 semanas"; "qual é meu
treino de hoje?".

**Resultado:** treino executado pelo cérebro **5/5** (bora-treinar, treinar-braço, só-braço,
joelho-ruim, qual-treino); deferido ao legado **0**; **template legado 0**; **re-ask 0**;
**chantagem de streak 0**; vazamento de meta **0**; resposta dupla **0**. Limitação (joelho)
respeitada. Volume do executor verificado = 5 ex no fallback determinístico (paridade com legado).

---

## 11. Riscos conhecidos (válidos para 2B e seguintes)

- Cuidado para NÃO transformar o curador de treino em decisor — ele gera o plano, não decide a fala.
- O executor pode gerar treino, mas **não pode substituir a fala** do cérebro.
- `missingFields` deve INFORMAR o cérebro, não virar template.
- L3 não pode sobrescrever a fala do cérebro (travado via atalho `res.json` para `none`/`updateWorkout`).
- Perfil incompleto → o cérebro pergunta na PRÓPRIA voz (`acao:none`); se mesmo assim pedir treino, defer.
- Turno complexo demais → defer honesto ao legado.
- **Duplicação do executor** (cérebro vs legado) é dívida técnica intencional (paridade flag-OFF), a quitar na 2G.
- Volume de treino depende do curador real (free-tier flash-lite pode vir fino) — afeta legado e cérebro igualmente.

---

## 12. Sequência antiga 2D/2E/2F/2G — SUPERADA

A 2C ficou pronta, testada e validada viva (seção 13), mas a estratégia mudou depois:
o fundador decidiu parar a migração conservadora por fatias e transformar o Cérebro
Soberano no fluxo principal do produto. **Não implementar 2D/2E/2F/2G como projetos
separados.** A convergência arquitetural foi executada na seção 14.

Pela auditoria de migração (Fase 2), a sequência restante de menor risco × maior retorno é:
- **2D — Dieta & swaps (resolvers L1)**: migrar os resolvers pré-modelo de "decidir antes do
  cérebro" para "observação/ferramenta" (catálogo de alimentos/exercícios como trilho). Os
  decisores L1 de swap COMPLEXO ainda vivos (`buildExerciseSubstitutionObjectionResponse`,
  `buildEquipmentBusyFallbackResponse`) e o gate de dieta entram aqui.
- **2E — Áudio (`/guto-audio`)**: rotear transcrição → `decideTurn` (trivial após texto pronto).
- **2F — Proatividade & base-plan (`/guto/proactive`)**: migrar a máquina de estado proativa.
- **2G — Remoção**: quando as 3 superfícies roteiam 100% por `decideTurn` sem defer, deletar
  `askGutoModel` + `classifyContractIntent` + `enforceTrainingFlowCertainty` +
  `enforceExecutionGateBeforeWorkout` + a escada + a DUPLICAÇÃO do executor (2B). `askGutoModel`
  deixa de existir no fim da 2F.

**Como continuar:** não retomar esta sequência. Trabalhar a partir da arquitetura convergida:
um cérebro, um dispatcher, executores/sanitizers/trilhos preservados.

---

## 13. Fatia 2C — registro do que foi feito (CONCLUÍDA; não refazer)

**Objetivo:** migrar adaptação, dor e continuidade para o cérebro; garantir que o L3 não muta
nem corrompe a fala do cérebro (L3 não decide fala — vira trilho/validador).

**Arquivos alterados:**
- `server.ts`:
  - `buildBrain2CDirective(ws)` (NOVO): diretriz soberana brain-only (marker `ADAPTAÇÃO, DOR E
    CONTINUIDADE`) — adaptação decisiva, limitação conhecida sem re-ask, dificuldade sem streak.
    Anexada SÓ no closure do cérebro (`buildGutoBrainPrompt` compartilhado intocado → flag OFF idêntica).
  - `buildExerciseSwapClarityResponse` (gate L1 ~12510): early-return agora gated `&& !config.brainSlice1`.
    Com a flag ON vira FALLBACK: se o cérebro deferir, é usado (paridade flag-OFF) antes do `askGutoModel`.
  - `runSovereignBrainSlice1`: validação de catálogo como TRILHO antes do `return` — se o cérebro
    propôs substituir um exercício do contexto por outro grupo muscular/movimento incompatível,
    DEFERE (return null); nunca reescreve a fala. Mesma condição estrita do reparo legado.
- `tests/guto-brain-2c.test.ts` (NOVO): 11 testes determinísticos (todos os obrigatórios da 2C).

**Princípio central cumprido:** L3 não decide fala. `enforceDecisiveSwap`/`repairInvalid…` só
agem no legado (o atalho `res.json` para `none`/`updateWorkout` já os ignora). A validação de
catálogo protege catálogo via DEFER honesto, nunca via template substituindo a voz do cérebro.

**Testes:** 2C 11/11; brain 120/120; backend flag OFF 858/858; typecheck verde.

**Validação viva (Gemini real, flag ON, 10 cenários):** cérebro possui 10/10; defer 0; template
legado 0; re-ask 0; chantagem de streak 0; menção a interface 0; vazamento de meta 0; resposta
dupla 0. Adaptação de dor (joelho) respeitou a limitação; trocas decisivas (agachamento→leg press);
dificuldade conduzida com continuidade ("não precisa ser perfeito, só precisa ser feito"); 2 turnos
`acao:none` perguntaram DECISIVAMENTE qual exercício (sem contexto de exercício no input — conduta correta).

**O que ainda ficou no legado (dívida intencional, fora do escopo 2C):**
- `buildExerciseSubstitutionObjectionResponse` e `buildEquipmentBusyFallbackResponse` (swap
  complexo/equipamento ocupado) — continuam decisores L1 (escopo 2D).
- Gate de dieta e resolvers L1 de dieta — 2D.
- Duplicação do executor de treino (cérebro vs legado) — quitar na 2G.

**Riscos restantes:** baixos. A validação de catálogo só dispara em contexto real de substituição
(mesma condição do reparo legado), então não causa defer falso em conversa/adaptação normal.

---

## 14. Convergência arquitetural — IMPLEMENTADA

**Objetivo executado:** tornar o Cérebro Soberano o fluxo principal do backend, sem manter
`askGutoModel` como cérebro alternativo para `/guto`.

**Arquitetura final do fluxo principal:**
```
Entrada
↓
Sanitizers/aguda/auth/rate limit
↓
assembleWorldStateV2
↓
buildSovereignBrainPrompt + decideTurn
↓
dispatchSovereignBrainAction
↓
Executores (treino, dieta, swap, proatividade, memória)
↓
Sanitizers finais
↓
Resposta
```

**Arquivos principais novos/alterados:**
- `src/brain/world-state-v2.ts` — WorldStateV2 com memória, risco, treino, dieta,
  exercício ativo, proatividade, pending cards, contexto diário, catálogo,
  missingFields e histórico recente.
- `src/brain/sovereign-prompt.ts` — prompt próprio soberano, sem `buildGutoBrainPrompt`.
- `src/brain/types.ts`, `src/brain/validate-contract.ts`, `src/brain/decide-turn.ts` —
  contrato expandido para ações soberanas.
- `server.ts` — `runSovereignBrainTurn`, dispatcher, executores de dieta/swap/proatividade,
  roteamento principal de `/guto`, `/guto-audio` e partes de `/guto/proactive`.
  - O executor soberano de dieta usa o gerador/validador existente; se o modelo não
    devolve refeições válidas, cai em fallback determinístico validado (macros,
    restrição alimentar e localidade) antes de declarar falha.
- `tests/guto-brain-convergence.test.ts` — cobertura da convergência.

**O que perdeu autoridade:**
- `/guto` não usa `askGutoModel` como fallback de cérebro.
- `/guto-audio` usa transcrição → `runSovereignBrainTurn`; não chama prompt legado,
  `classifyContractIntent` nem `localhost:3001/voz`.
- `classifyContractIntent`, `isResistance`, `isGrief`, `enforceTrainingFlowCertainty`
  e templates hardcoded não participam do fluxo soberano principal.
- Resolvers L1 de dieta/swap viraram resolução operacional/trilho/fallback estruturado,
  não personalidade concorrente.

**O que permanece:**
- Segurança aguda, autenticação, rate limit e sanitizers.
- Persistência/stores.
- Curador de treino, gerador de dieta, validação de catálogo, proatividade/card store,
  XP/Arena, TTS/transcrição como executores/estado.
- `askGutoModel` e parlamento legado ainda existem fisicamente para rotas/testes históricos
  e dívida de limpeza, mas não são autoridade principal de `/guto`.

**Testes finais da convergência:**
- `npm run typecheck` ✅
- `node --import tsx --test --test-concurrency=1 tests/guto-brain-*.test.ts` → **133/133** ✅
- `node scripts/run-guto-tests.mjs` → **869/869** ✅

**Validação viva com Gemini real (memória temporária, sem produção):**
- Cenários: `oi`, `estou triste`, `estou feliz`, `hoje tá difícil`, `bora treinar`,
  `quero treinar braço`, `meu joelho está ruim`, `quero trocar esse exercício`,
  `quero dieta`, `não como lactose`, `viajo amanhã`, `voltei depois de duas semanas`.
- Resultado: status 200 em todos; sem meta/validation/prompt leak; sem resposta dupla;
  treino por `updateWorkout`; dieta por `generateDiet` persistida em store temporário;
  restrição alimentar persistida; viagem/proatividade roteada por trilho; dor/troca
  sem fallback genérico; chamadas Gemini do parlamento antigo = 0.

**Riscos/dívida restante:**
- `server.ts` continua grande; limpeza estrutural física deve ser feita depois, sem mudar
  comportamento.
- `askGutoModel` e funções do parlamento ainda podem ser removidos fisicamente em etapa de
  limpeza, mas já não têm autoridade no fluxo principal.
- Alguns testes históricos ainda mencionam "flag OFF"; hoje isso significa "não quebra",
  não "volta ao cérebro antigo".

---

## 15. Preparação para smoke Vercel — IMPLEMENTADA

**Objetivo executado:** preparar o commit da convergência para teste real via link do
Vercel sem alterar a lógica soberana validada.

**Auditoria de autoridade por rota:**
- `/guto`: fluxo principal exclusivo em `runSovereignBrainTurn`; bloco legado abaixo fica
  comentado/bypassado e sem autoridade.
- `/guto-audio`: áudio → OpenAI transcription → texto transcrito → `runSovereignBrainTurn`;
  não cai em `askGutoModel`, `classifyContractIntent` nem prompt legado.
- `/guto/proactive`: usa `runSovereignBrainTurn` no caminho ativo de fala/persona; o bloco
  antigo com `askGutoModel/buildProactiveInput` está comentado como referência temporária.
- Rotas de dieta, treino, Arena, validação, stores, TTS e memória permanecem como executores,
  sanitizers ou estado, não como cérebro do chat principal.

**Marcação de legado:**
- `askGutoModel`, `classifyContractIntent`, `enforceTrainingFlowCertainty`,
  `buildProactiveInput`, `buildGutoSystemPrompt`, os booleanos internos `isResistance` /
  `isGrief` e `runSovereignBrainSlice1` foram marcados como deprecated em comentários.
- A marcação deixa explícito que eles existem fisicamente só para compatibilidade de
  rotas/testes históricos até a limpeza estrutural.

**Áudio:**
- `/guto-audio` foi validado por teste determinístico: transcrição entra como `input`
  soberano, resposta vem do cérebro V2, sem prompt legado, sem `contractIntent`, sem
  resposta dupla.
- Não há fixture de áudio real versionada nesta etapa; a cobertura usa multipart com
  blob de áudio sintético e stub da transcrição OpenAI para validar o roteamento backend.
- A síntese de voz deixou de fazer `fetch("http://localhost:${PORT}/voz")`; o executor TTS
  é chamado diretamente quando `VOICE_API_KEY` existe. Se a voz falhar/ausentar, a resposta
  textual soberana continua válida.

**Smoke Vercel/local-port:**
- Teste production-like sobe o app em porta efêmera mesmo com `PORT=3001` e valida `/guto`.
- O teste bloqueia chamada a `localhost:3001/voz`, garantindo que o preparo não depende do
  processo local já aberto nessa porta.

**Não alterado:**
- Frontend.
- Produção.
- Merge/PR draft.
- Lógica soberana de decisão.

---

## 16. Smoke Vercel real — VALIDADO

**Objetivo executado:** testar o Cérebro Soberano em endpoint público Vercel, sem frontend,
sem produção e sem criar feature nova.

**Deploy testado:**
- Projeto Vercel isolado: `cerebroguto-sovereign-smoke`.
- URL pública: `https://cerebroguto-sovereign-smoke-p4jbstvux.vercel.app`.
- Deployment: `dpl_5o6c7QbBJRDQzJ68hPCQgPc6zxh5`.
- Horário do smoke: `2026-07-01T05:42:32.024Z` (`2026-07-01 07:42:32 CEST`).
- `/health`: 200, `service:"guto-cerebro"`, Gemini configurado.

**Config Vercel confirmada:**
- `installCommand`: `npm ci`.
- `buildCommand`: `npm run typecheck`.
- `startCommand`: não existe no preview; runtime é Vercel Function via `api/index.ts`.
- Runtime Node: `24.x`.
- Rewrite: `/(.*)` → `/api/index`.
- `GUTO_DISABLE_LISTEN=1` é setado no wrapper serverless; o app Express exportado atende a
  função, sem depender de processo local em `:3001`.
- Aviso conhecido: `memory` em `vercel.json` é ignorado com Active CPU billing; não afeta o smoke.

**Env vars do preview:**
- Presentes para `/guto`: `GEMINI_API_KEY`, `JWT_SECRET`, `UPSTASH_REDIS_REST_URL`,
  `UPSTASH_REDIS_REST_TOKEN`, `GUTO_GEMINI_MODEL`, `GUTO_ALLOWED_ORIGINS`,
  `GUTO_RATE_LIMIT_MAX_REQUESTS`, `GUTO_RATE_LIMIT_WINDOW_MS`, `GUTO_TIME_ZONE`,
  `GUTO_MODEL_TIMEOUT_MS`, `GUTO_MODEL_TEMPERATURE`, `GUTO_CURATOR_MAX_ATTEMPTS`,
  `GUTO_CURATOR_BACKOFF_MS`, `FRONTEND_PUBLIC_URL`.
- `VOICE_API_KEY` presente; TTS não foi exercitado neste smoke textual.
- `OPENAI_API_KEY` ausente; áudio real não foi testado no Vercel. `/guto-audio` segue coberto por
  teste determinístico de roteamento transcrição → cérebro soberano.

**Correções mínimas exigidas pelo preview:**
- Adicionado wrapper serverless `api/index.ts` e `vercel.json`.
- Backend marcado como ESM (`"type":"module"`) e imports locais ajustados com extensão `.js`
  para Node/Vercel.
- Uploads de validação usam `/tmp/guto/validation-images` em Vercel.
- Store de memória: quando Redis está configurado, leitura síncrona usa cache hidratado/Redis,
  não `data/guto-memory.json` empacotado no build. O endpoint `/guto/memory` aguarda a fila de
  persistência para que o próximo turno do chat veja o perfil completo.
- Teste histórico `guto-experience-bugs` atualizado para ESM (`readFileSync/writeFileSync` em
  vez de `require("fs")`).

**Smoke `/guto` com Gemini real:**
Perfil temporário do aluno de smoke persistido no preview: idade 32, objetivo `muscle_gain`,
altura 178, peso 82, sexo biológico `male`, academia, joelho sensível, `não como lactose`.

| Cenário | Status | Ação |
|---|---:|---|
| `oi` | 200 | `none` |
| `estou triste` | 200 | `none` |
| `bora treinar` | 200 | `updateWorkout` |
| `quero treinar braço` | 200 | `updateWorkout` |
| `meu joelho está ruim` | 200 | `none` |
| `quero trocar esse exercício` | 200 | `none` |
| `quero dieta` | 200 | `generateDiet` |
| `não como lactose` | 200 | `none` |
| `viajo amanhã` | 200 | `openProactiveCard` |
| `voltei depois de duas semanas` | 200 | `none` |

**Resultado:** 10/10 passaram. Sem vazamento de meta/validation/prompt, sem resposta dupla,
sem padrões legados (`askGutoModel`, `classifyContractIntent`, `buildGutoBrainPrompt`,
`enforceTrainingFlowCertainty`) no payload público. Treino executou com `updateWorkout`,
dieta roteou por `generateDiet`, viagem criou trilho proativo por `openProactiveCard`.

**Testes locais após o smoke:**
- `npm run typecheck` ✅
- `node --import tsx --test --test-concurrency=1 tests/guto-brain-*.test.ts` → 133/133 ✅
- `node scripts/run-guto-tests.mjs` ✅ (suíte completa verde; todos os blocos com `fail 0`)

**Não alterado:**
- Frontend.
- Produção.
- Merge/PR draft.
- Lógica soberana de decisão.
- Legado físico ainda existe para compatibilidade/testes históricos, mas não tem autoridade no
  fluxo principal de `/guto`.

**Riscos/pendências:**
- Teste real de áudio no Vercel depende de `OPENAI_API_KEY` e fixture/arquivo real; ainda pendente.
- O projeto de smoke está isolado e com proteção SSO desativada para permitir chamadas públicas
  do teste; não confundir com produção.
- `server.ts` continua grande; limpeza estrutural física fica para etapa posterior.

---

## 17. Frontend real conectado ao preview soberano — VALIDADO

**Objetivo executado:** conectar o app real (`guto-app-v0`) ao backend soberano validado no
Vercel Preview sem criar feature nova, sem alterar UI/design/avatar/onboarding e sem tocar
produção.

**Backend usado:**
- `https://cerebroguto-sovereign-smoke-p4jbstvux.vercel.app`
- `/health` já validado na seção 16.

**Configuração do frontend:**
- Variável nova preferencial: `NEXT_PUBLIC_GUTO_API_URL`.
- Compatibilidade preservada: `NEXT_PUBLIC_API_URL` continua aceito como legado.
- Proxy Next local/preview: `GUTO_BACKEND_PROXY_URL` continua sendo o caminho server-side.
- `.env.local` local apontado para o preview soberano (não commitado).
- Vercel Preview do frontend (`corpoguto`, branch `test/card-block-contract-e2e`) recebeu:
  `GUTO_BACKEND_PROXY_URL`, `NEXT_PUBLIC_GUTO_API_URL` e `NEXT_PUBLIC_API_URL`, todas apontando
  para o backend soberano de smoke.

**Arquivos do frontend alterados:**
- `guto-app-v0/lib/api/client.ts` — resolve `NEXT_PUBLIC_GUTO_API_URL` e adiciona
  `suppressAuthRedirect` para chamadas laterais opcionais.
- `guto-app-v0/app/api/guto/[...path]/route.ts` — proxy lê `NEXT_PUBLIC_GUTO_API_URL`.
- `guto-app-v0/lib/api/guto.ts` — contrato aceita ações soberanas (`generateDiet`,
  `swapExercise`, `openProactiveCard`, `callCoach`) e trilhos opcionais de telemetria/proatividade
  não comandam navegação de auth.
- `guto-app-v0/.env.example` e `guto-app-v0/README.md` — documentam o apontamento por env.

**Smoke real pelo navegador:**
- Frontend local: `http://127.0.0.1:3100/?skip-intro=1`
- Backend: `https://cerebroguto-sovereign-smoke-p4jbstvux.vercel.app`
- Horário: `2026-07-01T11:18:38.828Z` (`2026-07-01 13:18:38 CEST`)
- Usuário temporário: `G-SMOKE-ROFAEA` (`Smoke rofaea`)

| Cenário | Status | Ação | UI |
|---|---:|---|---|
| `oi` | 200 | `none` | 1 resposta GUTO, sem duplicar |
| `estou triste` | 200 | `none` | 1 resposta GUTO, sem duplicar |
| `bora treinar` | 200 | `updateWorkout` | payload aceito; UI continua no chat |
| `quero treinar braço` | 200 | `updateWorkout` | payload aceito; UI continua no chat |
| `quero dieta` | 200 | `generateDiet` | payload aceito; UI continua no chat |
| `voltei depois de duas semanas` | 200 | `none` | 1 resposta GUTO, sem duplicar |
| `viajo amanhã` | 200 | `none` + resposta rápida | prompt de confirmação aceito; UI sem crash |

**Resultado:** usuário consegue falar com o GUTO pela interface real. Respostas vêm do backend
soberano via `/api/guto/guto` → `/guto`; sem CORS, sem loading infinito, sem resposta dupla, sem
texto visível de meta/validation/prompt e sem padrões legados no payload checado. Treino e dieta
preservam ações soberanas (`updateWorkout`, `generateDiet`).

**Testes após a conexão frontend:**
- Frontend `guto-app-v0`: `npx tsc --noEmit` ✅
- Frontend `guto-app-v0`: `npm test` → 95/95 ✅
- Frontend `guto-app-v0`: `npm run build` ✅
- Backend `guto-backend`: `npm run typecheck` ✅
- Backend `guto-backend`: `node --import tsx --test --test-concurrency=1 tests/guto-brain-*.test.ts` → 133/133 ✅
- Backend `guto-backend`: `node scripts/run-guto-tests.mjs` ✅ (exit 0; blocos exibidos com `fail 0`)

**Ajuste mínimo encontrado durante o smoke:**
- Subchamadas laterais (`/guto/events`, `/guto/proactive`, `/guto/proactivity/memories`,
  `/guto/proactivity/extract`, `/guto/proactivity/open-weekly`) podiam redirecionar a tela para
  `/acesso-pausado` ao receber 403 transitório/isolado, mesmo quando `/auth/me`, memória e `/guto`
  estavam válidos. Elas agora usam `suppressAuthRedirect`; continuam falhando silenciosamente
  quando não críticas, sem assumir autoridade sobre o chat principal.

**Falhas/observações:**
- Um `GET /guto/proactivity/memories` retornou 403 uma vez logo após criar o aluno temporário no
  preview; depois retornou 200. Com o ajuste, não houve redirect nem quebra da UI.
- Áudio real segue pendente porque o preview do backend não tem `OPENAI_API_KEY` configurada.
- Produção, frontend visual e fluxo soberano do backend não foram alterados.

---

## 18. Frontend Vercel staging público — VALIDADO

**Objetivo executado:** validar o frontend Vercel Preview público/staging na branch
`test/card-block-contract-e2e`, apontado para o backend soberano Preview, sem alterar produção,
sem mudar UI/design e sem criar feature nova.

**Frontend Preview testado:**
- URL final: `https://corpoguto-avnyttjoa-williangustavosantos-sys-projects.vercel.app`
- Deployment: `dpl_CU9wpJ4S2RBG8xssEJceYhdKca3d`
- Commit frontend: `4f0cb01 chore(guto): connect frontend to sovereign brain preview`
- O deployment é protegido por Vercel Authentication; o smoke usou URL temporária oficial
  (`_vercel_share`) expirada em 2026-07-02. O app em si respondeu 200 após o bypass.

**Backend Preview usado no smoke final:**
- URL final: `https://cerebroguto-sovereign-smoke-j5l1k8oh3.vercel.app`
- Deployment: `dpl_12gf3B9WhpbAsQDb8Bfc6Pi8BYUZ`
- Commit backend: `528903c chore(guto): connect frontend to sovereign brain preview`
- `/health`: 200, `service:"guto-cerebro"`, Gemini configurado.
- Persistência validada antes do smoke: aluno temporário criado via admin/invite, consentimento,
  calibragem e `initialXpGranted` persistiram e foram relidos do Preview.

**Config Preview corrigida/confirmada:**
- Frontend branch `test/card-block-contract-e2e`:
  `GUTO_BACKEND_PROXY_URL`, `NEXT_PUBLIC_GUTO_API_URL`, `NEXT_PUBLIC_API_URL` apontando para
  `https://cerebroguto-sovereign-smoke-j5l1k8oh3.vercel.app`.
- Backend branch `feat/brain-slice1`: envs críticas sobrescritas no Preview com os valores
  corretos (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `JWT_SECRET`,
  `GEMINI_API_KEY`, `GUTO_GEMINI_MODEL`, `VOICE_API_KEY`) e `GUTO_TIME_ZONE=Europe/Rome`.
- Correção operacional encontrada: o primeiro backend redeploy herdou `TZ=:UTC`, inválido para
  `Intl.DateTimeFormat`; fixado por `GUTO_TIME_ZONE=Europe/Rome`. Produção não foi alterada.

**Smoke público pelo navegador:**
- Horário: `2026-07-01T12:10:31.523Z` (`2026-07-01 14:10:31 CEST`)
- Usuário temporário: `G-ALUNO-SMOKE-MGRE`

| Cenário | Status | Ação | UI |
|---|---:|---|---|
| `oi` | 200 | `none` | 1 resposta GUTO |
| `estou triste` | 200 | `none` | 1 resposta GUTO |
| `bora treinar` | 200 | `updateWorkout` | treino aceito pela UI |
| `quero treinar braço` | 200 | `updateWorkout` | treino aceito pela UI |
| `quero dieta` | 200 | `generateDiet` | payload aceito pela UI |
| `viajo amanhã` | 200 | `openProactiveCard` | trilho proativo aceito |
| `voltei depois de duas semanas` | 200 | `none` | continuidade soberana, sem card obrigatório |

**Resultado:** 7/7 passaram. Sem CORS, sem loading infinito, sem redirect para
`/acesso-pausado`, sem redirect para `/login`, sem meta/validation/prompt leak, sem resposta
dupla, sem padrões legados no payload/UI e sem HTTP 4xx/5xx em `/api/guto/*` durante o smoke
final.

**Não alterado:**
- Produção.
- UI/design/avatar/onboarding.
- Legado físico.
- Fluxo soberano validado.

**Pendências:**
- O preview público direto ainda exige Vercel Authentication; para teste externo sem login Vercel,
  gerar nova URL `_vercel_share` ou desativar proteção apenas no ambiente de staging.
- Áudio real segue pendente enquanto `OPENAI_API_KEY` não estiver configurada no backend Preview.

---

## 19. Estado pronto para PR — HANDOFF FINAL

**Objetivo executado:** preparar o contexto final de revisão da convergência soberana, sem
alterar fluxo, UI/design, produção ou criar feature nova.

**Status arquitetural para revisão:**
- O fluxo principal do chat é o Cérebro Soberano.
- `/guto` usa `runSovereignBrainTurn` com `WorldStateV2`, `buildSovereignBrainPrompt` e
  `dispatchSovereignBrainAction`.
- `/guto-audio` usa transcrição → `runSovereignBrainTurn`; o áudio real no preview ainda depende
  de `OPENAI_API_KEY`.
- `/guto/proactive` foi validado onde há ação soberana `openProactiveCard` e não devolve autoridade
  ao parlamento legado no chat principal.
- `askGutoModel`, `classifyContractIntent`, `isResistance`, `isGrief`,
  `enforceTrainingFlowCertainty` e templates antigos continuam fisicamente no código para
  compatibilidade/testes históricos, mas não são autoridade do fluxo principal.
- Sanitizers, segurança aguda, autenticação, rate limit, stores, persistência, curador de treino,
  dieta, TTS/transcrição, XP/Arena e proatividade permanecem como proteção/estado/executores.

**Documento de PR criado:**
- `docs/SOVEREIGN_BRAIN_PR_HANDOFF.md`
  - resumo técnico para PR;
  - arquitetura atual;
  - fluxo `/guto`;
  - fluxo `/guto-audio`;
  - env vars necessárias;
  - rotas e previews validados;
  - smoke scenarios;
  - riscos remanescentes;
  - rollback.

**Previews validados:**
- Backend soberano inicial: `https://cerebroguto-sovereign-smoke-p4jbstvux.vercel.app`
- Backend soberano final usado no staging: `https://cerebroguto-sovereign-smoke-j5l1k8oh3.vercel.app`
- Frontend staging público: `https://corpoguto-avnyttjoa-williangustavosantos-sys-projects.vercel.app`

**Commits envolvidos na convergência final:**
- `c770910` — `feat(guto): converge fluxo principal para cérebro soberano`
- `5c490cc` — `chore(guto): prepare sovereign brain for vercel smoke test`
- `0b81999` — `chore(guto): validate sovereign brain on vercel smoke test`
- `528903c` — `chore(guto): connect frontend to sovereign brain preview`
- `2c29770` — `chore(guto): validate sovereign brain on frontend staging`
- Frontend relacionado: `4f0cb01` — `chore(guto): connect frontend to sovereign brain preview`
- Este handoff: `docs(guto): prepare sovereign brain pr handoff`

**Checklist de validação registrada:**
- Validação desta preparação de PR: `2026-07-01T16:08:12Z` (`2026-07-01 18:08:12 CEST`).
- Backend `npm run typecheck`: verde.
- Backend `node --import tsx --test --test-concurrency=1 tests/guto-brain-*.test.ts`:
  133/133 verde.
- Backend completo: `node scripts/run-guto-tests.mjs` verde nas validações de smoke/convergência.
- Frontend local: `npx tsc --noEmit` verde.
- Frontend local: `npm test` 95/95 verde.
- Frontend local: `npm run build` verde.
- Frontend staging público: smoke 7/7 verde.
- Backend Vercel `/guto`: smoke real 10/10 verde com Gemini real.
- Payload público: sem meta leak, sem validation leak, sem prompt legado, sem resposta dupla.
- Produção: intocada.
- PR: segue draft até decisão explícita de revisão/merge.

**Pendências conhecidas para revisão/release:**
- Testar áudio real no preview depois de configurar `OPENAI_API_KEY`.
- Para teste externo do frontend staging, gerar novo `_vercel_share` ou desativar Vercel
  Authentication apenas no ambiente de staging.
- Limpeza física do legado (`askGutoModel` e parlamento antigo) fica para etapa posterior; não
  deve ser feita neste PR de preparação sem nova autorização.
- `server.ts` continua grande; refatoração estrutural é dívida controlada, não bloqueio de smoke.
- Antes de promover produção, repetir checklist de release com envs de produção e rollback pronto.

---

## 20. Produção backend soberana — VALIDADA

**Objetivo executado:** promover o backend soberano para produção Vercel com rollback preparado,
sem alterar frontend produção, UI/design ou código funcional.

**Merge:**
- PR #87 mergeado em `main`.
- Merge commit: `dce6cfe804519fb13fdc1bd523d230b2163778af`
  (`feat(guto): converge chat to sovereign brain (#87)`).

**Produção final validada:**
- URL pública: `https://cerebroguto-sovereign-smoke.vercel.app`
- Deployment final: `dpl_2HtW5gRa8buptWX7oDh3kjqCA6yj`
- URL do deployment: `https://cerebroguto-sovereign-smoke-7j8h1cfsd.vercel.app`
- Commit do deployment: `dce6cfe`
- Horário do smoke: `2026-07-01T17:51:53Z` (`2026-07-01 19:51:53 CEST`).

**Env vars Production verificadas/configuradas:**
- Presentes: `GEMINI_API_KEY`, `GUTO_GEMINI_MODEL`, `JWT_SECRET`,
  `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `GUTO_TIME_ZONE=Europe/Rome`,
  `GUTO_ALLOWED_ORIGINS`, `GUTO_RATE_LIMIT_MAX_REQUESTS`, `GUTO_RATE_LIMIT_WINDOW_MS`,
  `VOICE_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`.
- Ausente: `OPENAI_API_KEY`; áudio real em produção não foi testado.

**Falhas encontradas e correção mínima:**
- O primeiro deploy automático de `main` (`dpl_GsR5zuyViHLTMh5kxzZHNVQtCmfP`) subiu, mas
  `/health` retornou 500 por `JWT_SECRET` ausente/fraco em Production.
- O rollback para o deployment anterior (`dpl_EWcvBgXeT8pHJ3pHwe3ySaxuepDL`) não ficou
  funcional nesse projeto porque aquele build antigo falhava no wrapper ESM (`api/index.js`
  sem `"type":"module"`).
- A promoção do preview validado (`dpl_ELwQpycxC9vgzWcDuvdRZq9WAqpY`) também falhou em runtime
  ao reconstruir com env Production vazio.
- Correção aplicada: configurar somente as env vars Production necessárias e fazer redeploy
  production de `main`, gerando `dpl_2HtW5gRa8buptWX7oDh3kjqCA6yj`.

**Smoke produção:**
- `/health`: 200, `service:"guto-cerebro"`, Gemini configurado.
- Usuário temporário de smoke: `u-ba7d6cd778e846b0`.

| Cenário | Status | Ação | Resultado |
|---|---:|---|---|
| `oi` | 200 | `none` | passou |
| `estou triste` | 200 | `none` | passou |
| `bora treinar` | 200 | `updateWorkout` | passou |
| `quero dieta` | 200 | `generateDiet` | passou |
| `viajo amanhã` | 200 | `openProactiveCard` | passou |

**Verificações do payload público:**
- Sem meta leak.
- Sem validation leak.
- Sem prompt legado/`askGutoModel`/`classifyContractIntent`/`enforceTrainingFlowCertainty`
  no payload.
- Sem resposta dupla.
- Treino roteado por `updateWorkout`.
- Dieta roteada por `generateDiet`.
- Viagem roteada por `openProactiveCard`.

**Rollback preparado:**
- Deployment final `dpl_2HtW5gRa8buptWX7oDh3kjqCA6yj` está marcado como rollback candidate
  pelo Vercel depois do release.
- O rollback automático para os deployments imediatamente anteriores não deve ser usado sem
  revalidação: `dpl_GsR5...` e `dpl_ELw...` falharam por env Production ausente, e
  `dpl_EWcv...` falhou por ESM antigo.
- Caminho seguro de rollback operacional, se necessário: promover novamente o último preview
  saudável (`dpl_HLo4kFCYP7Ydbsh62v2WwM19bSnh`) ou redeployar `main` com as envs Production
  agora configuradas, seguido de `/health` + smoke `/guto`.

**Não alterado:**
- Frontend produção.
- UI/design/avatar/onboarding.
- Legado físico.
- Fluxo soberano funcional além de configuração Production.

**Riscos/pendências:**
- `OPENAI_API_KEY` ausente: `/guto-audio` real em produção ainda não foi validado.
- Runtime logs do deployment final registram warning Node `DEP0169` (`url.parse()`); não bloqueou
  `/health` nem `/guto`, mas deve ser limpo em dívida técnica separada.
- O deploy CLI indicou `gitDirty: 1` por haver scripts de auditoria não rastreados no worktree
  local (`scripts/audit-workout-quality.*`). Eles não fazem parte do fluxo funcional validado.
