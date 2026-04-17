#!/usr/bin/env bash
# 生成 Langfuse 自部署所需的安全密钥
# 输出到 .env.langfuse 文件，供 docker-compose.langfuse.yml 引用

set -euo pipefail

ENV_FILE=".env.langfuse"

if [ -f "$ENV_FILE" ]; then
  echo "⚠️  $ENV_FILE 已存在，跳过生成"
  echo "   如需重新生成，请先删除: rm $ENV_FILE"
  exit 0
fi

cat > "$ENV_FILE" << EOF
# Langfuse 自部署密钥 - 自动生成于 $(date -Iseconds)
# ⚠️ 请妥善保管此文件，不要提交到版本控制

# PostgreSQL
POSTGRES_USER=langfuse
POSTGRES_PASSWORD=$(openssl rand -base64 24)
POSTGRES_DB=langfuse

# Redis
REDIS_AUTH=$(openssl rand -base64 24)

# ClickHouse
CLICKHOUSE_USER=clickhouse
CLICKHOUSE_PASSWORD=$(openssl rand -base64 24)

# MinIO
MINIO_ROOT_USER=minio
MINIO_ROOT_PASSWORD=$(openssl rand -base64 24)

# Langfuse Web
NEXTAUTH_URL=http://localhost:3100
NEXTAUTH_SECRET=$(openssl rand -hex 32)
SALT=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
LANGFUSE_PORT=3100
EOF

chmod 600 "$ENV_FILE"

echo "✅ 密钥已生成到 $ENV_FILE"
echo ""
echo "下一步："
echo "  1. docker compose -f docker-compose.langfuse.yml --env-file .env.langfuse up -d"
echo "  2. 访问 http://localhost:3100 创建管理员账户"
echo "  3. 创建项目并获取 API Key"
echo "  4. 将 API Key 填入 .env："
echo "     LANGFUSE_PUBLIC_KEY=pk-lf-xxx"
echo "     LANGFUSE_SECRET_KEY=sk-lf-xxx"
echo "     LANGFUSE_BASE_URL=http://localhost:3100"
