import * as vscode from 'vscode';
import { SourceDocument } from "./SourceDocument";
import { CSymbol } from "./CSymbol";
import { failure as addDefinitionFailure, title as addDefinitionTitle } from './addDefinition';
import { failure as moveDefinitionFailure, title as moveDefinitionTitle } from './moveDefinition';
import { failure as getterSetterFailure, title as getterSetterTitle } from './generateGetterSetter';
import { failure as createSourceFileFailure } from './createSourceFile';
import { failure as addHeaderGuardFailure } from './addHeaderGuard';
import { getMatchingSourceFile } from './extension';
import { SourceSymbol } from './SourceSymbol';
import { SourceFile } from './SourceFile';


export class CodeActionProvider implements vscode.CodeActionProvider
{
    async provideCodeActions(
        document: vscode.TextDocument,
        rangeOrSelection: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeAction[]> {
        const sourceDoc = new SourceDocument(document);

        const [matchingUri, symbol] = await Promise.all([
            getMatchingSourceFile(sourceDoc.uri),
            sourceDoc.getSymbol(rangeOrSelection.start)
        ]);

        const [refactorings, sourceActions] = await Promise.all([
            this.getRefactorings(symbol, rangeOrSelection, sourceDoc, matchingUri),
            this.getSourceActions(sourceDoc, matchingUri)
        ]);

        return [...refactorings, ...sourceActions];
    }

    private async getRefactorings(
        symbol: CSymbol | undefined,
        rangeOrSelection: vscode.Range | vscode.Selection,
        sourceDoc: SourceDocument,
        matchingUri?: vscode.Uri
    ): Promise<vscode.CodeAction[]> {
        if (symbol?.isFunctionDeclaration()) {
            return await this.getFunctionDeclarationRefactorings(symbol, sourceDoc, matchingUri);
        } else if (symbol?.isFunctionDefinition() && symbol.selectionRange.contains(rangeOrSelection.start)) {
            return await this.getFunctionDefinitionRefactorings(symbol, sourceDoc, matchingUri);
        } else if (symbol?.isMemberVariable()) {
            return await this.getMemberVariableRefactorings(symbol, sourceDoc);
        }
        return [];
    }

    private async getFunctionDeclarationRefactorings(
        symbol: CSymbol,
        sourceDoc: SourceDocument,
        matchingUri?: vscode.Uri
    ): Promise<vscode.CodeAction[]> {
        const existingDefinition = await symbol.findDefinition();

        let addDefinitionInMatchingSourceFileTitle = addDefinitionTitle.matchingSourceFile;
        let addDefinitionInMatchingSourceFileDisabled: { readonly reason: string } | undefined;
        let addDefinitionInCurrentFileDisabled: { readonly reason: string } | undefined;

        if (symbol.isInline()) {
            addDefinitionInMatchingSourceFileDisabled = { reason: addDefinitionFailure.isInline };
        }
        if (symbol.isConstexpr()) {
            addDefinitionInMatchingSourceFileDisabled = { reason: addDefinitionFailure.isConstexpr };
        }
        if (existingDefinition) {
            addDefinitionInMatchingSourceFileDisabled = { reason: addDefinitionFailure.definitionExists };
            addDefinitionInCurrentFileDisabled = addDefinitionInMatchingSourceFileDisabled;
        }
        if (!sourceDoc.isHeader()) {
            addDefinitionInMatchingSourceFileDisabled = { reason: addDefinitionFailure.notHeaderFile };
        } else if (matchingUri) {
            const displayPath = this.formatPathToDisplay(matchingUri);
            addDefinitionInMatchingSourceFileTitle = `Add Definition in "${displayPath}"`;
        } else {
            addDefinitionInMatchingSourceFileDisabled = { reason: addDefinitionFailure.noMatchingSourceFile };
        }

        return [{
            title: addDefinitionInMatchingSourceFileTitle,
            kind: vscode.CodeActionKind.Refactor,
            command: {
                title: addDefinitionInMatchingSourceFileTitle,
                command: 'cmantic.addDefinition',
                arguments: [symbol, sourceDoc, matchingUri]
            },
            disabled: addDefinitionInMatchingSourceFileDisabled
        }, {
            title: addDefinitionTitle.currentFile,
            kind: vscode.CodeActionKind.Refactor,
            command: {
                title: addDefinitionTitle.currentFile,
                command: 'cmantic.addDefinition',
                arguments: [symbol, sourceDoc, sourceDoc.uri]
            },
            disabled: addDefinitionInCurrentFileDisabled
        }];
    }

    private async getFunctionDefinitionRefactorings(
        definition: CSymbol,
        sourceDoc: SourceDocument,
        matchingUri?: vscode.Uri
    ): Promise<vscode.CodeAction[]> {
        let moveDefinitionToMatchingSourceFileTitle = moveDefinitionTitle.matchingSourceFile;
        let moveDefinitionToMatchingSourceFileDisabled: { readonly reason: string } | undefined;
        let moveDefinitionIntoOrOutOfClassTitle = moveDefinitionTitle.intoOrOutOfClassPlaceholder;
        let moveDefinitionIntoOrOutOfClassDisabled: { readonly reason: string } | undefined;

        let declaration: CSymbol | undefined;
        let declarationDoc: SourceDocument | undefined;

        if (definition.parent?.isClassOrStruct()) {
            moveDefinitionIntoOrOutOfClassTitle = moveDefinitionTitle.outOfClass;
            declarationDoc = sourceDoc;
        } else {
            const declarationLocation = await definition.findDeclaration();
            if (declarationLocation !== undefined
                    && (declarationLocation?.uri.fsPath === definition.uri.fsPath
                    || declarationLocation?.uri.fsPath === matchingUri?.fsPath)) {
                declarationDoc = declarationLocation.uri.fsPath === sourceDoc.fileName
                        ? sourceDoc
                        : await SourceDocument.open(declarationLocation.uri);
                declaration = await declarationDoc.getSymbol(declarationLocation.range.start);

                if (declaration?.parent?.kind === vscode.SymbolKind.Class) {
                    moveDefinitionIntoOrOutOfClassTitle = `Move Definition into class "${declaration.parent.name}"`;
                } else if (declaration?.parent?.kind === vscode.SymbolKind.Struct) {
                    moveDefinitionIntoOrOutOfClassTitle = `Move Definition into struct "${declaration.parent.name}"`;
                } else {
                    moveDefinitionIntoOrOutOfClassDisabled = { reason: moveDefinitionFailure.notMemberFunction };
                }
            }
        }

        if (sourceDoc.languageId !== 'cpp') {
            moveDefinitionIntoOrOutOfClassDisabled = { reason: moveDefinitionFailure.notCpp };
        } else if (definition.isInline()) {
            moveDefinitionToMatchingSourceFileDisabled = { reason: moveDefinitionFailure.isInline };
        } else if (definition.isConstexpr()) {
            moveDefinitionToMatchingSourceFileDisabled = { reason: moveDefinitionFailure.isConstexpr };
        }

        if (matchingUri) {
            const displayPath = this.formatPathToDisplay(matchingUri);
            moveDefinitionToMatchingSourceFileTitle = `Move Definition to "${displayPath}"`;
        } else {
            moveDefinitionToMatchingSourceFileDisabled = { reason: moveDefinitionFailure.noMatchingSourceFile };
        }

        return [{
            title: moveDefinitionToMatchingSourceFileTitle,
            kind: vscode.CodeActionKind.Refactor,
            command: {
                title: moveDefinitionToMatchingSourceFileTitle,
                command: 'cmantic.moveDefinitionToMatchingSourceFile',
                arguments: [definition, matchingUri, declaration]
            },
            disabled: moveDefinitionToMatchingSourceFileDisabled
        }, {
            title: moveDefinitionIntoOrOutOfClassTitle,
            kind: vscode.CodeActionKind.Refactor,
            command: {
                title: moveDefinitionIntoOrOutOfClassTitle,
                command: 'cmantic.moveDefinitionIntoOrOutOfClass',
                arguments: [definition, declarationDoc, declaration]
            },
            disabled: moveDefinitionIntoOrOutOfClassDisabled
        }];
    }

    private async getMemberVariableRefactorings(
        symbol: CSymbol,
        sourceDoc: SourceDocument
    ): Promise<vscode.CodeAction[]> {
        let generateGetterSetterDisabled: { readonly reason: string } | undefined;
        let generateGetterDisabled: { readonly reason: string } | undefined;
        let generateSetterDisabled: { readonly reason: string } | undefined;

        if (sourceDoc.languageId !== 'cpp') {
            generateGetterSetterDisabled = { reason: getterSetterFailure.notCpp };
            generateGetterDisabled = { reason: getterSetterFailure.notCpp };
            generateSetterDisabled = { reason: getterSetterFailure.notCpp };
        } else {
            const getter = symbol.parent?.findGetterFor(symbol);
            const setter = symbol.parent?.findSetterFor(symbol);

            generateGetterSetterDisabled = (getter || setter) ? { reason: getterSetterFailure.getterOrSetterExists } : undefined;
            generateGetterDisabled = getter ? { reason: getterSetterFailure.getterExists } : undefined;
            generateSetterDisabled = setter ? { reason: getterSetterFailure.setterExists } : undefined;

            if (symbol.isConst()) {
                generateGetterSetterDisabled = { reason: getterSetterFailure.isConst };
                generateSetterDisabled = { reason: getterSetterFailure.isConst };
            }
        }

        return [{
            title: getterSetterTitle.getterSetter,
            kind: vscode.CodeActionKind.Refactor,
            command: {
                title: getterSetterTitle.getterSetter,
                command: 'cmantic.generateGetterSetterFor',
                arguments: [symbol, sourceDoc]
            },
            disabled: generateGetterSetterDisabled
        }, {
            title: getterSetterTitle.getter,
            kind: vscode.CodeActionKind.Refactor,
            command: {
                title: getterSetterTitle.getter,
                command: 'cmantic.generateGetterFor',
                arguments: [symbol, sourceDoc]
            },
            disabled: generateGetterDisabled
        }, {
            title: getterSetterTitle.setter,
            kind: vscode.CodeActionKind.Refactor,
            command: {
                title: getterSetterTitle.setter,
                command: 'cmantic.generateSetterFor',
                arguments: [symbol, sourceDoc]
            },
            disabled: generateSetterDisabled
        }];
    }

    private async getSourceActions(
        sourceDoc: SourceDocument,
        matchingUri?: vscode.Uri
    ): Promise<vscode.CodeAction[]> {
        let createMatchingSourceFileDisabled: { readonly reason: string } | undefined;
        let addHeaderGuardDisabled: { readonly reason: string } | undefined;

        if (!sourceDoc.isHeader()) {
            createMatchingSourceFileDisabled = { reason: createSourceFileFailure.notHeaderFile };
            addHeaderGuardDisabled = { reason: addHeaderGuardFailure.notHeaderFile };
        } else if (matchingUri) {
            createMatchingSourceFileDisabled = { reason: createSourceFileFailure.sourceFileExists };
        }
        if (sourceDoc.hasHeaderGuard()) {
            addHeaderGuardDisabled = { reason: addHeaderGuardFailure.headerGuardExists };
        }

        return [{
            title: 'Add Header Guard',
            kind: vscode.CodeActionKind.Source,
            command: {
                title: 'Add Header Guard',
                command: 'cmantic.addHeaderGuard'
            },
            disabled: addHeaderGuardDisabled
        }, {
            title: 'Add Include',
            kind: vscode.CodeActionKind.Source,
            command: {
                title: 'Add Include',
                command: 'cmantic.addInclude'
            }
        }, {
            title: 'Create Matching Source File',
            kind: vscode.CodeActionKind.Source,
            command: {
                title: 'Create Matching Source File',
                command: 'cmantic.createMatchingSourceFile'
            },
            disabled: createMatchingSourceFileDisabled
        }];
    }

    private formatPathToDisplay(uri: vscode.Uri): string
    {
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        // Arbitrary limit, as to not display a path that's running all the way across the screen.
        if (relativePath.length > 60) {
            const length = relativePath.length;
            return relativePath.substring(0, 28) + '....' + relativePath.substring(length - 28, length);
        }
        return relativePath;
    }
}
