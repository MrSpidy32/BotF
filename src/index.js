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
// Telegram helpers
// =====================

async function tg(env, method, body = {}) {
  const r = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  )
  return r.json()
}

async function send(env, task) {
  const r = await tg(env, "copyMessage", task)
  if (r.ok && !task.file_id.startsWith("bf_")) {
    const db = env.INDEX.get(env.INDEX.idFromName("global"))
    const meta = await db.get(task.file_id)
    if (meta) {
      meta.target_msg = r.result.message_id
      await db.put(task.file_id, meta)
    }
  }
}

// =====================
// Polling logic
// =====================

async function poll(env) {
  const db = env.INDEX.get(env.INDEX.idFromName("global"))
  const q = env.QUEUE.get(env.QUEUE.idFromName("global"))

  const offset = (await db.get("tg_offset")) || 0

  const res = await tg(env, "getUpdates", {
    offset,
    limit: 50,
    timeout: 0,
  })

  if (!res.ok) return

  for (const up of res.result) {
    await db.put("tg_offset", up.update_id + 1)

    const msg = up.message || up.channel_post
    if (!msg) continue

    const media =
      msg.document ||
      msg.video ||
      msg.audio ||
      msg.photo?.[msg.photo.length - 1] ||
      msg.voice ||
      msg.animation ||
      msg.video_note ||
      msg.sticker

    if (!media) continue

    const fid = media.file_unique_id
    if (await db.has(fid)) continue

    await db.put(fid, {
      name: media.file_name || fid,
      size: media.file_size,
      mime: media.mime_type,
      src: msg.chat.id,
      date: msg.date,
      target_msg: null,
    })

    await q.push({
      file_id: fid,
      chat_id: env.TARGET_CHAT,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
    })
  }
}

// =====================
// Worker entry
// =====================

export default {
  async fetch() {
    return new Response("TG Mirror Alive (Polling)", { status: 200 })
  },

  async scheduled(_, env) {
    // 1️⃣ fetch updates
    await poll(env)

    // 2️⃣ send one queued item
    const q = env.QUEUE.get(env.QUEUE.idFromName("global"))
    const t = await q.pop()
    if (t) await send(env, t)
  },
}
