#!/usr/bin/env bash
set -euo pipefail

INPUT_CONFIG="${1:?usage: build-runtime-config.sh <input.json> <output.json> <envKey>}"
OUTPUT_CONFIG="${2:?output path required}"
TARGET_ENV="${3:?envKey required}"
AWS_REGION="${AWS_REGION:-ap-southeast-2}"

# Allow ACCOUNT_ID override for local runs; otherwise resolve from the assumed role.
ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"

python3 - "$INPUT_CONFIG" "$OUTPUT_CONFIG" "$ACCOUNT_ID" "$TARGET_ENV" <<'PY'
import json, sys
inp, out, account_id, target = sys.argv[1:5]

# Global __ACCOUNT_ID__ substitution (covers ARNs in secrets/cert too).
raw = open(inp).read().replace("__ACCOUNT_ID__", account_id)
cfg = json.loads(raw)

for _, env in cfg.get("environments", {}).items():
    if not env.get("account") or env.get("account") == "__ACCOUNT_ID__":
        env["account"] = account_id

cfg["stages"] = [s for s in cfg.get("stages", []) if s.get("envKey") == target]
if not cfg["stages"]:
    raise SystemExit(f"No stage found for envKey={target}")

json.dump(cfg, open(out, "w"), indent=2)
print(f"Wrote {out} (env={target}, account={account_id})")
PY
