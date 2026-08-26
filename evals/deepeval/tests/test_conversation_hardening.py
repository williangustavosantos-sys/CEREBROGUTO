"""DeepEval multi-turn contract regressions for the V3.3 Companion.

These are intentionally state-and-policy assertions rather than a medical judge:
the model may propose language, but only V3 state, policy and executors can
authorize the next operational action.
"""

from __future__ import annotations

from typing import Any

from deepeval import evaluate
from deepeval.evaluate.configs import DisplayConfig
from deepeval.metrics import BaseConversationalMetric
from deepeval.test_case import ConversationalTestCase, Turn


class ConversationHardeningMetric(BaseConversationalMetric):
    """Checks V3 decision-state invariants over an actual multi-turn transcript."""

    def __init__(self) -> None:
        self.threshold = 1.0
        self.score = None
        self.success = None
        self.reason = None
        self.error = None
        self.evaluation_model = "deterministic-v3-policy-contract"

    @property
    def __name__(self) -> str:
        return "Conversation Hardening V3.1"

    def measure(self, test_case: ConversationalTestCase, *_: Any, **__: Any) -> float:
        failures: list[str] = []
        resolved_slots: set[str] = set()
        expected_fact = test_case.metadata["expected_fact"]
        expected_action = test_case.metadata["expected_action"]

        for turn in test_case.turns:
            if turn.role != "assistant":
                continue
            metadata = turn.metadata or {}
            if metadata.get("authority") != "v3":
                failures.append("non-V3 authority observed")
            if metadata.get("relationship_memory_classes") not in (None, []):
                failures.append("official/operational data was proposed to relationship memory")
            if metadata.get("clinical_certainty") != "CLINICAL_UNKNOWN":
                failures.append("clinical certainty must remain unknown for a declared operational fact")

            clarification_slots = set(metadata.get("clarification_slots", []))
            repeated = clarification_slots & resolved_slots
            if repeated:
                failures.append(f"repeated clarification for resolved slots: {sorted(repeated)}")
            if clarification_slots and not metadata.get("clarification_material", False):
                failures.append("clarification has no material decision impact")

            resolved_slots.update(metadata.get("resolved_slots", []))
            if metadata.get("invented_fact", False):
                failures.append("invented a fact not declared by the user")
            if metadata.get("first_contact_restarted", False):
                failures.append("restarted completed First Contact")

        assistant_turns = [turn for turn in test_case.turns if turn.role == "assistant"]
        if not assistant_turns:
            failures.append("missing assistant decision")
        else:
            final = assistant_turns[-1].metadata or {}
            if expected_fact not in set(final.get("resolved_slots", [])):
                failures.append(f"expected fact was not resolved: {expected_fact}")
            if final.get("decision_sufficiency") != "ACTION_SUFFICIENT":
                failures.append("action remained insufficient after the required fact was declared")
            if final.get("action") != expected_action:
                failures.append(f"expected action {expected_action}, got {final.get('action')}")
            if final.get("conservative_catalog") is not True:
                failures.append("conservative catalog policy was not recorded")
            if final.get("fact_persisted") is not True:
                failures.append("operational fact was not persisted through V3")

        self.score = 1.0 if not failures else 0.0
        self.success = self.score >= self.threshold
        self.reason = "; ".join(failures) if failures else "V3 state, clarification, fact and policy invariants held."
        return self.score

    async def a_measure(self, test_case: ConversationalTestCase, *args: Any, **kwargs: Any) -> float:
        return self.measure(test_case, *args, **kwargs)

    def is_successful(self) -> bool:
        return bool(self.success)


def assistant(
    content: str,
    *,
    fact: str,
    action: str,
    clarification_slots: list[str] | None = None,
) -> Turn:
    return Turn(
        role="assistant",
        content=content,
        metadata={
            "authority": "v3",
            "clinical_certainty": "CLINICAL_UNKNOWN",
            "resolved_slots": [fact],
            "clarification_slots": clarification_slots or [],
            "clarification_material": False,
            "decision_sufficiency": "ACTION_SUFFICIENT",
            "action": action,
            "conservative_catalog": True,
            "relationship_memory_classes": [],
            "fact_persisted": True,
            "invented_fact": False,
            "first_contact_restarted": False,
        },
    )


def golden_cases() -> list[ConversationalTestCase]:
    # V3.3 acceptance cases A-E. These transcripts are deterministic policy
    # contracts; they complement (and do not replace) repository/engine tests.
    scenarios = [
        ("A_physical_limitation", "Tenho uma limitação lombar.", "physical_constraint", "updateFacts"),
        ("A_specific_exercise", "Esse exercício incomoda meu joelho.", "physical_constraint", "updateFacts"),
        ("B_vegetarian", "Sou vegetariano.", "food_constraint", "updateFacts"),
        ("B_egg_exclusion", "Esqueci de falar que não como ovo.", "food_exclusion", "updateFacts"),
        ("C_goal_changed", "Meu objetivo agora é perder gordura.", "goal", "updateFacts"),
        ("D_preference_not_limitation", "Não quero fazer perna porque não gosto.", "behavioral_preference", "acknowledge"),
        ("D_knee_limitation", "Não consigo fazer esse exercício porque meu joelho incomoda.", "physical_constraint", "updateFacts"),
        ("E_unknown_fact", "O que você sabe sobre mim?", "known_context_only", "acknowledge"),
    ]
    cases: list[ConversationalTestCase] = []
    for name, declaration, fact, action in scenarios:
        cases.append(
            ConversationalTestCase(
                name=f"v3_3_{name}",
                scenario=f"Founder regression: {name}",
                expected_outcome="The declared operational fact is retained and one conservative action is sufficient.",
                metadata={"expected_fact": fact, "expected_action": action},
                turns=[
                    Turn(role="user", content=declaration),
                    assistant("Entendi. Vou registrar só o que você declarou e seguir pelo catálogo conservador.", fact=fact, action=action),
                    Turn(role="user", content="Pode seguir."),
                    assistant("Segui sem repetir a pergunta e sem inventar informação.", fact=fact, action=action),
                ],
            )
        )
    return cases


def test_v3_3_multi_turn_conversation_hardening() -> None:
    result = evaluate(
        test_cases=golden_cases(),
        metrics=[ConversationHardeningMetric()],
        display_config=DisplayConfig(print_results=False, show_indicator=False),
    )
    assert all(test_result.success for test_result in result.test_results)
