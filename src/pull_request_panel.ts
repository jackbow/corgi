//! Viewer-local PR navigation, backed by the persistent GitHub cache.
import * as tui from "@earendil-works/pi-tui";
import type { Action } from "./action";
import * as i18n from "./i18n";
import { Rect } from "./layout";
import * as palette from "./palette";
import { Writer } from "./text";
import * as pr from "./pull_request";
import * as textArea from "./text_area";
import type { Key } from "./review/panel";

export type Tab = "overview" | "discussion" | "stack";
export interface Row {
  text: string;
  action?: Action;
  color?: palette.Token;
  framed?: boolean;
  prefix?: string;
}
const action = (name: string, value?: string): Action => ({
  name: `pull-request${name ? "-" + name : ""}`,
  ...(value === undefined ? {} : { value }),
});
const clean = (value: string) => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
const ink = (value: string, color: palette.Token = "text", bold = false) =>
  new palette.Style({ fg: color, bg: "surface", bold }).sgr() + value + "\x1b[0m";
const markdownTheme: tui.MarkdownTheme = {
  heading: value => ink(value, "strong", true),
  link: value => ink(value, "accent"),
  linkUrl: value => ink(value, "muted"),
  code: value => palette.fgRgb(palette.syntax.string) + value + "\x1b[0m",
  codeBlock: value => ink(value),
  codeBlockBorder: value => ink(value, "line"),
  quote: value => ink(value, "muted"),
  quoteBorder: value => ink(value, "line"),
  hr: value => ink(value, "line"),
  listBullet: value => ink(value, "accent"),
  bold: value => ink(value, "strong", true),
  italic: value => "\x1b[3m" + value + "\x1b[23m",
  strikethrough: value => "\x1b[9m" + value + "\x1b[29m",
  underline: value => "\x1b[4m" + value + "\x1b[24m",
};
interface Target {
  rect: Rect;
  command: Action;
  component: tui.MouseRegion;
}
export class Panel {
  compose: { snapshot: pr.Snapshot; thread?: string; area: textArea.TextArea } | null = null;
  private pasted = new textArea.Typed();
  private pastedCR = false;
  private followCaret = false;
  private composeRow = 0;
  open = false;
  fullscreen = false;
  ref: pr.Ref | null = null;
  snapshot: pr.Snapshot | null = null;
  refreshing = false;
  statusRefreshing = false;
  conflictStarting = false;
  conflictSession: string | null = null;
  statusError = "";
  busy = false;
  error = "";
  confirmation: { snapshot: pr.Snapshot; kind: "merge" | "enable-auto" } | null = null;
  unresolvedOnly = false;
  checksOpen = false;
  openThreads = new Set<string>();
  foldedThreads = new Set<string>();
  tab: Tab = "overview";
  private targets: Target[] = [];
  private hovered: string | null = null;
  private pressed: string | null = null;
  private clicked: Action | null = null;
  private bodyHeight = 1;
  private selected = 0;
  top = 0;
  cursor = 0;
  private generation = 0;
  private rect = new Rect(0, 0, 0, 0);
  private visible: Row[] = [];
  changed: () => void = () => {};
  constructor(readonly cache = new pr.Cache()) {}

  beginComment(thread?: string): void {
    if (!this.snapshot || this.busy || (thread !== undefined && !this.snapshot.threads.some(t => t.id === thread)))
      return;
    this.confirmation = null;
    this.compose = { snapshot: this.snapshot, thread, area: new textArea.TextArea() };
    this.top = 0;
    this.selected = -1;
    this.followCaret = true;
    this.pasted = new textArea.Typed();
    this.pastedCR = false;
    this.error = "";
  }
  pasteByte(byte: number): void {
    if (!this.compose || this.busy) return;
    const cr = this.pastedCR;
    this.pastedCR = byte === 13;
    if (byte === 10 && cr) return;
    const text = this.pasted.take(byte);
    this.followCaret = true;
    if (text !== null && ((byte >= 32 && byte !== 127) || byte === 10 || byte === 13 || byte === 9))
      this.compose.area.insert(text === "\r" ? "\n" : text === "\t" ? "    " : text);
  }
  commentTarget(value: string): { comment: pr.Comment; thread?: pr.Thread } | null {
    try {
      const [url, id, key] = JSON.parse(value);
      if (!this.snapshot || url !== this.snapshot.ref.url || !key) return null;
      const thread = id === null ? undefined : this.snapshot.threads.find(t => t.id === id);
      if (id !== null && !thread) return null;
      const comment = (thread?.comments ?? this.snapshot.comments).find(
        c => c.at === key.at && c.author === key.author && c.body === key.body && c.url === key.url,
      );
      return comment ? { comment, thread } : null;
    } catch {
      return null;
    }
  }
  async postComment(): Promise<void> {
    const draft = this.compose;
    if (!draft || this.busy) return;
    this.busy = true;
    this.error = "";
    this.changed();
    let posted = false;
    try {
      await this.cache.client.mutate(draft.snapshot, { kind: "comment", body: draft.area.text, thread: draft.thread });
      posted = true;
      if (this.compose === draft) {
        this.compose = null;
        this.tab = "discussion";
        this.unresolvedOnly = false;
        this.top = 0;
        if (draft.thread) {
          this.openThreads.add(draft.thread);
          this.foldedThreads.delete(draft.thread);
        }
      }
      const fresh = await this.cache.refresh(draft.snapshot.ref, true);
      if (this.ref?.url === fresh.ref.url) this.snapshot = fresh;
    } catch (error) {
      const message = (error as Error).message;
      if (this.ref?.url === draft.snapshot.ref.url)
        this.error = posted ? i18n.t`Comment posted; refresh failed: ${message}` : message;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  async show(ref: pr.Ref, force = false): Promise<void> {
    const same = ref.url === this.ref?.url;
    this.open = true;
    this.ref = ref;
    this.confirmation = null;
    this.error = "";
    const generation = ++this.generation;
    this.statusRefreshing = false;
    if (!same) {
      this.compose = null;
      this.snapshot = null;
      this.top = this.cursor = 0;
      this.unresolvedOnly = false;
      this.conflictSession = null;
      this.statusError = "";
      this.checksOpen = false;
      this.openThreads.clear();
      this.foldedThreads.clear();
      this.tab = "overview";
    }
    this.refreshing = false;
    this.changed();
    try {
      const cached = await this.cache.cached(ref);
      if (generation !== this.generation) return;
      if (cached) {
        this.snapshot = cached;
        this.changed();
      }
      if (!force && cached && cached.discussionVersion === 1 && !pr.stale(cached)) return;
      this.refreshing = true;
      this.changed();
      const snapshot = await this.cache.refresh(ref);
      if (generation === this.generation) this.snapshot = snapshot;
    } catch (error) {
      if (generation === this.generation) this.error = (error as Error).message;
    } finally {
      if (generation === this.generation) {
        this.refreshing = false;
        this.changed();
      }
    }
  }
  async refreshStatus(): Promise<void> {
    if (!this.snapshot || this.statusRefreshing || this.refreshing || this.busy) return;
    const snapshot = this.snapshot,
      generation = this.generation;
    this.statusRefreshing = true;
    this.statusError = "";
    this.changed();
    try {
      const fresh = await this.cache.status(snapshot);
      if (generation === this.generation && this.ref?.url === fresh.ref.url) this.snapshot = fresh;
    } catch (error) {
      if (generation === this.generation) this.statusError = (error as Error).message;
    } finally {
      if (generation === this.generation) this.statusRefreshing = false;
      this.changed();
    }
  }
  async mutate(mutation: pr.Mutation, snapshot = this.snapshot): Promise<void> {
    if (!snapshot || this.busy) return;
    this.busy = true;
    this.confirmation = null;
    this.error = "";
    this.changed();
    try {
      await this.cache.client.mutate(snapshot, mutation);
      // Refresh the PR that changed even if the user navigated elsewhere.
      const fresh = await this.cache.refresh(snapshot.ref, true);
      if (this.ref?.url === fresh.ref.url) this.snapshot = fresh;
    } catch (error) {
      if (this.ref?.url === snapshot.ref.url) this.error = (error as Error).message;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  requestMerge(kind: "merge" | "enable-auto"): void {
    if (
      !this.snapshot ||
      this.refreshing ||
      this.statusRefreshing ||
      this.busy ||
      this.error ||
      this.statusError ||
      this.snapshot.state !== "OPEN" ||
      this.snapshot.draft
    )
      return;
    this.confirmation = { snapshot: this.snapshot, kind };
    this.top = this.cursor = 0;
    this.selected = this.snapshot.stack.length ? 6 : 5;
  }
  selectTab(value: string): void {
    if (value !== "overview" && value !== "discussion" && value !== "stack") return;
    if (value === "stack" && !this.snapshot?.stack.length) return;
    this.tab = value;
    this.confirmation = null;
    this.top = this.cursor = this.selected = 0;
  }
  rows(width: number): Row[] {
    width = Math.max(4, width);
    const rows: Row[] = [];
    let framed = false;
    const contentWidth = () => width - (framed ? 2 : 0);
    const emit = (value: string) => {
      const line = tui.truncateToWidth(value, contentWidth());
      rows.push({
        text: framed
          ? ink("│", "line") +
            line +
            " ".repeat(Math.max(0, contentWidth() - tui.visibleWidth(line))) +
            ink("│", "line")
          : line,
      });
    };
    const endCard = () => {
      if (!framed) return;
      rows.push({ text: ink("╰" + "─".repeat(width - 2) + "╯", "line") });
      framed = false;
    };
    const prose = (value: string, color: palette.Token = "text", bold = false) => {
      const box = new tui.Box(1, 0);
      box.addChild(new tui.Text(ink(clean(value), color, bold), 0, 0));
      for (const line of box.render(contentWidth())) emit(line);
    };
    const markdown = (value: string) => {
      const box = new tui.Box(1, 0);
      box.addChild(new tui.Markdown(clean(value), 0, 0, markdownTheme, { color: value => ink(value) }));
      for (const line of box.render(contentWidth())) emit(line);
    };
    const space = () => emit("");
    const section = (title: string) => {
      endCard();
      if (rows.length) space();
      const label = tui.truncateToWidth(" " + clean(title) + " ", width - 4);
      rows.push({
        text:
          ink("╭─", "line") +
          ink(label, "accent", true) +
          ink("─".repeat(Math.max(0, width - 3 - tui.visibleWidth(label))) + "╮", "line"),
      });
      framed = true;
    };
    const button = (label: string, command: Action, color: palette.Token = "accent", prefix?: string) =>
      rows.push({ text: " " + label, action: command, color, framed, prefix });
    if (this.compose) {
      const draft = this.compose,
        area = draft.area;
      const thread = draft.snapshot.threads.find(t => t.id === draft.thread);
      const location = thread ? pr.location(thread) : "";
      section(thread ? i18n.t`Reply · ${location}` : i18n.t`New PR comment`);
      prose(draft.snapshot.ref.url, "muted");
      if (thread) prose(location, "muted");
      prose(i18n.t`Enter: new line · Tab: Post / Cancel · Esc: cancel`, "faint");
      space();
      area.width = Math.max(1, contentWidth() - 2);
      const caret = area.position();
      this.composeRow = rows.length + caret.row;
      for (const [index, line] of area.lines().entries()) {
        const text = clean(area.text.slice(line.start, line.end));
        const offset = area.caret - line.start;
        const glyph = String.fromCodePoint((text + " ").codePointAt(offset) ?? 32);
        const shown =
          index === caret.row && this.selected === -1
            ? ink(text.slice(0, offset)) + "\x1b[7m" + glyph + "\x1b[27m" + ink(text.slice(offset + glyph.length))
            : ink(text || " ");
        emit(" " + shown);
      }
      space();
      endCard();
      return rows;
    }
    if (this.confirmation) {
      const c = this.confirmation;
      const target = `${c.snapshot.ref.repo} #${c.snapshot.ref.number}`,
        head = c.snapshot.head.slice(0, 12);
      section(c.kind === "merge" ? i18n.t`Merge ${target}?` : i18n.t`Enable auto-merge for ${target}?`);
      prose(i18n.t`Head: ${head}`, "muted");
      if (c.snapshot.stack.length) {
        const total = pr.orderedStack(c.snapshot).length;
        prose(
          i18n.t`This PR is part of a stack of ${total} PRs. Only this PR will be merged; its dependents may need updating.`,
          "warm",
        );
      }
      prose(i18n.t`Merge now if requirements are met, otherwise enable auto-merge.`, "muted");
      space();
      prose(i18n.t`Choose the merge method to confirm. GitHub's branch rules still apply.`);
      space();
      button(i18n.t`Squash and merge`, action("confirm", "squash"));
      button(i18n.t`Create a merge commit`, action("confirm", "merge"));
      button(i18n.t`Rebase and merge`, action("confirm", "rebase"));
      space();
      button(i18n.t`Cancel`, action("cancel"), "muted");
      endCard();
      return rows;
    }
    if (this.error) {
      prose(clean(this.error), "hot");
      space();
    }
    const s = this.snapshot;
    if (!s) {
      prose(i18n.t`Loading from GitHub…`, "muted");
      return rows;
    }
    if (this.tab === "overview") {
      section(i18n.t`Merge readiness`);
      const actionable = !this.busy && !this.refreshing && !this.statusRefreshing && !this.error && !this.statusError;
      if (s.state === "MERGED") prose(i18n.t`✓ Already merged`, "accent");
      else if (s.state === "CLOSED") prose(i18n.t`Closed without merging`, "muted");
      else if (s.draft) {
        const label = "[ " + i18n.t`Mark ready` + " - v ]";
        if (actionable) button(label, action("ready"), "accent", ink(" " + i18n.t`Draft`, "warm"));
        else prose(i18n.t`Draft` + " " + label, "warm");
      }
      if (s.state === "OPEN") {
        if (s.mergeable === "CONFLICTING") prose(i18n.t`✕ Merge conflicts`, "hot");
        else if (s.mergeable === "MERGEABLE") prose(i18n.t`✓ No merge conflicts`, "muted");
        else
          prose(
            s.draft
              ? i18n.t`Conflict status not available for this draft`
              : i18n.t`GitHub has not calculated mergeability · r refresh`,
            "muted",
          );
        if (s.decision === "APPROVED") prose(i18n.t`✓ Approved`, "accent");
        else if (s.decision === "CHANGES_REQUESTED") prose(i18n.t`● Changes requested`, "warm");
        else if (s.decision === "REVIEW_REQUIRED") prose(i18n.t`○ Approval pending`, "warm");
        if (s.mergeState === "BLOCKED") prose(i18n.t`GitHub reports merge blocked`, "warm");
        else if (s.mergeState === "BEHIND") prose(i18n.t`Branch must be updated before merging`, "warm");
        else if (s.mergeState === "UNSTABLE") prose(i18n.t`Some checks have not passed`, "warm");
      }
      if (s.autoMerge) prose(i18n.t`Auto-merge enabled`, "accent");
      const unresolved = s.unresolved ?? s.threads.filter(t => !t.resolved).length;
      if (unresolved) button(i18n.t`${unresolved} unresolved comments →`, action("tab", "discussion"), "warm");
      if (s.state === "OPEN") {
        if (!s.draft) {
          if (actionable) button("[ " + i18n.t`Merge` + " · m ]", action("merge"));
          else prose("[ " + i18n.t`Merge` + " ]", "muted");
        }
        if (s.mergeable === "CONFLICTING") {
          if (this.conflictSession) prose(i18n.t`Conflict agent launched`, "accent");
          else if (this.conflictStarting) prose(i18n.t`Starting conflict agent…`, "muted");
          else if (actionable) button("[ " + i18n.t`Resolve conflicts with Codex` + " ]", action("conflicts"), "warm");
        }
        if (s.autoMerge && actionable) button("[ " + i18n.t`Disable auto-merge` + " ]", action("auto"), "muted");
      }
      if (this.statusError) prose(this.statusError, "hot");
      if (this.statusRefreshing) prose(i18n.t`Refreshing readiness and checks…`, "muted");
      else button("[ " + i18n.t`Refresh readiness / checks` + " · s ]", action("status"), "muted");
      for (const check of s.checks.filter(check => /^pullapprove/i.test(check.title) && check.summary))
        prose("PullApprove · " + check.summary, check.state === "passed" ? "accent" : "warm");
      section(i18n.t`Checks`);
      const counts = ["pending", "failed", "passed"].map(
        state => s.checks.filter(check => check.state === state).length,
      );
      const [pending, failed, passed] = counts;
      button(
        i18n.t`Checks: ${passed} passed · ${failed} failed · ${pending} pending →`,
        action("checks"),
        failed ? "hot" : pending ? "warm" : "accent",
      );
      if (this.checksOpen) {
        for (const check of s.checks.filter(check => check.state !== "passed")) {
          const label = (check.state === "failed" ? "✕ " : "◌ ") + clean(check.title);
          if (check.state === "failed" && check.id && !this.busy)
            button(label + " · " + i18n.t`Retry`, action("retry", check.id), "hot");
          else prose(label, check.state === "failed" ? "hot" : "warm");
        }
        if (!failed && !pending) prose(i18n.t`✓ All checks passed`, "accent");
        if (failed) {
          button(i18n.t`Retry all failed checks · R`, action("retry", ""), "accent");
          if (s.checks.some(check => check.state === "failed" && !check.id))
            prose(i18n.t`External status checks cannot be retried through GitHub`, "muted");
        }
      }
      section(i18n.t`Reviewers`);
      if (!s.reviewers.length && !s.reviews.length) prose(i18n.t`none`, "muted");
      for (const reviewer of s.reviewers) prose("○ @" + reviewer, "warm");
      for (const review of s.reviews)
        prose("@" + review.author + " · " + human(review.state), review.state === "APPROVED" ? "accent" : "muted");
      if (s.labels.length) {
        section(i18n.t`Labels`);
        prose(s.labels.map(label => "[ " + label + " ]").join("  "), "muted");
      }
      section(i18n.t`Description`);
      markdown(s.body || i18n.t`No description`);
    } else if (this.tab === "discussion") {
      section(i18n.t`Comments and reviews`);
      const unresolved = s.threads.filter(thread => !thread.resolved).length,
        resolved = s.threads.length - unresolved;
      prose(i18n.t`${unresolved} unresolved · ${resolved} resolved threads`, unresolved ? "warm" : "muted");
      button(this.unresolvedOnly ? i18n.t`Unresolved only · u` : i18n.t`All discussion · u`, action("filter"));
      button(i18n.t`New comment · c`, action("comment"));
      endCard();
      const entries = [
        ...(this.unresolvedOnly ? [] : s.comments).map(comment => ({ at: comment.at, comment, thread: null })),
        ...s.threads
          .filter(thread => !this.unresolvedOnly || !thread.resolved)
          .map(thread => ({
            at:
              thread.comments
                .map(c => c.at)
                .sort()
                .at(-1) || "",
            comment: null,
            thread,
          })),
      ].sort((a, b) => b.at.localeCompare(a.at));
      if (!entries.length) prose(i18n.t`No comments`, "muted");
      for (const entry of entries) {
        const thread = entry.thread;
        section(thread ? pr.location(thread) : "@" + entry.comment!.author);
        if (thread) {
          const open = thread.resolved ? this.openThreads.has(thread.id) : !this.foldedThreads.has(thread.id);
          const status = thread.resolved ? i18n.t`✓ Resolved` : i18n.t`● Unresolved`;
          const count = thread.comments.length,
            updated = entry.at;
          button(
            (open ? "▾ " : "▸ ") + status + " · " + clean(thread.path),
            action("thread", thread.id),
            thread.resolved ? "muted" : "warm",
          );
          prose(pr.location(thread), "muted");
          prose(i18n.t`${count} comments · ${updated}`, "faint");
          if (!open) {
            endCard();
            continue;
          }
        }
        if (thread) {
          const snippet = pr.commentSnippet(thread);
          if (snippet.length) prose(i18n.t`Code · old / new line`, "faint");
          for (const line of snippet)
            prose(line, /^\s*\d*\s+\d*\s+\+/.test(line) ? "accent" : /^\s*\d*\s+\d*\s+-/.test(line) ? "hot" : "muted");
          if (snippet.length) space();
        }
        for (const comment of entry.comment
          ? [entry.comment]
          : [...thread!.comments].sort((a, b) => b.at.localeCompare(a.at))) {
          if (thread) prose("@" + comment.author, "strong", true);
          prose(comment.at + (comment.path && !thread ? " · " + comment.path : ""), "muted");
          space();
          markdown(comment.body);
          button(
            i18n.t`Send to agent`,
            action("comment-send", JSON.stringify([s.ref.url, thread?.id ?? null, comment])),
          );
          space();
        }
        if (thread) button(i18n.t`Reply to thread`, action("comment-reply", thread.id));
        endCard();
      }
    } else {
      section(i18n.t`Stack · base → dependent PRs`);
      prose(i18n.t`Base PRs first. Indented PRs depend on their parent.`, "muted");
      space();
      const current: pr.StackEntry = {
        ...s.ref,
        title: s.title,
        headBranch: s.headBranch,
        baseBranch: s.baseBranch,
        state: s.state,
        draft: s.draft,
      };
      const nodes = [current, ...s.stack],
        seen = new Set<string>();
      const visit = (node: pr.StackEntry, prefix: string, branch: string, childrenPrefix: string) => {
        if (seen.has(node.url)) return;
        seen.add(node.url);
        const here = node.url === s.ref.url,
          status = here
            ? i18n.t`This PR`
            : node.draft
              ? i18n.t`Draft`
              : node.state === "MERGED"
                ? i18n.t`Merged`
                : node.state === "CLOSED"
                  ? i18n.t`Closed`
                  : i18n.t`Open`;
        button(prefix + branch + "#" + node.number + " · " + status, action("", node.url), here ? "accent" : "muted");
        const indent = prefix + childrenPrefix;
        for (const line of new tui.Text(clean(node.title), 0, 0).render(
          Math.max(4, contentWidth() - tui.visibleWidth(indent) - 3),
        ))
          button(indent + "  " + line, action("", node.url), "strong");
        prose(indent + "  " + node.headBranch + " → " + node.baseBranch, "faint");
        space();
        const children = nodes
          .filter(p => p.baseBranch === node.headBranch && p.url !== node.url)
          .sort((a, b) => a.number - b.number);
        for (let i = 0; i < children.length; i++)
          visit(
            children[i],
            indent,
            i === children.length - 1 ? "└─ " : "├─ ",
            i === children.length - 1 ? "   " : "│  ",
          );
      };
      const roots = nodes
        .filter(p => !nodes.some(parent => parent.url !== p.url && parent.headBranch === p.baseBranch))
        .sort((a, b) => a.number - b.number);
      for (const root of roots) visit(root, "", "", " ");
      for (const node of nodes) if (!seen.has(node.url)) visit(node, "", "", " ");
      if (!s.stack.length) prose(i18n.t`No related PRs found for these branches`, "muted");
    }
    endCard();
    return rows;
  }
  key(key: Key): Action | null {
    const k = "text" in key ? key.text : key.named;
    if (this.compose) {
      if (k === "escape") return this.busy ? null : action("comment-cancel");
      if (k === "tab" || k === "shift_tab") {
        const choices = [
          -1,
          ...this.targets.flatMap((t, i) =>
            ["pull-request-comment-post", "pull-request-comment-cancel"].includes(t.command.name) ? [i] : [],
          ),
        ];
        this.selected =
          choices[(choices.indexOf(this.selected) + (k === "tab" ? 1 : -1) + choices.length) % choices.length];
        return null;
      }
      if (k === "enter" && this.targets[this.selected]?.command.name.startsWith("pull-request-comment-"))
        return this.targets[this.selected].command;
      if (this.busy) return null;
      this.selected = -1;
      if ("text" in key) this.compose.area.insert(key.text);
      else {
        const edit =
          { home: "line_start", end: "line_end", ctrl_u: "line_backspace", ctrl_d: "delete", enter: "newline" }[k] ?? k;
        if (textArea.isEdit(edit)) this.compose.area.apply(edit);
      }
      this.followCaret = true;
      return null;
    }
    const shortcuts: Record<string, Action> = {
      c: action("comment"),
      q: action("close"),
      escape: action(this.confirmation ? "cancel" : "leave"),
      d: action("diff"),
      r: action("refresh"),
      R: action("retry", ""),
      o: action("browser"),
      v: action("ready"),
      u: action("filter"),
      a: action("auto"),
      s: action("status"),
      m: action("merge"),
      f: { name: "zoom" },
      "1": action("tab", "overview"),
      "2": action("tab", "discussion"),
      "3": action("tab", "stack"),
    };
    if (shortcuts[k]) return shortcuts[k];
    if (k === "enter") return this.targets[this.selected]?.command ?? null;
    if (k === "tab" || k === "shift_tab") {
      this.selected = (this.selected + (k === "tab" ? 1 : -1) + this.targets.length) % Math.max(1, this.targets.length);
    } else {
      if (k === "j" || k === "down") this.top++;
      if (k === "k" || k === "up") this.top--;
      if (k === " " || k === "page_down" || k === "ctrl_d") this.top += this.bodyHeight;
      if (k === "page_up" || k === "ctrl_u") this.top -= this.bodyHeight;
      if (k === "home") this.top = 0;
      if (k === "end") this.top = this.visible.length;
      this.clamp();
    }
    return null;
  }
  private clamp(): void {
    this.top = Math.max(0, Math.min(this.top, this.visible.length - this.bodyHeight));
  }
  private id(command: Action): string {
    return command.name + ":" + (command.value ?? "");
  }
  mouse(button: number, x: number, y: number, release = false): Action | null {
    const target = this.targets.find(target => target.rect.contains(x, y));
    this.hovered = target ? this.id(target.command) : null;
    this.clicked = null;
    if (!release && (button === 0 || button === 32)) this.pressed = null;
    target?.component.handleMouse({
      type: release ? "release" : button === 0 ? "press" : "move",
      button: button === 0 || release ? "left" : "none",
      x: x - target.rect.x,
      y: y - target.rect.y,
      screenX: x,
      screenY: y,
      width: target.rect.w,
      height: 1,
      shift: false,
      alt: false,
      ctrl: false,
    });
    if (release) this.pressed = null;
    if ((button === 64 || button === 65) && this.rect.contains(x, y)) {
      this.top += button === 64 ? -3 : 3;
      this.clamp();
    }
    return this.clicked;
  }
  draw(w: Writer, x: number, y: number, width: number, height: number, focused: boolean): void {
    if (width < 12 || height < 13) {
      this.targets = [];
      w.write(`\x1b[${y + 1};${x + 1}H` + ink(tui.truncateToWidth(i18n.t`Enlarge panel to view PR`, width), "muted"));
      return;
    }
    this.rect = new Rect(x, y, width, height);
    this.targets = [];
    const inner = width - 2,
      lines = Array.from({ length: height }, () => "");
    const fit = (value: string, size: number) => tui.truncateToWidth(value, Math.max(0, size));
    const pad = (value: string, size: number) =>
      fit(value, size) + " ".repeat(Math.max(0, size - tui.visibleWidth(fit(value, size))));
    const control = (
      label: string,
      command: Action,
      at: number,
      row: number,
      size: number,
      active = false,
      color: palette.Token = "strong",
    ) => {
      const index = this.targets.length,
        id = this.id(command);
      const component = new tui.MouseRegion(new tui.TruncatedText(pad(label, size), 0, 0), event => {
        if (event.type === "press") this.pressed = id;
        if (event.type === "release" && this.pressed === id) this.clicked = command;
        return { handled: true, render: true };
      });
      this.targets.push({ rect: new Rect(x + 1 + at, y + row, size, 1), command, component });
      const bg = active || (focused && this.selected === index) ? "selected" : this.hovered === id ? "line" : "surface";
      return new palette.Style({ fg: color, bg, bold: active }).sgr() + component.render(size)[0] + "\x1b[0m";
    };
    const border = focused ? "accent" : "line";
    lines[0] = ink("╭" + "─".repeat(inner) + "╮", border);
    const repo = this.ref ? this.ref.repo + " #" + this.ref.number : i18n.t`GitHub PR`;
    lines[1] =
      control(" " + repo, action("browser"), 0, 1, inner - 8, false, "muted") +
      control(" ⤢ ", { name: "zoom" }, inner - 8, 1, 4) +
      control(" × ", action("close"), inner - 4, 1, 4);
    const s = this.snapshot;
    lines[2] = ink(pad(" " + clean(s?.title || i18n.t`Loading from GitHub…`), inner), "strong", true);
    const status = s
      ? s.draft
        ? i18n.t`Draft`
        : s.state === "OPEN"
          ? i18n.t`Open`
          : s.state === "MERGED"
            ? i18n.t`Merged`
            : i18n.t`Closed`
      : "…";
    lines[3] =
      ink(" ● " + status, s?.draft ? "warm" : s?.state === "CLOSED" ? "hot" : "accent") +
      ink(
        fit(
          s ? "  " + clean(s.headBranch) + " → " + clean(s.baseBranch) : "",
          inner - tui.visibleWidth(" ● " + status),
        ),
        "muted",
      );
    const unresolved = s?.unresolved ?? s?.threads.filter(thread => !thread.resolved).length ?? 0;
    const tabs: [Tab, string][] = [
      ["overview", i18n.t`Overview`],
      ["discussion", i18n.t`Discussion` + (unresolved ? ` (${unresolved})` : "")],
    ];
    if (s?.stack.length) {
      const stack = pr.orderedStack(s),
        position = stack.findIndex(p => p.url === s.ref.url) + 1,
        total = stack.length;
      tabs.push(["stack", i18n.t`Stack (${position}/${total})`]);
    }
    const tabWidths = tabs.map(([, label]) => tui.visibleWidth(label) + 2),
      spare = inner - tabWidths.reduce((total, width) => total + width, 0);
    let offset = 0;
    lines[4] = tabs
      .map(([tab, label], index) => {
        const size =
          index === tabs.length - 1
            ? inner - offset
            : spare >= 0
              ? tabWidths[index] + Math.floor(spare / tabs.length)
              : Math.floor(inner / tabs.length);
        const result = control(" " + label, action("tab", tab), offset, 4, size, this.tab === tab);
        offset += size;
        return result;
      })
      .join("");
    lines[5] = ink("─".repeat(inner), "line");
    this.bodyHeight = Math.max(1, height - 10);
    const modalWidth = this.confirmation ? Math.max(8, Math.min(inner - 4, 64)) : inner;
    this.visible = this.rows(modalWidth);
    if (this.compose && this.followCaret) {
      this.top = Math.max(Math.min(this.top, this.composeRow), this.composeRow - this.bodyHeight + 1);
      this.followCaret = false;
    }
    this.clamp();
    const modalInset = Math.floor((inner - modalWidth) / 2),
      modalTop = this.confirmation ? Math.max(0, Math.floor((this.bodyHeight - this.visible.length) / 2)) : 0;
    for (let row = 0; row < this.bodyHeight; row++) {
      const item = row < modalTop ? undefined : this.visible[this.top + row - modalTop];
      if (item?.action) {
        const inset = item.framed ? 1 : 0,
          prefix = item.prefix ?? "",
          prefixWidth = tui.visibleWidth(prefix);
        const button = control(
          tui.stripTerminalSequences(item.text),
          item.action,
          inset + modalInset + prefixWidth,
          6 + row,
          modalWidth - 2 * inset - prefixWidth,
          false,
          item.color,
        );
        lines[6 + row] = item.framed ? ink("│", "line") + prefix + button + ink("│", "line") : prefix + button;
      } else lines[6 + row] = item?.text ?? "";
      if (modalInset) lines[6 + row] = " ".repeat(modalInset) + lines[6 + row];
    }
    const footer = height - 4;
    lines[footer] = ink("─".repeat(inner), "line");
    if (this.compose) {
      lines[footer + 1] =
        control(" " + i18n.t`Post to GitHub`, action("comment-post"), 0, footer + 1, Math.floor(inner / 2)) +
        control(
          " " + i18n.t`Cancel` + " · Esc",
          action("comment-cancel"),
          Math.floor(inner / 2),
          footer + 1,
          inner - Math.floor(inner / 2),
        );
    } else if (this.confirmation) {
      lines[footer + 1] = control(" " + i18n.t`Cancel` + " · Esc", action("cancel"), 0, footer + 1, inner);
    } else {
      const third = Math.floor(inner / 3);
      lines[footer + 1] =
        control(" " + i18n.t`Open` + " · o", action("browser"), 0, footer + 1, third) +
        control(" " + i18n.t`Diff` + " · d", action("diff"), third, footer + 1, third) +
        control(" " + i18n.t`Refresh` + " · r", action("refresh"), 2 * third, footer + 1, inner - 2 * third);
    }
    const updated = s
      ? new Date(s.statusFetched ?? s.fetched).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    const restriction =
      s?.state === "MERGED" ? i18n.t`Already merged` : s?.state === "CLOSED" ? i18n.t`PR is closed` : "";
    const info = this.error
      ? clean(this.error)
      : this.busy
        ? i18n.t`Updating GitHub…`
        : this.refreshing
          ? i18n.t`Refreshing cached view…`
          : restriction || i18n.t`Updated: ${updated}`;
    lines[height - 2] = ink(
      pad(" " + info + (this.top + this.bodyHeight < this.visible.length ? "  ↓" : ""), inner),
      this.error ? "hot" : "muted",
    );
    lines[height - 1] = ink("╰" + "─".repeat(inner) + "╯", border);
    for (let row = 0; row < height; row++) {
      const content =
        row === 0 || row === height - 1 ? lines[row] : ink("│", border) + pad(lines[row], inner) + ink("│", border);
      w.write(
        `\x1b[${y + row + 1};${x + 1}H\x1b[0m${palette.bg("surface")}${content.replaceAll("\x1b[0m", "\x1b[0m" + palette.bg("surface"))}\x1b[0m`,
      );
    }
  }
}
function human(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, letter => letter.toUpperCase());
}
