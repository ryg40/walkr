# Glossary

The words that the Walkr guides use, by mode. Each entry names a word to avoid in its place.

## Core

[Core](docs/core.md) reviews one file or `localhost` page.

**Batch**:
All edits, comments and the note of one Send, saved under one `batch_id` until the agent acknowledges it.
_Avoid_: Message

**Carried batch**:
An earlier delivered batch that was not acknowledged. The next batch carries it under `earlier_batches`.
_Avoid_: Lost batch

**Wake-up binding**:
The one Pi chat that the opt-in wake-up extension wakes on Send for a review target.
_Avoid_: Subscription

## Double

[Double](docs/double.md) compares two disposable review copies. Its components are explicitly marked major regions within those copies.

**Session**:
An ordered series of rounds pursuing one design brief, ending with an explicit final page choice.
_Avoid_: Comparison

**Round**:
One comparison and its submitted outcome within a session. An open round has no submitted outcome yet.
_Avoid_: Session

**Combined page**:
The next round's left page, retaining the current round's selected keeper content and designs while filling gaps from the brief and feedback.
_Avoid_: Keeper-only page

**Challenger**:
The next round's right page, using the brief and feedback without being constrained to copy keeper designs.
_Avoid_: Combined page

**Final page**:
The whole edited page explicitly chosen from the last displayed pair when the session ends, including its current deletions.
_Avoid_: Unchanged original, keeper composition

**Comparison**:
A named pairing of two review copies with a stable identity.
_Avoid_: Session

**Pane**:
The fixed left or right side of a comparison.
_Avoid_: Slot

**Original artifact**:
The source artifact from which a review copy is prepared. It remains separate from review changes.
_Avoid_: Editable source

**Review copy**:
A disposable copy of an artifact and its required local assets, isolated from the original artifact and the opposite pane.
_Avoid_: Original, source

**Component**:
An explicitly marked major region with a stable identity within its comparison and pane.
An ordinary component contains no other component. A component with an explicit `group` or `frame` scope can contain other components; see [nested scopes](docs/double-input.md#nested-scopes).
A kept or deleted outer `group` decides for every component inside it.
_Avoid_: Automatically detected section

**Component label**:
A readable name for a component, separate from its identity.
_Avoid_: Component ID

**Keeper**:
A visible component selected for the agent to retain. It is not a vote for a winning site.
_Avoid_: Winner

**Plain deletion**:
A component removal from the review without explicit written feedback.
_Avoid_: Feedback deletion

**Feedback deletion**:
A component removal accompanied by saved written feedback and identifying evidence.
_Avoid_: Plain deletion

**Undo**:
A saved reversal of a deletion that restores the component's prior selection state without removing feedback evidence.
_Avoid_: Erasure

**Component baseline**:
The component's validated content before comparison actions. It remains the source of identifying evidence after deletion.
_Avoid_: Browser replacement

**Comparison archive**:
The durable record of a comparison's provenance, component baselines, saved actions, feedback, current state, and delivery.
_Avoid_: Temporary review cache

**Historical feedback**:
Saved feedback whose deletion has been undone. It remains evidence, not a current instruction to remove the component.
_Avoid_: Discarded feedback

**Sent comparison**:
A successfully submitted, read-only comparison result.
_Avoid_: Applied comparison

**Agent batch**:
The frozen final comparison result delivered to the agent, with current decisions and historical evidence kept distinct.
_Avoid_: Live action stream

**Acknowledgment**:
The agent's confirmation that it received a batch. It does not confirm source changes or remove the saved evidence.
_Avoid_: Completion

## Coinflip

[Coinflip](docs/coinflip.md) develops one standalone UI component through repeated choices of the user. Its terms do not reuse Double keeper or composition meanings.

**Candidate**:
One complete rendered alternative for one standalone UI component.
_Avoid_: Page, component region

**Winner**:
The candidate that the user explicitly clicked. It keeps its exact bytes, assets, description, identity, and side.
_Avoid_: Keeper

**Coinflip challenger**:
The one new candidate that replaces the rejected side and records its intended difference.
_Avoid_: Combined page

**Result**:
The latest explicit winner, frozen by Stop and returned by Submit.
_Avoid_: Final page

## Trainer

[Trainer](docs/trainer.md) builds a preference dataset from ranked groups.

**Group**:
Exactly three candidates from the dataset that the user ranks 1, 2 and 3 in one vote.
_Avoid_: Batch

**Leftover**:
An item that does not fit into a complete group of three. It is listed as `unranked` and never gets a vote.
_Avoid_: Skipped item

**Analysis**:
The agent's inferred reading of one saved vote. It never changes the vote.
_Avoid_: Label, ground truth
