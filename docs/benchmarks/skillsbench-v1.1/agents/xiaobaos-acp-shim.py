#!/usr/bin/env python3
"""Minimal ACP-over-stdio compatibility shim for XiaoBaOS benchmark runs.

This file is shipped by Barena and installed inside a BenchFlow task container.
It does not claim that XiaoBaOS natively implements ACP. BenchFlow speaks ACP to
this process; this process invokes XiaoBaOS's one-shot `xiaoba chat` CLI.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

XIAOBA_BIN = os.environ.get("BARENA_XIAOBA_BIN", "/opt/benchflow/bin/xiaoba")
COMPOSITE_NAME = "skillsbench-composite"
HEARTBEAT_SECONDS = float(os.environ.get("BARENA_HEARTBEAT_SECONDS", "30"))
ANSI_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
active_process: subprocess.Popen[str] | None = None


def send(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def receive() -> dict[str, Any]:
    while True:
        line = sys.stdin.readline()
        if not line:
            raise EOFError("stdin closed")
        if line.strip():
            return json.loads(line)


def update(session_id: str, kind: str, text: str) -> None:
    send(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {"sessionUpdate": kind, "text": text},
            },
        }
    )


def prompt_text(parts: object) -> str:
    if not isinstance(parts, list):
        return ""
    return "".join(
        str(part.get("text", ""))
        for part in parts
        if isinstance(part, dict) and part.get("type") == "text"
    )


def candidate_skill_roots(cwd: Path) -> list[Path]:
    home = Path(os.environ.get("HOME", str(Path.home())))
    values = [
        home / ".xiaoba" / "skills",
        home / ".claude" / "skills",
        cwd / ".xiaoba" / "skills",
        cwd / ".claude" / "skills",
        cwd / ".codex" / "skills",
        cwd / ".agents" / "skills",
        cwd / "skills",
    ]
    seen: set[str] = set()
    roots: list[Path] = []
    for value in values:
        resolved = str(value.resolve())
        if resolved not in seen and value.is_dir():
            roots.append(value)
            seen.add(resolved)
    return roots


def strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        match = re.match(r"^---\s*\n[\s\S]*?\n---\s*\n?", text)
        if match:
            return text[match.end() :]
    return text


def create_composite_skill(cwd: Path) -> tuple[Path | None, int]:
    manifests: list[Path] = []
    for root in candidate_skill_roots(cwd):
        manifests.extend(sorted(root.rglob("SKILL.md")))
    unique = list(dict.fromkeys(path.resolve() for path in manifests))
    if not unique:
        return None, 0

    composite_root = Path(tempfile.mkdtemp(prefix="barena-xiaoba-skills-"))
    skill_root = composite_root / COMPOSITE_NAME
    skill_root.mkdir(parents=True)
    sections = [
        "---",
        f"name: {COMPOSITE_NAME}",
        "description: Composite of the source-pinned SkillsBench skills for this task.",
        "status: active",
        "auto-invocable: true",
        "user-invocable: true",
        "max-turns: 40",
        "---",
        "",
        "# SkillsBench composite skill",
        "",
        "Apply every relevant instruction below. Each section records its original package root.",
        "Resolve relative script, reference, and resource paths against that original root.",
        "",
    ]
    for manifest in unique:
        sections.extend(
            [
                f"## Source Skill: {manifest.parent.name}",
                "",
                f"Original package root: `{manifest.parent}`",
                "",
                strip_frontmatter(manifest.read_text(encoding="utf-8")),
                "",
            ]
        )
    (skill_root / "SKILL.md").write_text("\n".join(sections), encoding="utf-8")
    return composite_root, len(unique)


def clean_output(stdout: str) -> str:
    plain = ANSI_RE.sub("", stdout).replace("\r", "")
    lines = plain.splitlines()
    marker = next(
        (index for index, line in enumerate(lines) if "Your AI Assistant !!! Meow Meow" in line),
        -1,
    )
    if marker >= 0:
        lines = lines[marker + 2 :]
    return "\n".join(lines).strip()


def run_xiaoba(cwd: Path, prompt: str, session_id: str) -> tuple[int, str, str]:
    global active_process
    env = dict(os.environ)
    env.update(
        {
            "CI": "1",
            "NO_COLOR": "1",
            "XIAOBA_APP_ROOT": "/opt/benchflow/xiaobaos",
            "XIAOBA_PROJECT_ROOT": str(cwd),
        }
    )
    composite_root, skill_count = create_composite_skill(cwd)
    # SkillsBench tasks are artifact-oriented. Use XiaoBaOS's built-in EngineerCat
    # profile so evaluation measures direct task execution rather than the Base
    # agent's asynchronous sub-agent scheduling policy.
    args = [XIAOBA_BIN, "chat", "--role", "engineer-cat", "--message", prompt]
    if composite_root is not None:
        env["XIAOBA_SKILLS_ROOT"] = str(composite_root)
        args.extend(["--skill", COMPOSITE_NAME])
        update(
            session_id,
            "agent_thought",
            f"[barena] activated a composite XiaoBaOS Skill built from {skill_count} source package(s).",
        )
    try:
        active_process = subprocess.Popen(
            args,
            cwd=str(cwd),
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        started = time.monotonic()
        while True:
            remaining = 1800 - (time.monotonic() - started)
            if remaining <= 0:
                raise subprocess.TimeoutExpired(args, 1800)
            try:
                stdout, stderr = active_process.communicate(
                    timeout=min(HEARTBEAT_SECONDS, remaining)
                )
                return active_process.returncode or 0, stdout, stderr
            except subprocess.TimeoutExpired:
                elapsed = int(time.monotonic() - started)
                update(
                    session_id,
                    "agent_thought",
                    f"[barena] XiaoBaOS is still running ({elapsed}s elapsed).",
                )
    except subprocess.TimeoutExpired:
        if active_process is not None:
            os.killpg(active_process.pid, signal.SIGTERM)
            try:
                active_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(active_process.pid, signal.SIGKILL)
        return 124, "", "XiaoBaOS benchmark turn timed out after 1800 seconds."
    finally:
        active_process = None
        if composite_root is not None:
            shutil.rmtree(composite_root, ignore_errors=True)


def main() -> None:
    session_id = f"xiaobaos-{uuid.uuid4().hex[:12]}"
    cwd = Path("/app")
    while True:
        try:
            message = receive()
        except EOFError:
            break
        method = str(message.get("method", ""))
        request_id = message.get("id")
        params = message.get("params", {})
        if not isinstance(params, dict):
            params = {}

        if method == "initialize":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "protocolVersion": 1,
                        "agentCapabilities": {
                            "loadSession": False,
                            "promptCapabilities": {"image": False, "audio": False},
                        },
                        "agentInfo": {
                            "name": "barena-xiaobaos-shim",
                            "version": "1.0.0",
                        },
                    },
                }
            )
        elif method == "session/new":
            requested = Path(str(params.get("cwd", "/app"))).resolve()
            if not requested.is_dir():
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32602, "message": f"workspace does not exist: {requested}"},
                    }
                )
                continue
            cwd = requested
            session_id = f"xiaobaos-{uuid.uuid4().hex[:12]}"
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {"sessionId": session_id},
                }
            )
        elif method in {"session/set_model", "session/set_config_option"}:
            send({"jsonrpc": "2.0", "id": request_id, "result": {}})
        elif method == "session/prompt":
            prompt = prompt_text(params.get("prompt"))
            if not prompt.strip():
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32602, "message": "empty prompt"},
                    }
                )
                continue
            try:
                code, stdout, stderr = run_xiaoba(cwd, prompt, session_id)
                if stderr.strip():
                    update(session_id, "agent_thought", f"[xiaoba stderr]\n{stderr[-2000:]}")
                assistant = clean_output(stdout)
                if assistant:
                    update(session_id, "agent_message_chunk", assistant)
                if code != 0:
                    send(
                        {
                            "jsonrpc": "2.0",
                            "id": request_id,
                            "error": {
                                "code": -32603,
                                "message": f"xiaoba chat failed with exit code {code}",
                            },
                        }
                    )
                else:
                    send(
                        {
                            "jsonrpc": "2.0",
                            "id": request_id,
                            "result": {"stopReason": "end_turn"},
                        }
                    )
            except Exception as error:
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "error": {"code": -32603, "message": str(error)},
                    }
                )
        elif method == "session/cancel":
            if active_process is not None:
                os.killpg(active_process.pid, signal.SIGTERM)
            send({"jsonrpc": "2.0", "id": request_id, "result": {}})
        elif method == "session/request_permission":
            options = params.get("options", [])
            option = options[0] if isinstance(options, list) and options else {}
            option_id = option.get("optionId", "default") if isinstance(option, dict) else "default"
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {"outcome": {"outcome": "selected", "optionId": option_id}},
                }
            )
        elif request_id is not None:
            send({"jsonrpc": "2.0", "id": request_id, "result": {}})


if __name__ == "__main__":
    main()
