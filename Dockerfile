# Use Node.js 18 with build tools
FROM node:18-slim

# Install system dependencies for NetCDF4
RUN apt-get update && apt-get install -y \
    libnetcdf-dev \
    libhdf5-dev \
    build-essential \
    python3 \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (for better caching)
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create uploads directory
RUN mkdir -p uploads

# Expose port (Render will set PORT environment variable)
EXPOSE 10000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT:-10000}/api/health || exit 1

# Start the application
CMD ["npm", "start"]
