# Use Node.js LTS version
FROM node:18-alpine

# Metadata for version 2.0
LABEL version="2.0.0"
LABEL description="Collaborative copy/paste app with enhanced features"
LABEL maintainer="Carlos Andrade <carlos@perezandrade.com>"
LABEL features="dark-mode,search-replace,typing-indicators,chat,mobile-responsive,drag-drop,notifications,sounds"

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create a non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001

# Change ownership of the app directory
RUN chown -R nodejs:nodejs /app
USER nodejs

# Expose port 3000
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1

# Start the application
CMD ["npm", "start"]