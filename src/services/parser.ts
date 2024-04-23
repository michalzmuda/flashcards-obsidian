import { ISettings } from "src/conf/settings";
import * as showdown from "showdown";
import { Regex } from "src/conf/regex";
import { Flashcard } from "../entities/flashcard";
import { Inlinecard } from "src/entities/inlinecard";
import { Spacedcard } from "src/entities/spacedcard";
import { Clozecard } from "src/entities/clozecard";
import { escapeMarkdown } from "src/utils";
import { Card } from "src/entities/card";
import { htmlToMarkdown, Notice } from 'obsidian';

export class Parser {
  private regex: Regex;
  private settings: ISettings;
  private htmlConverter;

  constructor(regex: Regex, settings: ISettings) {
    this.regex = regex;
    this.settings = settings;
    this.htmlConverter = new showdown.Converter();
    this.htmlConverter.setOption("simplifiedAutoLink", true);
    this.htmlConverter.setOption("tables", true);
    this.htmlConverter.setOption("tasks", true);
    this.htmlConverter.setOption("strikethrough", true);
    this.htmlConverter.setOption("ghCodeBlocks", true);
    this.htmlConverter.setOption("requireSpaceBeforeHeadingText", true);
    this.htmlConverter.setOption("simpleLineBreaks", true);
  }

  public async generateFlashcards(
    file: string,
    deck: string,
    vault: string,
    note: string,
    globalTags: string[] = []
  ): Promise<Flashcard[]> {
//   ) {
    const contextAware = this.settings.contextAwareMode;
    let cards: Flashcard[] = [];
    let headings: any = [];

    if (contextAware) {
      // https://regex101.com/r/agSp9X/4
      headings = [...file.matchAll(this.regex.headingsRegex)];
    }

    note = this.substituteObsidianLinks(`[[${note}]]`, vault);
    cards = cards.concat(
      this.generateCardsWithTag(file, headings, deck, vault, note, globalTags)
    );
    cards = cards.concat(
      await this.generateInlineCards(file, headings, deck, vault, note, globalTags)
    );
    cards = cards.concat(
      this.generateSpacedCards(file, headings, deck, vault, note, globalTags)
    );
    cards = cards.concat(
      this.generateClozeCards(file, headings, deck, vault, note, globalTags)
    );

    // Filter out cards that are fully inside a code block, a math block or a math inline block
    const codeBlocks = [...file.matchAll(this.regex.obsidianCodeBlock)];
    const mathBlocks = [...file.matchAll(this.regex.mathBlock)];
    const mathInline = [...file.matchAll(this.regex.mathInline)];
    const blocksToFilter = [...codeBlocks, ...mathBlocks, ...mathInline];
    const rangesToDiscard = blocksToFilter.map(x => ([x.index, x.index + x[0].length]))
    cards = cards.filter(card => {
      const cardRange = [card.initialOffset, card.endOffset];
      const isInRangeToDiscard = rangesToDiscard.some(range => {
        return (
          cardRange[0] >= range[0] && cardRange[1] <= range[1]
        );
      });
      return !isInRangeToDiscard;
    });

    cards.sort((a, b) => a.endOffset - b.endOffset);

    const defaultAnkiTag = this.settings.defaultAnkiTag;
    if (defaultAnkiTag) {
      for (const card of cards) {
        card.tags.push(defaultAnkiTag);
      }
    }

    return cards;
  }

  /**
   * Gives back the ancestor headings of a line.
   * @param headings The list of all the headings available in a file.
   * @param line The line whose ancestors need to be calculated.
   * @param headingLevel The level of the first ancestor heading, i.e. the number of #.
   */
  private getContext(
    headings: any,
    index: number,
    headingLevel: number
  ): string[] {
    const context: string[] = [];
    let currentIndex: number = index;
    let goalLevel = 6;

    let i = headings.length - 1;
    // Get the level of the first heading before the index (i.e. above the current line)
    if (headingLevel !== -1) {
      // This is the case of a #flashcard in a heading
      goalLevel = headingLevel - 1;
    } else {
      // Find first heading and its level
      // This is the case of a #flashcard in a paragraph
      for (i; i >= 0; i--) {
        if (headings[i].index < currentIndex) {
          currentIndex = headings[i].index;
          goalLevel = headings[i][1].length - 1;

          context.unshift(headings[i][2].trim());
          break;
        }
      }
    }

    // Search for the other headings
    for (i; i >= 0; i--) {
      const currentLevel = headings[i][1].length;
      if (currentLevel == goalLevel && headings[i].index < currentIndex) {
        currentIndex = headings[i].index;
        goalLevel = currentLevel - 1;

        context.unshift(headings[i][2].trim());
      }
    }

    return context;
  }

  private generateSpacedCards(
    file: string,
    headings: any,
    deck: string,
    vault: string,
    note: string,
    globalTags: string[] = []
  ) {
    const contextAware = this.settings.contextAwareMode;
    const cards: Spacedcard[] = [];
    const matches = [...file.matchAll(this.regex.cardsSpacedStyle)];

    for (const match of matches) {
      const reversed = false;
      let headingLevel = -1;
      if (match[1]) {
        headingLevel =
          match[1].trim().length !== 0 ? match[1].trim().length : -1;
      }
      // Match.index - 1 because otherwise in the context there will be even match[1], i.e. the question itself
      const context = contextAware
        ? this.getContext(headings, match.index - 1, headingLevel)
        : "";

      const originalPrompt = match[2].trim();
      let prompt = contextAware
        ? [...context, match[2].trim()].join(
          `${this.settings.contextSeparator}`
        )
        : match[2].trim();
      let medias: string[] = this.getImageLinks(prompt);
      medias = medias.concat(this.getAudioLinks(prompt));
      prompt = this.parseLine(prompt, vault);

      const initialOffset = match.index;
      const endingLine = match.index + match[0].length;
      const tags: string[] = this.parseTags(match[4], globalTags);
      const id: number = match[5] ? Number(match[5]) : -1;
      const inserted: boolean = match[5] ? true : false;
      const fields: any = { Prompt: prompt };
      if (this.settings.sourceSupport) {
        fields["Source"] = note;
      }
      const containsCode = this.containsCode([prompt]);

      const card = new Spacedcard(
        id,
        deck,
        originalPrompt,
        fields,
        reversed,
        initialOffset,
        endingLine,
        tags,
        inserted,
        medias,
        containsCode
      );
      cards.push(card);
    }

    return cards;
  }

  private generateClozeCards(
    file: string,
    headings: any,
    deck: string,
    vault: string,
    note: string,
    globalTags: string[] = []) {

    const contextAware = this.settings.contextAwareMode;
    const cards: Clozecard[] = [];
    const matches = [...file.matchAll(this.regex.cardsClozeWholeLine)];

    const mathBlocks = [...file.matchAll(this.regex.mathBlock)];
    const mathInline = [...file.matchAll(this.regex.mathInline)];
    const blocksToFilter = [...mathBlocks, ...mathInline];
    const rangesToDiscard = blocksToFilter.map(x => ([x.index, x.index + x[0].length]))

    for (const match of matches) {
      const reversed = false;
      let headingLevel = -1;
      if (match[1]) {
        headingLevel =
          match[1].trim().length !== 0 ? match[1].trim().length : -1;
      }
      // Match.index - 1 because otherwise in the context there will be even match[1], i.e. the question itself
      const context = contextAware
        ? this.getContext(headings, match.index - 1, headingLevel)
        : "";

      // If all the curly clozes are inside a math block, then do not create the card
      const extra = match[2]
            .replace(/==/g, '')
            .replace(/<.+?>/g, '')
            .replace(/\%\%.+?\%\%/g, '')
            .replace(/\(.+?\)/g, '');
      const curlyClozes = match[2].matchAll(this.regex.singleClozeCurly);
      const matchIndex = match.index;
      // Identify curly clozes, drop all the ones that are in math blocks i.e. ($\frac{1}{12}$) and substitute the others with Anki syntax
      let clozeText = match[2].replace(this.regex.singleClozeCurly, (match, g1, g2, g3, offset) => {
        const globalOffset = matchIndex + offset;
        const isInMathBlock = rangesToDiscard.some(x => (globalOffset >= x[0] && globalOffset + match[0].length <= x[1]));
        if (isInMathBlock) {
          return match;
        } else {
          if (g2) {
            return `{{c${g2}::${g3}}}`;
          } else {
            return `{{c1::${g3}}}`;
          }
        }
      });

      // Replace the highlight clozes in the line with Anki syntax
      clozeText = clozeText.replace(this.regex.singleClozeHighlight, "{{c1::$2}}");

      if (clozeText === match[2]) {
        // If the clozeText is the same as the match it means that the curly clozes were all in math blocks
        continue;
      }

      const originalLine = match[2].trim();
      // Add context
      clozeText = contextAware
        ? [...context, clozeText.trim()].join(
          `${this.settings.contextSeparator}`
        )
        : clozeText.trim();
      let medias: string[] = this.getImageLinks(clozeText);
      medias = medias.concat(this.getAudioLinks(clozeText));
      clozeText = this.parseLine(clozeText, vault);

      let finalDeck = deck

      clozeText = clozeText.replace(/\%\%/g, '');
      let clozeTextSplitted = clozeText.split('||');
      clozeText = clozeTextSplitted[0].trim();

      let hint = ''      
      clozeTextSplitted.forEach((value, index) => {
        if (index == 0) {
          return
        }
        value = value.trim()
        let valueSplitted = value.split(':')
        
        if (valueSplitted.length != 2) {
          console.log('ERROR: ' + clozeText)
          new Notice("Flashcard error: " + clozeText, 3000)
          return
        }
      
        let property = valueSplitted[0].toLocaleLowerCase().trim()
        let propertyValue = valueSplitted[1].trim()
      
        if (/deck/ig.test(property) || /^d$/i.test(property)) {
          finalDeck = propertyValue.replace(/<.+?>/g, '').trim();
        }
        else if (/hint/ig.test(property) || /^h$/i.test(property)) {
          hint = propertyValue
        }
        else {
          new Notice("Flashcard error: " + clozeText, 3000)
          console.log('ERROR: ' + clozeText)
          return
        }
      });

      const initialOffset = match.index;
      const endingLine = match.index + match[0].length;
      const tags: string[] = this.parseTags(match[4], globalTags);
      const id: number = match[5] ? Number(match[5]) : -1;
      const inserted: boolean = match[5] ? true : false;
      const fields: any = { Text: clozeText, Extra: extra, Hint: hint };
      if (this.settings.sourceSupport) {
        fields["Source"] = note;
      }
      const containsCode = this.containsCode([clozeText]);

      const card = new Clozecard(
        id,
        finalDeck,
        originalLine,
        fields,
        reversed,
        initialOffset,
        endingLine,
        tags,
        inserted,
        medias,
        containsCode
      );
      cards.push(card);
    }

    return cards;
  }

  private async generateInlineCards(
    file: string,
    headings: any,
    deck: string,
    vault: string,
    note: string,
    globalTags: string[] = []
  ) {
    const contextAware = this.settings.contextAwareMode;
    const cards: Inlinecard[] = [];
    const matches = [...file.matchAll(this.regex.cardsInlineStyle)];

    for (const match of matches) {
      if (
        match[2].toLowerCase().startsWith("cards-deck") ||
        match[2].toLowerCase().startsWith("tags") ||
        // ignore breadcrumbs hierarchy tags
        match[2].toLowerCase().trim() == "up" ||
        match[2].toLowerCase().trim() == "down" ||
        match[2].toLowerCase().trim() == "same"
      ) {
        continue;
      }

      const reversed: boolean = match[3] === this.settings.inlineSeparatorReverse;
      let headingLevel = -1;
      if (match[1]) {
        headingLevel =
          match[1].trim().length !== 0 ? match[1].trim().length : -1;
      }
      // Match.index - 1 because otherwise in the context there will be even match[1], i.e. the question itself
      const context = contextAware
        ? this.getContext(headings, match.index - 1, headingLevel)
        : "";

      const originalQuestion = match[2].trim();
      let question = contextAware
        ? [...context, match[2].trim()].join(
          `${this.settings.contextSeparator}`
        )
        : match[2].trim();

      let back = match[4].trim();
      let medias: string[] = this.getImageLinks(question);
      medias = medias.concat(this.getImageLinks(back));
      medias = medias.concat(this.getAudioLinks(back));

      let frontSound = null
      let backSound = null

      let hintImage = null;
      let hintImageRegEx = new RegExp(/\[\[([^\[]+?)\|Hint\]\]/, "g").exec(back);
      if (hintImageRegEx) {
          this.upload_to_anki(hintImageRegEx[1]);
          hintImage = `<img src="${hintImageRegEx[1]}">`;
      }

      let frontImage = null;
      let frontImageRegEx = new RegExp(/\[\[([^\[]+?)\|🖼\]\]/, "g").exec(question);
      if (frontImageRegEx) {
          this.upload_to_anki(frontImageRegEx[1]);
          frontImage = `<img src="${frontImageRegEx[1]}">`;
      }

      let backImage = null;
      let backImageRegEx = new RegExp(/\[\[([^\[]+?)\|🖼\]\]/, "g").exec(back);
      if (backImageRegEx) {
          this.upload_to_anki(backImageRegEx[1]);
          backImage = `<img src="${backImageRegEx[1]}">`;
      }

      question = this.parseLine(question, vault);
      let front = question
            .replace(/<.?p>/g, '')
            .replace(/\&nbsp\;/g, ' ')
            .replace(/\[.+$/g, '')
            .replace(/<a.+$/g, '')
            .trim();
      let frontPronunciation = ''
      if (question.includes('[')) {
        frontPronunciation = question.replace(/<.+?>/g, '').replace(/^.+\[/g, '[').replace(/\].+$/g, ']').trim()
      }

      back = this.parseLine(back, vault)
            .replace(/<.?p>/g, '')
            .replace(/\&nbsp\;/g, ' ')
            .trim()
      let backSplitted = back.replace(/\%\%/g, '').split('||');

      back = this.parseLine(back, vault);

      let finalDeck = deck

      back = backSplitted[0]
            .replace(/\[.+$/g, '')
            .replace(/<a.+$/g, '')
            .trim();

      // TODO: check
      let backPronunciation = ''
      if (backSplitted[0].includes('[')) {
        backPronunciation = backSplitted[0].replace(/<.+?>/g, '').replace(/^.+\[/g, '[').replace(/\].+$/g, ']').trim()
      }
      
      let hint = ''
      let options = new Map()
      backSplitted.forEach((value, index) => {
        if (index == 0) {
          return
        }
        value = value.trim()
        let valueSplitted = value.split(':')
        
        if (valueSplitted.length != 2) {
          console.log('ERROR: ' + back)
          new Notice("Flashcard error: " + back, 3000)
          return
        }
      
        let property = valueSplitted[0].replace(/<.+?>/g, '').toLocaleLowerCase().trim()
        let propertyValue = valueSplitted[1].replace(/<.+?>/g, '').trim()
      
        if (/deck/ig.test(property) || /^d$/i.test(property)) {
          finalDeck = propertyValue;
        }
        else if (/hint/ig.test(property) || /^h$/i.test(property)) {
          hint = propertyValue
        }
        else if (/options/ig.test(property) || /^o$/i.test(property)) {
            let optionsSplitted = propertyValue.split(',')
            optionsSplitted.forEach(option => {
                let optionSplitted = option.trim().split('=')
                if (optionSplitted.length == 1) {
                    options.set(optionSplitted[0], true)
                }
                else if (optionSplitted.length == 2) {
                    options.set(optionSplitted[0], optionSplitted[1])
                }
            })
        }
        else {
          new Notice("Flashcard error: " + back, 3000)
          console.log('ERROR: ' + back)
          return
        }
      });

        let cardLangMatch = new RegExp(/^(.+?)-(.+?)(-.+)?$/, "g").exec(finalDeck)
        if (!cardLangMatch) {
           continue;
        }
        let cardLang = cardLangMatch[1].toLowerCase();

      if (finalDeck.match("-PL") ||
            finalDeck.match("Sent") ||
            !finalDeck.match("PL") ||
            /Mati/.test(finalDeck)) {
          const frontAudioResponse = await fetch('http://localhost:9179/audio/generate', {
                method: 'POST',
                body: JSON.stringify({
                  lang: cardLang,
                  text: front,
                  anki_dir: this.settings.anki_dir,
                  obsidian_dir: this.settings.obsidian_dir
                }),
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                }})
          console.log(frontAudioResponse);
          if (frontAudioResponse.ok && frontAudioResponse.body !== null) {
            const frontAudioResponseJSON = await frontAudioResponse.json()
            frontSound = frontAudioResponseJSON["file_name"]
          }
      }

      cardLang = cardLangMatch[2].toLowerCase();
      if (/^PL-/.test(finalDeck) || /Mati/.test(finalDeck)) {
          const backAudioResponse = await fetch('http://localhost:9179/audio/generate', {
                method: 'POST',
                body: JSON.stringify({
                  lang: cardLang,
                  text: back,
                  anki_dir: this.settings.anki_dir,
                  obsidian_dir: this.settings.obsidian_dir
                }),
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                }})
          console.log(backAudioResponse);
          if (backAudioResponse.ok && backAudioResponse.body !== null) {
            const backAudioResponseJSON = await backAudioResponse.json()
            backSound = backAudioResponseJSON["file_name"]
          }
      }

      const initialOffset = match.index
      const endingLine = match.index + match[0].length;
      const tags: string[] = this.parseTags(match[5], globalTags);
      const id: number = match[6] ? Number(match[6]) : -1;
      const inserted: boolean = match[6] ? true : false;
      let fields: any = {
            Front: front,
            FrontPronunciation: frontPronunciation,
            Back: back,
            BackPronunciation: backPronunciation
      };
      if (this.settings.sourceSupport) {
        fields["Source"] = note;
      }
      if (frontSound) {
        fields["FrontSound"] = `[sound:${frontSound}]`
      }
      if (backSound) {
        fields["BackSound"] = `[sound:${backSound}]`
      }
      if (hint) {
        fields["Hint"] = hint
      }
      if (hintImage) {
        fields["HintImage"] = hintImage
      }
      if (frontImage) {
        fields["FrontImage"] = frontImage
      }
      if (backImage) {
        fields["BackImage"] = backImage
      }

      const containsCode = this.containsCode([question, back]);

      const card = new Inlinecard(
        id,
        finalDeck,
        originalQuestion,
        fields,
        reversed,
        initialOffset,
        endingLine,
        tags,
        inserted,
        medias,
        containsCode,
        options);
      cards.push(card);
    }

    // TODO: my workflow specific


    for(let i=0; i<cards.length; i++){
        let card = cards[i]
        card.fields["Back"] = card.fields["Back"].trim()
        if (card.options.has("addSentences")) {
          let sentences = ""
          let sentencesList: Record<string, string>[] = []
          cards.forEach(c => {
            if(/sentences/ig.test(c.deckName)) {
                let sentenceFront =
                    c.fields["Front"]
                        .replace(/<.?p(.+?)?>/g, '')
                        .replace(/<.?a(.+?)?>/g, '')
                        .trim()
                let sentenceBack =
                    c.fields["Back"]
                        .replace(/<.?p(.+?)?>/g, '')
                        .replace(/<.?a(.+?)?>/g, '')
                        .trim()

                sentencesList.push({
                    front: sentenceFront,
                    back: sentenceBack
                });
                sentences += sentenceFront + " - " + sentenceBack + "<br/>";
            }
          })
          card.fields["Sentences"] = `<p>${sentences}</p>`

            if (sentences != "" &&
                sentencesList.length > 0) {

                let langMatch = new RegExp(/^(.+?)-(.+?)(-.+)?$/, "g").exec(card.deckName)
                if (!langMatch) {
                   continue;
                }
                let lang = langMatch[2].toLowerCase();

                const sentencesAudioResponse = await fetch('http://localhost:9179/audio/generate', {
                      method: 'POST',
                      body: JSON.stringify({
                        lang: lang,
                        text: card.fields["Front"],
                        sentences: sentencesList,
                        anki_dir: this.settings.anki_dir,
                        obsidian_dir: this.settings.obsidian_dir
                      }),
                      headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                      }})
                console.log(sentencesAudioResponse);
                if (sentencesAudioResponse.ok && sentencesAudioResponse.body !== null) {
                  const sentencesAudioResponseJSON = await sentencesAudioResponse.json()
                  const sentencesFile = sentencesAudioResponseJSON["file_name"]
                  card.fields["SentencesSound"] = `[sound:${sentencesFile}]`
                }
            }
        }
    }

    return cards;
  }

  private async upload_to_anki(file_name: string) {
    const backAudioResponse = await fetch('http://localhost:9179/anki/upload', {
          method: 'POST',
          body: JSON.stringify({
            file_name: file_name,
            anki_dir: this.settings.anki_dir,
            obsidian_dir: this.settings.obsidian_dir
          }),
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          }});
    console.log(backAudioResponse);
    if (!backAudioResponse.ok) {
      console.error("upload_to_anki error: " + file_name);
    }
  }

  private generateCardsWithTag(
    file: string,
    headings: any,
    deck: string,
    vault: string,
    note: string,
    globalTags: string[] = []
  ) {
    const contextAware = this.settings.contextAwareMode;
    const cards: Flashcard[] = [];
    const matches = [...file.matchAll(this.regex.flashscardsWithTag)];

    const embedMap = this.getEmbedMap();

    for (const match of matches) {
      const reversed: boolean =
        match[3].trim().toLowerCase() ===
        `#${this.settings.flashcardsTag}-reverse` ||
        match[3].trim().toLowerCase() ===
        `#${this.settings.flashcardsTag}/reverse`;
      const headingLevel = match[1].trim().length !== 0 ? match[1].length : -1;
      // Match.index - 1 because otherwise in the context there will be even match[1], i.e. the question itself
      const context = contextAware
        ? this.getContext(headings, match.index - 1, headingLevel).concat([])
        : "";

      const originalQuestion = match[2].trim();
      let question = contextAware
        ? [...context, match[2].trim()].join(
          `${this.settings.contextSeparator}`
        )
        : match[2].trim();
      let back = match[5].trim();
      let medias: string[] = this.getImageLinks(question);
      medias = medias.concat(this.getImageLinks(back));
      medias = medias.concat(this.getAudioLinks(back));

      back = this.getEmbedWrapContent(embedMap, back);

      question = this.parseLine(question, vault);
      back = this.parseLine(back, vault);

      const initialOffset = match.index
      const endingLine = match.index + match[0].length;
      const tags: string[] = this.parseTags(match[4], globalTags);
      const id: number = match[6] ? Number(match[6]) : -1;
      const inserted: boolean = match[6] ? true : false;
      const fields: any = { Front: question, Back: back };
      if (this.settings.sourceSupport) {
        fields["Source"] = note;
      }
      const containsCode = this.containsCode([question, back]);

      const card = new Flashcard(
        id,
        deck,
        originalQuestion,
        fields,
        reversed,
        initialOffset,
        endingLine,
        tags,
        inserted,
        medias,
        containsCode
      );
      cards.push(card);
    }

    return cards;
  }

  public containsCode(str: string[]): boolean {
    for (const s of str) {
      if (s.match(this.regex.codeBlock)) {
        return true;
      }
    }
    return false;
  }

  public getCardsToDelete(file: string): number[] {
    // Find block IDs with no content above it
    return [...file.matchAll(this.regex.cardsToDelete)].map((match) => {
      return Number(match[1]);
    });
  }

  private parseLine(str: string, vaultName: string) {
    return this.htmlConverter.makeHtml(
      this.mathToAnki(
        this.substituteObsidianLinks(
          this.substituteImageLinks(this.substituteAudioLinks(str)),
          vaultName
        )
      )
    );
  }

  private getImageLinks(str: string) {
    const wikiMatches = str.matchAll(this.regex.wikiImageLinks);
    const markdownMatches = str.matchAll(this.regex.markdownImageLinks);
    const links: string[] = [];

    for (const wikiMatch of wikiMatches) {
      links.push(wikiMatch[1]);
    }

    for (const markdownMatch of markdownMatches) {
      links.push(decodeURIComponent(markdownMatch[1]));
    }

    return links;
  }

  private getAudioLinks(str: string) {
    const wikiMatches = str.matchAll(this.regex.wikiAudioLinks);
    const links: string[] = [];

    for (const wikiMatch of wikiMatches) {
      links.push(wikiMatch[1]);
    }

    return links;
  }

  private substituteObsidianLinks(str: string, vaultName: string) {
    const linkRegex = /\[\[(.+?)(?:\|(.+?))?\]\]/gim;
    vaultName = encodeURIComponent(vaultName);

    return str.replace(linkRegex, (match, filename, rename) => {
      const href = `obsidian://open?vault=${vaultName}&amp;file=${encodeURIComponent(
        filename
      )}.md`;
      const fileRename = rename ? rename : filename;
      return `<a href="${href}">${fileRename}</a>`;
    });
  }

  private substituteImageLinks(str: string): string {
    str = str.replace(this.regex.wikiImageLinks, "<img src='$1'>");
    str = str.replace(this.regex.markdownImageLinks, "<img src='$1'>");

    return str;
  }

  private substituteAudioLinks(str: string): string {
    return str.replace(this.regex.wikiAudioLinks, "[sound:$1]");
  }

  private mathToAnki(str: string) {
    str = str.replace(this.regex.mathBlock, function (match, p1, p2) {
      return "\\\\[" + escapeMarkdown(p2) + " \\\\]";
    });

    str = str.replace(this.regex.mathInline, function (match, p1, p2) {
      return "\\\\(" + escapeMarkdown(p2) + "\\\\)";
    });

    return str;
  }

  private parseTags(str: string, globalTags: string[]): string[] {
    const tags: string[] = [...globalTags];

    if (str) {
      for (const tag of str.split("#")) {
        let newTag = tag.trim();
        if (newTag) {
          // Replace obsidian hierarchy tags delimeter \ with anki delimeter ::
          newTag = newTag.replace(this.regex.tagHierarchy, "::");
          tags.push(newTag);
        }
      }
    }

    return tags;
  }

  public getAnkiIDsBlocks(file: string): RegExpMatchArray[] {
    return Array.from(file.matchAll(/\^(\d{13})\s*/gm));
  }

  private getEmbedMap() {

    // key：link url 
    // value： embed content parse from html document
    const embedMap = new Map()

    var embedList = Array.from(document.documentElement.getElementsByClassName('internal-embed'));


    Array.from(embedList).forEach((el) => {
      // markdown-embed-content markdown-embed-page
      var embedValue = this.htmlConverter.makeMarkdown(this.htmlConverter.makeHtml(el.outerHTML).toString());

      var embedKey = el.getAttribute("src");
      embedMap.set(embedKey, embedValue);

      // console.log("embedKey: \n" + embedKey);
      // console.log("embedValue: \n" + embedValue);
    });

    return embedMap;
  }

  private getEmbedWrapContent(embedMap: Map<any, any>, embedContent: string): string {
    var result = embedContent.match(this.regex.embedBlock);
    while (result = this.regex.embedBlock.exec(embedContent)) {
      // console.log("result[0]: " + result[0]);
      // console.log("embedMap.get(result[1]): " + embedMap.get(result[1]));
      embedContent = embedContent.concat(embedMap.get(result[1]));
    }
    return embedContent;
  }

}
