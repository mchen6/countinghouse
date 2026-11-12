# A clean machine for one test run: Node, its own Redis, the working tree's
# files as git sees them (tracked, and untracked but not ignored; nothing
# .gitignore'd, so no local auth file, database or log), a non-root user.
# Built and run by scripts/run-in-docker.js, which sends that file list as
# the build context and gives each container its own network namespace
# (--network none), so its Redis and its ports cannot meet another run's or
# the host's (docs/testing.md).
#
#   NODE_VERSION  22.16.0 (the floor) or 24 (the newest 24.x); default 24
#
# Two stages. sqlite3 (an optional dependency) ships a prebuild that needs
# glibc 2.38, newer than Debian 12's 2.36, so the dependencies are installed
# in the full image, which has a compiler, with sqlite3 built from source; the
# run stage is the slim image with those node_modules and Redis, and no
# toolchain.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm AS deps
USER node
WORKDIR /home/node/countinghouse
COPY --chown=node:node package.json package-lock.json ./
# npm's own cache is a build cache mount, kept between builds and not in the
# image; this layer is reused until package.json or the lock file changes.
# npm ci: exactly the lock file's tree, or the build fails.
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 \
    npm_config_build_from_source=true npm ci --legacy-peer-deps --no-audit --no-fund

FROM node:${NODE_VERSION}-bookworm-slim
LABEL org.countinghouse.test=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends redis-server \
 && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /home/node/countinghouse
COPY --from=deps --chown=node:node /home/node/countinghouse/node_modules ./node_modules
COPY --chown=node:node . .

ENTRYPOINT ["/home/node/countinghouse/test/docker/entrypoint.sh"]
CMD ["node", "scripts/run-tests.js"]
