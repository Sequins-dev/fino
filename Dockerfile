FROM rust:1-bookworm

ENV CARGO_TERM_COLOR=always
WORKDIR /workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    clang \
    cmake \
    curl \
    g++ \
    git \
    libsqlite3-dev \
    make \
    perl \
    pkg-config \
    python3 \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/install-linux-protocol-deps.sh /usr/local/bin/
RUN install-linux-protocol-deps.sh /usr/local && ldconfig

COPY . .

RUN cargo build

CMD ["bash", "-c", "cargo build && FINO_REQUIRE_SQLITE=1 FINO_REQUIRE_TLS=1 FINO_REQUIRE_H2=1 FINO_REQUIRE_H3=1 ./target/debug/fino test tests && cargo test --quiet"]
