# Runtime-only image for the ty-desktop mount setup.
#
# Toolchain, engine CLIs, gateway binaries and the desktop-browser wrapper are
# baked in, but NO server source: the fork repo bind-mounts at /src and
# repo-start.sh installs, builds (only when inputs changed) and starts it on
# every boot. Fork updates are `git pull` + container restart -- rebuild this
# image only when runtime deps change.
FROM node:24-bookworm-slim
USER root
# pnpm for the boot-time repo install (pinned to packageManager).
RUN npm install -g pnpm@10.33.0
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# Same runtime set as the root Dockerfile (agent CLIs shell out to git; curl
# backs the healthcheck; the rest are Chrome's libraries), plus python3/procps
# for the gateway scripts and the browser wrapper.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client python3 procps \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
    libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0 \
    libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 \
    libcairo2 libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 \
    libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 \
    libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 \
    libxshmfence1 libgbm1 fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf \
  && rm -rf /var/lib/apt/lists/*
ARG ENGINES=""
RUN if [ -n "$ENGINES" ]; then npm install -g $ENGINES; fi
# The bots' browser: pinned agent-browser and a Chrome for Testing.
# Pin here and in server/browser-engine-release.ts together.
ARG AGENT_BROWSER_VERSION=0.37.0
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
  && HOME=/opt/openmausbot-browser agent-browser install \
  && ln -s /opt/openmausbot-browser/.agent-browser/browsers/chrome-*/chrome /opt/openmausbot-browser/chrome \
  && agent-browser --version
COPY muse-linux /opt/muse-code/
RUN chmod 755 /opt/muse-code/muse /opt/muse-code/muse-bin-* && ln -sf /opt/muse-code/muse /usr/local/bin/muse
COPY gateway /opt/gateway/
RUN ln -s /data /home/box && chmod +x /opt/gateway/entrypoint.sh /opt/gateway/gateway-init.sh
COPY browser/agent-browser-omb /usr/local/bin/agent-browser-omb
RUN chmod +x /usr/local/bin/agent-browser-omb
COPY repo-start.sh /opt/local/repo-start.sh
RUN chmod +x /opt/local/repo-start.sh
# The server runs as root: the repo is a Windows bind mount, so a non-root
# user cannot reliably write build outputs. Container-only; the bot already
# runs Full-access inside.
ENV HOME=/data \
    AGENT_BROWSER_EXECUTABLE_PATH=/opt/openmausbot-browser/chrome \
    OMB_DATA_DIR=/data/.openmausbot \
    OMB_STATIC_DIR=/src/dist \
    OMB_SRC_DIR=/src \
    OMB_PORT=8799 \
    OMB_WEBHOOK_PORT=8800 \
    NODE_ENV=production
VOLUME ["/data"]
ENTRYPOINT ["/opt/gateway/entrypoint.sh"]
CMD ["/opt/local/repo-start.sh"]
