# Frontier adapter for foul play (pmariglia/foul-play @ 8f541f8):
# Monte Carlo Tree Search over the Rust poke-engine, driven headlessly.
#
# Build:  docker build -t frontier-foulplay ./bots/foulplay
# Digest: docker inspect --format='{{.Id}}' frontier-foulplay
#
# Stage 1 compiles the poke-engine Rust extension (foul play pins
# poke-engine==0.0.48 with the terastallization feature).
# Stage 2 is the runtime: foul play source (pinned tarball), the adapter,
# and pre-warmed dataset caches (no network at runtime).

ARG FOUL_PLAY_SHA=8f541f80f91f960603673796559f796b10ccf0fb

FROM python:3.12-slim AS rustbuild
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl build-essential \
    && rm -rf /var/lib/apt/lists
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH="/opt/cargo/bin:$PATH"
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
RUN pip install --no-cache-dir maturin
RUN pip wheel --no-deps --no-cache-dir -w /wheels "poke-engine==0.0.48" \
        --config-settings="build-args=--features poke-engine/terastallization --no-default-features"

FROM python:3.12-slim
WORKDIR /app

# poke-engine wheel built above
COPY --from=rustbuild /wheels /wheels
RUN pip install --no-cache-dir /wheels/*.whl

# foul play source, pinned
ARG FOUL_PLAY_SHA
ADD https://github.com/pmariglia/foul-play/archive/${FOUL_PLAY_SHA}.tar.gz /tmp/fp.tgz
RUN tar xzf /tmp/fp.tgz -C /app --strip-components=1 && rm /tmp/fp.tgz
# requirements.txt pins poke-engine too, but we already installed our own
# wheel (built with the terastallization feature above)
RUN grep -v '^poke-engine==' requirements.txt > /tmp/req.txt \
    && pip install --no-cache-dir -r /tmp/req.txt && rm /tmp/req.txt

# adapter + dataset pre-warm (needs network; baked into the image)
COPY adapter.py warmup.py ./
ENV PYTHONPATH=/app
RUN python3 warmup.py

ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python3", "-u", "adapter.py"]
