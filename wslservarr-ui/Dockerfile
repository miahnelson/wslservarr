FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache docker-cli docker-cli-compose bash
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 5055
CMD ["npm", "start"]
