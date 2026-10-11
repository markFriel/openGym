# openGym MCP server over Streamable HTTP, for a box that runs the api (compose next to it).
# Build from the REPO ROOT, because the training logic lives in frontend/src/lib and the
# server imports it relatively:
#     docker build -f mcp/Dockerfile -t opengym-mcp .
# Reads and writes both go through the api (remote mode); no data directory is mounted.
FROM node:22-alpine
WORKDIR /app/mcp
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY mcp/src ./src
COPY mcp/scripts ./scripts
COPY frontend/src/lib /app/frontend/src/lib
# The app's icon keys, which the routine emoji field is validated against.
COPY api/coach/core/glyphs.js /app/api/coach/core/glyphs.js
ENV MCP_PORT=8086 \
    MCP_HOST=0.0.0.0 \
    MCP_PATH=/mcp \
    OPENGYM_REMOTE=1 \
    OPENGYM_TOKEN_FILE=/token/opengym.json
# /token holds the paired token (scripts/pair.mjs writes it); bind-mount a directory the
# `node` user (uid 1000) can write.
VOLUME ["/token"]
USER node
EXPOSE 8086
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8086/mcp/health >/dev/null || exit 1
CMD ["node", "src/http.js"]
