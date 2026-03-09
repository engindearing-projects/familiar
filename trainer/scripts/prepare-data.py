#!/usr/bin/env python3
"""
The Forge — Data Preparation
Reads raw JSONL pair files, filters, deduplicates, and splits into train/valid sets.
Outputs MLX chat format for LoRA training.

Now supports multi-model training via task_type classification.
Each domain config specifies which task_types it accepts.

Usage:
    python scripts/prepare-data.py [--min-pairs 10]
    python scripts/prepare-data.py --domain reasoning
    python scripts/prepare-data.py --domain tools --task-type tools
"""

import json
import hashlib
import os
import sys
import argparse
from pathlib import Path
from collections import defaultdict
from domain_config import get_active_domain, load_domain
from classify import classify_prompt, classify_pair, pair_matches_domain

TRAINER_DIR = Path(__file__).resolve().parent.parent
RAW_DIR = TRAINER_DIR / "data" / "raw"
TRACES_DIR = TRAINER_DIR / "data" / "traces"
OPEN_SOURCE_DIR = TRAINER_DIR / "data" / "open_source"

# Output paths are now domain-aware (set in main)
TRAIN_FILE = None
VALID_FILE = None

# Loaded from domain config in main()
DOMAIN = None
SYSTEM_PROMPT = None
MIN_RESPONSE_LENGTH = 50

# Hard filter patterns — Claude responses containing these are garbage for training
CLAUDE_REJECT_PATTERNS = [
    "permission",
    "Would you like me to proceed",
    "Would you like me to create",
    "I need your approval",
    "approve",
    "I'll create the following files",
    "Let me create",
    "I'll write",
    "permission_denials",
    "is_error",
    "tool_use_id",
]

# Minimum quality thresholds (coding-specific defaults, relaxed per domain)
MIN_CLAUDE_LENGTH = 500
MIN_CODE_BLOCKS = 1


def load_raw_pairs():
    """Load all raw JSONL pair files."""
    pairs = []
    if not RAW_DIR.exists():
        return pairs

    for f in sorted(RAW_DIR.glob("*.jsonl")):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    pair = json.loads(line)
                    pairs.append(pair)
                except json.JSONDecodeError:
                    continue
    return pairs


def load_self_iterate_traces():
    """Load successful self-iterate traces as training examples."""
    examples = []
    if not TRACES_DIR.exists():
        return examples

    for f in sorted(TRACES_DIR.glob("*-self-iterate.jsonl")):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    if not record.get("success"):
                        continue
                    trace = record.get("trace", [])
                    if len(trace) < 2:
                        continue

                    prompt = None
                    last_assistant = None
                    for msg in trace:
                        if msg["role"] == "user" and prompt is None:
                            prompt = msg["content"]
                        if msg["role"] == "assistant":
                            last_assistant = msg["content"]

                    if prompt and last_assistant and len(last_assistant) >= MIN_RESPONSE_LENGTH:
                        examples.append({
                            "type": "self_iterate",
                            "task_type": "coding",  # self-iterate traces are always coding
                            "prompt": prompt,
                            "gold_response": last_assistant,
                            "iterations": record.get("iterations", 1),
                            "task_id": record.get("task_id"),
                        })
                except json.JSONDecodeError:
                    continue
    return examples


def load_tool_traces():
    """Load tool-use traces from agent loop and Claude Code sessions."""
    examples = []
    if not TRACES_DIR.exists():
        return examples

    trace_files = sorted(TRACES_DIR.glob("*-tools.jsonl")) + sorted(TRACES_DIR.glob("*-agent.jsonl"))
    accepted_types = {"tool_use", "agent_loop"}

    for f in trace_files:
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    trace = record.get("trace", [])
                    if len(trace) < 2:
                        continue
                    meta = record.get("metadata", {})
                    if meta.get("type") not in accepted_types:
                        continue

                    prompt = record.get("prompt", "")
                    if len(prompt) < 20:
                        continue

                    full_response = ""
                    for msg in trace:
                        if msg["role"] == "assistant":
                            if msg.get("content"):
                                full_response += msg["content"] + "\n"
                            if msg.get("tool_calls"):
                                for tc in msg["tool_calls"]:
                                    fn = tc.get("function", {})
                                    full_response += f"\n[Tool: {fn.get('name')}({fn.get('arguments', '')})]\n"

                    if len(full_response) >= MIN_RESPONSE_LENGTH:
                        examples.append({
                            "type": "tool_trace",
                            "task_type": "tools",  # tool traces are always tools
                            "prompt": prompt,
                            "gold_response": full_response.strip(),
                            "tools_used": meta.get("tools_used", []),
                        })
                except json.JSONDecodeError:
                    continue
    return examples


def load_open_source_datasets():
    """Load pre-processed open-source dataset JSONL files."""
    examples = []
    if not OPEN_SOURCE_DIR.exists():
        return examples

    for f in sorted(OPEN_SOURCE_DIR.glob("*.jsonl")):
        with open(f) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                    prompt = record.get("prompt", "")
                    response = record.get("response", "")
                    if not prompt or not response:
                        continue
                    if len(response) < MIN_RESPONSE_LENGTH:
                        continue
                    examples.append({
                        "type": "open_source",
                        "task_type": record.get("task_type", "coding"),
                        "prompt": prompt,
                        "gold_response": response,
                        "source_dataset": record.get("source_dataset", f.stem),
                        "training_eligible": True,
                        "gold_source": "open_source",
                    })
                except json.JSONDecodeError:
                    continue
    return examples


def has_code_block(text):
    return "```" in text


def is_ground_truth(pair):
    return pair.get("type") == "ground_truth" and pair.get("ground_truth_diff")


def is_permission_garbage(text):
    if not text:
        return True
    text_lower = text.lower()
    hits = sum(1 for pat in CLAUDE_REJECT_PATTERNS if pat.lower() in text_lower)
    if hits >= 3:
        return True
    if text.strip().startswith('{"type":') or text.strip().startswith('{"result":'):
        return True
    return False


def count_code_blocks(text):
    return text.count("```") // 2


def filter_pair(pair, domain_id="coding", max_chars=24000):
    """Return True if pair should be kept for training.

    Filtering rules vary by domain:
    - coding: strict (require code blocks, 500 char min)
    - reasoning: relaxed (no code blocks required, 200 char min)
    - tools: moderate (tool calls expected, 100 char min)
    - chat: relaxed (short responses OK, 20 char min)

    max_chars caps total prompt+response length to prevent NaN from
    sequences that overflow the model's context window during training.
    24000 chars ≈ 6000 tokens — fits comfortably in 6144 max_seq.
    """
    prompt = pair.get("prompt", "")
    min_prompt_len = DOMAIN.get("data", {}).get("min_prompt_length", 20)

    if len(prompt) < min_prompt_len:
        return False

    # Cap total length to prevent NaN from oversized sequences
    claude = pair.get("claude_response", "") or pair.get("ground_truth_diff", "")
    total_len = len(prompt) + len(claude)
    if total_len > max_chars:
        return False

    # Ground-truth pairs: coding data (accepted by coding and brain domains)
    if is_ground_truth(pair):
        if domain_id != "coding" and domain_id != "brain":
            return False
        diff = pair.get("ground_truth_diff", "")
        if len(diff) < 100:
            return False
        if "+" not in diff and "-" not in diff:
            return False
        return True

    claude = pair.get("claude_response", "")
    local = pair.get("local_response", "")

    # Tool trace pairs from collector: accept if they have tool_calls (no local response needed)
    if pair.get("type") == "tool_trace" and pair.get("tool_calls"):
        if len(pair.get("tool_calls", [])) == 0:
            return False
        return len(pair.get("prompt", "")) >= min_prompt_len

    # Both responses must exist (for distillation pairs)
    if not claude or not local:
        return False

    # Universal: reject permission-asking garbage
    if is_permission_garbage(claude):
        return False

    # Reject raw tool/error output
    if '"is_error":true' in claude or '"stop_reason":null' in claude:
        return False

    # Domain-specific quality thresholds
    if domain_id == "brain":
        # Unified brain: use the threshold matching the pair's task type
        task_type = pair.get("task_type", "coding")
        if task_type == "coding" and len(claude) < 500:
            return False
        elif task_type == "coding" and not has_code_block(claude):
            return False
        elif task_type == "reasoning" and len(claude) < 200:
            return False
        elif task_type == "tools" and len(claude) < 100:
            return False
        elif task_type == "chat" and len(claude) < 20:
            return False
    elif domain_id == "coding":
        if len(claude) < 500:
            return False
        if not has_code_block(claude):
            return False
        if count_code_blocks(claude) < 1:
            return False
    elif domain_id == "reasoning":
        if len(claude) < 200:
            return False
    elif domain_id == "tools":
        if len(claude) < 100:
            return False
    elif domain_id == "chat":
        if len(claude) < 20:
            return False
    else:
        # Unknown domain — use coding defaults
        if len(claude) < 500:
            return False

    return True


def prompt_hash(prompt):
    normalized = prompt.strip().lower()
    return hashlib.sha256(normalized.encode()).hexdigest()[:16]


def format_tool_calls_as_response(pair):
    """Format structured tool calls into a training response showing tool-use planning."""
    tool_calls = pair.get("tool_calls", [])
    if not tool_calls:
        return pair.get("claude_response", "")

    parts = []
    for tc in tool_calls:
        name = tc.get("name", "unknown")
        args = tc.get("arguments", {})
        result = tc.get("result", "")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except (json.JSONDecodeError, TypeError):
                pass
        args_str = json.dumps(args, indent=2) if isinstance(args, dict) else str(args)
        parts.append(f"[Tool: {name}]\nArguments: {args_str}")
        if result:
            # Truncate long results for training
            result_preview = result[:1000] + ("..." if len(result) > 1000 else "")
            parts.append(f"Result: {result_preview}")

    # Include final text response if present
    final_text = pair.get("claude_response", "")
    if final_text:
        parts.append(f"\n{final_text}")

    return "\n\n".join(parts)


def to_chat_format(pair):
    """Convert a pair to MLX chat training format.

    Only accepts gold from clean sources: ground_truth_diff, self_iterate,
    tool_trace (local model traces), and open_source datasets.
    Returns None for pairs that would use proprietary model output as gold.
    """
    pair_type = pair.get("type")

    if pair_type == "open_source":
        gold = pair["gold_response"]
    elif pair_type == "self_iterate":
        gold = pair["gold_response"]
    elif pair_type == "tool_trace":
        # Structured tool calls from collector — format with tool call sequence
        if pair.get("tool_calls"):
            gold = format_tool_calls_as_response(pair)
        else:
            gold = pair.get("gold_response")
            if not gold:
                return None  # No clean gold source available
    elif is_ground_truth(pair):
        diff = pair["ground_truth_diff"]
        gold = f"Here are the code changes:\n\n```diff\n{diff}\n```"
    else:
        # No clean gold source — skip this pair entirely.
        # Previously used claude_response as fallback which violates TOS.
        return None

    if not gold:
        return None

    return {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": pair["prompt"]},
            {"role": "assistant", "content": gold},
        ]
    }


def main():
    global DOMAIN, SYSTEM_PROMPT, MIN_RESPONSE_LENGTH, TRAIN_FILE, VALID_FILE

    parser = argparse.ArgumentParser(description="Prepare training data from raw pairs")
    parser.add_argument("--min-pairs", type=int, default=10,
                        help="Minimum pairs needed to proceed (default: 10)")
    parser.add_argument("--split-ratio", type=float, default=0.9,
                        help="Train/valid split ratio (default: 0.9)")
    parser.add_argument("--domain", type=str, default=None,
                        help="Domain to use (default: active domain)")
    parser.add_argument("--task-type", type=str, default=None,
                        help="Override: only include this task type (coding/reasoning/tools/chat)")
    args = parser.parse_args()

    # Load domain config
    if args.domain:
        DOMAIN = load_domain(args.domain)
    else:
        DOMAIN = get_active_domain()
    SYSTEM_PROMPT = DOMAIN["system_prompt"]
    MIN_RESPONSE_LENGTH = DOMAIN.get("data", {}).get("min_response_length", 50)
    domain_id = DOMAIN["id"]

    # Domain-specific output paths
    data_dir = TRAINER_DIR / "data"
    if domain_id == "coding":
        # Backward compat: coding uses the root data/ dir
        TRAIN_FILE = data_dir / "train.jsonl"
        VALID_FILE = data_dir / "valid.jsonl"
    else:
        domain_dir = data_dir / domain_id
        domain_dir.mkdir(parents=True, exist_ok=True)
        TRAIN_FILE = domain_dir / "train.jsonl"
        VALID_FILE = domain_dir / "valid.jsonl"

    # Determine which task types this domain accepts
    accepted_types = set(DOMAIN.get("task_types", [domain_id]))
    if args.task_type:
        accepted_types = {args.task_type}

    print(f"Domain: {DOMAIN['name']} ({domain_id})")
    print(f"Accepted task types: {', '.join(sorted(accepted_types))}")
    print(f"Loading raw pairs from {RAW_DIR}...")
    pairs = load_raw_pairs()
    print(f"  Loaded {len(pairs)} raw pairs")

    # Filter out training-ineligible pairs (Claude/Gemini distillation)
    eligible_pairs = [p for p in pairs if p.get("training_eligible", True) is not False]
    ineligible_count = len(pairs) - len(eligible_pairs)
    if ineligible_count > 0:
        print(f"  Excluded {ineligible_count} training-ineligible pairs (proprietary model gold)")

    # Load self-iterate traces
    si_traces = load_self_iterate_traces()
    print(f"  Loaded {len(si_traces)} self-iterate traces (successful)")

    # Load tool-use traces
    tool_traces = load_tool_traces()
    print(f"  Loaded {len(tool_traces)} tool-use traces")

    # Load open-source datasets
    os_data = load_open_source_datasets()
    print(f"  Loaded {len(os_data)} open-source dataset examples")

    # Merge all sources
    all_data = eligible_pairs + si_traces + tool_traces + os_data

    if len(all_data) == 0:
        print("No data found. Collect more data first.")
        sys.exit(1)

    # Classify untagged pairs
    classified_counts = defaultdict(int)
    for p in all_data:
        if not p.get("task_type"):
            classify_pair(p)
        classified_counts[p.get("task_type", "unknown")] += 1

    print(f"\n  Classification distribution (all data):")
    for tt, count in sorted(classified_counts.items(), key=lambda x: -x[1]):
        print(f"    {tt}: {count}")

    # Filter by task type for this domain
    type_filtered = [p for p in all_data if pair_matches_domain(p, domain_id)]
    type_rejected = len(all_data) - len(type_filtered)
    print(f"\n  After task_type filter: {len(type_filtered)} examples ({type_rejected} excluded for other domains)")

    # Quality filter (domain-aware)
    filtered = []
    rejected_reasons = defaultdict(int)
    for p in type_filtered:
        if p.get("type") in ("self_iterate", "tool_trace"):
            filtered.append(p)
        elif filter_pair(p, domain_id):
            filtered.append(p)
        else:
            claude = p.get("claude_response", "")
            if is_ground_truth(p):
                rejected_reasons["gt_too_short"] += 1
            elif not claude or not p.get("local_response", ""):
                rejected_reasons["missing_response"] += 1
            elif is_permission_garbage(claude):
                rejected_reasons["permission_garbage"] += 1
            elif domain_id == "coding" and len(claude) < 500:
                rejected_reasons["too_short"] += 1
            elif domain_id == "coding" and not has_code_block(claude):
                rejected_reasons["no_code_blocks"] += 1
            else:
                rejected_reasons["other"] += 1

    rejected_total = len(type_filtered) - len(filtered)
    print(f"  After quality filter: {len(filtered)} examples ({rejected_total} rejected)")
    if rejected_reasons:
        print(f"  Rejection breakdown:")
        for reason, count in sorted(rejected_reasons.items(), key=lambda x: -x[1]):
            print(f"    {reason}: {count}")

    # Deduplicate by prompt hash
    seen = set()
    deduped = []
    for p in filtered:
        h = prompt_hash(p["prompt"])
        if h not in seen:
            seen.add(h)
            deduped.append(p)
    print(f"  After dedup: {len(deduped)} unique examples")

    if len(deduped) < args.min_pairs:
        print(f"Not enough pairs ({len(deduped)} < {args.min_pairs}). Collect more data.")
        sys.exit(1)

    # Convert to chat format (filter out None — pairs with no clean gold source)
    examples = [ex for ex in (to_chat_format(p) for p in deduped) if ex is not None]
    skipped_no_gold = len(deduped) - len(examples)
    if skipped_no_gold > 0:
        print(f"  Skipped {skipped_no_gold} pairs with no clean gold source")

    # Shuffle deterministically
    import random
    random.seed(42)
    random.shuffle(examples)

    # Split
    split_idx = int(len(examples) * args.split_ratio)
    train = examples[:split_idx]
    valid = examples[split_idx:]

    if len(valid) == 0 and len(train) > 1:
        valid = [train.pop()]

    # Write output
    TRAIN_FILE.parent.mkdir(parents=True, exist_ok=True)

    with open(TRAIN_FILE, "w") as f:
        for ex in train:
            f.write(json.dumps(ex) + "\n")

    with open(VALID_FILE, "w") as f:
        for ex in valid:
            f.write(json.dumps(ex) + "\n")

    # MLX-LM expects test.jsonl to exist
    test_file = TRAIN_FILE.parent / "test.jsonl"
    if not test_file.exists() or test_file.stat().st_size == 0:
        test = valid[:min(5, len(valid))]
        with open(test_file, "w") as f:
            for ex in test:
                f.write(json.dumps(ex) + "\n")

    print(f"\nOutput ({domain_id}):")
    print(f"  Train: {len(train)} examples → {TRAIN_FILE}")
    print(f"  Valid: {len(valid)} examples → {VALID_FILE}")
    print(f"  Test:  {min(5, len(valid))} examples → {test_file}")
    print("Done.")


if __name__ == "__main__":
    main()
