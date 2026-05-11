import { config } from "dotenv";
config();

import { supabase } from "./supabase-client";

async function testConnection() {
  console.log("🔌 Testando conexão com Supabase...\n");

  // Testa se as tabelas existem
  const tables = [
    "context_bank", "channel_weights", "opportunity_queue",
    "proactive_messages", "admin_alerts", "guto_errors"
  ];

  for (const t of tables) {
    const { error } = await supabase.from(t).select("id").limit(1);
    if (error) {
      console.log(`❌ ${t}: ${error.message}`);
    } else {
      console.log(`✅ ${t}: ok`);
    }
  }

  // Testa RPC claim
  const { error: rpcErr } = await supabase.rpc("claim_next_opportunity", {
    p_user_id: "test-user-000"
  });
  if (rpcErr) {
    console.log(`\n❌ RPC claim_next_opportunity: ${rpcErr.message}`);
  } else {
    console.log(`\n✅ RPC claim_next_opportunity: ok`);
  }

  // Testa RPC enqueue
  const { data, error: enqErr } = await supabase.rpc("enqueue_opportunity", {
    p_user_id: "test-user-000",
    p_channel: "check_in",
    p_payload: { reason: "connection_test" },
    p_score: 0.50,
    p_health_risk: false,
  });
  if (enqErr) {
    console.log(`❌ RPC enqueue_opportunity: ${enqErr.message}`);
  } else {
    console.log(`✅ RPC enqueue_opportunity: ${data || "ok (null = dedup)"}`);
  }

  // Limpa o teste
  await supabase
    .from("opportunity_queue")
    .delete()
    .eq("user_id", "test-user-000");

  console.log("\n🧹 Dados de teste limpos");
  console.log("🎉 Conexão e schema validados!");
}

testConnection().catch(console.error);
