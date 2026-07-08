# Peptide Dose Planner — minimal self-hosting image.
# Uses Node's built-in SQLite + test runner, so there are no dependencies to install.
FROM node:22-alpine

WORKDIR /app

# App source. node_modules is unnecessary (no third-party deps), so a plain copy is enough.
COPY package.json server.js index.html styles.css manifest.webmanifest ./
COPY icon.svg icon-512.png apple-touch-icon.png ./
COPY src/ ./src/

# Persisted planner database lives here; mount a volume to keep it across restarts.
ENV SHOTS_DATA_DIR=/data
ENV HOST=0.0.0.0
ENV PORT=4173
VOLUME ["/data"]
EXPOSE 4173

CMD ["node", "server.js"]
