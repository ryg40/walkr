#!/bin/sh
# Use the hooks in scripts/git-hooks (pre-commit, pre-merge-commit, pre-push)
# in this repository.
#
# The script copies scripts/git-hooks/dispatch to <git-common-dir>/hooks/<hook>
# for each hook. The main checkout and each worktree share that directory. The
# dispatcher runs scripts/git-hooks/<hook> of the working tree where the hook
# runs. core.hooksPath stays unset: scripts/publish_portable.py refuses a set
# core.hooksPath, because it turns these hooks off. See docs/secret-handling.md.
#
# Usage: scripts/install-hooks.sh [--check|--uninstall]
#   --check      change nothing; exit 0 if the hooks are installed and current, else 1
#   --uninstall  remove the hooks that this script installed; leave other hooks

set -eu

HOOKS="pre-commit pre-merge-commit pre-push"
MARK=walkr-scan-hook-dispatch

usage() {
    echo "usage: $0 [--check|--uninstall]" >&2
    exit 2
}

mode=install
case $# in
    0) ;;
    1) case $1 in
           --check) mode=check ;;
           --uninstall) mode=uninstall ;;
           *) usage ;;
       esac ;;
    *) usage ;;
esac

git rev-parse --git-dir >/dev/null 2>&1 || {
    echo "error: not inside a Git repository" >&2
    exit 2
}

top=$(git rev-parse --show-toplevel)
common=$(cd -- "$top" && CDPATH='' cd -- "$(git rev-parse --git-common-dir)" && pwd -P)
dir=$common/hooks
source=$top/scripts/git-hooks/dispatch
current=$(git config --get core.hooksPath || true)

ours() {
    [ -f "$1" ] && grep -qx "# $MARK" "$1"
}

case $mode in
    check)
        if [ -n "$current" ]; then
            echo "not active: core.hooksPath is '$current'; Git does not run $dir" >&2
            exit 1
        fi
        for h in $HOOKS; do
            if [ ! -x "$dir/$h" ] || ! cmp -s "$source" "$dir/$h"; then
                echo "not current: $dir/$h differs from scripts/git-hooks/dispatch; run $0" >&2
                exit 1
            fi
        done
        echo "ok: hooks installed in $dir"
        ;;
    uninstall)
        for h in $HOOKS; do
            if ours "$dir/$h"; then
                rm -f "$dir/$h"
                echo "removed $dir/$h"
            fi
        done
        ;;
    install)
        if [ -n "$current" ]; then
            echo "error: core.hooksPath is '$current'; unset it first (git config --unset core.hooksPath)" >&2
            exit 1
        fi
        [ -f "$source" ] || {
            echo "error: scripts/git-hooks/dispatch is missing" >&2
            exit 1
        }
        for h in $HOOKS; do
            if [ -e "$dir/$h" ] && ! ours "$dir/$h"; then
                echo "error: $dir/$h exists and is not a hook of this script; move it first" >&2
                exit 1
            fi
        done
        mkdir -p "$dir"
        for h in $HOOKS; do
            cp "$source" "$dir/$h.tmp"
            chmod 755 "$dir/$h.tmp"
            mv -f "$dir/$h.tmp" "$dir/$h"
        done
        echo "hooks installed in $dir (main checkout and all worktrees)"
        ;;
esac
