# Redis MCP Server

MCP server untuk Redis dengan **mode read-only default** — aman dipasang di Cursor agar AI agent bisa baca key, hash, list, set, dan sorted set tanpa risiko SET/DEL tidak sengaja.

## Fitur

| Tool | Keterangan |
|------|------------|
| `redis_ping` | Cek koneksi + status guard (read-only, allow delete, write enabled) |
| `redis_info` | Info server Redis (section opsional: `server`, `memory`, `stats`, `keyspace`) |
| `redis_get` | Ambil value string dari key |
| `redis_exists` | Cek key mana yang ada (`existing[]`, `missing[]`, `count`) |
| `redis_type` | Ambil tipe key (string, hash, set, …) |
| `redis_ttl` | Ambil TTL key |
| `redis_hash_getall` | Ambil semua field dari hash |
| `redis_list_range` | Ambil range item dari list |
| `redis_set_members` | Ambil semua member dari set |
| `redis_zrange` | Ambil member sorted set berdasarkan rank |
| `redis_scan` | Scan key berdasarkan pattern (satu halaman) |
| `redis_scan_all` | Scan semua key match pattern (loop internal, max 10000) |
| `redis_set` | **Hanya jika `REDIS_READ_ONLY=false`** — set string key |
| `redis_delete` | **Hanya jika write + `REDIS_ALLOW_DELETE=true`** — hapus key |
| `redis_expire` | **Hanya jika write** — set TTL key |
| `redis_incrby` / `redis_decrby` | **Hanya jika write** — increment/decrement numeric |
| `redis_hash_set` | **Hanya jika write** — set field hash |
| `redis_list_push` | **Hanya jika write** — push ke list |
| `redis_set_add` | **Hanya jika write** — tambah member ke set |
| `redis_zadd` | **Hanya jika write** — tambah member ke sorted set |
| `redis_flushdb` | **Hanya jika write + delete + flush** — kosongkan database aktif |

## Guard keamanan (untuk AI agent)

Default server **read-only**:

- `REDIS_READ_ONLY=true` (default) → semua tool mutasi **tidak terdaftar**
- Saat write diaktifkan, setiap tool mutasi wajib `write_token` = `REDIS_WRITE_TOKEN`
- `redis_delete` dan `redis_flushdb` tetap diblokir kecuali `REDIS_ALLOW_DELETE=true`
- `redis_flushdb` butuh guard ekstra: `REDIS_ALLOW_FLUSH=true` + `confirm=FLUSHDB`

Rekomendasi untuk penggunaan dengan Cursor Agent: **biarkan default read-only**.

## Instalasi

```bash
cd /path/to/mcp-collection/redis
pnpm install
```

## Variabel lingkungan

### Koneksi Redis

| Variabel | Default | Keterangan |
|----------|---------|------------|
| `REDIS_URL` | *(kosong)* | URL lengkap, mis. `redis://:password@127.0.0.1:6379/0`. Jika diset, mengabaikan host/port terpisah |
| `REDIS_HOST` | `127.0.0.1` | Host Redis (jika tidak pakai `REDIS_URL`) |
| `REDIS_PORT` | `6379` | Port |
| `REDIS_USERNAME` | *(kosong)* | Username (Redis 6+ ACL) |
| `REDIS_PASSWORD` | *(kosong)* | Password |
| `REDIS_DB` | `0` | Nomor database |
| `REDIS_TLS` | `false` | `true` / `1` / `yes` untuk koneksi TLS |

### Guard mutasi

| Variabel | Default | Keterangan |
|----------|---------|------------|
| `REDIS_READ_ONLY` | `true` | `false` untuk mengaktifkan tool write |
| `REDIS_WRITE_TOKEN` | *(kosong)* | Token wajib saat write; agent harus tahu token ini |
| `REDIS_ALLOW_DELETE` | `false` | `true` untuk mengizinkan `redis_delete` dan `redis_flushdb` |
| `REDIS_ALLOW_FLUSH` | `false` | Guard ekstra khusus `redis_flushdb` |
| `REDIS_SCAN_ALL_MAX_KEYS` | `10000` | Batas maksimum key yang dikembalikan `redis_scan_all` |

### v2.0.1

- `redis_exists` mengembalikan **`existing[]`** dan **`missing[]`** per key (bukan hanya total count)
- Tool baru **`redis_scan_all`** — scan pattern sampai selesai tanpa paginasi manual
- Tool baru **`redis_type`** — cek tipe key sebelum GET/SMEMBERS/HGETALL

## Setup di Cursor

### 1. Buka MCP Settings

**Cursor Settings → MCP → Add new MCP server**

Atau edit file konfigurasi MCP (biasanya `~/.cursor/mcp.json`).

### 2. Tambahkan konfigurasi (read-only, disarankan)

Ganti path dan kredensial sesuai lingkungan Anda:

```json
{
  "mcpServers": {
    "redis": {
      "command": "node",
      "args": ["/home/noname/project/mcp-collection/redis/redis.mjs"],
      "env": {
        "REDIS_HOST": "127.0.0.1",
        "REDIS_PORT": "6379",
        "REDIS_PASSWORD": "",
        "REDIS_DB": "0",
        "REDIS_READ_ONLY": "true"
      }
    }
  }
}
```

Alternatif dengan URL lengkap:

```json
{
  "mcpServers": {
    "redis": {
      "command": "node",
      "args": ["/home/noname/project/mcp-collection/redis/redis.mjs"],
      "env": {
        "REDIS_URL": "redis://127.0.0.1:6379/0",
        "REDIS_READ_ONLY": "true"
      }
    }
  }
}
```

### 3. Restart MCP / Cursor

Setelah disimpan, restart MCP server dari Cursor Settings atau reload window (`Ctrl+Shift+P` → **Developer: Reload Window**).

### 4. Verifikasi

Di chat Cursor, minta agent:

> Ping Redis dan scan key dengan pattern `user:*`

Agent seharusnya memanggil `redis_ping` dan `redis_scan`.

Respons `redis_ping` akan menampilkan:

```json
{
  "result": "PONG",
  "readOnly": true,
  "allowDelete": false,
  "writeToolsEnabled": false
}
```

## Contoh penggunaan tool

### Baca data (aman untuk agent)

```
redis_get({ "key": "session:abc123", "parseJson": true })
redis_hash_getall({ "key": "user:42" })
redis_list_range({ "key": "queue:jobs", "start": 0, "stop": 9 })
redis_set_members({ "key": "tags:article:1" })
redis_zrange({ "key": "leaderboard", "start": 0, "stop": 9, "withScores": true })
redis_scan({ "pattern": "cache:*", "count": 100 })
redis_scan_all({ "pattern": "bgprocess*", "maxKeys": 1000 })
redis_exists({ "keys": ["bgprocess_dag_graph_abc", "bgprocess_abc"] })
redis_type({ "key": "bgprocess_dag_graph_abc" })
```

### Write (hanya jika benar-benar diperlukan)

Aktifkan di env MCP:

```json
"REDIS_READ_ONLY": "false",
"REDIS_WRITE_TOKEN": "token-rahasia-manual"
```

Lalu panggil dengan token eksplisit (agent tidak akan punya token kecuali Anda memberikannya):

```
redis_set({
  "key": "cache:page:home",
  "value": { "title": "Home" },
  "ttlSeconds": 3600,
  "write_token": "token-rahasia-manual"
})
```

### Delete (butuh guard tambahan)

```json
"REDIS_ALLOW_DELETE": "true"
```

```
redis_delete({
  "keys": ["cache:page:home"],
  "write_token": "token-rahasia-manual"
})
```

## Tips

- Biarkan `REDIS_READ_ONLY=true` untuk eksplorasi dan debugging dengan agent.
- Jangan set `REDIS_WRITE_TOKEN` di konfigurasi yang dibagikan ke tim jika tidak perlu write.
- Gunakan `redis_scan` dengan pattern spesifik, bukan `*`, agar tidak memindai seluruh keyspace.
- Untuk Redis Cloud / managed Redis, gunakan `REDIS_URL` dan set `REDIS_TLS=true` jika diperlukan.

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| Tool write (`redis_set`, dll.) tidak muncul | Normal — `REDIS_READ_ONLY=true`. Set `false` jika perlu write. |
| Koneksi gagal | Cek Redis berjalan (`redis-cli ping`), host/port, password, dan firewall. |
| `write_token tidak valid` | Pastikan `write_token` di request sama dengan `REDIS_WRITE_TOKEN`. |
| `Operasi DELETE diblokir` | Set `REDIS_ALLOW_DELETE=true` untuk `redis_delete`. |
| `FLUSHDB diblokir` | Butuh `REDIS_ALLOW_DELETE=true`, `REDIS_ALLOW_FLUSH=true`, dan `confirm=FLUSHDB`. |
| MCP tidak start | Pastikan sudah `pnpm install` dan path ke `redis.mjs` benar (absolute path disarankan). |

## Lisensi

ISC
