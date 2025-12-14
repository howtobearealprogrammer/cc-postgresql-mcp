/**
 * File: src/config.ts
 * Author: Claude
 * Last Updated: 2025-12-14
 * Description: Configuration loader for PostgreSQL MCP server
 */

import { config as dotenvConfig } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { log } from './logger.js';

dotenvConfig();

export interface PostgreSQLConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  connectionLimit: number;
  ssl?: boolean;
}

export interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
}

export interface LoggingConfig {
  enabled: boolean;
  logPath?: string;
}

export interface Config {
  postgresql: PostgreSQLConfig;
  telemetry: TelemetryConfig;
  logging: LoggingConfig;
}

function loadConfig(): Config {
  // Try to load from config file if specified
  const configPath = process.env.CONFIG_PATH;
  if (configPath) {
    try {
      const configFile = readFileSync(resolve(configPath), 'utf-8');
      return JSON.parse(configFile);
    } catch (error) {
      console.error(`Failed to load config from ${configPath}:`, error);
      process.exit(1);
    }
  }

  // Fall back to environment variables
  const rawPassword = process.env.PGPASSWORD || '';

  // URL-decode password if it appears to be encoded
  let decodedPassword = rawPassword;
  if (rawPassword.includes('%')) {
    try {
      decodedPassword = decodeURIComponent(rawPassword);
    } catch (error) {
      // If decoding fails, use raw password
      decodedPassword = rawPassword;
    }
  }

  // Build OpenTelemetry endpoint
  // Priority: OTEL_ENDPOINT (full URL) > OTEL_HOST + OTEL_PORT (construct URL)
  let otelEndpoint: string;
  if (process.env.OTEL_ENDPOINT) {
    otelEndpoint = process.env.OTEL_ENDPOINT;
  } else {
    const otelHost = process.env.OTEL_HOST || 'localhost';
    const otelPort = process.env.OTEL_PORT || '4318';
    const otelProtocol = process.env.OTEL_PROTOCOL || 'http';
    otelEndpoint = `${otelProtocol}://${otelHost}:${otelPort}`;
  }

  const config = {
    postgresql: {
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      user: process.env.PGUSER || 'postgres',
      password: decodedPassword,
      database: process.env.PGDATABASE,
      connectionLimit: parseInt(process.env.PG_CONNECTION_LIMIT || '10', 10),
      ssl: process.env.PGSSLMODE === 'require',
    },
    telemetry: {
      enabled: process.env.OTEL_ENABLED === 'true',
      endpoint: otelEndpoint,
      serviceName: process.env.OTEL_SERVICE_NAME || 'cc-postgresql',
    },
    logging: {
      enabled: process.env.LOG_ENABLED === 'true',
      logPath: process.env.LOG_PATH,
    },
  };

  // Log configuration (mask password)
  log('Configuration loaded:');
  log(`  PostgreSQL Host: ${config.postgresql.host}:${config.postgresql.port}`);
  log(`  PostgreSQL User: ${config.postgresql.user}`);
  log(`  PostgreSQL Password: ${config.postgresql.password ? '[SET]' : '[NOT SET]'}`);
  log(`  PostgreSQL Database: ${config.postgresql.database || '[NOT SET]'}`);
  log(`  Connection Limit: ${config.postgresql.connectionLimit}`);
  log(`  SSL Mode: ${config.postgresql.ssl ? 'require' : 'disabled'}`);
  log(`  Telemetry Enabled: ${config.telemetry.enabled}`);
  if (config.telemetry.enabled) {
    log(`  Telemetry Endpoint: ${config.telemetry.endpoint}`);
    log(`  Telemetry Service: ${config.telemetry.serviceName}`);
  }
  log('');

  return config;
}

export const config = loadConfig();