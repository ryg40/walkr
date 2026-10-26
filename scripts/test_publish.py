#!/usr/bin/env python3
"""Tests of the publisher, the scan and the hooks, in temporary repositories.

Run: python3 -I scripts/test_publish.py
No network. The tests never touch the repository that holds this file.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
OWN_FILES = ("publish_check.py", "publish_portable.py", "scan.sh", "install-hooks.sh", "test_publish.py",
             "host-values.deny", "host-values.regex", "host-values.allow", "host-values.allow-lines")
REAL_GIT = shutil.which("git")
# Built at run time, so that no tracked file holds the token or the host marker.
TOKEN = "gh" + "p_" + "Zx9QwEr7TyUi3OpA" + "s5DfGh1JkLz2XcVbNm4Q"
MARKER = "host" + "marker-q7z"
ZERO = "0" * 40


class Repository(unittest.TestCase):
    """A temporary repository on `local-dev` with the publisher files and a small publish set."""

    version = "1.0.0"

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="walkr-publish-test-")
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name)
        self.root = self.temp / "repo"
        config = self.temp / "gitconfig"
        config.write_text("")
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("GIT_", "SCAN_", "WALKR_PUBLISH_"))}
        self.env.update(GIT_CONFIG_GLOBAL=str(config), GIT_CONFIG_NOSYSTEM="1", PYTHONDONTWRITEBYTECODE="1")
        self.root.mkdir()
        self.git("init", "-q", "-b", "local-dev")
        self.git("config", "user.name", "test")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        (self.root / "scripts/git-hooks").mkdir(parents=True)
        for name in OWN_FILES:
            shutil.copy2(SCRIPTS / name, self.root / "scripts" / name)
        for hook in (SCRIPTS / "git-hooks").iterdir():
            shutil.copy2(hook, self.root / "scripts/git-hooks" / hook.name)
        files = {
            ".gitattributes": "* text=auto eol=lf\n", ".gitignore": ".local/\n__pycache__/\n",
            "CHANGELOG.md": "# Changes\n", "GLOSSARY.md": "# Words\n", "INSTALL.md": "# Install\n",
            "LICENSE": "MIT\n", "README.md": "# Walkr\n", "install.sh": "#!/bin/sh\n",
            "package-lock.json": "{}\n", "src/cli.js": "export {};\n", "test/cli.test.js": "// test\n",
            "docs/use.md": "# Use\n", "notes/private.md": "a private note\n",
            "scripts/dev-only-files.txt": "scripts/dev-only-files.txt\nnotes/\n",
        }
        for name, text in files.items():
            self.write(name, text)
        self.set_version(self.version)
        (self.root / ".local").mkdir()
        self.write(".local/host-values.deny", f"{MARKER}\n")
        self.commit("first")

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def set_version(self, version):
        self.write("package.json", json.dumps({"name": "walkr", "version": version}, indent=2) + "\n")

    def git(self, *args, check=True, cwd=None, input=None):
        result = subprocess.run([REAL_GIT, *args], cwd=cwd or self.root, env=self.env, text=True,
                                capture_output=True, input=input)
        if check and result.returncode:
            raise AssertionError(f"git {args}: {result.stderr}")
        return result.stdout.strip()

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "--no-verify", "-m", message)

    def run_script(self, *args, env=None, input=None):
        return subprocess.run(list(args), cwd=self.root, env=env or self.env, text=True,
                              capture_output=True, input=input)

    def publish(self, *args, env=None, main_checkout=True):
        """Run the publisher. The temporary repository is a main checkout; the option lets it run."""
        extra = ("--allow-main-checkout",) if main_checkout else ()
        return self.run_script(sys.executable, "-I", "scripts/publish_portable.py", *extra, *args, env=env)

    def scan(self, *args):
        return self.run_script("sh", "scripts/scan.sh", *args)

    def ref(self, name):
        return self.git("rev-parse", "--verify", "--quiet", name, check=False) or None

    def refs(self):
        return self.git("for-each-ref", "--format=%(refname) %(objectname)")

    def bare_remote(self, name="github"):
        bare = self.temp / f"{name}.git"
        self.git("init", "-q", "--bare", str(bare))
        self.git("remote", "add", name, str(bare))
        return bare

    def remote_refs(self, bare):
        return sorted(line.split("\t")[1] for line in self.git("ls-remote", str(bare)).splitlines())


class ScanTests(Repository):
    def test_staged_scan_reads_the_staged_bytes_and_redacts(self):
        self.write("src/config.js", f'const token = "{TOKEN}";\n')
        self.git("add", "src/config.js")
        # The working file is harmless now; only the index holds the token.
        self.write("src/config.js", "const token = process.env.TOKEN;\n")
        result = self.scan("staged")
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn("src/config.js", result.stdout)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertNotIn(TOKEN[4:20], result.stdout + result.stderr)
        # Positive control: the harmless content staged gives a clean scan.
        self.git("add", "src/config.js")
        self.assertEqual(0, self.scan("staged").returncode)

    def test_scan_stops_without_the_local_deny_list(self):
        (self.root / ".local/host-values.deny").unlink()
        self.assertEqual(2, self.scan("tree").returncode)
        self.write(".local/host-values.deny", "# only a comment\n\n")
        self.assertEqual(2, self.scan("tree").returncode)
        self.assertEqual(0, self.scan("--allow-no-local-deny", "tree").returncode)

    def test_a_local_hit_prints_the_rule_id_and_never_the_pattern(self):
        self.write("docs/use.md", f"see {MARKER} for details\n")
        self.commit("marker")
        result = self.scan("--level", "fail", "tree")
        self.assertEqual(1, result.returncode)
        self.assertIn("host-value-local-1", result.stdout)
        self.assertNotIn(MARKER, (result.stdout + result.stderr).lower())

    def test_selftest_passes(self):
        self.assertEqual(0, self.scan("selftest").returncode)


class PublisherRefusals(Repository):
    def test_dirty_tree_is_refused_and_no_ref_moves(self):
        before = self.refs()
        self.write("untracked.txt", "new\n")
        self.assertEqual(1, self.publish("--version", "1.0.0").returncode)
        self.assertEqual(1, self.publish().returncode)
        self.assertEqual(before, self.refs())

    def test_version_must_match_package_json(self):
        before = self.refs()
        self.assertEqual(1, self.publish("--version", "1.1.0").returncode)
        self.assertEqual(before, self.refs())

    def test_version_must_increase_and_a_tag_must_be_new(self):
        self.assertEqual(0, self.publish("--version", "1.0.0").returncode)
        built = self.refs()
        # The same version again: the tag exists.
        self.write("docs/use.md", "# Use, changed\n")
        self.commit("change")
        self.assertEqual(1, self.publish("--version", "1.0.0").returncode)
        # A lower version that matches package.json.
        self.set_version("0.9.0")
        self.commit("lower")
        self.assertEqual(1, self.publish("--version", "0.9.0").returncode)
        self.assertEqual(self.ref("refs/heads/portable"), dict(
            line.split() for line in built.splitlines())["refs/heads/portable"])
        self.assertIsNone(self.ref("refs/tags/portable-v0.9.0"))
        self.assertEqual(1, self.publish("--version", "1.0").returncode)

    def test_a_missing_exact_file_fails_the_check(self):
        (self.root / "CHANGELOG.md").unlink()
        self.commit("drop the changelog")
        result = self.publish()
        self.assertEqual(1, result.returncode)
        self.assertIn("CHANGELOG.md", result.stdout)

    def test_an_unreviewed_file_fails_the_check(self):
        self.write("extra.txt", "neither published nor excluded\n")
        self.commit("extra")
        self.assertEqual(1, self.publish().returncode)

    def test_a_secret_in_the_publish_set_stops_the_build(self):
        self.write("src/config.js", f'const token = "{TOKEN}";\n')
        self.commit("token")
        result = self.publish("--version", "1.0.0")
        self.assertEqual(1, result.returncode)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertIsNone(self.ref("refs/heads/portable"))

    def test_other_branch_shallow_hooks_path_and_portable_checkout_are_refused(self):
        self.git("switch", "-q", "-c", "topic/x")
        self.assertEqual(1, self.publish("--version", "1.0.0").returncode)
        self.git("switch", "-q", "local-dev")
        self.git("config", "core.hooksPath", "/nonexistent")
        self.assertEqual(1, self.publish("--version", "1.0.0").returncode)
        self.git("config", "--unset", "core.hooksPath")
        self.assertEqual(0, self.publish("--version", "1.0.0").returncode)
        self.git("switch", "-q", "portable")
        self.assertEqual(1, self.publish().returncode)
        self.git("switch", "-q", "local-dev")
        clone = self.temp / "shallow"
        self.git("clone", "-q", "--depth", "1", "--branch", "local-dev", f"file://{self.root}", str(clone))
        result = subprocess.run([sys.executable, "-I", "scripts/publish_portable.py", "--allow-no-local-deny",
                                 "--allow-main-checkout"],
                                cwd=clone, env=self.env, text=True, capture_output=True)
        self.assertEqual(1, result.returncode)

    def test_refused_push_options_and_remotes(self):
        before = self.refs()
        for option in ("--tags", "--all", "--follow-tags", "--mirror", "--force", "--force-with-lease=x"):
            self.assertEqual(1, self.publish("--version", "1.0.0", "--push", option).returncode, option)
        self.assertEqual(1, self.publish("--push").returncode)
        self.assertEqual(before, self.refs())
        self.git("remote", "add", "github", "https://user:" + "secret@example.invalid/walkr.git")
        self.assertEqual(1, self.publish("--version", "1.0.0", "--push").returncode)
        self.git("remote", "set-url", "github", "https://example.invalid/walkr.git")
        self.git("remote", "set-url", "--push", "github", "DISABLED")
        self.assertEqual(1, self.publish("--version", "1.0.0", "--push").returncode)
        self.git("remote", "add", "upstream", "https://example.invalid/upstream.git")
        self.assertEqual(1, self.publish("--version", "1.0.0", "--push", "--remote", "upstream").returncode)
        self.assertIsNone(self.ref("refs/heads/portable"))


class Snapshot(Repository):
    def publish_list(self, ref):
        result = self.run_script(sys.executable, "-I", "scripts/publish_check.py", "--list", "--ref", ref)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        return result.stdout.split()

    def test_the_snapshot_tree_is_exactly_the_publish_set(self):
        result = self.publish("--version", "1.0.0")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        tree = sorted(self.git("ls-tree", "-r", "--name-only", "portable").split())
        self.assertEqual(sorted(self.publish_list("local-dev")), tree)
        self.assertNotIn("notes/private.md", tree)
        self.assertNotIn("scripts/dev-only-files.txt", tree)
        self.assertIn("scripts/scan.sh", tree)
        self.assertIn("scripts/git-hooks/pre-push", tree)
        self.assertEqual("100755", self.git("ls-tree", "portable", "scripts/scan.sh").split()[0])
        # No development commit reaches the snapshot chain.
        self.assertEqual("1", self.git("rev-list", "--count", "portable"))
        self.assertEqual(self.ref("portable"), self.ref("refs/tags/portable-v1.0.0^{commit}"))

    def test_snapshots_chain_and_carry_the_neutral_identity(self):
        self.assertEqual(0, self.publish("--version", "1.0.0").returncode)
        first = self.ref("portable")
        self.write("docs/use.md", "# Use, changed\n")
        self.set_version("1.0.1")
        self.commit("second")
        result = self.publish("--version", "1.0.1")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(first, self.ref("portable^"))
        self.assertEqual("2", self.git("rev-list", "--count", "portable"))
        line = self.git("log", "-1", "--format=%an <%ae>|%cn <%ce>", "portable")
        self.assertEqual("walkr portable <portable@walkr.invalid>|walkr portable <portable@walkr.invalid>", line)
        self.assertNotIn("gpgsig", self.git("cat-file", "commit", "portable"))
        self.assertIn("tagger walkr portable <portable@walkr.invalid>", self.git("cat-file", "tag", "portable-v1.0.1"))
        self.assertIn("portable@walkr.invalid", result.stdout)

    def test_identity_overrides(self):
        env = dict(self.env, WALKR_PUBLISH_NAME="env name", WALKR_PUBLISH_EMAIL="env@example.invalid")
        self.assertEqual(0, self.publish("--version", "1.0.0", "--identity-email", "opt@example.invalid",
                                         env=env).returncode)
        self.assertEqual("env name <opt@example.invalid>", self.git("log", "-1", "--format=%an <%ae>", "portable"))


class FakeGit(Repository):
    """A `git` on PATH that records each call and then runs the real Git."""

    def setUp(self):
        super().setUp()
        self.log = self.temp / "git.log"
        bin_dir = self.temp / "bin"
        bin_dir.mkdir()
        fake = bin_dir / "git"
        fake.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >>"{self.log}"\nexec "{REAL_GIT}" "$@"\n')
        fake.chmod(0o755)
        self.fake_env = dict(self.env, PATH=f"{bin_dir}{os.pathsep}{self.env.get('PATH', '')}")
        self.bare = self.bare_remote()

    def calls(self, command):
        found = []
        for line in self.log.read_text().splitlines() if self.log.exists() else []:
            words = line.split()
            while words[:1] == ["-c"]:
                words = words[2:]
            if words[:1] == [command]:
                found.append(words)
        return found

    def test_no_push_without_the_push_option(self):
        self.assertEqual(0, self.publish(env=self.fake_env).returncode)
        self.assertEqual(0, self.publish("--version", "1.0.0", env=self.fake_env).returncode)
        self.assertEqual([], self.calls("push"))
        self.assertEqual([], self.remote_refs(self.bare))
        self.assertIsNotNone(self.ref("refs/tags/portable-v1.0.0"))

    def test_push_sends_exactly_the_two_refs(self):
        self.assertEqual(0, self.publish("--version", "1.0.0", env=self.fake_env).returncode)
        result = self.publish("--version", "1.0.0", "--push", env=self.fake_env)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(["refs/heads/main", "refs/tags/portable-v1.0.0", "refs/tags/portable-v1.0.0^{}"],
                         self.remote_refs(self.bare))
        pushes = self.calls("push")
        self.assertEqual(2, len(pushes))
        self.assertIn("--dry-run", pushes[0])
        for words in pushes:
            self.assertEqual(["refs/heads/portable:refs/heads/main", "refs/tags/portable-v1.0.0"], words[-2:])
            for option in ("--tags", "--all", "--follow-tags", "--mirror", "--force", "-f"):
                self.assertNotIn(option, words)
        self.assertEqual(self.ref("portable"), self.git("rev-parse", "main", cwd=self.bare))

    def test_a_foreign_ref_on_the_remote_stops_the_push(self):
        self.git("push", "-q", "--no-verify", str(self.bare), "local-dev:refs/heads/stray")
        self.assertEqual(0, self.publish("--version", "1.0.0", env=self.fake_env).returncode)
        self.assertNotEqual(0, self.publish("--version", "1.0.0", "--push", env=self.fake_env).returncode)
        self.assertEqual(["refs/heads/stray"], self.remote_refs(self.bare))


class ReviewRegressions(Repository):
    """One regression test for each finding of the publisher review."""

    neutral = {"GIT_AUTHOR_NAME": "walkr portable", "GIT_AUTHOR_EMAIL": "portable@walkr.invalid",
               "GIT_COMMITTER_NAME": "walkr portable", "GIT_COMMITTER_EMAIL": "portable@walkr.invalid"}

    def git_as(self, identity, *args, input=None):
        result = subprocess.run([REAL_GIT, *args], cwd=self.root, env=dict(self.env, **identity), text=True,
                                capture_output=True, input=input)
        if result.returncode:
            raise AssertionError(f"git {args}: {result.stderr}")
        return result.stdout.strip()

    def snapshot_on_portable(self, name, text):
        """A neutral snapshot commit on top of `portable` that changes one file; returns its id."""
        blob = self.git("hash-object", "-w", "--stdin", input=text)
        index = self.temp / "craft-index"
        env = dict(self.env, GIT_INDEX_FILE=str(index))
        for args in (("read-tree", "portable"), ("update-index", "--add", "--cacheinfo", f"100644,{blob},{name}")):
            subprocess.run([REAL_GIT, *args], cwd=self.root, env=env, check=True)
        tree = subprocess.run([REAL_GIT, "write-tree"], cwd=self.root, env=env, check=True, text=True,
                              capture_output=True).stdout.strip()
        commit = self.git_as(self.neutral, "commit-tree", tree, "-p", "portable", "-m", "Walkr portable crafted")
        self.git("update-ref", "refs/heads/portable", commit)
        return commit

    def next_release(self, version):
        self.write("docs/use.md", f"# Use {version}\n")
        self.set_version(version)
        self.commit(version)

    def test_1_development_ancestry_on_portable_is_refused(self):
        bare = self.bare_remote()
        self.git("branch", "portable", "local-dev")
        result = self.publish("--version", "1.0.0", "--push")
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertEqual([], self.remote_refs(bare))
        # An orphan chain that is not reachable from local-dev but holds a dev-only path.
        tree = self.git("rev-parse", "local-dev^{tree}")
        orphan = self.git_as(self.neutral, "commit-tree", tree, "-m", "Walkr portable crafted")
        self.git("update-ref", "refs/heads/portable", orphan)
        self.assertEqual(1, self.publish("--version", "1.0.0", "--push").returncode)
        self.assertEqual([], self.remote_refs(bare))
        self.assertIsNone(self.ref("refs/tags/portable-v1.0.0"))

    def test_2_push_destination_is_the_one_push_url(self):
        fetch = self.bare_remote()
        target = self.temp / "push.git"
        self.git("init", "-q", "--bare", str(target))
        self.git("push", "-q", "--no-verify", str(target), "local-dev:refs/heads/stray")
        self.git("remote", "set-url", "--push", "github", str(target))
        result = self.publish("--version", "1.0.0", "--push")
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertEqual(["refs/heads/stray"], self.remote_refs(target))
        self.assertIsNone(self.ref("refs/heads/portable"))
        # A clean push URL receives the release; the fetch URL stays untouched.
        clean = self.temp / "clean.git"
        self.git("init", "-q", "--bare", str(clean))
        self.git("remote", "set-url", "--push", "github", str(clean))
        result = self.publish("--version", "1.0.0", "--push")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("refs/heads/main", self.remote_refs(clean))
        self.assertEqual([], self.remote_refs(fetch))
        # Two push URLs: refused.
        self.next_release("1.0.1")
        self.git("remote", "set-url", "--add", "--push", "github", str(target))
        self.assertEqual(1, self.publish("--version", "1.0.1", "--push").returncode)
        self.assertNotIn("refs/tags/portable-v1.0.1", self.remote_refs(clean))

    def test_3_resume_verifies_the_actual_tag(self):
        bare = self.bare_remote()
        self.assertEqual(0, self.publish("--version", "1.0.0").returncode)
        tag = "portable-v1.0.0"
        message = f"Walkr portable 1.0.0\n\ntoken = {TOKEN}\n"
        cases = ((self.neutral, ("-a", "-m", message)),
                 ({}, ("-a", "-m", "Walkr portable 1.0.0\n")),
                 ({}, ()))
        for identity, kind in cases:
            self.git_as(identity, "-c", "tag.gpgsign=false", "tag", "-f", *kind, tag, "portable")
            result = self.publish("--version", "1.0.0", "--push")
            self.assertEqual(1, result.returncode, kind)
            self.assertNotIn(TOKEN, result.stdout + result.stderr)
            self.assertEqual([], self.remote_refs(bare))
        # The output names the tagger of the tag object, not the configured identity.
        self.git_as({}, "-c", "tag.gpgsign=false", "tag", "-f", "-a", "-m", "Walkr portable 1.0.0\n", tag, "portable")
        self.assertIn("tagger test <test@example.invalid>", self.publish("--version", "1.0.0", "--push").stdout)

    def test_4_a_secret_with_an_incidental_word_is_found(self):
        value = "J7q2pM8" + "test" + "N4v6xR9cK3zT5aB"
        self.write("test/config.test.js", f'const client_secret = "{value}";\n')
        self.git("add", "test/config.test.js")
        result = self.scan("staged")
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertNotIn(value, result.stdout + result.stderr)

    def test_5_main_checkout_and_any_upstream_are_refused(self):
        before = self.refs()
        self.assertEqual(1, self.publish("--version", "1.0.0", main_checkout=False).returncode)
        self.assertEqual(before, self.refs())
        # A linked worktree with a detached HEAD at the tip of local-dev may build.
        worktree = self.temp / "release"
        self.git("worktree", "add", "-q", "--detach", str(worktree), "local-dev")
        result = subprocess.run([sys.executable, "-I", "scripts/publish_portable.py", "--version", "1.0.0"],
                                cwd=worktree, env=self.env, text=True, capture_output=True)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.next_release("1.0.1")
        self.bare_remote()
        self.git("remote", "add", "upstream", "https://example.invalid/upstream.git")
        self.assertEqual(1, self.publish("--version", "1.0.1").returncode)
        self.assertIsNone(self.ref("refs/tags/portable-v1.0.1"))

    def test_6_history_applies_the_public_reader_rules(self):
        bare = self.bare_remote()
        self.assertEqual(0, self.publish("--version", "1.0.0").returncode)
        crafted = self.snapshot_on_portable("docs/use.md", "see " + "iss" + "ue 12 for the reason\n")
        self.next_release("1.0.1")
        result = self.publish("--version", "1.0.1", "--push")
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn("tracker-reference", result.stdout)
        self.assertEqual([], self.remote_refs(bare))
        self.assertEqual(crafted, self.ref("portable"))

    def test_8_forwarded_git_output_has_no_userinfo(self):
        sys.path.insert(0, str(SCRIPTS))
        self.addCleanup(sys.path.remove, str(SCRIPTS))
        import publish_portable
        secret = "s3cr" + "etvalue"
        at = "@"
        text = (f"fatal: unable to access 'https://user:{secret}{at}example.invalid/w.git/'\n"
                f"To ssh://git{at}example.invalid/w.git\nhttp://{secret}{at}example.invalid/x")
        redacted = publish_portable.redact(text)
        self.assertNotIn(secret, redacted)
        self.assertNotIn("git@", redacted)
        self.assertIn("https://example.invalid/w.git/", redacted)

    def test_9_accept_commit_needs_a_full_id_and_never_accepts_a_secret(self):
        bare = self.bare_remote()
        self.assertEqual(0, self.publish("--version", "1.0.0").returncode)
        crafted = self.snapshot_on_portable("docs/use.md", "see " + "iss" + "ue 12 for the reason\n")
        self.next_release("1.0.1")
        self.assertEqual(1, self.publish("--version", "1.0.1", "--push", "--accept-commit", crafted[:12]).returncode)
        result = self.publish("--version", "1.0.1", "--push", "--accept-commit", crafted)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("accepted tracker-reference", result.stdout)
        # A secret in an accepted snapshot still stops the push.
        secret = self.snapshot_on_portable("docs/key.md", f"token = {TOKEN}\n")
        self.next_release("1.0.2")
        result = self.publish("--version", "1.0.2", "--push", "--accept-commit", secret)
        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertNotIn("refs/tags/portable-v1.0.2", self.remote_refs(bare))

    def test_n1_a_chained_push_rewrite_never_hides_the_destination(self):
        first = self.bare_remote()
        second, third = self.temp / "second.git", self.temp / "third.git"
        for bare in (second, third):
            self.git("init", "-q", "--bare", str(bare))
        self.git("push", "-q", "--no-verify", str(third), "local-dev:refs/heads/stray")
        self.git("config", f"url.{second}.pushInsteadOf", str(first))
        self.git("config", f"url.{third}.pushInsteadOf", str(second))
        result = self.publish("--version", "1.0.0", "--push")
        self.assertNotEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(["refs/heads/stray"], self.remote_refs(third))
        self.assertEqual([], self.remote_refs(second))
        self.assertEqual([], self.remote_refs(first))

    def test_n2_a_file_that_leaves_the_publish_set_keeps_the_old_snapshot_valid(self):
        bare = self.bare_remote()
        self.assertEqual(0, self.publish("--version", "1.0.0", "--push").returncode)
        self.write("scripts/dev-only-files.txt", "scripts/dev-only-files.txt\nnotes/\ndocs/use.md\n")
        self.set_version("1.0.1")
        self.commit("1.0.1")
        result = self.publish("--version", "1.0.1", "--push")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertNotIn("docs/use.md", self.git("ls-tree", "-r", "--name-only", "portable").split())
        self.assertIn("refs/tags/portable-v1.0.1", self.remote_refs(bare))

    def test_n3_a_backup_branch_of_portable_does_not_block_a_resume(self):
        bare = self.bare_remote()
        self.assertEqual(0, self.publish("--version", "1.0.0").returncode)
        self.git("branch", "release-backup", "portable")
        result = self.publish("--version", "1.0.0", "--push")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("refs/heads/main", self.remote_refs(bare))


class PrePushHook(Repository):
    def setUp(self):
        super().setUp()
        result = self.run_script("sh", "scripts/install-hooks.sh")
        self.assertEqual(0, result.returncode, result.stderr)
        self.bare = self.bare_remote()

    def test_the_hook_refuses_local_dev_toward_github(self):
        result = self.run_script(REAL_GIT, "push", "github", "refs/heads/local-dev:refs/heads/local-dev")
        self.assertNotEqual(0, result.returncode)
        result = self.run_script(REAL_GIT, "push", "github", "local-dev:refs/heads/main")
        self.assertNotEqual(0, result.returncode)
        self.assertEqual([], self.remote_refs(self.bare))

    def test_the_hook_input_contract(self):
        head = self.ref("local-dev")
        line = f"refs/heads/local-dev {head} refs/heads/local-dev {ZERO}\n"
        refused = self.run_script("sh", "scripts/git-hooks/pre-push", "github", "url", input=line)
        self.assertEqual(1, refused.returncode)
        delete = f"(delete) {ZERO} refs/heads/main {head}\n"
        self.assertEqual(1, self.run_script("sh", "scripts/git-hooks/pre-push", "github", "url",
                                            input=delete).returncode)
        allowed = self.run_script("sh", "scripts/git-hooks/pre-push", "origin", "url", input=line)
        self.assertEqual(0, allowed.returncode, allowed.stderr)

    def test_the_hook_lets_the_snapshot_through(self):
        self.assertEqual(0, self.publish("--version", "1.0.0").returncode)
        result = self.publish("--version", "1.0.0", "--push")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("refs/heads/main", self.remote_refs(self.bare))

    def test_check_reports_installed_hooks(self):
        self.assertEqual(0, self.run_script("sh", "scripts/install-hooks.sh", "--check").returncode)
        self.assertEqual(0, self.run_script("sh", "scripts/install-hooks.sh", "--uninstall").returncode)
        self.assertEqual(1, self.run_script("sh", "scripts/install-hooks.sh", "--check").returncode)


if __name__ == "__main__":
    unittest.main(verbosity=1)
