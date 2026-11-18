#!/usr/bin/env bash
# =============================================================================
#  CallScore: self-hosted transcription + diarization + call scoring
#  Ubuntu Server 22.04 / 24.04, CPU-only
#
#  Stack (all local, Docker Compose):
#    Scriberr (WhisperX + pyannote)  -> transcription + speaker diarization (API for RecBot)
#    Ollama                          -> local LLM behind Scriberr's /summarize
#                                       (RecBot's PII redaction + call scoring)
#  Optional (off by default; RecBot already scores calls):
#    callscore-worker + Postgres/pgvector -> inbox watcher / built-in scoring pipeline
#    Metabase                             -> dashboards for the built-in pipeline
#
#  Usage:
#    sudo ./setup-callscore.sh [install]   Install or re-run setup (idempotent)
#    sudo ./setup-callscore.sh status      Show service + processing status
#    sudo ./setup-callscore.sh test FILE   Drop an audio file in the inbox and follow logs
#    sudo ./setup-callscore.sh pull-models Pull/refresh Ollama models (needs internet)
#    sudo ./setup-callscore.sh lockdown    Block internet egress for the stack (offline mode)
#    sudo ./setup-callscore.sh unlock      Re-allow egress (for updates / model downloads)
#    sudo ./setup-callscore.sh update      Pull newer images and rebuild (run unlock first)
#    sudo ./setup-callscore.sh recbot-env  Print the env vars to paste into RecBot
#
#  Options (env vars, all optional):
#    HF_TOKEN=hf_xxx       Hugging Face read token (one-time pyannote model download)
#    CALLSCORE_DIR=/opt/callscore
#    LLM_MODEL=qwen2.5:7b-instruct   WHISPER_MODEL=medium.en
#    WITH_PIPELINE=yes|no   Built-in CallScore pipeline (default no)
#    WITH_DASHBOARD=yes|no  ASSUME_YES=1 (non-interactive)
# =============================================================================
set -Eeuo pipefail

CALLSCORE_DIR="${CALLSCORE_DIR:-/opt/callscore}"
ENV_FILE="$CALLSCORE_DIR/.env"
SUBNET_DEFAULT="172.30.77.0/24"
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"

c_info() { printf '\e[1;34m==>\e[0m %s\n' "$*"; }
c_ok()   { printf '\e[1;32m ok\e[0m %s\n' "$*"; }
c_warn() { printf '\e[1;33m !!\e[0m %s\n' "$*" >&2; }
c_err()  { printf '\e[1;31mERR\e[0m %s\n' "$*" >&2; }
die()    { c_err "$*"; exit 1; }
trap 'c_err "Failed at line $LINENO: $BASH_COMMAND"' ERR

# Never let a stuck HTTP call hang the installer.
curl() { command curl --connect-timeout 10 --max-time 900 "$@"; }

require_root() { [[ $EUID -eq 0 ]] || die "Run with sudo: sudo $0 $*"; }

compose() { docker compose --project-directory "$CALLSCORE_DIR" -f "$CALLSCORE_DIR/docker-compose.yml" --env-file "$ENV_FILE" "$@"; }

env_get() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }
env_set() {
  local key="$1" val="$2"
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    local esc; esc=$(printf '%s' "$val" | sed -e 's/[\/&|]/\\&/g')
    sed -i "s|^${key}=.*|${key}=${esc}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
has_profile() { [[ ",$(env_get COMPOSE_PROFILES)," == *",$1,"* ]]; }
gen_secret() { local s; s=$(head -c 512 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9'); printf '%s' "${s:0:${1:-32}}"; }

ask() {  # ask "Question" default -> echoes answer
  local q="$1" def="${2:-}" ans
  if [[ "${ASSUME_YES:-0}" == "1" || ! -t 0 ]]; then echo "$def"; return; fi
  read -r -p "$q [$def]: " ans </dev/tty || true
  echo "${ans:-$def}"
}

# -----------------------------------------------------------------------------
# Preflight
# -----------------------------------------------------------------------------
preflight() {
  c_info "Preflight checks"
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || c_warn "Tested on Ubuntu 22.04/24.04; detected ${PRETTY_NAME:-unknown}"
  [[ "$(uname -m)" == "x86_64" ]] || c_warn "Non-x86_64 CPU detected ($(uname -m)); Scriberr images may not run"

  CPU_CORES=$(nproc)
  MEM_GB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
  mkdir -p "$CALLSCORE_DIR"
  DISK_GB=$(df -BG --output=avail "$CALLSCORE_DIR" | tail -1 | tr -dc '0-9')
  c_ok "CPU cores: $CPU_CORES | RAM: ${MEM_GB}GB | Free disk at $CALLSCORE_DIR: ${DISK_GB}GB"

  grep -qw avx2 /proc/cpuinfo || c_warn "CPU lacks AVX2 (check VM CPU type = host passthrough). LLM and Whisper will be much slower."
  (( CPU_CORES >= 8 )) || c_warn "Fewer than 8 vCPUs; expect slow processing (well below real-time)."
  (( MEM_GB >= 16 ))   || c_warn "Less than 16GB RAM; a smaller LLM (qwen2.5:3b) will be used and PII redaction quality will suffer."
  (( DISK_GB >= 60 ))  || c_warn "Less than 60GB free; Docker images + models + WhisperX env need ~40-50GB."
}

pick_defaults() {
  LLM_MODEL="${LLM_MODEL:-$(env_get LLM_MODEL)}"
  WHISPER_MODEL="${WHISPER_MODEL:-$(env_get WHISPER_MODEL)}"
  if [[ -z "${LLM_MODEL:-}" ]]; then
    if (( MEM_GB >= 16 )); then LLM_MODEL="qwen2.5:7b-instruct"; else LLM_MODEL="qwen2.5:3b-instruct"; fi
  fi
  if [[ -z "${WHISPER_MODEL:-}" ]]; then
    if (( CPU_CORES >= 8 && MEM_GB >= 16 )); then WHISPER_MODEL="medium.en"; else WHISPER_MODEL="small.en"; fi
  fi
}

# -----------------------------------------------------------------------------
# Docker
# -----------------------------------------------------------------------------
install_docker() {
  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    c_ok "Docker + Compose already installed ($(docker --version | cut -d, -f1))"
    return
  fi
  c_info "Installing Docker Engine + Compose plugin"
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg jq
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  c_ok "Docker installed"
}

install_tools() {
  local need=()
  for t in curl jq; do command -v "$t" >/dev/null || need+=("$t"); done
  command -v iptables >/dev/null || need+=(iptables)
  if (( ${#need[@]} )); then apt-get update -y && apt-get install -y "${need[@]}"; fi
}

# -----------------------------------------------------------------------------
# Files
# -----------------------------------------------------------------------------
write_file_if_absent() {  # keep user edits to config files on re-run
  local path="$1"
  if [[ -f "$path" ]]; then
    c_ok "Keeping existing $(basename "$path")"
    cat >/dev/null
  else
    cat > "$path"
    c_ok "Wrote $path"
  fi
}

write_files() {
  c_info "Writing stack files to $CALLSCORE_DIR"
  mkdir -p "$CALLSCORE_DIR"/{worker,config,db,data/{inbox,processed,failed,results}}
  chown -R 1000:1000 "$CALLSCORE_DIR/data"

  # Code + schema are always refreshed; rubric/vocabulary are preserved if you edited them.
  cat > "$CALLSCORE_DIR/docker-compose.yml" <<'CALLSCORE_FILE_EOF'
name: callscore

networks:
  callscore:
    driver: bridge
    ipam:
      config:
        - subnet: ${CALLSCORE_SUBNET}

volumes:
  scriberr_data: {}
  scriberr_env: {}
  ollama_data: {}
  pg_data: {}

services:
  postgres:
    image: pgvector/pgvector:pg16
    profiles: ["callscore", "dashboard"]
    restart: unless-stopped
    environment:
      POSTGRES_DB: callscore
      POSTGRES_USER: callscore
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./db/init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro
    networks: [callscore]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U callscore -d callscore"]
      interval: 10s
      timeout: 5s
      retries: 10

  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    environment:
      OLLAMA_KEEP_ALIVE: 30m
      # Scriberr doesn't send a context size, so set the server default here.
      # Too small and long transcripts get silently cut off.
      OLLAMA_CONTEXT_LENGTH: ${OLLAMA_CONTEXT_LENGTH}
      OLLAMA_NUM_PARALLEL: "1"
      OLLAMA_MAX_LOADED_MODELS: "2"
    volumes:
      - ollama_data:/root/.ollama
    networks: [callscore]

  scriberr:
    image: ghcr.io/rishikanthc/scriberr:${SCRIBERR_TAG}
    restart: unless-stopped
    ports:
      - "${SCRIBERR_PORT}:8080"
    environment:
      PUID: "1000"
      PGID: "1000"
      APP_ENV: production
      SECURE_COOKIES: "false"
      # One WhisperX job at a time: on CPU, parallel jobs just fight over cores.
      QUEUE_WORKERS: ${SCRIBERR_QUEUE_WORKERS}
      ALLOWED_ORIGINS: ${SCRIBERR_ALLOWED_ORIGINS}
      HF_TOKEN: ${HF_TOKEN}
      HF_HOME: /app/data/hf-cache
      HF_HUB_OFFLINE: ${OFFLINE}
      TRANSFORMERS_OFFLINE: ${OFFLINE}
      HF_HUB_DISABLE_TELEMETRY: "1"
    volumes:
      - scriberr_data:/app/data
      - scriberr_env:/app/whisperx-env
    networks: [callscore]

  worker:
    build: ./worker
    image: callscore-worker:local
    profiles: ["callscore"]
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      scriberr:
        condition: service_started
      ollama:
        condition: service_started
    environment:
      SCRIBERR_URL: http://scriberr:8080
      SCRIBERR_API_KEY: ${SCRIBERR_API_KEY}
      OLLAMA_URL: http://ollama:11434
      LLM_MODEL: ${LLM_MODEL}
      EMBED_MODEL: ${EMBED_MODEL}
      LLM_NUM_CTX: ${LLM_NUM_CTX}
      DATABASE_URL: postgresql://callscore:${POSTGRES_PASSWORD}@postgres:5432/callscore
      WHISPER_MODEL: ${WHISPER_MODEL}
      WHISPER_COMPUTE_TYPE: int8
      WHISPER_BATCH_SIZE: ${WHISPER_BATCH_SIZE}
      WHISPER_THREADS: ${WHISPER_THREADS}
      WHISPER_LANGUAGE: en
      MIN_SPEAKERS: ${MIN_SPEAKERS}
      MAX_SPEAKERS: ${MAX_SPEAKERS}
      STEREO_MODE: ${STEREO_MODE}
      LEFT_CHANNEL_ROLE: ${LEFT_CHANNEL_ROLE}
      RIGHT_CHANNEL_ROLE: ${RIGHT_CHANNEL_ROLE}
      DATA_DIR: /data
      RUBRIC_PATH: /config/rubric.yaml
      VOCAB_PATH: /config/vocabulary.txt
    volumes:
      - ./data:/data
      - ./config:/config:ro
    networks: [callscore]

  metabase:
    image: metabase/metabase:latest
    profiles: ["dashboard"]
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "${METABASE_PORT}:3000"
    environment:
      MB_DB_TYPE: postgres
      MB_DB_DBNAME: metabase
      MB_DB_PORT: "5432"
      MB_DB_USER: callscore
      MB_DB_PASS: ${POSTGRES_PASSWORD}
      MB_DB_HOST: postgres
      MB_ANON_TRACKING_ENABLED: "false"
      MB_CHECK_FOR_UPDATES: "false"
      JAVA_OPTS: -Xmx1g
    networks: [callscore]
CALLSCORE_FILE_EOF

  cat > "$CALLSCORE_DIR/worker/Dockerfile" <<'CALLSCORE_FILE_EOF'
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak-ng && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY worker.py .
RUN useradd -u 1000 -m worker
USER worker
CMD ["python", "-u", "worker.py"]
CALLSCORE_FILE_EOF

  cat > "$CALLSCORE_DIR/worker/requirements.txt" <<'CALLSCORE_FILE_EOF'
requests==2.32.3
psycopg[binary]==3.2.3
pgvector==0.3.6
PyYAML==6.0.2
CALLSCORE_FILE_EOF

  cat > "$CALLSCORE_DIR/worker/worker.py" <<'CALLSCORE_FILE_EOF'
#!/usr/bin/env python3
"""
CallScore worker: inbox -> Scriberr (WhisperX + pyannote) -> compliance checks
-> Ollama rubric scoring -> embeddings -> Postgres/pgvector.

Everything runs on your own hosts. No external APIs are called.
"""
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import psycopg
import requests
import yaml
from pgvector.psycopg import register_vector

# ----------------------------------------------------------------------------
# Config (from environment)
# ----------------------------------------------------------------------------
ENV = os.environ.get
SCRIBERR_URL = ENV("SCRIBERR_URL", "http://scriberr:8080").rstrip("/")
SCRIBERR_API_KEY = ENV("SCRIBERR_API_KEY", "")
OLLAMA_URL = ENV("OLLAMA_URL", "http://ollama:11434").rstrip("/")
LLM_MODEL = ENV("LLM_MODEL", "qwen2.5:7b-instruct")
EMBED_MODEL = ENV("EMBED_MODEL", "nomic-embed-text")
EMBED_DIM = int(ENV("EMBED_DIM", "768"))
LLM_NUM_CTX = int(ENV("LLM_NUM_CTX", "16384"))
DATABASE_URL = ENV("DATABASE_URL", "postgresql://callscore:callscore@postgres:5432/callscore")

WHISPER_MODEL = ENV("WHISPER_MODEL", "medium.en")
WHISPER_COMPUTE_TYPE = ENV("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_BATCH_SIZE = int(ENV("WHISPER_BATCH_SIZE", "4"))
WHISPER_THREADS = int(ENV("WHISPER_THREADS", "0"))
WHISPER_LANGUAGE = ENV("WHISPER_LANGUAGE", "en")
DIARIZE_MODEL = ENV("DIARIZE_MODEL", "pyannote")
MIN_SPEAKERS = int(ENV("MIN_SPEAKERS", "2"))
MAX_SPEAKERS = int(ENV("MAX_SPEAKERS", "3"))

# Stereo handling: "auto" = split 2-channel files into one track per channel
# (more accurate than diarization for call recordings), "off" = always diarize.
STEREO_MODE = ENV("STEREO_MODE", "auto")
LEFT_CHANNEL_ROLE = ENV("LEFT_CHANNEL_ROLE", "agent")
RIGHT_CHANNEL_ROLE = ENV("RIGHT_CHANNEL_ROLE", "customer")

DATA_DIR = Path(ENV("DATA_DIR", "/data"))
INBOX = DATA_DIR / "inbox"
PROCESSED = DATA_DIR / "processed"
FAILED = DATA_DIR / "failed"
RESULTS = DATA_DIR / "results"
RUBRIC_PATH = Path(ENV("RUBRIC_PATH", "/config/rubric.yaml"))
VOCAB_PATH = Path(ENV("VOCAB_PATH", "/config/vocabulary.txt"))

POLL_SECONDS = int(ENV("POLL_SECONDS", "15"))
JOB_TIMEOUT_SECONDS = int(ENV("JOB_TIMEOUT_SECONDS", str(6 * 3600)))
AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus", ".aac", ".wma", ".webm", ".mp4"}

logging.basicConfig(
    level=ENV("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("callscore")


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def fmt_ts(seconds: float) -> str:
    seconds = int(seconds or 0)
    return f"{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}:{seconds % 60:02d}"


def load_rubric() -> dict:
    with open(RUBRIC_PATH, "r", encoding="utf-8") as f:
        rubric = yaml.safe_load(f)
    total = sum(float(c.get("weight", 1)) for c in rubric.get("criteria", []))
    if total <= 0:
        raise ValueError("Rubric has no weighted criteria")
    return rubric


def load_vocabulary() -> str:
    if not VOCAB_PATH.exists():
        return ""
    words = [w.strip() for w in VOCAB_PATH.read_text(encoding="utf-8").splitlines()]
    words = [w for w in words if w and not w.startswith("#")]
    return ", ".join(words)


def file_is_stable(path: Path, wait: float = 3.0) -> bool:
    """Avoid picking up files that are still being copied in."""
    try:
        s1 = path.stat().st_size
        time.sleep(wait)
        s2 = path.stat().st_size
        return s1 == s2 and s1 > 0
    except FileNotFoundError:
        return False


def probe_channels(path: Path) -> int:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=channels", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, check=True, timeout=60,
        ).stdout.strip()
        return int(out.splitlines()[0]) if out else 1
    except Exception:
        return 1


def probe_duration(path: Path) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, check=True, timeout=60,
        ).stdout.strip()
        return float(out)
    except Exception:
        return 0.0


def split_stereo(path: Path, workdir: Path) -> tuple[Path, Path]:
    left = workdir / "left.wav"
    right = workdir / "right.wav"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(path),
         "-filter_complex", "[0:a]channelsplit=channel_layout=stereo[l][r]",
         "-map", "[l]", "-ac", "1", "-ar", "16000", str(left),
         "-map", "[r]", "-ac", "1", "-ar", "16000", str(right)],
        check=True, timeout=1800,
    )
    return left, right


# ----------------------------------------------------------------------------
# Scriberr client
# ----------------------------------------------------------------------------
class Scriberr:
    def __init__(self, base: str, api_key: str):
        self.base = base
        self.s = requests.Session()
        self.s.headers["X-API-Key"] = api_key

    def health(self) -> bool:
        try:
            return self.s.get(f"{self.base}/health", timeout=10).ok
        except requests.RequestException:
            return False

    def transcribe(self, audio: Path, title: str, diarize: bool, prompt: str) -> tuple[list[dict], str]:
        with open(audio, "rb") as f:
            r = self.s.post(
                f"{self.base}/api/v1/transcription/upload",
                files={"audio": (audio.name, f)},
                data={"title": title},
                timeout=1800,
            )
        r.raise_for_status()
        job_id = r.json()["id"]

        params = {
            "model_family": "whisper",
            "model": WHISPER_MODEL,
            "device": "cpu",
            "compute_type": WHISPER_COMPUTE_TYPE,
            "batch_size": WHISPER_BATCH_SIZE,
            "threads": WHISPER_THREADS,
            "language": WHISPER_LANGUAGE,
            "diarize": diarize,
            "diarize_model": DIARIZE_MODEL,
            "vad_method": "pyannote",
            "segment_resolution": "sentence",
            "fp16": False,
        }
        if diarize:
            params["min_speakers"] = MIN_SPEAKERS
            params["max_speakers"] = MAX_SPEAKERS
        if prompt:
            params["initial_prompt"] = prompt

        r = self.s.post(f"{self.base}/api/v1/transcription/{job_id}/start", json=params, timeout=60)
        r.raise_for_status()
        log.info("Scriberr job %s started for %s (diarize=%s)", job_id, audio.name, diarize)

        deadline = time.time() + JOB_TIMEOUT_SECONDS
        while time.time() < deadline:
            time.sleep(10)
            st = self.s.get(f"{self.base}/api/v1/transcription/{job_id}/status", timeout=30)
            st.raise_for_status()
            status = st.json().get("status")
            if status == "completed":
                break
            if status == "failed":
                raise RuntimeError(f"Scriberr job {job_id} failed: {st.json().get('error_message')}")
        else:
            raise TimeoutError(f"Scriberr job {job_id} timed out")

        t = self.s.get(f"{self.base}/api/v1/transcription/{job_id}/transcript", timeout=60)
        t.raise_for_status()
        transcript = t.json().get("transcript") or {}
        segments = transcript.get("segments", []) if isinstance(transcript, dict) else transcript
        return [
            {
                "start": float(s.get("start", 0)),
                "end": float(s.get("end", 0)),
                "text": (s.get("text") or "").strip(),
                "speaker": s.get("speaker") or "SPEAKER_00",
            }
            for s in segments
            if (s.get("text") or "").strip()
        ], job_id


# ----------------------------------------------------------------------------
# Ollama client
# ----------------------------------------------------------------------------
def ollama_chat_json(system: str, user: str, schema: dict) -> dict:
    r = requests.post(
        f"{OLLAMA_URL}/api/chat",
        json={
            "model": LLM_MODEL,
            "stream": False,
            "format": schema,
            "options": {"temperature": 0, "num_ctx": LLM_NUM_CTX},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        },
        timeout=3 * 3600,
    )
    r.raise_for_status()
    return json.loads(r.json()["message"]["content"])


def ollama_embed(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    r = requests.post(
        f"{OLLAMA_URL}/api/embed",
        json={"model": EMBED_MODEL, "input": texts},
        timeout=1800,
    )
    r.raise_for_status()
    return r.json()["embeddings"]


# ----------------------------------------------------------------------------
# Analysis
# ----------------------------------------------------------------------------
def render_transcript(segments: list[dict], roles: dict | None = None) -> str:
    lines = []
    for s in segments:
        who = s["speaker"]
        if roles and who in roles:
            who = f"{who} ({roles[who]})"
        lines.append(f"[{fmt_ts(s['start'])}] {who}: {s['text']}")
    return "\n".join(lines)


def run_compliance_checks(segments: list[dict], rubric: dict, roles: dict) -> list[dict]:
    """Deterministic regex checks. These never depend on the LLM's judgment."""
    results = []
    for chk in rubric.get("compliance_checks", []):
        want_role = chk.get("speaker_role")
        pats = [re.compile(p, re.IGNORECASE) for p in chk.get("patterns", [])]
        within = chk.get("within_seconds")
        hit = None
        for s in segments:
            if within is not None and s["start"] > float(within):
                break
            if want_role and roles.get(s["speaker"]) != want_role:
                continue
            if any(p.search(s["text"]) for p in pats):
                hit = s
                break
        results.append({
            "id": chk["id"],
            "description": chk.get("description", ""),
            "required": bool(chk.get("required", True)),
            "passed": hit is not None,
            "evidence": hit["text"] if hit else None,
            "timestamp": fmt_ts(hit["start"]) if hit else None,
        })
    return results


def identify_roles(segments: list[dict], rubric: dict) -> dict:
    speakers = sorted({s["speaker"] for s in segments})
    if not speakers:
        return {}
    role_names = [r["id"] for r in rubric.get("roles", [{"id": "agent"}, {"id": "customer"}])]
    role_desc = "\n".join(f"- {r['id']}: {r.get('description', '')}" for r in rubric.get("roles", []))
    excerpt = render_transcript(segments[:80])
    schema = {
        "type": "object",
        "properties": {
            "roles": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "speaker": {"type": "string", "enum": speakers},
                        "role": {"type": "string", "enum": role_names + ["other"]},
                    },
                    "required": ["speaker", "role"],
                },
            }
        },
        "required": ["roles"],
    }
    out = ollama_chat_json(
        "You label speakers in call transcripts. Respond only with JSON.",
        f"Roles:\n{role_desc}\n\nAssign each speaker label ({', '.join(speakers)}) a role.\n\n"
        f"Transcript excerpt:\n{excerpt}",
        schema,
    )
    return {r["speaker"]: r["role"] for r in out.get("roles", []) if r.get("speaker") in speakers}


def score_call(segments: list[dict], roles: dict, rubric: dict, compliance: list[dict]) -> dict:
    criteria = rubric["criteria"]
    crit_ids = [c["id"] for c in criteria]
    crit_text = "\n".join(
        f"- id: {c['id']}\n  name: {c['name']}\n  max_score: {c.get('max_score', 5)}\n"
        f"  what_good_looks_like: {c.get('guidance', '').strip()}"
        for c in criteria
    )
    comp_text = "\n".join(
        f"- {c['id']}: {'PASSED' if c['passed'] else 'NOT FOUND'} ({c['description']})" for c in compliance
    ) or "(none)"
    schema = {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "call_type": {"type": "string"},
            "outcome": {"type": "string"},
            "customer_sentiment": {"type": "string", "enum": ["positive", "neutral", "negative", "mixed"]},
            "agent_sentiment": {"type": "string", "enum": ["positive", "neutral", "negative", "mixed"]},
            "topics": {"type": "array", "items": {"type": "string"}},
            "customer_objections": {"type": "array", "items": {"type": "string"}},
            "criteria": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "enum": crit_ids},
                        "score": {"type": "number"},
                        "not_applicable": {"type": "boolean"},
                        "rationale": {"type": "string"},
                        "evidence_quote": {"type": "string"},
                        "evidence_timestamp": {"type": "string"},
                    },
                    "required": ["id", "score", "not_applicable", "rationale", "evidence_quote", "evidence_timestamp"],
                },
            },
            "coaching_notes": {"type": "array", "items": {"type": "string"}},
            "flags": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["summary", "call_type", "outcome", "customer_sentiment", "agent_sentiment",
                     "topics", "customer_objections", "criteria", "coaching_notes", "flags"],
    }
    system = (
        "You are a strict, fair call quality analyst for a mortgage company. "
        "Score ONLY on what is in the transcript. Every score must cite a short verbatim quote "
        "and its [hh:mm:ss] timestamp from the transcript; if there is no evidence, give a low score "
        "and say so. Mark a criterion not_applicable only if the call type makes it irrelevant. "
        "Respond only with JSON."
    )
    user = (
        f"{rubric.get('context', '').strip()}\n\n"
        f"SCORING CRITERIA (score each 0..max_score):\n{crit_text}\n\n"
        f"AUTOMATED COMPLIANCE CHECKS (already computed, do not re-score, but mention in flags if failed):\n"
        f"{comp_text}\n\n"
        f"TRANSCRIPT:\n{render_transcript(segments, roles)}"
    )
    out = ollama_chat_json(system, user, schema)

    # Clamp scores and compute weighted overall in code, not by the LLM.
    by_id = {c["id"]: c for c in criteria}
    seen, cleaned = set(), []
    for c in out.get("criteria", []):
        cid = c.get("id")
        if cid not in by_id or cid in seen:
            continue
        seen.add(cid)
        mx = float(by_id[cid].get("max_score", 5))
        c["score"] = max(0.0, min(mx, float(c.get("score", 0))))
        c["max_score"] = mx
        c["weight"] = float(by_id[cid].get("weight", 1))
        c["name"] = by_id[cid]["name"]
        cleaned.append(c)
    for cid in crit_ids:  # criteria the model skipped count as 0, flagged
        if cid not in seen:
            cleaned.append({"id": cid, "name": by_id[cid]["name"], "score": 0.0,
                            "max_score": float(by_id[cid].get("max_score", 5)),
                            "weight": float(by_id[cid].get("weight", 1)), "not_applicable": False,
                            "rationale": "Model returned no score for this criterion.",
                            "evidence_quote": "", "evidence_timestamp": ""})
    out["criteria"] = cleaned

    applicable = [c for c in cleaned if not c.get("not_applicable")]
    wsum = sum(c["weight"] for c in applicable)
    quality = 100.0 * sum(c["weight"] * c["score"] / c["max_score"] for c in applicable) / wsum if wsum else 0.0

    failed_required = [c for c in compliance if c["required"] and not c["passed"]]
    penalty = float(rubric.get("compliance_penalty_per_fail", 15))
    cap = rubric.get("compliance_fail_score_cap")
    overall = max(0.0, quality - penalty * len(failed_required))
    if failed_required and cap is not None:
        overall = min(overall, float(cap))

    out["quality_score"] = round(quality, 1)
    out["overall_score"] = round(overall, 1)
    out["compliance_passed"] = not failed_required
    return out


def chunk_segments(segments: list[dict], max_chars: int = 1200) -> list[dict]:
    chunks, cur, size = [], [], 0
    for s in segments:
        line = f"{s['speaker']}: {s['text']}"
        if cur and size + len(line) > max_chars:
            chunks.append(cur)
            cur, size = [], 0
        cur.append(s)
        size += len(line)
    if cur:
        chunks.append(cur)
    return [
        {"start": c[0]["start"], "end": c[-1]["end"],
         "text": "\n".join(f"{s['speaker']}: {s['text']}" for s in c)}
        for c in chunks
    ]


# ----------------------------------------------------------------------------
# Persistence
# ----------------------------------------------------------------------------
def save(conn, meta: dict, segments: list[dict], roles: dict, compliance: list[dict], analysis: dict):
    chunks = chunk_segments(segments)
    vectors = ollama_embed([c["text"] for c in chunks])
    summary_vec = ollama_embed([analysis.get("summary", "") or "empty"])[0]

    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO calls (filename, recorded_at, duration_seconds, scriberr_job_ids, mode,
                       speaker_roles, summary, call_type, outcome, customer_sentiment, agent_sentiment,
                       topics, customer_objections, coaching_notes, flags, quality_score, overall_score,
                       compliance_passed, llm_model, whisper_model, rubric_version, raw_analysis, summary_embedding)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   RETURNING id""",
                (
                    meta["filename"], meta["recorded_at"], meta["duration"], meta["job_ids"], meta["mode"],
                    json.dumps(roles), analysis.get("summary"), analysis.get("call_type"),
                    analysis.get("outcome"), analysis.get("customer_sentiment"),
                    analysis.get("agent_sentiment"), analysis.get("topics", []),
                    analysis.get("customer_objections", []), analysis.get("coaching_notes", []),
                    analysis.get("flags", []), analysis["quality_score"], analysis["overall_score"],
                    analysis["compliance_passed"], LLM_MODEL, WHISPER_MODEL, meta["rubric_version"],
                    json.dumps(analysis), summary_vec,
                ),
            )
            call_id = cur.fetchone()[0]
            cur.executemany(
                "INSERT INTO segments (call_id, idx, start_s, end_s, speaker, role, text) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                [(call_id, i, s["start"], s["end"], s["speaker"], roles.get(s["speaker"]), s["text"])
                 for i, s in enumerate(segments)],
            )
            cur.executemany(
                """INSERT INTO criterion_scores (call_id, criterion_id, name, score, max_score, weight,
                       not_applicable, rationale, evidence_quote, evidence_timestamp)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                [(call_id, c["id"], c["name"], c["score"], c["max_score"], c["weight"],
                  bool(c.get("not_applicable")), c.get("rationale"), c.get("evidence_quote"),
                  c.get("evidence_timestamp")) for c in analysis["criteria"]],
            )
            cur.executemany(
                """INSERT INTO compliance_checks (call_id, check_id, description, required, passed, evidence, timestamp_str)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                [(call_id, c["id"], c["description"], c["required"], c["passed"], c["evidence"], c["timestamp"])
                 for c in compliance],
            )
            cur.executemany(
                "INSERT INTO chunks (call_id, start_s, end_s, text, embedding) VALUES (%s,%s,%s,%s,%s)",
                [(call_id, c["start"], c["end"], c["text"], v) for c, v in zip(chunks, vectors)],
            )
    return call_id


# ----------------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------------
def process(path: Path, scriberr: Scriberr, conn) -> None:
    rubric = load_rubric()
    vocab = load_vocabulary()
    duration = probe_duration(path)
    channels = probe_channels(path)
    title = path.stem
    log.info("Processing %s (%.0fs, %d ch)", path.name, duration, channels)

    with tempfile.TemporaryDirectory() as td:
        if STEREO_MODE == "auto" and channels == 2:
            left, right = split_stereo(path, Path(td))
            lseg, ljob = scriberr.transcribe(left, f"{title} [L]", diarize=False, prompt=vocab)
            rseg, rjob = scriberr.transcribe(right, f"{title} [R]", diarize=False, prompt=vocab)
            for s in lseg:
                s["speaker"] = "LEFT"
            for s in rseg:
                s["speaker"] = "RIGHT"
            segments = sorted(lseg + rseg, key=lambda s: s["start"])
            roles = {"LEFT": LEFT_CHANNEL_ROLE, "RIGHT": RIGHT_CHANNEL_ROLE}
            job_ids, mode = [ljob, rjob], "stereo_split"
        else:
            segments, job = scriberr.transcribe(path, title, diarize=True, prompt=vocab)
            roles = identify_roles(segments, rubric)
            job_ids, mode = [job], "diarized"

    if not segments:
        raise RuntimeError("Transcript is empty (silence or unsupported audio)")

    compliance = run_compliance_checks(segments, rubric, roles)
    analysis = score_call(segments, roles, rubric, compliance)
    meta = {
        "filename": path.name,
        "recorded_at": datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc),
        "duration": duration,
        "job_ids": job_ids,
        "mode": mode,
        "rubric_version": str(rubric.get("version", "1")),
    }
    call_id = save(conn, meta, segments, roles, compliance, analysis)

    result = {"call_id": call_id, **{k: v for k, v in meta.items() if k != "recorded_at"},
              "recorded_at": meta["recorded_at"].isoformat(), "speaker_roles": roles,
              "compliance": compliance, "analysis": analysis,
              "transcript": render_transcript(segments, roles)}
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / f"{path.stem}.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    log.info("Done %s -> call_id=%s overall=%.1f quality=%.1f compliance=%s",
             path.name, call_id, analysis["overall_score"], analysis["quality_score"],
             "PASS" if analysis["compliance_passed"] else "FAIL")


def move_unique(src: Path, dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    if dest.exists():
        dest = dest_dir / f"{src.stem}.{int(time.time())}{src.suffix}"
    shutil.move(str(src), str(dest))
    return dest


def main() -> None:
    if not SCRIBERR_API_KEY:
        log.error("SCRIBERR_API_KEY is not set. Re-run setup or add it to .env.")
        sys.exit(1)
    for d in (INBOX, PROCESSED, FAILED, RESULTS):
        d.mkdir(parents=True, exist_ok=True)
    load_rubric()  # fail fast on a broken rubric

    scriberr = Scriberr(SCRIBERR_URL, SCRIBERR_API_KEY)
    while not scriberr.health():
        log.info("Waiting for Scriberr at %s ...", SCRIBERR_URL)
        time.sleep(10)

    log.info("Worker ready. Watching %s (LLM=%s, whisper=%s)", INBOX, LLM_MODEL, WHISPER_MODEL)

    while True:
        files = sorted(p for p in INBOX.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTS)
        for f in files:
            if not file_is_stable(f):
                continue
            try:
                with psycopg.connect(DATABASE_URL, autocommit=True) as conn:
                    register_vector(conn)
                    process(f, scriberr, conn)
                move_unique(f, PROCESSED)
            except Exception as e:  # keep the loop alive; park the file in failed/
                log.error("Failed %s: %s\n%s", f.name, e, traceback.format_exc())
                dest = move_unique(f, FAILED)
                dest.with_name(dest.name + ".error.txt").write_text(traceback.format_exc(), encoding="utf-8")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
CALLSCORE_FILE_EOF

  cat > "$CALLSCORE_DIR/db/init.sql" <<'CALLSCORE_FILE_EOF'
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS calls (
  id                  BIGSERIAL PRIMARY KEY,
  filename            TEXT NOT NULL,
  processed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at         TIMESTAMPTZ,
  duration_seconds    REAL,
  scriberr_job_ids    TEXT[],
  mode                TEXT,              -- stereo_split | diarized
  speaker_roles       JSONB,
  agent_name          TEXT,              -- fill in later (e.g. from filename or your phone system)
  summary             TEXT,
  call_type           TEXT,
  outcome             TEXT,
  customer_sentiment  TEXT,
  agent_sentiment     TEXT,
  topics              TEXT[],
  customer_objections TEXT[],
  coaching_notes      TEXT[],
  flags               TEXT[],
  quality_score       REAL,
  overall_score       REAL,
  compliance_passed   BOOLEAN,
  llm_model           TEXT,
  whisper_model       TEXT,
  rubric_version      TEXT,
  raw_analysis        JSONB,
  summary_embedding   vector(768)
);

CREATE TABLE IF NOT EXISTS segments (
  id       BIGSERIAL PRIMARY KEY,
  call_id  BIGINT REFERENCES calls(id) ON DELETE CASCADE,
  idx      INT,
  start_s  REAL,
  end_s    REAL,
  speaker  TEXT,
  role     TEXT,
  text     TEXT
);
CREATE INDEX IF NOT EXISTS segments_call_idx ON segments(call_id, idx);
CREATE INDEX IF NOT EXISTS segments_fts ON segments USING gin (to_tsvector('english', text));

CREATE TABLE IF NOT EXISTS criterion_scores (
  id                 BIGSERIAL PRIMARY KEY,
  call_id            BIGINT REFERENCES calls(id) ON DELETE CASCADE,
  criterion_id       TEXT,
  name               TEXT,
  score              REAL,
  max_score          REAL,
  weight             REAL,
  not_applicable     BOOLEAN,
  rationale          TEXT,
  evidence_quote     TEXT,
  evidence_timestamp TEXT
);

CREATE TABLE IF NOT EXISTS compliance_checks (
  id            BIGSERIAL PRIMARY KEY,
  call_id       BIGINT REFERENCES calls(id) ON DELETE CASCADE,
  check_id      TEXT,
  description   TEXT,
  required      BOOLEAN,
  passed        BOOLEAN,
  evidence      TEXT,
  timestamp_str TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id        BIGSERIAL PRIMARY KEY,
  call_id   BIGINT REFERENCES calls(id) ON DELETE CASCADE,
  start_s   REAL,
  end_s     REAL,
  text      TEXT,
  embedding vector(768)
);
CREATE INDEX IF NOT EXISTS chunks_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);

-- Handy view for dashboards
CREATE OR REPLACE VIEW call_scorecard AS
SELECT c.id, c.filename, c.recorded_at, c.processed_at, c.agent_name, c.duration_seconds,
       c.call_type, c.outcome, c.customer_sentiment, c.overall_score, c.quality_score,
       c.compliance_passed,
       (SELECT count(*) FROM compliance_checks k WHERE k.call_id = c.id AND k.required AND NOT k.passed) AS compliance_fails
FROM calls c;

-- Separate database for Metabase's own settings (optional dashboard)
SELECT 'CREATE DATABASE metabase' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'metabase')\gexec
CALLSCORE_FILE_EOF

  write_file_if_absent "$CALLSCORE_DIR/config/rubric.yaml" <<'CALLSCORE_FILE_EOF'
# CallScore rubric. Edit freely; the worker re-reads this file for every call.
# Bump 'version' when you change it so old and new scores can be told apart.
version: "1"

context: |
  These are recorded phone calls between MortgagePros loan officers/staff (the "agent")
  and borrowers or prospective borrowers (the "customer").

roles:
  - id: agent
    description: MortgagePros employee (loan officer, processor, or support staff)
  - id: customer
    description: Borrower, prospective borrower, or their representative

# Weighted, LLM-scored criteria. Overall quality = weighted % of max.
criteria:
  - id: greeting
    name: Professional greeting and identification
    weight: 1
    max_score: 5
    guidance: Agent greets the caller, states their name and MortgagePros, and sets a positive tone.
  - id: needs_discovery
    name: Needs discovery
    weight: 3
    max_score: 5
    guidance: Agent asks open questions to understand the customer's goals (purchase/refi, timeline, budget, property) before recommending anything.
  - id: product_accuracy
    name: Accurate product and process information
    weight: 3
    max_score: 5
    guidance: Explanations of rates, programs, fees, and next steps are accurate and not misleading. No guarantees of approval or rates.
  - id: objection_handling
    name: Objection handling
    weight: 2
    max_score: 5
    guidance: Agent acknowledges concerns, answers them directly, and does not pressure the customer.
  - id: clarity_empathy
    name: Clarity and empathy
    weight: 2
    max_score: 5
    guidance: Plain language, avoids jargon or explains it, listens, and does not interrupt.
  - id: next_steps
    name: Clear next steps and close
    weight: 2
    max_score: 5
    guidance: Agent summarizes, confirms next steps with dates/owners, and checks for remaining questions.

# Deterministic regex checks (case-insensitive). These do NOT rely on the LLM.
# speaker_role limits the check to that role's lines; within_seconds limits it to the start of the call.
# Replace the patterns with your actual required scripting.
compliance_checks:
  - id: recording_disclosure
    description: Agent discloses the call is recorded
    required: true
    speaker_role: agent
    within_seconds: 120
    patterns:
      - "(call|conversation) (is|may be|will be) (being )?(recorded|monitored)"
      - "recorded (line|call)"
  - id: nmls_id
    description: Agent states NMLS ID
    required: false
    speaker_role: agent
    patterns:
      - "\\bNMLS\\b"
  - id: rate_disclaimer
    description: Agent notes that rates are not locked / subject to change when quoting rates
    required: false
    speaker_role: agent
    patterns:
      - "subject to change"
      - "not (a )?(guarantee|locked)"

# Each failed *required* compliance check subtracts this many points from the overall score.
compliance_penalty_per_fail: 15
# And caps the overall score at this value if any required check fails (set to null to disable).
compliance_fail_score_cap: 59
CALLSCORE_FILE_EOF

  write_file_if_absent "$CALLSCORE_DIR/config/vocabulary.txt" <<'CALLSCORE_FILE_EOF'
# Words/names Whisper should spell correctly. One per line. Lines starting with # are ignored.
# Keep this short (Whisper only uses the first ~200 tokens of the prompt).
MortgagePros
escrow
HELOC
LTV
DTI
PMI
APR
FHA
VA loan
USDA
conventional loan
jumbo loan
rate lock
pre-approval
underwriting
Loan Estimate
Closing Disclosure
appraisal
NMLS
amortization
cash-out refinance
CALLSCORE_FILE_EOF

  # Keep a copy of this script next to the stack for later commands / systemd.
  if [[ "$SCRIPT_PATH" != "$CALLSCORE_DIR/callscore.sh" ]]; then
    install -m 0750 "$SCRIPT_PATH" "$CALLSCORE_DIR/callscore.sh"
  fi
}

write_env() {
  c_info "Configuring $ENV_FILE"
  local ip; ip=$(hostname -I | awk '{print $1}')

  [[ -n "$(env_get POSTGRES_PASSWORD)" ]] || env_set POSTGRES_PASSWORD "$(gen_secret 32)"
  [[ -n "$(env_get SCRIBERR_ADMIN_USER)" ]] || env_set SCRIBERR_ADMIN_USER "admin"
  [[ -n "$(env_get SCRIBERR_ADMIN_PASSWORD)" ]] || env_set SCRIBERR_ADMIN_PASSWORD "$(gen_secret 20)"
  [[ -n "$(env_get SCRIBERR_API_KEY)" ]] || env_set SCRIBERR_API_KEY ""

  env_set CALLSCORE_SUBNET "$(env_get CALLSCORE_SUBNET | grep . || echo "$SUBNET_DEFAULT")"
  env_set SCRIBERR_TAG "$(env_get SCRIBERR_TAG | grep . || echo latest)"
  env_set SCRIBERR_PORT "$(env_get SCRIBERR_PORT | grep . || echo 8080)"
  env_set METABASE_PORT "$(env_get METABASE_PORT | grep . || echo 3000)"
  env_set SCRIBERR_ALLOWED_ORIGINS "http://${ip}:$(env_get SCRIBERR_PORT),http://localhost:$(env_get SCRIBERR_PORT)"
  env_set OFFLINE "$(env_get OFFLINE | grep . || echo 0)"

  env_set LLM_MODEL "${LLM_MODEL}"
  env_set EMBED_MODEL "$(env_get EMBED_MODEL | grep . || echo nomic-embed-text)"
  env_set LLM_NUM_CTX "$(env_get LLM_NUM_CTX | grep . || echo 16384)"
  env_set WHISPER_MODEL "${WHISPER_MODEL}"
  env_set WHISPER_BATCH_SIZE "$(env_get WHISPER_BATCH_SIZE | grep . || echo 4)"
  env_set WHISPER_THREADS "$(env_get WHISPER_THREADS | grep . || echo "$CPU_CORES")"
  env_set MIN_SPEAKERS "$(env_get MIN_SPEAKERS | grep . || echo 2)"
  env_set MAX_SPEAKERS "$(env_get MAX_SPEAKERS | grep . || echo 3)"
  env_set STEREO_MODE "$(env_get STEREO_MODE | grep . || echo auto)"
  env_set LEFT_CHANNEL_ROLE "$(env_get LEFT_CHANNEL_ROLE | grep . || echo agent)"
  env_set RIGHT_CHANNEL_ROLE "$(env_get RIGHT_CHANNEL_ROLE | grep . || echo customer)"
  env_set SCRIBERR_QUEUE_WORKERS "$(env_get SCRIBERR_QUEUE_WORKERS | grep . || echo 1)"
  # RecBot's scoring prompt can be ~15k tokens; Scriberr doesn't send a context size,
  # so Ollama's server default must be big enough (the KV cache uses RAM).
  local ctx_default=16384; (( MEM_GB >= 24 )) && ctx_default=32768
  env_set OLLAMA_CONTEXT_LENGTH "$(env_get OLLAMA_CONTEXT_LENGTH | grep . || echo "$ctx_default")"
  [[ -n "$(env_get RECBOT_API_KEY)" ]] || env_set RECBOT_API_KEY ""

  # Hugging Face token (only needed until pyannote models are cached)
  local hf="${HF_TOKEN:-$(env_get HF_TOKEN)}"
  if [[ -z "$hf" && "${ASSUME_YES:-0}" != "1" && -t 0 ]]; then
    echo
    echo "Speaker diarization uses pyannote models from Hugging Face (one-time download)."
    echo "  1. Create a free account at huggingface.co"
    echo "  2. Accept the terms on: pyannote/speaker-diarization-3.1, pyannote/segmentation-3.0,"
    echo "     and pyannote/speaker-diarization-community-1"
    echo "  3. Create a READ token: Settings -> Access Tokens"
    read -r -s -p "Paste HF token (or leave blank to add later): " hf </dev/tty || true
    echo
  fi
  env_set HF_TOKEN "${hf}"
  [[ -n "$hf" ]] || c_warn "No HF token set: diarization will fail until you add HF_TOKEN to $ENV_FILE and re-run install."

  local pipe="${WITH_PIPELINE:-}" dash="${WITH_DASHBOARD:-}" profiles=()
  if [[ -z "$pipe" ]]; then
    if has_profile callscore; then pipe=yes
    else pipe=$(ask "Enable the built-in CallScore pipeline (inbox + scoring)? RecBot already scores calls, so usually no. yes/no" "no"); fi
  fi
  if [[ "$pipe" =~ ^[Yy] ]]; then
    profiles+=(callscore)
    if [[ -z "$dash" ]]; then
      if has_profile dashboard; then dash=yes
      else dash=$(ask "Install Metabase dashboard for the pipeline (uses ~1.5GB RAM)? yes/no" "no"); fi
    fi
    if [[ "$dash" =~ ^[Yy] ]]; then profiles+=(dashboard); fi
  fi
  env_set COMPOSE_PROFILES "$(IFS=,; echo "${profiles[*]}")"
}

# -----------------------------------------------------------------------------
# Bring-up + bootstrap
# -----------------------------------------------------------------------------
start_stack() {
  c_info "Building and starting containers (first pull can take a while)"
  compose pull --ignore-buildable --quiet || compose pull --quiet || true
  # The worker image also generates the warm-up audio, so build it even when the pipeline is off.
  compose --profile callscore build worker
  if has_profile callscore || has_profile dashboard; then
    compose up -d --wait postgres
  fi
  if has_profile dashboard; then
    echo "SELECT 'CREATE DATABASE metabase' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'metabase')\\gexec" \
      | compose exec -T postgres psql -U callscore -d callscore >/dev/null
  fi
  # Remove optional containers that are switched off (their data volumes are kept).
  has_profile callscore || compose --profile callscore rm -sf worker >/dev/null 2>&1 || true
  has_profile dashboard || compose --profile dashboard rm -sf metabase >/dev/null 2>&1 || true
  if ! has_profile callscore && ! has_profile dashboard; then
    compose --profile callscore rm -sf postgres >/dev/null 2>&1 || true
  fi
  compose up -d --build --remove-orphans
}

wait_http() {  # wait_http URL seconds
  local url="$1" t="${2:-300}" i=0
  until curl -fsS -o /dev/null "$url"; do
    (( i += 5 )); (( i < t )) || return 1; sleep 5
  done
}

bootstrap_scriberr() {
  c_info "Bootstrapping Scriberr admin + API key"
  local base
  base=$(scriberr_base)
  # On first start Scriberr builds its Python envs (WhisperX, PyAnnote, NVIDIA models; ~10-20GB)
  # BEFORE it opens its web port. That can take 30-90 min on a CPU VM, so wait patiently.
  c_info "Waiting for Scriberr to finish first-time environment setup (can take 30-90 min)..."
  local waited=0 last
  until curl -fsS -o /dev/null "$base/health"; do
    sleep 15; (( waited += 15 ))
    last=$(compose logs --no-log-prefix --tail 1 scriberr 2>/dev/null | tr -d '\r' | cut -c1-90)
    printf '\r   %3d min | %-90s' $(( waited / 60 )) "$last"
    if (( waited >= ${SCRIBERR_WAIT_SECONDS:-7200} )); then
      echo
      die "Scriberr still not up after $(( waited / 60 )) min. Check: sudo docker compose -f $CALLSCORE_DIR/docker-compose.yml logs -f scriberr"
    fi
    if [[ -z "$(compose ps -q --status running scriberr 2>/dev/null)" ]]; then
      echo; die "Scriberr container stopped. Check: sudo docker compose -f $CALLSCORE_DIR/docker-compose.yml logs scriberr"
    fi
  done
  echo; c_ok "Scriberr is up"
  ensure_api_key SCRIBERR_API_KEY "callscore-stack" "Stack admin key (warm-up, built-in pipeline)"
  ensure_api_key RECBOT_API_KEY "recbot" "RecBot transcription + LLM client"
  if has_profile callscore; then compose up -d worker; fi
  configure_scriberr_llm
}

scriberr_base() { echo "http://127.0.0.1:$(env_get SCRIBERR_PORT)"; }

scriberr_jwt() {  # registers the admin on first run, then logs in; echoes a JWT or nothing
  local base user pass
  base=$(scriberr_base); user=$(env_get SCRIBERR_ADMIN_USER); pass=$(env_get SCRIBERR_ADMIN_PASSWORD)
  if [[ "$(curl -fsS "$base/api/v1/auth/registration-status" | jq -r '.registration_enabled')" == "true" ]]; then
    curl -fsS -X POST "$base/api/v1/auth/register" -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg u "$user" --arg p "$pass" '{username:$u,password:$p,confirmPassword:$p}')" >/dev/null
    c_ok "Created Scriberr admin user '$user'" >&2
  fi
  curl -fsS -X POST "$base/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg u "$user" --arg p "$pass" '{username:$u,password:$p}')" 2>/dev/null | jq -r '.token // empty' || true
}

ensure_api_key() {  # ensure_api_key ENV_VAR key-name description
  local var="$1" name="$2" desc="$3" base key token
  base=$(scriberr_base); key=$(env_get "$var")
  if [[ -n "$key" ]]; then
    if curl -fsS -o /dev/null -H "X-API-Key: $key" "$base/api/v1/transcription/list?limit=1"; then
      c_ok "Scriberr API key '$name' works"; return
    fi
    c_warn "Stored '$name' API key was rejected; creating a new one"
  fi
  token=$(scriberr_jwt)
  if [[ -z "$token" ]]; then
    c_warn "Could not log in to Scriberr as '$(env_get SCRIBERR_ADMIN_USER)' (an admin may already exist from an earlier install)."
    c_warn "Create an API key named '$name' in the Scriberr UI (Settings -> API Keys), then run:"
    c_warn "  sudo sed -i 's|^${var}=.*|${var}=<key>|' $ENV_FILE && sudo $CALLSCORE_DIR/callscore.sh install"
    return
  fi
  key=$(curl -fsS -X POST "$base/api/v1/api-keys/" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg n "$name" --arg d "$desc" '{name:$n,description:$d}')" | jq -r '.key // empty')
  [[ -n "$key" ]] || die "Failed to create Scriberr API key '$name'"
  env_set "$var" "$key"
  c_ok "Created Scriberr API key '$name'"
}

configure_scriberr_llm() {
  # RecBot's redaction and scoring go through Scriberr's /summarize, which needs an active LLM provider.
  local base key cur want="http://ollama:11434"
  base=$(scriberr_base); key=$(env_get SCRIBERR_API_KEY)
  if [[ -z "$key" ]]; then
    c_warn "No Scriberr API key; set the LLM provider in the Scriberr UI: Settings -> LLM -> Ollama, $want"; return
  fi
  cur=$(curl -fsS -H "X-API-Key: $key" "$base/api/v1/llm/config" 2>/dev/null || true)
  if [[ -n "$cur" && "$(jq -r '"\(.provider) \(.base_url) \(.is_active)"' <<<"$cur" 2>/dev/null)" == "ollama $want true" ]]; then
    c_ok "Scriberr LLM provider already set to Ollama ($want)"; return
  fi
  if curl -fsS -o /dev/null -X POST "$base/api/v1/llm/config" -H "X-API-Key: $key" -H 'Content-Type: application/json' \
       -d "$(jq -nc --arg u "$want" '{provider:"ollama",base_url:$u,is_active:true}')"; then
    c_ok "Scriberr LLM provider set to Ollama ($want)"
  else
    c_warn "Could not set Scriberr's LLM provider; set it in the UI: Settings -> LLM -> Ollama, $want"
  fi
}

pull_models() {
  c_info "Pulling Ollama model: $(env_get LLM_MODEL)"
  [[ "$(env_get OFFLINE)" == "1" ]] && c_warn "Stack is locked down; run '$0 unlock' first if pulls fail."
  compose exec -T ollama ollama pull "$(env_get LLM_MODEL)"
  if has_profile callscore; then compose exec -T ollama ollama pull "$(env_get EMBED_MODEL)"; fi
  c_ok "Models ready"
}

warm_scriberr() {
  # First Scriberr job builds its WhisperX Python env and downloads Whisper + pyannote
  # models. Do it now with a 20-second synthetic clip so the first real call isn't stuck.
  c_info "Warming up Scriberr (builds WhisperX env + downloads models; can take 10-30 min on first run)"
  local key base tmp job st i=0
  key=$(env_get SCRIBERR_API_KEY); [[ -n "$key" ]] || { c_warn "No API key; skipping warm-up"; return; }
  base="http://127.0.0.1:$(env_get SCRIBERR_PORT)"
  tmp=$(mktemp -d); chmod 777 "$tmp"
  # Two synthetic "speakers" (different espeak voices) so diarization actually runs.
  docker run --rm --user 0 -v "$tmp:/out" --entrypoint bash callscore-worker:local -c '
      espeak-ng -v en-us   -s 150 -w /out/a.wav "Thank you for calling MortgagePros, this call may be recorded. How can I help you today?" &&
      espeak-ng -v en+f3   -s 140 -w /out/b.wav "Hi, I am looking to refinance my home and want to know about current rates and closing costs." &&
      espeak-ng -v en-us   -s 150 -w /out/c.wav "Sure. Rates are subject to change until you lock, but let me ask a few questions about your loan first." &&
      ffmpeg -nostdin -loglevel error -i /out/a.wav -i /out/b.wav -i /out/c.wav \
        -filter_complex "[0][1][2]concat=n=3:v=0:a=1,aresample=16000" -ac 1 /out/warmup.wav' \
    || { c_warn "Could not generate warm-up audio; skipping"; rm -rf "$tmp"; return; }
  job=$(curl -fsS -H "X-API-Key: $key" -F "audio=@$tmp/warmup.wav" -F "title=callscore-warmup" \
        "$base/api/v1/transcription/upload" | jq -r '.id')
  rm -rf "$tmp"
  local diar=false; [[ -n "$(env_get HF_TOKEN)" ]] && diar=true
  curl -fsS -X POST -H "X-API-Key: $key" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg m "$(env_get WHISPER_MODEL)" --argjson d "$diar" \
      '{model_family:"whisper",model:$m,device:"cpu",compute_type:"int8",batch_size:4,language:"en",diarize:$d,diarize_model:"pyannote",min_speakers:1,max_speakers:2}')" \
    "$base/api/v1/transcription/$job/start" >/dev/null
  while :; do
    sleep 15; (( i += 15 ))
    st=$(curl -fsS -H "X-API-Key: $key" "$base/api/v1/transcription/$job/status" | jq -r '.status')
    printf '\r   warm-up status: %-12s (%ds)' "$st" "$i"
    [[ "$st" == "completed" || "$st" == "failed" ]] && break
    (( i < 3600 )) || { echo; c_warn "Warm-up still running after 60 min; continuing"; return; }
  done
  echo
  if [[ "$st" == "completed" ]]; then
    c_ok "Scriberr warm-up complete (models cached)"
    curl -fsS -X DELETE -H "X-API-Key: $key" "$base/api/v1/transcription/$job" >/dev/null || true
  else
    c_warn "Warm-up job failed. Check: docker compose -f $CALLSCORE_DIR/docker-compose.yml logs scriberr"
    c_warn "Most common cause: HF token missing, or pyannote model terms not accepted on huggingface.co"
  fi
}

# -----------------------------------------------------------------------------
# Offline lockdown (blocks internet egress from the stack's Docker subnet)
# -----------------------------------------------------------------------------
apply_lock() {
  local subnet; subnet=$(env_get CALLSCORE_SUBNET)
  iptables -N CALLSCORE-EGRESS 2>/dev/null || iptables -F CALLSCORE-EGRESS
  iptables -A CALLSCORE-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8; do
    iptables -A CALLSCORE-EGRESS -d "$net" -j RETURN
  done
  iptables -A CALLSCORE-EGRESS -j DROP
  iptables -N DOCKER-USER 2>/dev/null || true
  iptables -C DOCKER-USER -s "$subnet" -j CALLSCORE-EGRESS 2>/dev/null \
    || iptables -I DOCKER-USER 1 -s "$subnet" -j CALLSCORE-EGRESS
}

remove_lock() {
  local subnet; subnet=$(env_get CALLSCORE_SUBNET)
  while iptables -C DOCKER-USER -s "$subnet" -j CALLSCORE-EGRESS 2>/dev/null; do
    iptables -D DOCKER-USER -s "$subnet" -j CALLSCORE-EGRESS
  done
  iptables -F CALLSCORE-EGRESS 2>/dev/null || true
  iptables -X CALLSCORE-EGRESS 2>/dev/null || true
}

lockdown() {
  c_info "Locking down: containers may reach your LAN only, not the internet"
  env_set OFFLINE 1
  env_set HF_TOKEN ""
  cat > /etc/systemd/system/callscore-egress-lock.service <<EOF
[Unit]
Description=CallScore - block internet egress from the CallScore Docker subnet
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$CALLSCORE_DIR/callscore.sh _apply-lock
ExecStop=$CALLSCORE_DIR/callscore.sh _remove-lock

[Install]
WantedBy=docker.service
EOF
  systemctl daemon-reload
  systemctl enable --now callscore-egress-lock.service
  systemctl restart callscore-egress-lock.service
  compose up -d
  sleep 5
  if compose exec -T worker python -c "import requests;requests.get('https://huggingface.co',timeout=8)" >/dev/null 2>&1; then
    c_warn "Egress test: internet still reachable from containers. Check 'iptables -L DOCKER-USER -n'."
  else
    c_ok "Egress test: internet blocked from containers (expected)"
  fi
  c_ok "Offline mode on. HF token removed; HF_HUB_OFFLINE=1 set on Scriberr."
}

unlock() {
  c_info "Removing egress lock"
  systemctl disable --now callscore-egress-lock.service 2>/dev/null || true
  remove_lock
  env_set OFFLINE 0
  compose up -d
  c_ok "Egress allowed. Re-add HF_TOKEN to $ENV_FILE if you need to re-download pyannote models."
}

# -----------------------------------------------------------------------------
# Status / test / update
# -----------------------------------------------------------------------------
status() {
  compose ps
  echo
  has_profile callscore && c_info "Inbox: $(find "$CALLSCORE_DIR/data/inbox" -maxdepth 1 -type f | wc -l) | processed: $(find "$CALLSCORE_DIR/data/processed" -maxdepth 1 -type f | wc -l) | failed: $(find "$CALLSCORE_DIR/data/failed" -maxdepth 1 -type f ! -name '*.error.txt' | wc -l)"
  has_profile callscore && compose exec -T postgres psql -U callscore -d callscore -c \
    "SELECT count(*) AS calls, round(avg(overall_score)::numeric,1) AS avg_score, sum(CASE WHEN compliance_passed THEN 0 ELSE 1 END) AS compliance_fails FROM calls;" 2>/dev/null || true
  echo
  c_info "Offline mode: $( [[ "$(env_get OFFLINE)" == "1" ]] && echo ON || echo OFF )"
  if has_profile callscore; then c_info "Recent worker log:"; compose logs --tail 15 worker
  else c_info "Recent Scriberr log:"; compose logs --tail 15 scriberr; fi
}

test_file() {
  local f="${1:-}"; [[ -f "$f" ]] || die "Usage: $0 test /path/to/call.wav"
  has_profile callscore || die "The built-in pipeline is off (RecBot does scoring). Enable it with: sudo WITH_PIPELINE=yes $0 install"
  install -o 1000 -g 1000 -m 0644 "$f" "$CALLSCORE_DIR/data/inbox/"
  c_info "Queued $(basename "$f"). Following worker logs (Ctrl+C to stop)..."
  compose logs -f --tail 0 worker
}

update() {
  [[ "$(env_get OFFLINE)" == "1" ]] && die "Stack is locked down. Run '$0 unlock' first, then '$0 lockdown' after updating."
  write_files
  compose pull --ignore-buildable || true
  compose up -d --build
  c_ok "Updated"
}

recbot_env() {
  local ip; ip=$(hostname -I | awk '{print $1}')
  cat <<EOF
# --- Paste into RecBot's environment (docker-compose / Portainer stack) ---
SCRIBERR_URL=http://${ip}:$(env_get SCRIBERR_PORT)
SCRIBERR_API_KEY=$(env_get RECBOT_API_KEY)
SCRIBERR_TRANSCRIBE_MODEL=$(env_get WHISPER_MODEL)
SCRIBERR_LANGUAGE=en
SCRIBERR_LLM_MODEL=$(env_get LLM_MODEL)
SCRIBERR_LLM_TIMEOUT_MS=1800000
TRANSCRIBE_MAX_PER_TICK=3
EOF
}

summary() {
  local ip; ip=$(hostname -I | awk '{print $1}')
  cat <<EOF

=============================================================================
 AI stack is up (Scriberr + Ollama).
-----------------------------------------------------------------------------
 Scriberr UI:   http://${ip}:$(env_get SCRIBERR_PORT)
                user: $(env_get SCRIBERR_ADMIN_USER)   password: in $ENV_FILE
$( has_profile dashboard && echo " Metabase:      http://${ip}:$(env_get METABASE_PORT)  (DB host: postgres, db/user: callscore, password in .env)" )
 Whisper: $(env_get WHISPER_MODEL)   LLM: $(env_get LLM_MODEL)   Ollama context: $(env_get OLLAMA_CONTEXT_LENGTH) tokens
 Scriberr LLM provider: Ollama (http://ollama:11434)
$( has_profile callscore && echo " Pipeline inbox: $CALLSCORE_DIR/data/inbox   Rubric: $CALLSCORE_DIR/config/rubric.yaml" )

 RecBot settings (print again any time: sudo $CALLSCORE_DIR/callscore.sh recbot-env):
$(recbot_env | sed 's/^/   /')

 Next steps:
   1. Put the settings above into RecBot and restart it.
   2. Offline:  sudo $CALLSCORE_DIR/callscore.sh lockdown
=============================================================================
EOF
}

install_all() {
  preflight
  pick_defaults
  install_tools
  install_docker
  install_tools
  write_files
  write_env
  start_stack
  bootstrap_scriberr
  pull_models
  warm_scriberr
  summary
}

main() {
  local cmd="${1:-install}"; shift || true
  require_root "$cmd"
  case "$cmd" in
    install)      install_all ;;
    status)       status ;;
    test)         test_file "$@" ;;
    pull-models)  pull_models ;;
    lockdown)     lockdown ;;
    unlock)       unlock ;;
    update)       update ;;
    recbot-env)   recbot_env ;;
    _apply-lock)  apply_lock ;;
    _remove-lock) remove_lock ;;
    *) sed -n '2,30p' "$SCRIPT_PATH"; exit 1 ;;
  esac
}
main "$@"
