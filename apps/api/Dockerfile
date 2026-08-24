FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/console/package.json apps/console/package.json
COPY apps/mobile/package.json apps/mobile/package.json
RUN npm ci --workspace=@cooper2talk/api --workspace=@cooper2talk/console
COPY apps/api apps/api
COPY apps/console apps/console
RUN npm run build --workspaces --if-present

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/console/package.json apps/console/package.json
COPY apps/mobile/package.json apps/mobile/package.json
RUN npm ci --omit=dev --workspace=@cooper2talk/api
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/console/dist apps/console/dist
CMD ["node", "apps/api/dist/server.js"]
