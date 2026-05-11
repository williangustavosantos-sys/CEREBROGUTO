import { supabase } from '../supabaseClient';

export interface ContextEntry {
  user_id: string;
  category: string;
  key: string;
  value: Record<string, unknown>;
  confidence?: number;
  source?: string;
}

export async function upsertContext(entry: ContextEntry) {
  const { data, error } = await supabase
    .from('context_bank')
    .upsert(
      {
        user_id: entry.user_id,
        category: entry.category,
        key: entry.key,
        value: entry.value,
        confidence: entry.confidence ?? 1.0,
        source: entry.source ?? 'inferred',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,category,key' }
    )
    .select()
    .single();

  if (error) throw new Error(`upsertContext: ${error.message}`);
  return data;
}

export async function getContextByUser(userId: string) {
  const { data, error } = await supabase
    .from('context_bank')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error) throw new Error(`getContextByUser: ${error.message}`);
  return data;
}

export async function getContextByCategory(userId: string, category: string) {
  const { data, error } = await supabase
    .from('context_bank')
    .select('*')
    .eq('user_id', userId)
    .eq('category', category)
    .order('updated_at', { ascending: false });

  if (error) throw new Error(`getContextByCategory: ${error.message}`);
  return data;
}

export async function deleteContext(userId: string, category: string, key: string) {
  const { error } = await supabase
    .from('context_bank')
    .delete()
    .eq('user_id', userId)
    .eq('category', category)
    .eq('key', key);

  if (error) throw new Error(`deleteContext: ${error.message}`);
}
