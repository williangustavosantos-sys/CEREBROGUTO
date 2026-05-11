import { supabase } from '../supabaseClient';

const TEMPLATES: Record<string, string> = {
  health_risk: 'Isso saiu do território de treino. Para agora. Primeiro resolve isso com um profissional.',
  health: 'Vi que mencionou algo de saúde. Cuidado com isso — se precisar, adapto o treino.',
  mood: 'Percebi que tá num dia mais pesado. Hoje pode ser dia de recuperação ativa.',
  travel: 'Viagem no radar? Posso montar treino com peso corporal pros próximos dias.',
  routine: 'Mudança de rotina detectada. Vou ajustar o plano pra encaixar no novo cenário.',
};

export async function processNext(): Promise<{ sent: boolean; message?: string }> {
  // Claim next opportunity ordered by priority desc
  const { data: opportunities } = await supabase
    .from('opportunity_queue')
    .select('*')
    .eq('status', 'pending')
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1);

  if (!opportunities || opportunities.length === 0) {
    return { sent: false };
  }

  const opp = opportunities[0];

  // Mark as processing
  await supabase
    .from('opportunity_queue')
    .update({ status: 'processing' })
    .eq('id', opp.id);

  // Generate message from template
  const message = TEMPLATES[opp.trigger_type] ?? 'Lembrei de algo que você mencionou. Vamos ajustar.';

  // Log interaction
  await supabase.from('interaction_log').insert({
    user_id: opp.user_id,
    direction: 'outbound',
    channel: 'chat',
    summary: message,
    metadata: { opportunity_id: opp.id, trigger: opp.trigger_type },
  });

  // Mark delivered
  await supabase
    .from('opportunity_queue')
    .update({ status: 'delivered', delivered_at: new Date().toISOString() })
    .eq('id', opp.id);

  return { sent: true, message };
}
