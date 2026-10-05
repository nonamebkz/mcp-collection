import pg from 'pg';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

/**
 * PostgreSQL MCP Server — read-only by default, mutation guard for AI agents.
 *
 * Dependencies:
 *   pnpm install @modelcontextprotocol/server pg zod
 *
 * Environment variables:
 *   DB_HOST=127.0.0.1
 *   DB_PORT=5432
 *   DB_USER=postgres
 *   DB_PASSWORD=secret
 *   DB_NAME=postgres
 *   DB_SCHEMA=public
 *   DB_CONNECTION_LIMIT=5
 *   DB_READ_ONLY=true          (default: true — blocks write tool registration)
 *   DB_WRITE_TOKEN=secret      (required when DB_READ_ONLY=false)
 *   DB_ALLOW_DELETE=false      (default: false — DELETE always blocked unless true)
 */

const READ_ONLY = process.env.DB_READ_ONLY !== 'false';
const WRITE_TOKEN = process.env.DB_WRITE_TOKEN || '';
const ALLOW_DELETE = process.env.DB_ALLOW_DELETE === 'true';

/** Env passwords may be URL-encoded in JSON (e.g. %40 for @). */
function readPassword() {
  const raw = process.env.DB_PASSWORD;
  if (raw == null || raw === '') {
    return '';
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return String(raw);
  }
}

const pool = new pg.Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: readPassword(),
  database: process.env.DB_NAME || 'postgres',
  max: Number(process.env.DB_CONNECTION_LIMIT || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 15_000),
});

const server = new McpServer({
  name: 'postgres-guarded-mcp',
  version: '2.0.1',
});

function stripQuotedStrings(sql) {
  return sql
    .replace(/\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'([^'\\]|\\.|'')*'/g, "''")
    .replace(/\"([^\"\\]|\\.)*\"/g, '""');
}

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ');
}

function normalizeForInspection(sql) {
  return stripComments(stripQuotedStrings(sql))
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureSingleStatement(sql) {
  const normalized = normalizeForInspection(sql);
  const trimmed = normalized.endsWith(';')
    ? normalized.slice(0, -1).trim()
    : normalized;

  if (trimmed.includes(';')) {
    throw new Error('Hanya satu SQL statement per request yang diizinkan.');
  }
}

function ensureNoDml(sql) {
  const normalized = normalizeForInspection(sql);
  const blocked = [];

  if (/\binsert\b/i.test(normalized)) blocked.push('INSERT');
  if (/\bupdate\b/i.test(normalized)) blocked.push('UPDATE');
  if (/\bdelete\b/i.test(normalized)) blocked.push('DELETE');
  if (/\btruncate\b/i.test(normalized)) blocked.push('TRUNCATE');
  if (/\bmerge\b/i.test(normalized)) blocked.push('MERGE');

  if (blocked.length > 0) {
    throw new Error(
      `Statement ${blocked.join(', ')} diblokir. Gunakan tool postgres_execute dengan token write yang valid jika mutasi diizinkan.`
    );
  }
}

function ensureNoDelete(sql) {
  const normalized = normalizeForInspection(sql);
  if (/\bdelete\b/i.test(normalized)) {
    throw new Error('Statement DELETE diblokir oleh guard server MCP ini.');
  }
  if (/\btruncate\b/i.test(normalized)) {
    throw new Error('Statement TRUNCATE diblokir oleh guard server MCP ini.');
  }
}

function ensureReadOnlyQuery(sql) {
  const normalized = normalizeForInspection(sql);
  if (!/^(select|with|explain|table)\b/i.test(normalized)) {
    throw new Error(
      'Tool ini hanya menerima SELECT, WITH, EXPLAIN, atau TABLE.'
    );
  }
}

function ensureWriteAllowed(sql) {
  const normalized = normalizeForInspection(sql);
  if (/^(select|with|explain|table)\b/i.test(normalized)) {
    throw new Error(
      'Gunakan tool postgres_select atau tool schema untuk query baca.'
    );
  }
}

function ensureMutationAllowed(sql) {
  const normalized = normalizeForInspection(sql);
  const isMutation =
    /\b(insert|update|delete|merge|truncate)\b/i.test(normalized);

  if (!isMutation) return;

  if (READ_ONLY) {
    throw new Error(
      'Mutasi data (INSERT/UPDATE/DELETE) diblokir: DB_READ_ONLY=true (default). Set DB_READ_ONLY=false dan sediakan DB_WRITE_TOKEN untuk mengizinkan.'
    );
  }

  if (/\b(delete|truncate)\b/i.test(normalized) && !ALLOW_DELETE) {
    throw new Error(
      'DELETE/TRUNCATE diblokir: set DB_ALLOW_DELETE=true jika benar-benar diperlukan.'
    );
  }
}

function assertWriteToken(token) {
  if (READ_ONLY) {
    throw new Error(
      'Tool write tidak aktif. Set DB_READ_ONLY=false untuk mengaktifkan postgres_execute.'
    );
  }
  if (!WRITE_TOKEN) {
    throw new Error(
      'DB_WRITE_TOKEN belum diset. Wajib diset saat DB_READ_ONLY=false agar AI agent tidak bisa menulis tanpa token eksplisit.'
    );
  }
  if (token !== WRITE_TOKEN) {
    throw new Error('write_token tidak valid. Mutasi ditolak.');
  }
}

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return value.toString('base64');
  }
  return value;
}

function toJsonText(data) {
  return JSON.stringify(data, jsonReplacer, 2);
}

function textResult(title, payload) {
  return {
    content: [
      {
        type: 'text',
        text: `${title}\n\n${toJsonText(payload)}`,
      },
    ],
  };
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function runSelect(sql, params = []) {
  ensureSingleStatement(sql);
  ensureNoDml(sql);
  ensureReadOnlyQuery(sql);

  const result = await pool.query(sql, params);

  return {
    rowCount: result.rowCount ?? result.rows.length,
    rows: result.rows,
  };
}

async function runExecute(sql, params = [], writeToken) {
  assertWriteToken(writeToken);
  ensureSingleStatement(sql);
  ensureWriteAllowed(sql);
  ensureMutationAllowed(sql);
  if (!ALLOW_DELETE) {
    ensureNoDelete(sql);
  }

  const result = await pool.query(sql, params);

  if (result.rows?.length > 0 && result.command === 'SELECT') {
    return {
      type: 'resultset',
      rowCount: result.rowCount,
      rows: result.rows,
    };
  }

  return {
    type: 'write',
    command: result.command,
    rowCount: result.rowCount ?? 0,
    rows: result.rows?.length ? result.rows : undefined,
  };
}

async function resolveSchema(schema) {
  if (schema) return schema;
  if (process.env.DB_SCHEMA) return process.env.DB_SCHEMA;
  return 'public';
}

async function resolveDatabase(database) {
  const current = await pool.query('SELECT current_database() AS db');
  const connected = current.rows?.[0]?.db;

  if (database && database !== connected) {
    throw new Error(
      `Database "${database}" berbeda dari koneksi aktif "${connected}". Set DB_NAME atau buat koneksi MCP terpisah.`
    );
  }

  if (connected) return connected;
  if (process.env.DB_NAME) return process.env.DB_NAME;

  throw new Error(
    'Database tidak ditentukan. Set DB_NAME atau sambungkan ke database PostgreSQL.'
  );
}

async function fetchSchema(schemaName, table) {
  const schema = await resolveSchema(schemaName);
  const tableFilter = table ? 'AND c.table_name = $2' : '';
  const tableParams = table ? [schema, table] : [schema];

  const tables = await pool.query(
    `SELECT table_catalog, table_schema, table_name, table_type
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_type IN ('BASE TABLE', 'VIEW')
       ${tableFilter}
     ORDER BY table_name`,
    tableParams
  );

  const columns = await pool.query(
    `SELECT table_catalog, table_schema, table_name, column_name, ordinal_position,
            column_default, is_nullable, data_type, udt_name, character_maximum_length,
            numeric_precision, numeric_scale, datetime_precision, is_identity, identity_generation
     FROM information_schema.columns
     WHERE table_schema = $1 ${tableFilter}
     ORDER BY table_name, ordinal_position`,
    tableParams
  );

  const indexes = await pool.query(
    `SELECT schemaname, tablename, indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = $1 ${table ? 'AND tablename = $2' : ''}
     ORDER BY tablename, indexname`,
    tableParams
  );

  const foreignKeys = await pool.query(
    `SELECT
       tc.table_schema,
       tc.table_name,
       tc.constraint_name,
       kcu.column_name,
       ccu.table_schema AS foreign_table_schema,
       ccu.table_name AS foreign_table_name,
       ccu.column_name AS foreign_column_name,
       rc.update_rule,
       rc.delete_rule
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = $1
       ${table ? 'AND tc.table_name = $2' : ''}
     ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`,
    tableParams
  );

  const db = await resolveDatabase();

  return {
    database: db,
    schema,
    table: table || null,
    tableCount: tables.rows.length,
    tables: tables.rows,
    columns: columns.rows,
    indexes: indexes.rows,
    foreignKeys: foreignKeys.rows,
  };
}

async function fetchCreateTableDdl(schemaName, table) {
  const schema = await resolveSchema(schemaName);
  const safeTable = String(table).replace(/"/g, '');

  const columns = await pool.query(
    `SELECT column_name, data_type, udt_name, character_maximum_length,
            numeric_precision, numeric_scale, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, safeTable]
  );

  if (columns.rows.length === 0) {
    throw new Error(`Tabel ${schema}.${safeTable} tidak ditemukan.`);
  }

  const parts = columns.rows.map((col) => {
    let type = col.data_type === 'USER-DEFINED' ? col.udt_name : col.data_type;
    if (col.character_maximum_length) {
      type += `(${col.character_maximum_length})`;
    } else if (col.numeric_precision) {
      type +=
        col.numeric_scale != null
          ? `(${col.numeric_precision},${col.numeric_scale})`
          : `(${col.numeric_precision})`;
    }
    const nullable = col.is_nullable === 'NO' ? ' NOT NULL' : '';
    const defaultVal =
      col.column_default != null ? ` DEFAULT ${col.column_default}` : '';
    return `  ${quoteIdent(col.column_name)} ${type}${defaultVal}${nullable}`;
  });

  const ddl = `CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(safeTable)} (\n${parts.join(',\n')}\n);`;

  return {
    database: await resolveDatabase(),
    schema,
    table: safeTable,
    ddl,
    note: 'DDL disusun dari information_schema (tanpa constraint/index/FK). Gunakan postgres_get_schema untuk detail lengkap.',
  };
}

async function closePool() {
  try {
    await pool.end();
  } catch {
    // ignore shutdown errors
  }
}

server.registerTool(
  'postgres_ping',
  {
    description: 'Test koneksi PostgreSQL dan kembalikan status server.',
    inputSchema: z.object({}),
  },
  async () => {
    const [ping, version, current] = await Promise.all([
      pool.query('SELECT 1 AS ok'),
      pool.query('SELECT version() AS version'),
      pool.query(
        'SELECT current_database() AS current_database, current_schema() AS current_schema, current_user AS current_user'
      ),
    ]);

    return textResult('PostgreSQL connection OK', {
      ok: true,
      readOnly: READ_ONLY,
      allowDelete: ALLOW_DELETE,
      writeToolEnabled: !READ_ONLY && Boolean(WRITE_TOKEN),
      defaultSchema: process.env.DB_SCHEMA || 'public',
      ping: ping.rows,
      serverInfo: version.rows?.[0] ?? null,
      session: current.rows?.[0] ?? null,
    });
  }
);

server.registerTool(
  'postgres_list_databases',
  {
    description: 'Daftar database di cluster PostgreSQL (bukan schema).',
    inputSchema: z.object({}),
  },
  async () => {
    const result = await pool.query(
      `SELECT datname
       FROM pg_database
       WHERE datistemplate = false
       ORDER BY datname`
    );
    return textResult('Databases', {
      rowCount: result.rowCount,
      databases: result.rows.map((row) => row.datname),
    });
  }
);

server.registerTool(
  'postgres_list_schemas',
  {
    description: 'Daftar schema di database yang sedang terhubung.',
    inputSchema: z.object({}),
  },
  async () => {
    const result = await pool.query(
      `SELECT schema_name
       FROM information_schema.schemata
       WHERE schema_name NOT LIKE 'pg_%'
         AND schema_name <> 'information_schema'
       ORDER BY schema_name`
    );
    return textResult('Schemas', {
      database: await resolveDatabase(),
      rowCount: result.rowCount,
      schemas: result.rows.map((row) => row.schema_name),
    });
  }
);

server.registerTool(
  'postgres_list_tables',
  {
    description: 'Daftar tabel/view di sebuah schema PostgreSQL.',
    inputSchema: z.object({
      schema: z
        .string()
        .optional()
        .describe('Nama schema. Default: DB_SCHEMA atau public.'),
      database: z
        .string()
        .optional()
        .describe(
          'Harus sama dengan database koneksi aktif (validasi saja). Default: DB_NAME.'
        ),
    }),
  },
  async ({ schema, database }) => {
    await resolveDatabase(database);
    const resolvedSchema = await resolveSchema(schema);
    const result = await pool.query(
      `SELECT table_name, table_type
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_type IN ('BASE TABLE', 'VIEW')
       ORDER BY table_name`,
      [resolvedSchema]
    );

    return textResult(`Tables in ${resolvedSchema}`, {
      database: await resolveDatabase(),
      schema: resolvedSchema,
      rowCount: result.rowCount,
      tables: result.rows,
    });
  }
);

server.registerTool(
  'postgres_describe_table',
  {
    description: 'Struktur kolom satu tabel + index (information_schema + pg_indexes).',
    inputSchema: z.object({
      table: z.string().min(1).describe('Nama tabel'),
      schema: z.string().optional().describe('Nama schema. Default: DB_SCHEMA.'),
      database: z.string().optional().describe('Validasi database koneksi aktif.'),
    }),
  },
  async ({ table, schema, database }) => {
    await resolveDatabase(database);
    const resolvedSchema = await resolveSchema(schema);
    const safeTable = String(table).replace(/"/g, '');

    const [columns, indexes] = await Promise.all([
      pool.query(
        `SELECT column_name, ordinal_position, column_default, is_nullable,
                data_type, udt_name, character_maximum_length, numeric_precision,
                numeric_scale, is_identity, identity_generation
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [resolvedSchema, safeTable]
      ),
      pool.query(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = $2
         ORDER BY indexname`,
        [resolvedSchema, safeTable]
      ),
    ]);

    return textResult(`Describe ${resolvedSchema}.${safeTable}`, {
      database: await resolveDatabase(),
      schema: resolvedSchema,
      table: safeTable,
      columns: columns.rows,
      indexes: indexes.rows,
    });
  }
);

server.registerTool(
  'postgres_get_schema',
  {
    description:
      'Ambil schema lengkap (tables, columns, indexes, foreign keys) dari information_schema / pg_catalog.',
    inputSchema: z.object({
      schema: z.string().optional().describe('Nama schema. Default: DB_SCHEMA.'),
      table: z
        .string()
        .optional()
        .describe('Filter ke satu tabel. Kosongkan untuk seluruh schema.'),
      database: z.string().optional().describe('Validasi database koneksi aktif.'),
    }),
  },
  async ({ schema, table, database }) => {
    await resolveDatabase(database);
    const payload = await fetchSchema(schema, table);
    return textResult('Schema', payload);
  }
);

server.registerTool(
  'postgres_show_create_table',
  {
    description:
      'Tampilkan DDL CREATE TABLE (disusun dari kolom information_schema; tanpa FK/index).',
    inputSchema: z.object({
      table: z.string().min(1).describe('Nama tabel'),
      schema: z.string().optional().describe('Nama schema. Default: DB_SCHEMA.'),
      database: z.string().optional().describe('Validasi database koneksi aktif.'),
    }),
  },
  async ({ table, schema, database }) => {
    await resolveDatabase(database);
    const payload = await fetchCreateTableDdl(schema, table);
    return textResult(`CREATE TABLE ${payload.schema}.${payload.table}`, payload);
  }
);

server.registerTool(
  'postgres_select',
  {
    description:
      'Jalankan query baca (SELECT/WITH/EXPLAIN/TABLE). INSERT, UPDATE, DELETE diblokir.',
    inputSchema: z.object({
      sql: z
        .string()
        .min(1)
        .describe(
          'SQL read-only, misalnya SELECT, WITH ... SELECT, EXPLAIN, TABLE tablename'
        ),
      params: z.array(z.any()).optional().default([]),
    }),
  },
  async ({ sql, params }) => {
    const result = await runSelect(sql, params);
    return textResult('SELECT executed', result);
  }
);

if (!READ_ONLY) {
  server.registerTool(
    'postgres_execute',
    {
      description:
        'Jalankan INSERT/UPDATE/DDL. WAJIB write_token yang cocok dengan DB_WRITE_TOKEN. DELETE diblokir kecuali DB_ALLOW_DELETE=true. Tool ini TIDAK terdaftar saat DB_READ_ONLY=true (default).',
      inputSchema: z.object({
        sql: z
          .string()
          .min(1)
          .describe('SQL non-SELECT, misalnya INSERT, UPDATE, CREATE, ALTER'),
        params: z.array(z.any()).optional().default([]),
        write_token: z
          .string()
          .min(1)
          .describe('Token konfirmasi yang harus sama dengan env DB_WRITE_TOKEN'),
      }),
    },
    async ({ sql, params, write_token }) => {
      const result = await runExecute(sql, params, write_token);
      return textResult('Statement executed', result);
    }
  );
}

async function main() {
  if (!process.env.DB_NAME) {
    console.error(
      '[postgres-guarded-mcp] WARN: DB_NAME not set — default database is "postgres".'
    );
  }
  if (!readPassword()) {
    console.error(
      '[postgres-guarded-mcp] WARN: DB_PASSWORD empty — auth may fail.'
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[postgres-guarded-mcp] ready readOnly=${READ_ONLY} db=${process.env.DB_NAME || 'postgres'} host=${process.env.DB_HOST || '127.0.0.1'}`
  );
}

main().catch(async (error) => {
  console.error('[postgres-guarded-mcp] fatal:', error);
  await closePool();
  process.exit(1);
});

process.on('SIGINT', async () => {
  await closePool();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closePool();
  process.exit(0);
});
