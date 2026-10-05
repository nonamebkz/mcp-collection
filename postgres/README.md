# PostgreSQL MCP Server

MCP server untuk PostgreSQL dengan **mode read-only default** — aman dipasang di Cursor agar AI agent bisa eksplorasi schema dan query data tanpa risiko INSERT/UPDATE/DELETE tidak sengaja.

## Fitur

| Tool | Keterangan |
|------|------------|
| `postgres_ping` | Cek koneksi + info server & session |
| `postgres_list_databases` | Daftar database di cluster |
| `postgres_list_schemas` | Daftar schema di database aktif |
| `postgres_list_tables` | Daftar tabel/view di satu schema |
| `postgres_describe_table` | Struktur kolom + index satu tabel |
| `postgres_get_schema` | Schema lengkap (tables, columns, indexes, FK) |
| `postgres_show_create_table` | DDL `CREATE TABLE` (dari kolom; tanpa FK/index) |
| `postgres_select` | Query baca: SELECT, WITH, EXPLAIN, TABLE |
| `postgres_execute` | **Hanya jika `DB_READ_ONLY=false`** — INSERT/UPDATE/DDL dengan token |

### v2.0.1

- Guard mutasi & token write sama pola dengan server MariaDB di repo ini
- Serialisasi **BigInt**, Date, dan Buffer aman untuk respons JSON MCP
- Parameter **`schema`** (default `public` / `DB_SCHEMA`) — setara namespace tabel di PostgreSQL

## Guard keamanan (untuk AI agent)

Default server **read-only**:

- `DB_READ_ONLY=true` (default) → tool `postgres_execute` **tidak terdaftar**
- `postgres_select` memblokir INSERT, UPDATE, DELETE, TRUNCATE, MERGE
- DELETE/TRUNCATE di `postgres_execute` tetap diblokir kecuali `DB_ALLOW_DELETE=true`
- Saat write diaktifkan, setiap call `postgres_execute` wajib `write_token` = `DB_WRITE_TOKEN`

Rekomendasi untuk penggunaan dengan Cursor Agent: **biarkan default read-only**.

## Instalasi

```bash
cd /path/to/mcp-collection/postgres
pnpm install
```

## Variabel lingkungan

| Variabel | Default | Keterangan |
|----------|---------|------------|
| `DB_HOST` | `127.0.0.1` | Host PostgreSQL |
| `DB_PORT` | `5432` | Port |
| `DB_USER` | `postgres` | Username |
| `DB_PASSWORD` | *(kosong)* | Password |
| `DB_NAME` | `postgres` | Database yang disambungkan (satu koneksi = satu DB) |
| `DB_SCHEMA` | `public` | Schema default untuk list/describe/schema tools |
| `DB_CONNECTION_LIMIT` | `5` | Ukuran connection pool |
| `DB_READ_ONLY` | `true` | `false` untuk mengaktifkan tool write |
| `DB_WRITE_TOKEN` | *(kosong)* | Token wajib saat write; agent harus tahu token ini |
| `DB_ALLOW_DELETE` | `false` | `true` untuk mengizinkan DELETE/TRUNCATE |

## Setup di Cursor

### 1. Buka MCP Settings

**Cursor Settings → MCP → Add new MCP server**

Atau edit file konfigurasi MCP (biasanya `~/.cursor/mcp.json`).

### 2. Tambahkan konfigurasi

Ganti path (**absolute path ke `postgres.mjs` di mesin Anda**, bukan path contoh) dan kredensial:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["/home/kikichan/project/mcp-collection/postgres/postgres.mjs"],
      "env": {
        "DB_HOST": "127.0.0.1",
        "DB_PORT": "5432",
        "DB_USER": "postgres",
        "DB_PASSWORD": "your_password",
        "DB_NAME": "your_database",
        "DB_SCHEMA": "public",
        "DB_READ_ONLY": "true"
      }
    }
  }
}
```

### 3. Restart MCP / Cursor

Setelah disimpan, restart MCP server dari Cursor Settings atau reload window.

### 4. Verifikasi

Di chat Cursor, minta agent:

> Ping PostgreSQL dan tampilkan daftar tabel di schema public

Agent seharusnya memanggil `postgres_ping` dan `postgres_list_tables`.

## Contoh penggunaan tool

### Eksplorasi schema (aman untuk agent)

```
postgres_list_schemas({})
postgres_get_schema({ "schema": "public" })
postgres_describe_table({ "table": "users", "schema": "public" })
postgres_show_create_table({ "table": "orders" })
```

### Query data

```
postgres_select({
  "sql": "SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status"
})
```

### Write (hanya jika benar-benar diperlukan)

Aktifkan di env:

```json
"DB_READ_ONLY": "false",
"DB_WRITE_TOKEN": "token-rahasia-manual"
```

Lalu panggil dengan token eksplisit (agent tidak akan punya token kecuali Anda memberikannya):

```
postgres_execute({
  "sql": "UPDATE users SET status = $1 WHERE id = $2",
  "params": ["inactive", 42],
  "write_token": "token-rahasia-manual"
})
```

## Tips

- Buat role PostgreSQL khusus dengan hak **SELECT** saja untuk penggunaan agent.
- Satu MCP server = satu `DB_NAME`; untuk database lain, buat entri MCP terpisah.
- Gunakan `postgres_get_schema` di awal sesi agar agent memahami struktur tabel tanpa menebak-nebak.

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| Cursor **timeout** / MCP tidak connect | Gunakan **path absolute ke `node`** (bukan `"command": "node"`) — GUI Cursor sering tidak memuat NVM ke `PATH`. Tambahkan `"cwd": "/path/to/mcp-collection/postgres"`. Reload window setelah edit MCP. |
| `Cannot find module '.../postgres.mjs'` | Path di `args` salah (sering masih `/home/noname/...` dari contoh). Ganti ke path absolute yang ada di disk, mis. `/home/kikichan/project/mcp-collection/postgres/postgres.mjs`. |
| `password authentication failed` / `%40` di password | Jangan URL-encode `@` sebagai `%40` kecuali server decode — v2.0.1+ memanggil `decodeURIComponent` pada `DB_PASSWORD`. Atau tulis `@` langsung di JSON: `"DB_PASSWORD": "pass@word"`. |
| Tool `postgres_execute` tidak muncul | Normal — `DB_READ_ONLY=true`. Set `false` jika perlu write. |
| `Database ... berbeda dari koneksi aktif` | Parameter `database` harus sama dengan `DB_NAME`; atau ubah `DB_NAME`. |
| Koneksi gagal | Cek PostgreSQL berjalan, `pg_hba.conf`, host/port, firewall, dan kredensial. Set `DB_CONNECTION_TIMEOUT_MS=15000` agar gagal cepat, bukan hang. |
| `write_token tidak valid` | Pastikan `write_token` di request sama dengan `DB_WRITE_TOKEN`. |
| MCP tidak start | Pastikan sudah `pnpm install` dan path ke `postgres.mjs` benar (absolute path disarankan). Lihat stderr Cursor MCP log — baris `[postgres-guarded-mcp] ready` = server hidup. |

### Verifikasi lokal (tanpa Cursor)

```bash
cd /home/kikichan/project/mcp-collection/postgres
pnpm install
env DB_HOST=... DB_PASSWORD='...' DB_NAME=poc-big-data \
  npx @modelcontextprotocol/inspector --cli node postgres.mjs \
  --method tools/call --tool-name postgres_ping
```

## Lisensi

ISC
