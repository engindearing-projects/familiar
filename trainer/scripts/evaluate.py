#!/usr/bin/env python3
"""
The Forge — Model Evaluation
Runs benchmark tasks against the current familiar-coder model via Ollama API.
Scores: syntax validity (25pts), test passing (40pts), similarity to gold (20pts), completeness (15pts).

Usage:
    python scripts/evaluate.py [--model familiar-coder:latest] [--version v1]
"""

import json
import os
import re
import sys
import time
import argparse
import subprocess
from pathlib import Path
from difflib import SequenceMatcher
from domain_config import get_active_domain, load_domain

TRAINER_DIR = Path(__file__).resolve().parent.parent
RESULTS_DIR = TRAINER_DIR / "benchmarks" / "results"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")

# Set from domain config in main()
DOMAIN = None
BENCHMARK_FILE = None


def load_benchmark():
    """Load benchmark tasks from JSONL file."""
    tasks = []
    if not BENCHMARK_FILE.exists():
        print(f"Benchmark file not found: {BENCHMARK_FILE}")
        return tasks

    with open(BENCHMARK_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                tasks.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return tasks


def call_ollama(prompt, model):
    """Send a prompt to Ollama and get the response."""
    import urllib.request

    system_prompt = DOMAIN["system_prompt"] if DOMAIN else "You are a helpful assistant."
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
    }).encode()

    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
            return data.get("message", {}).get("content", "")
    except Exception as e:
        return f"ERROR: {e}"


def extract_code_blocks(text):
    """Extract code blocks from markdown text."""
    pattern = r"```(?:\w+)?\n(.*?)```"
    blocks = re.findall(pattern, text, re.DOTALL)
    return blocks


def score_structure(response, task):
    """Score structure/format validity (0-max_weight points).
    For coding domains: checks code syntax.
    For other domains: checks document structure and keyword presence."""
    max_weight = DOMAIN["eval"]["scoring"]["structure"]["weight"] if DOMAIN else 25
    has_tests = DOMAIN.get("eval", {}).get("has_executable_tests", True) if DOMAIN else True

    if has_tests:
        # Coding domain — check code blocks and syntax
        blocks = extract_code_blocks(response)
        if not blocks:
            return int(max_weight * 0.2) if any(kw in response.lower() for kw in ["def ", "function ", "class ", "const ", "let "]) else 0

        lang = task.get("language", "python").lower()
        score = int(max_weight * 0.6)  # has code blocks

        code = "\n".join(blocks)
        if lang == "python":
            if "def " in code or "class " in code:
                score += int(max_weight * 0.2)
            if "return " in code or "print(" in code:
                score += int(max_weight * 0.2)
        elif lang in ("javascript", "typescript"):
            if "function " in code or "=>" in code or "const " in code:
                score += int(max_weight * 0.2)
            if "return " in code:
                score += int(max_weight * 0.2)
        else:
            if len(code.strip()) > 20:
                score += int(max_weight * 0.4)

        return min(score, max_weight)
    else:
        # Non-coding domain — check structure and keywords
        score = 0
        keywords = DOMAIN.get("eval", {}).get("keyword_checks", [])

        # Length and structure
        if len(response) > 500:
            score += int(max_weight * 0.3)
        elif len(response) > 200:
            score += int(max_weight * 0.2)

        # Has sections/headers
        if any(marker in response for marker in ["##", "**", "\n\n", "1.", "- "]):
            score += int(max_weight * 0.3)

        # Domain keywords present
        if keywords:
            found = sum(1 for kw in keywords if kw.lower() in response.lower())
            keyword_ratio = found / len(keywords) if keywords else 0
            score += int(max_weight * 0.4 * keyword_ratio)

        return min(score, max_weight)


def score_correctness(response, task):
    """Score correctness (0-max_weight points).
    For coding: runs test cases.
    For non-coding: scores based on requirements coverage and response quality."""
    max_weight = DOMAIN["eval"]["scoring"]["correctness"]["weight"] if DOMAIN else 40
    has_tests = DOMAIN.get("eval", {}).get("has_executable_tests", True) if DOMAIN else True

    if has_tests:
        # Coding domain — run test cases
        test_cases = task.get("test_cases", [])
        if not test_cases:
            blocks = extract_code_blocks(response)
            if blocks and len("\n".join(blocks)) > 50:
                return int(max_weight * 0.625)
            return int(max_weight * 0.25)

        blocks = extract_code_blocks(response)
        if not blocks:
            return 0

        code = "\n".join(blocks)
        passed = 0
        total = len(test_cases)

        for tc in test_cases:
            test_code = tc.get("code", "")
            expected = tc.get("expected", "")
            if not test_code:
                continue

            full_code = code + "\n" + test_code
            try:
                result = subprocess.run(
                    [sys.executable, "-c", full_code],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                if result.returncode == 0:
                    output = result.stdout.strip()
                    if expected and output == str(expected).strip():
                        passed += 1
                    elif not expected and result.returncode == 0:
                        passed += 1
            except (subprocess.TimeoutExpired, Exception):
                continue

        if total == 0:
            return int(max_weight * 0.625)
        return int((passed / total) * max_weight)
    else:
        # Non-coding domain — score based on response quality
        score = 0
        requirements = task.get("requirements", [])

        # Response addresses the prompt
        if len(response) > 300:
            score += int(max_weight * 0.4)
        elif len(response) > 100:
            score += int(max_weight * 0.2)

        # Requirements coverage
        if requirements:
            met = sum(1 for req in requirements if req.lower() in response.lower())
            ratio = met / len(requirements) if requirements else 0
            score += int(max_weight * 0.6 * ratio)
        else:
            score += int(max_weight * 0.3)

        return min(score, max_weight)


def score_similarity(response, task):
    """Score similarity to gold answer (0-20 points)."""
    gold = task.get("gold_answer", "")
    if not gold:
        return 10  # no gold to compare

    # Compare code blocks
    response_blocks = extract_code_blocks(response)
    gold_blocks = extract_code_blocks(gold)

    if not response_blocks:
        return 0

    response_code = "\n".join(response_blocks).strip()
    gold_code = "\n".join(gold_blocks).strip() if gold_blocks else gold.strip()

    ratio = SequenceMatcher(None, response_code, gold_code).ratio()
    return int(ratio * 20)


def score_completeness(response, task):
    """Score completeness (0-15 points)."""
    requirements = task.get("requirements", [])
    if not requirements:
        # Basic completeness check
        if len(response) > 200 and extract_code_blocks(response):
            return 12
        elif len(response) > 100:
            return 8
        return 5

    met = 0
    for req in requirements:
        if req.lower() in response.lower():
            met += 1

    if len(requirements) == 0:
        return 10
    return int((met / len(requirements)) * 15)


def evaluate_task(task, model):
    """Evaluate a single benchmark task."""
    prompt = task["prompt"]
    start = time.time()
    response = call_ollama(prompt, model)
    duration = time.time() - start

    structure = score_structure(response, task)
    correctness = score_correctness(response, task)
    similarity = score_similarity(response, task)
    completeness = score_completeness(response, task)
    total = structure + correctness + similarity + completeness

    return {
        "task_id": task.get("id", "unknown"),
        "category": task.get("category", "general"),
        "total_score": total,
        "structure_score": structure,
        "correctness_score": correctness,
        "similarity_score": similarity,
        "completeness_score": completeness,
        "duration_seconds": round(duration, 2),
        "response_length": len(response),
        "has_code": bool(extract_code_blocks(response)),
    }


def main():
    global DOMAIN, BENCHMARK_FILE

    parser = argparse.ArgumentParser(description="Evaluate model against benchmark")
    parser.add_argument("--model", default=None, help="Ollama model to evaluate (default: from domain config)")
    parser.add_argument("--version", default=None, help="Version label (e.g. v1)")
    parser.add_argument("--domain", default=None, help="Domain to evaluate (default: active domain)")
    args = parser.parse_args()

    # Load domain config
    if args.domain:
        DOMAIN = load_domain(args.domain)
    else:
        DOMAIN = get_active_domain()

    # Set benchmark file based on domain
    BENCHMARK_FILE = TRAINER_DIR / "benchmarks" / f"{DOMAIN['id']}-tasks.jsonl"
    if not BENCHMARK_FILE.exists():
        # Fall back to coding-tasks.jsonl for backward compat
        BENCHMARK_FILE = TRAINER_DIR / "benchmarks" / "coding-tasks.jsonl"

    # Default model from domain config
    model = args.model or f"{DOMAIN['model_prefix']}:latest"

    tasks = load_benchmark()
    if not tasks:
        print(f"No benchmark tasks found. Create benchmarks/{DOMAIN['id']}-tasks.jsonl first.")
        sys.exit(1)

    print(f"=== The Forge — Evaluation ===")
    print(f"  Domain: {DOMAIN['name']} ({DOMAIN['id']})")
    print(f"  Model:  {model}")
    print(f"  Tasks:  {len(tasks)}")
    print()

    results = []
    for i, task in enumerate(tasks):
        print(f"  [{i+1}/{len(tasks)}] {task.get('id', 'task')}...", end=" ", flush=True)
        result = evaluate_task(task, model)
        results.append(result)
        print(f"{result['total_score']}/100 ({result['duration_seconds']}s)")

    # Aggregate scores
    total_tasks = len(results)
    avg_total = sum(r["total_score"] for r in results) / total_tasks if total_tasks else 0
    avg_structure = sum(r["structure_score"] for r in results) / total_tasks if total_tasks else 0
    avg_correctness = sum(r["correctness_score"] for r in results) / total_tasks if total_tasks else 0
    avg_similarity = sum(r["similarity_score"] for r in results) / total_tasks if total_tasks else 0
    avg_completeness = sum(r["completeness_score"] for r in results) / total_tasks if total_tasks else 0

    # Category breakdown
    categories = {}
    for r in results:
        cat = r["category"]
        if cat not in categories:
            categories[cat] = []
        categories[cat].append(r["total_score"])

    scoring = DOMAIN["eval"]["scoring"] if DOMAIN else {}
    struct_max = scoring.get("structure", {}).get("weight", 25)
    correct_max = scoring.get("correctness", {}).get("weight", 40)
    sim_max = scoring.get("similarity", {}).get("weight", 20)
    comp_max = scoring.get("completeness", {}).get("weight", 15)

    print(f"\n=== Results ===")
    print(f"  Overall score:    {avg_total:.1f}/100")
    print(f"  Structure:        {avg_structure:.1f}/{struct_max}")
    print(f"  Correctness:      {avg_correctness:.1f}/{correct_max}")
    print(f"  Similarity:       {avg_similarity:.1f}/{sim_max}")
    print(f"  Completeness:     {avg_completeness:.1f}/{comp_max}")
    print(f"\n  By category:")
    for cat, scores in sorted(categories.items()):
        avg = sum(scores) / len(scores)
        print(f"    {cat}: {avg:.1f}/100 ({len(scores)} tasks)")

    # Save results
    version = args.version or "latest"
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    result_file = RESULTS_DIR / f"{version}-{int(time.time())}.json"
    result_data = {
        "version": version,
        "model": model,
        "domain": DOMAIN["id"] if DOMAIN else "coding",
        "evaluated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tasks_evaluated": total_tasks,
        "overall_score": round(avg_total, 2),
        "structure_score": round(avg_structure, 2),
        "correctness_score": round(avg_correctness, 2),
        "similarity_score": round(avg_similarity, 2),
        "completeness_score": round(avg_completeness, 2),
        "categories": {cat: round(sum(s) / len(s), 2) for cat, s in categories.items()},
        "results": results,
    }
    result_file.write_text(json.dumps(result_data, indent=2))
    print(f"\n  Results saved to {result_file}")

    # Record in forge DB
    try:
        js = f"""
        import {{ recordEvaluation, updateVersion }} from "{TRAINER_DIR}/forge-db.js";
        try {{
          recordEvaluation({{
            version: "{version}",
            overallScore: {round(avg_total, 2)},
            syntaxScore: {round(avg_structure, 2)},
            testScore: {round(avg_correctness, 2)},
            similarityScore: {round(avg_similarity, 2)},
            completenessScore: {round(avg_completeness, 2)},
            tasksEvaluated: {total_tasks},
          }});
          updateVersion("{version}", {{
            benchmarkScore: {round(avg_total, 2)},
            benchmarkDetails: JSON.stringify({json.dumps({cat: round(sum(s)/len(s), 2) for cat, s in categories.items()})}),
          }});
        }} catch(e) {{ console.error(e.message); }}
        """
        subprocess.run(["bun", "-e", js], capture_output=True, timeout=10)
    except Exception:
        pass

    # Check for regression
    if args.version and args.version != "latest":
        try:
            prev_results = sorted(RESULTS_DIR.glob("*.json"))
            if len(prev_results) > 1:
                prev_data = json.loads(prev_results[-2].read_text())
                prev_score = prev_data.get("overall_score", 0)
                delta = avg_total - prev_score
                if delta < -5:
                    print(f"\n  WARNING: Regression detected! Score dropped {abs(delta):.1f} points vs previous.")
                    print(f"  Previous: {prev_score:.1f}, Current: {avg_total:.1f}")
                    print(f"  Consider rolling back: engie forge rollback")
                elif delta > 0:
                    print(f"\n  Improvement: +{delta:.1f} points vs previous ({prev_score:.1f})")
        except Exception:
            pass


if __name__ == "__main__":
    main()
