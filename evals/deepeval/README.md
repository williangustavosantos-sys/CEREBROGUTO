# DeepEval V3.3

Run the permanent multi-turn regression suite with:

```sh
uv run pytest
```

The suite uses DeepEval's `ConversationalTestCase` and a deterministic
conversation metric for the V3.3 A-E multi-turn cases: functional limitations,
food constraints and exclusions, changing goals, preference versus limitation,
and absence of invented facts. It does not make a judge model authoritative
over clinical or operational facts.
