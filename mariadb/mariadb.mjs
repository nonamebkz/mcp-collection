import mariadb from 'mariadb';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

/**
 * MariaDB MCP Server — read-only by default, mutation guard for AI agents.
 *
 * Dependencies:
 *   pnpm install @modelcontextprotocol/server mariadb zod
 *
 * Environment variables:
 *   DB_HOST=127.0.0.1
 *   DB_PORT=3306
 *   DB_USER=root
 *   DB_PASSWORD=secret
 *   DB_NAME=mydb
 *   DB_CONNECTION_LIMIT=5
 *   DB_READ_ONLY=true          (default: true — blocks write tool registration)
 *   DB_WRITE_TOKEN=secret      (required when DB_READ_ONLY=false)
 *   DB_ALLOW_DELETE=false      (default: false — DELETE always blocked unless true)
 */

const READ_ONLY = process.env.DB_READ_ONLY !== 'false';
const WRITE_TOKEN = process.env.DB_WRITE_TOKEN || '';
const ALLOW_DELETE = process.env.DB_ALLOW_DELETE === 'true';

const pool = mariadb.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || '',
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
  idleTimeout: 30000,
  multipleStatements: false,
});

const server = new McpServer({
  name: 'mariadb-guarded-mcp',
  version: '2.0.1',
});

function stripQuotedStrings(sql) {
  return sql
    .replace(/'([^'\\]|\\.|'')*'/g, "''")
    .replace(/\"([^\"\\]|\\.)*\"/g, '""')
    .replace(/`([^`\\]|\\.)*`/g, '``');
}

function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/#.*$/gm, ' ');
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
  if (/\breplace\b/i.test(normalized)) blocked.push('REPLACE');

  if (blocked.length > 0) {
    throw new Error(
      `Statement ${blocked.join(', ')} diblokir. Gunakan tool mariadb_execute dengan token write yang valid jika mutasi diizinkan.`
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
  if (!/^(select|with|show|describe|desc|explain)\b/i.test(normalized)) {
    throw new Error(
      'Tool ini hanya menerima SELECT, WITH, SHOW, DESCRIBE, atau EXPLAIN.'
    );
  }
}

function ensureWriteAllowed(sql) {
  const normalized = normalizeForInspection(sql);
  if (/^(select|with|show|describe|desc|explain)\b/i.test(normalized)) {
    throw new Error('Gunakan tool mariadb_select atau tool schema untuk query baca.');
  }
}

function ensureMutationAllowed(sql) {
  const normalized = normalizeForInspection(sql);
  const isMutation =
    /\b(insert|update|delete|replace|truncate)\b/i.test(normalized);

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
      'Tool write tidak aktif. Set DB_READ_ONLY=false untuk mengaktifkan mariadb_execute.'
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

async function runSelect(sql, params = []) {
  ensureSingleStatement(sql);
  ensureNoDml(sql);
  ensureReadOnlyQuery(sql);

  const rows = await pool.query(sql, params);
  const plainRows = Array.isArray(rows) ? rows : [];

  return {
    rowCount: plainRows.length,
    rows: plainRows,
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

  if (Array.isArray(result)) {
    return {
      type: 'resultset',
      rowCount: result.length,
      rows: result,
    };
  }

  return {
    type: 'write',
    affectedRows: result?.affectedRows ?? 0,
    insertId: result?.insertId ?? null,
    warningStatus: result?.warningStatus ?? 0,
  };
}

async function resolveDatabase(database) {
  if (database) return database;
  if (process.env.DB_NAME) return process.env.DB_NAME;

  const rows = await pool.query('SELECT DATABASE() AS db');
  const current = rows?.[0]?.db;
  if (!current) {
    throw new Error(
      'Database tidak ditentukan. Set DB_NAME atau kirim parameter database.'
    );
  }
  return current;
}

async function fetchSchema(database, table) {
  const db = await resolveDatabase(database);
  const tableFilter = table ? 'AND TABLE_NAME = ?' : '';
  const tableParams = table ? [db, table] : [db];

  const tables = await pool.query(
    `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS,
            AVG_ROW_LENGTH, DATA_LENGTH, INDEX_LENGTH, TABLE_COLLATION,
            CREATE_TIME, UPDATE_TIME, TABLE_COMMENT
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? ${tableFilter}
     ORDER BY TABLE_NAME`,
    tableParams
  );

  const columns = await pool.query(
    `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION,
            COLUMN_DEFAULT, IS_NULLABLE, DATA_TYPE, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH,
            NUMERIC_PRECISION, NUMERIC_SCALE, COLUMN_KEY, EXTRA, COLUMN_COMMENT
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? ${tableFilter}
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    tableParams
  );

  const indexes = await pool.query(
    `SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX,
            COLUMN_NAME, COLLATION, CARDINALITY, INDEX_TYPE, INDEX_COMMENT
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? ${tableFilter}
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    tableParams
  );

  const foreignKeys = await pool.query(
    `SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.CONSTRAINT_NAME,
            kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME,
            kcu.REFERENCED_COLUMN_NAME, rc.UPDATE_RULE, rc.DELETE_RULE
     FROM information_schema.KEY_COLUMN_USAGE kcu
     JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
       ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
      AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
     WHERE kcu.TABLE_SCHEMA = ?
       AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
       ${table ? 'AND kcu.TABLE_NAME = ?' : ''}
     ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
    tableParams
  );

  return {
    database: db,
    table: table || null,
    tableCount: tables.length,
    tables,
    columns,
    indexes,
    foreignKeys,
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
  'mariadb_ping',
  {
    description: 'Test koneksi MariaDB dan kembalikan status server.',
    inputSchema: z.object({}),
  },
  async () => {
    const [ping, version] = await Promise.all([
      pool.query('SELECT 1 AS ok'),
      pool.query('SELECT VERSION() AS version, DATABASE() AS current_database'),
    ]);

    return textResult('MariaDB connection OK', {
      ok: true,
      readOnly: READ_ONLY,
      allowDelete: ALLOW_DELETE,
      writeToolEnabled: !READ_ONLY && Boolean(WRITE_TOKEN),
      ping,
      serverInfo: version?.[0] ?? null,
    });
  }
);

server.registerTool(
  'mariadb_list_databases',
  {
    description: 'Daftar semua database yang dapat diakses user saat ini.',
    inputSchema: z.object({}),
  },
  async () => {
    const rows = await pool.query('SHOW DATABASES');
    return textResult('Databases', {
      rowCount: rows.length,
      databases: rows.map((row) => row.Database),
    });
  }
);

server.registerTool(
  'mariadb_list_tables',
  {
    description: 'Daftar tabel/view di sebuah database.',
    inputSchema: z.object({
      database: z
        .string()
        .optional()
        .describe('Nama database. Default: DB_NAME atau database aktif.'),
    }),
  },
  async ({ database }) => {
    const db = await resolveDatabase(database);
    const rows = await pool.query(
      `SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [db]
    );

    return textResult(`Tables in ${db}`, {
      database: db,
      rowCount: rows.length,
      tables: rows,
    });
  }
);

server.registerTool(
  'mariadb_describe_table',
  {
    description: 'Struktur kolom satu tabel (DESCRIBE + index ringkas).',
    inputSchema: z.object({
      table: z.string().min(1).describe('Nama tabel'),
      database: z.string().optional().describe('Nama database. Default: DB_NAME.'),
    }),
  },
  async ({ table, database }) => {
    const db = await resolveDatabase(database);
    const safeTable = table.replace(/`/g, '');

    const [columns, indexes] = await Promise.all([
      pool.query(`DESCRIBE \`${db}\`.\`${safeTable}\``),
      pool.query(
        `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [db, safeTable]
      ),
    ]);

    return textResult(`Describe ${db}.${safeTable}`, {
      database: db,
      table: safeTable,
      columns,
      indexes,
    });
  }
);

server.registerTool(
  'mariadb_get_schema',
  {
    description:
      'Ambil schema lengkap (tables, columns, indexes, foreign keys) dari information_schema.',
    inputSchema: z.object({
      database: z.string().optional().describe('Nama database. Default: DB_NAME.'),
      table: z
        .string()
        .optional()
        .describe('Filter ke satu tabel. Kosongkan untuk seluruh database.'),
    }),
  },
  async ({ database, table }) => {
    const schema = await fetchSchema(database, table);
    return textResult('Schema', schema);
  }
);

server.registerTool(
  'mariadb_show_create_table',
  {
    description: 'Tampilkan DDL CREATE TABLE untuk satu tabel.',
    inputSchema: z.object({
      table: z.string().min(1).describe('Nama tabel'),
      database: z.string().optional().describe('Nama database. Default: DB_NAME.'),
    }),
  },
  async ({ table, database }) => {
    const db = await resolveDatabase(database);
    const safeTable = table.replace(/`/g, '');
    const rows = await pool.query(`SHOW CREATE TABLE \`${db}\`.\`${safeTable}\``);

    return textResult(`CREATE TABLE ${db}.${safeTable}`, {
      database: db,
      table: safeTable,
      createTable: rows?.[0] ?? null,
    });
  }
);

server.registerTool(
  'mariadb_select',
  {
    description:
      'Jalankan query baca (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN). INSERT, UPDATE, DELETE diblokir.',
    inputSchema: z.object({
      sql: z
        .string()
        .min(1)
        .describe('SQL read-only, misalnya SELECT, WITH ... SELECT, SHOW, DESCRIBE'),
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
    'mariadb_execute',
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(async (error) => {
  console.error('[mariadb-guarded-mcp] fatal:', error);
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
