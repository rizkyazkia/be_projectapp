FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci
RUN npx prisma generate

FROM node:20-alpine AS runner

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

COPY prisma ./prisma/
COPY src ./src

EXPOSE 3000

CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node src/index.js"]
