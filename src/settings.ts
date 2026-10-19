import { App, Modal, PluginSettingTab, requireApiVersion, SecretComponent, Setting, type SettingDefinition } from "obsidian";
import { API_KEYS_URL } from "./api";
import { SEMBLE_ICON } from "./icon";
import type SemblePlugin from "./main";

export interface SembleSettings {
	/**
	 * Name of the secret in Obsidian's secret storage that holds the API key.
	 * The key itself is never written to data.json.
	 */
	apiKeySecret: string;
	/**
	 * Whether the links pane has been added to the right sidebar on first run.
	 * Internal state, not shown in the settings tab: it stops the pane from
	 * coming back on every startup after the user closes it.
	 */
	paneAdded: boolean;
}

/** Secret ID used when the key is entered through the "Set API key" dialog. */
export const DEFAULT_API_KEY_SECRET = "semble-api-key";

export const DEFAULT_SETTINGS: SembleSettings = {
	apiKeySecret: DEFAULT_API_KEY_SECRET,
	paneAdded: false,
};

type SettingKey = keyof SembleSettings;

export class SembleSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: SemblePlugin,
	) {
		super(app, plugin);
		// Obsidian hides icons for community plugins in the settings sidebar, but
		// shows this one next to "Semble" in settings search results.
		this.icon = SEMBLE_ICON;
	}

	/**
	 * Declarative settings (Obsidian 1.13+): rendered by Obsidian and indexed by
	 * settings search. Also the single source for the legacy `display()` below.
	 */
	getSettingDefinitions(): SettingDefinition<SettingKey>[] {
		// Until a key is stored, only offer to set one; the rest only make sense afterwards.
		const hasKey = () => this.plugin.getApiKey() !== null;
		return [
			{
				name: "Set API key",
				desc: createFragment((frag) => {
					frag.appendText("Create a key on your ");
					frag.createEl("a", { text: "Semble API keys page", href: API_KEYS_URL });
					frag.appendText(", then paste it here.");
				}),
				action: () => new ApiKeyModal(this.app, (key) => void this.saveApiKey(key)).open(),
				visible: () => !hasKey(),
			},
			{
				name: "API key secret",
				desc: "The secret that holds the API key. Pick a different one to reuse a key you've already saved.",
				control: { type: "secret", key: "apiKeySecret" },
				visible: hasKey,
			},
			{
				name: "Check connection",
				desc: "Confirm that Semble accepts the API key.",
				action: () => void this.plugin.checkConnection(),
				visible: hasKey,
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as SettingKey];
	}

	// Route writes through the plugin so open panes pick up the change.
	async setControlValue(key: string, value: unknown): Promise<void> {
		this.plugin.settings = { ...this.plugin.settings, [key]: value };
		await this.plugin.saveSettings();
		this.refresh();
	}

	/** Store the key under the default secret ID and link it, so the user never has to name it. */
	private async saveApiKey(key: string): Promise<void> {
		this.app.secretStorage.setSecret(DEFAULT_API_KEY_SECRET, key);
		await this.setControlValue("apiKeySecret", DEFAULT_API_KEY_SECRET);
		await this.plugin.checkConnection();
	}

	/**
	 * Re-render so rows shown or hidden by whether a key is stored, and the
	 * secret picker's linked ID, follow the change.
	 */
	private refresh(): void {
		if (requireApiVersion("1.13.2")) this.update();
		else this.renderLegacy();
	}

	/**
	 * Imperative fallback for Obsidian 1.11.4–1.13.1, which don't render
	 * getSettingDefinitions() (or its `secret` control). Newer versions never call this.
	 */
	display(): void {
		this.renderLegacy();
	}

	private renderLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();

		for (const def of this.getSettingDefinitions()) {
			if (typeof def.visible === "function" ? !def.visible() : def.visible === false) continue;
			const setting = new Setting(containerEl).setName(def.name);
			if (def.desc) setting.setDesc(def.desc);

			if ("action" in def && def.action) {
				const action = def.action;
				setting.addButton((button) => button.setButtonText(def.name).onClick(() => action(button.buttonEl, 0)));
			} else if ("control" in def && def.control?.type === "secret") {
				const { key } = def.control;
				setting.addComponent((el) =>
					new SecretComponent(this.app, el)
						.setValue(this.plugin.settings.apiKeySecret)
						.onChange((value) => this.setControlValue(key, value ?? "")),
				);
			}
		}
	}
}

/** Prompts for the API key alone; the secret ID is fixed to DEFAULT_API_KEY_SECRET. */
class ApiKeyModal extends Modal {
	constructor(
		app: App,
		private readonly onSave: (key: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Set API key");
		let value = "";
		const save = () => {
			const key = value.trim();
			if (!key) return;
			this.close();
			this.onSave(key);
		};

		new Setting(this.contentEl)
			.setName("API key")
			.setDesc("Saved in Obsidian's keychain, not in your vault.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.addEventListener("keydown", (evt) => {
					if (evt.key === "Enter") {
						evt.preventDefault();
						save();
					}
				});
				text.onChange((v) => (value = v));
				window.setTimeout(() => text.inputEl.focus());
			});
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) => button.setButtonText("Save").setCta().onClick(save));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
