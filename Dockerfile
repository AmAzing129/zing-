# Personal station. Talk over Telegram; life lives in ZING_HOME.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY plugins/channels/telegram/package.json plugins/channels/telegram/package.json
COPY plugins/tools/mcp/package.json plugins/tools/mcp/package.json
COPY plugins/triggers/schedule/package.json plugins/triggers/schedule/package.json
RUN npm ci

COPY tsconfig.json agent.yaml station.yaml ./
COPY src ./src
COPY plugins ./plugins
COPY skills ./skills
COPY examples ./examples
COPY docker-entrypoint.sh /usr/local/bin/zing-entrypoint
RUN chmod +x /usr/local/bin/zing-entrypoint \
  && mkdir -p /zing \
  && chown -R node:node /app /zing

ENV NODE_ENV=production \
    ZING_HOME=/zing

USER node
VOLUME ["/zing"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["zing-entrypoint"]
