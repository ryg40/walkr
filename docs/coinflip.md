# Coinflip

Coinflip develops one standalone UI component through repeated choices.
The agent shows two candidates. You click the better one. The agent replaces the other side with a new challenger.
You repeat this until you stop. The result is the last winner.

Coinflip runs only in the local shared GUI. It is not available in hosted mode.

## Terms

Coinflip terms are separate from Double terms.

| Coinflip term | Meaning | Not the same as |
| --- | --- | --- |
| Candidate | One complete rendered alternative for one standalone UI component | A Double page or a Double component region |
| Winner | The candidate that you clicked | A Double keeper, which is a region inside a page |
| Challenger | The one new candidate that replaces the rejected side | The Double right-hand challenger page |
| Choice | One saved click: winner, rejected candidate, optional note | A Double round |
| Result | The latest winner, frozen by Stop | A Double final page |

A winner keeps its exact bytes, assets, description, identity and side.
Coinflip has no keepers, deletions or page composition.

## Start

1. Start the shared GUI server and connect one persistent Pi chat. The steps are in [Double: Start from the shared GUI](double.md#start-from-the-shared-gui).
2. Open the private URL. Select Coinflip, type a brief and select Send to Coinflip.
   The page switches to Coinflip before the candidates exist.

## Rounds

1. The chat receives an `initial` request. It returns two candidates, one for each side, each with a description.
2. Both candidates must pass the [input rules](double-input.md) before the pair shows.
   Mark each candidate root with `data-double-id` and `data-container`. Scripts, remote assets, SVG and custom fonts are refused.
3. Type an optional note, then click a candidate. The click saves the choice and the note and asks for one challenger.
   There is no second confirmation.
4. During generation, the last pair stays visible, the winner is marked, choices are off, and Stop stays available.
5. The `challenger` request carries the brief, every saved choice and note, the winner, the rejected candidate, `replaceSide` and an instruction to try a new design direction.
6. The agent returns the unchanged winner on its side and one new candidate with `description` and `intendedDifference`.
7. The server compares the winner side with the saved winner bytes. A changed winner records a failed attempt. The last valid pair and winner stay.
   A challenger with the same bytes as the winner or the rejected candidate also fails (`CANDIDATE_REPEATED`).

The prompt box can [steer](steering.md) an active session.
After a winner, Send instruction asks for a new challenger only. Before a winner, it replaces both candidates.

The checks prove the static input rules and an unchanged winner. You judge whether a challenger is a new direction.

## Stop and Submit

- Stop ends the session. It freezes the latest winner, also while a challenger is in generation. There is no Resume.
- Stop before any winner saves the brief and the history with no result. Submit stays off.
- Submit sends the final packet. A repeated Submit returns the same event.
- The final packet holds the winner's exact bytes and assets, its description, the brief, every choice and note, and references to the other candidates.
- Submit works while Pi is disconnected. The page shows delivery as pending until the same chat reconnects and the receipt is checked.
- A packet larger than 256 KiB stays complete in the archive. The page shows `oversized_output`.

## Failure and recovery

- A failed generation keeps the last valid pair and winner. Select Retry or Stop. Nothing retries automatically.
- Retry repeats the saved request with a new attempt.
- If the winner's copy folder changed or is gone, every challenger fails. After Retry, the agent writes the saved winner to a new folder:

  ```sh
  walkr-coinflip session export-winner '<session-id>' /absolute/new-folder
  ```

  The command writes `original/` and `copy/` and prints a manifest pane for the winner side.
  It refuses a folder that is not empty and a folder inside the archive or the state directory.
- A disconnection marks a running attempt as interrupted. Select Mark interrupted attempt failed, then Retry or Stop.
- An unconfirmed browser action stays in browser storage. Select Resolve saved request to send the same action again. A reload never sends it by itself.
- To check an exact receipt again: `/shared-gui {"action":"retry-ack","sessionId":"<session-id>","eventId":"<event-id>"}`.

## Agent commands

```sh
walkr-coinflip gui view
walkr-coinflip session view '<session-id>'
walkr-coinflip session events '<session-id>'
walkr-coinflip session attach '<session-id>' /absolute/attach-request.json
walkr-coinflip session fail '<session-id>' /absolute/fail-request.json
walkr-coinflip session ack '<session-id>' /absolute/ack-request.json
walkr-coinflip session export-winner '<session-id>' /absolute/new-folder
walkr-coinflip session output '<submitted-session-id>'
```

The commands need the same `HUMAN_REVIEW_STATE_DIR` and `HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR` as the server.
Choose, Send instruction, Stop, Submit, Retry and recovery are browser actions. The CLI has no command for them, and the server refuses them for the agent credential.

## HTTP routes

`<id>` is the route segment of the session id: `~` followed by `encodeURIComponent(id)`. For example, the id `landing-session` has the segment `~landing-session`.
The code is `encodeDoubleComparisonId` in `src/double-route.js`. A raw id without the `~` gets no route.
JSON bodies and CLI arguments take the raw id. The CLI commands encode it for you.

| Route | Use |
| --- | --- |
| `POST /api/double/gui/start` | `{ actionId, mode: "coinflip", brief }` starts a session |
| `GET /api/double/modes/coinflip/sessions/<id>` | The saved view |
| `POST .../choose` | Browser: `{ actionId, pairIndex, winner, note }` |
| `POST .../steer` | Browser: `{ actionId, pairIndex, instruction }` |
| `POST .../stop`, `.../submit` | Browser: `{ actionId }` |
| `POST .../retry`, `.../recover` | Browser: `{ actionId, requestId, attemptId }` |
| `POST .../attach` | Agent: `{ actionId, requestId, attemptId, manifest, candidates }` |
| `POST .../fail`, `.../ack` | Agent: `{ actionId, requestId, attemptId, message }` or `{ actionId, eventId }` |
| `GET .../events`, `.../output`, `.../winner` | Agent |

The archive saves one `coinflip-session-<hash>.json` record for each session.
The frames read the saved bytes, so a later change to a copy folder does not change a candidate.

## Limits

- A candidate frame is 3000 CSS pixels tall. Content below 3000 pixels does not show.
- The agent relays the private URL, so it can reach the browser credential. The split of credentials protects against mistakes, not against a hostile agent.
- One writer per archive. There is no exactly-once guarantee for model work.
- Not verified: real model quality, visual contrast, real browser layout and accessibility.
