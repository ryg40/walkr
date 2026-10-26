#!/bin/sh
# Scan for secrets and host values before they go to a remote.
# See docs/secret-handling.md for the rules, the levels and the hooks.
#
# Usage: scripts/scan.sh [--level warn|fail] [--allow-no-local-deny] <mode> [<argument>]
#   tree               tracked files of the working tree, their staged content
#                      and their names
#   staged             the staged changes and their file names (the hooks
#                      pre-commit and pre-merge-commit use this)
#   history [<range>]  the commits in <range> (git rev-list syntax, default
#                      HEAD): the commit object (identities and message), the
#                      new content of each changed file and the file names
#   history --stdin    exact commit ids, one per line on standard input
#   all                tree and history
#   selftest           negative control: synthetic tokens and each host rule
#                      must give a finding, a clean text must give none
#
# A secret finding and a policy finding always fail. A host-value finding
# (scripts/host-values.deny, .local/host-values.deny, scripts/host-values.regex)
# fails at level "fail" and prints a warning at level "warn". The default level
# is "fail" for the branch portable and for a tag portable-v*; else "warn".
# A finding names the rule, the file and the line, never the text. A rule of
# the local deny list prints its id only.
#
# The local deny list .local/host-values.deny holds the values of one host.
# A linked worktree reads the list of the main checkout. The scan stops with
# exit 2 when the list is absent or empty, unless --allow-no-local-deny or
# SCAN_ALLOW_NO_LOCAL_DENY=1 is given (a public clone has no list).
#
# Exit: 0 clean, 1 finding, 2 usage or tool error.
# Needs: a POSIX shell, Git 2.31 or later, Python 3.9 or later. No network.
#
# Environment:
#   SCAN_LOCAL_DENY           path of the local deny list
#   SCAN_ALLOW_NO_LOCAL_DENY  1: run without a local deny list
#   SCAN_REF                  the refs that set the default level
#   PYTHON                    the Python interpreter (default python3)

set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
python=${PYTHON:-python3}
command -v "$python" >/dev/null 2>&1 || {
    echo "scan: error: no Python interpreter $python; install Python 3 or set PYTHON" >&2
    exit 2
}
exec "$python" -I "$root/scripts/publish_check.py" scan "$@"
