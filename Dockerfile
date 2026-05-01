FROM node:20-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server server
COPY contract contract

ENV ARIZ_DATA_DIR=/data
VOLUME /data

CMD [ "npm", "start" ]
