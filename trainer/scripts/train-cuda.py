#!/usr/bin/env python3
"""
The Forge — CUDA/PyTorch LoRA Training
QLoRA fine-tuning using PEFT + bitsandbytes for NVIDIA GPUs.
Equivalent to train.py (MLX) but for Linux/CUDA machines.

Usage:
    python scripts/train-cuda.py [--epochs 3] [--batch-size 2] [--lr 2e-5]
    python scripts/train-cuda.py --domain healthcare
"""

import json
import os
import sys
import time
import argparse
from pathlib import Path

TRAINER_DIR = Path(__file__).resolve().parent.parent
ADAPTERS_DIR = TRAINER_DIR / "models" / "adapters"
DATA_DIR = TRAINER_DIR / "data"
TRAIN_FILE = DATA_DIR / "train.jsonl"
VALID_FILE = DATA_DIR / "valid.jsonl"

# CUDA base model — full precision (not MLX 4-bit)
DEFAULT_BASE_MODEL = "Qwen/Qwen3-Coder-30B-A3B-Instruct"


def get_next_version():
    """Determine next version number from existing adapters."""
    if not ADAPTERS_DIR.exists():
        ADAPTERS_DIR.mkdir(parents=True)
        return 1
    versions = []
    for d in ADAPTERS_DIR.iterdir():
        if d.is_dir() and d.name.startswith("v"):
            try:
                versions.append(int(d.name[1:]))
            except ValueError:
                continue
    return max(versions, default=0) + 1


def load_jsonl(path):
    """Load JSONL file as list of dicts."""
    data = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                data.append(json.loads(line))
    return data


def main():
    parser = argparse.ArgumentParser(description="QLoRA training on NVIDIA GPU")
    parser.add_argument("--epochs", type=int, default=3, help="Training epochs (default: 3)")
    parser.add_argument("--batch-size", type=int, default=2, help="Batch size per device (default: 2)")
    parser.add_argument("--lr", type=float, default=2e-5, help="Learning rate (default: 2e-5)")
    parser.add_argument("--lora-r", type=int, default=16, help="LoRA rank (default: 16)")
    parser.add_argument("--lora-alpha", type=int, default=32, help="LoRA alpha (default: 32)")
    parser.add_argument("--max-seq-length", type=int, default=2048, help="Max sequence length (default: 2048)")
    parser.add_argument("--base-model", default=None, help="HuggingFace model ID or local path")
    parser.add_argument("--version", type=int, default=None, help="Override version number")
    parser.add_argument("--domain", default=None, help="Domain (default: active domain)")
    parser.add_argument("--gradient-accumulation", type=int, default=4, help="Gradient accumulation steps (default: 4)")
    args = parser.parse_args()

    # Imports (after arg parsing for fast --help)
    import torch
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
    )
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from trl import SFTTrainer, SFTConfig
    from datasets import Dataset

    # Load domain config
    domain = None
    try:
        sys.path.insert(0, str(TRAINER_DIR / "scripts"))
        from domain_config import get_active_domain, load_domain
        domain = load_domain(args.domain) if args.domain else get_active_domain()
    except Exception:
        pass

    # Determine base model — check domain config, then local paths, then default
    base_model_id = args.base_model or DEFAULT_BASE_MODEL
    if not args.base_model:
        # Check domain config for base_model_hf
        if domain and domain.get("base_model_hf"):
            base_model_id = domain["base_model_hf"]
        # Check local paths (home dir and media drives)
        base_name = domain.get("base_model", "Qwen3-Coder-30B-A3B-Instruct") if domain else "Qwen3-Coder-30B-A3B-Instruct"
        local_paths = [
            TRAINER_DIR / "models" / "base" / base_name,
            Path("/media") if Path("/media").exists() else None,
        ]
        for lp in local_paths:
            if lp and lp.exists():
                if lp == Path("/media"):
                    # Search media drives for the model
                    import glob
                    found = glob.glob(f"/media/*/engie/trainer/models/base/{base_name}/config.json") + \
                            glob.glob(f"/media/*/*/engie/trainer/models/base/{base_name}/config.json")
                    if found:
                        base_model_id = str(Path(found[0]).parent)
                        break
                elif (lp / "config.json").exists():
                    base_model_id = str(lp)
                    break

    # Check prerequisites
    if not torch.cuda.is_available():
        print("ERROR: CUDA not available. This script requires an NVIDIA GPU.")
        print("Use train.py for Apple Silicon (MLX) training instead.")
        sys.exit(1)

    gpu_name = torch.cuda.get_device_name(0)
    gpu_mem = torch.cuda.get_device_properties(0).total_memory / 1e9

    if not TRAIN_FILE.exists():
        print(f"Training data not found at {TRAIN_FILE}")
        print("Run prepare-data.py first.")
        sys.exit(1)

    # Load data
    train_data = load_jsonl(TRAIN_FILE)
    valid_data = load_jsonl(VALID_FILE) if VALID_FILE.exists() else []

    version = args.version or get_next_version()
    adapter_path = ADAPTERS_DIR / f"v{version}"
    adapter_path.mkdir(parents=True, exist_ok=True)

    domain_name = domain["name"] if domain else "coding"
    print(f"=== The Forge — CUDA Training v{version} ===")
    print(f"  Domain:       {domain_name}")
    print(f"  GPU:          {gpu_name} ({gpu_mem:.1f}GB)")
    print(f"  Base model:   {base_model_id}")
    print(f"  Train data:   {len(train_data)} examples")
    print(f"  Valid data:   {len(valid_data)} examples")
    print(f"  Epochs:       {args.epochs}")
    print(f"  Batch size:   {args.batch_size} (x{args.gradient_accumulation} accum = {args.batch_size * args.gradient_accumulation} effective)")
    print(f"  Learning rate: {args.lr}")
    print(f"  LoRA rank:    {args.lora_r}")
    print(f"  Max seq len:  {args.max_seq_length}")
    print(f"  Adapter path: {adapter_path}")

    # QLoRA quantization config (4-bit)
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )

    print(f"\nLoading base model in 4-bit...")
    model = AutoModelForCausalLM.from_pretrained(
        base_model_id,
        quantization_config=bnb_config,
        device_map={"": 0},
        trust_remote_code=True,
    )
    model = prepare_model_for_kbit_training(model)

    tokenizer = AutoTokenizer.from_pretrained(base_model_id, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # LoRA config — detect MoE and target attention + shared layers (not expert FFN)
    is_moe = hasattr(model, "config") and getattr(model.config, "num_experts", 0) > 0
    if not is_moe:
        # Check model name for MoE indicators
        model_name_lower = base_model_id.lower()
        is_moe = any(tag in model_name_lower for tag in ["-a3b", "-a22b", "-a35b", "moe"])

    if is_moe:
        # MoE: target attention layers only — expert FFN layers are too many and sparse
        target_modules = ["q_proj", "k_proj", "v_proj", "o_proj"]
        print(f"  MoE detected — targeting attention layers only")
    else:
        target_modules = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]

    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        target_modules=target_modules,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    print(f"  Trainable params: {trainable:,} / {total:,} ({100 * trainable / total:.2f}%)")

    # Format data for SFTTrainer
    def format_example(ex):
        """Convert JSONL messages format to chat template string."""
        messages = ex.get("messages", [])
        if not messages:
            return {"text": ""}
        return {"text": tokenizer.apply_chat_template(messages, tokenize=False)}

    train_dataset = Dataset.from_list(train_data).map(format_example)
    valid_dataset = Dataset.from_list(valid_data).map(format_example) if valid_data else None

    # Training arguments (SFTConfig extends TrainingArguments with max_seq_length)
    output_dir = str(adapter_path)
    sft_config = SFTConfig(
        output_dir=output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.gradient_accumulation,
        learning_rate=args.lr,
        weight_decay=0.01,
        warmup_ratio=0.03,
        lr_scheduler_type="cosine",
        logging_steps=10,
        eval_strategy="steps" if valid_dataset else "no",
        eval_steps=50 if valid_dataset else None,
        save_strategy="steps",
        save_steps=100,
        save_total_limit=2,
        bf16=True,
        max_grad_norm=0.3,
        optim="paged_adamw_8bit",
        report_to="none",
        max_length=args.max_seq_length,
    )

    # Train
    trainer = SFTTrainer(
        model=model,
        args=sft_config,
        train_dataset=train_dataset,
        eval_dataset=valid_dataset,
        processing_class=tokenizer,
    )

    print(f"\nStarting training...")
    start = time.time()

    try:
        result = trainer.train()
        duration = time.time() - start
        train_loss = result.training_loss
        print(f"\nTraining completed in {duration:.1f}s")
        print(f"  Final train loss: {train_loss:.4f}")

        # Evaluate
        valid_loss = None
        if valid_dataset:
            eval_result = trainer.evaluate()
            valid_loss = eval_result.get("eval_loss")
            print(f"  Validation loss: {valid_loss:.4f}")

        # Save adapter
        trainer.save_model(output_dir)
        tokenizer.save_pretrained(output_dir)
        print(f"  Adapter saved to {output_dir}")

        # Save training metadata
        meta = {
            "version": f"v{version}",
            "platform": "cuda",
            "gpu": gpu_name,
            "base_model": base_model_id,
            "domain": domain["id"] if domain else "coding",
            "train_examples": len(train_data),
            "valid_examples": len(valid_data),
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "gradient_accumulation": args.gradient_accumulation,
            "effective_batch_size": args.batch_size * args.gradient_accumulation,
            "learning_rate": args.lr,
            "lora_r": args.lora_r,
            "lora_alpha": args.lora_alpha,
            "max_seq_length": args.max_seq_length,
            "duration_seconds": round(duration, 1),
            "train_loss": train_loss,
            "valid_loss": valid_loss,
        }
        meta_path = adapter_path / "training-meta.json"
        meta_path.write_text(json.dumps(meta, indent=2))

    except Exception as e:
        duration = time.time() - start
        print(f"\nTraining FAILED after {duration:.1f}s: {e}")
        sys.exit(1)

    print(f"\nNext: run fuse-and-deploy.py to create Ollama model")


if __name__ == "__main__":
    main()
