# syntax=docker/dockerfile:1
ARG NOTO_REVISION=dev
FROM node:22-bookworm-slim AS web
WORKDIR /build/desktop
ENV NEXT_TELEMETRY_DISABLED=1
COPY desktop/package.json desktop/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY desktop/ ./
ARG NOTO_REVISION
RUN npm run build:next

FROM rust:1.96-bookworm AS service
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY server/ server/
COPY desktop/src-tauri/ desktop/src-tauri/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --locked --release -p noto-server && cp target/release/noto-server /noto-server

FROM service AS checks
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo test --locked -p noto-core -p noto-server

FROM debian:bookworm-slim AS runtime
ARG NOTO_REVISION
LABEL org.opencontainers.image.title="Noto" org.opencontainers.image.revision="$NOTO_REVISION"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 noto && useradd --uid 10001 --gid noto --no-create-home noto
WORKDIR /app
COPY --from=service /noto-server /app/noto-server
COPY --from=web /build/desktop/out /app/web
COPY LICENSE /licenses/noto/LICENSE
COPY third_party/noteriv/LICENSE /licenses/noteriv/LICENSE
ENV NOTO_VAULT_DIR=/vault NOTO_DATA_DIR=/data NOTO_STATIC_DIR=/app/web NOTO_LISTEN=0.0.0.0:3457
USER 10001:10001
EXPOSE 3457
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl --fail --silent http://127.0.0.1:3457/health || exit 1
ENTRYPOINT ["/app/noto-server"]
