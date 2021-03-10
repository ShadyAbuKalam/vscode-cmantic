import * as vscode from 'vscode';
import * as cfg from './configuration';
import * as util from './utility';
import * as parse from './parsing';
import { SourceSymbol } from './SourceSymbol';
import { ProposedPosition } from './ProposedPosition';
import { SourceFile } from './SourceFile';
import { SourceDocument } from './SourceDocument';
import { SubSymbol } from './SubSymbol';

const re_primitiveTypes = /\b(void|bool|char|wchar_t|char8_t|char16_t|char32_t|int|short|long|signed|unsigned|float|double)\b/;
// Only matches identifiers that are not folowed by a scope resolution operator (::).
const re_scopeResolvedIdentifier = /[\w_][\w\d_]*\b(?!\s*::)/;
const re_beginingOfScopeString = /(?<!::\s*|[\w\d_])[\w_][\w\d_]*(?=\s*::)/g;


/**
 * Extends SourceSymbol by adding a document property that gives more semantic-awareness over SourceSymbol.
 */
export class CSymbol extends SourceSymbol {
    readonly document: SourceDocument;
    parent?: CSymbol;

    /**
     * When constructing with a SourceSymbol that has a parent, the parent parameter may be omitted.
     */
    constructor(symbol: SourceSymbol, document: SourceDocument) {
        super(symbol, document.uri);
        this.document = document;

        if (symbol.parent) {
            this.parent = new CSymbol(symbol.parent, document);
        }

        this.range = this.range.with(this.range.start, parse.getEndOfStatement(this.document, this.range.end));
    }

    /**
     * Returns the text contained in this symbol.
     */
    text(): string { return this.document.getText(this.range); }

    /**
     * Returns the text contained in this symbol with comments masked with spaces.
     */
    get parsableText(): string {
        if (this._parsableText) {
            return this._parsableText;
        }
        this._parsableText = parse.maskComments(this.text(), false);
        this._parsableText = parse.maskRawStringLiterals(this._parsableText);
        this._parsableText = parse.maskQuotes(this._parsableText);
        return this._parsableText;
    }
    private _parsableText?: string;

    get parsableLeadingText(): string {
        const endIndex = this.document.offsetAt(this.selectionRange.start) - this.startOffset();
        return this.parsableText.substring(0, endIndex);
    }

    /**
     * Returns the text of this symbol including potential template statement.
     */
    fullText(): string { return this.document.getText(this.fullRange()); }

    fullTextWithLeadingComment(): string {
        return this.document.getText(this.rangeWithLeadingComment());
    }

    /**
     * Returns the text contained in this symbol that comes before this.selectionRange.
     */
    leadingText(): string {
        return this.document.getText(new vscode.Range(this.range.start, this.selectionRange.start));
    }

    /**
     * Returns the text contained in this symbol that comes before this.selectionRange,
     * including potential template statement.
     */
    fullLeadingText(): string {
        return this.document.getText(new vscode.Range(this.trueStart, this.selectionRange.start));
    }

    /**
     * Returns the range of this symbol including potential template statement.
     */
    fullRange(): vscode.Range { return new vscode.Range(this.trueStart, this.range.end); }

    rangeWithLeadingComment(): vscode.Range {
        return new vscode.Range(this.leadingCommentStart, this.range.end);
    }

    startOffset(): number { return this.document.offsetAt(this.range.start); }

    endOffset(): number { return this.document.offsetAt(this.range.end); }

    trueStartOffset(): number { return this.document.offsetAt(this.trueStart); }

    isBefore(offset: number): boolean { return this.endOffset() < offset; }

    isAfter(offset: number): boolean { return this.startOffset() > offset; }

    get accessSpecifiers(): SubSymbol[] {
        if (this._accessSpecifiers) {
            return this._accessSpecifiers;
        }

        this._accessSpecifiers = [];

        if (!this.isClassOrStruct()) {
            return this._accessSpecifiers;
        }

        const startOffset = this.startOffset();

        let parsableText = this.parsableText;
        this.children.forEach(child => {
            // Mask children in order to easily match access specifiers.
            const childCSymbol = new CSymbol(child, this.document);
            const relativeStartOffset = childCSymbol.startOffset() - startOffset;
            const relativeEndOffset = childCSymbol.endOffset() - startOffset;
            parsableText = parsableText.slice(0, relativeStartOffset)
                    + ' '.repeat(relativeEndOffset - relativeStartOffset)
                    + parsableText.slice(relativeEndOffset);
        });

        // Prevent potential macro arguments from affecting access specifier matching.
        parsableText = parse.maskParentheses(parsableText);

        for (const match of parsableText.matchAll(/\b[\w_][\w\d_]*\s*:(?!:)/g)) {
            if (match.index === undefined) {
                continue;
            }
            const start = this.document.positionAt(startOffset + match.index);
            const end = this.document.positionAt(startOffset + match.index + match[0].length);
            this._accessSpecifiers.push(new SubSymbol(this, new vscode.Range(start, end)));
        }

        return this._accessSpecifiers;
    }
    private _accessSpecifiers?: SubSymbol[];

    rangesOfAccess(access: util.AccessLevel): vscode.Range[] {
        const re_accessSpecifier = util.accessSpecifierRegexp(access);
        const ranges: vscode.Range[] = [];
        let start: vscode.Position | undefined;

        if (access === util.AccessLevel.private && this.kind === vscode.SymbolKind.Class) {
            start = this.bodyStart();
        } else if (access === util.AccessLevel.public && this.kind === vscode.SymbolKind.Struct) {
            start = this.bodyStart();
        }

        for (const accessSpecifier of this.accessSpecifiers) {
            if (re_accessSpecifier.test(accessSpecifier.text()) && !start) {
                start = accessSpecifier.range.end;
            } else if (start) {
                ranges.push(new vscode.Range(start, accessSpecifier.range.start));
                start = undefined;
            }
        }

        if (start) {
            ranges.push(new vscode.Range(start, this.bodyEnd()));
        }

        return ranges;
    }

    positionHasAccess(position: vscode.Position, access: util.AccessLevel): boolean {
        return this.rangesOfAccess(access).some(range => range.contains(position));
    }

    /**
     * Finds a position for a new member function within this class or struct. Optionally provide a relativeName
     * to look for a position next to. Optionally provide a memberVariable if the new member function is an
     * accessor. Returns undefined if this is not a class or struct, or when this.children.length === 0.
     */
    findPositionForNewMemberFunction(
        access: util.AccessLevel, relativeName?: string, memberVariable?: SourceSymbol
    ): ProposedPosition | undefined {
        if (!this.isClassOrStruct()) {
            return;
        }

        /* If relativeName is a setterName, then ProposedPosition should be before, since the new member function is
         * a getter. This is to match the positioning of these members when both are generated at the same time. */
        const isGetter = memberVariable ? relativeName === memberVariable.setterName() : false;

        for (let i = this.children.length - 1, child = new CSymbol(this.children[i], this.document);
            i >= 0 && (child = new CSymbol(this.children[i], this.document));
            --i
        ) {
            if (child.name === relativeName) {
                if (isGetter) {
                    return new ProposedPosition(child.leadingCommentStart, {
                        relativeTo: child.range,
                        before: true,
                        nextTo: true
                    });
                } else {
                    return new ProposedPosition(child.range.end, {
                        relativeTo: child.range,
                        after: true,
                        nextTo: true
                    });
                }
            } else if (relativeName === undefined && this.positionHasAccess(child.range.end, access)) {
                return new ProposedPosition(child.range.end, {
                    relativeTo: child.range,
                    after: true
                });
            }
        }

        return this.getPositionForNewChild();
    }

    async scopeString(target: SourceDocument, position: vscode.Position): Promise<string> {
        let scopeString = '';
        const scopes = (this.isClassOrStruct() || this.kind === vscode.SymbolKind.Namespace)
                ? [...this.scopes(), this]
                : this.scopes();

        for (const scope of scopes) {
            let targetScope = await target.findMatchingSymbol(scope);
            // Check if position exists inside of a corresponding scope block. If so, omit that scope.name.
            if (!targetScope || !util.containsExclusive(targetScope.range, position)) {
                if (!targetScope) {
                    targetScope = new CSymbol(scope, this.document);
                }
                const templateParameters = targetScope.isTemplate()
                        ? targetScope.templateParameters()
                        : '';
                scopeString += scope.name + templateParameters + '::';
            }
        }

        return scopeString;
    }

    immediateScope(): SubSymbol | undefined {
        const match = this.parsableLeadingText.match(/[\w_][\w\d_]*(?=\s*::\s*$)/);
        if (!match || match.index === undefined) {
            return;
        }

        const startOffset = this.startOffset() + match.index;
        const start = this.document.positionAt(startOffset);
        const end = this.document.positionAt(startOffset + match[0].length);

        return new SubSymbol(this.document, new vscode.Range(start, end));
    }

    async getParentClass(): Promise<CSymbol | undefined> {
        const immediateScope = this.immediateScope();
        if (immediateScope) {
            const immediateScopeDefinition = await immediateScope.findDefinition();
            if (immediateScopeDefinition) {
                const immediateScopeDoc = (immediateScopeDefinition.uri.fsPath === this.uri.fsPath)
                        ? this.document
                        : await SourceDocument.open(immediateScopeDefinition.uri);
                const immediateScopeSymbol = await immediateScopeDoc.getSymbol(immediateScopeDefinition.range.start);
                if (immediateScopeSymbol?.isClassOrStruct()) {
                    return immediateScopeSymbol;
                }
            }
        }
    }

    baseClasses(): SubSymbol[] {
        if (!this.isClassOrStruct()) {
            return [];
        }

        const startOffset = this.document.offsetAt(this.selectionRange.end);
        let trailingText = this.document.getText(new vscode.Range(this.selectionRange.end, this.declarationEnd()));
        trailingText = parse.maskComments(trailingText, false);
        trailingText = parse.maskAngleBrackets(trailingText);
        trailingText = trailingText.replace(/\b(public|protected|private)\b/g, parse.masker);

        const baseClasses: SubSymbol[] = [];
        for (const match of trailingText.matchAll(/\b[\w_][\w\d_]*(\s*::\s*[\w_][\w\d_]*)*\b(\s*<\s*>)?/g)) {
            if (match.index !== undefined) {
                const matchStartOffset = startOffset + match.index;
                const start = this.document.positionAt(matchStartOffset);
                const end = this.document.positionAt(startOffset + match.index + match[0].length);
                const selectionMatch = match[0].match(re_scopeResolvedIdentifier);
                let selectionRange: vscode.Range | undefined;
                if (selectionMatch?.index !== undefined) {
                    const selectionStart = this.document.positionAt(matchStartOffset + selectionMatch.index);
                    const selectionEnd = this.document.positionAt(
                            matchStartOffset + selectionMatch.index + selectionMatch[0].length);
                    selectionRange = new vscode.Range(selectionStart, selectionEnd);
                }
                baseClasses.push(new SubSymbol(this.document, new vscode.Range(start, end), selectionRange));
            }
        }

        return baseClasses;
    }

    /**
     * Retruns the member variables of this class/struct that are const or a reference.
     */
    memberVariablesThatRequireInitialization(): SourceSymbol[] {
        if (!this.isClassOrStruct()) {
            return [];
        }

        return this.children.filter(child => {
            if (child.isMemberVariable()) {
                const memberVariable = new CSymbol(child, this.document);
                return memberVariable.isConst() || memberVariable.isReference();
            }
        });
    }

    nonStaticMemberVariables(): SourceSymbol[] {
        if (!this.isClassOrStruct()) {
            return [];
        }

        return this.children.filter(child => {
            if (child.isMemberVariable()) {
                const memberVariable = new CSymbol(child, this.document);
                return !memberVariable.isStatic();
            }
        });
    }

    templateStatement(removeDefaultArgs?: boolean): string {
        if (!this.isTemplate()) {
            return '';
        }

        const maskedLeadingText = parse.maskAngleBrackets(this.fullLeadingText());
        const templateParamEnd = maskedLeadingText.indexOf('>');
        if (templateParamEnd === -1) {
            return '';
        }

        const templateParamEndOffset = this.document.offsetAt(this.trueStart) + templateParamEnd + 1;
        const templateParamEndPos = this.document.positionAt(templateParamEndOffset);
        const templateStatement = this.document.getText(new vscode.Range(this.trueStart, templateParamEndPos));

        return removeDefaultArgs ? templateStatement.replace(/\s*=[^,>]+(?=[,>])/g, '') : templateStatement;
    }

    templateParameters(): string {
        const templateStatement = this.templateStatement(true);
        if (!templateStatement) {
            return '';
        }

        const templateParamStart = templateStatement.indexOf('<');
        if (templateParamStart === -1) {
            return '';
        }

        const parameterList = parse.maskAngleBrackets(templateStatement.slice(templateParamStart + 1, -1));
        const parameters: string[] = [];

        for (const parameter of parameterList.matchAll(/(?<=[\w_][\w\d_]*\b\s*)(\.\.\.)?\s*\b([\w_][\w\d_]*)/g)) {
            parameters.push(parameter[2] + (parameter[1] ? parameter[1] : ''));
        }

        return '<' + parameters.join(', ') + '>';
    }

    isFunctionDeclaration(): boolean {
        return this.isFunction() && !this.parsableText.endsWith('}')
                && !this.isDeletedOrDefaulted() && !this.isPureVirtual();
    }

    isFunctionDefinition(): boolean {
        return this.isFunction() && this.parsableText.endsWith('}')
                && !this.isDeletedOrDefaulted() && !this.isPureVirtual();
    }

    isVirtual(): boolean {
        return /\b(virtual|override|final)\b/.test(this.parsableLeadingText);
    }

    isPureVirtual(): boolean {
        return this.isVirtual() && /\s*=\s*0\s*;?$/.test(this.parsableText);
    }

    isDeletedOrDefaulted(): boolean {
        return /\s*=\s*(delete|default)\s*;?$/.test(this.parsableText);
    }

    isConstexpr(): boolean {
        return /\bconstexpr\b/.test(this.parsableLeadingText);
    }

    isInline(): boolean {
        return /\binline\b/.test(this.parsableLeadingText);
    }

    isPointer(): boolean {
        return parse.maskAngleBrackets(this.parsableLeadingText).includes('*');
    }

    isReference(): boolean {
        return parse.maskAngleBrackets(this.parsableLeadingText).includes('&');
    }

    isConst(): boolean {
        return /\bconst\b/.test(parse.maskAngleBrackets(this.parsableLeadingText));
    }

    isStatic(): boolean {
        return /\bstatic\b/.test(this.parsableLeadingText);
    }

    isTemplate(): boolean {
        return this.fullLeadingText().startsWith('template');
    }

    isTypedef(): boolean {
        return this.mightBeTypedefOrTypeAlias() && /\btypedef\b/.test(this.parsableText);
    }

    isTypeAlias(): boolean {
        return this.mightBeTypedefOrTypeAlias()
                && /\busing\b/.test(this.parsableText) && this.parsableText.includes('=');
    }

    async isPrimitive(): Promise<boolean> {
        if (this.isVariable()) {
            const leadingText = this.parsableLeadingText;
            if (this.matchesPrimitiveType(leadingText)) {
                return true;
            } else if (!cfg.resolveTypes()) {
                return false;
            }

            const type = leadingText.replace(/\b(static|const|constexpr|inline|mutable)\b/g, parse.masker);
            const index = type.search(re_scopeResolvedIdentifier);
            if (index !== -1) {
                return await this.resolveThisType(this.startOffset() + index);
            }
        } else if (this.isTypedef()) {
            if (this.matchesPrimitiveType(this.parsableText)) {
                return true;
            } else if (/\b(struct|class|(<(>(?=>)|[^>])*>))\b/.test(this.parsableText)) {
                return false;
            } else if (!cfg.resolveTypes()) {
                return false;
            }

            const maskedText = this.parsableText.replace(/\b(typedef|const)\b/g, parse.masker);
            const index = maskedText.search(re_scopeResolvedIdentifier);
            if (index !== -1) {
                return await this.resolveThisType(this.startOffset() + index);
            }
        } else if (this.isTypeAlias()) {
            if (this.matchesPrimitiveType(this.parsableText)) {
                return true;
            } else if (/\b(struct|class|(<(>(?=>)|[^>])*>))\b/.test(this.parsableText)) {
                return false;
            } else if (!cfg.resolveTypes()) {
                return false;
            }

            const indexOfEquals = this.parsableText.indexOf('=');
            if (indexOfEquals === -1) {
                return false;
            }

            const type = this.parsableText.substring(indexOfEquals + 1);
            const index = type.search(re_scopeResolvedIdentifier);
            if (index !== -1) {
                return await this.resolveThisType(this.startOffset() + index);
            }
        }

        return false;
    }

    private async resolveThisType(offset: number): Promise<boolean> {
        const sourceDoc = (this.document instanceof SourceDocument) ? this.document : new SourceDocument(this.document);
        const locations = await sourceDoc.findDefintions(this.document.positionAt(offset));

        if (locations.length > 0) {
            const typeFile = new SourceFile(locations[0].uri);
            const typeSymbol = await typeFile.getSymbol(locations[0].range.start);

            if (typeSymbol?.kind === vscode.SymbolKind.Enum) {
                return true;
            } else if (typeSymbol?.mightBeTypedefOrTypeAlias()) {
                const typeDoc = await typeFile.openDocument();
                const typeCSymbol = new CSymbol(typeSymbol, typeDoc);
                return await typeCSymbol.isPrimitive();
            }
        }

        return false;
    }

    async getDefinitionForTargetPosition(
        targetDoc: SourceDocument,
        position: vscode.Position,
        declarationSymbol?: CSymbol,
        checkForInline?: boolean
    ): Promise<string> {
        const bodyRange = new vscode.Range(this.declarationEnd(), this.range.end);
        const bodyText = this.document.getText(bodyRange).replace(parse.getIndentationRegExp(this), '');
        const scopeString = await declarationSymbol?.scopeString(targetDoc, position);

        let comment = '';
        if (cfg.alwaysMoveComments()) {
            comment = this.document.getText(new vscode.Range(this.leadingCommentStart, this.trueStart));
            comment = comment.replace(parse.getIndentationRegExp(this), '');
        }

        // This CSymbol is a definition, but it can be treated as a declaration for the purpose of this function.
        const declaration = await this.formatDeclaration(targetDoc, position, scopeString, checkForInline);
        return comment + declaration + bodyText;
    }

    async getDeclarationForTargetPosition(targetDoc: SourceDocument, position: vscode.Position): Promise<string> {
        return await this.formatDeclaration(targetDoc, position) + ';';
    }

    /**
     * Formats this function declaration for use as a definition (without curly braces).
     */
    async newFunctionDefinition(targetDoc: SourceDocument, position: vscode.Position): Promise<string> {
        if (!this.isFunctionDeclaration()) {
            return '';
        }
        return this.formatDeclaration(targetDoc, position, undefined, true);
    }

    private async formatDeclaration(
        targetDoc: SourceDocument,
        position: vscode.Position,
        scopeString?: string,
        checkForInline?: boolean
    ): Promise<string> {
        if (scopeString === undefined) {
            scopeString = await this.scopeString(targetDoc, position);
        }

        const declarationRange = new vscode.Range(this.trueStart, this.declarationEnd());
        const declaration = this.document.getText(declarationRange).replace(/;$/, '');
        let maskedDeclaration = parse.maskComments(declaration, false);
        maskedDeclaration = parse.maskRawStringLiterals(maskedDeclaration);
        maskedDeclaration = parse.maskQuotes(maskedDeclaration);
        maskedDeclaration = parse.maskParentheses(maskedDeclaration);

        const nameEndIndex = this.document.offsetAt(this.selectionRange.end) - this.document.offsetAt(this.trueStart);
        const paramStartIndex = maskedDeclaration.indexOf('(', nameEndIndex);
        const paramEndIndex = maskedDeclaration.indexOf(')', nameEndIndex);
        if (paramStartIndex === -1 || paramEndIndex === -1) {
            return '';
        }
        const parameters = parse.stripDefaultValues(declaration.substring(paramStartIndex + 1, paramEndIndex));

        const templateStatement = this.parent?.isTemplate()
                ? this.parent.templateStatement(true) + targetDoc.endOfLine
                : '';
        const inlineSpecifier =
                ((!this.parent || !util.containsExclusive(this.parent.range, position))
                        && (this.document.fileName === targetDoc.fileName || targetDoc.isHeader())
                        && !this.isInline() && !this.isConstexpr() && checkForInline)
                ? 'inline '
                : '';

        // Intelligently align the definition in the case of a multi-line declaration.
        const scopeStringStart = this.scopeStringStart();
        let leadingText = this.document.getText(new vscode.Range(this.trueStart, scopeStringStart));
        const oldScopeString = this.document.getText(new vscode.Range(scopeStringStart, this.selectionRange.start));
        const line = this.document.lineAt(this.range.start);
        const leadingIndent = line.text.substring(0, line.firstNonWhitespaceCharacterIndex).length;
        const leadingLines = leadingText.split(util.endOfLine(this.document));
        const alignLength = leadingLines[leadingLines.length - 1].trimStart().length;
        const newLineAlignment = leadingIndent + alignLength + oldScopeString.length;
        const re_newLineAlignment =
                new RegExp('^' + ' '.repeat(newLineAlignment), 'gm');
        leadingText = leadingText.replace(/\b(virtual|static|explicit|friend)\b\s*/g, '');
        if (!targetDoc.isHeader() || !checkForInline) {
            leadingText = leadingText.replace(/\binline\b\s*/, '');
        }
        leadingText = leadingText.replace(parse.getIndentationRegExp(this), '');
        let definition = this.name + '(' + parameters + ')' + declaration.substring(paramEndIndex + 1);

        const newLeadingLines = leadingText.split(targetDoc.endOfLine);
        const newAlignLength = newLeadingLines[newLeadingLines.length - 1].length;
        if (newLineAlignment) {
            definition = definition.replace(
                    re_newLineAlignment, ' '.repeat(newAlignLength + inlineSpecifier.length + scopeString.length));
        }
        definition = templateStatement + inlineSpecifier + leadingText + scopeString + definition;
        return definition.replace(/\s*\b(override|final)\b/g, '');
    }

    newFunctionDeclaration(): string {
        if (!this.isFunctionDefinition()) {
            return '';
        }
        return this.document.getText(new vscode.Range(this.trueStart, this.declarationEnd())).trimEnd() + ';';
    }

    combineDefinition(definition: CSymbol): string {
        const body = definition.document.getText(new vscode.Range(definition.declarationEnd(), definition.range.end));
        const re_oldIndentation = parse.getIndentationRegExp(definition);
        const line = this.document.lineAt(this.range.start);
        const newIndentation = line.text.substring(0, line.firstNonWhitespaceCharacterIndex);

        // If this CSymbol (declaration) doesn't have a comment, then we want to pull the comment from the definition.
        if (!this.hasLeadingComment() && definition.hasLeadingComment()) {
            const leadingCommentRange = new vscode.Range(definition.leadingCommentStart, definition.trueStart);
            const leadingComment = definition.document.getText(leadingCommentRange);
            return leadingComment.replace(re_oldIndentation, '').replace(/\n(?!$)/gm, '\n' + newIndentation)
                    + newIndentation + this.fullText().replace(/\s*;$/, '')
                    + body.replace(re_oldIndentation, '').replace(/\n(?!$)/gm, '\n' + newIndentation);
        }

        return this.fullText().replace(/\s*;$/, '')
                + body.replace(re_oldIndentation, '').replace(/\n(?!$)/gm, '\n' + newIndentation);
    }

    /**
     * clangd and ccls don't include template statements in provided DocumentSymbols.
     */
    get trueStart(): vscode.Position {
        if (this._trueStart) {
            return this._trueStart;
        }

        const before = new vscode.Range(new vscode.Position(0, 0), this.range.start);
        let maskedText = parse.maskComments(this.document.getText(before), false);
        maskedText = parse.maskAngleBrackets(maskedText).trimEnd();
        if (!maskedText.endsWith('>')) {
            this._trueStart = this.range.start;
            return this._trueStart;
        }

        let lastMatch: RegExpMatchArray | undefined;
        for (const match of maskedText.matchAll(/\btemplate\s*<.*>/g)) {
            lastMatch = match;
        }
        if (lastMatch?.index === undefined) {
            this._trueStart = this.range.start;
            return this._trueStart;
        }

        this._trueStart = this.document.positionAt(lastMatch.index);
        return this._trueStart;
    }
    private _trueStart?: vscode.Position;

    private declarationEnd(): vscode.Position {
        const maskedText = parse.maskParentheses(this.parsableText);
        const startOffset = this.startOffset();
        const nameEndIndex = this.document.offsetAt(this.selectionRange.end) - startOffset;
        const bodyStartIndex = maskedText.substring(nameEndIndex).search(/\s*{|\s*;$/);
        if (bodyStartIndex === -1) {
            return this.range.end;
        }

        if (!this.isConstructor()) {
            return this.document.positionAt(startOffset + nameEndIndex + bodyStartIndex);
        }

        // Get the start of the constructor's member initializer list, if one is present.
        const initializerIndex = maskedText.substring(nameEndIndex, bodyStartIndex + nameEndIndex).search(/\s*:(?!:)/);
        if (initializerIndex === -1) {
            return this.document.positionAt(startOffset + nameEndIndex + bodyStartIndex);
        }
        return this.document.positionAt(startOffset + nameEndIndex + initializerIndex);
    }

    private bodyStart(): vscode.Position {
        const maskedText = parse.maskBraces(parse.maskParentheses(this.parsableText));
        const bodyStartIndex = maskedText.lastIndexOf('{');
        if (bodyStartIndex === -1) {
            return this.range.end;
        }

        return this.document.positionAt(this.startOffset() + bodyStartIndex + 1);
    }

    private bodyEnd(): vscode.Position {
        const bodyEndIndex = this.parsableText.lastIndexOf('}');
        if (bodyEndIndex === -1) {
            return this.range.end;
        }

        return this.document.positionAt(this.startOffset() + bodyEndIndex);
    }

    private scopeStringStart(): vscode.Position {
        const trimmedLeadingText = this.parsableLeadingText.trimEnd();
        if (!trimmedLeadingText.endsWith('::')) {
            return this.selectionRange.start;
        }

        let lastMatch: RegExpMatchArray | undefined;
        for (const match of trimmedLeadingText.matchAll(re_beginingOfScopeString)) {
            lastMatch = match;
        }
        if (lastMatch?.index === undefined) {
            return this.selectionRange.start;
        }

        return this.document.positionAt(this.startOffset() + lastMatch.index);
    }

    hasLeadingComment(): boolean {
        if (this.leadingCommentStart.isEqual(this.trueStart)) {
            return false;
        }
        return true;
    }

    get leadingCommentStart(): vscode.Position {
        if (this._leadingCommentStart) {
            return this._leadingCommentStart;
        }

        const before = new vscode.Range(new vscode.Position(0, 0), this.trueStart);
        const maskedText = parse.maskComments(this.document.getText(before)).trimEnd();
        if (!maskedText.endsWith('//') && !maskedText.endsWith('*/')) {
            this._leadingCommentStart = this.trueStart;
            return this._leadingCommentStart;
        }

        if (maskedText.endsWith('*/')) {
            const commentStartOffset = maskedText.lastIndexOf('/*');
            if (commentStartOffset !== -1) {
                this._leadingCommentStart = this.document.positionAt(commentStartOffset);
                return this._leadingCommentStart;
            }
            this._leadingCommentStart = this.trueStart;
            return this._leadingCommentStart;
        }

        for (let i = this.trueStart.line - 1; i >= 0; --i) {
            const line = this.document.lineAt(i);
            if (!line.text.trimStart().startsWith('//')) {
                const indexOfComment = this.document.lineAt(i + 1).text.indexOf('//');
                if (indexOfComment === -1) {
                    break;  // This shouldn't happen, but just in-case.
                }
                this._leadingCommentStart = new vscode.Position(i + 1, indexOfComment);
                return this._leadingCommentStart;
            }
        }

        this._leadingCommentStart = this.trueStart;
        return this._leadingCommentStart;
    }
    private _leadingCommentStart?: vscode.Position;

    private isChildFunctionBetween(child: CSymbol, afterOffset: number, beforeOffset: number): boolean {
        if (child.isFunction() && child.isAfter(afterOffset) && child.isBefore(beforeOffset)) {
            return true;
        }
        return false;
    }

    private getPositionForNewChild(): ProposedPosition {
        if (this.children.length > 0) {
            const lastChild = new CSymbol(this.children[this.children.length - 1], this.document);
            return new ProposedPosition(lastChild.range.end, {
                relativeTo: this.children[this.children.length - 1].range,
                after: true
            });
        }

        return new ProposedPosition(this.bodyStart(), {
            after: true,
            nextTo: true,
            emptyScope: true
        });
    }

    private matchesPrimitiveType(text: string): boolean {
        return !(text.includes('<') && text.includes('>')) && re_primitiveTypes.test(text);
    }
}
