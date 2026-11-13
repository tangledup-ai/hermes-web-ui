"""Apply Studio's server-authenticated ASR settings to one audio request."""

from __future__ import annotations

import base64
import binascii
import json
import os
from dataclasses import replace
from secrets import compare_digest

from .config import default_settings, transcription_owner, transcription_settings


class TranscriptionContextMiddleware:
    def __init__(self, app):
        self.app = app
        self.token = os.environ.get("STUDIO_TRANSCRIPTION_TOKEN", "").encode("ascii")

    async def __call__(self, scope, receive, send):
        headers = dict(scope.get("headers", []))
        encoded = headers.get(b"x-studio-transcription-context")
        if not encoded:
            return await self.app(scope, receive, send)

        supplied_token = headers.get(b"x-studio-transcription-token", b"")
        if not self.token or not compare_digest(supplied_token, self.token):
            return await self._reject(scope, send)

        try:
            context = json.loads(base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4)))
            owner = context["owner"]
            overrides = context["settings"]
            if not isinstance(owner, str) or not isinstance(overrides, dict):
                raise TypeError("Invalid transcription context")
            config = replace(default_settings, **overrides)
            config.asr_language_hints = overrides.get("paraformer_language_hints", config.asr_language_hints)
        except (ValueError, TypeError, KeyError, binascii.Error):
            return await self._reject(scope, send)

        settings_token = transcription_settings.set(config)
        owner_token = transcription_owner.set(owner)
        try:
            if context.get("fixedProvider") is True:
                scope["studio_fixed_asr_provider"] = config.asr_provider
            return await self.app(scope, receive, send)
        finally:
            transcription_owner.reset(owner_token)
            transcription_settings.reset(settings_token)

    @staticmethod
    async def _reject(scope, send):
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
        else:
            await send({"type": "http.response.start", "status": 403, "headers": []})
            await send({"type": "http.response.body", "body": b""})
