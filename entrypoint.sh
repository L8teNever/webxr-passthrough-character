#!/bin/bash
set -euo pipefail

CERT_DIR="${CERT_DIR:-/certs}"
DATA_DIR="${DATA_DIR:-/data}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
# Optional LAN IP for Quest Browser (e.g. HOST_IP=192.168.1.42)
HOST_IP="${HOST_IP:-}"
EXTRA_SAN="${EXTRA_SAN:-}"

mkdir -p "${CERT_DIR}" "${DATA_DIR}/models" "${DATA_DIR}/calibration"

CERT_FILE="${CERT_DIR}/cert.pem"
KEY_FILE="${CERT_DIR}/key.pem"

collect_ips() {
  # Prefer hostname -I when available (Debian)
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null || true
  fi
  # Fallback: parse ip route / ip addr
  if command -v ip >/dev/null 2>&1; then
    ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 || true
  fi
}

build_san() {
  local sans="DNS:localhost,DNS:webxr.local,IP:127.0.0.1"
  if [ -n "${HOST_IP}" ]; then
    sans="${sans},IP:${HOST_IP}"
  fi
  local ip
  for ip in $(collect_ips); do
    case "${ip}" in
      127.*|::1|"") continue ;;
      *:*) continue ;; # skip IPv6 for simplicity
      *) sans="${sans},IP:${ip}" ;;
    esac
  done
  if [ -n "${EXTRA_SAN}" ]; then
    sans="${sans},${EXTRA_SAN}"
  fi
  # Deduplicate while preserving order
  echo "${sans}" | tr ',' '\n' | awk 'NF && !seen[$0]++' | paste -sd, -
}

# Regenerate cert if missing OR if HOST_IP is set and not present in existing cert
need_cert=0
if [ ! -f "${CERT_FILE}" ] || [ ! -f "${KEY_FILE}" ]; then
  need_cert=1
elif [ -n "${HOST_IP}" ] && ! openssl x509 -in "${CERT_FILE}" -noout -text 2>/dev/null | grep -q "${HOST_IP}"; then
  echo "[entrypoint] HOST_IP=${HOST_IP} missing from existing cert — regenerating"
  need_cert=1
fi

if [ "${need_cert}" -eq 1 ]; then
  SAN="$(build_san)"
  echo "[entrypoint] Generating self-signed SSL certificate for WebXR..."
  echo "[entrypoint] subjectAltName=${SAN}"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "${KEY_FILE}" \
    -out "${CERT_FILE}" \
    -days 365 \
    -subj "/CN=webxr.local/O=WebXR Local/C=DE" \
    -addext "subjectAltName=${SAN}"
  echo "[entrypoint] Certificate written to ${CERT_FILE}"
else
  echo "[entrypoint] Reusing existing SSL certificate"
fi

echo "[entrypoint] Ensuring 3D model assets..."
python -c "from app.model_loader import ensure_model; print(ensure_model())"

echo "[entrypoint] Starting Uvicorn on https://${HOST}:${PORT}"
exec uvicorn app.main:app \
  --host "${HOST}" \
  --port "${PORT}" \
  --ssl-keyfile "${KEY_FILE}" \
  --ssl-certfile "${CERT_FILE}" \
  --proxy-headers \
  --forwarded-allow-ips='*'
