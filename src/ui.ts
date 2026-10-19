import { App, Modal, Setting, setIcon } from "obsidian";
import { sembleUrlPage } from "./urls";

/** Obsidian routes window.open for http(s) URLs to the system browser (or Web viewer, if enabled). */
export function openUrl(url: string): void {
	window.open(url);
}

/** Open a web link's page on Semble, which is where the plugin sends every link. */
export function openLink(url: string): void {
	openUrl(sembleUrlPage(url));
}

export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : "Something went wrong.";
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

const TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 365 * 86400],
	["month", 30 * 86400],
	["week", 7 * 86400],
	["day", 86400],
	["hour", 3600],
	["minute", 60],
];

/** "3 days ago", "last month", etc. Returns "" for an unparseable date. */
export function timeAgo(date: string): string {
	const seconds = (Date.parse(date) - Date.now()) / 1000;
	if (Number.isNaN(seconds)) return "";
	const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	for (const [unit, size] of TIME_UNITS) {
		if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
	}
	return format.format(0, "minute");
}

/** Muted placeholder text, with an optional retry link for failed loads. */
export function renderMessage(parentEl: HTMLElement, text: string, retry?: () => void): HTMLElement {
	const el = parentEl.createDiv({ cls: "semble-message", text });
	if (retry) {
		el.appendText(" ");
		const link = el.createEl("a", { text: "Try again", href: "#" });
		link.addEventListener("click", (evt) => {
			evt.preventDefault();
			retry();
		});
	}
	return el;
}

export interface RowOptions {
	/** Lucide icon name. */
	icon?: string;
	/** Small round image (e.g. an avatar) shown instead of the icon; the icon is the fallback. */
	imageUrl?: string;
	title: string;
	/** Faint second line, e.g. a host name. */
	detail?: string;
	/** Right-aligned count or label, like the counts in Outline and Backlinks. */
	flair?: string;
	tooltip?: string;
	onClick?: (evt: MouseEvent) => void;
	onContextMenu?: (evt: MouseEvent) => void;
}

/**
 * A list row built from Obsidian's core `tree-item` classes, so every list in
 * the pane looks like Outline, Backlinks and Search. Returns the `.tree-item`.
 */
export function renderRow(parentEl: HTMLElement, options: RowOptions): HTMLElement {
	const itemEl = parentEl.createDiv({ cls: "tree-item semble-row" });
	const selfEl = itemEl.createDiv({ cls: "tree-item-self" });

	if (options.icon || options.imageUrl) {
		const iconEl = selfEl.createDiv({ cls: "semble-row-icon" });
		const fallback = () => options.icon && setIcon(iconEl, options.icon);
		if (options.imageUrl) {
			const img = iconEl.createEl("img", {
				attr: { src: options.imageUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer" },
			});
			img.addEventListener("error", () => {
				img.remove();
				fallback();
			});
		} else {
			fallback();
		}
	}

	const innerEl = selfEl.createDiv({ cls: "tree-item-inner" });
	innerEl.createDiv({ cls: "semble-row-title", text: options.title });
	if (options.detail) innerEl.createDiv({ cls: "semble-row-detail", text: options.detail });

	if (options.flair) {
		selfEl.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: options.flair });
	}
	if (options.tooltip) {
		selfEl.setAttr("aria-label", options.tooltip);
		selfEl.setAttr("data-tooltip-position", "left");
	}
	if (options.onClick) {
		const onClick = options.onClick;
		selfEl.addClass("is-clickable");
		selfEl.addEventListener("click", (evt) => onClick(evt));
	}
	if (options.onContextMenu) selfEl.addEventListener("contextmenu", options.onContextMenu);
	return itemEl;
}

/**
 * Set (or clear, with null) a row's right-aligned flair after it was rendered,
 * e.g. once data for it arrives. `icon` goes before the text.
 */
export function setRowFlair(
	itemEl: HTMLElement,
	text: string | null,
	options: { icon?: string; cls?: string; tooltip?: string } = {},
): void {
	const selfEl = itemEl.querySelector<HTMLElement>(":scope > .tree-item-self");
	if (!selfEl) return;
	selfEl.querySelector(":scope > .tree-item-flair-outer")?.remove();
	if (text === null) return;

	const flairEl = selfEl.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair" });
	if (options.cls) flairEl.addClass(options.cls);
	if (options.icon) setIcon(flairEl.createSpan({ cls: "semble-flair-icon" }), options.icon);
	flairEl.createSpan({ text });
	if (options.tooltip) flairEl.setAttr("aria-label", options.tooltip);
}

/**
 * A row's Semble save count, as in the link list: the number of saves, in the
 * accent colour with a checkmark when the link is in your library, or nothing
 * when no one has saved it.
 */
export function setSavesFlair(itemEl: HTMLElement, saves: number, inLibrary: boolean): void {
	if (inLibrary) {
		const count = Math.max(saves, 1);
		setRowFlair(itemEl, String(count), {
			icon: "check",
			cls: "mod-saved",
			tooltip: `In your library · ${plural(count, "save")} on Semble`,
		});
	} else if (saves > 0) {
		setRowFlair(itemEl, String(saves), { tooltip: `${plural(saves, "save")} on Semble` });
	} else {
		setRowFlair(itemEl, null);
	}
}

/**
 * A row of toggle buttons built from core `clickable-icon` buttons, the same
 * ones in Obsidian's pane toolbars, so hover and active states come from the
 * theme. Used for the link view's tabs and for filters.
 */
export interface ToggleGroup<T extends string> {
	el: HTMLElement;
	/** Highlight a button without calling onChange; null clears the highlight. */
	setActive(id: T | null): void;
}

export function renderToggleGroup<T extends string>(
	parentEl: HTMLElement,
	options: { id: T; label: string; icon?: string }[],
	active: T | null,
	onChange: (id: T) => void,
	cls = "",
): ToggleGroup<T> {
	const groupEl = parentEl.createDiv({ cls: `semble-toggle-group ${cls}`.trim(), attr: { role: "tablist" } });
	const buttons = new Map<T, HTMLElement>();
	const setActive = (activeId: T | null) => {
		for (const [id, el] of buttons) {
			el.toggleClass("is-active", id === activeId);
			el.setAttr("aria-selected", String(id === activeId));
		}
	};

	for (const { id, label, icon } of options) {
		const el = groupEl.createDiv({ cls: "clickable-icon semble-toggle", attr: { role: "tab", tabindex: "0" } });
		if (icon) setIcon(el.createSpan({ cls: "semble-toggle-icon" }), icon);
		el.createSpan({ text: label });
		const select = () => {
			if (el.hasClass("is-active")) return;
			setActive(id);
			onChange(id);
		};
		el.addEventListener("click", select);
		el.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				select();
			}
		});
		buttons.set(id, el);
	}
	setActive(active);
	return { el: groupEl, setActive };
}

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly options: {
			title: string;
			message: string;
			confirmText: string;
			onConfirm: () => void | Promise<void>;
		},
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		this.contentEl.createEl("p", { text: this.options.message });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) => {
				button.setButtonText(this.options.confirmText).onClick(() => {
					this.close();
					void this.options.onConfirm();
				});
				button.buttonEl.addClass("mod-warning");
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
