FROM node:24-slim

# The server keeps each book in a git repository.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY fixtures ./fixtures

# Pre-create the data directory, so a new named volume inherits this owner.
RUN mkdir -p /data && chown node:node /data
USER node
ENV REWRITE_DATA_DIR=/data
ENV PORT=8080
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/server/main.ts"]
