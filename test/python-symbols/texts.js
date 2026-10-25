'use strict';
// Python texts whose document symbols Pyright gave are recorded in ./recorded.json by
// test/lsp-harness/record-python-symbols.js; test/python-symbols.test.js replays them, so it
// needs no editor and no Pyright. Two are encode/httpx files at b5addb6 (BSD-3-Clause,
// © Encode OSS Ltd), kept as `.py.txt` so nothing treats them as this repository's Python:
// `_exceptions.py` (a `@property` getter with a setter) and `_auth.py` (a nested def). The
// others are written for the cases httpx does not have (`@overload`, nested classes,
// repeated names). Change a text only together with a new recording: the test checks each
// text's hash against the one recorded.

const fs = require('fs');
const path = require('path');

const httpxFile = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');

const toolBase = `import typing
from typing import overload


@overload
def fetch(key: int) -> int: ...
@overload
def fetch(key: str) -> str: ...
def fetch(key):
    return key


def helper(a, b):
    def inner(x):
        return x * 2
    return inner(a) + b


def removed():
    pass


class Tool:
    """A tool.

def not_a_method_in_the_docstring():
    """

    limit = 3

    def __init__(self, size: int) -> None:
        self._size = size

    @property
    def size(self) -> int:
        # the getter
        return self._size

    @size.setter
    def size(
        self,
        value: int,
    ) -> None:
        self._size = value

    @typing.overload
    def get(self, i: int) -> int: ...

    @typing.overload
    def get(self, i: str) -> str: ...

    def get(self, i):
        return i

    async def run(self) -> None:
        text = """
not code
"""
        return None

    class Inner:
        def method(self):
            return 1

        class Deeper:
            def deepest(self):
                return 2

    def _private(self):
        return 0


def helper(a, b):
    return a


def _hidden():
    return 1
`;

const toolHead = toolBase
  .replace('def fetch(key: str) -> str: ...', 'def fetch(key: str, strict: bool = False) -> str: ...')
  .replace('        return x * 2', '        return x * 3')
  .replace('def removed():\n    pass\n\n\n', '')
  .replace('        # the getter\n        return self._size', '        # the getter\n        return int(self._size)')
  .replace('        class Deeper:\n            def deepest(self):\n                return 2', '        class Deeper:\n            def deepest(self):\n                return 3')
  .replace('def _hidden():\n    return 1\n', 'def _hidden():\n    return 1\n\n\ndef added(z):\n    return z\n');

// P7 (httpx #3319, `_compat.py`): one name defined in both branches of an `if` and of a
// `try`, at module level and in a class; Pyright lists one definition of each name.
const branches = `import ssl
import sys

if sys.version_info >= (3, 10):

    def set_minimum(context):
        context.minimum = 2

else:

    def set_minimum(context):
        context.options |= 1

try:
    import brotli

    def decode(data):
        return brotli.decompress(data)
except ImportError:  # pragma: no cover
    def decode(data):
        raise RuntimeError("no brotli")


class Box:
    if sys.platform == "win32":
        def path(self):
            return "C:"
    else:
        def path(self):
            return "/"

    def size(self):
        def inner():
            return 1
        return inner()


def example():
    """Example:

        def not_a_function():
            pass
    """
    return 1
`;

module.exports = {
  'branches.py': branches,
  'httpx_exceptions.py': httpxFile('httpx_exceptions.py.txt'),
  'httpx_auth.py': httpxFile('httpx_auth.py.txt'),
  'tool.py@base': toolBase,
  'tool.py@head': toolHead,
};
