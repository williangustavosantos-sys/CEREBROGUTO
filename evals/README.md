# GUTO Behavior Evals

Este diretório guarda a bateria de perguntas que valida se o GUTO continua sendo um sistema de ação e accountability.

## Rodar

Com o backend ligado em outra aba:

```bash
npm run dev
```

rode:

```bash
npm run eval:guto
```

## Rodar com Promptfoo

Com o backend ligado:

```bash
npm run eval:promptfoo
```

Para testar um recorte sem disparar a bateria toda:

```bash
npm run eval:promptfoo -- --filter-first-n 3
```

Para filtrar por grupo ou caso no Promptfoo, use o texto da descricao:

```bash
npm run eval:promptfoo -- --filter-pattern resistencia
npm run eval:promptfoo -- --filter-pattern cansaco_comum_01
```

## Rodar só um grupo

```bash
npm run eval:guto -- --group resistencia
```

## Rodar só um caso

```bash
npm run eval:guto -- --id cansaco_comum_01
```

## Rodar sem rubrica LLM

```bash
npm run eval:guto -- --no-judge
```

## Arquivos

- `guto-cases.jsonl`: perguntas e expectativas de comportamento.
- `promptfoo/`: provider, gerador de testes e asserts usados pelo Promptfoo.
- `reports/`: relatórios gerados localmente, ignorados pelo Git.

Cada caso testa comportamento, não frase exata. Use `forbidden` para bloquear respostas genéricas e `rubric` para avaliar condução, postura e coerência com o projeto.
