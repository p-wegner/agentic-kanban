# Agentic Kanban — server deployment image.
# Debian (glibc) is required: @libsql/client and the @anthropic-ai/claude-agent-sdk
# native binary do not run on musl/alpine.

# ---- build stage: full workspace, pnpm build ----
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY scripts ./scripts
COPY packages ./packages
RUN pnpm install --frozen-lockfile
# → packages/server/dist/{cli,server.js,mcp.js,client,migrations,scaffold}
RUN pnpm build

# ---- runtime stage: dist bundle + Linux-native runtime deps ----
FROM node:22-bookworm-slim
# docker CLI + compose plugin: per-workspace service stacks (decision 011) let a project
# declare a Docker Compose sidecar (e.g. a postgres). The agents run INSIDE this container and
# shell out to `docker compose up` for that stack, so the client + `compose` plugin must exist
# here. We install the CLI ONLY (docker-ce-cli + docker-compose-plugin) from Docker's official
# apt repo — NOT the daemon: the daemon is provided externally via DooD (host socket mount) or
# DinD (sidecar), see docker-compose.yml / docker-compose.dind.yml. Debian's `docker.io` pulls
# in the whole engine (heavy, and its compose is the deprecated v1); Docker's repo gives a lean,
# current CLI + the v2 `compose` subcommand this project invokes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && apt-get purge -y gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 # Pre-activate pnpm (worktree setup scripts run `pnpm install -r`) so first use doesn't
 # hit corepack's interactive download prompt at runtime.
 && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare pnpm@10.12.1 --activate \
 && npm install -g @anthropic-ai/claude-code \
 # Bind-mounted repos are owned by arbitrary host UIDs; without this every git call fails
 # with "dubious ownership".
 && git config --system safe.directory '*'
WORKDIR /app
COPY --from=build /app/packages/server/package.json ./package.json
COPY --from=build /app/packages/server/bin ./bin
COPY --from=build /app/packages/server/dist ./dist
# The esbuild bundle keeps hono/libsql/drizzle/claude-agent-sdk (native binary) external —
# they must be installed on Linux here, not copied from a foreign-platform build.
# devDependencies are dropped first (they contain workspace:* refs npm can't parse) and
# --legacy-peer-deps because claude-agent-sdk declares a zod@^4 peer while the app pins
# zod 3 — pnpm (the workspace's package manager) tolerates this, npm's strict resolver not.
RUN node -e "const p=require('./package.json');delete p.devDependencies;require('fs').writeFileSync('package.json',JSON.stringify(p,null,2))" \
 && npm install --omit=dev --legacy-peer-deps && npm cache clean --force
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# IS_SANDBOX=1: the container runs as root, and Claude Code refuses
# --dangerously-skip-permissions under root unless it knows it's inside a sandbox.
# buildSpawnEnv passes this through to every spawned agent.
ENV AGENTIC_KANBAN_DIR=/data \
    KANBAN_REPOS_DIR=/data/repos \
    KANBAN_HOST=0.0.0.0 \
    PORT=3001 \
    HOME=/root \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    IS_SANDBOX=1
EXPOSE 3001
VOLUME ["/data"]
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/cli/index.js", "dev", "--no-open"]
