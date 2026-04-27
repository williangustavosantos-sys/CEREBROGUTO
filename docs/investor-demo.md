# GUTO Investor Demo - zero cost setup

Objetivo: deixar até 20 testers usando o GUTO sem login e sem custo fixo, mantendo memória separada por navegador.

## Arquitetura de demo

- Corpo: Vercel free tier.
- Cérebro: Render/Railway/Fly free tier, ou máquina local com túnel apenas para demo controlada.
- Memória: JSON local via `GUTO_MEMORY_FILE`.
- Identidade de usuário: `anon-uuid` persistido no `localStorage` do navegador.

## Limites conscientes

- Sem autenticação real.
- Memória não é durável se o host apagar disco efêmero.
- Uma pessoa em outro navegador vira outro usuário.
- Não serve para lançamento público, serve para teste fechado e apresentação.

## Variáveis obrigatórias

Backend:

```bash
PORT=3001
GUTO_ALLOWED_ORIGINS=https://seu-corpo.vercel.app,http://localhost:3000
GEMINI_API_KEY=
OPENAI_API_KEY=
VOICE_API_KEY=
```

Frontend:

```bash
NEXT_PUBLIC_API_URL=https://seu-cerebro.onrender.com
```

## Checklist antes de abrir para testers

1. Rodar `npm run eval:guto -- --no-judge` no cérebro.
2. Rodar `npm run build` no corpo.
3. Testar onboarding em aba anônima.
4. Testar dois navegadores diferentes e confirmar memórias diferentes.
5. Testar Safari: avatar, chat, microfone e botão de missão.
6. Ver logs do backend para erros 429, 500 ou timeout.

## Próxima troca obrigatória

Quando sair de 20 testers fechados, trocar JSON por banco real via `MemoryStore`.
