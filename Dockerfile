FROM python:3.12-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY public ./public
COPY content ./content
COPY app ./app
COPY migrations ./migrations
COPY scripts ./scripts
ENV PYTHONUNBUFFERED=1
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-3000}
