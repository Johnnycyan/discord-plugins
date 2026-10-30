FROM node:22-alpine

WORKDIR /app
COPY server.mjs .

# Favorites are stored in /data; mount a volume there to keep them
RUN mkdir /data && chown node:node /data
VOLUME /data

ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_FILE=/data/favorites.json

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/v1/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "server.mjs"]
