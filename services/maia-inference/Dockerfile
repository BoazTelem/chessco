# syntax=docker/dockerfile:1.7
#
# Two-stage build:
#   1. lc0 build stage: compile lc0 from source, download Maia weights.
#   2. Runtime stage: thin Python image with the lc0 binary + weights
#      copied across.
#
# License note: lc0 is GPL-3.0, Maia weights are GPL-3.0. This image
# bundles both. The image itself is therefore GPL-3.0 and you must offer
# the corresponding source for the lc0 binary if you distribute the
# image. For a privately-deployed Cloud Run service this isn't
# distribution; if you ever publish this image to a public registry,
# include a pointer to https://github.com/LeelaChessZero/lc0 in the
# image labels.

FROM debian:bookworm-slim AS lc0

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git build-essential ninja-build meson \
        python3 python3-pip libopenblas-dev libprotobuf-dev protobuf-compiler \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Build lc0 from source. v0.31.2 is a known-good stable tag.
RUN git clone --depth 1 --branch v0.31.2 https://github.com/LeelaChessZero/lc0.git /tmp/lc0
WORKDIR /tmp/lc0
RUN ./build.sh -Dgtest=false -Dblas=true -Dopencl=false -Dcudnn=false

# Fetch the Maia ladder weights from the CSSLab repo. Versioned by the
# git ref of CSSLab/maia-chess at build time. If you need to pin weights
# beyond "current master", switch to a specific commit SHA in the URLs.
RUN mkdir -p /opt/maia/weights \
 && for r in 1500 1700 1900; do \
        curl -fsSL -o /opt/maia/weights/maia-${r}.pb.gz \
            "https://github.com/CSSLab/maia-chess/raw/master/maia_weights/maia-${r}.pb.gz" ; \
    done

# Runtime stage. Python 3.12 slim for FastAPI; libopenblas is the
# runtime dep that lc0 was compiled against.
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        libopenblas0 libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=lc0 /tmp/lc0/build/release/lc0 /usr/local/bin/lc0
COPY --from=lc0 /opt/maia/weights /opt/maia/weights

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .

ENV LC0_BIN=/usr/local/bin/lc0
ENV WEIGHTS_DIR=/opt/maia/weights
ENV LADDER_RATINGS=1500,1700,1900
ENV PORT=8080
ENV PYTHONUNBUFFERED=1
EXPOSE 8080

# Health probe path — Cloud Run does HTTP probes automatically when
# the container exposes a TCP port, but if you front this with a load
# balancer make sure the health endpoint points at /healthz.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
