import * as vscode from 'vscode';
import * as cfg from './configuration';
import * as path from 'path';
import { SourceDocument } from './SourceDocument';
import { logger } from './logger';


export const failure = {
    noActiveTextEditor: 'No active text editor detected.',
    notHeaderFile: 'This file is not a header file.',
    headerGuardExists: 'A header guard already exists.'
};


export async function addHeaderGuard(): Promise<void>
{
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        logger.showErrorMessage(failure.noActiveTextEditor);
        return;
    }
    const fileName = path.basename(activeEditor.document.fileName);
    const headerDoc = new SourceDocument(activeEditor.document);
    if (!headerDoc.isHeader()) {
        logger.showWarningMessage(failure.notHeaderFile);
        return;
    } else if (headerDoc.hasHeaderGuard()) {
        logger.showInformationMessage(failure.headerGuardExists);
        return;
    }

    const headerGuardPosition = headerDoc.positionAfterHeaderComment();
    const eol = headerDoc.endOfLine;

    let header = '';
    let footer = '';
    const headerGuardKind = cfg.headerGuardStyle();

    if (headerGuardKind === cfg.HeaderGuardStyle.PragmaOnce || headerGuardKind === cfg.HeaderGuardStyle.Both) {
        header = '#pragma once' + eol;
    }

    if (headerGuardKind === cfg.HeaderGuardStyle.Define || headerGuardKind === cfg.HeaderGuardStyle.Both) {
        const headerGuardDefine = cfg.headerGuardDefine(fileName);
        header += '#ifndef ' + headerGuardDefine + eol + '#define ' + headerGuardDefine + eol;
        footer = eol + '#endif // ' + headerGuardDefine + eol;
    }

    const footerPosition = headerDoc.lineAt(headerDoc.lineCount - 1).range.end;

    if (headerGuardPosition.options.after) {
        header = eol + eol + header;
    } else if (headerGuardPosition.options.before) {
        header += eol;
    }
    if (headerDoc.getText(new vscode.Range(headerGuardPosition, footerPosition)).trim().length === 0) {
        header += eol;
    }
    if (footerPosition.line === headerGuardPosition.line) {
        footer = eol + footer;
    }

    await Promise.all([
        activeEditor.insertSnippet(
                new vscode.SnippetString(footer),
                footerPosition,
                { undoStopBefore: true, undoStopAfter: false }),
        activeEditor.insertSnippet(
                new vscode.SnippetString(header),
                headerGuardPosition,
                { undoStopBefore: false, undoStopAfter: true })
    ]);
}
