FROM python:3.12-slim

WORKDIR /app

# Install system deps for pandas/numpy on ARM64
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
RUN mkdir -p snapshots

ENV BONDS_SNAPSHOT_DIR=/app/snapshots
ENV BONDS_LOG_LEVEL=INFO

EXPOSE 8000

CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
