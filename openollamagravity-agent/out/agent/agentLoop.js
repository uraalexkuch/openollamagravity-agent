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
exports.AgentLoop = void 0;
// Copyright (c) 2026 Юрій Кучеренко.
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const client_1 = require("../ollama/client");
const Tools = __importStar(require("./tools"));
function buildSystemPrompt(language, skills, workspaceContext, workspacePath, workspaceRoot) {
    const skillsBlock = skills.length === 0 ? '' : `\n\n### SKILLS:\n` + skills.map(s => `#### ${s.name}\n${s.content}`).join('\n');
    const wsBlock = workspaceContext ? `\n\n### WORKSPACE CONTEXT:\n${workspaceContext}` : '';
    const rootPath = workspaceRoot || workspacePath;
    const rootBlock = rootPath ? `\n\n### WORKSPACE ROOT: ${rootPath}\nCross-project access: Use absolute paths to access any files on this computer.` : '';
    return `
### MISSION:
You are an expert AI software engineer. Complete the task efficiently using the tools below.

### CRITICAL CONSTRAINTS (READ CAREFULLY):
1. XML Format ONLY: You MUST wrap every tool call inside <tool_call> tags. NEVER write tool calls as plain text or javascript functions.
2. Example of a CORRECT tool call for reading/listing:
<tool_call>
<name>list_files</name>
<args>{"path": ".", "depth": 1}</args>
</tool_call>

Example of a CORRECT tool call for writing/editing (use <content>):
<tool_call>
<name>write_file</name>
<args>{"path": "docs/README.md"}</args>
<content>
# Documentation
Put your multi-line content here without escaping quotes or newlines.
</content>
</tool_call>

3. Language & Translation: The user may provide tasks in various languages. You MUST internally translate the user's request into English to plan your actions and use tools accurately. However, you MUST ALWAYS provide your final explanations, narrations, and direct answers to the user in ${language}.
4. Windows Paths: Use double backslashes in JSON args: "C:\\\\path\\\\to\\\\file".
5. Workflow: TRANSLATE REQUEST TO ENGLISH -> THINK -> CALL TOOL -> GET RESULT -> CONTINUE until done.
6. NO HALLUCINATIONS: Base your answers STRICTLY on the facts obtained through tools. DO NOT guess, assume, or invent file contents, dependencies, code snippets, or project architecture.
7. FACT-BASED ANALYSIS: If asked to analyze or explain a project, you MUST use tools to read the actual project files (package.json, source code) BEFORE generating a response. Talk ONLY about the specific technologies and code present in this repository.

### TOOLS:
- manage_plan(action, task?, id?): Manage your multi-step plan.
- delegate_to_expert(role, question, context?): Spawn an isolated AI sub-agent.
- run_chatdev_team(task, output_dir): Orchestrate a virtual software company (CTO -> Programmer -> Reviewer -> TechWriter).
- save_skill(name, description): Save a new reusable skill.
- read_file(path, start_line?, end_line?): Read file content.
- write_file(path): Create/Overwrite file. Use <content> block for the body.
- edit_file(path, start_line, end_line): Replace lines. Use <content> block for the new text.
- list_files(path?, depth?): List directories.
- search_files(pattern, path?): Grep-like search.
- run_terminal(command, cwd?): Run shell commands.
- get_diagnostics(path?): Get IDE errors.
- get_file_outline(path): List functions/classes in a file.
- create_directory(path): Create folders.
- delete_file(path): Delete file.
- get_workspace_info(path?): Project metadata (deps, scripts).
- web_search(query, website?): Internet search.
- list_skills(), read_skill(name): View best practices.
${skillsBlock}${wsBlock}${rootBlock}`.trim();
}
function repairJson(raw) {
    let result = raw.replace(/([{,]\s*)(['"]?)([a-zA-Z0-9_$-]+)\2\s*:/g, '$1"$3":');
    result = result.replace(/:\s*'([^']*)'/g, (_, inner) => ': "' + inner.replace(/"/g, '\\"') + '"');
    result = result.replace(/,\s*'([^']*)'/g, (_, inner) => ', "' + inner.replace(/"/g, '\\"') + '"');
    let finalResult = '';
    let inString = false;
    let i = 0;
    while (i < result.length) {
        const ch = result[i];
        if (!inString) {
            if (ch === '"') {
                inString = true;
            }
            finalResult += ch;
            i++;
            continue;
        }
        if (ch === '\n') {
            finalResult += '\\n';
            i++;
            continue;
        }
        if (ch === '\r') {
            i++;
            continue;
        }
        if (ch === '\t') {
            finalResult += '\\t';
            i++;
            continue;
        }
        if (ch === '\\') {
            const next = result[i + 1] ?? '';
            if (/["\\\/bfnrtu]/.test(next))
                finalResult += ch + next;
            else
                finalResult += '\\\\' + next;
            i += 2;
            continue;
        }
        if (ch === '"') {
            inString = false;
        }
        finalResult += ch;
        i++;
    }
    return finalResult;
}
function parseToolCall(text) {
    const block = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
    if (!block)
        return null;
    const blockStart = text.indexOf('<tool_call>');
    const narration = text.slice(0, blockStart).trim();
    const inner = block[1];
    const nameMatch = inner.match(/<n>\s*([\w_]+)\s*<\/n>/i) || inner.match(/<name>\s*([\w_]+)\s*<\/name>/i);
    if (!nameMatch)
        return null;
    const name = nameMatch[1].trim();
    const contentMatch = inner.match(/<content>([\s\S]*?)<\/content>/i) || inner.match(/<content>([\s\S]*)/i);
    const extractedContent = contentMatch ? contentMatch[1].trim() : null;
    let raw = '';
    const argsMatch = inner.match(/<args>([\s\S]*?)<\/args>/i);
    if (argsMatch) {
        raw = argsMatch[1].trim();
    }
    else {
        const fallbackMatch = inner.match(/<args>([\s\S]*)/i);
        if (fallbackMatch) {
            raw = fallbackMatch[1].trim().replace(/<content>[\s\S]*/i, '').trim();
        }
        else {
            raw = '{}';
        }
    }
    let args = {};
    if (raw && raw !== '{}') {
        raw = raw.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
        try {
            args = JSON.parse(raw);
        }
        catch {
            try {
                args = JSON.parse(repairJson(raw));
            }
            catch (e) {
                return { name, narration, args: {}, parseError: e.message };
            }
        }
    }
    if (extractedContent !== null) {
        if (name === 'write_file' || name === 'save_skill')
            args.content = extractedContent;
        else if (name === 'edit_file')
            args.new_content = extractedContent;
    }
    return { name, narration, args };
}
class AgentLoop {
    constructor(_ollama) {
        this._ollama = _ollama;
        this._history = [];
        this._listeners = [];
        this._loadedFolders = new Set();
        this._planState = { currentPlan: [], planIdCounter: 0 };
        this.running = false;
    }
    on(fn) { this._listeners.push(fn); }
    off(fn) { this._listeners = this._listeners.filter(l => l !== fn); }
    emit(ev) { this._listeners.forEach(l => l(ev)); }
    stop() { this._abortCtrl?.abort(); this.running = false; }
    clearHistory() {
        this._history = [];
        this._loadedFolders.clear();
        this._planState = { currentPlan: [], planIdCounter: 0 };
    }
    async run(task, contextMessages = [], workspaceContext = '', language = 'Ukrainian', workspaceRoot = '', selectedSkillFolders = []) {
        this.running = true;
        try {
            this._abortCtrl = new AbortController();
            const signal = this._abortCtrl.signal;
            const config = vscode.workspace.getConfiguration('openollamagravity');
            const maxSteps = config.get('maxAgentSteps', 50);
            const timeoutMs = config.get('firstTokenTimeoutSec', 300) * 1000;
            const resolvedRoot = workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            let loadedSkills = [];
            if (this._history.length === 0) {
                const taskContext = [task, workspaceContext, resolvedRoot].filter(Boolean).join('\n');
                if (selectedSkillFolders.length > 0) {
                    const allScored = Tools.scanAndScoreAllSkillsIdf(taskContext, new Set(), 0);
                    const toLoad = allScored.filter(s => selectedSkillFolders.includes(s.folderName));
                    loadedSkills = Tools.loadTopSkills(toLoad, 20);
                }
                const sysPrompt = buildSystemPrompt(language, loadedSkills, workspaceContext, resolvedRoot, resolvedRoot);
                this._history.push({ role: 'system', content: sysPrompt });
                if (contextMessages.length > 0)
                    this._history.push(...contextMessages);
            }
            this._history.push({ role: 'user', content: task });
            for (let step = 1; step <= maxSteps; step++) {
                if (signal.aborted)
                    break;
                this.emit({ type: 'step', content: '', step, totalSteps: maxSteps });
                const output = await this._streamWithTimeout(step, maxSteps, timeoutMs, signal);
                const tool = parseToolCall(output);
                if (!tool) {
                    this.emit({ type: 'answer', content: output });
                    break;
                }
                if (tool.narration)
                    this.emit({ type: 'narration', content: tool.narration });
                if (tool.parseError) {
                    const errMsg = `TOOL CALL FAILED — JSON error: ${tool.parseError}. Use <content> for files!`;
                    this.emit({ type: 'tool_result', content: errMsg, toolName: tool.name, ok: false });
                    this._history.push({ role: 'assistant', content: output });
                    this._history.push({ role: 'user', content: `<tool_result>\n<name>${tool.name}</name>\n<ok>false</ok>\n<output>${errMsg}</output>\n</tool_result>` });
                    continue;
                }
                this.emit({ type: 'tool_call', content: `Calling: ${tool.name}`, toolName: tool.name, toolArgs: tool.args });
                const res = await this._executeTool(tool.name, tool.args, loadedSkills);
                this.emit({ type: 'tool_result', content: res.output, toolName: tool.name, ok: res.ok });
                this._history.push({ role: 'assistant', content: output });
                this._history.push({ role: 'user', content: `<tool_result>\n<name>${tool.name}</name>\n<ok>${res.ok}</ok>\n<output>${res.output}</output>\n</tool_result>` });
                this._trimHistory();
            }
        }
        finally {
            this.running = false;
            this.emit({ type: 'done', content: '' });
        }
    }
    _trimHistory() {
        if (this._history.length > 22) {
            const sys = this._history[0];
            const recent = this._history.slice(-20);
            this._history = [sys, ...recent];
        }
    }
    async _streamWithTimeout(step, total, initialMs, signal) {
        return new Promise((resolve, reject) => {
            let started = false;
            const timer = setTimeout(() => { if (!started)
                reject(new Error('Ollama timeout')); }, initialMs);
            this._ollama.chatStream(this._history, chunk => {
                started = true;
                clearTimeout(timer);
                this.emit({ type: 'thinking', content: chunk, step, totalSteps: total });
            }, signal, this.model).then(resolve).catch(reject);
        });
    }
    async _executeTool(name, args, loadedSkills = []) {
        const confirm = async (msg) => (await vscode.window.showWarningMessage(`OOG: ${msg}`, 'Allow', 'Deny')) === 'Allow';
        switch (name) {
            case 'read_file': return Tools.readFile(args);
            case 'write_file': return Tools.writeFile(args, p => confirm(`Записати у ${p}`));
            case 'edit_file': return Tools.editFile(args, (p, _d) => confirm(`Редагувати ${p}`));
            case 'list_files': return Tools.listFiles(args);
            case 'search_files': return Tools.searchFiles(args);
            case 'run_terminal': return Tools.runTerminal(args, c => confirm(`Запустити: ${c}`));
            case 'get_diagnostics': return Tools.getDiagnostics(args);
            case 'get_file_outline': return Tools.getFileOutline(args);
            case 'get_workspace_info': return Tools.getWorkspaceInfo(args);
            case 'manage_plan': return Tools.managePlan(args, this._planState);
            // ─────────────────────────────────────────────────────────────
            case 'run_chatdev_team': {
                if (!args.task || !args.output_dir) {
                    return { ok: false, output: 'Missing task or output_dir' };
                }
                if (!await confirm(`Запустити ChatDev у "${args.output_dir}"?`)) {
                    return { ok: false, output: 'Cancelled' };
                }
                // Skills block shared by all sub-agents
                const skillsBlock = loadedSkills.length > 0
                    ? `\n\n### PROJECT SKILLS:\n` + loadedSkills.map(s => `#### ${s.name}\n${s.content}`).join('\n')
                    : '';
                // Shared memory accumulates context so every agent sees previous files
                let sharedMemory = `### BUILT CONTEXT:\n`;
                let report = `🏢 ChatDev Report:\n`;
                const { signal } = this._abortCtrl;
                // ── PHASE 1: CTO ──────────────────────────────────────────
                this.emit({ type: 'narration', content: `🧠 CTO: Проектую архітектуру...` });
                const ctoPrompt = `You are the CTO of a software company. Your task: "${args.task}".` +
                    skillsBlock +
                    `\n\nOutput ONLY a single valid JSON object — no prose, no markdown fences:\n` +
                    `{"dependencies": "npm install ...", "files": [{"filename": "...", "description": "..."}]}`;
                try {
                    let ctoRes = await this._ollama.generate(ctoPrompt, 2048, this.model);
                    // Markdown cleaning
                    ctoRes = ctoRes
                        .replace(/^```json\s*/i, '')
                        .replace(/^```\s*/i, '')
                        .replace(/\s*```$/g, '')
                        .trim();
                    // Robust JSON parsing: extract first {...} block even if the model
                    // wrapped it in explanatory text
                    const ctoJsonMatch = ctoRes.match(/\{[\s\S]*\}/);
                    if (!ctoJsonMatch)
                        throw new Error('CTO did not return valid JSON');
                    const ctoJson = JSON.parse(repairJson(ctoJsonMatch[0]));
                    const deps = ctoJson.dependencies || '';
                    const files = ctoJson.files || [];
                    report += `\n📐 Architecture: ${files.length} files planned\n`;
                    sharedMemory += `CTO designed ${files.length} files: ${files.map(f => f.filename).join(', ')}\n`;
                    this.emit({ type: 'narration', content: `📐 CTO спроектував: ${files.map(f => f.filename).join(', ')}` });
                    // ── PHASE 2: Install dependencies ───────────────────────
                    if (deps) {
                        this.emit({ type: 'narration', content: `📦 Встановлення залежностей...` });
                        const installRes = await Tools.runTerminal({ command: deps, cwd: args.output_dir }, async () => true);
                        report += `\n📦 Install: ${installRes.ok ? 'OK' : installRes.output.slice(0, 100)}\n`;
                    }
                    // ── PHASE 3: Create output directory ────────────────────
                    await Tools.createDirectory({ path: args.output_dir });
                    // ── PHASE 4 + 5: Programmer → Reviewer (per file) ───────
                    for (const file of files) {
                        if (signal.aborted)
                            break;
                        // — Programmer —
                        this.emit({ type: 'narration', content: `👨‍💻 Programmer: пишу ${file.filename}...` });
                        const programmerPrompt = `You are an expert Programmer in a software company.\n` +
                            skillsBlock +
                            `\n\n### TASK:\n${args.task}` +
                            `\n\n### ARCHITECTURE (from CTO):` +
                            `\nFile to implement: "${file.filename}"` +
                            `\nDescription: "${file.description}"` +
                            `\n\n### SHARED MEMORY (already built):\n${sharedMemory}` +
                            `\n\n### INSTRUCTIONS:` +
                            `\n- Write COMPLETE, production-ready code for "${file.filename}".` +
                            `\n- Output ONLY the raw file content. No markdown fences, no explanations.` +
                            `\n- Follow all skills and best practices listed above strictly.`;
                        let code = await this._ollama.generate(programmerPrompt, 4096, this.model);
                        // Markdown cleaning
                        code = code.replace(/^```[\w]*\n?/gm, '').replace(/```\s*$/gm, '').trim();
                        // — Reviewer —
                        this.emit({ type: 'narration', content: `🔍 Reviewer: перевіряю ${file.filename}...` });
                        const reviewerPrompt = `You are a senior Code Reviewer in a software company.\n` +
                            skillsBlock +
                            `\n\n### TASK:\n${args.task}` +
                            `\n\n### FILE TO REVIEW: ${file.filename}\n\`\`\`\n${code}\n\`\`\`` +
                            `\n\n### SHARED MEMORY:\n${sharedMemory}` +
                            `\n\n### INSTRUCTIONS:` +
                            `\n- Line 1 MUST be exactly APPROVED or FIXED (all caps).` +
                            `\n- If code is correct, write APPROVED on line 1, then the full code from line 2.` +
                            `\n- If there are bugs, fix them, write FIXED on line 1, then the corrected code from line 2.` +
                            `\n- No markdown fences, no extra commentary.`;
                        let reviewRes = await this._ollama.generate(reviewerPrompt, 4096, this.model);
                        // Markdown cleaning
                        reviewRes = reviewRes.replace(/^```[\w]*\n?/gm, '').replace(/```\s*$/gm, '').trim();
                        const lines = reviewRes.split('\n');
                        const verdict = lines[0].trim().toUpperCase();
                        let finalCode = (verdict === 'APPROVED' || verdict === 'FIXED')
                            ? lines.slice(1).join('\n').trim()
                            : reviewRes; // fallback: model ignored the protocol
                        // Final markdown cleaning
                        finalCode = finalCode.replace(/^```[\w]*\n?/gm, '').replace(/```\s*$/gm, '').trim();
                        // Write file
                        const filePath = path.join(args.output_dir, file.filename);
                        const writeRes = await Tools.writeFile({ path: filePath, content: finalCode }, async () => true);
                        const icon = verdict === 'FIXED' ? '🔧' : '✅';
                        report += `\n${icon} ${file.filename}: ${writeRes.ok ? (verdict || 'OK') : 'WRITE ERROR'}`;
                        this.emit({
                            type: 'tool_result',
                            content: `Записано: ${file.filename} [${verdict}]`,
                            toolName: 'write_file',
                            ok: writeRes.ok,
                        });
                        // Append to shared memory (truncated to keep prompts manageable)
                        const snippet = finalCode.length > 1200
                            ? finalCode.slice(0, 1200) + '\n... (truncated)'
                            : finalCode;
                        sharedMemory += `\n\n### FILE: ${file.filename}\n\`\`\`\n${snippet}\n\`\`\``;
                    }
                    // ── PHASE 6: TechWriter — README ────────────────────────
                    if (!signal.aborted) {
                        this.emit({ type: 'narration', content: `📝 TechWriter: генерую README...` });
                        const twPrompt = `You are a Technical Writer in a software company.\n` +
                            skillsBlock +
                            `\n\n### TASK:\n${args.task}` +
                            `\n\n### PROJECT FILES BUILT:\n` +
                            files.map(f => `- ${f.filename}: ${f.description}`).join('\n') +
                            `\n\n### SHARED MEMORY:\n${sharedMemory}` +
                            `\n\nWrite a clear, professional README.md for this project.` +
                            `\nInclude: project title, description, installation, usage, file structure.` +
                            `\nOutput ONLY raw Markdown. No extra commentary.`;
                        let readme = await this._ollama.generate(twPrompt, 2048, this.model);
                        readme = readme.replace(/^```[\w]*\n?/gm, '').replace(/```\s*$/gm, '').trim();
                        const readmePath = path.join(args.output_dir, 'README.md');
                        await Tools.writeFile({ path: readmePath, content: readme }, async () => true);
                        report += `\n📄 README.md: OK`;
                    }
                    report += `\n\n✅ ChatDev завершив роботу у: ${args.output_dir}`;
                    return { ok: true, output: report };
                }
                catch (e) {
                    client_1.oogLogger.appendLine(`[ChatDev error] ${e?.message ?? e}`);
                    return { ok: false, output: `ChatDev failed: ${e.message}` };
                }
            }
            // ─────────────────────────────────────────────────────────────
            case 'delegate_to_expert': {
                if (!args.role || !args.question) {
                    return { ok: false, output: 'Missing role or question' };
                }
                // Skills are forwarded to delegated experts as well
                const expertSkillsBlock = loadedSkills.length > 0
                    ? `\n\n### PROJECT SKILLS:\n` + loadedSkills.map(s => `#### ${s.name}\n${s.content}`).join('\n')
                    : '';
                const expertPrompt = `You are ${args.role}. Answer the following question thoroughly and precisely.` +
                    expertSkillsBlock +
                    (args.context ? `\n\n### CONTEXT:\n${args.context}` : '') +
                    `\n\n### QUESTION:\n${args.question}` +
                    `\n\nProvide a complete, actionable answer. Base your response strictly on facts.`;
                try {
                    this.emit({ type: 'narration', content: `🤝 Делегую до: ${args.role}` });
                    const expertAnswer = await this._ollama.generate(expertPrompt, 3000, this.model);
                    return { ok: true, output: expertAnswer.trim() };
                }
                catch (e) {
                    return { ok: false, output: `Expert delegation failed: ${e.message}` };
                }
            }
            // ─────────────────────────────────────────────────────────────
            case 'save_skill': {
                if (!args.name || !args.content)
                    return { ok: false, output: 'Missing name or content' };
                return Tools.saveSkill(args.name, args.content);
            }
            case 'list_skills': {
                return Tools.listSkills();
            }
            case 'read_skill': {
                if (!args.name)
                    return { ok: false, output: 'Missing skill name' };
                return Tools.readSkill(args);
            }
            case 'web_search': {
                if (!args.query)
                    return { ok: false, output: 'Missing query' };
                return Tools.webSearch(args);
            }
            case 'create_directory': {
                return Tools.createDirectory(args);
            }
            case 'delete_file': {
                const confirmed = await confirm(`Видалити файл: ${args.path}?`);
                if (!confirmed)
                    return { ok: false, output: 'Cancelled by user' };
                return Tools.deleteFile(args, async () => true);
            }
            default:
                return { ok: false, output: `Unknown tool: "${name}". Check the tool list in the system prompt.` };
        }
    }
}
exports.AgentLoop = AgentLoop;
