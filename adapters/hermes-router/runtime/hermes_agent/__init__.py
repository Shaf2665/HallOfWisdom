"""Hall-owned coding runtime that uses Hermes Router for inference."""

PROTOCOL_VERSION = "hermes-agent/v1"
RUNTIME_VERSION = "0.1.0"

CAPABILITIES = (
    "project.read",
    "project.edit",
    "command.execute",
    "structured.events",
    "cancellation",
)

