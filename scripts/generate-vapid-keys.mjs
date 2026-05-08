#!/usr/bin/env node
// Gera o par de chaves VAPID para Web Push.
// Uso: node scripts/generate-vapid-keys.mjs
//
// Cole o resultado nas envs PUSH_VAPID_PUBLIC_KEY e PUSH_VAPID_PRIVATE_KEY do
// backend (Render). A pública também precisa estar disponível no frontend
// como NEXT_PUBLIC_PUSH_VAPID_PUBLIC_KEY (Vercel).
//
// NUNCA comite a chave privada — só a pública pode ir para o frontend.

import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("Generated VAPID keys. Save in env vars.\n");
console.log(`PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`PUSH_VAPID_SUBJECT=mailto:app.guto.life@gmail.com  # ajuste se mudar`);
console.log(`PUSH_CRON_SECRET=<gere um random; ex: openssl rand -hex 32>`);
console.log(`\nFrontend (Vercel):`);
console.log(`NEXT_PUBLIC_PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}`);
