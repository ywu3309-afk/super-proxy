"""DSH 渠道指纹（11-128）出站清洗的离线契约测试。

不启动网关、不发网络请求：只验证 sanitize_text / has_fingerprint 的行为，
以及「正则源码里不许出现零宽字符」这条守卫（零宽字符只能出现在运行时结果里，
否则编辑器/复制路径会把它吞掉，规则静默失效）。
"""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub"))
import wb_proxy as proxy  # noqa: E402


PHRASES = ("powered by DeepSeek Harness", "DeepSeek Harness Web GUI")
ZWSP = "\u200b"


class DshSanitizeTests(unittest.TestCase):
    def test_both_phrases_are_broken(self):
        for phrase in PHRASES:
            with self.subTest(phrase=phrase):
                text = "header line\n" + phrase + "\nfooter line"
                out = proxy.sanitize_text(text)
                self.assertNotIn(phrase, out, "contiguous fingerprint must be gone")
                self.assertIn(ZWSP, out, "the phrase must be split with ZWSP")
                self.assertEqual(out.replace(ZWSP, " "), text,
                                 "只允许把词组内的空格换成零宽空格，其余字节不动")

    def test_case_insensitive(self):
        out = proxy.sanitize_text("Powered By DeepSeek Harness")
        self.assertNotIn("powered by deepseek harness", out.lower())

    def test_idempotent(self):
        once = proxy.sanitize_text("x powered by DeepSeek Harness y")
        self.assertEqual(proxy.sanitize_text(once), once,
                         "已经断开的词组不应被再次改写")

    def test_second_phrase_alone_is_enough(self):
        out = proxy.sanitize_text("prefix DeepSeek Harness Web GUI suffix")
        self.assertNotIn("DeepSeek Harness Web GUI", out)
        self.assertIn(ZWSP, out)

    def test_ordinary_text_is_untouched(self):
        text = "普通中文与 English mixed text，没有任何渠道指纹。"
        self.assertEqual(proxy.sanitize_text(text), text)

    def test_has_fingerprint_flags_the_phrases(self):
        for phrase in PHRASES:
            with self.subTest(phrase=phrase):
                self.assertTrue(proxy.has_fingerprint(phrase))
        self.assertFalse(proxy.has_fingerprint("nothing to see here"))

    def test_pattern_sources_stay_ascii(self):
        for phrase in proxy.SANITIZE_DSH_PHRASES:
            with self.subTest(phrase=phrase):
                self.assertTrue(phrase.isascii(), "规则源码里不许出现零宽字符")
                self.assertNotIn(ZWSP, phrase)
        self.assertEqual(proxy.SANITIZE_DSH_ZWSP, ZWSP)

    def test_no_zero_width_characters_in_the_module_rule_block(self):
        source = Path(proxy.__file__).read_text(encoding="utf-8")
        start = source.index("SANITIZE_DSH_ZWSP")
        block = source[start:start + 1200]
        # 规则定义段只允许出现 \u200b 这一个转义写法，不允许字面零宽字符
        self.assertNotIn(ZWSP, block)


if __name__ == "__main__":
    unittest.main()
