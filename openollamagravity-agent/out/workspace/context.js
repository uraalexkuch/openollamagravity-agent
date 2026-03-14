"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.gatherContext = gatherContext;
exports.getActiveFileContent = getActiveFileContent;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** Gather compact workspace context: project type, key files, open file, selection */
function gatherContext() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root)
        return '';
    const lines = [];
    // Project metadata
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            lines.push(`Project: ${pkg.name ?? 'unknown'} (${pkg.version ?? '?'})`);
            const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
            if (deps.length)
                lines.push(`Key deps: ${deps.slice(0, 12).join(', ')}`);
            if (pkg.scripts) {
                const scripts = Object.keys(pkg.scripts).slice(0, 8).join(', ');
                lines.push(`Scripts: ${scripts}`);
            }
        }
        catch { /* */ }
    }
    // Active file
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const rel = path.relative(root, editor.document.fileName);
        lines.push(`Active file: ${rel} (${editor.document.languageId})`);
        const sel = editor.selection;
        if (!sel.isEmpty) {
            const selText = editor.document.getText(sel);
            const preview = selText.slice(0, 400);
            lines.push(`Selected code:\n\`\`\`\n${preview}${selText.length > 400 ? '\n…' : ''}\n\`\`\``);
        }
    }
    return lines.join('\n');
}
/** Get currently open file content (capped at 200 lines) */
function getActiveFileContent() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
        return '';
    const doc = editor.document;
    const content = doc.getText();
    const lines = content.split('\n');
    const capped = lines.slice(0, 200);
    const suffix = lines.length > 200 ? `\n…(${lines.length - 200} more lines)` : '';
    return `\`\`\`${doc.languageId}\n${capped.join('\n')}${suffix}\n\`\`\``;
}
