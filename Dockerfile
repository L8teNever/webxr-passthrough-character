FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssl \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

COPY app/ ./app/

RUN mkdir -p /data/models /data/calibration /certs

ENV DATA_DIR=/data
ENV CERT_DIR=/certs
ENV HOST=0.0.0.0
ENV PORT=8000
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

VOLUME ["/data"]

ENTRYPOINT ["/entrypoint.sh"]
