/** Версионирование на базе git: рабочий процесс лежит файлом в GitHub-репозитории. */
import { useEffect, useState } from "react";
import {
  commitFile,
  getFile,
  getFileAtRef,
  listCommits,
  loadGitConfig,
  saveGitConfig,
  type CommitInfo,
  type GitConfig,
} from "../git";

interface Props {
  open: boolean;
  onClose: () => void;
  serialize: () => string;
  apply: (json: string, source: string) => void;
}

const EMPTY: GitConfig = {
  owner: "",
  repo: "",
  branch: "main",
  path: "workflows/my-workflow.json",
  token: "",
};

export function GitPanel({ open, onClose, serialize, apply }: Props) {
  const [config, setConfig] = useState<GitConfig>(loadGitConfig() || EMPTY);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (open) setConfig(loadGitConfig() || EMPTY);
  }, [open]);

  if (!open) return null;

  const ready = Boolean(config.owner && config.repo && config.token);
  const field = (key: keyof GitConfig) => ({
    value: config[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setConfig({ ...config, [key]: e.target.value }),
  });

  const guard = async (run: () => Promise<string>) => {
    setBusy(true);
    setStatus("");
    try {
      saveGitConfig(config);
      setStatus(await run());
    } catch (error) {
      setStatus(`✗ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2>Версии в GitHub</h2>
          <button className="btn btn--ghost" onClick={onClose}>
            ✕
          </button>
        </header>

        <p className="muted">
          Каждое сохранение — коммит. Токен хранится только в вашем браузере (localStorage) и
          отправляется напрямую в api.github.com. Нужен fine-grained токен на один репозиторий с
          правом <code>Contents: Read and write</code>.
        </p>

        <div className="grid2">
          <label>
            владелец
            <input {...field("owner")} placeholder="Valeonl" spellCheck={false} />
          </label>
          <label>
            репозиторий
            <input {...field("repo")} placeholder="etl-studio" spellCheck={false} />
          </label>
          <label>
            ветка
            <input {...field("branch")} spellCheck={false} />
          </label>
          <label>
            путь к файлу
            <input {...field("path")} spellCheck={false} />
          </label>
          <label className="grid2__wide">
            токен (github_pat_… или ghp_…)
            <input {...field("token")} type="password" spellCheck={false} autoComplete="off" />
          </label>
        </div>

        <label>
          сообщение коммита
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`workflow: правки от ${new Date().toLocaleString("ru-RU")}`}
            spellCheck={false}
          />
        </label>

        <div className="modal__actions">
          <button
            className="btn btn--primary"
            disabled={!ready || busy}
            onClick={() =>
              guard(async () => {
                const result = await commitFile(
                  config,
                  serialize(),
                  message.trim() || `workflow: правки от ${new Date().toLocaleString("ru-RU")}`,
                );
                setMessage("");
                return `✓ коммит ${result.sha.slice(0, 7)} — ${result.url}`;
              })
            }
          >
            Сохранить в GitHub
          </button>

          <button
            className="btn"
            disabled={!ready || busy}
            onClick={() =>
              guard(async () => {
                const file = await getFile(config);
                if (!file) return "файла в репозитории ещё нет";
                apply(file.content, "загружено из GitHub");
                return "✓ рабочая область заменена версией из репозитория";
              })
            }
          >
            Загрузить из GitHub
          </button>

          <button
            className="btn"
            disabled={!ready || busy}
            onClick={() =>
              guard(async () => {
                const file = await getFile(config);
                return file
                  ? `✓ доступ есть, в файле ${file.content.length} символов`
                  : "✓ доступ есть, файла пока нет — первое сохранение создаст его";
              })
            }
          >
            Проверить доступ
          </button>

          <button
            className="btn"
            disabled={!ready || busy}
            onClick={() =>
              guard(async () => {
                const list = await listCommits(config);
                setCommits(list);
                setShowHistory(true);
                return `✓ коммитов по этому файлу: ${list.length}`;
              })
            }
          >
            История
          </button>
        </div>

        {status && <div className="modal__status">{status}</div>}

        {showHistory && (
          <div className="history">
            {commits.length === 0 && <div className="muted">Коммитов по этому пути нет.</div>}
            {commits.map((commit) => (
              <div key={commit.sha} className="history__row">
                <div>
                  <div className="history__msg">{commit.message}</div>
                  <div className="muted">
                    {commit.sha.slice(0, 7)} · {commit.author} ·{" "}
                    {commit.date ? new Date(commit.date).toLocaleString("ru-RU") : ""}
                  </div>
                </div>
                <div className="history__actions">
                  <button
                    className="btn btn--ghost"
                    disabled={busy}
                    onClick={() =>
                      guard(async () => {
                        const json = await getFileAtRef(config, commit.sha);
                        apply(json, `коммит ${commit.sha.slice(0, 7)}`);
                        return `✓ восстановлена версия ${commit.sha.slice(0, 7)}`;
                      })
                    }
                  >
                    Восстановить
                  </button>
                  <a
                    className="btn btn--ghost"
                    target="_blank"
                    rel="noreferrer"
                    href={`https://github.com/${config.owner}/${config.repo}/commit/${commit.sha}`}
                  >
                    diff
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
