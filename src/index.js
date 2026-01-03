import { DurableObject } from "cloudflare:workers"

// =====================
// Durable Objects
// =====================

export class IndexDB extends DurableObject {
  constructor(state, env) {
    super(state, env)
    this.state = state
  }

  async has(id) {
    return (await this.state.storage.get(id)) !== undefined
  }

  async get(id) {
    return await this.state.storage.get(id)
  }

  async put(id, meta) {
    await this.state.storage.put(id, meta)
  }
}

export class Queue extends DurableObject {
  constructor(state, env) {
    super(state, env)
    this.state = state
  }

  async push(t) {
    const q = (await this.state.storage.get("q")) || []
    q.push(t)
    await this.state.storage.put("q", q)
  }

  async pop() {
    const q = (await this.state.storage.get("q")) || []
    const t = q.shift()
    await this.state.storage.put("q", q)
    return t
  }
}

// =====================
// Telegram sender
// =====================

async function send(env, task) {
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    }
  )

  const j = await r.json()

  // Old / missing messages during backfill → ignore
  if (!j.ok) return

  // Skip DB update for backfill jobs
  if (task.file_id.startsWith("bf_")) return

  const db = env.INDEX.get(env.INDEX.idFromName("global"))
  const meta = await db.get(task.file_id)
  if (meta) {
    meta.target_msg = j.result.message_id
    await db.put(task.file_id, meta)
  }
}

// =====================
// Backfill logic (LATEST → OLDEST)
// =====================

async function backfill(env) {
  if (!env.BACKFILL_CHATS) return

  const chats = env.BACKFILL_CHATS.split(",").map(x => x.trim())
  const db = env.INDEX.get(env.INDEX.idFromName("global"))
  const q = env.QUEUE.get(env.QUEUE.idFromName("global"))

  for (const chat of chats) {
    // Cursor = last message_id we tried
    let cursor = await db.get(`bf_${chat}`)

    // First run: assume very high message_id
    if (!cursor) cursor = 10_000_000

    // Push a small batch (rate-safe)
    const BATCH = 10

    for (let i = 0; i < BATCH; i++) {
      const mid = cursor - i
      if (mid <= 0) break

      await q.push({
        file_id: `bf_${chat}_${mid}`,
        chat_id: env.TARGET_CHAT,
        from_chat_id: chat,
        message_id: mid,
      })
    }

    // Move cursor backwards
    await db.put(`bf_${chat}`, cursor - BATCH)
  }
}

// =====================
// Worker entry
// =====================

export default {
  async fetch(req, env) {
    // Health check
    if (req.method === "GET") {
      return new Response("TG Mirror Alive", { status: 200 })
    }

    // Telegram webhook
    if (req.method === "POST") {
      try {
        const up = await req.json()

        const msg =
          up.message ||
          up.channel_post ||
          up.edited_message ||
          up.edited_channel_post

        if (!msg) return new Response("OK", { status: 200 })

        const media =
          msg.document ||
          msg.video ||
          msg.audio ||
          (msg.photo && msg.photo[msg.photo.length - 1]) ||
          msg.voice ||
          msg.animation ||
          msg.video_note ||
          msg.sticker

        if (!media) return new Response("OK", { status: 200 })

        const fid = media.file_unique_id
        const db = env.INDEX.get(env.INDEX.idFromName("global"))

        // Dedup
        if (await db.has(fid)) return new Response("OK", { status: 200 })

        await db.put(fid, {
          name: media.file_name || fid,
          size: media.file_size,
          mime: media.mime_type,
          src: msg.chat.id,
          date: msg.date,
          target_msg: null,
        })

        const q = env.QUEUE.get(env.QUEUE.idFromName("global"))
        await q.push({
          file_id: fid,
          chat_id: env.TARGET_CHAT,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
        })
      } catch (e) {
        console.error("Webhook error:", e)
      }

      return new Response("OK", { status: 200 })
    }

    return new Response("OK", { status: 200 })
  },

  async scheduled(_, env) {
    // 1️⃣ Backfill newest → older
    await backfill(env)

    // 2️⃣ Send ONE queued item (rate-safe)
    const q = env.QUEUE.get(env.QUEUE.idFromName("global"))
    const t = await q.pop()
    if (t) await send(env, t)
  },
}
