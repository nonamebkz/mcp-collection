# MariaDB MCP Server

MCP server untuk MariaDB/MySQL dengan **mode read-only default** — aman dipasang di Cursor agar AI agent bisa eksplorasi schema dan query data tanpa risiko INSERT/UPDATE/DELETE tidak sengaja.

## Fitur

| Tool | Keterangan |
|------|------------|
| `mariadb_ping` | Cek koneksi + info server |
| `mariadb_list_databases` | Daftar database |
| `mariadb_list_tables` | Daftar tabel/view di satu database |
| `mariadb_describe_table` | Struktur kolom + index satu tabel |
| `mariadb_get_schema` | Schema lengkap (tables, columns, indexes, FK) |
| `mariadb_show_create_table` | DDL `CREATE TABLE` |
| `mariadb_select` | Query baca: SELECT, WITH, SHOW, DESCRIBE, EXPLAIN |
| `mariadb_execute` | **Hanya jika `DB_READ_ONLY=false`** — INSERT/UPDATE/DDL dengan token |

### v2.0.1

- Perbaikan serialisasi **BigInt** (COUNT/SUM/aggregate) — tidak lagi error `Do not know how to serialize a BigInt`
- Date dan Buffer ikut dinormalisasi ke ISO string / base64 saat JSON response

## Guard keamanan (untuk AI agent)

Default server **read-only**:

- `DB_READ_ONLY=true` (default) → tool `mariadb_execute` **tidak terdaftar**
- `mariadb_select` memblokir INSERT, UPDATE, DELETE, TRUNCATE, REPLACE
- DELETE/TRUNCATE di `mariadb_execute` tetap diblokir kecuali `DB_ALLOW_DELETE=true`
- Saat write diaktifkan, setiap call `mariadb_execute` wajib `write_token` = `DB_WRITE_TOKEN`

Rekomendasi untuk penggunaan dengan Cursor Agent: **biarkan default read-only**.

## Instalasi

```bash
cd /path/to/mcp-collection/mariadb
pnpm install
```

## Variabel lingkungan

| Variabel | Default | Keterangan |
|----------|---------|------------|
| `DB_HOST` | `127.0.0.1` | Host MariaDB |
| `DB_PORT` | `3306` | Port |
| `DB_USER` | `root` | Username |
| `DB_PASSWORD` | *(kosong)* | Password |
| `DB_NAME` | *(kosong)* | Database default |
| `DB_CONNECTION_LIMIT` | `5` | Ukuran connection pool |
| `DB_READ_ONLY` | `true` | `false` untuk mengaktifkan tool write |
| `DB_WRITE_TOKEN` | *(kosong)* | Token wajib saat write; agent harus tahu token ini |
| `DB_ALLOW_DELETE` | `false` | `true` untuk mengizinkan DELETE/TRUNCATE |

## Setup di Cursor

### 1. Buka MCP Settings

**Cursor Settings → MCP → Add new MCP server**

Atau edit file konfigurasi MCP (biasanya `~/.cursor/mcp.json`).

### 2. Tambahkan konfigurasi

Ganti path dan kredensial sesuai lingkungan Anda:

```json
{
  "mcpServers": {
    "mariadb": {
      "command": "node",
      "args": ["/home/noname/project/mcp-collection/mariadb/mariadb.mjs"],
      "env": {
        "DB_HOST": "127.0.0.1",
        "DB_PORT": "3306",
        "DB_USER": "root",
        "DB_PASSWORD": "your_password",
        "DB_NAME": "your_database",
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

> Ping MariaDB dan tampilkan daftar tabel

Agent seharusnya memanggil `mariadb_ping` dan `mariadb_list_tables`.

## Contoh penggunaan tool

### Eksplorasi schema (aman untuk agent)

```
mariadb_get_schema({ "database": "mydb" })
mariadb_describe_table({ "table": "users", "database": "mydb" })
mariadb_show_create_table({ "table": "orders" })
```

### Query data

```
mariadb_select({
  "sql": "SELECT status, COUNT(*) AS cnt FROM TSEDPROCESSITEM GROUP BY status"
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
mariadb_execute({
  "sql": "UPDATE users SET status = ? WHERE id = ?",
  "params": ["inactive", 42],
  "write_token": "token-rahasia-manual"
})
```

## Tips

- Buat user database khusus dengan hak **SELECT** saja untuk penggunaan agent.
- Jangan set `DB_WRITE_TOKEN` di konfigurasi yang dibagikan ke tim jika tidak perlu write.
- Gunakan `mariadb_get_schema` di awal sesi agar agent memahami struktur tabel tanpa menebak-nebak.

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| Tool `mariadb_execute` tidak muncul | Normal — `DB_READ_ONLY=true`. Set `false` jika perlu write. |
| `Database tidak ditentukan` | Set `DB_NAME` di env atau kirim parameter `database`. |
| Koneksi gagal | Cek MariaDB berjalan, host/port, firewall, dan kredensial. |
| `write_token tidak valid` | Pastikan `write_token` di request sama dengan `DB_WRITE_TOKEN`. |

## Lisensi

ISC
