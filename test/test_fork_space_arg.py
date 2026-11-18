"""This fork's --space resolution (FORK.md; mods/tasks/bin/herdr_task/fork_spaces.py): herdr-task keeps a space's id,
never its name. herdr-app ls is faked: no window is reached."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import subprocess
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(ROOT, "mods", "tasks", "bin"))
from herdr_task import fork_spaces  # noqa: E402
from herdr_task.base import Fail  # noqa: E402

SPACES = [
    {"id": "spce1252", "name": "agent-workspace", "machine": None},
    {"id": "sp7", "name": "shop", "machine": None},
    {"id": "vm/sp3", "name": "shop", "machine": "vm"},
]


def ls(spaces, code=0):
    out = json.dumps({"spaces": spaces})
    return lambda args, **k: subprocess.CompletedProcess(args, code, stdout=out, stderr="")


class SpaceArg(unittest.TestCase):
    def test_an_id_passes_bare(self):
        self.assertEqual(fork_spaces.space_arg("spce1252", SPACES), "spce1252")
        self.assertEqual(fork_spaces.space_arg("vm/sp3", SPACES), "sp3")
        self.assertEqual(fork_spaces.space_arg("sp3", SPACES), "sp3")

    def test_a_unique_name_becomes_its_id(self):
        self.assertEqual(fork_spaces.space_arg("agent-workspace", SPACES), "spce1252")

    def test_anything_else_fails_listing_the_spaces(self):
        with self.assertRaises(Fail) as e:
            fork_spaces.space_arg("agent-worksp", SPACES)
        self.assertIn("agent-workspace (spce1252)", str(e.exception))
        self.assertIn("shop (vm/sp3)", str(e.exception))
        # an Assistant without its space labels passes the word "null"
        with self.assertRaises(Fail):
            fork_spaces.space_arg("null", SPACES)
        # a name two spaces share names neither
        with self.assertRaises(Fail) as e:
            fork_spaces.space_arg("shop", SPACES)
        self.assertIn("2 spaces are named 'shop'", str(e.exception))

    def test_a_window_with_no_spaces_takes_none(self):
        with self.assertRaises(Fail) as e:
            fork_spaces.space_arg("null", [])
        self.assertIn("no spaces", str(e.exception))
        with mock.patch.object(fork_spaces.shutil, "which", return_value="/bin/herdr-app"), \
                mock.patch.object(fork_spaces, "run", side_effect=ls([])):
            with self.assertRaises(Fail):
                fork_spaces.space_arg("sp1")

    def test_read_from_herdr_app_ls(self):
        with mock.patch.object(fork_spaces.shutil, "which", return_value="/bin/herdr-app"), \
                mock.patch.object(fork_spaces, "run", side_effect=ls(SPACES)) as run:
            self.assertEqual(fork_spaces.space_arg("agent-workspace"), "spce1252")
        self.assertEqual(run.call_args[0][0], ["herdr-app", "ls"])

    def test_no_window_list_passes_as_before(self):
        with mock.patch.object(fork_spaces.shutil, "which", return_value=None):
            self.assertEqual(fork_spaces.space_arg("vm/anything"), "anything")
        with mock.patch.object(fork_spaces.shutil, "which", return_value="/bin/herdr-app"), \
                mock.patch.object(fork_spaces, "run", side_effect=ls([], code=1)):
            self.assertEqual(fork_spaces.space_arg("agent-workspace"), "agent-workspace")
        # herdr-task refuses herdr-app outside the real environment (a test's HOME): passes too
        with mock.patch.object(fork_spaces.shutil, "which", return_value="/bin/herdr-app"), \
                mock.patch.object(fork_spaces, "run", side_effect=Fail("refusing to run herdr-app")):
            self.assertEqual(fork_spaces.space_arg("shop"), "shop")

    def test_commands_read_space_through_it(self):
        """Every --space read in commands.py and automations.py goes through space_arg, none through bare()."""
        for f in ("commands.py", "automations.py"):
            with open(os.path.join(ROOT, "mods", "tasks", "bin", "herdr_task", f), encoding="utf-8") as fh:
                src = fh.read()
            self.assertNotIn("bare(args.space)", src, f)
            self.assertIn("space_arg(args.space)", src, f)


if __name__ == "__main__":
    unittest.main()
