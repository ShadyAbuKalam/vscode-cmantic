import * as vscode from 'vscode';
import * as cfg from './configuration';
import * as util from './utility';
import Logger from './Logger';
import HeaderSourceCache from './HeaderSourceCache';
import { addDefinition, addDefinitionInSourceFile, addDefinitionInCurrentFile } from './addDefinition';
import { addDeclaration } from './addDeclaration';
import { moveDefinitionToMatchingSourceFile, moveDefinitionIntoOrOutOfClass } from './moveDefinition';
import {
    generateGetterSetter, generateGetter, generateSetter,
    generateGetterSetterFor, generateGetterFor, generateSetterFor
} from './generateGetterSetter';
import { generateEqualityOperators } from './generateEqualityOperators';
import { switchHeaderSourceInWorkspace } from './switchHeaderSource';
import { createMatchingSourceFile } from './createSourceFile';
import { addInclude } from './addInclude';
import { addHeaderGuard } from './addHeaderGuard';
import { CodeActionProvider } from './codeActions';


export const extensionId = 'tdennis4496.cmantic';

export const logger = new Logger('C-mantic');

const disposables: vscode.Disposable[] = [logger];
const codeActionProvider = new CodeActionProvider();
const headerSourceCache = new HeaderSourceCache();

export function activate(context: vscode.ExtensionContext): void {
    registerCommands(context);
    registerCodeActionProvider(context);
    registerEventListeners();
    logActivation(context);
    cacheOpenDocuments();
}

export function deactivate(): void {
    disposables.forEach(disposable => disposable.dispose());
}

export function getMatchingHeaderSource(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    return headerSourceCache.get(uri);
}

export const commands = {
    'cmantic.addDefinitionInSourceFile': addDefinitionInSourceFile,
    'cmantic.addDefinitionInCurrentFile': addDefinitionInCurrentFile,
    'cmantic.addDefinition': addDefinition,
    'cmantic.addDeclaration': addDeclaration,
    'cmantic.moveDefinitionToMatchingSourceFile': moveDefinitionToMatchingSourceFile,
    'cmantic.moveDefinitionIntoOrOutOfClass': moveDefinitionIntoOrOutOfClass,
    'cmantic.generateGetterSetter': generateGetterSetter,
    'cmantic.generateGetter': generateGetter,
    'cmantic.generateSetter': generateSetter,
    'cmantic.generateGetterSetterFor': generateGetterSetterFor,
    'cmantic.generateGetterFor': generateGetterFor,
    'cmantic.generateSetterFor': generateSetterFor,
    'cmantic.generateEqualityOperators': generateEqualityOperators,
    'cmantic.createMatchingSourceFile': createMatchingSourceFile,
    'cmantic.addHeaderGuard': addHeaderGuard,
    'cmantic.addInclude': addInclude,
    'cmantic.switchHeaderSourceInWorkspace': switchHeaderSourceInWorkspace
};

function registerCommands(context: vscode.ExtensionContext): void {
    Object.entries(commands).forEach(([command, handler]) => {
        context.subscriptions.push(vscode.commands.registerCommand(command, handler));
    });
}

function registerCodeActionProvider(context: vscode.ExtensionContext): void {
    const documentSelector: vscode.DocumentSelector = [
        { scheme: 'file', language: 'c' },
        { scheme: 'file', language: 'cpp' }
    ];

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            documentSelector,
            codeActionProvider,
            codeActionProvider.metadata
        )
    );
}

function registerEventListeners(): void {
    disposables.push(vscode.workspace.onDidOpenTextDocument(onDidOpenTextDocument));
    disposables.push(vscode.workspace.onDidCloseTextDocument(onDidCloseTextDocument));
    disposables.push(vscode.workspace.onDidCreateFiles(onDidCreateFiles));
    disposables.push(vscode.workspace.onDidChangeConfiguration(onDidChangeConfiguration));
}

function logActivation(context: vscode.ExtensionContext): void {
    logger.logInfo('C-mantic extension activated.');
    showMessageOnFeatureUpdate(context);
}

async function cacheOpenDocuments(): Promise<void> {
    const p_cached: Promise<void>[] = [];
    vscode.workspace.textDocuments.forEach(document => p_cached.push(onDidOpenTextDocument(document)));
    await Promise.all(p_cached);
}

async function onDidOpenTextDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.scheme === 'file' && (document.languageId === 'c' || document.languageId === 'cpp')) {
        return headerSourceCache.add(document.uri);
    }
}

function onDidCloseTextDocument(document: vscode.TextDocument): void {
    if (document.uri.scheme === 'file' && (document.languageId === 'c' || document.languageId === 'cpp')) {
        headerSourceCache.delete(document.uri);
    }
}

async function onDidCreateFiles(event: vscode.FileCreateEvent): Promise<void> {
    const p_cached: Promise<void>[] = [];
    event.files.forEach(uri => {
        const ext = util.fileExtension(uri.fsPath);
        if (uri.scheme === 'file' && (cfg.sourceExtensions().includes(ext) || cfg.headerExtensions().includes(ext))) {
            p_cached.push(headerSourceCache.add(uri));
        }
    });
    await Promise.all(p_cached);
}

function onDidChangeConfiguration(event: vscode.ConfigurationChangeEvent): void {
    if (event.affectsConfiguration(cfg.baseConfigurationKey)) {
        codeActionProvider.addDefinitionEnabled = cfg.enableAddDefinition();
        codeActionProvider.addDeclarationEnabled = cfg.enableAddDeclaration();
        codeActionProvider.moveDefinitionEnabled = cfg.enableMoveDefinition();
        codeActionProvider.generateGetterSetterEnabled = cfg.enableGenerateGetterSetter();
    }
}

const re_semver = /^\d+\.\d+\.\d+$/;
const versionKey = 'version';
const updateMessage =
        'C-mantic v0.6.0: Added \'Add Declaration\' command and more options for generating header guards.';
const readmeButton = 'Open README';
const changelogButton = 'Open CHANGELOG';
const readmeUri = vscode.Uri.parse('https://github.com/BigBahss/vscode-cmantic/blob/master/README.md');
const changelogUri = vscode.Uri.parse('https://github.com/BigBahss/vscode-cmantic/blob/master/CHANGELOG.md');

async function showMessageOnFeatureUpdate(context: vscode.ExtensionContext): Promise<void> {
	const currentVersion = vscode.extensions.getExtension(extensionId)?.packageJSON?.version;
    if (typeof currentVersion !== 'string' || !re_semver.test(currentVersion)) {
        return;
    }

    const previousVersion = context.globalState.get<string>(versionKey);
    context.globalState.update(versionKey, currentVersion);

    const [,currentMinor,] = currentVersion.split('.');
    if (previousVersion !== undefined && re_semver.test(previousVersion)) {
        const [,previousMinor,] = previousVersion.split('.');
        if (+previousMinor >= +currentMinor) {
            return;
        }
    }

    const selected = await vscode.window.showInformationMessage(updateMessage, readmeButton, changelogButton);
    if (selected === readmeButton) {
        vscode.env.openExternal(readmeUri);
    } else if (selected === changelogButton) {
        vscode.env.openExternal(changelogUri);
    }
}
