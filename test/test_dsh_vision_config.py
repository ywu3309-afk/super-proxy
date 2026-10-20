"""DSH capability propagation; fixture-only, no real client files or requests."""
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub"))
import wb_agents as agents


class DshVisionConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dsh-vision-", dir=Path(__file__).resolve().parents[1] / "analysis" / "test-tmp")
        self.addCleanup(self.temp.cleanup)

    def entries(self, models):
        result = agents.plan("dsh", "http://127.0.0.1:9999/v1", "fixture-key", models=models, home=self.temp.name)
        settings = next(item["content"] for item in result["files"] if item["path"].endswith("settings.yaml"))
        provider_line = next(line for line in settings.splitlines() if line.strip().startswith(agents.PROVIDER_ID + ":"))
        return json.loads(provider_line.split(":", 1)[1])["models"]

    def test_all_explicit_flag_aliases_and_arrays(self):
        sources = [{key: True} for key in ("vision", "supportsVision", "supports_vision", "supports_images", "supportsImages", "multimodal")]
        sources += [{"capabilities": {"vision": True}}, {"abilities": {"vision": True}},
                    {"input": ["text", "image"]}, {"input_modalities": ["text", "image"]},
                    {"modalities": {"input": ["text", "image"]}}, {"architecture": {"input_modalities": ["text", "image"]}}]
        for source in sources:
            with self.subTest(source=source):
                entry = self.entries([{"id": "arbitrary-id", **source}])[0]
                self.assertEqual(entry["input"], ["text", "image"])
                self.assertIs(entry["supportsVision"], True)

    def test_unknown_malformed_and_truthy_non_boolean_do_not_enable_images(self):
        sources = [{}, {"supports_vision": "true"}, {"vision": 1}, {"multimodal": {}},
                   {"input": "text,image"}, {"input": ["image", None]}, {"input": ["image", "unknown"]},
                   {"input": []}, {"input": ["IMAGE"]}, {"input": ["text"]}, {"output_modalities": ["image"]}]
        for source in sources:
            entry = self.entries([{"id": "trae/deepseek-v4.1-flash", **source}])[0]
            self.assertEqual(entry["input"], ["text"])
            self.assertNotIn("supportsVision", entry)

    def test_explicit_negative_or_text_only_declaration_wins_conflicts(self):
        negatives = [{"vision": False}, {"capabilities": {"vision": False}}, {"abilities": {"vision": False}},
                     {"input_modalities": ["text"]}, {"modalities": {"input": ["text"]}},
                     {"architecture": {"input_modalities": ["text"]}}, {"disabledMultimodal": True}]
        for negative in negatives:
            source = {"id": "vision-name", "supports_vision": True, "input": ["text", "image"], **negative}
            self.assertEqual(self.entries([source])[0]["input"], ["text"])

    def test_fetch_then_plan_propagates_authority_and_preserves_metadata(self):
        payload = {"data": [{"id": "image-model", "input_modalities": ["text", "image"],
                              "context_length": 123456, "max_output_tokens": 4567, "reasoning_efforts": ["low", "high"], "name": "Example"},
                             {"id": "trae/deepseek-v4.1-flash", "input_modalities": ["text"], "supportsVision": True}]}
        with patch.object(agents.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(payload).encode())) as request:
            models = agents.fetch_models_from_gateway("http://127.0.0.1:9999/v1", "fixture-key")
        self.assertEqual(request.call_args.args[0].full_url, "http://127.0.0.1:9999/v1/models")
        self.assertEqual(models[0]["name"], "Example")
        entries = self.entries(models)
        self.assertEqual(entries[0], {"id": "image-model", "input": ["text", "image"], "contextWindow": 123456,
                                     "maxTokens": 4567, "reasoningEfforts": {"low": "low", "high": "high"}, "supportsVision": True})
        self.assertEqual(entries[1]["input"], ["text"])
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])

    def test_non_dsh_models_are_not_given_dsh_input(self):
        result = agents.plan("crush", "http://127.0.0.1:9999/v1", "fixture-key",
                             models=[{"id": "model", "input": ["text", "image"], "supports_vision": True}], home=self.temp.name)
        config = json.loads(result["files"][0]["content"])
        self.assertEqual(config["providers"][agents.PROVIDER_ID]["models"], [{"id": "model", "name": "model"}])


if __name__ == "__main__":
    unittest.main()
