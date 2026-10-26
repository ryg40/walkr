# Publishing portable snapshots

The public Walkr repository is a snapshot of a private development copy. The private copy holds notes, deployment files and host values that never leave. The publisher copies only a reviewed list of files into a separate history and pushes that history.

`python3 -I scripts/publish_portable.py --help` lists the options. The publisher needs Python 3.9 or later and Git 2.31 or later. It uses no package.

## Words

| Word | Meaning |
| --- | --- |
| Development branch | `local-dev` in the private copy. It never goes to the shared remote. |
| Snapshot branch | `portable`. Each commit holds exactly the publish set of one source commit. Its parent is the previous snapshot. |
| Shared remote | `github`. It receives `portable` as its branch `main`, and the tags `portable-vX.Y.Z`. |
| Publish set | The files that a snapshot holds. `scripts/publish_check.py` computes it. |
| Allowlist snapshot | The promotion mode: a temporary index with exactly the publish set, then `git commit-tree` onto the previous snapshot. No development commit reaches `portable`. |

## The command

```sh
python3 -I scripts/publish_portable.py                                # dry run
python3 -I scripts/publish_portable.py --version 0.9.0                # build and tag locally
python3 -I scripts/publish_portable.py --version 0.9.0 --push         # push the two refs
```

1. The dry run checks the source commit and prints the plan. It changes no ref and pushes nothing.
2. `--version X.Y.Z` builds the snapshot commit on `portable` and the annotated tag `portable-vX.Y.Z`. It pushes nothing. Inspect the snapshot before the push.
3. `--push` with the same `--version` pushes the snapshot and the tag of step 2. When step 2 did not run, it builds them first.

Run the command in a clean linked worktree, not in the main checkout. The source is `local-dev`, or a detached `HEAD` at the tip of `local-dev`: a linked worktree cannot check out `local-dev` while the main checkout has it. The snapshot comes from the committed `HEAD`, never from the working tree.

```sh
git worktree add --detach ../walkr-release local-dev
```

The push sends exactly two refs, each by an explicit refspec:

```text
refs/heads/portable:refs/heads/main
refs/tags/portable-vX.Y.Z
```

The publisher refuses `--all`, `--tags`, `--follow-tags`, `--mirror` and each force option.

The push goes to one destination: `remote.github.pushurl` when it is set, else `remote.github.url`. The publisher refuses a remote with more than one push URL. It also refuses the run when a `url.<base>.insteadOf` or `url.<base>.pushInsteadOf` setting matches the start of the push URL, and it names that setting. Git applies these rules again to a URL on the command line, so a match could send the push to a destination that the checks did not see. Without a match, the plan, `git ls-remote` before and after, `git push --dry-run` and the push all use the same literal URL.

Before the build, the publisher runs `git ls-remote` on the destination. A ref other than `main` and `portable-v*` tags is a foreign ref. A foreign ref, or the release tag on the destination, stops the run before a ref changes. Then the publisher prints the plan: the remote, the destination without user information, each ref with its old and new commit. Then it runs `git push --dry-run`, then the push, then `git ls-remote` again. A foreign ref after the push gives exit code 3. The publisher deletes nothing.

The publisher removes the user information of each URL from the Git output that it prints.

The publisher never reads or prints a credential. Git uses its own credential helper, or `gh auth` for GitHub. The publisher never creates the remote repository.

## What the publisher refuses

Each refusal stops the run before a ref changes. After the local build, a failed `git push --dry-run` or push leaves the local `portable` and tag. A rerun with the same `--version` and `--push` resumes.

- A run in the main checkout of the repository. The option `--allow-main-checkout` exists for the tests only.
- A working tree with changes or untracked files.
- `HEAD` on `portable`, or a worktree with `portable` checked out.
- A shallow repository.
- A set `core.hooksPath`. It turns off the hooks of `scripts/install-hooks.sh`.
- A build from a source other than `local-dev` or a detached `HEAD` at its tip.
- A remote named `upstream` anywhere in the configuration.
- A target remote named `origin`, a push URL `DISABLED`, a mirror remote, more than one push URL.
- An http(s) URL with user information, or any URL with a password. An SSH user name such as `git@` is no credential and passes.
- An existing `portable` chain that is not a clean snapshot chain: a merge commit, a commit that `local-dev` or the source commit also holds, another author or committer than the identity of the run, a signature, or a path that never leaves. The paths that never leave are a fixed list: `.local/`, `secrets/`, an `.env` file (an `.env.example`, `.env.sample` or `.env.template` passes) and `scripts/dev-only-files.txt`. The publish rules of today apply to the new snapshot only. A file that leaves the publish set later stays in the older snapshots, and the next snapshot does not have it. Another branch at a `portable` commit, such as a backup branch, is no refusal.
- An existing tag `portable-vX.Y.Z`, except the tag of an earlier build of the same snapshot on a run with `--push`. That tag must be annotated, point at the tip of `portable`, name the version, carry the identity of the run as tagger, and have no signature. Its message must pass the scan and the public reader rules.
- A version that is not higher than the highest local `portable-v*` tag.
- A version that is not equal to `version` in `package.json` of the source commit.
- A finding of the publish check, the scan or the public reader rules.

## Versions and tags

`--version` takes three numbers, `X.Y.Z`. The tag is `portable-vX.Y.Z`. The version must increase over the last `portable-v*` tag, and it must equal `version` in `package.json`. Change `package.json` on `local-dev` first, then build the snapshot.

Old `vX.Y.Z` tags of the upstream project are not snapshot tags. The publisher never pushes them.

## Identity

The snapshot commit and the tag carry a neutral identity and no signature:

| Field | Default | Override |
| --- | --- | --- |
| Author, committer and tagger name | `walkr portable` | `--identity-name`, or `WALKR_PUBLISH_NAME` |
| Author, committer and tagger e-mail | `portable@walkr.invalid` | `--identity-email`, or `WALKR_PUBLISH_EMAIL` |

An option wins over the variable. The publisher runs Git with `commit.gpgsign=false` and `tag.gpgsign=false`, and with the time zone UTC. It prints the three identities at the start of each run. It also prints the identities of the existing `portable` chain and the tagger of the actual tag object. Give the same identity for each release: a chain commit with another identity stops the run.

## The publish set

`scripts/publish_check.py` computes the set from the source commit:

- Exact files: `package.json`, `package-lock.json`, `README.md`, `GLOSSARY.md`, `LICENSE`, `INSTALL.md`, `install.sh`, `.gitignore`, `CHANGELOG.md`.
- Directory rules: `src/`, `test/`, `skills/`, `prompts/`, `integrations/pi/`, `docs/`, `assets/`, `.github/workflows/`.
- In `scripts/`, only the publisher files: `publish_portable.py`, `publish_check.py`, `scan.sh`, `install-hooks.sh`, `git-hooks/`, `test_publish.py` and the four `host-values.*` lists.
- Minus each path of `scripts/dev-only-files.txt`. The list excludes itself.

The check fails when:

- an exact file or a publisher file is missing;
- a tracked file is neither in the set nor in the dev-only list;
- an entry of the dev-only list names no tracked file;
- a file of the set is not a regular file.

After the build, the publisher compares the snapshot tree with the computed set. They must be equal.

To add a file outside the directory rules, add its path to `PUBLISH` in `scripts/publish_check.py` after a review. To keep a tracked file private, add it to `scripts/dev-only-files.txt`.

```sh
python3 -I scripts/publish_check.py              # the publish check of HEAD
python3 -I scripts/publish_check.py --list       # the publish set of HEAD
```

A public clone has no dev-only list and no local deny list. There, run `python3 -I scripts/publish_check.py --allow-no-local-deny`.

## Public reader rules

A snapshot is for a reader outside the private copy. The publish check fails when a file of the set holds one of these classes:

| Rule id | Finds |
| --- | --- |
| `tracker-reference` | The word for an issue or a ticket and then a number, or a decision with a letter code. |
| `machine-path` | A path of the home directory of the administrator, or of the stack directory of one host. |
| `host-record` | A record of work on one host: a record word such as "observed" or "verified" with a date in the same line, or a date with a phrase for one host. |
| `host-value-<n>`, `host-value-local-<n>`, `host-value-<name>` | A pattern of a deny list or an address rule of [the scan](secret-handling.md#deny-lists). |

A finding names the rule, the file and the line. It never shows the text. Write the lasting fact in place of such content, for example "Not verified: ...".

The accepted lines of `scripts/host-values.allow-lines` give no host-value or public reader finding. The publisher prints a warning when a file of that list changed since the last snapshot. Review the accepted lines of that file again.

## History

The public history only moves forward. Each snapshot has the previous snapshot as its parent. A reader updates with `git pull`. The publisher has no option to replace or restart the history. A value that left in an old snapshot stays in the history; removing it from a later snapshot does not remove it from the earlier one.

On a first push, the history scan covers the whole snapshot chain. Later pushes scan the snapshots that the remote does not have. The history scan uses the secret, policy and host-value rules and the public reader rules, on each commit object with its message, on the new content of each file, on the file names, and on the tag message.

`--accept-commit <sha>` takes the full 40-character id of a snapshot commit whose finding the owner accepted in writing. Its host-value and public reader findings print as `accepted` and do not stop the run. Its secret and policy findings still stop the run.

## Continuous integration

`.github/workflows/test.yml` runs on each push to `main` and on each pull request. It runs `npm ci --ignore-scripts` and `npm test` on Linux and macOS, with Node 20 and 22. It also runs `python3 -I scripts/test_publish.py`. On Linux it runs the scan of the tree without a local deny list. The actions are pinned by full commit hash, and a comment names the tag of each hash.

## Limits

- The scan finds forms, not meanings. Review each new file before you commit it.
- The publisher reads Git state only. It does not build, run a service or create a repository.
