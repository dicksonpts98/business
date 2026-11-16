#!/usr/bin/env bash
# Reproduces the offline demonstration: initialise on SYNTHETIC data, run the first research cycle,
# replay every reserved session through the learning loop, then run the engine-contribution ablation.
set -euo pipefail
cd "$(dirname "$0")/../backend"
python -u -W ignore -m alpha_genesis.cli init
python -u -W ignore -m alpha_genesis.cli cycle > ../data/demo_cycle1.json
python -u -W ignore -m alpha_genesis.cli advance "${1:-196}" > ../data/demo_advance.jsonl
python -u -W ignore -m alpha_genesis.cli ablation > ../data/demo_ablation.txt
python -u -W ignore -m alpha_genesis.cli status
