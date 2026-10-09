import { useEffect, useState } from "react"
import { getJson, send } from "../api"

interface SkillMeta {
  name: string
  description: string
  status: "active" | "pending" | "disabled"
  size: number
}

export default function Skills() {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [open, setOpen] = useState<string | null>(null) // name being edited
  const [desc, setDesc] = useState("")
  const [body, setBody] = useState("")
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")

  const refresh = () =>
    getJson<{ skills: SkillMeta[] }>("/api/skills")
      .then((d) => setSkills(d.skills ?? []))
      .catch(() => {})
  useEffect(() => {
    void refresh()
  }, [])

  async function openEditor(name: string) {
    const s = await getJson<{ description: string; body: string }>(`/api/skills/${name}`)
    setDesc(s.description)
    setBody(s.body)
    setCreating(false)
    setOpen(name)
  }

  async function save() {
    if (creating) {
      if (!newName.trim() || !desc.trim() || !body.trim()) return
      await send("/api/skills", "POST", { name: newName.trim(), description: desc, instructions: body })
    } else if (open) {
      await send(`/api/skills/${open}`, "PUT", { description: desc, instructions: body })
    }
    setOpen(null)
    setCreating(false)
    setNewName("")
    await refresh()
  }

  const setStatus = (name: string, status: string) =>
    void send(`/api/skills/${name}`, "PUT", { status }).then(refresh)
  const remove = (name: string) => void send(`/api/skills/${name}`, "DELETE").then(refresh)

  const pending = skills.filter((s) => s.status === "pending")
  const rest = skills.filter((s) => s.status !== "pending")

  const editor = (
    <div className="border-t border-dashed border-faint bg-paper px-4 py-3">
      <input
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="one line: when does this skill apply?"
        className="w-full border border-linec bg-surface px-3 py-1.5 text-[13px] outline-none focus:border-accent"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={12}
        spellCheck={false}
        placeholder={"# The skill\n\nConcise markdown instructions the agent follows…"}
        className="mt-2 w-full resize-y border border-linec bg-surface px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus:border-accent"
      />
      <div className="mt-2 flex items-center gap-2">
        <button onClick={() => void save()} className="bg-ink px-4 py-1.5 text-[12px] font-medium text-paper">
          Save
        </button>
        <button
          onClick={() => {
            setOpen(null)
            setCreating(false)
          }}
          className="px-3 py-1.5 text-[12px] text-muted hover:text-ink"
        >
          cancel
        </button>
        <span className="steplabel ml-auto">markdown · loaded by the agent on demand</span>
      </div>
    </div>
  )

  const Row = ({ s }: { s: SkillMeta }) => (
    <div className="bg-surface">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <span className="font-mono text-[12.5px] font-semibold">{s.name}</span>
        {s.status === "pending" && (
          <span className="font-mono text-[10px] uppercase text-warn">pending</span>
        )}
        {s.status === "disabled" && (
          <span className="font-mono text-[10px] uppercase text-faint">off</span>
        )}
        {s.status === "active" && <span className="font-mono text-[10px] uppercase text-ok">on</span>}
        <span className="ml-auto flex flex-none gap-1 text-[12px]">
          {s.status === "pending" ? (
            <button onClick={() => setStatus(s.name, "active")} className="px-2 py-1 hover:bg-paper">
              approve
            </button>
          ) : (
            <button
              onClick={() => setStatus(s.name, s.status === "active" ? "disabled" : "active")}
              className="px-2 py-1 text-muted hover:bg-paper hover:text-ink"
            >
              {s.status === "active" ? "disable" : "enable"}
            </button>
          )}
          <button
            onClick={() => (open === s.name && !creating ? setOpen(null) : void openEditor(s.name))}
            className="px-2 py-1 text-muted hover:bg-paper hover:text-ink"
          >
            {open === s.name && !creating ? "close" : "edit"}
          </button>
          <button onClick={() => remove(s.name)} className="px-2 py-1 text-bad hover:bg-paper">
            delete
          </button>
        </span>
      </div>
      <p className="px-4 pb-3 text-[13px] text-muted">{s.description}</p>
      {open === s.name && !creating && editor}
    </div>
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[var(--container-chat)] px-6 py-10">
        <h1 className="font-serif text-2xl font-semibold">Skills</h1>
        <p className="mt-1 text-sm text-muted">
          Reusable expertise the agent loads when a task calls for it — venue rubrics, writing
          formats, methods. One library for the whole app, shared by every workspace: markdown
          files in <code className="font-mono text-[11.5px]">~/.abstract/skills</code>; you and
          the agent can both write them. Skills shape style and method — verification stays
          code-enforced and no skill can weaken it.
        </p>

        {pending.length > 0 && (
          <>
            <span className="steplabel mb-1 mt-8 block font-bold">
              pending — the agent proposed these
            </span>
            <div className="divide-y divide-linec border border-warn/50">
              {pending.map((s) => (
                <Row key={s.name} s={s} />
              ))}
            </div>
          </>
        )}

        <span className="steplabel mb-1 mt-8 block font-bold">skills</span>
        <div className="divide-y divide-linec border border-linec">
          {rest.length === 0 && (
            <p className="bg-surface px-4 py-3 text-sm text-muted">No skills yet.</p>
          )}
          {rest.map((s) => (
            <Row key={s.name} s={s} />
          ))}
          {!creating ? (
            <button
              onClick={() => {
                setCreating(true)
                setOpen(null)
                setNewName("")
                setDesc("")
                setBody("")
              }}
              className="w-full bg-surface px-4 py-2.5 text-center text-sm text-muted hover:text-ink"
            >
              + New skill
            </button>
          ) : (
            <div className="bg-surface">
              <div className="flex items-center gap-2 px-4 pt-3">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="skill-name (kebab-case)"
                  className="w-64 border border-linec bg-paper px-3 py-1.5 font-mono text-[12px] outline-none focus:border-accent"
                />
                <span className="steplabel">new skill</span>
              </div>
              {editor}
            </div>
          )}
        </div>

        <p className="mt-3 text-[12px] text-muted">
          Ask in chat and the agent writes one for you — “create a skill for how I write IEEE
          reports” — it will interview you first. Skills it proposes on its own wait here for your
          approval.
        </p>
      </div>
    </div>
  )
}
