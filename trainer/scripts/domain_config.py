"""
The Forge — Domain Configuration (Python side)
Reads domain-specific config from domains/*.json
Shared by prepare-data.py, evaluate.py, train.py, and fuse-and-deploy.py
"""

import json
import os
from pathlib import Path

TRAINER_DIR = Path(__file__).resolve().parent.parent
DOMAINS_DIR = TRAINER_DIR / "domains"
ACTIVE_FILE = DOMAINS_DIR / ".active"
DEFAULT_DOMAIN = "coding"


def load_domain(domain_id):
    """Load a domain config by ID."""
    f = DOMAINS_DIR / f"{domain_id}.json"
    if not f.exists():
        raise FileNotFoundError(f'Domain "{domain_id}" not found at {f}')
    return json.loads(f.read_text())


def get_active_domain_id():
    """Get the currently active domain ID."""
    if ACTIVE_FILE.exists():
        text = ACTIVE_FILE.read_text().strip()
        return text if text else DEFAULT_DOMAIN
    return DEFAULT_DOMAIN


def get_active_domain():
    """Get the currently active domain config."""
    return load_domain(get_active_domain_id())


def set_active_domain(domain_id):
    """Set the active domain."""
    load_domain(domain_id)  # validate exists
    ACTIVE_FILE.write_text(domain_id + "\n")


def list_domains():
    """List all available domains."""
    active = get_active_domain_id()
    domains = []
    for f in sorted(DOMAINS_DIR.glob("*.json")):
        if f.name.startswith("."):
            continue
        d = json.loads(f.read_text())
        domains.append({
            "id": d["id"],
            "name": d["name"],
            "description": d["description"],
            "model_prefix": d["model_prefix"],
            "active": d["id"] == active,
        })
    return domains
