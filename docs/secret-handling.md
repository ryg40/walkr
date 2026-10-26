# Secret handling

`scripts/scan.sh` stops a secret or a host value before it goes to a remote. It needs a POSIX shell, Git 2.31 or later and Python 3.9 or later. It uses no network and no scanner binary. The rules live in `scripts/publish_check.py` and in the `scripts/host-values.*` lists.

The comment at the top of `scripts/scan.sh` gives the modes, the levels, the environment variables and the exit codes. Each list file gives its format in its own header.

## What the scan finds

| Class | Finds | Result |
| --- | --- | --- |
| Secret | A private key block, a cloud access key, a token of a code host or a chat service, an API key, a URL with a password, a bearer header, an assignment of a long key or password value. | Always fails. |
| Host value | A pattern of a deny list, or a private network address of `scripts/host-values.regex`. | Fails at level `fail`. Prints a warning at level `warn`. |
| Policy | A tracked ignore file of a scanner, a tracked file in `.local/`, a tracked archive, database dump or Git bundle. | Always fails. |

The default level is `fail` on the branch `portable` and on a tag `portable-v*`, and `warn` on other branches. The publisher always uses `fail`.

A finding names the class, the rule, the file and the line. It never shows the matched text.

## Modes

| Mode | Reads | Use |
| --- | --- | --- |
| `tree` | The tracked files of the working tree, their staged content and their names. | Before a review. |
| `staged` | The staged bytes of each added or changed file, and their names. It reads the index, not the working file. | The hooks `pre-commit` and `pre-merge-commit`. |
| `history [<range>]` | Each commit of the range: the commit object with its identities and message, the new content of each changed file, and the file names. | Before a merge or a push. |
| `history --stdin` | Exact commit ids, one for each line. | The hook `pre-push`. |
| `all` | `tree` and `history HEAD`. | A full check. |
| `selftest` | Synthetic tokens and the sample of each host rule must give a finding. A clean text must give none. | After a change of a rule or a list. |

## Deny lists

There are two deny lists with the same format: one literal pattern for each line, in any case.

- `scripts/host-values.deny` is tracked and published. It holds generic patterns only.
- `.local/host-values.deny` is untracked. It holds the values of one host: its host names, its domains, its account names and its paths. A linked worktree reads the list of the main checkout. `SCAN_LOCAL_DENY` names another file.

The private development copy keeps a local deny list. The published copy has none.

The scan stops with exit code 2 when the local list is absent or empty. A missing list would give a false clean result. In a public clone, give `--allow-no-local-deny`, or set `SCAN_ALLOW_NO_LOCAL_DENY=1` for the hooks.

The rule ids are `host-value-<n>` for the tracked list and `host-value-local-<n>` for the local list. The output gives the rule id only, never the pattern. To see the pattern of `host-value-local-<n>`, read line `<n>` of the local list (comments and empty lines do not count).

Warning: do not copy a line of the local list into a tracked file, a report or a commit message.

## Exceptions

- `scripts/host-values.allow` holds exact `https` URLs. A deny-list pattern that is only inside such a URL gives no finding.
- `scripts/host-values.allow-lines` holds `<path><TAB><sha256>` of one exact line. That line gives no host-value finding and no public reader finding. A changed line is a finding again.

No exception hides a secret finding or a policy finding. The `secret-assignment` rule has no word exemption: a value that holds a word such as "test" or "example" is still a finding. Build a synthetic value at run time from parts. Add an exception only after a review by the maintainer, and write the reason here.

### Accepted host values in the publish set

None.

## Hooks

```sh
sh scripts/install-hooks.sh            # install
sh scripts/install-hooks.sh --check    # exit 0 when installed and current
sh scripts/install-hooks.sh --uninstall
```

The script copies `scripts/git-hooks/dispatch` into the shared hooks directory of the repository, once for each hook. The main checkout and each worktree use these copies. Each copy runs `scripts/git-hooks/<hook>` of the current working tree. `core.hooksPath` stays unset, because the publisher refuses a set `core.hooksPath`. The script does not replace a hook that it did not install.

| Hook | Does |
| --- | --- |
| `pre-commit` | Runs `selftest` when a rule file is staged, then `staged`. |
| `pre-merge-commit` | The same as `pre-commit`, for a merge without a conflict. |
| `pre-push` | Guards the refs, then scans the pushed range. |

The `pre-push` guard: toward each remote except `origin`, only `refs/heads/portable` (to `main` or `portable`) and `refs/tags/portable-v*` (to the same name) may go. It refuses each other ref and each delete. A push to a URL counts as a push to a remote that is not `origin`. For a new portable ref, the scan covers the snapshot chain from the first snapshot. The chain holds no development history.

`git commit --no-verify` and `git push --no-verify` skip the hooks. The publisher runs its own checks and does not depend on the hooks.

## Blind spots

- The scan does not read into an archive. The policy rule refuses known archive formats.
- A secret that is split over lines, encoded or encrypted is not found.
- A host value that no deny list holds is not found. Add the values of your host to `.local/host-values.deny`.
- Tag messages and notes are not scanned by `history`. The publisher scans the message of the tag that it pushes, also of an existing tag on a resume.

## Rules for changes

1. Do not write a token or a host value into a tracked file, also not into a test. Build it at run time from parts, as `scripts/test_publish.py` does.
2. Do not add a value of a real host to `scripts/host-values.deny`. Add it to `.local/host-values.deny`.
3. `scripts/host-values.regex` must not hold an address. Its header gives the format of a rule and its sample.
4. After a change of a rule or a list, run `sh scripts/scan.sh selftest` and `python3 -I scripts/test_publish.py`.
