"""Hermes Router inference client for the local coding runtime."""

from __future__ import annotations

from typing import Any, Callable

from hermes_router_client import RouterConfig, request_json

from .errors import AgentError


class HermesInferenceClient:
    def __init__(
        self,
        config: RouterConfig,
        request: Callable[..., Any] = request_json,
        task_intent: str | None = None,
    ):
        self.config = config
        self.request = request
        # Optional generic workload hint, forwarded to the inference gateway
        # for the whole run. None → no hint, i.e. normal routing.
        self.task_intent = task_intent

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        run_id: str,
    ) -> dict[str, Any]:
        payload = {
            "model": self.config.model,
            "stream": False,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
            "parallel_tool_calls": False,
        }
        headers = {
            "X-Hermes-Tool-Loop": "true",
            "X-Hermes-Session-Affinity": run_id,
        }
        if self.task_intent is not None:
            headers["X-Hermes-Workload-Hint"] = self.task_intent
        response = self.request(
            self.config,
            "POST",
            "/chat/completions",
            payload,
            extra_headers=headers,
        )
        try:
            message = response["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as error:
            raise AgentError(
                "HERMES_AGENT_INVALID_RESPONSE", "Hermes Router returned an invalid agent response."
            ) from error
        if not isinstance(message, dict):
            raise AgentError(
                "HERMES_AGENT_INVALID_RESPONSE", "Hermes Router returned an invalid agent response."
            )
        return message

