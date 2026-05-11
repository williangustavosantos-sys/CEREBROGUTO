import { upsertContext } from './context-service';

interface Signal {
  category: string;
  key: string;
  value: Record<string, unknown>;
  confidence: number;
}

const HEALTH_RISK_TERMS = [
  'dor no peito', 'falta de ar', 'desmaiei', 'desmaio', 'sincope',
  'vomitando sangue', 'tontura forte', 'palpitação', 'formigamento',
  'não consigo respirar', 'autolesão', 'me machucar', 'suicídio'
];

const HEALTH_TERMS = [
  'dor', 'lesão', 'machuquei', 'médico', 'tendinite', 'hérnia',
  'cirurgia', 'fisioterapia', 'anti-inflamatório', 'torci'
];

const MOOD_TERMS = ['cansado', 'exausto', 'estressado', 'dormi mal', 'sem energia', 'desanimado', 'animado', 'motivado'];

const TRAVEL_PATTERNS = [
  /(?:vou|viajo|viajar|indo)\s+(?:pra|para|a)\s+(\w+)/i,
  /viagem\s+(?:pra|para|a)\s+(\w+)/i,
];

const ROUTINE_PATTERNS = [
  /(?:mudei|troquei|agora treino)\s+(?:de|para|pra)\s+(.+)/i,
  /(?:comecei|comecando|comecei a)\s+(.+)/i,
];

export function extractSignals(text: string): Signal[] {
  const lower = text.toLowerCase();
  const signals: Signal[] = [];

  // Health risk (critical)
  for (const term of HEALTH_RISK_TERMS) {
    if (lower.includes(term)) {
      signals.push({
        category: 'health_risk',
        key: term.replace(/\s+/g, '_'),
        value: { term, raw: text, critical: true },
        confidence: 0.95,
      });
      break;
    }
  }

  // Health normal
  if (signals.length === 0) {
    for (const term of HEALTH_TERMS) {
      if (lower.includes(term)) {
        signals.push({
          category: 'health',
          key: term.replace(/\s+/g, '_'),
          value: { term, raw: text },
          confidence: 0.7,
        });
        break;
      }
    }
  }

  // Mood
  for (const term of MOOD_TERMS) {
    if (lower.includes(term)) {
      signals.push({
        category: 'mood',
        key: term.replace(/\s+/g, '_'),
        value: { mood: term, raw: text },
        confidence: 0.6,
      });
      break;
    }
  }

  // Travel
  for (const pattern of TRAVEL_PATTERNS) {
    const match = lower.match(pattern);
    if (match?.[1]) {
      signals.push({
        category: 'travel',
        key: `trip_${match[1]}`,
        value: { destination: match[1], raw: text },
        confidence: 0.5,
      });
      break;
    }
  }

  // Routine change
  for (const pattern of ROUTINE_PATTERNS) {
    const match = lower.match(pattern);
    if (match?.[1]) {
      signals.push({
        category: 'routine',
        key: `change_${match[1].slice(0, 20).replace(/\s+/g, '_')}`,
        value: { description: match[1], raw: text },
        confidence: 0.5,
      });
      break;
    }
  }

  return signals;
}

export async function processMessage(userId: string, text: string): Promise<Signal[]> {
  const signals = extractSignals(text);

  for (const signal of signals) {
    await upsertContext({
      user_id: userId,
      category: signal.category,
      key: signal.key,
      value: signal.value,
      confidence: signal.confidence,
      source: 'radar',
    });
  }

  return signals;
}
