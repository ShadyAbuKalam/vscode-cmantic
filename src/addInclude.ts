import * as vscode from 'vscode';
import * as cfg from './configuration';
import * as util from './utility';
import * as c from './cmantics';


export async function addInclude(): Promise<void>
{
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('You must have a text editor open.');
        return;
    }

    const userInput = vscode.window.showInputBox({ value: '#include ', valueSelection: [9, 9] });

    const sourceFile = new c.SourceFile(editor.document);
    const newIncludePosition = await sourceFile.findPositionForNewInclude();
    const eol = util.endOfLine(sourceFile.document);

    userInput.then(value => {
        if (value?.trim().match(/^#include\s*<.+>/)) {
            editor.edit(edit => edit.insert(newIncludePosition.system, value + eol));
        } else if (value?.trim().match(/^#include\s*".+"/)) {
            editor.edit(edit => edit.insert(newIncludePosition.project, value + eol));
        } else if (value) {
            vscode.window.showWarningMessage('This doesn\'t seem to be a valid include statement. It wasn\'t added.');
        }
    });
}
