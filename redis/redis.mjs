import process from 'node:process';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { createClient } from 'redis';

/**
 * Redis MCP Server — read-only by default, mutation guard for AI agents.
 *
 * Environment variables:
 *   REDIS_URL / REDIS_HOST / REDIS_PORT / REDIS_USERNAME / REDIS_PASSWORD / REDIS_DB / REDIS_TLS
 *   REDIS_READ_ONLY=true          (default: true — write tools not registered)
 *   REDIS_WRITE_TOKEN=secret      (required when REDIS_READ_ONLY=false)
 *   REDIS_ALLOW_DELETE=false      (default: false — delete/flush blocked unless true)
 *   REDIS_ALLOW_FLUSH=false       (extra guard for FLUSHDB)
 */

const READ_ONLY = process.env.REDIS_READ_ONLY !== 'false';
const WRITE_TOKEN = process.env.REDIS_WRITE_TOKEN || '';
const ALLOW_DELETE = process.env.REDIS_ALLOW_DELETE === 'true';

const redisUrl = process.env.REDIS_URL;
const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = Number(process.env.REDIS_PORT || 6379);
const redisUsername = process.env.REDIS_USERNAME;
const redisPassword = process.env.REDIS_PASSWORD;
const redisDb = Number(process.env.REDIS_DB || 0);
const redisTls = ['1', 'true', 'yes'].includes(String(process.env.REDIS_TLS || '').toLowerCase());

const clientOptions = redisUrl
  ? { url: redisUrl }
  : {
      socket: {
        host: redisHost,
        port: redisPort,
        tls: redisTls,
      },
      username: redisUsername,
      password: redisPassword,
      database: redisDb,
    };

const client = createClient(clientOptions);
client.on('error', (error) => {
  console.error('[redis] client error:', error);
});

async function ensureConnected() {
  if (!client.isOpen) {
    await client.connect();
  }
}

function toJson(value) {
  return JSON.stringify(value, null, 2);
}

function textResult(title, data) {
  return {
    content: [
      {
        type: 'text',
        text: `${title}\n${typeof data === 'string' ? data : toJson(data)}`,
      },
    ],
  };
}

function parseValue(value, autoJson) {
  if (!autoJson) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeScores(items) {
  return items.map((item) => ({
    member: item.value,
    score: Number(item.score),
  }));
}

function assertWriteToken(token) {
  if (READ_ONLY) {
    throw new Error(
      'Tool write tidak aktif. Set REDIS_READ_ONLY=false untuk mengaktifkan tool mutasi.'
    );
  }
  if (!WRITE_TOKEN) {
    throw new Error(
      'REDIS_WRITE_TOKEN belum diset. Wajib diset saat REDIS_READ_ONLY=false agar AI agent tidak bisa menulis tanpa token eksplisit.'
    );
  }
  if (token !== WRITE_TOKEN) {
    throw new Error('write_token tidak valid. Mutasi ditolak.');
  }
}

function ensureDeleteAllowed() {
  if (!ALLOW_DELETE) {
    throw new Error(
      'Operasi DELETE diblokir: set REDIS_ALLOW_DELETE=true jika benar-benar diperlukan.'
    );
  }
}

const writeTokenSchema = z
  .string()
  .min(1)
  .describe('Token konfirmasi yang harus sama dengan env REDIS_WRITE_TOKEN');

const SCAN_ALL_MAX_KEYS = Number(process.env.REDIS_SCAN_ALL_MAX_KEYS || 10000);

const server = new McpServer({
  name: 'redis-guarded-mcp',
  version: '2.0.1',
});

server.registerTool(
  'redis_ping',
  {
    description: 'Ping Redis untuk memastikan koneksi hidup.',
    inputSchema: z.object({}),
  },
  async () => {
    await ensureConnected();
    const result = await client.ping();
    return textResult('Redis ping result:', {
      result,
      readOnly: READ_ONLY,
      allowDelete: ALLOW_DELETE,
      writeToolsEnabled: !READ_ONLY && Boolean(WRITE_TOKEN),
    });
  }
);

server.registerTool(
  'redis_info',
  {
    description: 'Ambil informasi server Redis. Section opsional, mis. server, memory, stats, keyspace.',
    inputSchema: z.object({
      section: z.string().optional(),
    }),
  },
  async ({ section }) => {
    await ensureConnected();
    const result = section ? await client.info(section) : await client.info();
    return textResult('Redis info:', result);
  }
);

server.registerTool(
  'redis_get',
  {
    description: 'Ambil value string dari sebuah key.',
    inputSchema: z.object({
      key: z.string(),
      parseJson: z.boolean().default(false),
    }),
  },
  async ({ key, parseJson = false }) => {
    await ensureConnected();
    const value = await client.get(key);
    return textResult('Redis GET result:', {
      key,
      value: value === null ? null : parseValue(value, parseJson),
    });
  }
);

if (!READ_ONLY) {
  server.registerTool(
    'redis_set',
    {
      description:
        'Set value string ke key. WAJIB write_token yang cocok dengan REDIS_WRITE_TOKEN. Tool ini TIDAK terdaftar saat REDIS_READ_ONLY=true (default).',
      inputSchema: z.object({
        key: z.string(),
        value: z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.any()), z.array(z.any())]),
        ttlSeconds: z.number().int().positive().optional(),
        write_token: writeTokenSchema,
      }),
    },
    async ({ key, value, ttlSeconds, write_token }) => {
      assertWriteToken(write_token);
      await ensureConnected();
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
      const result = ttlSeconds
        ? await client.set(key, stringValue, { EX: ttlSeconds })
        : await client.set(key, stringValue);
      return textResult('Redis SET result:', { key, result, ttlSeconds: ttlSeconds ?? null });
    }
  );

  server.registerTool(
    'redis_delete',
    {
      description:
        'Hapus satu atau banyak key. WAJIB write_token. DELETE diblokir kecuali REDIS_ALLOW_DELETE=true. Tool ini TIDAK terdaftar saat REDIS_READ_ONLY=true (default).',
      inputSchema: z.object({
        keys: z.array(z.string()).min(1),
        write_token: writeTokenSchema,
      }),
    },
    async ({ keys, write_token }) => {
      assertWriteToken(write_token);
      ensureDeleteAllowed();
      await ensureConnected();
      const deleted = await client.del(keys);
      return textResult('Redis DEL result:', { keys, deleted });
    }
  );
}

server.registerTool(
  'redis_exists',
  {
    description:
      'Cek key mana yang ada. Mengembalikan count, existing[], dan missing[] per key.',
    inputSchema: z.object({
      keys: z.array(z.string()).min(1),
    }),
  },
  async ({ keys }) => {
    await ensureConnected();
    const existing = [];
    const missing = [];

    for (const key of keys) {
      const found = await client.exists(key);
      if (found) {
        existing.push(key);
      } else {
        missing.push(key);
      }
    }

    return textResult('Redis EXISTS result:', {
      keys,
      count: existing.length,
      existing,
      missing,
    });
  }
);

server.registerTool(
  'redis_type',
  {
    description: 'Ambil tipe Redis key (string, hash, set, list, zset, stream, none).',
    inputSchema: z.object({
      key: z.string(),
    }),
  },
  async ({ key }) => {
    await ensureConnected();
    const type = await client.type(key);
    return textResult('Redis TYPE result:', { key, type });
  }
);

if (!READ_ONLY) {
  server.registerTool(
    'redis_expire',
    {
      description:
        'Set TTL key dalam detik. WAJIB write_token. Tool ini TIDAK terdaftar saat REDIS_READ_ONLY=true (default).',
      inputSchema: z.object({
        key: z.string(),
        ttlSeconds: z.number().int().positive(),
        write_token: writeTokenSchema,
      }),
    },
    async ({ key, ttlSeconds, write_token }) => {
      assertWriteToken(write_token);
      await ensureConnected();
      const applied = await client.expire(key, ttlSeconds);
      return textResult('Redis EXPIRE result:', { key, ttlSeconds, applied });
    }
  );
}

server.registerTool(
  'redis_ttl',
  {
    description: 'Ambil TTL key.',
    inputSchema: z.object({
      key: z.string(),
    }),
  },
  async ({ key }) => {
    await ensureConnected();
    const ttl = await client.ttl(key);
    return textResult('Redis TTL result:', { key, ttl });
  }
);

if (!READ_ONLY) {
  server.registerTool(
    'redis_incrby',
    {
      description:
        'Increment numeric value pada key. WAJIB write_token. Tool ini TIDAK terdaftar saat REDIS_READ_ONLY=true (default).',
      inputSchema: z.object({
        key: z.string(),
        amount: z.number().default(1),
        write_token: writeTokenSchema,
      }),
    },
    async ({ key, amount = 1, write_token }) => {
      assertWriteToken(write_token);
      await ensureConnected();
      const value = Number.isInteger(amount)
        ? await client.incrBy(key, amount)
        : await client.incrByFloat(key, amount);
      return textResult('Redis INCRBY result:', { key, amount, value });
    }
  );

  server.registerTool(
    'redis_decrby',
    {
      description:
        'Decrement numeric value pada key. WAJIB write_token. Tool ini TIDAK terdaftar saat REDIS_READ_ONLY=true (default).',
      inputSchema: z.object({
        key: z.string(),
        amount: z.number().default(1),
        write_token: writeTokenSchema,
      }),
    },
    async ({ key, amount = 1, write_token }) => {
      assertWriteToken(write_token);
      await ensureConnected();
      const value = await client.decrBy(key, Math.trunc(amount));
      return textResult('Redis DECRBY result:', { key, amount: Math.trunc(amount), value });
    }
  );

  server.registerTool(
    'redis_hash_set',
    {
      description:
        'Set satu atau banyak field pada hash. WAJIB write_token. Tool ini TIDAK terdaftar saat REDIS_READ_ONLY=true (default).',
      inputSchema: z.object({
        key: z.string(),
        fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
        write_token: writeTokenSchema,
      }),
    },
    async ({ key, fields, write_token }) => {
      assertWriteToken(write_token);
      await ensureConnected();
      const normalized = Object.fromEntries(
        Object.entries(fields).map(([field, value]) => [field, String(value)])
      );
      const added = await client.hSet(key, normalized);
      return textResult('Redis HSET result:', { key, added, fields: normalized });
    }
  );
}

server.registerTool(
  'redis_hash_getall',
  {
    description: 'Ambil semua field dari hash.',
    inputSchema: z.object({
      key: z.string(),
    }),
  },
  async ({ key }) => {
    await ensureConnected();
    const value = await client.hGetAll(key);
    return textResult('Redis HGETALL result:', { key, value });
  }
);

if (!READ_ONLY) {
  server.registerTool(
    'redis_list_push',
    {
      description:
        'Push item ke list, kiri atau kanan. WAJIB write_token. Tool ini TIDAK terdaftar saat REDIS_READ_ONLY=true (default).',
      inputSchema: z.object({
        key: z.string(),
        values: z.array(z.string()).min(1),
        side: z.enum(['left', 'right']).default('right'),
        write_token: writeTokenSchema,
      }),
    },
    async ({ key, values, side = 'right', write_token }) => {
      assertWriteToken(write_token);
      await ensureConnected();
      const length = side === 'left' ? await client.lPush(key, values) : await client.rPush(key, values);
      return textResult('Redis list push result:', { key, side, length, values });
    }
  );
}

server.registerTool(
  'redis_list_range',
  {
    description: 'Ambil range item dari list.',
    inputSchema: z.object({
      key: z.string(),
      start: z.number().int().default(0),
      stop: z.number().int().default(-1),
    }),
  },
  async ({ key, start = 0, stop = -1 }) => {
    await ensureConnected();
    const values = await client.lRange(key, start, stop);
    return textResult('Redis LRANGE result:', { key, start, stop, values });
  }
);

if (!READ_ONLY) {
  server.registerTool(
    'redis_set_add',
    {
      description:
        'Tambah member ke set. WAJIB write_token. Tool ini TIDAK terdaftar saat REDIS_READ_ONLY=true (default).',
      inputSchema: z.object({
        key: z.string(),
        members: z.array(z.string()).min(1),
        write_token: writeTokenSchema,
      }),
    },
    async ({ key, members, write_token }) => {
      assertWriteToken(write_token);
      await ensureConnected();
      const added = await client.sAdd(key, members);
      const allMembers = await client.sMembers(key);
      return textResult('Redis SADD result:', { key, added, members: allMembers });
    }
  );
}

server.registerTool(
  'redis_set_members',
  {
    description: 'Ambil semua member dari set.',
    inputSchema: z.object({
      key: z.string(),
    }),
  },
  async ({ key }) => {
    await ensureConnected();
    const members = await client.sMembers(key);
    return textResult('Redis SMEMBERS result:', { key, members });
  }
);

if (!READ_ONLY) {
  server.registerTool(
    'redis_zadd',
    {
      description:
        'Tambah member ke sorted set dengan score. WAJIB write_token. Tool ini TIDAK terdaftar saat REDIS_READ_ONLY=true (default).',
      inputSchema: z.object({
        key: z.string(),
        members: z
          .array(
            z.object({
              score: z.number(),
              value: z.string(),
            })
          )
          .min(1),
        write_token: writeTokenSchema,
      }),
    },
    async ({ key, members, write_token }) => {
      assertWriteToken(write_token);
      await ensureConnected();
      const added = await client.zAdd(key, members);
      return textResult('Redis ZADD result:', { key, added, members });
    }
  );
}

server.registerTool(
  'redis_zrange',
  {
    description: 'Ambil member sorted set berdasarkan rank.',
    inputSchema: z.object({
      key: z.string(),
      start: z.number().int().default(0),
      stop: z.number().int().default(-1),
      withScores: z.boolean().default(true),
    }),
  },
  async ({ key, start = 0, stop = -1, withScores = true }) => {
    await ensureConnected();
    const result = withScores
      ? normalizeScores(await client.zRangeWithScores(key, start, stop))
      : await client.zRange(key, start, stop);
    return textResult('Redis ZRANGE result:', { key, start, stop, result });
  }
);

server.registerTool(
  'redis_scan',
  {
    description: 'Scan key berdasarkan pattern dengan limit count (satu halaman SCAN).',
    inputSchema: z.object({
      pattern: z.string().default('*'),
      count: z.number().int().positive().max(1000).default(100),
      cursor: z.string().default('0'),
    }),
  },
  async ({ pattern = '*', count = 100, cursor = '0' }) => {
    await ensureConnected();
    const result = await client.scan(cursor, { MATCH: pattern, COUNT: count });
    return textResult('Redis SCAN result:', {
      cursor: result.cursor,
      keys: result.keys,
      pattern,
      count,
    });
  }
);

server.registerTool(
  'redis_scan_all',
  {
    description:
      'Scan semua key yang match pattern (loop internal sampai cursor 0). Dibatasi maxKeys (default 10000, env REDIS_SCAN_ALL_MAX_KEYS).',
    inputSchema: z.object({
      pattern: z.string().default('*'),
      count: z.number().int().positive().max(1000).default(1000),
      maxKeys: z
        .number()
        .int()
        .positive()
        .max(SCAN_ALL_MAX_KEYS)
        .default(Math.min(1000, SCAN_ALL_MAX_KEYS)),
    }),
  },
  async ({ pattern = '*', count = 1000, maxKeys = Math.min(1000, SCAN_ALL_MAX_KEYS) }) => {
    await ensureConnected();

    let cursor = '0';
    const keys = [];
    let truncated = false;

    do {
      const result = await client.scan(cursor, { MATCH: pattern, COUNT: count });
      cursor = String(result.cursor);
      keys.push(...result.keys);

      if (keys.length >= maxKeys) {
        truncated = cursor !== '0';
        break;
      }
    } while (cursor !== '0');

    const matchedKeys = keys.slice(0, maxKeys);

    return textResult('Redis SCAN ALL result:', {
      pattern,
      count,
      maxKeys,
      truncated,
      totalMatched: matchedKeys.length,
      keys: matchedKeys,
    });
  }
);

if (!READ_ONLY) {
  server.registerTool(
    'redis_flushdb',
    {
      description:
        'Kosongkan database Redis aktif. WAJIB write_token, REDIS_ALLOW_DELETE=true, REDIS_ALLOW_FLUSH=true, dan confirm=FLUSHDB. Tool ini TIDAK terdaftar saat REDIS_READ_ONLY=true (default).',
      inputSchema: z.object({
        confirm: z.literal('FLUSHDB'),
        write_token: writeTokenSchema,
      }),
    },
    async ({ confirm, write_token }) => {
      assertWriteToken(write_token);
      ensureDeleteAllowed();
      await ensureConnected();
      const allowed = ['1', 'true', 'yes'].includes(String(process.env.REDIS_ALLOW_FLUSH || '').toLowerCase());
      if (!allowed || confirm !== 'FLUSHDB') {
        throw new Error(
          'FLUSHDB diblokir. Set REDIS_ALLOW_FLUSH=true dan kirim confirm=FLUSHDB jika benar-benar diperlukan.'
        );
      }
      const result = await client.flushDb();
      return textResult('Redis FLUSHDB result:', { result });
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Redis MCP server berjalan via stdio');
