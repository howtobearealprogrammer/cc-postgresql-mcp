/**
 * File: src/index.ts
 * Author: Claude
 * Last Updated: 2025-12-14
 * Description: Main MCP server implementation for PostgreSQL with OpenTelemetry
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  Tool,
  Prompt,
} from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
import { config } from './config.js';
import {
  initTelemetry,
  shutdownTelemetry,
  startSpan,
  recordToolCall,
  recordQueryDuration,
  recordQueryError,
  recordQueryRows,
  recordQueryBytes,
} from './telemetry.js';
import { log } from './logger.js';

const { Pool } = pg;

// Initialize telemetry
initTelemetry();

// Create PostgreSQL connection pool
const pool = new Pool({
  host: config.postgresql.host,
  port: config.postgresql.port,
  user: config.postgresql.user,
  password: config.postgresql.password,
  database: config.postgresql.database,
  max: config.postgresql.connectionLimit,
  ssl: config.postgresql.ssl ? { rejectUnauthorized: false } : undefined,
});

// Define available tools
const TOOLS: Tool[] = [
  {
    name: 'onboarding',
    description: 'Get comprehensive guidance on how to use this PostgreSQL MCP server efficiently, including available tools, best practices, and example workflows',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_tables',
    description: 'List all tables in the configured database (public schema by default)',
    inputSchema: {
      type: 'object',
      properties: {
        schema: {
          type: 'string',
          description: 'Schema name (defaults to "public")',
        },
      },
    },
  },
  {
    name: 'get_table_schema',
    description: 'Get the complete schema information for a specific table including columns, types, keys, and constraints',
    inputSchema: {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          description: 'Name of the table',
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to "public")',
        },
      },
      required: ['table'],
    },
  },
  {
    name: 'execute_query',
    description: 'Execute a SQL query and return results. Supports both read (SELECT) and write (INSERT, UPDATE, DELETE) operations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'SQL query to execute',
        },
      },
      required: ['query'],
    },
  },
];

// Define available prompts
const PROMPTS: Prompt[] = [
  {
    name: 'postgresql-onboarding',
    description: 'Get guidance on how to efficiently use this PostgreSQL MCP server',
  },
];

// Create MCP server
const server = new Server(
  {
    name: 'cc-postgresql',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  }
);

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Prompt handlers
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: PROMPTS };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const promptName = request.params.name;

  if (promptName === 'postgresql-onboarding') {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `You are connected to a PostgreSQL database server via MCP. Here's how to use this server efficiently:

## Available Tools

1. **list_tables** - List all tables in the database
   - Optional parameter: schema (string, defaults to "public")
   - Returns: Array of table names
   - Example: Use this first to see what tables are available

2. **get_table_schema** - Get complete schema for a specific table
   - Parameters: table (string, required) - name of the table
   - Optional parameter: schema (string, defaults to "public")
   - Returns: Column definitions, indexes, foreign keys, and constraints
   - Example: Use this to understand table structure before querying

3. **execute_query** - Execute any SQL query (SELECT, INSERT, UPDATE, DELETE, etc.)
   - Parameters: query (string) - SQL query to execute
   - Returns: For SELECT: rows and field info; For DML: affected rows
   - Example: Run queries based on the schema you've discovered

## Recommended Workflow

1. **Start by listing tables**: Use list_tables to see what's in the database
2. **Examine schemas**: Use get_table_schema on relevant tables to understand structure
3. **Execute queries**: Use execute_query to retrieve or modify data

## Best Practices

- Always examine table schemas before writing complex queries
- Use parameterized queries - the execute_query tool handles them safely
- For exploratory analysis, start with simple SELECT queries with LIMIT clauses
- Check column types and constraints from get_table_schema to avoid type errors
- Use JOINs appropriately based on foreign key relationships shown in schema
- PostgreSQL uses double quotes for identifiers: "table_name"

## Current Configuration

- Database: ${config.postgresql.database || 'Not set - will need to specify database in queries'}
- Host: ${config.postgresql.host}:${config.postgresql.port}

## Example Session

1. list_tables → See all available tables
2. get_table_schema(table: "users") → Understand users table structure
3. execute_query(query: "SELECT * FROM users LIMIT 10") → Retrieve sample data
4. execute_query(query: "SELECT COUNT(*) as total FROM users") → Get statistics

Now you're ready to explore the database! What would you like to do first?`,
          },
        },
      ],
    };
  }

  throw new Error(`Unknown prompt: ${promptName}`);
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  recordToolCall(toolName);

  const span = startSpan(`tool.${toolName}`);
  const startTime = Date.now();

  try {
    let result: any;

    switch (toolName) {
      case 'onboarding':
        result = await handleOnboarding();
        break;

      case 'list_tables':
        result = await handleListTables(
          request.params.arguments as { schema?: string }
        );
        break;

      case 'get_table_schema':
        result = await handleGetTableSchema(
          request.params.arguments as { table: string; schema?: string }
        );
        break;

      case 'execute_query': {
        const queryArgs = request.params.arguments as { query: string };
        const queryType = detectQueryType(queryArgs.query);
        if (span) {
          span.setAttribute('query.type', queryType);
        }
        result = await handleExecuteQuery(queryArgs);
        break;
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }

    const duration = Date.now() - startTime;
    recordQueryDuration(duration, toolName);

    if (span) {
      span.setAttribute('success', true);

      // Add result metrics to span for execute_query
      if (toolName === 'execute_query' && result) {
        if (result.rowCount !== undefined) {
          span.setAttribute('query.rows', result.rowCount);
        }
      }

      span.end();
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    recordQueryDuration(duration, toolName);
    recordQueryError(toolName, errorMessage);

    if (span) {
      span.setAttribute('success', false);
      span.setAttribute('error', errorMessage);
      span.end();
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: errorMessage,
          }),
        },
      ],
      isError: true,
    };
  }
});

async function handleOnboarding() {
  return {
    guide: `Welcome to the PostgreSQL MCP Server!`,
    description: `This server provides tools to explore and query PostgreSQL databases efficiently.`,

    configuration: {
      database: config.postgresql.database || 'Not set - queries will need to specify database',
      host: `${config.postgresql.host}:${config.postgresql.port}`,
    },

    available_tools: [
      {
        name: 'list_tables',
        purpose: 'List all tables in the database',
        parameters: 'schema (optional, defaults to "public")',
        returns: 'Array of table names',
        when_to_use: 'Use this first to discover what tables exist in the database',
        example: 'Call list_tables to see: ["users", "products", "orders", ...]',
      },
      {
        name: 'get_table_schema',
        purpose: 'Get complete schema information for a specific table',
        parameters: 'table: string (required), schema: string (optional)',
        returns: 'Column definitions, data types, indexes, foreign keys, and constraints',
        when_to_use: 'Use this to understand table structure before writing queries',
        example: 'get_table_schema(table: "users") returns all column info, constraints, and indexes',
      },
      {
        name: 'execute_query',
        purpose: 'Execute any SQL query (SELECT, INSERT, UPDATE, DELETE, etc.)',
        parameters: 'query: string (SQL query to execute)',
        returns: 'For SELECT: rows and field info; For DML: affected rows',
        when_to_use: 'Use this to retrieve or modify data after understanding the schema',
        example: 'execute_query(query: "SELECT * FROM users LIMIT 10")',
      },
    ],

    recommended_workflow: [
      '1. Start with list_tables to see all available tables',
      '2. Use get_table_schema on relevant tables to understand their structure',
      '3. Execute queries using execute_query based on the schema information',
      '4. For complex queries, examine foreign key relationships from schema info',
    ],

    best_practices: [
      'Always examine table schemas before writing complex queries',
      'Use LIMIT clauses for exploratory SELECT queries',
      'Check column types and constraints from get_table_schema to avoid errors',
      'PostgreSQL uses double quotes for identifiers with special characters',
      'Use JOINs based on foreign key relationships shown in schema',
      'Start with simple queries and build complexity iteratively',
    ],

    example_session: {
      step_1: {
        action: 'list_tables',
        result: 'Returns all table names in the database',
      },
      step_2: {
        action: 'get_table_schema(table: "users")',
        result: 'Returns complete schema: columns, types, indexes, foreign keys',
      },
      step_3: {
        action: 'execute_query(query: "SELECT COUNT(*) as total FROM users")',
        result: 'Returns row count',
      },
      step_4: {
        action: 'execute_query(query: "SELECT * FROM users LIMIT 10")',
        result: 'Returns first 10 user records',
      },
    },

    tips: [
      'Complex queries: Always check schema first to understand relationships',
      'Performance: Use indexes (shown in schema) for WHERE clauses',
      'Debugging: Start with COUNT(*) queries to verify data exists',
      'Exploration: Use ORDER BY and LIMIT for sampling data',
      'PostgreSQL-specific: Use ILIKE for case-insensitive pattern matching',
    ],
  };
}

async function handleListTables(args: { schema?: string }) {
  const schemaName = args.schema || 'public';
  const queryStartTime = Date.now();

  const result = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schemaName]
  );

  const queryDuration = Date.now() - queryStartTime;

  const tables = result.rows.map((row) => row.table_name);
  const resultData = {
    database: config.postgresql.database,
    schema: schemaName,
    tables,
  };

  // Record metrics
  const payloadSize = calculatePayloadSize(resultData);
  recordQueryRows(tables.length, 'SELECT', 'list_tables');
  recordQueryBytes(payloadSize, 'SELECT', 'list_tables');
  recordQueryDuration(queryDuration, 'list_tables.SELECT');

  return resultData;
}

async function handleGetTableSchema(args: { table: string; schema?: string }) {
  const schemaName = args.schema || 'public';
  const queryStartTime = Date.now();

  // Get column information
  const columnsResult = await pool.query(
    `SELECT
       column_name,
       data_type,
       character_maximum_length,
       numeric_precision,
       numeric_scale,
       is_nullable,
       column_default,
       udt_name
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schemaName, args.table]
  );

  // Get primary key information
  const pkResult = await pool.query(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = $1
       AND tc.table_name = $2`,
    [schemaName, args.table]
  );
  const primaryKeys = pkResult.rows.map((row) => row.column_name);

  // Get indexes
  const indexesResult = await pool.query(
    `SELECT
       indexname,
       indexdef
     FROM pg_indexes
     WHERE schemaname = $1 AND tablename = $2`,
    [schemaName, args.table]
  );

  // Get foreign keys
  const fkResult = await pool.query(
    `SELECT
       kcu.column_name,
       ccu.table_schema AS foreign_table_schema,
       ccu.table_name AS foreign_table_name,
       ccu.column_name AS foreign_column_name,
       tc.constraint_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = $1
       AND tc.table_name = $2`,
    [schemaName, args.table]
  );

  // Get unique constraints
  const uniqueResult = await pool.query(
    `SELECT kcu.column_name, tc.constraint_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'UNIQUE'
       AND tc.table_schema = $1
       AND tc.table_name = $2`,
    [schemaName, args.table]
  );

  // Get check constraints
  const checkResult = await pool.query(
    `SELECT
       cc.constraint_name,
       cc.check_clause
     FROM information_schema.check_constraints cc
     JOIN information_schema.table_constraints tc
       ON cc.constraint_name = tc.constraint_name
       AND cc.constraint_schema = tc.table_schema
     WHERE tc.table_schema = $1 AND tc.table_name = $2
       AND tc.constraint_type = 'CHECK'`,
    [schemaName, args.table]
  );

  const queryDuration = Date.now() - queryStartTime;

  // Format columns with enriched information
  const columns = columnsResult.rows.map((col) => ({
    name: col.column_name,
    type: col.data_type,
    udtName: col.udt_name,
    maxLength: col.character_maximum_length,
    precision: col.numeric_precision,
    scale: col.numeric_scale,
    nullable: col.is_nullable === 'YES',
    default: col.column_default,
    isPrimaryKey: primaryKeys.includes(col.column_name),
  }));

  const resultData = {
    database: config.postgresql.database,
    schema: schemaName,
    table: args.table,
    columns,
    primaryKeys,
    indexes: indexesResult.rows,
    foreignKeys: fkResult.rows,
    uniqueConstraints: uniqueResult.rows,
    checkConstraints: checkResult.rows,
  };

  // Record metrics
  const payloadSize = calculatePayloadSize(resultData);
  const totalRows = columnsResult.rows.length + indexesResult.rows.length;
  recordQueryRows(totalRows, 'SELECT', 'get_table_schema');
  recordQueryBytes(payloadSize, 'SELECT', 'get_table_schema');
  recordQueryDuration(queryDuration, 'get_table_schema.SELECT');

  return resultData;
}

// Helper function to detect query type from SQL
function detectQueryType(query: string): string {
  const normalized = query.trim().toUpperCase();
  if (normalized.startsWith('SELECT')) return 'SELECT';
  if (normalized.startsWith('INSERT')) return 'INSERT';
  if (normalized.startsWith('UPDATE')) return 'UPDATE';
  if (normalized.startsWith('DELETE')) return 'DELETE';
  if (normalized.startsWith('CREATE')) return 'CREATE';
  if (normalized.startsWith('ALTER')) return 'ALTER';
  if (normalized.startsWith('DROP')) return 'DROP';
  if (normalized.startsWith('TRUNCATE')) return 'TRUNCATE';
  if (normalized.startsWith('WITH')) return 'WITH'; // CTEs
  if (normalized.startsWith('EXPLAIN')) return 'EXPLAIN';
  if (normalized.startsWith('ANALYZE')) return 'ANALYZE';
  if (normalized.startsWith('VACUUM')) return 'VACUUM';
  return 'OTHER';
}

// Helper function to calculate payload size in bytes
function calculatePayloadSize(data: any): number {
  try {
    return Buffer.byteLength(JSON.stringify(data), 'utf8');
  } catch {
    return 0;
  }
}

async function handleExecuteQuery(args: { query: string }) {
  const client = await pool.connect();
  const queryType = detectQueryType(args.query);
  const queryStartTime = Date.now();

  try {
    const result = await client.query(args.query);
    const queryDuration = Date.now() - queryStartTime;

    // Handle different result types
    if (queryType === 'SELECT' || queryType === 'WITH' || queryType === 'EXPLAIN') {
      // SELECT-type queries
      const resultData = {
        rowCount: result.rowCount,
        rows: result.rows,
        fields: result.fields?.map((f) => ({
          name: f.name,
          dataTypeID: f.dataTypeID,
        })),
      };

      // Record metrics for SELECT queries
      const payloadSize = calculatePayloadSize(result.rows);
      recordQueryRows(result.rowCount || 0, queryType, 'execute_query');
      recordQueryBytes(payloadSize, queryType, 'execute_query');
      recordQueryDuration(queryDuration, `execute_query.${queryType}`);

      return resultData;
    } else {
      // For INSERT, UPDATE, DELETE, etc.
      const resultData = {
        rowCount: result.rowCount,
        command: result.command,
      };

      // Record metrics for DML queries
      const payloadSize = calculatePayloadSize(resultData);
      recordQueryRows(result.rowCount || 0, queryType, 'execute_query');
      recordQueryBytes(payloadSize, queryType, 'execute_query');
      recordQueryDuration(queryDuration, `execute_query.${queryType}`);

      return resultData;
    }
  } finally {
    client.release();
  }
}

// Start server
async function main() {
  // Test PostgreSQL connection before starting server
  log('Testing PostgreSQL connection...');
  try {
    const client = await pool.connect();
    log('✓ PostgreSQL connection successful');
    client.release();
  } catch (error) {
    log('✗ PostgreSQL connection failed: ' + (error instanceof Error ? error.message : String(error)));
    log('Please check your PostgreSQL credentials and ensure the server is running.');
    log('');
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('PostgreSQL MCP Server running on stdio');
  log(`Connected to PostgreSQL at ${config.postgresql.host}:${config.postgresql.port}`);
  if (config.postgresql.database) {
    log(`Default database: ${config.postgresql.database}`);
  }
  log('');
}

// Cleanup on exit
process.on('SIGINT', async () => {
  console.error('\nShutting down...');
  await pool.end();
  await shutdownTelemetry();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('\nShutting down...');
  await pool.end();
  await shutdownTelemetry();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
