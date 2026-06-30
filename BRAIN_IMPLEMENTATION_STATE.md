# BRAIN_IMPLEMENTATION_STATE.md — Estado da Migração do Cérebro Soberano

> **Handoff de contexto.** Qualquer IA/dev deve LER este arquivo antes de continuar a
> migração do cérebro soberano do GUTO. Ele registra o estado exato para sobreviver à
> compactação de contexto. **Não reconstrua a conversa — continue daqui.**
>
> ⚠️ **ATENÇÃO — leia primeiro:** este template foi pedido com a Fatia 2B como "próxima",
> mas **a Fatia 2B JÁ FOI CONCLUÍDA e validada viva nesta sessão**. As seções 6–11 abaixo
> ficam como **registro do que foi feito na 2B** (não refaça). A **próxima tarefa real é a
> Fatia 2C** (ver seção 12).

---

## 1. Estado atual

- **Repo:** CEREBROGUTO (submódulo local em `guto-backend/`; este arquivo está na raiz dele).
- **Branch atual:** `feat/brain-slice1`
- **PR:** **#87 — DRAFT** (https://github.com/williangustavosantos-sys/CEREBROGUTO/pull/87)
- **Flag principal:** `GUTO_BRAIN_SLICE1` (estrita `=== "true"`, default OFF).
- **Flag OFF mantém o legado intacto** (byte-idêntico — provado pela suíte completa).
- **Nenhum merge feito.** PR continua draft.
- **Frontend intocado. Produção intocada.** Flag NÃO ativada no `.env` (default OFF).
- **Último commit:** `f865e01` (Fatia 2B).
- **Node:** `/opt/homebrew/bin/node` (export `PATH="/opt/homebrew/bin:$PATH"` antes de rodar).
- **Rodar testes:** `cd guto-backend && npm run typecheck` e `node --import tsx --test --test-concurrency=1 <arquivo>`. Suíte completa: `node scripts/run-guto-tests.mjs`.

### Commits da migração (mais recentes no topo)
```
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

---

## 3. Estado de testes conhecido (mais recente)

- **Fatia 1+2A+2B: 109/109** ✅ (`node --import tsx --test tests/guto-brain-*.test.ts`)
- **Backend completo flag OFF: 847/847** ✅ (`node scripts/run-guto-tests.mjs`)
- **Typecheck: verde** ✅ (`npm run typecheck`)
- **Validação viva 2A:** 14 cenários com Gemini real — chantagem 0, agenda 0, presença OK.
- **Validação viva 2B:** 10 cenários com Gemini real — 5/5 treinos executados pelo cérebro, template legado 0, re-ask 0, chantagem 0.
- Sem vazamento de meta/validation. Sem resposta dupla. PR #87 continua draft.

*(Números históricos por etapa: Fatia 1 = 80/80 + 818 backend; 2A = 99/99 + 837 backend; 2B = 109/109 + 847 backend.)*

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

## 12. PRÓXIMA AÇÃO REAL — Fatia 2C (aguardando autorização do fundador)

A 2B está pronta, testada e validada viva. **A próxima fatia (não autorizada ainda) é a 2C.**

Pela auditoria de migração (Fase 2), a sequência de menor risco × maior retorno de identidade é:
- **2C — Adaptação/dor/continuidade**: garantir que `repairInvalidExerciseSubstitutionResponse`/
  `enforceDecisiveSwap` (L3) NÃO mutem a fala do cérebro; reclassificar como trilho/validador.
- **2D — Dieta & swaps (resolvers L1)**: migrar os resolvers pré-modelo de "decidir antes do
  cérebro" para "observação/ferramenta" (catálogo de alimentos/exercícios como trilho).
- **2E — Áudio (`/guto-audio`)**: rotear transcrição → `decideTurn` (trivial após texto pronto).
- **2F — Proatividade & base-plan (`/guto/proactive`)**: migrar a máquina de estado proativa.
- **2G — Remoção**: quando as 3 superfícies roteiam 100% por `decideTurn` sem defer, deletar
  `askGutoModel` + `classifyContractIntent` + `enforceTrainingFlowCertainty` +
  `enforceExecutionGateBeforeWorkout` + a escada. `askGutoModel` deixa de existir no fim da 2F.

**Como continuar:** aguardar o fundador autorizar a 2C; então implementar a fatia inteira
(sem microparadas), testar (typecheck + suíte da fatia + backend completo flag OFF), validar
viva com Gemini real, e só então entregar o relatório final. Manter tudo atrás da flag, PR draft,
sem merge, sem frontend, flag OFF intacta.
