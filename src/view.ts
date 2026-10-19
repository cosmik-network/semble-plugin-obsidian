import {
	debounce,
	ItemView,
	Keymap,
	MarkdownView,
	Menu,
	Notice,
	SearchComponent,
	TFile,
	type WorkspaceLeaf,
} from "obsidian";
import { LinkDetail, type ViewId } from "./detail/LinkDetail";
import { extractLinks, type WebLink } from "./links";
import type SemblePlugin from "./main";
import type { UrlInfo } from "./api";
import { openLink, renderRow, setSavesFlair } from "./ui";
import { SEMBLE_ICON } from "./icon";
import { hostOf } from "./urls";

export const VIEW_TYPE_LINKS = "semble-links";

/**
 * Sidebar pane listing every web link in the active note, modelled on the
 * core Outline view. Clicking a link opens a detail sub-view backed by Semble.
 *
 * The pane follows the most recently opened file (not the focused leaf), so
 * clicking into the pane keeps showing the note you came from.
 */
export class LinksView extends ItemView {
	private file: TFile | null = null;
	private links: WebLink[] = [];
	/** Rendered rows by URL, so Semble stats can be added to them as they arrive. */
	private readonly rowEls = new Map<string, HTMLElement[]>();
	/** Incremented per stats load so results for an old list are dropped. */
	private statsRun = 0;
	/** Check every row's counts with Semble on the next draw (not just missing ones). */
	private revalidateStats = false;
	private filter = "";
	/** Incremented per refresh so a slow read can't overwrite a newer result. */
	private refreshId = 0;

	private listViewEl!: HTMLElement;
	private listEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private detail: LinkDetail | null = null;
	/** Reopen link views on the tab (or stat list) the user last chose. */
	private detailView: ViewId = "library";

	private readonly requestRefresh = debounce(() => void this.refresh(), 250, true);
	/**
	 * Looking up stats for links Semble hasn't been asked about waits until the
	 * note settles, so typing a URL doesn't query every partial URL on the way.
	 */
	private readonly fetchStatsLater = debounce(() => void this.fetchStats(true), 1000, true);

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: SemblePlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_LINKS;
	}

	getDisplayText(): string {
		return "Web links";
	}

	getIcon(): string {
		return SEMBLE_ICON;
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("semble-links-view");

		// The list stays in the DOM (just hidden) while a link is open, so its
		// filter and scroll position survive going back.
		this.listViewEl = this.contentEl.createDiv({ cls: "semble-links-list-view" });
		const searchEl = this.listViewEl.createDiv({ cls: "semble-links-search" });
		new SearchComponent(searchEl).setPlaceholder("Filter links...").onChange((value) => {
			this.filter = value.trim().toLowerCase();
			this.render();
		});
		this.listEl = this.listViewEl.createDiv({ cls: "semble-links-list" });
		this.detailEl = this.contentEl.createDiv({ cls: "semble-detail-container" });
		this.detailEl.hide();

		const { workspace, metadataCache, vault } = this.app;
		this.registerEvent(workspace.on("file-open", (file) => this.setFile(file)));
		// A background check found different counts: show them.
		this.register(this.plugin.api.onChange(() => this.showStats()));
		this.registerEvent(
			metadataCache.on("changed", (file) => {
				if (file === this.file) this.requestRefresh();
			}),
		);
		this.registerEvent(
			vault.on("delete", (file) => {
				if (file === this.file) this.setFile(null);
			}),
		);

		this.setFile(workspace.getActiveFile());
	}

	async onClose(): Promise<void> {
		this.requestRefresh.cancel();
		this.fetchStatsLater.cancel();
	}

	onSettingsChanged(): void {
		this.render();
		// Rebuild an open detail view, e.g. so a newly added API key takes effect.
		if (this.detail) this.openDetail(this.detail.link);
	}

	private setFile(file: TFile | null): void {
		if (file === this.file) return;
		this.file = file;
		this.links = [];
		this.revalidateStats = true;
		this.closeDetail();
		void this.refresh();
	}

	/** Re-read the current note and rebuild the link list. */
	private async refresh(): Promise<void> {
		const id = ++this.refreshId;
		const file = this.file;
		if (!file || file.extension !== "md") {
			this.links = [];
			this.render();
			return;
		}

		const content = await this.app.vault.cachedRead(file);
		if (id !== this.refreshId) return;
		this.links = extractLinks(content);
		this.render();
	}

	// --- Detail sub-view ---

	private openDetail(link: WebLink): void {
		this.closeDetail();
		this.listViewEl.hide();
		this.detailEl.show();
		this.detail = this.addChild(
			new LinkDetail(this.detailEl, this.plugin, link, {
				back: () => this.closeDetail(),
				revealInNote: (target) => void this.revealInNote(target),
				noteLinks: () => this.links,
				initialView: this.detailView,
				onViewChange: (view) => (this.detailView = view),
			}),
		);
	}

	private closeDetail(): void {
		if (!this.detail) return;
		this.removeChild(this.detail);
		this.detail = null;
		this.detailEl.hide();
		this.listViewEl.show();
		// Re-check the counts: the link view may have changed them.
		this.revalidateStats = true;
		this.showStats();
	}

	// --- List ---

	/** Redraw from the last extracted links using the current filter. */
	render(): void {
		if (!this.listEl) return;
		this.listEl.empty();
		this.rowEls.clear();

		if (!this.file) return this.renderEmpty("No file is open.");
		if (this.file.extension !== "md") return this.renderEmpty("Links are only listed for Markdown notes.");

		const links = this.filter ? this.links.filter((link) => matchesFilter(link, this.filter)) : this.links;
		if (links.length === 0) {
			return this.renderEmpty(this.filter ? "No links match the filter." : "No web links in this note.");
		}
		for (const link of links) this.renderItem(link);
		this.showStats();
	}

	/**
	 * Show each link's Semble save count in its row's flair. It's the same
	 * cached request as the link view's header, so opening a link afterwards is
	 * instant. Cached counts are applied right away, so redraws never flicker;
	 * the rest are fetched once the note settles, with no loading state.
	 */
	private showStats(): void {
		const { api } = this.plugin;
		if (!api.hasApiKey) return;
		let missing = false;
		for (const [url, els] of this.rowEls) {
			const info = api.peekUrlInfo(url);
			if (info) for (const el of els) applyStats(el, info);
			else missing = true;
		}
		// Opening a note (or coming back from a link) checks every count with
		// Semble; redraws while typing only fetch counts that are missing.
		if (this.revalidateStats && this.rowEls.size > 0) {
			this.revalidateStats = false;
			void this.fetchStats(false);
		} else if (missing) {
			this.fetchStatsLater();
		}
	}

	/**
	 * Fetch counts a few at a time to go easy on the API. Cached ones return
	 * immediately and are re-checked in the background if they're not recent.
	 */
	private async fetchStats(onlyMissing: boolean): Promise<void> {
		const { api } = this.plugin;
		if (!api.hasApiKey) return;
		const run = ++this.statsRun;
		const queue = [...this.rowEls.keys()].filter((url) => !onlyMissing || !api.peekUrlInfo(url));

		const worker = async () => {
			for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
				let info: UrlInfo;
				try {
					info = await api.getUrlInfo(url);
				} catch {
					continue; // Stats are extra; the row works without them.
				}
				if (run !== this.statsRun) return;
				for (const el of this.rowEls.get(url) ?? []) applyStats(el, info);
			}
		};
		await Promise.all([worker(), worker(), worker()]);
	}

	private renderEmpty(message: string): void {
		this.listEl.createDiv({ cls: "pane-empty", text: message });
	}

	private renderItem(link: WebLink): void {
		const host = hostOf(link.url);
		const itemEl = renderRow(this.listEl, {
			title: link.displayText,
			detail: host && host !== link.displayText ? host : undefined,
			tooltip: link.url,
			onClick: (evt) => {
				if (Keymap.isModEvent(evt)) openLink(link.url);
				else this.openDetail(link);
			},
			onContextMenu: (evt) => this.showMenu(link, evt),
		});
		const rows = this.rowEls.get(link.url) ?? [];
		rows.push(itemEl);
		this.rowEls.set(link.url, rows);
	}

	private showMenu(link: WebLink, evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Show in Semble").setIcon("info").onClick(() => this.openDetail(link)));
		menu.addItem((item) => item.setTitle("Open on Semble").setIcon("external-link").onClick(() => openLink(link.url)));
		menu.addItem((item) =>
			item.setTitle("Jump to link in note").setIcon("text-cursor").onClick(() => this.revealInNote(link)),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Copy URL")
				.setIcon("copy")
				.onClick(async () => {
					await navigator.clipboard.writeText(link.url);
					new Notice("Copied to clipboard");
				}),
		);
		menu.showAtMouseEvent(evt);
	}

	/** Focus the note and select the link's source text, like clicking a heading in Outline. */
	private async revealInNote(link: WebLink): Promise<void> {
		const file = this.file;
		if (!file) return;
		const { position } = link;

		const { workspace } = this.app;
		let leaf = workspace
			.getLeavesOfType("markdown")
			.find((candidate) => candidate.view instanceof MarkdownView && candidate.view.file === file);
		if (!leaf) {
			leaf = workspace.getLeaf(false);
			await leaf.openFile(file);
		}
		workspace.setActiveLeaf(leaf, { focus: true });

		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		if (view.getMode() === "source") {
			const from = { line: position.start.line, ch: position.start.col };
			const to = { line: position.end.line, ch: position.end.col };
			view.editor.setSelection(from, to);
			view.editor.scrollIntoView({ from, to }, true);
		} else {
			view.setEphemeralState({ line: position.start.line });
		}
	}
}

function matchesFilter(link: WebLink, filter: string): boolean {
	return link.displayText.toLowerCase().includes(filter) || link.url.toLowerCase().includes(filter);
}

/** Show a link's Semble save count in its row. */
function applyStats(itemEl: HTMLElement, info: UrlInfo): void {
	setSavesFlair(itemEl, info.stats?.libraryCount ?? 0, Boolean(info.urlInLibrary));
}
