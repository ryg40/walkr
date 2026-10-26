# Changelog

## 0.9.0 (2026-10-26)

This is the first public release of Walkr.
Walkr is a fork of [Human Review](https://github.com/petergyang/human-review) 0.8.2 by Peter Yang, from upstream commit `f9a5581`.

### Added over Human Review 0.8.2

- Four modes, each with its own command and agent skill:
  - Core (`walkr-core`, also `walkr`): the review of one HTML or Markdown file or one `localhost` page.
  - Double (`walkr-double`): two candidates of one page side by side. Keep or delete regions over rounds, then choose a final page.
  - Coinflip (`walkr-coinflip`): two candidates of one component. Pick a winner round by round.
  - Trainer (`walkr-trainer`): rank prepared items in groups of three to build a preference dataset.
- The shared GUI: one browser view that starts Double, Coinflip and Training from a brief and connects one Pi chat.
- Steering: the prompt box sends a new instruction to an active Double or Coinflip review.
- A mode bar on the review pages, and a theme picker with five new themes beside the original light and dark.
- Batch ids for Core: each Send has a stable `batch_id`. `walkr-core poll --ack <batch_id>` acknowledges one exact batch.
- An opt-in Pi wake-up for Core (`integrations/pi/core-wake.ts`): it wakes the chat that started a review when a Send waits.
- The selection reticle in Core: a green glowing mark on the selected block, separate from the gray hover line.
- Five agent skills, installed with `walkr-core setup`: `walkr`, `walkr-core`, `walkr-double`, `walkr-coinflip`, `walkr-trainer`.
- An installer, `install.sh`, with `--dry-run` and `--uninstall`. See [INSTALL.md](INSTALL.md).

### Changed

- The command is `walkr`. The `human-review` command is not installed.
- The `/human-review` skill is replaced by the five Walkr skills. Setup moves a known old copy to a backup.
- The `HUMAN_REVIEW_*` environment variables, the `x-human-review-token` header and the `~/.human-review` state directory stay for compatibility.

### Not in this release

- Hosted mode. The code has a dormant hosted mode (`HUMAN_REVIEW_HOSTED`). This release does not support it.
- Hosted Double, Coinflip and Trainer.

### Known limits

- The browser tests use jsdom, not a real browser. Real browser layout, accessibility and visual contrast are not verified by the tests.
- The Pi tests use an offline model provider. They prove delivery and saving, not the quality of real model output.
- One server writes to one archive or one Trainer root at a time.
