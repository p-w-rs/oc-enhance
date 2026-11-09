import json
import subprocess

import pytest

from open_enhance.document_worker import MAX_INPUT, extract_isolated, parser_environment
from open_enhance.runtime import pixi_python


def test_document_sandbox_denies_writes_network_source_reads_and_processes(tmp_path):
    source = tmp_path / "private.md"
    source.write_text("unrelated private source")
    target = tmp_path / "must-not-exist"
    code = f'''
import json, socket, subprocess
from open_enhance.document_worker import constrain_parser
constrain_parser()
outcomes = {{}}
for name, operation in [
    ("read", lambda: open({str(source)!r}).read()),
    ("write", lambda: open({str(target)!r}, "w").write("bad")),
    ("network", lambda: socket.create_connection(("127.0.0.1", 9), timeout=1)),
    ("process", lambda: subprocess.run(["/bin/echo", "bad"], check=True)),
]:
    try:
        operation()
        outcomes[name] = "allowed"
    except OSError:
        outcomes[name] = "denied"
print(json.dumps(outcomes))
'''
    result = subprocess.run(pixi_python("-c", code), capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {name: "denied" for name in ["read", "write", "network", "process"]}
    assert not target.exists()


def test_document_input_budget_precedes_process_launch():
    with pytest.raises(ValueError, match="input budget"):
        extract_isolated(b"x" * (MAX_INPUT + 1), ".pdf")


def test_parser_does_not_inherit_cli_credentials_or_loader_injection(monkeypatch):
    for key in ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HF_TOKEN", "OPENCODE_CONFIG_CONTENT", "PYTHONPATH", "DYLD_INSERT_LIBRARIES"]:
        monkeypatch.setenv(key, "synthetic-secret")
    environment = parser_environment()
    assert "synthetic-secret" not in environment.values()
    assert environment["PYTHONNOUSERSITE"] == "1"
