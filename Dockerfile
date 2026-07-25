# The cherenkov reactor is a path dependency living beside this repo, so the
# build context must be the PARENT directory:
#   container build -f surge/Dockerfile ~/Code/rust
FROM rust:1-bookworm

ENV CARGO_TERM_COLOR=always
WORKDIR /workspace/surge

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    clang \
    cmake \
    g++ \
    git \
    libgnutls28-dev \
    libngtcp2-crypto-gnutls-dev \
    libngtcp2-dev \
    libsqlite3-dev \
    libssl-dev \
    make \
    perl \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY cherenkov/ /workspace/cherenkov/
COPY surge/ .

RUN cargo build

CMD ["bash", "-c", "cargo build && FINO_REQUIRE_SQLITE=1 ./target/debug/fino test tests && cargo test --quiet"]
