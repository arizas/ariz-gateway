FROM node:20
COPY server server
COPY package.json package.json
COPY yarn.lock yarn.lock
