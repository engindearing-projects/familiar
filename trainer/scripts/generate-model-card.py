#!/usr/bin/env python3
"""Generate a HuggingFace model card (README.md) from training metadata.

Reads training-meta.json and domain config to produce a complete model card
with usage examples for Ollama, llama.cpp, and the hosted API.

Usage:
    python3 scripts/generate-model-card.py v33
    python3 scripts/generate-model-card.py v33 --output /tmp/README.md
"""

import json
import sys
import os
from pathlib import Path
from datetime import datetime

TRAINER_DIR = Path(__file__).resolve().parent.parent
DOMAINS_DIR = TRAINER_DIR / "domains"


def load_training_meta(version: str) -> dict:
    """Load training-meta.json for the given version."""
    meta_path = TRAINER_DIR / "models" / "adapters" / version / "training-meta.json"
    if not meta_path.exists():
        # Try domain-prefixed path
        meta_path = TRAINER_DIR / "models" / "adapters" / "brain" / version / "training-meta.json"
    if not meta_path.exists():
        print(f"WARNING: training-meta.json not found for {version}, using defaults")
        return {}
    with open(meta_path) as f:
        return json.load(f)


def load_domain_config(domain_id: str = "brain") -> dict:
    """Load domain config JSON."""
    config_path = DOMAINS_DIR / f"{domain_id}.json"
    if not config_path.exists():
        return {}
    with open(config_path) as f:
        return json.load(f)


def format_duration(seconds: float) -> str:
    """Format seconds into human-readable duration."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    if hours > 0:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def generate_card(version: str, meta: dict, domain: dict) -> str:
    """Generate the model card markdown."""
    base_model = meta.get("base_model", domain.get("base_model", "Unknown"))
    base_model_hf = domain.get("base_model_hf", "")
    model_prefix = domain.get("model_prefix", "familiar-brain")
    system_prompt = domain.get("deploy_system_prompt", domain.get("system_prompt", ""))

    # Clean up base model display name
    base_display = base_model.split("/")[-1]

    train_examples = meta.get("train_examples", "N/A")
    valid_examples = meta.get("valid_examples", "N/A")
    epochs = meta.get("epochs", "N/A")
    lr = meta.get("learning_rate", "N/A")
    lora_r = meta.get("lora_r", "N/A")
    lora_alpha = meta.get("lora_alpha", "N/A")
    max_seq = meta.get("max_seq_length", "N/A")
    batch_size = meta.get("effective_batch_size", meta.get("batch_size", "N/A"))
    train_loss = meta.get("train_loss", None)
    valid_loss = meta.get("valid_loss", None)
    gpu = meta.get("gpu", "N/A")
    platform = meta.get("platform", "N/A")
    duration = meta.get("duration_seconds", None)

    ollama = domain.get("ollama", {})
    temp = ollama.get("temperature", 0.6)
    top_p = ollama.get("top_p", 0.9)
    num_ctx = ollama.get("num_ctx", 8192)

    card = f"""---
language:
  - en
license: apache-2.0
tags:
  - familiar
  - gguf
  - code
  - assistant
  - fine-tuned
base_model: {base_model_hf or base_display}
model_type: transformer
quantized_by: llama.cpp
---

# Familiar Brain {version}

A fine-tuned coding and reasoning assistant from [familiar.run](https://familiar.run).

| Property | Value |
|----------|-------|
| Base model | {base_display} |
| Quantization | Q4_K_M (GGUF) |
| Parameters | ~22B |
| Training data | {train_examples} examples |
| Fine-tune method | QLoRA (PEFT) |

## What it does

Familiar Brain is a general-purpose coding assistant fine-tuned on real development workflows. It handles:

- Code generation and editing
- Tool use and function calling
- Step-by-step reasoning
- Concise technical conversation

## Quick start

### Ollama (easiest)

```bash
ollama pull familiar-run/familiar-brain
ollama run familiar-run/familiar-brain
```

### llama.cpp

```bash
# Download the GGUF from this repo, then:
./llama-server -m familiar-brain-{version}-Q4_K_M.gguf -c {num_ctx} --temp {temp} --top-p {top_p}
```

### Hosted API

```bash
curl https://api.familiar.run/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{{
    "model": "familiar-brain",
    "messages": [{{"role": "user", "content": "Write a function to merge two sorted arrays"}}]
  }}'
```

### OpenCode / OpenAI SDK

Point any OpenAI-compatible client at `https://api.familiar.run/v1`:

```json
{{
  "provider": {{
    "familiar": {{
      "npm": "@ai-sdk/openai-compatible",
      "options": {{ "baseURL": "https://api.familiar.run/v1" }},
      "models": {{
        "familiar-brain": {{
          "name": "Familiar Brain",
          "limit": {{ "context": {num_ctx}, "output": 4096 }}
        }}
      }}
    }}
  }}
}}
```

## System prompt

```
{system_prompt}
```

## Recommended parameters

| Parameter | Value |
|-----------|-------|
| Temperature | {temp} |
| Top P | {top_p} |
| Context window | {num_ctx} |

## Training details

| Detail | Value |
|--------|-------|
| GPU | {gpu} |
| Platform | {platform} |
| Epochs | {epochs} |
| Learning rate | {lr} |
| LoRA rank | {lora_r} |
| LoRA alpha | {lora_alpha} |
| Max sequence length | {max_seq} |
| Effective batch size | {batch_size} |"""

    if train_loss is not None:
        card += f"\n| Training loss | {train_loss:.4f} |"
    if valid_loss is not None:
        card += f"\n| Validation loss | {valid_loss:.4f} |"
    if duration is not None:
        card += f"\n| Training time | {format_duration(duration)} |"

    card += f"""

## Files

| File | Description |
|------|-------------|
| `familiar-brain-{version}-Q4_K_M.gguf` | Quantized model (Q4_K_M, ~12GB) |
| `README.md` | This model card |

## License

Apache 2.0
"""
    return card


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/generate-model-card.py <version> [--output <path>]")
        sys.exit(1)

    version = sys.argv[1]
    output_path = None

    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--output" and i + 1 < len(sys.argv):
            output_path = sys.argv[i + 1]
            i += 2
        else:
            i += 1

    meta = load_training_meta(version)
    domain = load_domain_config("brain")
    card = generate_card(version, meta, domain)

    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            f.write(card)
        print(f"Model card written to {output_path}")
    else:
        print(card)


if __name__ == "__main__":
    main()
