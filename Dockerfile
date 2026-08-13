FROM node:18-slim
# sql.js es SQLite en WASM (100% JS): no se requieren herramientas de compilación.
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
