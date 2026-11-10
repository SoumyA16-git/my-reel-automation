FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Copy package files
COPY package.json tsconfig.json ./
RUN npm install

# Copy source and build
COPY src/ ./src/
RUN npx tsc

USER pwuser

EXPOSE 4000

ENV PORT=4000 \
    HOST=0.0.0.0 \
    NODE_ENV=production

CMD ["node", "dist/index.js"]

