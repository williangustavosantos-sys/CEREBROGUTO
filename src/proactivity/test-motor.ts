import 'dotenv/config';
import { processMessage } from './radar-service';
import { evaluate } from './maestro-service';
import { processNext } from './generator-service';

async function run() {
  const userId = 'test-user-01';

  console.log('--- RADAR ---');
  const signals = await processMessage(userId, 'Cara, tô com uma dor no joelho foda, acho que machuquei ontem');
  console.log('Sinais extraídos:', signals.map(s => s.category));

  console.log('\n--- MAESTRO ---');
  const enqueued = await evaluate(userId);
  console.log('Enfileirados:', enqueued);

  console.log('\n--- GENERATOR ---');
  const result = await processNext();
  console.log('Resultado:', result);
}

run().catch(console.error);
