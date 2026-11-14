import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("check_kb", Path(__file__).with_name("check_kb.py"))
kb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kb)
HEADER = """# Test
**Status:** Implemented
**Last Updated:** 2026-11-14
**Audience:** Contributors
**Last verified:** 2026-11-14 against 98d6da6
"""


class CheckKBTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.run_git("init", "-q")
        self.run_git("config", "user.name", "KB test")
        self.run_git("config", "user.email", "kb-test@example.invalid")
        self.write("src/file.ts", "export {}\n")
        self.write("docs/README.md", HEADER + "**Code:** `src`\n[Page](page.md): What does it do?\n")
        self.write("docs/page.md", HEADER + "**Code:** `src/file.ts`\n")
        self.run_git("add", ".")
        self.run_git("commit", "-qm", "base")

    def run_git(self, *args):
        subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True)

    def write(self, path, text):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")

    def test_good_paths_and_parent_coverage(self):
        self.write("src/new.ts", "export {}\n")
        self.write("docs/page.md", HEADER + "**Code:** `src/file.ts`\n```text\n**Code:** `example.ts`\n```\n")
        self.assertEqual(kb.check(self.root, "HEAD"), ([], []))

    def test_missing_path_and_dead_link(self):
        self.write("docs/page.md", HEADER + "**Code:** `missing.ts`\n[Bad](missing.md)\n")
        errors, _ = kb.check(self.root)
        self.assertTrue(any("Code path does not exist" in item for item in errors))
        self.assertTrue(any("dead local link" in item for item in errors))

    def test_missing_page_subfolder_and_generated_skip(self):
        self.write("docs/other.md", HEADER)
        self.write("docs/sub/README.md", HEADER)
        self.write("docs/generated/ignored.md", "not a page")
        errors, _ = kb.check(self.root)
        self.assertEqual(len(errors), 2)
        self.assertTrue(any("docs/sub" in item for item in errors))
        self.assertTrue(any("docs/other.md" in item for item in errors))

    def test_rename_and_uncovered_source_warnings(self):
        self.run_git("mv", "src/file.ts", "elsewhere.ts")
        self.write("docs/page.md", HEADER + "**Code:** `elsewhere.ts`\n")
        self.write("unknown.ts", "export {}\n")
        errors, warnings = kb.check(self.root, "HEAD")
        self.assertEqual(errors, [])
        self.assertEqual(warnings, ["source has no Code coverage: unknown.ts"])

    def test_deleted_named_path_is_error_and_warning(self):
        self.run_git("rm", "src/file.ts")
        errors, warnings = kb.check(self.root, "HEAD")
        self.assertTrue(any("Code path does not exist" in item for item in errors))
        self.assertEqual(warnings, ["deleted or renamed Code path: src/file.ts"])


if __name__ == "__main__":
    unittest.main()
