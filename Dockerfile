# syntax=docker/dockerfile:1
#
# LarkBot bot image (Feishu/Lark mode; TDLib is never loaded at runtime).
#
# Build:
#   docker buildx build --platform linux/arm64 -t larkbot:arm64 --load .
# Or through deploy/docker-compose.yml, which also builds the sandbox image.
# docs/deploy.md prefers building off-host and transferring with `docker save`
# / `docker load`; on-host builds work too but need ~2 GB of builder cache.
#
# Node is pinned to 24.18.1 deliberately. better-sqlite3 11 has no prebuild for
# Node 24's ABI, so `pnpm install` compiles it from source against this image's
# headers. Node 24.19.0+ ships the broken cleanup-hook backport
# (nodejs/node#65446): an addon compiled against 24.19+ headers aborts the
# process the first time a statement is finalized, while one compiled against
# <=24.18.1 headers runs on any 24.x. Both stages stay on 24.18.1 so the
# runtime matches the headers the addon links against.
#
# Debian trixie rather than bookworm: lottie-frame links librlottie, and
# Debian's librlottie 0.1 headers already declare the four-argument
# Animation::loadFromData() that the repo's lottie-frame patch calls (bookworm
# happens to ship the same version, but trixie matches the target host and has
# a current openssh-client).

FROM node:24.18.1-trixie-slim AS build

# Never let sharp detect a host libvips and try to build against it; the
# prebuilt @img/sharp-* binary is what the runtime expects.
# node-gyp is a devDependency and is therefore absent from a --prod install,
# yet better-sqlite3 and lottie-frame fall back to `node-gyp rebuild` on
# arm64/Node 24. libpng-dev + librlottie-dev are lottie-frame's link headers.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    SHARP_IGNORE_GLOBAL_LIBVIPS=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates python3 make g++ libpng-dev librlottie-dev \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-fund --no-audit node-gyp@12 pnpm@10.6.2

WORKDIR /app

# The root postinstall (`pnpm tdlib:types`) reads scripts/ and fetches the
# TDLib schema for the pinned prebuilt-tdlib version; it only writes
# types/tdlib-types.d.ts, which no runtime code needs (all tdlib-types imports
# are `import type`). The manifest set, patches/ and scripts/ must be present
# before install so pnpm can apply patches and run the postinstall.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# plugins/ is a workspace package: its manifest must be present for the
# frozen install, which hoists the plugins' own dependencies (node-linker is
# hoisted) into /app/node_modules next to core's.
COPY plugins/package.json ./plugins/package.json
COPY patches ./patches
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --prod

# Trim binaries this image can never load, *before* they are copied into the
# runtime stage: deleting them after the COPY would only add a layer, not
# shrink the image.
#  - ffprobe-static ships darwin/win32/linux-{ia32,x64} only, so on arm64 the
#    whole bin/ directory is dead weight (animationToText then has no ffprobe
#    for video attachments; TGS/webp still work through lottie-frame/sharp);
#  - the musl builds of libvips and TDLib are unreachable on glibc (the glibc
#    TDLib binary stays, so the image could still run Telegram mode).
# See docs/deploy.md.
RUN set -eux; \
    rm -rf node_modules/ffprobe-static/bin/darwin \
           node_modules/ffprobe-static/bin/win32 \
           node_modules/ffprobe-static/bin/linux/ia32; \
    if [ "$(node -p process.arch)" = "arm64" ]; then rm -rf node_modules/ffprobe-static/bin/linux/x64; fi; \
    rm -rf node_modules/@img/*musl* node_modules/@prebuilt-tdlib/*musl*

FROM node:24.18.1-trixie-slim AS runtime

# Runtime shared libraries and tools:
#  - lottie-frame links librlottie.so.0-1 and libpng16.so.16 (trixie's t64 name)
#  - openssh-client provides the ssh that /usr/local/bin/sandbox-exec execs
#  - ca-certificates for outbound HTTPS (Feishu, the model gateway)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates libpng16-16t64 librlottie0-1 openssh-client \
 && rm -rf /var/lib/apt/lists/*

# tsx is a devDependency, so a --prod install does not include it; install the
# lockfile version globally (npm 11.16+ blocks install scripts by default, so
# allow esbuild's — tsx transpiles through esbuild). The symlink into the app's
# node_modules is added after the COPY below, so that the runtime process can
# be plain `node --import tsx ...`: a `tsx` CLI wrapper is an extra process that
# swallows SIGTERM instead of forwarding it, and src/startup's graceful
# shutdown would never run.
RUN npm install -g --no-fund --no-audit --allow-scripts=esbuild tsx@4.21.0

# The deployment host has ~900 MB RAM and the container is capped at 512m.
# Keeping V8's old space well below that limit leaves room for the native
# buffers (sharp/libvips, SQLite, ffmpeg children) and makes a leak surface as
# a V8 out-of-memory error instead of the kernel OOM-killer choosing a victim.
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=320

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# Plugin sources (git submodule) are imported by src/ through a relative path.
COPY plugins/src ./plugins/src
COPY drizzle ./drizzle
# Only tracked prompt templates are baked in; prompts/IDENTITY.md and any other
# deployment-local file listed in a chat's systemFiles are bind-mounted at
# runtime (docs/deploy.md). The check below fails the build when the source
# references a prompt this COPY did not bring in — a new tracked prompt must be
# added here (the glob covers the usual *.velin.md naming).
COPY prompts/*.velin.md prompts/style-enforcements.md prompts/IDENTITY.example.md ./prompts/
COPY deploy/sandbox-exec /usr/local/bin/sandbox-exec
COPY deploy/larkbot-entrypoint.sh /usr/local/bin/larkbot-entrypoint

RUN set -eux; \
    missing=0; \
    for ref in $(grep -rhoE 'prompts/[A-Za-z0-9._-]+\.md' /app/src | sort -u); do \
      [ -f "/app/$ref" ] || { echo "prompt file referenced by src but not copied: $ref" >&2; missing=1; }; \
    done; \
    [ "$missing" -eq 0 ]

# Deployment-private files are bind-mounted at runtime and must never be baked
# into the image. .dockerignore already keeps them out of the build context;
# this is the backstop for a build that skips or mis-edits that file, which
# matters now that CI builds from the public repository and cannot see the
# operator's checkout. Every path here is either a secret (config.yaml holds the
# Feishu app secret and model API keys; .config/ holds the sandbox SSH key) or a
# deployment-local policy file that differs per host.
RUN set -eux; \
    leaked=0; \
    for path in config.yaml contacts.json prompts/IDENTITY.md \
                deploy/.env deploy/docker-compose.override.yml prompts/group-policy.md; do \
      if [ -e "/app/$path" ]; then \
        echo "deployment-private file reached the image: $path" >&2; leaked=1; \
      fi; \
    done; \
    [ "$leaked" -eq 0 ]

RUN ln -s /usr/local/lib/node_modules/tsx /app/node_modules/tsx \
 && chmod 0755 /usr/local/bin/sandbox-exec /usr/local/bin/larkbot-entrypoint \
 && mkdir -p /app/data /app/.config \
 && chown -R node:node /app/data

USER node

ENTRYPOINT ["/usr/local/bin/larkbot-entrypoint"]
CMD ["node", "--import", "tsx", "src/index.ts"]
