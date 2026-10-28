// Source control: which repository it shows, the git operations (one at a time, no queue), the status
// line, the 4 s status refresh and the stale-answer guards. The parts render themselves. One instance is the
// "Source Control" view of the main card (the sidebar's folder); createSourceControlPanel makes another for
// a single folder in a narrow column, beside a terminal.

import type { GitStatus } from "../../bindings/GitStatus";
import { call } from "../../core/api";
import { on } from "../../core/bus";
import { h } from "../../core/dom";
import { leaf } from "../../core/format";
import { isWindows } from "../../core/platform";
import { updateSettings } from "../../core/settings";
import { type SidebarSelection, store } from "../../core/store";
import { ask } from "../../ui/dialog";
import type { MenuItem } from "../../ui/menu";
import { splitter } from "../../ui/splitter";
import { textTabs } from "../../ui/texttabs";
import { openInCode, trashName } from "../os/api";
import { startProfile } from "../profiles/api";
import { trashPath } from "../sessions/api";
import { git } from "./backend";
import { planSwitch, showBranchMenu, showRepoMenu } from "./branch";
import { type Action, type ChangeRow, createChanges } from "./changes";
import { createCommitBox } from "./commit";
import { createDiff } from "./diff";
import { newFileLines, parseDiff } from "./diffparse";
import { createHeader, type Header } from "./header";
import { createHistory } from "./history";
import { pickTarget, selectionFolders } from "./repos";
import {
  binaryFile,
  type CommitAction,
  changeCount,
  changesTab,
  commitAction,
  commitLabel,
  deleteNewFile,
  discardFile,
  errorText,
  LOG_ARGS,
  largeFile,
  notRepo,
  parseLog,
  type Sync,
  stashMessage,
  successText,
  TEXT,
  unpublishedCount,
} from "./strings";
import "./git.css";

const POLL_MS = 4000;
const MESSAGE_MS = 4000;
const LEFT_MIN = 260;
/** Room the diff keeps when the left column is dragged wide. */
const RIGHT_MIN = 200;

type Tab = "changes" | "history";
type FileRow = Extract<ChangeRow, { kind: "file" }>;

interface SourceControlOptions {
  /** The folders to show the repository of (a project's: the bar picks among its repositories). */
  selection(): SidebarSelection | null;
  /** Besides being shown, idle and in a focused window: whether the status may be polled now. */
  canPoll(): boolean;
  /** Changes and diff side by side with a saved divider (the card), else stacked (a narrow column). */
  split: boolean;
}

function createSourceControl(opts: SourceControlOptions) {
  const st = {
    visible: false,
    /** The folder in view (a repository, or a folder that is not one). */
    folder: null as string | null,
    /** Top of the repository; null when there is none. */
    repo: null as string | null,
    repos: [] as string[],
    pick: null as string | null,
    busy: false,
    sync: { hasUpstream: false, ahead: 0, behind: 0 } as Sync,
    staged: 0,
    changes: 0,
    tab: "changes" as Tab,
    /** What the diff pane should show ("section|path|status" or "commit|<hash>"); answers for others are dropped. */
    diffKey: null as string | null,
  };
  let refreshSeq = 0;
  let statusSeq = 0;
  let historySeq = 0;

  let header: Header;
  const changes = createChanges({ onSelect: () => void showSelectedDiff(), onOpen: (r) => openFile(r), onAction });
  const history = createHistory(
    (hash) => void showCommit(hash),
    () => st.repo,
  );
  const diff = createDiff();
  const commit = createCommitBox({ onAction: commitButton, menu: commitMenu, generate: generateMessage });
  const tabs = textTabs<Tab>({
    label: "Changes or history",
    items: [
      { id: "changes", label: changesTab(0) },
      { id: "history", label: "History" },
    ],
    value: "changes",
    onChange: (id) => showTab(id),
  });
  const messageEl = h("div", { class: "git-status-line", attrs: { role: "status" } });
  messageEl.hidden = true;
  let messageTimer: ReturnType<typeof setTimeout> | undefined;

  // ---------- status line ----------

  /** Progress and results fade after 4 s (not while busy); errors stay until replaced. */
  function message(text: string, error = false) {
    messageEl.textContent = text;
    messageEl.classList.toggle("err", error);
    messageEl.hidden = !text;
    clearTimeout(messageTimer);
    if (text && !error && !st.busy) {
      messageTimer = setTimeout(() => {
        if (!st.busy) messageEl.hidden = true;
      }, MESSAGE_MS);
    }
  }

  function setBusy(busy: boolean) {
    st.busy = busy;
    header.setBusy(busy);
    commit.setBusy(busy);
  }

  // ---------- paths ----------

  function sep(): string {
    return isWindows() ? "\\" : "/";
  }

  function fullPath(repo: string, rel: string): string {
    return `${repo.replace(/[\\/]+$/, "")}${sep()}${rel.replaceAll("/", sep())}`;
  }

  // ---------- loading ----------

  function showNothing(text: string, status = "") {
    st.repo = null;
    st.diffKey = null;
    st.staged = st.changes = 0;
    header.setBranch(null);
    header.setCount("");
    commit.setAction("commit", commitLabel(0));
    setTabLabel(0);
    changes.set(null);
    history.set([]);
    diff.clear(text);
    message(status);
  }

  /** Works out the repository for the sidebar selection and loads it. */
  async function refresh() {
    if (!st.visible) return;
    const seq = ++refreshSeq;
    const sel = opts.selection();
    const found = await Promise.all(
      selectionFolders(sel).map(async (path) => {
        const res = await call("find_repos", { path }, { quiet: true });
        return res.ok ? res.value : [];
      }),
    );
    if (seq !== refreshSeq) return;
    const target = pickTarget(sel, found, st.pick, store.get().platform.os);
    st.repos = target.repos;
    st.pick = target.repos.length ? target.folder : st.pick;
    st.folder = target.folder;
    const label = target.folder && target.repos.length ? leaf(target.folder) : null;
    header.setRepo(label, target.folder ?? undefined);
    if (!target.folder) return showNothing(TEXT.selectFolder);

    const top = await git(target.folder, ["rev-parse", "--show-toplevel"]);
    if (seq !== refreshSeq) return;
    if (top.missing) return showNothing(TEXT.selectFolder);
    if (top.code === -1) return showNothing(top.stderr, top.stderr); // git itself is missing
    if (top.code !== 0) return showNothing(notRepo(target.folder), TEXT.notRepoStatus);
    const repo = isWindows() ? top.stdout.trim().replaceAll("/", "\\") : top.stdout.trim();
    if (repo !== st.repo) {
      changes.clearSelection();
      history.clearSelection();
      message("");
    }
    st.repo = repo;
    await loadStatus();
    if (st.tab === "history") await loadHistory();
  }

  async function loadStatus(poll = false) {
    const repo = st.repo;
    if (!repo) return;
    const seq = ++statusSeq;
    const res = await call("git_status", { repo, poll }, { quiet: true });
    if (seq !== statusSeq || repo !== st.repo) return;
    if (!res.ok) {
      message(res.error.message, true);
      return;
    }
    // a branch not published yet has no upstream to count against: count the commits no remote has, before
    // anything is drawn (drawing first and the count after made the push button blink on every refresh)
    let unpublished = 0;
    if (res.value.upstream === null && !res.value.branch.startsWith("HEAD")) {
      const out = await git(repo, ["log", "--format=%h", "--max-count=999", "HEAD", "--not", "--remotes"], { poll });
      if (seq !== statusSeq || repo !== st.repo) return;
      if (out.code === 0) unpublished = unpublishedCount(out.stdout);
    }
    applyStatus(res.value, unpublished);
  }

  /** `unpublished`: commits of a branch without upstream that no remote has (its push count). */
  function applyStatus(s: GitStatus, unpublished = 0) {
    st.sync = {
      hasUpstream: s.upstream !== null,
      ahead: s.upstream === null ? unpublished : s.ahead,
      behind: s.behind,
    };
    st.staged = s.staged.length;
    st.changes = s.changes.length;
    const total = st.staged + st.changes;
    header.setBranch(s.branch, st.sync);
    header.setCount(changeCount(total));
    const button = commitAction(st.staged, st.changes, s.branch, st.sync);
    commit.setAction(button.action, button.label);
    setTabLabel(total);
    changes.set(s);
    if (st.tab === "changes") void showSelectedDiff();
  }

  function setTabLabel(total: number) {
    const label = changesTab(total);
    if (tabs.el.querySelector(".ttab")?.textContent === label) return;
    tabs.setItems([
      { id: "changes", label },
      { id: "history", label: "History" },
    ]);
  }

  async function showSelectedDiff() {
    if (st.tab !== "changes") return;
    const row = changes.selected();
    const repo = st.repo;
    if (!row || !repo) {
      st.diffKey = null;
      diff.clear(repo ? TEXT.selectFile : TEXT.selectFolder);
      return;
    }
    const { section, change } = row;
    const key = `${section}|${change.path}|${change.status}`;
    st.diffKey = key;
    if (change.status === "U") {
      const res = await call("read_new_file", { repo, path: change.path }, { quiet: true });
      if (st.diffKey !== key) return;
      if (!res.ok) return diff.clear(res.error.message);
      const f = res.value;
      if (f.kind === "missing") diff.clear(TEXT.fileNotFound);
      else if (f.kind === "large") diff.clear(largeFile(change.name, f.size));
      else if (f.kind === "binary") diff.clear(binaryFile(change.name));
      else diff.show(newFileLines(change.path, f.text), `${key}\n${f.text}`);
      return;
    }
    const args =
      section === "staged"
        ? ["diff", "--cached", "--no-color", "--", change.path]
        : ["diff", "--no-color", "--", change.path];
    const out = await git(repo, args);
    if (st.diffKey !== key) return;
    showOutput(out.code, out.stdout, out.stderr, key, TEXT.noTextChanges);
  }

  function showOutput(code: number, stdout: string, stderr: string, key: string, emptyText: string) {
    const lines = parseDiff(stdout);
    if (lines.length) diff.show(lines, `${key}\n${stdout}`);
    else diff.clear(code !== 0 && stderr.trim() ? errorText(code, stdout, stderr) : emptyText);
  }

  async function loadHistory() {
    const repo = st.repo;
    if (!repo) {
      history.set([]);
      return;
    }
    const seq = ++historySeq;
    const out = await git(repo, LOG_ARGS);
    if (seq !== historySeq || repo !== st.repo) return;
    // an unborn branch has no HEAD to log: an empty history
    history.set(out.code === 0 ? parseLog(out.stdout) : []);
    if (st.tab === "history") void showCommit(history.selected());
  }

  async function showCommit(hash: string | null) {
    const repo = st.repo;
    if (st.tab !== "history" || !repo) return;
    if (!hash) {
      st.diffKey = null;
      diff.clear(TEXT.selectCommit);
      return;
    }
    const key = `commit|${hash}`;
    st.diffKey = key;
    const out = await git(repo, ["show", "--no-color", "--stat", "--patch", "--format=fuller", hash]);
    if (st.diffKey !== key) return;
    showOutput(out.code, out.stdout, out.stderr, key, TEXT.emptyCommit);
  }

  function showTab(tab: Tab) {
    st.tab = tab;
    changes.el.hidden = tab !== "changes";
    history.el.hidden = tab !== "history";
    if (tab === "history") void loadHistory();
    else void showSelectedDiff();
  }

  // ---------- operations ----------

  interface OpOptions {
    stdin?: string | null;
    /** Runs only when git succeeded. */
    after?: () => void;
  }

  /** Runs one git operation: ignored while another runs (no queue); then the lists refresh. */
  /** Runs git on the repository in view, shows how it went, and reloads. Resolves true when git succeeded. */
  async function runOp(args: string[], busyText = "", opts: OpOptions = {}): Promise<boolean> {
    const repo = st.repo;
    if (!repo || st.busy) return false;
    setBusy(true);
    if (busyText) message(busyText);
    const out = await git(repo, args, { stdin: opts.stdin });
    setBusy(false);
    if (repo === st.repo) {
      if (out.code !== 0) message(errorText(out.code, out.stdout, out.stderr), true);
      else {
        message(successText(out.stdout, out.stderr));
        opts.after?.();
      }
    }
    void loadStatus();
    if (st.tab === "history") void loadHistory();
    return out.code === 0;
  }

  function push() {
    if (st.sync.hasUpstream) void runOp(["push"], "Pushing...");
    else void runOp(["push", "-u", "origin", "HEAD"], "Publishing branch...");
  }

  /** The commit button: commit, or with nothing to commit pull then push (sync), or publish the branch. */
  function commitButton(action: CommitAction) {
    if (action === "commit") void doCommit();
    else if (action === "publish") push();
    else if (st.sync.behind) void runOp(["pull"], "Syncing...", { after: () => st.sync.ahead && push() });
    else push();
  }

  /** Has Claude write a message for what Commit would take (staged changes, else all of them). */
  async function generateMessage(): Promise<string | null> {
    const repo = st.repo;
    if (!repo) return null;
    if (!st.staged && !st.changes) {
      message(TEXT.nothingToCommit);
      return null;
    }
    message(TEXT.generating);
    const res = await call("git_commit_message", { repo, profile: startProfile() }, { quiet: true });
    if (repo !== st.repo) return null;
    if (!res.ok) {
      message(res.error.message, true);
      return null;
    }
    message("");
    return res.value;
  }

  async function doCommit(opts: { push?: boolean; amend?: boolean } = {}) {
    if (!st.repo) return;
    const msg = commit.message().trim();
    if (opts.amend) {
      const args = msg ? ["commit", "--amend", "-F", "-"] : ["commit", "--amend", "--no-edit"];
      void runOp(args, "Amending...", { stdin: msg || null, after: () => commit.clear() });
      return;
    }
    if (!msg) {
      message(TEXT.typeMessage, true);
      commit.focus();
      return;
    }
    let stageAll = false;
    if (!st.staged) {
      if (!st.changes) {
        message(TEXT.nothingToCommit);
        return;
      }
      if (!(await ask(TEXT.stageAllAndCommit, "Commit"))) return;
      stageAll = true;
    }
    const commitNow = () =>
      void runOp(["commit", "-F", "-"], "Committing...", {
        stdin: msg,
        after: () => {
          commit.clear();
          if (opts.push) push();
        },
      });
    // nothing staged: stage everything first (new files too), like VS Code's smart commit
    if (stageAll) void runOp(["add", "-A"], "Staging...", { after: commitNow });
    else commitNow();
  }

  function commitMenu(): MenuItem[] {
    return [
      { label: "Commit & Push", icon: "push", run: () => void doCommit({ push: true }) },
      { label: "Amend last commit", icon: "commit", run: () => void doCommit({ amend: true }) },
      {
        label: "Undo last commit",
        icon: "undo",
        run: async () => {
          const repo = st.repo;
          if (!repo || !(await ask(TEXT.undoCommit, "Undo commit"))) return;
          // like VS Code: the undone commit's message comes back into the box, to edit and commit again
          const last = await git(repo, ["log", "-1", "--format=%B"]);
          const ok = await runOp(["reset", "--soft", "HEAD~1"], "Undoing last commit...");
          if (ok && last.code === 0 && repo === st.repo && !commit.message().trim()) {
            commit.setMessage(last.stdout.trim());
          }
        },
      },
      { kind: "separator" },
      {
        label: "Stash all changes",
        icon: "stash",
        run: () => void runOp(["stash", "push", "-u", "-m", stashMessage()], "Stashing..."),
      },
      { label: "Pop latest stash", icon: "pull", run: () => void runOp(["stash", "pop"], "Applying stash...") },
      { kind: "separator" },
      {
        label: "Open folder in VS Code",
        icon: "vscode",
        disabled: !st.repo,
        run: () => {
          if (st.repo) void openInCode([st.repo]);
        },
      },
    ];
  }

  function openFile(row: FileRow) {
    // a deleted file has nothing to open
    if (st.repo && row.change.status !== "D") void openInCode([fullPath(st.repo, row.change.path)]);
  }

  async function onAction(row: ChangeRow, action: Action) {
    const repo = st.repo;
    if (!repo) return;
    if (row.kind === "section") {
      if (action === "stageAll") void runOp(["add", "-A"]);
      else if (action === "unstageAll") void runOp(["reset", "-q"]);
      else if (action === "discardAll" && (await ask(TEXT.discardAll, "Discard all", "warning"))) {
        void runOp(["restore", "--", ":/"]);
      }
      return;
    }
    const { path, status } = row.change;
    switch (action) {
      case "open":
        openFile(row);
        break;
      case "stage":
        void runOp(["add", "--", path]);
        break;
      case "unstage":
        void runOp(["restore", "--staged", "--", path]);
        break;
      case "discard":
        if (status === "U") {
          if (!(await ask(deleteNewFile(path, trashName()), "Discard", "warning"))) return;
          if (await trashPath(fullPath(repo, path), repo)) void loadStatus();
        } else if (await ask(discardFile(path), "Discard", "warning")) {
          void runOp(["restore", "--", path]);
        }
        break;
    }
  }

  // ---------- layout ----------

  function buildBody(body: HTMLElement) {
    const left = h(
      "div",
      { class: "git-left" },
      ...commit.els,
      h("div", { class: "git-tabs" }, tabs.el),
      h("div", { class: "git-lists" }, changes.el, history.el),
    );
    history.el.hidden = true;
    const divider = h("div", { class: "git-divider" });
    const main = h("div", { class: "git-main" }, left, divider, h("div", { class: "git-right" }, diff.el));
    body.classList.add("git-view");
    body.append(main, messageEl);

    if (!opts.split) {
      diff.clear(TEXT.selectFolder);
      return;
    }
    const setLeft = (px: number | null) => {
      left.style.width = px === null ? "" : `${px}px`;
    };
    splitter({
      el: divider,
      label: "Resize the changes column",
      get: () => left.getBoundingClientRect().width,
      min: LEFT_MIN,
      max: () => Math.max(LEFT_MIN, main.clientWidth - RIGHT_MIN),
      onResize: setLeft,
      onCommit: (px) => void updateSettings({ gitSplit: px }),
    });
    // saved width, else clamp(290px, 34%, 380px) from git.css
    store.select((s) => s.settings.gitSplit, setLeft, { immediate: true });
    diff.clear(TEXT.selectFolder);
  }

  function headerActions(el: HTMLElement) {
    header = createHeader(el, {
      onRepoMenu: (anchor) =>
        showRepoMenu(anchor, st.repos, st.folder, (repo) => {
          st.pick = repo;
          void refresh();
        }),
      onBranchMenu: (anchor) => {
        if (!st.repo) return;
        void showBranchMenu(anchor, st.repo, {
          switchTo: async (name) => {
            const repo = st.repo;
            const steps = repo ? await planSwitch(repo, name) : null;
            if (!steps || repo !== st.repo) return;
            for (const args of steps) {
              const ok = await runOp(args, args[0] === "stash" ? "Stashing..." : `Switching to ${name}...`);
              if (!ok) break;
            }
          },
          create: (name) => void runOp(["switch", "-c", name], `Creating ${name}...`),
          error: (text) => message(text, true),
        });
      },
      onFetch: () => void runOp(["fetch", "--prune"], "Fetching..."),
      onPull: () => void runOp(["pull"], "Pulling..."),
      onPush: push,
      onRefresh: () => refresh(),
    });
  }

  function pollable(): boolean {
    const s = store.get();
    return (
      st.visible &&
      !st.busy &&
      st.repo !== null &&
      s.windowFocused &&
      opts.canPoll() &&
      s.screen === "main" &&
      document.hasFocus()
    );
  }

  setInterval(() => {
    if (pollable()) void loadStatus(true);
  }, POLL_MS);

  return {
    buildBody,
    headerActions,
    refresh,
    show() {
      st.visible = true;
      void refresh();
    },
    hide() {
      st.visible = false;
    },
  };
}

const card = createSourceControl({
  selection: () => store.get().sidebarSelection,
  canPoll: () => store.get().activeTerminal === null,
  split: true,
});

export const gitView = {
  id: "git" as const,
  title: "Source Control",
  order: 1,
  mount: card.buildBody,
  headerActions: card.headerActions,
  onShow: card.show,
  onHide: card.hide,
};

/** Follows the sidebar selection. */
export function startFollowing(): void {
  store.select(
    (s) => s.sidebarSelection,
    () => void card.refresh(),
  );
  on("refresh:full", () => void card.refresh());
}

export interface SourceControlPanel {
  el: HTMLElement;
  /** The folder whose repository is shown (null = none). */
  setFolder(dir: string | null): void;
  /** Loads and polls only while shown. */
  setShown(shown: boolean): void;
}

/** Source control of one folder in a narrow column: the head's controls on top, then the commit box and
 * lists, and the diff below them. Polls while a terminal is in front (the card polls while Home is). */
export function createSourceControlPanel(): SourceControlPanel {
  let folder: string | null = null;
  let shown = false;
  const sc = createSourceControl({
    selection: () => (folder ? { kind: "folder", key: folder, path: folder } : null),
    canPoll: () => store.get().activeTerminal !== null,
    split: false,
  });
  const head = h("div", { class: "git-panel-head" });
  const body = h("div", { class: "git-panel-body" });
  sc.headerActions(head);
  sc.buildBody(body);
  on("refresh:full", () => void sc.refresh());
  return {
    el: h("div", { class: "git-panel" }, head, body),
    setFolder(dir) {
      if (dir === folder) return;
      folder = dir;
      void sc.refresh();
    },
    setShown(next) {
      if (next === shown) return;
      shown = next;
      if (shown) sc.show();
      else sc.hide();
    },
  };
}
