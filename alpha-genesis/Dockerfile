# ALPHA GENESIS — single image: builds the dashboard, then serves API + UI + background worker.
FROM node:22-slim AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ backend/
COPY config/ config/
COPY --from=ui /ui/dist frontend/dist
RUN pip install --no-cache-dir -e backend
ENV AG_DATA_DIR=/app/data PYTHONUNBUFFERED=1
VOLUME /app/data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1
CMD ["python", "-W", "ignore", "-m", "alpha_genesis.cli", "serve", "--host", "0.0.0.0", "--port", "8000"]
