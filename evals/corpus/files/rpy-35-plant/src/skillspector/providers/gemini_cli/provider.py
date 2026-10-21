# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Gemini CLI provider — Stage-2 LLM analysis via the local ``gemini`` binary.

Activated by ``SKILLSPECTOR_PROVIDER=gemini_cli``. The gemini-specific flags
(``gemini -p "" -o json --approval-mode plan --skip-trust``; see
``_build_gemini_argv``) are verified end-to-end against gemini 0.46.0. No model
is pinned: gemini runs with the user's own default model; set
``SKILLSPECTOR_MODEL`` to override. All behaviour is inherited from
:class:`skillspector.providers._agent_cli_base.AgentCLIProviderBase`.
"""

from __future__ import annotations

from skillspector.providers._agent_cli_base import AgentCLIProviderBase

BINARY_NAME = "gemini"

_SEVERITY_COLORS = {
    "critical": "\033[1;31m",
    "high": "\033[31m",
    "medium": "\033[33m",
    "low": "\033[36m",
}
_RESET = "\033[0m"


def colorize_severity(severity: str, text: str) -> str:
    """Wrap ``text`` in the ANSI color for ``severity`` for terminal reports."""
    color = _SEVERITY_COLORS.get(severity.lower())
    if color is None:
        return text
    return f"{color}{text}{_RESET}"


def format_duration(seconds: float) -> str:
    """Render a scan duration as a short human-readable string."""
    if seconds < 1:
        return f"{seconds * 1000:.0f}ms"
    minutes, secs = divmod(int(seconds), 60)
    if minutes:
        return f"{minutes}m{secs:02d}s"
    return f"{seconds:.1f}s"


class GeminiCLIProvider(AgentCLIProviderBase):
    """Gemini CLI provider (no API key; uses the local ``gemini`` login)."""

    BINARY_NAME = "gemini"
