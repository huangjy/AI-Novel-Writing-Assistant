import argparse
import base64
import hashlib
from html.parser import HTMLParser
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock
import zlib

import render_diagrams as renderer


SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">'
    '<rect width="320" height="180" fill="white"/>'
    '<text x="10" y="30">Diagram</text></svg>'
)
def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


PNG = (
    b"\x89PNG\r\n\x1a\n"
    + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
    + png_chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff\xff"))
    + png_chunk(b"IEND", b"")
)


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.images = []
        self.scripts = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "img":
            self.images.append(attributes)
        if tag == "script":
            self.scripts.append(attributes)


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "architecture.mmd"
        self.source.write_bytes(b"flowchart TD\r\n  A-->B\r\n")
        self.args = argparse.Namespace(
            feature="file-import", kind="dev-design", source=[str(self.source)],
            output_dir=str(self.root / "review"), title="Import <Review>",
            png=False, mmdc=sys.executable, puppeteer_config=None, timeout=30,
        )

    def fake_cli(self, command, timeout):
        if command[-1] == "--version":
            return "11.16.0"
        output = Path(command[command.index("-o") + 1])
        config = json.loads(Path(command[command.index("-c") + 1]).read_text())
        self.assertEqual(config["securityLevel"], "strict")
        self.assertFalse(config["htmlLabels"])
        self.assertFalse(config["flowchart"]["htmlLabels"])
        self.assertEqual(
            Path(command[command.index("-i") + 1]).read_bytes(),
            self.source.read_bytes(),
        )
        output.write_bytes(PNG if output.suffix == ".png" else SVG.encode())
        return ""

    def render(self):
        with mock.patch.object(renderer, "run_cli", side_effect=self.fake_cli):
            return renderer.render(self.args)

    def test_html_embeds_image_and_preserves_exact_source_hash(self):
        result = self.render()
        page = Path(result["html"]).read_text()
        parsed = PageParser()
        parsed.feed(page)
        self.assertEqual(len(parsed.images), 1)
        self.assertFalse(parsed.scripts)
        self.assertTrue(parsed.images[0]["src"].startswith("data:image/svg+xml;base64,"))
        self.assertEqual(
            base64.b64decode(parsed.images[0]["src"].split(",", 1)[1]).decode(), SVG
        )
        self.assertIn("Import &lt;Review&gt;", page)
        self.assertEqual(
            result["diagrams"][0]["sha256"],
            hashlib.sha256(self.source.read_bytes()).hexdigest(),
        )
        self.assertEqual(Path(result["html"]).name, "file-import-dev-design.html")
        self.assertNotIn("png", result["diagrams"][0])

    def test_multiple_workflow_diagrams_and_png(self):
        self.args.kind = "test-workflow"
        self.args.png = True
        self.args.source.append(str(self.source))
        result = self.render()
        self.assertEqual(Path(result["html"]).name, "file-import-test-workflow.html")
        self.assertEqual(len(result["diagrams"]), 2)
        for number, item in enumerate(result["diagrams"], start=1):
            self.assertTrue(item["svg"].endswith(f"-{number:02d}.svg"))
            self.assertEqual(Path(item["png"]).read_bytes(), PNG)

    def test_source_and_title_cannot_inject_html(self):
        self.source.write_text('</code><script>alert("x")</script>', encoding="utf-8")
        page = Path(self.render()["html"]).read_text()
        parsed = PageParser()
        parsed.feed(page)
        self.assertFalse(parsed.scripts)
        self.assertIn("&lt;script&gt;", page)

    def test_failed_rerender_preserves_prior_artifacts(self):
        result = self.render()
        files = [Path(result["html"]), Path(result["diagrams"][0]["svg"])]
        previous = [path.read_bytes() for path in files]
        with mock.patch.object(
            renderer, "run_cli", side_effect=["11.16.0", ValueError("syntax error")]
        ):
            with self.assertRaisesRegex(ValueError, "syntax error"):
                renderer.render(self.args)
        self.assertEqual([path.read_bytes() for path in files], previous)
        self.assertFalse(list(Path(self.args.output_dir).glob(".mermaid-*")))

    def test_unrelated_artifact_is_not_overwritten(self):
        out = Path(self.args.output_dir)
        out.mkdir()
        page = out / "file-import-dev-design.html"
        page.write_text("User-authored page")
        with self.assertRaisesRegex(ValueError, "拒绝覆盖"):
            self.render()
        self.assertEqual(page.read_text(), "User-authored page")

    def test_missing_cli_is_actionable(self):
        with mock.patch.object(renderer.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ValueError, "未找到 Mermaid CLI"):
                renderer.render(self.args)

    def test_feature_cannot_escape_output_directory(self):
        self.args.feature = "../elsewhere"
        with self.assertRaisesRegex(ValueError, "kebab-case"):
            self.render()
        self.assertFalse(Path(self.args.output_dir).exists())

    def test_empty_svg_is_rejected(self):
        empty = self.root / "empty.svg"
        empty.write_text('<svg viewBox="0 0 320 180"></svg>')
        with self.assertRaisesRegex(ValueError, "没有可绘制的图形元素"):
            renderer.svg_dimensions(empty)

    def test_bad_png_is_rejected(self):
        image = self.root / "bad.png"
        image.write_bytes(b"not an image")
        with self.assertRaisesRegex(ValueError, "PNG 输出无效"):
            renderer.validate_png(image)

    def test_rerender_updates_source_identity(self):
        first = self.render()
        self.source.write_text("flowchart TD\n A-->C\n")
        second = self.render()
        self.assertNotEqual(
            first["diagrams"][0]["sha256"], second["diagrams"][0]["sha256"]
        )
        self.assertIn(second["diagrams"][0]["sha256"], Path(second["html"]).read_text())

    def test_new_png_collision_is_preserved(self):
        self.render()
        collision = Path(self.args.output_dir) / "file-import-dev-design.png"
        collision.write_bytes(b"User PNG")
        self.args.png = True
        with self.assertRaisesRegex(ValueError, "不属于本次渲染或已被修改"):
            self.render()
        self.assertEqual(collision.read_bytes(), b"User PNG")

    def test_new_numbered_image_collision_is_preserved(self):
        self.render()
        collision = Path(self.args.output_dir) / "file-import-dev-design-01.svg"
        collision.write_bytes(b"User SVG")
        self.args.source.append(str(self.source))
        with self.assertRaisesRegex(ValueError, "不属于本次渲染或已被修改"):
            self.render()
        self.assertEqual(collision.read_bytes(), b"User SVG")

    def test_modified_generated_image_is_preserved(self):
        first = self.render()
        image = Path(first["diagrams"][0]["svg"])
        image.write_bytes(b"User edit")
        with self.assertRaisesRegex(ValueError, "不属于本次渲染或已被修改"):
            self.render()
        self.assertEqual(image.read_bytes(), b"User edit")

    def test_truncated_png_and_bad_checksum_are_rejected(self):
        for data in [PNG[:24], PNG[:-12], PNG[:-1] + b"x"]:
            image = self.root / "truncated.png"
            image.write_bytes(data)
            with self.assertRaisesRegex(ValueError, "PNG 输出无效"):
                renderer.validate_png(image)

    def test_definitions_only_svg_is_rejected(self):
        image = self.root / "definitions.svg"
        image.write_text(
            '<svg viewBox="0 0 320 180"><defs><path d="M0 0 L10 10"/></defs></svg>'
        )
        with self.assertRaisesRegex(ValueError, "没有可绘制的图形元素"):
            renderer.svg_dimensions(image)

    def test_directory_collision_does_not_change_any_artifact(self):
        self.render()
        out = Path(self.args.output_dir)
        previous = {path.name: path.read_bytes() for path in out.iterdir()}
        (out / "file-import-dev-design.png").mkdir()
        self.args.png = True
        with self.assertRaisesRegex(ValueError, "非文件类型"):
            self.render()
        for name, data in previous.items():
            self.assertEqual((out / name).read_bytes(), data)

    def test_publication_failure_restores_old_and_removes_new_artifacts(self):
        self.render()
        out = Path(self.args.output_dir)
        previous = {path.name: path.read_bytes() for path in out.iterdir()}
        self.source.write_text("flowchart TD\n  A-->C\n")
        self.args.png = True
        real_replace = os.replace
        failed = False

        def fail_page_once(source, target):
            nonlocal failed
            if Path(target).suffix == ".html" and not failed:
                failed = True
                raise OSError("publication fixture failure")
            return real_replace(source, target)

        with mock.patch.object(renderer.os, "replace", side_effect=fail_page_once):
            with self.assertRaisesRegex(ValueError, "已恢复原有附件"):
                self.render()
        self.assertTrue(failed)
        self.assertEqual({path.name: path.read_bytes() for path in out.iterdir()}, previous)

    def test_review_pages_have_chinese_titles_and_language(self):
        self.args.title = "资料导入"
        for kind, title in [
            ("dev-design", "技术方案与架构设计"),
            ("test-workflow", "端到端测试流程"),
        ]:
            self.args.kind = kind
            result = self.render()
            page = Path(result["html"]).read_text(encoding="utf-8")
            self.assertIn('<html lang="zh-CN">', page)
            self.assertIn(f"<title>资料导入 - {title}</title>", page)
            self.assertIn("Mermaid 源码", page)
            self.assertIn("图 1：architecture", page)
            self.assertEqual(
                Path(result["html"]).name, f"file-import-{kind}.html"
            )

    def test_cli_help_contains_chinese_descriptions(self):
        output = io.StringIO()
        with mock.patch("sys.stdout", output):
            with self.assertRaises(SystemExit) as raised:
                renderer.main(["--help"])
        self.assertEqual(raised.exception.code, 0)
        self.assertIn("可离线审阅的中文 HTML", output.getvalue())
        self.assertIn("同时生成 PNG 预览", output.getvalue())


if __name__ == "__main__":
    unittest.main()
