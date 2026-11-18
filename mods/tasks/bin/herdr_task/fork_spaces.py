"""Fork (nishitpatel92): --space resolved against the window's spaces (herdr-app ls).

A task keeps the space it was given, and the Tasks panel's This space filter, the Spaces sidebar and the labels on its
agents all compare space ids. Given a name (`--space agent-workspace`), herdr-task used to keep the name, so the task
showed under no space. Now: an id, bare or "machine/id", passes (bare, as before); a name exactly one space has becomes
that space's id; anything else fails, listing the spaces (a window with no spaces: every value fails). Where the
window's list can't be read (no herdr-app here, a machine with no window), the value passes as before: there is nothing to check it against.
"""

import json
import shutil

from .base import Fail, run
from .settings import bare


def window_spaces():
    """[{id, name, machine}] from herdr-app ls, or None when it can't be read."""
    if not shutil.which("herdr-app"):
        return None
    try:
        r = run(["herdr-app", "ls"])
        if r.returncode != 0:
            return None
        spaces = json.loads(r.stdout).get("spaces")
    except (Fail, OSError, ValueError, AttributeError):  # Fail: refused outside the real environment (base.guard)
        return None
    return [s for s in spaces if isinstance(s, dict) and s.get("id")] if isinstance(spaces, list) else None


def space_arg(value, spaces=None):
    """--space's value as the space id herdr-task keeps (bare); a Fail when it names no one space."""
    if not value:
        return value
    spaces = window_spaces() if spaces is None else spaces
    if spaces is None:
        return bare(value)
    if any(bare(s["id"]) == bare(value) for s in spaces):
        return bare(value)
    named = [s for s in spaces if (s.get("name") or "") == value]
    if len(named) == 1:
        return bare(named[0]["id"])
    listed = ", ".join(f"{s.get('name') or '(no name)'} ({s['id']})" for s in spaces) or "none (the window has no spaces)"
    if named:
        raise Fail(f"{len(named)} spaces are named {value!r}: pass the id of one. Spaces: {listed}")
    raise Fail(f"No space {value!r}. Pass a space's id or name: {listed}")
