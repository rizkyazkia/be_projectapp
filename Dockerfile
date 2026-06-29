FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

COPY src ./src

EXPOSE 3000

CMD ["sh", "-c", "npx prisma generate && node src/index.js"]
