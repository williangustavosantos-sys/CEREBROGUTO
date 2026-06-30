# BRAIN_IMPLEMENTATION_STATE.md — Estado da Migração do Cérebro Soberano

> **Handoff de contexto.** Qualquer IA/dev deve LER este arquivo antes de continuar a
> migração do cérebro soberano do GUTO. Ele registra o estado exato para sobreviver à
> compactação de contexto. **Não reconstrua a conversa — continue daqui.**
>
> ⚠️ **ATENÇÃO — leia primeiro:** as Fatias **1, 2A, 2B e 2C JÁ FORAM CONCLUÍDAS** e
> validadas vivas. As seções 6–11 ficam como registro da 2B (não refaça). A **próxima
> tarefa real é a Fatia 2D** (ver seção 12). A seção 13 registra o que foi feito na 2C.

---

## 1. Estado atual

- **Repo:** CEREBROGUTO (submódulo local em `guto-backend/`; este arquivo está na raiz dele).
- **Branch atual:** `feat/brain-slice1`
- **PR:** **#87 — DRAFT** (https://github.com/williangustavosantos-sys/CEREBROGUTO/pull/87)
- **Flag principal:** `GUTO_BRAIN_SLICE1` (estrita `=== "true"`, default OFF).
- **Flag OFF mantém o legado intacto** (byte-idêntico — provado pela suíte completa).
- **Nenhum merge feito.** PR continua draft.
- **Frontend intocado. Produção intocada.** Flag NÃO ativada no `.env` (default OFF).
- **Último commit:** o commit da **Fatia 2C** (este — adaptação/dor/continuidade). `b447318` era o handoff; antes, `f865e01` (2B).
- **Node:** `/opt/homebrew/bin/node` (export `PATH="/opt/homebrew/bin:$PATH"` antes de rodar).
- **Rodar testes:** `cd guto-backend && npm run typecheck` e `node --import tsx --test --test-concurrency=1 <arquivo>`. Suíte completa: `node scripts/run-guto-tests.mjs`.

### Commits da migração (mais recentes no topo)
```
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
- `src/brain/types.ts` — `ReducedWorldState`, `TurnContract`, `RiskObservation`, `SovereignField`, `TurnAcao`.
- `src/brain/validate-contract.ts` — valida FORMA + decide acao suportada (`none`, `updateWorkout`).
- `src/brain/assemble-world-state.ts` — função PURA; observações `risk`/`missingFields`.
- `src/brain/decide-turn.ts` — chamada governada própria; preserva acao; persist honesto.
- `server.ts`:
  - `runSovereignBrainSlice1(...)` (~12100): orquestra o caminho do cérebro (flag ON).
  - `buildBrain2ADirective(ws)`: diretriz soberana anexada SÓ no cérebro.
  - `generateAndCommitBrainWorkout(...)`: EXECUTOR de treino do cérebro (2B).
  - Interceptação no handler `app.post("/guto", ...)`: `brainResult = config.brainSlice1 ? await runSovereignBrainSlice1(...) : null; const result = brainResult ?? await askGutoModel(...)`.
  - Atalho L3: `if (brainResult && (result.acao === "none" || result.acao === "updateWorkout")) return res.json(result);`
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

- **Fatia 1+2A+2B+2C: 120/120** ✅ (`node --import tsx --test tests/guto-brain-*.test.ts`)
- **Backend completo flag OFF: 858/858** ✅ (`node scripts/run-guto-tests.mjs`)
- **Typecheck: verde** ✅ (`npm run typecheck`)
- **Validação viva 2A:** 14 cenários com Gemini real — chantagem 0, agenda 0, presença OK.
- **Validação viva 2B:** 10 cenários com Gemini real — 5/5 treinos executados pelo cérebro, template legado 0, re-ask 0, chantagem 0.
- **Validação viva 2C:** 10 cenários com Gemini real (flag ON) — **cérebro possui 10/10**, defer 0, **template legado 0, re-ask 0, chantagem de streak 0**, menção a interface 0, vazamento de meta 0, resposta dupla 0; treino executado 8/10 (os 2 `acao:none` perguntaram DECISIVAMENTE qual exercício — sem contexto, conduta correta).
- Sem vazamento de meta/validation. Sem resposta dupla. PR #87 continua draft.

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

## 12. PRÓXIMA AÇÃO REAL — Fatia 2D (aguardando autorização do fundador)

A 2C está pronta, testada e validada viva (seção 13). **A próxima fatia (não autorizada ainda) é a 2D.**

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

**Como continuar:** aguardar o fundador autorizar a 2D; então implementar a fatia inteira
(sem microparadas), testar (typecheck + suíte da fatia + backend completo flag OFF), validar
viva com Gemini real, e só então entregar o relatório final. Manter tudo atrás da flag, PR draft,
sem merge, sem frontend, flag OFF intacta.

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
