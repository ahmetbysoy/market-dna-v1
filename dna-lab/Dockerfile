# Market DNA V1 — sıfır bağımlılıklı Node.js sunucusu (kalıcı süreç!)
# Build: cd dna-lab && docker build -t market-dna .
# Run:   docker run -p 3000:3000 -v market-dna-data:/app/data market-dna
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DNA_JSONL_MAX_BYTES=33554432
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data /app/audit/live
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server.js"]
