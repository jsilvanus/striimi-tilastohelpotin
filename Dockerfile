FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8095 \
    DATA_FILE=/data/store.json \
    SECRETS_FILE=/data/secrets.enc.json

WORKDIR /app
# No runtime dependencies: only the sources are needed.
COPY package.json ./
COPY src ./src

RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/main.js"]
