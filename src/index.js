import { DurableObject } from "cloudflare:workers"

/* =========================
   Durable Objects
========================= */

export class IndexDB extends DurableObject {
  constructor(state, env) {
    super(state, env)
    this.state = state
  }

  async has(key) {
    return (await this.state.storage.get(key)) !== undefined
  }

  async get(key) {
    return await this.state.storage.get(key)
  }

  async put(key, value) {
    await this.state.storage.put(key, value)
  }

  async dump() {
    const out = []
    for (const [key, value] of (await this.state.storage.list()).entries()) {
      out.push({ key, value })
    }
    return out
  }
}

export class Queue extends DurableObject {
  constructor(state, env) {
    super(state, env)
    this.state = state
  }

  async push(item) {
    const q = (await this.state.storage.get("q")) || []
    q.push(item)
    await this.state.storage.put("q", q)
  }

  async pop() {
    const q = (await this.state.storage.get("q")) || []
    const item = q.shift()
    await this.state.storage.put("q", q)
    return item
  }

  async dump() {
    return (await this.state.storage.get("q")) || []
  }
}

/* =========================
   Telegram sender
========================= */

async function send(env, task) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: task.chat_id,
        from_chat_id: task.from_chat_id,
        message_id: task.message_id,
      }),
    }
  )

  const json = await res.json()

  if (!json.ok) {
    console.error("Telegram send failed:", json)
    return
  }

  // Only update DB for LIVE messages (not backfill)
  if (task.type === "live") {
    const db = env.INDEX.get(env.INDEX.idFromName("global"))
    const meta = await db.get(task.key)
    if (meta) {
      meta.target_msg = json.result.message_id
      await db.put(task.key, meta)
    }
  }
}

/* =========================
   Backfill logic
========================= */

async function backfill(env) {
  if (!env.BACKFILL_CHATS) return

  const chats = env.BACKFILL_CHATS.split(",").map(c => c.trim())
  const db = env.INDEX.get(env.INDEX.idFromName("global"))
  const q = env.QUEUE.get(env.QUEUE.idFromName("global"))

  const BATCH = 5

  for (const chat of chats) {
    let cursor = await db.get(`bf_${chat}`)
    if (typeof cursor !== "number") cursor = 10_000_000

    for (let i = 0; i < BATCH; i++) {
      const mid = cursor - i
      if (mid <= 0) break

      await q.push({
        type: "backfill",
        chat_id: env.TARGET_CHAT,
        from_chat_id: Number(chat),
        message_id: mid,
      })
    }

    await db.put(`bf_${chat}`, Math.max(cursor - BATCH, 0))
  }
}

/* =========================
   Worker entry
========================= */

export default {
  async fetch(req, env) {
    if (req.method === "GET") {
      return new Response("TG Mirror Alive", { status: 200 })
    }

    if (req.method === "POST") {
      try {
        const update = await req.json()

        const msg =
          update.message ||
          update.channel_post ||
          update.edited_message ||
          update.edited_channel_post

        if (!msg) return new Response("OK")

        const media =
          msg.document ||
          msg.video ||
          msg.audio ||
          (msg.photo && msg.photo.at(-1)) ||
          msg.voice ||
          msg.animation ||
          msg.video_note ||
          msg.sticker

        if (!media) return new Response("OK")

        const key = media.file_unique_id
        const realFileId = media.file_id

        const db = env.INDEX.get(env.INDEX.idFromName("global"))
        if (await db.has(key)) return new Response("OK")

        await db.put(key, {
          name: media.file_name || key,
          size: media.file_size || 0,
          mime: media.mime_type || "unknown",
          src: msg.chat.id,
          date: msg.date,
          file_id: realFileId,
          target_msg: null,
        })

        const q = env.QUEUE.get(env.QUEUE.idFromName("global"))
        await q.push({
          type: "live",
          key,
          chat_id: env.TARGET_CHAT,
          from_chat_id: msg.chat.id,
          message_id: msg.message_id,
        })
      } catch (e) {
        console.error("Webhook error:", e)
      }

      return new Response("OK")
    }

    return new Response("OK")
  },

  async scheduled(_, env) {
    await backfill(env)

    const q = env.QUEUE.get(env.QUEUE.idFromName("global"))
    const task = await q.pop()
    if (task) await send(env, task)
  },
}
