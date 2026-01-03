// =====================
// Durable Objects
// =====================

export class IndexDB {
  constructor(state) {
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

export class Queue {
  constructor(state) {
    this.state = state
  }

  async push(task) {
    const q = (await this.state.storage.get("q")) || []
    q.push(task)
    await this.state.storage.put("q", q)
  }

  async pop() {
    const q = (await this.state.storage.get("q")) || []
    const task = q.shift()
    await this.state.storage.put("q", q)
    return task
  }
}

// =====================
// Telegram Sender
// =====================

async function send(env, task) {
  const res = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    }
  )

  const json = await res.json()

  if (json.ok && !task.file_id.startsWith("bf_")) {
    const db = env.INDEX.get(env.INDEX.idFromName("global"))
    const meta = await db.get(task.file_id)
    if (meta) {
      meta.target_msg = json.result.message_id
      await db.put(task.file_id, meta)
    }
  }
}

// =====================
// Backfill Logic
// =====================

async function backfill(env) {
  if (!env.BACKFILL_CHATS) return

  const chats = env.BACKFILL_CHATS.split(",").map(c => c.trim())
  const q = env.QUEUE.get(env.QUEUE.idFromName("global"))
  const db = env.INDEX.get(env.INDEX.idFromName("global"))

  for (const chat of chats) {
    let last = (await db.get(`bf_${chat}`)) || 1

    for (let i = 0; i < 40; i++) {
      const mid = last + i
      await q.push({
        file_id: `bf_${chat}_${mid}`,
        chat_id: env.TARGET_CHAT,
        from_chat_id: chat,
        message_id: mid,
      })
    }

    await db.put(`bf_${chat}`, last + 40)
  }
}

// =====================
// Worker Entrypoint
// =====================

export default {
  async fetch(req, env) {
    if (req.method === "GET") {
      return new Response("TG Mirror Alive")
    }

    if (req.method === "POST") {
      const update = await req.json()
      const msg = update.message || update.channel_post
      if (!msg) return new Response("OK")

      const media =
        msg.document ||
        msg.video ||
        msg.audio ||
        msg.photo?.at(-1) ||
        msg.voice ||
        msg.animation ||
        msg.video_note ||
        msg.sticker

      if (!media) return new Response("NO MEDIA")

      const fid = media.file_unique_id
      const db = env.INDEX.get(env.INDEX.idFromName("global"))

      if (await db.has(fid)) return new Response("DUP")

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

      return new Response("QUEUED")
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
