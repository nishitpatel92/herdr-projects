"""This fork's proxy mode from the command line (FORK.md, docs/web-proxy.md): `shepherdr web proxy setup|status|off`
writes and removes proxy.json in the service's folder and refuses every interface; a web install ships
service/proxy-cli.ts with the rest of the service. Throwaway roots and data folders only."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHEPHERDR = os.path.join(ROOT, "bin", "shepherdr")
BUN = shutil.which("bun") or (os.path.expanduser("~/.bun/bin/bun") if os.path.isfile(os.path.expanduser("~/.bun/bin/bun")) else None)


def shep(data, *args):
    env = dict(os.environ, SHEPHERDR_DATA=data)
    if BUN:
        env["PATH"] = os.path.dirname(BUN) + os.pathsep + env.get("PATH", "")
    return subprocess.run([sys.executable, SHEPHERDR, *args], capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)


@unittest.skipUnless(BUN, "needs Bun")
class ProxyCommands(unittest.TestCase):
    def setUp(self):
        self.data = tempfile.mkdtemp(prefix="shepherdr-proxy-")
        self.conf = os.path.join(self.data, "proxy.json")

    def tearDown(self):
        shutil.rmtree(self.data, ignore_errors=True)

    def test_setup_status_off(self):
        self.assertIn("off", shep(self.data, "web", "proxy", "status").stdout)
        p = shep(self.data, "web", "proxy", "setup", "--bind", "172.30.172.1", "--origin", "https://shepherdr.blackbox")
        self.assertEqual(p.returncode, 0, p.stderr)
        with open(self.conf) as f:
            self.assertEqual(json.load(f), {"bind": "172.30.172.1", "port": 7789, "origin": "https://shepherdr.blackbox"})
        self.assertEqual(os.stat(self.conf).st_mode & 0o777, 0o600)
        self.assertIn("restart", p.stdout.lower())
        self.assertIn("https://shepherdr.blackbox/shepherdr/", shep(self.data, "web", "proxy", "status").stdout)
        self.assertEqual(shep(self.data, "web", "proxy", "off").returncode, 0)
        self.assertFalse(os.path.exists(self.conf))

    def test_every_interface_is_refused(self):
        for bind in ("0.0.0.0", "::"):
            p = shep(self.data, "web", "proxy", "setup", "--bind", bind, "--origin", "https://shepherdr.blackbox")
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("every interface", p.stderr)
        self.assertFalse(os.path.exists(self.conf))

    def test_a_name_or_http_origin_is_refused(self):
        self.assertNotEqual(shep(self.data, "web", "proxy", "setup", "--bind", "blackbox", "--origin", "https://x.blackbox").returncode, 0)
        self.assertNotEqual(shep(self.data, "web", "proxy", "setup", "--bind", "10.0.0.1", "--origin", "http://x.blackbox").returncode, 0)
        self.assertFalse(os.path.exists(self.conf))

    def test_pair_without_a_service_says_so(self):
        p = shep(self.data, "web", "pair")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("token", p.stderr)


class Shipped(unittest.TestCase):
    def test_a_web_install_ships_the_proxy_files(self):
        """The installer ships every non-test service file (bin/shepherdr service_items): ours go with no change to it."""
        with open(SHEPHERDR) as f:
            src = f.read()
        ns = {"__name__": "shepherdr_under_test", "__file__": SHEPHERDR}
        exec(compile(src, SHEPHERDR, "exec"), ns)
        dests = {d for _, d, _ in ns["service_items"](ROOT)}
        for f in ("devices.ts", "proxy.ts", "proxy-pages.ts", "proxy-cli.ts"):
            self.assertIn(f".local/share/shepherdr/service/{f}", dests)
        self.assertFalse(any(d.endswith(".test.ts") for d in dests))


if __name__ == "__main__":
    unittest.main()
