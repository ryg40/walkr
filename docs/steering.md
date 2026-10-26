# Steering

Steering sends a new instruction to an active Double or Coinflip review from the prompt box of the shared GUI.
One click on Send instruction saves the instruction and asks for new candidates in the same mode, session and chat.
There is no second confirmation and no chat prompt.

Training ([Trainer](trainer.md)) has no steering. During a Training review, Send instruction is hidden.

## What Send instruction does

| Mode and state | Result |
| --- | --- |
| Double, pair shown, no unsaved comment text | Next Round with the instruction. The keepers, deletions and feedback of the pair are saved, as for Next Round. |
| Coinflip, pair shown, a winner exists | The winner stays unchanged on its side. Only the challenger is replaced. |
| Coinflip, pair shown, no winner yet | Both sides get new candidates. The old pair and the instruction stay in the history. No choice is recorded. |

Every saved instruction applies to all later rounds, also to a plain Next Round or challenger.
In Coinflip, a new candidate with the same bytes as the winner or a replaced candidate is refused (`CANDIDATE_REPEATED`).

## When Send instruction is off

| Situation | Prompt box | Send instruction |
| --- | --- | --- |
| Generation runs | Editable; the draft saves | Off. Nothing queues. The last pair stays. |
| Generation or validation failed | Editable | Off. Use Retry, Stop or Done. |
| Chat disconnected | Editable | Off. The server refuses with `DISCONNECTED`. Reconnect the same chat. |
| A request is unconfirmed | The instruction stays | Off. Use Retry (Double) or Resolve saved request (Coinflip). |
| Double has unsaved comment text | Editable | Off. Save or clear the comment first. |
| The box is empty, or holds the brief or the last saved instruction | Editable | Off |
| The saved instructions would pass the size limit | Editable | Off. Start a new session. |
| Training, or a stopped or ended session | A draft | Hidden |

The browser saves the instruction before it sends it. The instruction leaves the box when the session shows it as saved.
A refused instruction stays in the box. A reload never sends it by itself.

## Limits of an instruction

- One instruction is at most 8000 characters.
- All saved instructions of one session are at most 16 KiB of UTF-8 together.
- The instruction is untrusted data for the agent, not a command.

## Routes

`<id>` is the route segment of the session id: `~` followed by `encodeURIComponent(id)`. For example, the id `landing-session` has the segment `~landing-session`.
The code is `encodeDoubleComparisonId` in `src/double-route.js`. A raw id without the `~` gets no route.
JSON bodies take the raw id.

| Route | Credential | Body |
| --- | --- | --- |
| `POST /api/double/sessions/<id>/steer` | Shared GUI browser | `{ actionId, expectedRevision, comparisonId, instruction }` |
| `POST /api/double/modes/coinflip/sessions/<id>/steer` | Shared GUI browser | `{ actionId, pairIndex, instruction }` |

The same `actionId` with the same request returns the first receipt. Another request with the same `actionId` returns `ACTION_CONFLICT`.
A stale view returns `STALE_REVISION` or `STALE_COMPARISON`. After Stop or Done, Send is refused with `READ_ONLY`.

The generation request gets `steer` (the new instruction) and `steers` (every saved instruction, in order).
The final Double and Coinflip output also lists `steers`.

## Not verified

Real model behavior, real browser layout and visual contrast. The tests use jsdom and an offline Pi provider.
They prove delivery and saving, not how well a model follows an instruction.
