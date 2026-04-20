#!/usr/bin/env bash
# 构建 fan-bot 沙箱镜像

set -euo pipefail

IMAGE_NAME="${SANDBOX_IMAGE:-fan-bot-sandbox}"
IMAGE_TAG="${SANDBOX_IMAGE_TAG:-latest}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Building sandbox image: ${IMAGE_NAME}:${IMAGE_TAG}"
docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" -f "${PROJECT_DIR}/Dockerfile.sandbox" "${PROJECT_DIR}"

echo "✅ Sandbox image built: ${IMAGE_NAME}:${IMAGE_TAG}"
docker images "${IMAGE_NAME}:${IMAGE_TAG}"
