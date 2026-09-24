/**
 * Versioning on top of git: the workflow file lives in a GitHub repository and every save is a
 * commit, so history, diffs and rollback come from git rather than from a bespoke undo stack.
 *
 * The token is entered in the UI and kept in localStorage of the user's own browser — it never
 * reaches this app's code, the static build, or any server. Use a fine-grained token limited to
 * one repository with Contents: Read and write.
 */

export interface GitConfig {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
}

const KEY = "etl-studio:git";

export function loadGitConfig(): GitConfig | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GitConfig;
  } catch {
    return null;
  }
}

export function saveGitConfig(config: GitConfig | null): void {
  if (config) localStorage.setItem(KEY, JSON.stringify(config));
  else localStorage.removeItem(KEY);
}

function api(config: GitConfig, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com/repos/${config.owner}/${config.repo}/${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
}

async function explain(res: Response): Promise<never> {
  let detail = `${res.status}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) detail = `${res.status}: ${body.message}`;
  } catch {
    /* keep the bare status when the body is not JSON */
  }
  if (res.status === 401) detail += " — токен неверный или истёк";
  if (res.status === 403) detail += " — нет прав: нужен Contents: Read and write";
  if (res.status === 404) detail += " — репозиторий/файл не найден или токен без доступа";
  throw new Error(detail);
}

/** UTF-8 safe base64: btoa() alone breaks on the Cyrillic that Russian node titles produce. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface RemoteFile {
  content: string;
  sha: string;
  updatedAt: string | null;
}

export async function getFile(config: GitConfig, ref?: string): Promise<RemoteFile | null> {
  const query = `contents/${encodeURIComponent(config.path)}?ref=${encodeURIComponent(ref || config.branch)}`;
  const res = await api(config, query);
  if (res.status === 404) return null;
  if (!res.ok) await explain(res);
  const body = (await res.json()) as {
    content?: string;
    sha: string;
    encoding?: string;
    type?: string;
  };
  if (body.type === "dir") throw new Error("Путь указывает на папку, а не на файл");
  const content = body.content
    ? fromBase64(body.content)
    : body.encoding === "none"
      ? ""
      : fromBase64(await (await fetch((body as unknown as { download_url: string }).download_url)).text());
  return { content, sha: body.sha, updatedAt: null };
}

export interface CommitInfo {
  sha: string;
  message: string;
  date: string;
  author: string;
}

export async function listCommits(config: GitConfig, limit = 30): Promise<CommitInfo[]> {
  const res = await api(
    config,
    `commits?path=${encodeURIComponent(config.path)}&sha=${encodeURIComponent(config.branch)}&per_page=${limit}`,
  );
  if (!res.ok) await explain(res);
  const body = (await res.json()) as Array<{
    sha: string;
    commit: { message: string; author: { date: string; name: string } | null };
  }>;
  return body.map((c) => ({
    sha: c.sha,
    message: c.commit.message.split("\n")[0],
    date: c.commit.author?.date || "",
    author: c.commit.author?.name || "",
  }));
}

export async function commitFile(
  config: GitConfig,
  content: string,
  message: string,
): Promise<{ sha: string; url: string }> {
  const existing = await getFile(config);
  const res = await api(config, `contents/${encodeURIComponent(config.path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: toBase64(content),
      branch: config.branch,
      ...(existing ? { sha: existing.sha } : {}),
    }),
  });
  if (!res.ok) await explain(res);
  const body = (await res.json()) as { content?: { sha: string; html_url: string } };
  return {
    sha: body.content?.sha || "",
    url: body.content?.html_url || `https://github.com/${config.owner}/${config.repo}`,
  };
}

export async function getFileAtRef(config: GitConfig, sha: string): Promise<string> {
  const file = await getFile(config, sha);
  if (!file) throw new Error(`В коммите ${sha.slice(0, 7)} файла нет`);
  return file.content;
}
