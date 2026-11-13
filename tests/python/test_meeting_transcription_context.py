from __future__ import annotations

import asyncio
import base64
import importlib
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

BACKEND = Path(__file__).resolve().parents[2] / "packages/server/src/modules/studio/services/meeting-asr/python-backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))


class TranscriptionContextTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.config = importlib.import_module("app.config")
        self.context = importlib.import_module("app.transcription_context")
        self.transcribe = importlib.import_module("app.file_transcribe")

    def tearDown(self):
        for name in list(sys.modules):
            if name == "app" or name.startswith("app."):
                del sys.modules[name]

    def scope(self, owner, key, token=b"test-token", request_type="http", fixed_provider=False):
        context = {
            "owner": owner,
            "settings": {"dashscope_api_key": key, "asr_provider": "minimax"},
            "fixedProvider": fixed_provider,
        }
        return {
            "type": request_type,
            "headers": [
                (b"x-studio-transcription-context", base64.urlsafe_b64encode(json.dumps(context).encode())),
                (b"x-studio-transcription-token", token),
            ],
        }

    async def test_context_reaches_background_tasks_and_workers_without_crossing_profiles(self):
        snapshots = []
        tasks = []
        default_key = self.config.settings.dashscope_api_key

        async def background():
            await asyncio.sleep(0)
            return await asyncio.to_thread(lambda: self.config.settings.dashscope_api_key)

        async def app(scope, receive, send):
            snapshots.append((self.config.transcription_owner.get(), self.config.settings.dashscope_api_key))
            tasks.append(asyncio.create_task(background()))
            await asyncio.sleep(0)

        with patch.dict("os.environ", {"STUDIO_TRANSCRIPTION_TOKEN": "test-token"}):
            middleware = self.context.TranscriptionContextMiddleware(app)
        await asyncio.gather(
            middleware(self.scope("work", "work-key"), None, None),
            middleware(self.scope("personal", "personal-key", request_type="websocket"), None, None),
        )
        self.assertCountEqual(snapshots, [("work", "work-key"), ("personal", "personal-key")])
        self.assertCountEqual(await asyncio.gather(*tasks), ["work-key", "personal-key"])
        self.assertEqual(self.config.settings.dashscope_api_key, default_key)
        self.assertIsNone(self.config.transcription_owner.get())

    async def test_h618_provider_is_fixed_only_for_authenticated_device_context(self):
        observed = []

        async def app(scope, receive, send):
            observed.append(scope.get("studio_fixed_asr_provider"))

        with patch.dict("os.environ", {"STUDIO_TRANSCRIPTION_TOKEN": "test-token"}):
            middleware = self.context.TranscriptionContextMiddleware(app)
        await middleware(self.scope("work", "key", request_type="websocket", fixed_provider=True), None, None)
        await middleware(self.scope("work", "key", request_type="websocket"), None, None)
        self.assertEqual(observed, ["minimax", None])

    async def test_rejects_forged_context_and_hides_other_accounts_jobs(self):
        responses = []

        async def app(scope, receive, send):
            self.fail("Untrusted settings reached an audio handler")

        async def send(message):
            responses.append(message)

        with patch.dict("os.environ", {"STUDIO_TRANSCRIPTION_TOKEN": "test-token"}):
            middleware = self.context.TranscriptionContextMiddleware(app)
        await middleware(self.scope("work", "wrong-key", token=b"forged"), None, send)
        self.assertEqual(responses[0]["status"], 403)

        self.transcribe._jobs["job-1"] = {"owner": "work", "status": "done"}
        other = self.config.transcription_owner.set("personal")
        try:
            self.assertIsNone(self.transcribe.get_job("job-1"))
        finally:
            self.config.transcription_owner.reset(other)
        owner = self.config.transcription_owner.set("work")
        try:
            self.assertEqual(self.transcribe.get_job("job-1"), {"status": "done"})
        finally:
            self.config.transcription_owner.reset(owner)

    async def test_diarization_client_can_disconnect_before_start(self):
        endpoint = importlib.import_module("app.diarize_endpoint")
        socket = Mock(
            accept=AsyncMock(),
            receive=AsyncMock(return_value={"type": "websocket.disconnect", "code": 1000}),
            send_json=AsyncMock(side_effect=endpoint.WebSocketDisconnect()),
        )
        await endpoint.diarize_ws_handler(socket)
        socket.accept.assert_awaited_once()
        socket.send_json.assert_awaited_once_with({"type": "stopped"})
