# ⚡ OpenOllamaGravity — Full Coding Agent

**Автономний локальний ШІ-агент для програмування**, що працює на базі [Ollama](https://ollama.ai).
Планує. Читає файли. Пише код. Виконує команди. Ітерує. Повністю офлайн.

---

## Основні можливості

### 1. Автономний ШІ-агент (Agent Loop)
Агент працює у циклі, виконуючи завдання крок за кроком (до 25 кроків за замовчуванням). Він використовує XML-теги (`<tool_call>`) для виклику інструментів та має вбудований «розумний парсер», який автоматично виправляє синтаксичні помилки моделі у JSON-аргументах.

Агенту доступні такі інструменти (Tools):
* **Робота з файлами**: Читання (`read_file`), створення/перезапис (`write_file`), точкове редагування рядків (`edit_file`) та перегляд структури директорій (`list_files`).
* **Термінал**: Виконання дозволених shell-команд (наприклад, npm, git, tsc) із обов'язковим запитом на підтвердження від користувача.
* **Аналіз проєкту**: Отримання інформації про `package.json` та залежності (`get_workspace_info`), а також читання помилок/попереджень TypeScript чи ESLint (`get_diagnostics`).

### 2. Система «Скілів» (Skills System) та Auto-Matching
Проєкт має унікальну систему навчання агента на основі зовнішньої бази знань.
* **Синхронізація**: Розширення автоматично завантажує (через git clone / pull) репозиторій `openollamagravity-awesome-skills` у папку Documents на вашому комп'ютері.
* **Розумний підбір**: Коли ви ставите завдання, система аналізує ваші слова та шукає збіги з назвами `.md` файлів скілів. Якщо знайдено збіг (наприклад, ви згадали "react"), система непомітно додає `[SYSTEM HINT]`, змушуючи агента прочитати відповідний файл (через інструмент `read_skill`) перед написанням коду.

### 3. Автодоповнення коду (Inline Completions)
Проєкт надає ШІ-автодоповнення під час написання коду.
* Він використовує формат **FIM** (Fill-in-the-Middle) для сумісних моделей (CodeLlama, DeepSeek-Coder, Qwen-Coder), передаючи моделі як попередній код (prefix), так і код після курсора (suffix).
* Реалізовано систему затримки (debounce), щоб не перевантажувати Ollama при швидкому друкуванні.

### 4. Багатомовний та зручний інтерфейс (UI)
Взаємодія відбувається через зручну Webview-панель.
* **Мультимовність**: Інтерфейс підтримує українську, англійську, німецьку, іспанську та французьку мови.
* **Візуалізація процесу**: Ви бачите, коли агент «думає» (з анімацією пульсації), які інструменти він викликає та які результати отримує.
* **Керування моделями**: Можна перемикати моделі Ollama прямо з інтерфейсу або через Status Bar знизу.
* **Експорт**: Готові відповіді агента (наприклад, згенеровану документацію) можна зберегти як `.md` файл натисканням однієї кнопки 💾 Зберегти .md.

### 5. Оптимізація роботи з обладнанням
Щоб запобігти помилкам нестачі пам'яті (Out of Memory), клієнт Ollama динамічно вираховує розмір вікна контексту (`num_ctx`). Для сучасних моделей (Llama 3.2, Qwen, DeepSeek) він дозволяє контекст до 128k токенів, для простіших моделей — 8k або стандартні 4096 токенів, спираючись на жорсткий ліміт в налаштуваннях користувача. Також додано таймаут (`firstTokenTimeoutSec`) для переривання процесу, якщо модель зависла під час генерації першого токена.

---

## Setup

```bash
# 1. Install Ollama
# https://ollama.ai

# 2. Pull a coding model (pick one)
ollama pull deepseek-coder:6.7b   # recommended
ollama pull qwen2.5-coder:7b       # great alternative
ollama pull codellama              # classic
ollama pull llama3.2               # for explanations

# 3. Start Ollama
ollama serve
```

### Install the extension

```bash
unzip openollamagravity-agent.zip && cd openollamagravity-agent
npm install
npm run compile
# Press F5 in VSCode to launch dev mode

# Or build .vsix:
npx @vscode/vsce package
code --install-extension openollamagravity-agent-1.0.0.vsix
```

---

## Example tasks

```
Explore this project and summarize the architecture.

Find all TypeScript errors and fix them one by one.

Add unit tests for every exported function in src/utils.ts

Refactor the authentication module to use async/await instead of callbacks.

Create a new REST endpoint for /api/users with CRUD operations.

What does this codebase do? Read the main entry points and explain.

Run npm test, read the failures, and fix the code.
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+A` | Open Agent panel |
| `Ctrl+Shift+X` | Stop running agent |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `openollamagravity.ollamaUrl` | `http://localhost:11434` | Ollama server URL |
| `openollamagravity.model` | `codellama` | Active model |
| `openollamagravity.temperature` | `0.15` | Lower = more deterministic |
| `openollamagravity.maxTokens` | `4096` | Max tokens per step |
| `openollamagravity.maxAgentSteps` | `20` | Max tool iterations per task |
| `openollamagravity.autoApplyEdits` | `false` | Skip file write confirmations |
| `openollamagravity.terminalEnabled` | `true` | Allow terminal commands |
| `openollamagravity.allowedShellCmds` | `[npm, git, tsc, …]` | Whitelist of allowed commands |

---

## Recommended Models

| Model | Best for | Speed |
|-------|----------|-------|
| `deepseek-coder:6.7b` | Code gen, debugging | Fast |
| `qwen2.5-coder:7b` | Multilingual, docs | Fast |
| `codellama:13b` | Complex reasoning | Medium |
| `starcoder2:15b` | Large codebase navigation | Slow |
| `llama3.2:3b` | Fast Q&A, low RAM | Very fast |

---

## Privacy

100% local inference. No API keys, no telemetry, no cloud.

---

## License  MIT
