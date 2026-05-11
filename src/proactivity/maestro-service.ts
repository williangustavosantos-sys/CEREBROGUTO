import { supabase } from '../supabaseClient';
import { getContextByUser } from './context-service';

const PRIORITY_MAP: Record<string, number> = {
  health_risk: 10,
  health: 7,
  mood: 4,
  travel: 3,
  routine: 3,
};

export async function evaluate(userId: string) {
  const contexts = await getContextByUser(userId);
  if (!contexts || contexts.length === 0) return [];

  const enqueued: string[] = [];

  for (const ctx of contexts) {
    // Check if already pending for this context
    const { data: existing } = await supabase
      .from('opportunity_queue')
      .select('id')
      .eq('user_id', userId)
      .eq('trigger_type', ctx.category)
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle();

    if (existing) continue;

    const priority = PRIORITY_MAP[ctx.category] ?? 5;

    const { error } = await supabase.from('opportunity_queue').insert({
      user_id: userId,
      trigger_type: ctx.category,
      payload: { context_id: ctx.id, key: ctx.key, value: ctx.value },
      priority,
      status: 'pending',
      scheduled_for: new Date().toISOString(),
    });

    if (!error) enqueued.push(ctx.category);
  }

  return enqueued;
}
