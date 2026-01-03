import { DurableObject } from "cloudflare:workers"

// =====================
// Durable Objects
// =====================

export class IndexDB extends DurableObject {
  constructor(state) {
    super(state)
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
  constructor(state) {
    super(state)
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

  if (j.ok && !task.file_id.startsWith("bf_")) {
    const db = env.INDEX.get(env.INDEX.idFromName("global"))
    const meta = await db.get(task.file_id)
    if (meta) {
      meta.target_msg = j.result.message_id
      await db.put(task.file_id, meta)
    }
  }
}

// =====================
// Worker entry
// =====================

export default {
  async fetch(req, env) {
    if (req.method === "GET") {
      return new Response("TG Mirror Alive", { status: 200 })
    }

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
    const q = env.QUEUE.get(env.QUEUE.idFromName("global"))
    const t = await q.pop()
    if (t) await send(env, t)
  },
}
