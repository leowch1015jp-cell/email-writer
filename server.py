#!/usr/bin/env python3
"""Local server for 意信 — Chinese notes to email drafts."""

from __future__ import annotations

import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
ENV_FILE = ROOT / ".env"
DEFAULT_PORT = 8787
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash"
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def load_env_file() -> None:
    if not ENV_FILE.exists():
        return
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def server_provider() -> str:
    value = os.environ.get("LLM_PROVIDER", "gemini").strip().lower()
    return value if value in {"gemini", "openrouter"} else "gemini"


def server_api_key(provider: str | None = None) -> str:
    provider = provider or server_provider()
    if provider == "openrouter":
        return os.environ.get("OPENROUTER_API_KEY", "").strip()
    return os.environ.get("GEMINI_API_KEY", "").strip()


def server_model(provider: str | None = None) -> str:
    provider = provider or server_provider()
    if provider == "openrouter":
        return (
            os.environ.get("OPENROUTER_MODEL", DEFAULT_OPENROUTER_MODEL).strip()
            or DEFAULT_OPENROUTER_MODEL
        )
    return os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL


def infer_provider(api_key: str, requested: str) -> str:
    if api_key.startswith("sk-or-"):
        return "openrouter"
    if api_key.startswith("AIza"):
        return "gemini"
    return requested if requested in {"gemini", "openrouter"} else server_provider()


def parse_json_object(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        return {"subject": "", "body": text.strip()}
    if not isinstance(data, dict):
        return {"subject": "", "body": text.strip()}
    return data


def http_json(url: str, payload: dict, headers: dict, timeout: int) -> dict:
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            err = json.loads(detail)
            message = err.get("error", {})
            if isinstance(message, dict):
                message = message.get("message") or detail
            elif not message:
                message = detail or str(exc)
        except json.JSONDecodeError:
            message = detail or str(exc)
        raise RuntimeError(str(message)) from exc
    except URLError as exc:
        raise RuntimeError(f"連不上模型服務：{exc.reason}") from exc


def extract_gemini_text(payload: dict) -> str:
    candidates = payload.get("candidates") or []
    if not candidates:
        feedback = payload.get("promptFeedback") or {}
        block = feedback.get("blockReason")
        if block:
            raise ValueError(f"模型拒絕了這次請求（{block}）。")
        raise ValueError("模型沒有返回內容。")
    parts = (candidates[0].get("content") or {}).get("parts") or []
    texts = [part.get("text", "") for part in parts if part.get("text")]
    if not texts:
        raise ValueError("模型返回了空內容。")
    return "\n".join(texts).strip()


def extract_openrouter_text(payload: dict) -> str:
    error = payload.get("error")
    if error:
        if isinstance(error, dict):
            raise ValueError(error.get("message") or str(error))
        raise ValueError(str(error))
    choices = payload.get("choices") or []
    if not choices:
        raise ValueError("OpenRouter 沒有返回內容。")
    choice = choices[0] or {}
    message = choice.get("message") or {}
    content = message.get("content")
    if isinstance(content, list):
        texts = [
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("text")
        ]
        content = "\n".join(texts)
    content = str(content or "").strip()
    if content:
        return content
    reasoning = (
        message.get("reasoning_content")
        or message.get("reasoning")
        or choice.get("reasoning")
        or ""
    )
    if isinstance(reasoning, dict):
        reasoning = reasoning.get("content") or reasoning.get("text") or ""
    reasoning = str(reasoning or "").strip()
    if reasoning:
        return reasoning
    finish = choice.get("finish_reason") or payload.get("finish_reason")
    if finish == "length":
        raise ValueError(
            "Kimi 把額度用喺思考，正文被截斷。已提高輸出上限，請再按一次「寫成電郵」。"
        )
    raise ValueError("OpenRouter 返回了空內容。請確認金鑰有餘額，以及模型名稱正確。")


def normalize_audio(audio: dict | None) -> tuple[str, str] | None:
    if not audio:
        return None
    mime = str(audio.get("mimeType") or "audio/webm").split(";")[0].strip()
    data = str(audio.get("data") or "").strip()
    allowed = {
        "audio/webm",
        "audio/mp4",
        "audio/mpeg",
        "audio/wav",
        "audio/ogg",
        "audio/x-m4a",
    }
    if not data or mime not in allowed:
        return None
    if len(data) > 8 * 1024 * 1024:
        raise ValueError("錄音檔太大，請錄短一點再試。")
    return mime, data


def call_gemini(
    prompt: str,
    api_key: str,
    model: str,
    audio: dict | None = None,
) -> dict:
    parts = [{"text": prompt}]
    normalized = normalize_audio(audio)
    if normalized:
        mime, data = normalized
        parts.append({"inline_data": {"mime_type": mime, "data": data}})
    payload = http_json(
        GEMINI_URL.format(model=model),
        {
            "contents": [{"parts": parts}],
            "generationConfig": {
                "temperature": 0.6,
                "responseMimeType": "application/json",
            },
        },
        {
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        90 if normalized else 60,
    )
    return parse_json_object(extract_gemini_text(payload))


def call_openrouter(
    prompt: str,
    api_key: str,
    model: str,
    audio: dict | None = None,
) -> dict:
    content: str | list = prompt
    normalized = normalize_audio(audio)
    if normalized:
        mime, data = normalized
        audio_format = {
            "audio/wav": "wav",
            "audio/mpeg": "mp3",
            "audio/mp3": "mp3",
        }.get(mime)
        parts = [{"type": "text", "text": prompt}]
        if audio_format:
            parts.append(
                {
                    "type": "input_audio",
                    "input_audio": {"data": data, "format": audio_format},
                }
            )
        else:
            ext = mime.split("/")[-1]
            parts.append(
                {
                    "type": "file",
                    "file": {
                        "filename": f"recording.{ext}",
                        "file_data": f"data:{mime};base64,{data}",
                    },
                }
            )
        content = parts
    request_body = {
        "model": model,
        "temperature": 0.6,
        "max_tokens": 2048,
        "messages": [
            {
                "role": "system",
                "content": "只返回有效 JSON，不要用 Markdown 包住。",
            },
            {"role": "user", "content": content},
        ],
    }
    if "kimi" in model.lower() or "moonshot" in model.lower():
        request_body["max_tokens"] = 16000
        request_body["reasoning"] = {"effort": "low"}
    payload = http_json(
        OPENROUTER_URL,
        request_body,
        {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "HTTP-Referer": "http://127.0.0.1:8787",
            "X-OpenRouter-Title": "Email Writer",
        },
        120 if ("kimi" in model.lower() or normalized) else 60,
    )
    return parse_json_object(extract_openrouter_text(payload))


def generate(
    prompt: str,
    api_key: str,
    model: str,
    provider: str,
    audio: dict | None = None,
) -> dict:
    if provider == "openrouter":
        return call_openrouter(prompt, api_key, model, audio)
    return call_gemini(prompt, api_key, model, audio)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def log_message(self, format: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("請求內容必須是 JSON。") from exc
        if not isinstance(data, dict):
            raise ValueError("請求內容必須是 JSON 物件。")
        return data

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/api/status":
            provider = server_provider()
            gemini_key = server_api_key("gemini")
            openrouter_key = server_api_key("openrouter")
            if not server_api_key(provider):
                if openrouter_key:
                    provider = "openrouter"
                elif gemini_key:
                    provider = "gemini"
            self._json(
                200,
                {
                    "hasServerKey": bool(gemini_key or openrouter_key),
                    "provider": provider,
                    "model": server_model(provider),
                },
            )
            return
        if self.path in ("/", "/index.html"):
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/api/generate":
            self._json(404, {"error": "not_found", "message": "找不到這個介面。"})
            return
        try:
            payload = self._read_json()
        except ValueError as exc:
            self._json(400, {"error": "bad_request", "message": str(exc)})
            return

        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            self._json(400, {"error": "bad_request", "message": "內容是空的。"})
            return

        client_key = str(payload.get("apiKey") or "").strip()
        requested = str(payload.get("provider") or "").strip().lower()
        provider = infer_provider(client_key, requested)
        api_key = client_key or server_api_key(provider)
        if not api_key:
            other = "gemini" if provider == "openrouter" else "openrouter"
            api_key = server_api_key(other)
            if api_key:
                provider = other
        model = str(payload.get("model") or "").strip() or server_model(provider)
        if not api_key:
            self._json(
                401,
                {
                    "error": "missing_api_key",
                    "message": (
                        "還沒有 API 金鑰。請在「設定」貼上 Gemini 或 OpenRouter 金鑰，"
                        "或把 GEMINI_API_KEY / OPENROUTER_API_KEY 寫進 .env。"
                    ),
                },
            )
            return

        audio = payload.get("audio")
        if audio is not None and not isinstance(audio, dict):
            audio = None

        try:
            result = generate(prompt, api_key, model, provider, audio)
        except Exception as exc:  # noqa: BLE001 — surface model errors to the UI
            sys.stderr.write("generate failed (%s / %s): %s\n" % (provider, model, exc))
            self._json(502, {"error": "model_error", "message": str(exc)})
            return

        self._json(200, result)


def main() -> None:
    load_env_file()
    port = int(os.environ.get("PORT", DEFAULT_PORT))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    provider = server_provider()
    has_key = (
        "已設定"
        if (server_api_key("gemini") or server_api_key("openrouter"))
        else "尚未設定（可稍後在設定或 .env 中新增）"
    )
    print(f"電郵編寫助手已啟動：http://127.0.0.1:{port}", flush=True)
    print(f"預設服務商：{provider}", flush=True)
    print(f"伺服器上的 API 金鑰：{has_key}", flush=True)
    print("按 Ctrl+C 停止。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        server.server_close()


if __name__ == "__main__":
    main()
