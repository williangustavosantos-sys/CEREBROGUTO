import { selectBestHook } from "./hook-selector";
import { markHookUsed } from "./hook-store";
import { config } from "../config";
import { recordHookFeedback } from "./user-feedback";

/**
 * Injects a DAILY_CONTEXT_BRIEF block into the GUTO brain prompt
 * if a relevant hook exists for the user.
 * Returns the prompt unchanged if no hook is available or feature is disabled.
 */
export async function injectDailyBriefIntoBrainPrompt(
  userId: string,
  prompt: string
): Promise<string> {
  if (!config.enableDailyBriefing) return prompt;

  const hook = await selectBestHook(userId);
  if (!hook) return prompt;

  const briefBlock = `
DAILY_CONTEXT_BRIEF:
Objective: ${hook.objective}
Trigger: ${hook.category}
Facts:
- ${hook.content}
Decision:
${hook.mustMention.map(m => `- ${m}`).join("\n")}
Style:
- 1 a 3 frases.
- Não mencionar sistema, hook, API, briefing ou previsão como certeza absoluta.
${hook.mustAvoid.map(a => `- EVITE: ${a}`).join("\n")}
`;

  return prompt + "\n" + briefBlock;
}

/**
 * Marks the best hook as used for the user (only if feature is enabled).
 * Safe to call even if no hook was selected – it's a no‑op.
 * 
 * Feedback evaluation is now done semantically by the LLM via memoryPatch,
 * NOT by fragile keyword lists. This prevents breaking in other languages
 * or with user slang/typos.
 */
export async function markHookUsedAfterResponse(userId: string, userMessage?: string): Promise<void> {
  if (!config.enableDailyBriefing) return;

  const hook = await selectBestHook(userId);
  if (hook) {
    await markHookUsed(userId, hook.id);
    
    // Feedback evaluation is delegated to the LLM via memoryPatch.
    // The LLM will detect if the user engaged positively, ignored, or rejected
    // the proactive message and update the feedback profile accordingly.
    // This avoids fragile keyword lists that break across languages and slang.
    
    // If user didn't respond at all, mark as ignored
    if (!userMessage || userMessage.trim().length === 0) {
      await recordHookFeedback(userId, hook.category, "ignored");
    }
  }
}

