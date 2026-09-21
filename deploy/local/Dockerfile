ARG BASE_IMAGE=ghcr.io/milind-soni/openmausbot:latest
FROM ${BASE_IMAGE}
USER root
ARG ENGINES="@anthropic-ai/claude-code @openai/codex"
RUN if [ -n "$ENGINES" ]; then npm install -g $ENGINES; fi
COPY muse-linux /opt/muse-code/
RUN chmod 755 /opt/muse-code/muse /opt/muse-code/muse-bin-* && ln -sf /opt/muse-code/muse /usr/local/bin/muse && chown -R maus:maus /opt/muse-code
RUN apt-get update && apt-get install -y --no-install-recommends python3 procps && rm -rf /var/lib/apt/lists/*
COPY gateway /opt/gateway/
RUN ln -s /data /home/box && chmod +x /opt/gateway/entrypoint.sh /opt/gateway/gateway-init.sh
COPY browser/agent-browser-omb /usr/local/bin/agent-browser-omb
RUN chmod +x /usr/local/bin/agent-browser-omb
ENTRYPOINT ["/opt/gateway/entrypoint.sh"]
CMD ["node", "dist-server/index.js"]
USER maus
