# DeepEval V3.1

Run the permanent multi-turn regression suite with:

```sh
uv run pytest
```

The suite uses DeepEval's `ConversationalTestCase` and a deterministic
conversation metric to assert V3 state and policy invariants for lower-back,
knee, shoulder, food restriction, equipment, and routine variants. It does not
make a judge model authoritative over clinical or operational facts.
