"""Minimal YAML writer for LoRA config — avoids pyyaml dependency."""

from pathlib import Path


def write(path, data):
    """Write a simple nested dict as YAML."""
    lines = []
    _dump(data, lines, indent=0)
    Path(path).write_text("\n".join(lines) + "\n")


def _dump(obj, lines, indent):
    prefix = "  " * indent
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, dict):
                lines.append(f"{prefix}{k}:")
                _dump(v, lines, indent + 1)
            else:
                lines.append(f"{prefix}{k}: {_format(v)}")
    elif isinstance(obj, list):
        for item in obj:
            lines.append(f"{prefix}- {_format(item)}")


def _format(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return str(v)
    if isinstance(v, int):
        return str(v)
    if v is None:
        return "null"
    return str(v)
