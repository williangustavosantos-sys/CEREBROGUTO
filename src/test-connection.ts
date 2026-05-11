import 'dotenv/config';
import { supabase } from './supabaseClient';

async function test() {
  const tables = ['context_bank', 'opportunity_queue', 'interaction_log'];
  for (const t of tables) {
    const { error } = await supabase.from(t).select('*').limit(1);
    console.log(`${t}: ${error ? 'ERRO - ' + error.message : 'OK'}`);
  }
}

test();
