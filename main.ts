import { addIcon, Notice, Plugin, TFile } from 'obsidian';
import { ISettings } from 'src/conf/settings';
import { SettingsTab } from 'src/gui/settings-tab';
import { CardsService } from 'src/services/cards';
import { Anki } from 'src/services/anki';
import { noticeTimeout, flashcardsIcon } from 'src/conf/constants';

export default class ObsidianFlashcard extends Plugin {
	private settings: ISettings
	private cardsService: CardsService

	async onload() {
		addIcon("flashcards", flashcardsIcon)

		// TODO test when file did not insert flashcards, but one of them is in Anki already
		const anki = new Anki()
		this.settings = await this.loadData() || this.getDefaultSettings()
		this.cardsService = new CardsService(this.app, this.settings)

		const statusBar = this.addStatusBarItem()

		this.addCommand({
			id: 'generate-flashcard-current-file',
			name: 'Generate for the current file',
			checkCallback: (checking: boolean) => {
				const activeFile = this.app.workspace.getActiveFile()
				if (activeFile) {
					if (!checking) {
						this.generateCards(activeFile)
					}
					return true;
				}
				return false;
			}
		});

		this.addRibbonIcon('flashcards', 'Generate flashcards', () => {
			const activeFile = this.app.workspace.getActiveFile()
			if (activeFile) {
				this.generateCards(activeFile)
			} else {
				new Notice("Open a file before")
			}
		});

		this.addSettingTab(new SettingsTab(this.app, this));

		this.registerInterval(window.setInterval(() =>
			anki.ping().then(() => statusBar.setText('Anki ⚡️')).catch(() => statusBar.setText('')), 15 * 1000
		));
	}

	async onunload() {
		await this.saveData(this.settings);
	}

	private getDefaultSettings(): ISettings {
		return {
            contextAwareMode: true,
            sourceSupport: false,
            codeHighlightSupport: false,
            inlineID: false,
            contextSeparator: " > ",
            deck: "Default",
            folderBasedDeck: true,
            flashcardsTag: "card",
            inlineSeparator: "::",
            inlineSeparatorReverse: ":::",
            defaultAnkiTag: "obsidian",
            ankiConnectPermission: false,
            anki_dir: "c:/Users/M/AppData/Roaming/Anki2/User 1/collection.media",
            obsidian_dir: "D:/pkm/pkm-english" }
	}

	private generateCards(activeFile: TFile) {
	    try {
            this.cardsService.execute(activeFile)
                .then(res => {
                    for (const r of res) {
                        new Notice(r, noticeTimeout)
                    }
                    console.log(res)
                    new Notice("generateCards DONE", 3000)
                })
                .catch(err => {
                    new Notice("generateCards error", 3000)
                    Error(err)
                })
		}
		catch(error) {
		    new Notice("generateCards error: " + error, 3000)
		}
	}
}