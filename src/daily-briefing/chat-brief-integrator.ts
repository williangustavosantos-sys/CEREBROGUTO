import { selectBestHook } from "./hook-selector";
import { markHookUsed } from "./hook-store";
import { config } from "../config";

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
─── DAILY_CONTEXT_BRIEF ───
${JSON.stringify({
    objective: "adapt_today_response",
    hook: {
      category: hook.category,
      content: hook.content,
      actionImpact: hook.actionImpact,
      changesAction: hook.changesAction,
    },
    rules: [
      "Use only if it changes the user's action today",
      "Do not mention system, hooks, briefing or internal context",
      "Maximum 2 sentences influenced by this hook",
      "If the hook is not relevant to the user's message, ignore it",
    ],
  })}
`;

  return prompt + "\n" + briefBlock;
}

/**
 * Marks the best hook as used for the user (only if feature is enabled).
 * Safe to call even if no hook was selected – it's a no‑op.
 */
export async function markHookUsedAfterResponse(userId: string): Promise<void> {
  if (!config.enableDailyBriefing) return;

  const hook = await selectBestHook(userId);
  if (hook) {
    await markHookUsed(userId, hook.id);
  }
}
