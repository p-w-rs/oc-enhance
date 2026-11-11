// Reminders: an agent sets one ("in 40 min: check whether training finished") and can end its turn; when it is due,
// the session is woken with the message. Stored in OpenCode's plugin storage, so they survive restarts. A paused
// session's reminders wait and are handed over on Resume.

export interface Reminder {
  readonly id: string
  readonly sessionID: string
  readonly message: string
  readonly due: number
  readonly created: number
  /** Repeat every this many minutes until cancelled. */
  readonly every?: number
}

export interface ReminderStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{ entries: readonly { key: string; value: unknown }[]; next?: string }>
}

export interface ReminderHost {
  /** The paused session (this one or an ancestor), if any: reminders wait while paused. */
  pausedBy(sessionID: string): Promise<string | undefined>
  /** Wakes the session with this text. Throws if it cannot be delivered. */
  deliver(reminder: Reminder, text: string): Promise<void>
  /** Whether the session still exists (undelivered reminders of deleted sessions are dropped). */
  exists(sessionID: string): Promise<boolean>
}

export const LIMITS = { perSession: 20, maxMinutes: 7 * 24 * 60, minMinutes: 0.25, message: 1000 }
const PREFIX = "reminder/"

export const minutesText = (minutes: number) => minutes < 1 ? `${Math.round(minutes * 60)} s` : minutes < 90 ? `${Math.round(minutes)} min` : minutes < 48 * 60 ? `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)} h` : `${Math.round(minutes / 1440)} days`
export const dueText = (due: number, now = Date.now()) => due <= now ? `due ${minutesText((now - due) / 60000)} ago` : `in ${minutesText((due - now) / 60000)}`

/** The message the agent wakes up to. */
export function reminderText(reminder: Reminder, now = Date.now()): string {
  const late = now - reminder.due > 120_000 ? ` (it was due ${minutesText((now - reminder.due) / 60000)} ago; OpenCode was not running or the session was paused)` : ""
  const set = new Date(reminder.created).toISOString().slice(0, 16).replace("T", " ")
  return `<reminder id="${reminder.id}" set="${set} UTC"${reminder.every ? ` repeats="every ${minutesText(reminder.every)}"` : ""}>\n${reminder.message}\n</reminder>\nThis is the reminder you set${late}. Check the current state before acting on it.${reminder.every ? ` It repeats; cancel it with reminder action=cancel id=${reminder.id} when it is no longer needed.` : ""}`
}

/**
 * Process-global scheduler state: OpenCode runs one plugin instance per project location, so the instances share one
 * set of in-flight deliveries to never wake a session twice.
 */
const GLOBAL = Symbol.for("oc-enhance.reminders.v1")
const delivering: Set<string> = ((globalThis as Record<symbol, unknown>)[GLOBAL] ??= new Set<string>()) as Set<string>

export class Reminders {
  #timer?: ReturnType<typeof setTimeout>
  #stopped = false
  constructor(private readonly storage: ReminderStorage, private readonly host: ReminderHost, private readonly now = () => Date.now()) {}

  async #all(): Promise<Map<string, Reminder>> {
    const found = new Map<string, Reminder>()
    let after: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = await this.storage.scan({ prefix: PREFIX, ...(after && { after }), limit: 200 })
      for (const entry of result.entries) {
        const value = entry.value as Reminder
        if (value && typeof value === "object" && typeof value.id === "string" && typeof value.due === "number") found.set(value.id, value)
      }
      if (!result.next) break
      after = result.next
    }
    return found
  }

  async list(sessionID?: string): Promise<Reminder[]> {
    return [...(await this.#all()).values()].filter(item => !sessionID || item.sessionID === sessionID).sort((a, b) => a.due - b.due)
  }

  async set(sessionID: string, input: { minutes?: number; at?: string; message: string; every?: number }): Promise<Reminder> {
    const message = String(input.message ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim()
    if (!message) throw new Error("message is required: what should you check or do when the reminder goes off?")
    if (message.length > LIMITS.message) throw new Error(`message is longer than ${LIMITS.message} characters; summarize it`)
    let due: number
    if (input.at !== undefined) {
      due = Date.parse(input.at)
      if (!Number.isFinite(due)) throw new Error("at must be a date and time, e.g. 2026-11-11T15:30:00Z or 2026-11-11T08:30:00-07:00")
    } else if (typeof input.minutes === "number" && Number.isFinite(input.minutes)) due = this.now() + input.minutes * 60_000
    else throw new Error("Give minutes (from now) or at (a date and time)")
    const minutes = (due - this.now()) / 60_000
    if (minutes < LIMITS.minMinutes) throw new Error(`The reminder must be at least ${LIMITS.minMinutes * 60} seconds from now`)
    if (minutes > LIMITS.maxMinutes) throw new Error("Reminders can be at most 7 days ahead")
    if (input.every !== undefined && (!Number.isFinite(input.every) || input.every < 1 || input.every > LIMITS.maxMinutes)) throw new Error("every must be between 1 minute and 7 days")
    const mine = await this.list(sessionID)
    if (mine.length >= LIMITS.perSession) throw new Error(`This session already has ${mine.length} reminders; cancel some first (reminder action=list)`)
    const reminder: Reminder = { id: `r${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, sessionID, message, due, created: this.now(), ...(input.every && { every: input.every }) }
    await this.storage.set(PREFIX + reminder.id, reminder as never)
    this.#schedule()
    return reminder
  }

  async cancel(sessionID: string, id: string): Promise<Reminder | undefined> {
    const reminder = await this.#get(id)
    if (!reminder || reminder.sessionID !== sessionID) return undefined
    await this.storage.remove(PREFIX + id)
    this.#schedule()
    return reminder
  }

  /** Removes the session's due reminders and returns them (Resume hands them to the agent). */
  async takeDue(sessionID: string): Promise<Reminder[]> {
    const due = (await this.list(sessionID)).filter(item => item.due <= this.now())
    for (const item of due) await this.#done(item)
    return due
  }

  async #get(id: string): Promise<Reminder | undefined> {
    const value = await this.storage.get(PREFIX + id) as Reminder | undefined
    return value && typeof value === "object" && value.id === id ? value : undefined
  }

  async #done(reminder: Reminder) {
    if (reminder.every) {
      let due = reminder.due
      while (due <= this.now()) due += reminder.every * 60_000
      await this.storage.set(PREFIX + reminder.id, { ...reminder, due } as never)
    } else await this.storage.remove(PREFIX + reminder.id)
  }

  /** Delivers every due reminder whose session is not paused. */
  async tick(): Promise<void> {
    for (const reminder of await this.list()) {
      if (reminder.due > this.now()) break
      if (delivering.has(reminder.id)) continue
      delivering.add(reminder.id)
      try {
        if (await this.host.pausedBy(reminder.sessionID).catch(() => undefined)) continue
        // Another plugin instance may have delivered or rescheduled it meanwhile.
        const current = await this.#get(reminder.id)
        if (!current || current.due !== reminder.due) continue
        try {
          await this.host.deliver(reminder, reminderText(reminder, this.now()))
          await this.#done(reminder)
        } catch (error) {
          if (!(await this.host.exists(reminder.sessionID).catch(() => true))) await this.storage.remove(PREFIX + reminder.id)
          else console.warn(`[oc-enhance] reminder ${reminder.id} not delivered yet: ${error instanceof Error ? error.message : String(error)}`)
        }
      } finally { delivering.delete(reminder.id) }
    }
  }

  start() { this.#stopped = false; this.#schedule(0) }
  stop() { this.#stopped = true; if (this.#timer) clearTimeout(this.#timer) }

  /** Wakes at the next due time (at most every 30 s, to notice resumes and retries). */
  #schedule(delay?: number) {
    if (this.#stopped) return
    if (this.#timer) clearTimeout(this.#timer)
    const run = async () => {
      try { await this.tick() } catch (error) { console.warn(`[oc-enhance] reminders: ${error instanceof Error ? error.message : String(error)}`) }
      const next = (await this.list().catch(() => []))[0]
      this.#schedule(next ? Math.min(30_000, Math.max(1000, next.due - this.now())) : 30_000)
    }
    this.#timer = setTimeout(() => void run(), delay ?? 0)
    this.#timer.unref?.()
  }
}
