FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# npm ci, а не npm install: package-lock.json в репозитории есть, сборка должна
# быть детерминированной. node_modules из контекста исключён (.dockerignore) —
# иначе COPY ниже затирал бы установленное здесь содержимым хоста.
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "3000"]
