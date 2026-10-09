export interface ModelsInfo {
  providers: { id: string; name: string; models: string[]; available: boolean }[]
  roles: Record<string, string | null>
}

export interface ChatGPTStatus {
  connected: boolean
  email?: string
  /** signed in AND allowed to use the plan — sign-in alone can't run models */
  planUsage: boolean
  models: { slug: string; name: string }[]
  welcomed: boolean
  signedInAt?: string
  manageUsageUrl: string
}

/** OpenAI's page where users see and cap what each app spends from their plan */
export const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage"

export interface SourceFile {
  path: string
  size: number
  status: string
  grade: string | null
  title: string | null
}

export interface MemoryNote {
  id: string
  kind: string
  content: string
  approved: boolean
}

export interface SessionInfo {
  id: string
  title: string | null
  messages: number
}

export interface WorkspaceInfo {
  name: string
  root: string
}

export const getJson = <T,>(url: string): Promise<T> => fetch(url).then((r) => r.json())

export const send = (url: string, method: string, body?: unknown): Promise<Response> =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

/** friendly step names for the timeline */
export const STEP_NAMES: Record<string, string> = {
  list_sources: "listing files",
  read_source: "reading source",
  ingest_source: "ingesting source",
  search_library: "searching library",
  search_scholar: "searching literature",
  fetch_paper: "fetching paper",
  draft_section: "writing · verified",
  export_draft: "exporting",
  check_references: "checking references",
  remember: "memory note",
  ask_document: "reading visually",
  view_page: "viewing figure",
  edit_source: "editing file",
  search_sessions: "searching conversations",
  use_skill: "using skill",
  create_skill: "writing skill",
  update_plan: "planning",
  synthesize: "synthesizing · finding tensions",
  map_source: "mapping concepts",
  related: "exploring the map",
  delegate: "delegating to sub-agents",
}

/** icon name per tool (rendered by <Icon/> as black SVG) */
export const STEP_ICONS: Record<string, string> = {
  list_sources: "list",
  read_source: "filetext",
  ingest_source: "box",
  search_library: "search",
  search_scholar: "globe",
  fetch_paper: "download",
  draft_section: "pen",
  export_draft: "export",
  check_references: "check",
  remember: "diamond",
  ask_document: "eye",
  view_page: "eye",
  read_pages: "pages",
  save_note: "note",
  read_note: "note",
  edit_source: "pen",
  search_sessions: "search",
  use_skill: "book",
  create_skill: "book",
  update_plan: "check",
  synthesize: "diamond",
  map_source: "globe",
  related: "globe",
  delegate: "diamond",
}
